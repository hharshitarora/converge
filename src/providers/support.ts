import { FaultInjector, FaultMode } from "../faults.js";
import type { FieldDiff, Observed, ResourceSpec } from "../types.js";

/**
 * Shared plumbing for app clients.
 *
 * `guard` is where injected faults become real behaviour. The subtle part is
 * the silent modes: `lost_ack` must perform the write and THEN throw, and
 * `partial_write` must perform a deliberately incomplete write and report
 * success. Faults that only throw before doing anything would be harmless —
 * and would quietly turn the eval suite into theatre.
 */
export interface GuardCtx {
  injector: FaultInjector;
  pass: () => number;
  onFault?: (mode: FaultMode, op: string, kind: string) => void;
}

export async function guard<T>(
  ctx: GuardCtx,
  op: "observe" | "create" | "update",
  kind: string,
  perform: () => Promise<T> | T,
  /** Incomplete version of the write, used only for `partial_write`. */
  performPartial?: () => Promise<T> | T,
): Promise<T> {
  const mode = ctx.injector.check(op, kind, ctx.pass());
  if (!mode) return await perform();
  ctx.onFault?.(mode, op, kind);

  if (mode === "partial_write" && performPartial) {
    // The damaging case: the caller is told everything is fine.
    return await performPartial();
  }
  if (mode === "lost_ack") {
    // Side effect really happens; the acknowledgement is what is lost.
    await perform();
    throw FaultInjector.toError(mode);
  }
  throw FaultInjector.toError(mode);
}

/** Compare only the fields the spec actually declares. */
export function diffProps(
  spec: ResourceSpec,
  observed: Observed,
  fields: string[],
): FieldDiff[] {
  if (!observed.exists) {
    return fields
      .filter((f) => spec.desired[f] !== undefined)
      .map((f) => ({ field: f, from: undefined, to: spec.desired[f] }));
  }
  const out: FieldDiff[] = [];
  for (const f of fields) {
    const to = spec.desired[f];
    if (to === undefined) continue;
    const from = observed.props[f];
    if (!equal(from, to)) out.push({ field: f, from, to });
  }
  return out;
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  return a === b;
}

/** Slugify to a Slack-legal channel name; also our natural key for channels. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

let seq = 0;
export function mockId(prefix: string): string {
  seq += 1;
  return `${prefix}_${String(seq).padStart(4, "0")}`;
}
export function resetMockIds() {
  seq = 0;
}
