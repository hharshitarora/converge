import { z } from "zod";
import type { Spec } from "./types.js";
import { slug } from "./providers/support.js";

/**
 * The desired-state spec.
 *
 * The model's entire output is this document -- data, not actions. That is the
 * design decision the rest of the system rests on: because the plan is inert
 * data, it can be validated before anything is touched, diffed against the
 * world, shown to a human, replayed, and stored as evidence. A model that
 * emits tool calls directly gives you none of those, because by the time you
 * see the call it has already happened.
 */

export const KINDS = [
  "slack.channel",
  "slack.message",
  "notion.page",
  "linear.issue",
  "github.repo",
] as const;

export const ResourceSpecSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(KINDS),
  naturalKey: z.string().min(1),
  desired: z.record(z.unknown()),
  dependsOn: z.array(z.string()).optional(),
});

export const SpecSchema = z.object({
  goal: z.string().min(1),
  resources: z.array(ResourceSpecSchema).min(3),
});

export type ValidationIssue = string;

/**
 * Structural checks the JSON schema cannot express. These run before any
 * side effect, so a malformed plan costs nothing.
 */
export function validateSpec(spec: Spec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const keys = new Set<string>();

  for (const r of spec.resources) {
    if (keys.has(r.key)) issues.push("duplicate resource key: " + r.key);
    keys.add(r.key);

    if (r.kind === "slack.channel" && r.naturalKey !== slug(r.naturalKey)) {
      issues.push(
        "slack.channel naturalKey must be a valid channel name (got '" +
          r.naturalKey +
          "', expected '" +
          slug(r.naturalKey) +
          "')",
      );
    }
    if (r.kind === "notion.page" && !r.desired.parentId) {
      issues.push("notion.page " + r.key + " is missing desired.parentId");
    }
    if (r.kind === "linear.issue" && !r.desired.teamKey) {
      issues.push("linear.issue " + r.key + " is missing desired.teamKey");
    }
    if (r.kind === "slack.message" && !r.desired.channelKey) {
      issues.push("slack.message " + r.key + " is missing desired.channelKey");
    }
  }

  for (const r of spec.resources) {
    for (const dep of r.dependsOn ?? []) {
      if (!keys.has(dep)) {
        issues.push(r.key + " dependsOn unknown resource '" + dep + "'");
      }
    }
  }

  // At least three distinct apps must be touched -- the hackathon's own bar,
  // enforced by the system rather than trusted to the model.
  const apps = new Set(spec.resources.map((r) => r.kind.split(".")[0]));
  if (apps.size < 3) {
    issues.push(
      "spec touches only " + apps.size + " app(s) (" + [...apps].join(", ") + "); at least 3 required",
    );
  }

  if (hasCycle(spec)) issues.push("dependsOn graph contains a cycle");

  return issues;
}

function hasCycle(spec: Spec): boolean {
  const deps = new Map(spec.resources.map((r) => [r.key, r.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const walk = (k: string): boolean => {
    const s = state.get(k) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) {
      if (deps.has(d) && walk(d)) return true;
    }
    state.set(k, 2);
    return false;
  };
  return [...deps.keys()].some(walk);
}

/**
 * Deterministic fallback template.
 *
 * Used when no ANTHROPIC_API_KEY is present, and as the comparison baseline in
 * evals so that engine behaviour can be measured without model variance in the
 * way. Reliability numbers taken over a non-deterministic planner measure the
 * planner, not the engine.
 */
export function templateSpec(opts: {
  company: string;
  domain?: string;
  tier?: string;
  owner?: string;
  notionParentId: string;
  linearTeamKey: string;
}): Spec {
  const { company, domain = "", tier = "Standard", owner = "unassigned" } = opts;
  const s = slug(company);

  return {
    goal: "Onboard " + company,
    resources: [
      {
        key: "slack.channel:" + s,
        kind: "slack.channel",
        naturalKey: s + "-onboarding",
        desired: {
          topic: "Onboarding " + company + " (" + tier + ")",
          purpose: "Shared channel for the " + company + " onboarding. Owner: " + owner + ".",
        },
      },
      {
        key: "notion.page:" + s,
        kind: "notion.page",
        naturalKey: company,
        desired: {
          parentId: opts.notionParentId,
          summary:
            company + " -- " + tier + " tier" + (domain ? " (" + domain + ")" : "") +
            ". Account owner: " + owner + ". Onboarding in progress.",
        },
      },
      {
        key: "linear.epic:" + s,
        kind: "linear.issue",
        naturalKey: "Onboard " + company,
        desired: {
          teamKey: opts.linearTeamKey,
          description: "Umbrella issue for onboarding " + company + " (" + tier + " tier).",
        },
      },
      {
        key: "linear.task:kickoff:" + s,
        kind: "linear.issue",
        naturalKey: "Schedule kickoff call with " + company,
        desired: {
          teamKey: opts.linearTeamKey,
          description: "Book the kickoff call with " + company + " and send the agenda.",
        },
        dependsOn: ["linear.epic:" + s],
      },
      {
        key: "linear.task:access:" + s,
        kind: "linear.issue",
        naturalKey: "Provision production access for " + company,
        desired: {
          teamKey: opts.linearTeamKey,
          description: "Create the tenant and issue API credentials for " + company + ".",
        },
        dependsOn: ["linear.epic:" + s],
      },
      {
        key: "github.repo:" + s,
        kind: "github.repo",
        naturalKey: s + "-integration",
        desired: {
          description: "Integration workspace for " + company + " (" + tier + " tier).",
        },
      },
      {
        // Composed from what every other app returned. `{{key}}` resolves to
        // that resource's real external id, so this message cannot be written
        // until Notion, Linear and GitHub have each produced one.
        key: "slack.message:kickoff:" + s,
        kind: "slack.message",
        naturalKey: "kickoff brief for " + company,
        desired: {
          channelKey: "slack.channel:" + s,
          text: [
            ":wave: *" + company + "* is onboarding (" + tier + " tier). " +
              "Account owner: " + owner + ".",
            "- Account record: {{notion.page:" + s + "}}",
            "- Onboarding epic: {{linear.epic:" + s + "}}",
            "- Kickoff call: {{linear.task:kickoff:" + s + "}}",
            "- Production access: {{linear.task:access:" + s + "}}",
            "- Integration repo: {{github.repo:" + s + "}}",
          ].join("\n"),
        },
        dependsOn: [
          "slack.channel:" + s,
          "notion.page:" + s,
          "linear.epic:" + s,
          "linear.task:kickoff:" + s,
          "linear.task:access:" + s,
          "github.repo:" + s,
        ],
      },
    ],
  };
}
