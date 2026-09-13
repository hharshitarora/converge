import type { Provider, ResourceKind } from "../types.js";
import type { GuardCtx } from "./support.js";
import { MockWorld } from "./mockworld.js";
import { slackChannelProvider, mockSlack, liveSlack } from "./slack.js";
import { notionPageProvider, mockNotion, liveNotion } from "./notion.js";
import { linearIssueProvider, mockLinear, liveLinear } from "./linear.js";
import { githubRepoProvider, mockGithub, liveGithub } from "./github.js";
import { slackMessageProvider, mockSlackMessage, liveSlackMessage } from "./slackmessage.js";

export { MockWorld } from "./mockworld.js";

export interface Registry {
  providers: Map<ResourceKind, Provider>;
  /** Which apps are wired to real APIs vs. local twins, for the run header. */
  modes: Record<string, "live" | "mock">;
  world?: MockWorld;
}

/**
 * Build the provider registry.
 *
 * Each app independently resolves to live or mock depending on whether its
 * credential is present. That per-app granularity matters during a live demo:
 * if one integration's token expires, the other three still run for real
 * instead of the whole run collapsing to mocks.
 */
export function buildRegistry(
  env: Record<string, string | undefined>,
  g: GuardCtx,
  world: MockWorld,
): Registry {
  const live = env.CONVERGE_LIVE === "1";
  const providers = new Map<ResourceKind, Provider>();
  const modes: Record<string, "live" | "mock"> = {};

  const slackTok = env.SLACK_BOT_TOKEN;
  if (live && slackTok) {
    providers.set("slack.channel", slackChannelProvider(liveSlack(slackTok, g)));
    providers.set("slack.message", slackMessageProvider(liveSlackMessage(slackTok, g)));
    modes.slack = "live";
  } else {
    providers.set("slack.channel", slackChannelProvider(mockSlack(world, g)));
    providers.set("slack.message", slackMessageProvider(mockSlackMessage(world, g)));
    modes.slack = "mock";
  }

  const notionTok = env.NOTION_TOKEN;
  if (live && notionTok) {
    providers.set("notion.page", notionPageProvider(liveNotion(notionTok, g)));
    modes.notion = "live";
  } else {
    providers.set("notion.page", notionPageProvider(mockNotion(world, g)));
    modes.notion = "mock";
  }

  const linearKey = env.LINEAR_API_KEY;
  if (live && linearKey) {
    providers.set("linear.issue", linearIssueProvider(liveLinear(linearKey, g)));
    modes.linear = "live";
  } else {
    providers.set("linear.issue", linearIssueProvider(mockLinear(world, g)));
    modes.linear = "mock";
  }

  const ghOwner = env.GITHUB_OWNER;
  if (live && ghOwner) {
    providers.set("github.repo", githubRepoProvider(liveGithub(ghOwner, g)));
    modes.github = "live";
  } else {
    providers.set("github.repo", githubRepoProvider(mockGithub(world, g)));
    modes.github = "mock";
  }

  return { providers, modes, world };
}
