import type {
  Change,
  Plan,
  Provider,
  ResourceKind,
  ResourceSpec,
  RunContext,
  Spec,
} from "../types.js";
import { FaultInjected, FaultInjector } from "../faults.js";

/**
 * Build a plan: read the world, diff it against the spec.
 *
 * This function is the whole correctness story. It is called before any write
 * (that is the plan), after every write (that is the verification), and on
 * demand days later (that is drift detection). Because all three are literally
 * the same call, they cannot disagree with each other.
 *
 * Observation is read-only, so every resource is observed concurrently, and
 * reads may be retried freely -- unlike writes. See apply.ts for why that
 * asymmetry is the core safety rule.
 */

const OBSERVE_ATTEMPTS = 3;

export interface PlanOptions {
  /**
   * Treat the spec as the COMPLETE desired state, so leftovers count as work.
   *
   * Two honest readings of "converged" exist, and which one applies is the
   * caller's decision, not ours:
   *   additive (default) - the spec says what must exist; a leftover is untidy
   *   exact (--prune)    - the spec says what must exist AND ONLY THAT
   *
   * Keeping both inside this one function matters: convergence, verification
   * and drift stay a single predicate, and the prune flag changes what that
   * predicate means rather than bolting a second notion of done onto the loop.
   */
  exact?: boolean;
}

export async function buildPlan(
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
  opts: PlanOptions = {},
): Promise<Plan> {
  // Observe in dependency layers, concurrently within each layer.
  //
  // Not merely an optimisation detail: some resources can only be FOUND
  // through another resource's identity. A Slack message has no name, so it is
  // located by searching the channel it lives in — which means the channel's
  // id must already be known. Observing everything at once looked harmless and
  // was faster, but with an empty ledger the message was looked up before its
  // channel had been rediscovered, reported absent, and got posted a second
  // time. Dependencies constrain reads exactly as they constrain writes.
  const results: Change[] = [];
  for (const layer of dependencyLayers(spec)) {
    results.push(
      ...(await Promise.all(layer.map((r) => observeOne(r, providers, ctx)))),
    );
  }

  const changes = results.filter((c) => c.action !== "noop" && !c.unobservable);
  const blind = results.filter((c) => !!c.unobservable);
  const orphans = await findOrphans(spec, providers, ctx);

  ctx.trace({
    op: "plan",
    ok: true,
    detail:
      changes.filter((c) => c.action === "create").length +
      " create, " +
      changes.filter((c) => c.action === "update").length +
      " update, " +
      (results.length - changes.length - blind.length) +
      " in sync, " +
      blind.length +
      " unreadable",
  });

  return {
    goal: spec.goal,
    changes,
    blind,
    orphans,
    // Convergence requires certainty. A resource we could not read is not
    // "fine by default" -- we refuse to claim success over a blind spot.
    //
    // Orphans block convergence only in exact mode. Note the exclusion of
    // orphans a provider refuses to delete: those can never be resolved by
    // this system, so counting them would mean --prune could never converge
    // and would spin to the pass limit every time. They are reported for a
    // human instead, which is the only honest outcome.
    converged:
      changes.length === 0 &&
      blind.length === 0 &&
      (!opts.exact || orphans.every((o) => !!o.unobservable)),
  };
}

/**
 * Resources the ledger remembers but the spec no longer declares, which still
 * exist in their app. See the note on `Plan.orphans`: this is the one question
 * the external apps cannot answer for us.
 */
async function findOrphans(
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
): Promise<Change[]> {
  const declared = new Set(spec.resources.map((r) => r.key));
  const out: Change[] = [];

  for (const [key, entry] of ctx.state.entries()) {
    if (declared.has(key)) continue;
    const provider = providers.get(entry.kind);
    if (!provider) continue;

    // Rebuild just enough of the departed resource to look it up again.
    const ghost: ResourceSpec = {
      key,
      kind: entry.kind,
      naturalKey: entry.naturalKey,
      desired: entry.desired,
    };

    try {
      const observed = await provider.observe(ghost, ctx);
      if (!observed.exists) {
        // Already gone; stop remembering it.
        ctx.state.drop(key);
        continue;
      }
      out.push({
        key,
        kind: entry.kind,
        naturalKey: entry.naturalKey,
        action: "destroy",
        externalId: observed.externalId,
        fields: [],
        ghost,
        // A provider with no destroy() is refusing on principle, not failing.
        unobservable: provider.destroy ? undefined : "this kind is never deleted automatically",
      });
    } catch {
      // If we cannot confirm it still exists, we certainly will not delete it.
    }
  }

  return out;
}

