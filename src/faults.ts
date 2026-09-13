/**
 * Deterministic fault injection.
 *
 * The failure modes below are not a random sprinkle of 500s. Each one is a
 * distinct way a multi-app workflow gets corrupted in production, and the
 * interesting ones are the ones that produce *silent* damage rather than a
 * loud error:
 *
 *   lost_ack      The write succeeded server-side, but the acknowledgement
 *                 never made it back. This is the single most destructive
 *                 fault in multi-app automation: a script-shaped agent sees an
 *                 error, retries, and creates a DUPLICATE. Nothing alerts,
 *                 because from the agent's point of view it recovered.
 *
 *   partial_write Create succeeded, but only some fields landed. The resource
 *                 exists, so an existence check passes, yet it is wrong.
 *
 *   rate_limit    429. Correctness must survive being told to slow down.
 *
 *   error_500     Loud, honest failure. The easy case; included as a control.
 *
 *   auth_fail     401. Unrecoverable within the run — the correct behaviour is
 *                 to stay BLIND about that resource, never to assume anything.
 *
 *   timeout       No response at all. Indistinguishable from lost_ack at the
 *                 call site, which is exactly why guessing is unsafe.
 *
 * Injection is seeded and deterministic so that an eval failure can be
 * replayed exactly. Non-reproducible reliability numbers are not evidence.
 */

export type FaultMode =
  | "error_500"
  | "rate_limit"
  | "auth_fail"
  | "timeout"
  | "lost_ack"
  | "partial_write";

export interface FaultRule {
  mode: FaultMode;
  /** Restrict to one resource kind, e.g. "slack.channel". */
  kind?: string;
  /** Restrict to one operation. */
  op?: "observe" | "create" | "update";
  /** 0..1, evaluated against the seeded PRNG. */
  probability?: number;
  /** Only fire on these convergence passes (1-indexed). */
  onlyPasses?: number[];
  /** Fire at most this many times in a run. */
  maxFires?: number;
}

/** Small deterministic PRNG (mulberry32) so runs are exactly replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FaultInjected extends Error {
  constructor(
    readonly mode: FaultMode,
    message: string,
  ) {
    super(message);
    this.name = "FaultInjected";
  }
}

export class FaultInjector {
  private rand: () => number;
  private fires = new Map<FaultRule, number>();
  readonly log: { mode: FaultMode; op: string; kind: string; pass: number }[] = [];

  constructor(
    private rules: FaultRule[] = [],
    seed = 1,
  ) {
    this.rand = mulberry32(seed);
  }

  static none() {
    return new FaultInjector([], 1);
  }

  /**
   * Decide whether to fault this call. Returns the mode, or null to proceed.
   * Callers handle `lost_ack` and `partial_write` specially: those must perform
   * the real side effect and *then* misreport, otherwise they would not
   * reproduce the bug they exist to test.
   */
  check(op: string, kind: string, pass: number): FaultMode | null {
    for (const rule of this.rules) {
      if (rule.op && rule.op !== op) continue;
      if (rule.kind && rule.kind !== kind) continue;
      if (rule.onlyPasses && !rule.onlyPasses.includes(pass)) continue;
      const fired = this.fires.get(rule) ?? 0;
      if (rule.maxFires !== undefined && fired >= rule.maxFires) continue;
      if (this.rand() > (rule.probability ?? 1)) continue;
      this.fires.set(rule, fired + 1);
      this.log.push({ mode: rule.mode, op, kind, pass });
      return rule.mode;
    }
    return null;
  }

  /** Faults that must still perform the underlying side effect. */
  static isSilent(mode: FaultMode): boolean {
    return mode === "lost_ack" || mode === "partial_write";
  }

  static toError(mode: FaultMode): FaultInjected {
    const messages: Record<FaultMode, string> = {
      error_500: "500 Internal Server Error (injected)",
      rate_limit: "429 Too Many Requests (injected)",
      auth_fail: "401 Unauthorized (injected)",
      timeout: "ETIMEDOUT: no response from upstream (injected)",
      lost_ack: "ECONNRESET: connection lost after request was sent (injected)",
      partial_write: "partial write (injected)",
    };
    return new FaultInjected(mode, messages[mode]);
  }

  /** Auth failures are not retryable within a run; the rest are. */
  static isRetryable(mode: FaultMode): boolean {
    return mode !== "auth_fail";
  }
}
