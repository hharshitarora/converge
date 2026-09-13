import type {
  ApplyResult,
  Change,
  Plan,
  Provider,
  ResourceKind,
  RunContext,
  Spec,
  TraceEvent,
} from "../types.js";
import { FaultInjected } from "../faults.js";
import { buildPlan, sleep, topoSort } from "./plan.js";

/**
 * The convergence loop.
 *
 * =========================================================================
 * THE CENTRAL SAFETY RULE: reads may be retried; writes may never be.
 * =========================================================================
 *
 * When a write fails, the agent genuinely cannot tell from the error whether
 * the side effect happened. `lost_ack` and `timeout` look identical at the
 * call site to a real failure, and in both of those cases the write DID land.
 * An agent that retries on the spot creates a duplicate -- silently, because
 * from its own point of view it recovered gracefully. This is the single most
 * common way multi-app automation corrupts state, and no amount of error
 * handling fixes it, because the error is not the problem: the guessing is.
 *
 * So writes are attempted exactly once per pass. On failure we record it and
 * move on. The next pass begins by re-observing the world, which replaces the
 * guess with a fact, and the plan that follows is correct by construction:
 *
 *   lost_ack      -> pass 2 observes the resource exists -> no action -> no duplicate
 *   partial_write -> pass 2 observes the missing field   -> update    -> repaired
 *   error_500     -> pass 2 observes it is still absent  -> create    -> completed
 *   auth_fail     -> pass 2 still cannot read it         -> BLIND     -> reported, never guessed
 *
 * Retrying is not how this system recovers. Re-observing is.
 */

const MAX_PASSES = 4;

export interface ApplyOptions {
  maxPasses?: number;
  /** Plan only; make no changes. */
  dryRun?: boolean;
}

export async function apply(
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const started = Date.now();
  const maxPasses = opts.maxPasses ?? MAX_PASSES;
  const events: TraceEvent[] = [];
  const created: string[] = [];
  const updated: string[] = [];

  // Capture every traced event for the run report.
  //
  // Deliberately mutating `ctx` rather than spreading it into a copy. Providers
  // and the fault injector close over this exact object to read the current
  // pass number; handing the loop a copy silently froze `pass` at 1 for
  // everyone outside this function, which the chaos scenarios caught.
  const baseTrace = ctx.trace;
  ctx.trace = (e) => {
    events.push({ ...e, ts: Date.now(), runId: ctx.runId, pass: ctx.pass } as TraceEvent);
    baseTrace(e);
  };
  const ctxWithCapture: RunContext = ctx;

  let plan: Plan = { goal: spec.goal, changes: [], blind: [], converged: false };
  let pass = 0;

  while (pass < maxPasses) {
    pass += 1;
    ctxWithCapture.pass = pass;

    // Every pass starts by reading reality. On pass 1 this is the plan; on
    // every later pass it is simultaneously the verification of the pass
    // before it and the plan for this one.
    plan = await buildPlan(spec, providers, ctxWithCapture);

    ctxWithCapture.trace({
      op: "pass",
      ok: true,
      detail:
        "pass " + pass + ": " + plan.changes.length + " change(s), " +
        plan.blind.length + " unreadable",
    });

    if (plan.converged) {
      ctxWithCapture.trace({
        op: "converged",
        ok: true,
        detail: "verified by read-back in " + pass + " pass(es)",
      });
      break;
    }

    if (opts.dryRun) break;

    // Nothing actionable left: only blind spots remain. More passes cannot
    // help, so stop rather than spin.
    if (plan.changes.length === 0) break;

    for (const change of topoSort(plan.changes, spec)) {
      const done = await executeOnce(change, spec, providers, ctxWithCapture);
      if (done === "created") created.push(change.key);
      if (done === "updated") updated.push(change.key);
    }

    await sleep(25);
  }

  ctx.state.save();

  return {
    runId: ctx.runId,
    goal: spec.goal,
    passes: pass,
    converged: plan.converged,
    finalPlan: plan,
    created: [...new Set(created)],
    updated: [...new Set(updated)],
    unresolved: [...plan.changes, ...plan.blind],
    events,
    durationMs: Date.now() - started,
  };
}

/**
 * Attempt one change exactly once. Never retried here -- see the rule above.
 */
async function executeOnce(
  change: Change,
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
): Promise<"created" | "updated" | "failed"> {
  const resource = spec.resources.find((r) => r.key === change.key)!;
  const provider = providers.get(change.kind)!;
  const t0 = Date.now();

  try {
    if (change.action === "create") {
      const { externalId } = await provider.create(resource, ctx);
      ctx.state.set(change.key, externalId);
      ctx.trace({
        op: "create",
        key: change.key,
        kind: change.kind,
        attempt: 1,
        latencyMs: Date.now() - t0,
        ok: true,
        detail: change.naturalKey + " -> " + externalId,
      });
      return "created";
    }

    await provider.update(
      resource,
      { exists: true, externalId: change.externalId, props: {} },
      change.fields,
      ctx,
    );
    ctx.trace({
      op: "update",
      key: change.key,
      kind: change.kind,
      attempt: 1,
      latencyMs: Date.now() - t0,
      ok: true,
      detail: change.fields.map((f) => f.field).join(", "),
    });
    return "updated";
  } catch (e) {
    const fault = e instanceof FaultInjected ? e.mode : undefined;
    ctx.trace({
      op: change.action === "create" ? "create" : "update",
      key: change.key,
      kind: change.kind,
      attempt: 1,
      latencyMs: Date.now() - t0,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      fault,
      detail: "not retried in-pass by design; next pass re-observes before acting",
    });
    return "failed";
  }
}
