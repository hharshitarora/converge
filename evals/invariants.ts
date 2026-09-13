import type { ApplyResult, Spec } from "../src/types.js";
import type { MockWorld } from "../src/providers/mockworld.js";

/**
 * Invariants.
 *
 * These are properties of the world after a run, not assertions about which
 * code path executed. That distinction matters: a test that checks "retry was
 * called twice" passes happily while the world is corrupt. Every invariant
 * here is phrased as something a user would notice.
 */

export interface InvariantResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

/** Expected object count per kind, derived from the spec itself. */
export function expectedCensus(spec: Spec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of spec.resources) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

export function checkInvariants(
  spec: Spec,
  world: MockWorld,
  result: ApplyResult,
  maxPasses: number,
  /**
   * Skip the duplicate census. Used only by replacement scenarios, where the
   * world legitimately holds a previous customer's resources: those are not
   * duplicates of anything in this spec, and I7/I8 check their fate exactly.
   */
  skipCensus = false,
): InvariantResult[] {
  const checks: InvariantResult[] = [];
  const expected = expectedCensus(spec);
  const actual = world.census();

  // I1 -- the headline property. One spec resource, one real object, forever,
  // no matter how many times it ran or what failed midway.
  const dupes: string[] = [];
  for (const [kind, want] of Object.entries(expected)) {
    const got = actual[kind] ?? 0;
    if (got > want) dupes.push(kind + ": expected " + want + ", found " + got);
  }
  if (!skipCensus) {
    checks.push({
      id: "I1",
      name: "no duplicates",
      passed: dupes.length === 0,
      detail: dupes.length ? dupes.join("; ") : "object counts match the spec exactly",
    });
  }

  // I2 -- honesty. Success may only be claimed when every resource was
  // actually read back and matched. Never "probably fine".
  const claimedSuccess = result.converged;
  const trulyClean =
    result.finalPlan.changes.length === 0 && result.finalPlan.blind.length === 0;
  checks.push({
    id: "I2",
    name: "no false success",
    passed: !claimedSuccess || trulyClean,
    detail: claimedSuccess
      ? trulyClean
        ? "claimed converged, and a fresh read confirms it"
        : "CLAIMED CONVERGED WHILE WORK REMAINED"
      : "did not claim success (" +
        result.finalPlan.changes.length + " pending, " +
        result.finalPlan.blind.length + " unreadable)",
  });

  // I3 -- no half-written resources when we do claim convergence.
  checks.push({
    id: "I3",
    name: "no half-written state",
    passed: !result.converged || result.finalPlan.changes.length === 0,
    detail: result.converged
      ? "every field verified by read-back"
      : "not applicable (run did not converge)",
  });

  // I4 -- convergence must terminate, not merely be possible.
  checks.push({
    id: "I4",
    name: "bounded passes",
    passed: result.passes <= maxPasses,
    detail: "converged in " + result.passes + " pass(es), limit " + maxPasses,
  });

  // I5 -- nothing created that the spec never asked for.
  const stray = skipCensus
    ? []
    : Object.entries(actual).filter(([kind, n]) => n > 0 && expected[kind] === undefined);
  checks.push({
    id: "I5",
    name: "no collateral objects",
    passed: stray.length === 0,
    detail: stray.length
      ? "unexpected: " + stray.map(([k, n]) => k + "=" + n).join(", ")
      : "nothing created outside the spec",
  });

  return checks;
}

/** Same duplicate check, for the naive baseline (which has no ApplyResult). */
export function checkDuplicatesOnly(spec: Spec, world: MockWorld): InvariantResult {
  const expected = expectedCensus(spec);
  const actual = world.census();
  const dupes: string[] = [];
  let extra = 0;
  for (const [kind, want] of Object.entries(expected)) {
    const got = actual[kind] ?? 0;
    if (got > want) {
      dupes.push(kind + " x" + got + " (wanted " + want + ")");
      extra += got - want;
    }
  }
  return {
    id: "I1",
    name: "no duplicates",
    passed: dupes.length === 0,
    detail: dupes.length ? extra + " duplicate object(s): " + dupes.join("; ") : "clean",
  };
}
