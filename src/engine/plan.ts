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

export async function buildPlan(
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
): Promise<Plan> {
  const results = await Promise.all(
    spec.resources.map((r) => observeOne(r, providers, ctx)),
  );

  const changes = results.filter((c) => c.action !== "noop" && !c.unobservable);
  const blind = results.filter((c) => !!c.unobservable);

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
    // Convergence requires certainty. A resource we could not read is not
    // "fine by default" -- we refuse to claim success over a blind spot.
    converged: changes.length === 0 && blind.length === 0,
  };
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
      const fields = provider.diff(spec, observed);
      ctx.trace({
        op: "observe",
        key: spec.key,
        kind: spec.kind,
        attempt,
        latencyMs: Date.now() - t0,
        ok: true,
        detail: observed.exists ? "found " + (observed.externalId ?? "") : "absent",
      });
      if (observed.externalId) ctx.state.set(spec.key, observed.externalId);
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
