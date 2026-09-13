/**
 * Converge — core types.
 *
 * The central idea: there is exactly ONE notion of correctness in this system,
 * and everything else is expressed in terms of it.
 *
 *   correctness := "a fresh read of the world shows zero diff against the spec"
 *
 * That single predicate does quadruple duty:
 *   - planning      -> the diff, before we touch anything
 *   - verification  -> re-read after a write; the diff must be gone
 *   - convergence   -> keep applying until the diff is empty
 *   - drift         -> run it again tomorrow; a non-empty diff is drift
 *
 * Script-shaped agents need separate machinery for each of those, and the four
 * pieces inevitably disagree. Here they cannot disagree: they are the same call.
 */

/** Deterministic identity for a resource, e.g. "slack.channel:acme-onboarding". */
export type ResourceKey = string;

export type ResourceKind =
  | "slack.channel"
  | "slack.message"
  | "notion.page"
  | "linear.issue"
  | "github.repo"
  | "gcal.event"
  | "gmail.draft";

/** One desired resource. The spec is data, never code — so it can be diffed. */
export interface ResourceSpec {
  key: ResourceKey;
  kind: ResourceKind;
  /**
   * The natural key: how this resource is found in the external app when we
   * have no local state at all (channel name, page title, issue title...).
   * Idempotency rests on this, NOT on the state ledger — losing the ledger
   * must never cause a duplicate.
   */
  naturalKey: string;
  desired: Record<string, unknown>;
  /** Keys that must converge before this one (e.g. message needs its channel). */
  dependsOn?: ResourceKey[];
}

export interface Spec {
  goal: string;
  resources: ResourceSpec[];
}

/** What we actually found in the external app right now. */
export interface Observed {
  exists: boolean;
  externalId?: string;
  props: Record<string, unknown>;
}

export type ChangeAction = "create" | "update" | "noop";

export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

export interface Change {
  key: ResourceKey;
  kind: ResourceKind;
  action: ChangeAction;
  naturalKey: string;
  externalId?: string;
  fields: FieldDiff[];
  /** Set when the resource could not be observed (app down, auth failure). */
  unobservable?: string;
}

export interface Plan {
  goal: string;
  changes: Change[];
  /** True when every resource is in its desired state: nothing left to do. */
  converged: boolean;
  /** Resources we could not read at all — convergence is unknown, not false. */
  blind: Change[];
}

/**
 * A provider knows how to observe and reconcile one kind of resource.
 *
 * Note there is no `verify()` and no `delete()`/`rollback()`:
 *   - verification is just observe+diff, so a separate method could drift from it
 *   - rollback is unnecessary when every apply is idempotent and convergent
 */
export interface Provider {
  kind: ResourceKind;
  /** Find the resource by natural key. MUST work with no local state. */
  observe(spec: ResourceSpec, ctx: RunContext): Promise<Observed>;
  /** Compare desired vs observed. Pure — no I/O, so it is trivially testable. */
  diff(spec: ResourceSpec, observed: Observed): FieldDiff[];
  create(spec: ResourceSpec, ctx: RunContext): Promise<{ externalId: string }>;
  update(
    spec: ResourceSpec,
    observed: Observed,
    fields: FieldDiff[],
    ctx: RunContext,
  ): Promise<void>;
}

export interface RunContext {
  runId: string;
  pass: number;
  trace: (e: Omit<TraceEvent, "ts" | "runId" | "pass">) => void;
  /** Cache of key -> externalId. An optimization only; never load-bearing. */
  state: StateLedger;
  env: Record<string, string | undefined>;
}

export interface StateLedger {
  get(key: ResourceKey): string | undefined;
  set(key: ResourceKey, externalId: string): void;
  save(): void;
}

export type TraceOp =
  | "observe"
  | "create"
  | "update"
  | "http"
  | "plan"
  | "pass"
  | "converged"
  | "compile";

export interface TraceEvent {
  ts: number;
  runId: string;
  pass: number;
  op: TraceOp;
  key?: ResourceKey;
  kind?: string;
  attempt?: number;
  latencyMs?: number;
  ok: boolean;
  detail?: string;
  error?: string;
  /** Which fault the injector applied, if any — evidence for the eval report. */
  fault?: string;
  http?: { method: string; url: string; status?: number };
}

export interface ApplyResult {
  runId: string;
  goal: string;
  passes: number;
  converged: boolean;
  /** Final plan. Converged means this is empty. This IS the verification. */
  finalPlan: Plan;
  created: ResourceKey[];
  updated: ResourceKey[];
  unresolved: Change[];
  events: TraceEvent[];
  durationMs: number;
}
