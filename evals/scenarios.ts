import type { FaultMode, FaultRule } from "../src/faults.js";

/**
 * The scenario matrix.
 *
 * Generated rather than hand-written, so coverage is a property of the matrix
 * instead of a function of how much patience the author had. Every fault mode
 * is crossed with every app and every operation, and the awkward cases that
 * are usually skipped -- losing local state, repairing damage a human did,
 * several apps failing at once -- get their own families.
 */

export interface Scenario {
  name: string;
  family: string;
  description: string;
  faults: FaultRule[];
  seed: number;
  /** Apply this many times in sequence; the census must not grow. */
  runs: number;
  /** Wipe the ledger before the final run: forces rediscovery by natural key. */
  forgetState?: boolean;
  /** Damage the world between runs, the way a human with admin rights does. */
  breakBetween?: ("slack-channel" | "notion-page" | "linear-desc" | "github-repo")[];
  /** Convergence is impossible here; the correct outcome is an honest report. */
  expectBlind?: boolean;
  /** Include this scenario in the naive-baseline comparison. */
  baseline: boolean;
}

const KINDS = ["slack.channel", "notion.page", "linear.issue", "github.repo"] as const;

const RECOVERABLE: FaultMode[] = [
  "error_500",
  "rate_limit",
  "timeout",
  "lost_ack",
  "partial_write",
];

export function allScenarios(): Scenario[] {
  const out: Scenario[] = [];
  let seed = 1;

  // --- family 1: the happy path ------------------------------------------
  out.push({
    name: "clean run",
    family: "baseline",
    description: "No faults. Establishes that convergence works at all.",
    faults: [],
    seed: seed++,
    runs: 1,
    baseline: true,
  });

  out.push({
    name: "applied three times",
    family: "idempotence",
    description:
      "Same spec applied three times with no faults. The census must not grow -- " +
      "re-running must be free.",
    faults: [],
    seed: seed++,
    runs: 3,
    baseline: true,
  });

  // --- family 2: every recoverable fault, on create, on every app --------
  for (const mode of RECOVERABLE) {
    for (const kind of KINDS) {
      out.push({
        name: mode + " on create " + kind,
        family: "write faults",
        description:
          "Pass 1 create of " + kind + " hits " + mode +
          ". The engine must reach the desired state without duplicating.",
        faults: [{ mode, kind, op: "create", onlyPasses: [1], maxFires: 1 }],
        seed: seed++,
        runs: 1,
        baseline: true,
      });
    }
  }

  // --- family 3: faults while reading ------------------------------------
  for (const mode of ["error_500", "rate_limit", "timeout"] as FaultMode[]) {
    for (const kind of KINDS) {
      out.push({
        name: mode + " on observe " + kind,
        family: "read faults",
        description:
          "Reading " + kind + " fails on pass 1. Reads are retryable, so this " +
          "should recover within the pass.",
        faults: [{ mode, kind, op: "observe", onlyPasses: [1], maxFires: 2 }],
        seed: seed++,
        runs: 1,
        baseline: false,
      });
    }
  }

  // --- family 4: unrecoverable auth failure ------------------------------
  for (const kind of KINDS) {
    out.push({
      name: "auth_fail on " + kind,
      family: "unrecoverable",
      description:
        "Credentials for " + kind + " are rejected for the whole run. Convergence " +
        "is impossible; the only correct behaviour is to report the blind spot " +
        "and never guess at that resource's state.",
      faults: [{ mode: "auth_fail", kind, op: "observe" }],
      seed: seed++,
      runs: 1,
      expectBlind: true,
      baseline: false,
    });
  }

  // --- family 5: several apps failing at once ----------------------------
  for (let i = 0; i < 6; i++) {
    const a = RECOVERABLE[i % RECOVERABLE.length]!;
    const b = RECOVERABLE[(i + 2) % RECOVERABLE.length]!;
    out.push({
      name: "chaos " + (i + 1) + " (" + a + " + " + b + ")",
      family: "chaos",
      description:
        "Two apps fail simultaneously on pass 1 with different modes, at 60% " +
        "probability across all operations.",
      faults: [
        { mode: a, kind: KINDS[i % 4], probability: 0.6, onlyPasses: [1] },
        { mode: b, kind: KINDS[(i + 1) % 4], probability: 0.6, onlyPasses: [1] },
      ],
      seed: seed++,
      runs: 1,
      baseline: true,
    });
  }

  // --- family 6: losing our own state ------------------------------------
  for (const kind of KINDS) {
    out.push({
      name: "state loss after " + kind + " fault",
      family: "state independence",
      description:
        "A fault hits " + kind + ", then the local ledger is deleted before the " +
        "next run. Every resource must be rediscovered by natural key. This is " +
        "the scenario that proves the ledger is a cache and not the truth.",
      faults: [{ mode: "lost_ack", kind, op: "create", onlyPasses: [1], maxFires: 1 }],
      seed: seed++,
      runs: 2,
      forgetState: true,
      baseline: false,
    });
  }

  // --- family 7: repairing damage a human did ----------------------------
  const targets = ["slack-channel", "notion-page", "linear-desc", "github-repo"] as const;
  for (const t of targets) {
    out.push({
      name: "repair " + t,
      family: "drift repair",
      description:
        "Converge, then damage " + t + " outside the agent, then converge again. " +
        "Exactly the damage must be repaired and nothing else touched.",
      faults: [],
      seed: seed++,
      runs: 2,
      breakBetween: [t],
      baseline: false,
    });
  }

  out.push({
    name: "repair everything at once",
    family: "drift repair",
    description: "All four apps damaged simultaneously, then a single converge.",
    faults: [],
    seed: seed++,
    runs: 2,
    breakBetween: [...targets],
    baseline: false,
  });

  return out;
}