async function observeOne(
  spec: ResourceSpec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
): Promise<Change> {
  const provider = providers.get(spec.kind);
  if (!provider) {
    return {
      key: spec.key,
      kind: spec.kind,
      action: "noop",
      naturalKey: spec.naturalKey,
      fields: [],
      unobservable: "no provider registered for kind " + spec.kind,
    };
  }

  let lastErr = "";
  for (let attempt = 1; attempt <= OBSERVE_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const observed = await provider.observe(spec, ctx);
      const fields = provider.diff(spec, observed, ctx);
      ctx.trace({
        op: "observe",
        key: spec.key,
        kind: spec.kind,
        attempt,
        latencyMs: Date.now() - t0,
        ok: true,
        detail: observed.exists ? "found " + (observed.externalId ?? "") : "absent",
      });
      if (observed.externalId) ctx.state.record(spec, observed.externalId);
      return {
        key: spec.key,
        kind: spec.kind,
        naturalKey: spec.naturalKey,
        action: !observed.exists ? "create" : fields.length ? "update" : "noop",
        externalId: observed.externalId,
        fields,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      const fault = e instanceof FaultInjected ? e.mode : undefined;
      ctx.trace({
        op: "observe",
        key: spec.key,
        kind: spec.kind,
        attempt,
        latencyMs: Date.now() - t0,
        ok: false,
        error: lastErr,
        fault,
      });
      // Auth failures will not fix themselves by trying harder.
      if (fault && !FaultInjector.isRetryable(fault)) break;
      if (attempt < OBSERVE_ATTEMPTS) {
        await sleep(40 * attempt);
      }
    }
  }

  return {
    key: spec.key,
    kind: spec.kind,
    action: "noop",
    naturalKey: spec.naturalKey,
    fields: [],
    unobservable: lastErr,
  };
}

/**
 * Group resources so that everything in layer N depends only on layers < N.
 * Members of a layer are independent of one another and can run concurrently.
 */
export function dependencyLayers(spec: Spec): ResourceSpec[][] {
  const byKey = new Map(spec.resources.map((r) => [r.key, r]));
  const depth = new Map<string, number>();

  const compute = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    // A cycle is rejected by spec validation before we get here; guard anyway
    // so a malformed spec cannot hang the planner.
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = (byKey.get(key)?.dependsOn ?? []).filter((d) => byKey.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => compute(x, seen))) : 0;
    seen.delete(key);
    depth.set(key, d);
    return d;
  };

  for (const r of spec.resources) compute(r.key, new Set());

  const layers: ResourceSpec[][] = [];
  for (const r of spec.resources) {
    const d = depth.get(r.key) ?? 0;
    (layers[d] ??= []).push(r);
  }
  return layers.filter(Boolean);
}

/** Order changes so dependencies land before dependents. */
export function topoSort(changes: Change[], spec: Spec): Change[] {
  const byKey = new Map(spec.resources.map((r) => [r.key, r]));
  const out: Change[] = [];
  const seen = new Set<string>();
  const pending = new Set(changes.map((c) => c.key));

  const visit = (key: string, stack: Set<string>) => {
    if (seen.has(key) || stack.has(key)) return;
    stack.add(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (pending.has(dep)) visit(dep, stack);
    }
    stack.delete(key);
    seen.add(key);
    const change = changes.find((c) => c.key === key);
    if (change) out.push(change);
  };

  for (const c of changes) visit(c.key, new Set());
  return out;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
