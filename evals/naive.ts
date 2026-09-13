import type { Provider, ResourceKind, RunContext, Spec } from "../src/types.js";

/**
 * The baseline: a conventional tool-calling agent.
 *
 * This is not a straw man. It is the shape almost every production agent has
 * today, and the shape most reviewers would call correct: execute each step,
 * catch errors, retry a few times with backoff, report what failed. It has
 * error handling. It has retries. It is careful.
 *
 * It also silently corrupts state, because it answers the one question it
 * cannot answer -- "did my write land?" -- by guessing. Running it through the
 * same fault matrix as the convergent engine is the whole argument: the
 * difference in outcomes is not diligence, it is architecture.
 */

const MAX_RETRIES = 3;

export interface NaiveResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export async function runNaive(
  spec: Spec,
  providers: Map<ResourceKind, Provider>,
  ctx: RunContext,
): Promise<NaiveResult> {
  const result: NaiveResult = { attempted: 0, succeeded: 0, failed: 0, errors: [] };

  for (const resource of spec.resources) {
    const provider = providers.get(resource.kind);
    if (!provider) continue;
    result.attempted += 1;

    let ok = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // The fatal line. It creates without first asking whether the
        // resource already exists, so a retry after an ambiguous failure
        // creates a second one. Everything else here is textbook-correct.
        const { externalId } = await provider.create(resource, ctx);
        ctx.state.set(resource.key, externalId);
        ok = true;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === MAX_RETRIES) {
          result.errors.push(resource.key + ": " + msg);
        }
        await new Promise((r) => setTimeout(r, 10 * attempt));
      }
    }

    if (ok) result.succeeded += 1;
    else result.failed += 1;
  }

  return result;
}
