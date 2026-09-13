import Anthropic from "@anthropic-ai/sdk";
import type { Spec } from "./types.js";
import { KINDS, SpecSchema, templateSpec, validateSpec } from "./spec.js";

/**
 * Compile a real-world request into a desired-state spec.
 *
 * The model plans; it never acts. Its only output is a JSON document
 * describing the world it wants to exist, which is then validated twice --
 * once by the API against a strict schema, once by our own structural rules --
 * before a single byte is written to any external app.
 *
 * That ordering is the point. A tool-calling agent's mistakes are discovered
 * after they have already happened, in whichever app it happened to touch
 * first. Here an invalid plan is caught while it is still just text, and the
 * model is handed the validation errors to repair. Being wrong is free until
 * the plan is approved.
 */

const MODEL = "claude-opus-5";

const SYSTEM = [
  "You turn customer-onboarding requests into a declarative desired-state spec.",
  "",
  "You do not take actions. You describe the end state that should exist across",
  "Slack, Notion, Linear and GitHub once onboarding is complete. A separate",
  "engine diffs your spec against the real world and converges it.",
  "",
  "Rules:",
  "- Every resource needs a stable `key` (e.g. 'slack.channel:acme') and a",
  "  `naturalKey`: the value the app itself uses to identify the resource",
  "  (channel name, page title, issue title, repo name). The naturalKey must be",
  "  derivable from the request alone, because it is how the resource is found",
  "  again on later runs. Never invent IDs.",
  "- slack.channel naturalKey must be lowercase, hyphenated, no spaces.",
  "- notion.page requires desired.parentId; use the provided Notion parent id.",
  "- linear.issue requires desired.teamKey; use the provided team key.",
  "- Sub-tasks should list their parent epic in dependsOn.",
  "- Finish with ONE slack.message kickoff brief in the onboarding channel. Set",
  "  desired.channelKey to the channel resource's key, and write desired.text with",
  "  {{resource.key}} placeholders for the other resources -- each is replaced with",
  "  that resource's real id once it exists. List every resource it references in",
  "  dependsOn, so it is written only after they are. This is the step that makes",
  "  the apps one workflow rather than four separate integrations.",
  "- Touch at least three different apps.",
  "- Write topics, summaries and descriptions that a real colleague would find",
  "  useful: specific to this customer, not filler.",
].join("\n");

const TOOL: Anthropic.Tool = {
  name: "emit_spec",
  description: "Emit the desired-state spec for this onboarding request.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "resources"],
    properties: {
      goal: { type: "string", description: "One line: what this run achieves." },
      resources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "kind", "naturalKey", "desired"],
          properties: {
            key: { type: "string" },
            kind: { type: "string", enum: [...KINDS] },
            naturalKey: { type: "string" },
            desired: {
              type: "object",
              additionalProperties: false,
              properties: {
                topic: { type: "string" },
                purpose: { type: "string" },
                summary: { type: "string" },
                description: { type: "string" },
                parentId: { type: "string" },
                teamKey: { type: "string" },
                channelKey: { type: "string" },
                text: { type: "string" },
              },
            },
            dependsOn: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

export interface CompileOptions {
  request: string;
  notionParentId: string;
  linearTeamKey: string;
  apiKey?: string;
  onEvent?: (msg: string) => void;
}

export interface CompileResult {
  spec: Spec;
  source: "model" | "template";
  attempts: number;
  repaired: boolean;
}

export async function compile(opts: CompileOptions): Promise<CompileResult> {
  const { request, notionParentId, linearTeamKey } = opts;
  const log = opts.onEvent ?? (() => {});

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log("no ANTHROPIC_API_KEY; using the deterministic template planner");
    return {
      spec: templateSpec({
        company: guessCompany(request),
        notionParentId,
        linearTeamKey,
      }),
      source: "template",
      attempts: 0,
      repaired: false,
    };
  }

  const client = new Anthropic({ apiKey });
  const context = [
    "Request:",
    request,
    "",
    "Notion parent page id: " + notionParentId,
    "Linear team key: " + linearTeamKey,
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: context }];

  // One planning attempt, then one repair attempt seeded with the exact
  // validation errors. Two rounds is enough in practice, and bounding it keeps
  // a confused model from burning the clock.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "emit_spec" },
      messages,
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!block) throw new Error("planner returned no spec");

    const parsed = SpecSchema.safeParse(block.input);
    const issues = parsed.success
      ? validateSpec(parsed.data as Spec)
      : parsed.error.issues.map((i) => i.path.join(".") + ": " + i.message);

    if (parsed.success && issues.length === 0) {
      log(
        "plan compiled: " +
          parsed.data.resources.length +
          " resources across " +
          new Set(parsed.data.resources.map((r) => r.kind.split(".")[0])).size +
          " apps" +
          (attempt > 1 ? " (after repair)" : ""),
      );
      return {
        spec: parsed.data as Spec,
        source: "model",
        attempts: attempt,
        repaired: attempt > 1,
      };
    }

    log("plan rejected by validation: " + issues.slice(0, 4).join("; "));

    if (attempt === 2) break;

    messages.push(
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content:
              "The spec failed validation. Fix every issue and emit it again:\n- " +
              issues.join("\n- "),
          },
        ],
      },
    );
  }

  // Never fail the run because the planner struggled: fall back to the
  // deterministic template so the engine still has something correct to
  // converge. A degraded plan beats no onboarding.
  log("planner did not produce a valid spec; falling back to the template");
  return {
    spec: templateSpec({
      company: guessCompany(request),
      notionParentId,
      linearTeamKey,
    }),
    source: "template",
    attempts: 2,
    repaired: false,
  };
}

/** Crude company extraction for the template fallback path only. */
function guessCompany(request: string): string {
  const m =
    request.match(/onboard(?:ing)?\s+([A-Z][\w&.\- ]{1,40}?)(?:[,.\n]|$)/i) ??
    request.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+(?:Corp|Inc|Labs|Systems|Technologies|AI))?)\b/);
  return (m?.[1] ?? "New Customer").trim();
}
