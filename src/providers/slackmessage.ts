import type { Observed, Provider, ResourceSpec, RunContext } from "../types.js";
import { guard, type GuardCtx } from "./support.js";
import type { MockWorld } from "./mockworld.js";

/**
 * The Slack kickoff message: the resource that ties the workflow together.
 *
 * Its text is composed from what the OTHER apps returned. `{{key}}` in the
 * template is replaced with that resource's real external identifier — the
 * Linear issue keys, the Notion page id, the GitHub repo. So this message
 * genuinely cannot be written until Notion, Linear and GitHub have each
 * produced an id: the data flows across apps rather than four integrations
 * running side by side.
 *
 * Which raises the interesting question: what is its natural key? A message
 * has no name. We embed an invisible marker derived from the resource key and
 * search the channel for it. That marker IS the identity — post the same
 * message twice and the second one is found, not duplicated.
 */

export interface SlackMessageClient {
  findMessage(channelId: string, marker: string): Promise<{ id: string; text: string } | null>;
  postMessage(channelId: string, text: string): Promise<{ id: string }>;
  editMessage(channelId: string, id: string, text: string): Promise<void>;
}

/** Zero-width marker: invisible to humans, unique per resource. */
export function markerFor(key: string): string {
  const bits = [...key].reduce((a, c) => a + c.charCodeAt(0), 0).toString(2);
  return bits.replace(/0/g, "​").replace(/1/g, "‌");
}

/** Replace {{resource.key}} with that resource's resolved external id. */
export function render(spec: ResourceSpec, ctx: RunContext): string {
  const template = String(spec.desired.text ?? "");
  return template.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => {
    const id = ctx.state.get(key.trim());
    // Before its dependency exists there is nothing true to say, so the
    // message renders a placeholder, converges once, and is corrected on the
    // next pass. Wrong-but-present is never preferable to visibly pending.
    return id ?? "(pending)";
  });
}

export function slackMessageProvider(client: SlackMessageClient): Provider {
  return {
    kind: "slack.message",

    async observe(spec: ResourceSpec, ctx: RunContext): Promise<Observed> {
      const channelId = ctx.state.get(String(spec.desired.channelKey ?? ""));
      // Without its channel there is nothing to search; report absent rather
      // than guessing, and the next pass will have the channel.
      if (!channelId) return { exists: false, props: {} };
      const msg = await client.findMessage(channelId, markerFor(spec.key));
      if (!msg) return { exists: false, props: {} };
      return { exists: true, externalId: msg.id, props: { text: msg.text } };
    },

    diff(spec, observed, ctx) {
      if (!observed.exists) return [{ field: "text", from: undefined, to: "(new message)" }];
      const want = render(spec, ctx) + markerFor(spec.key);
      const have = String(observed.props.text ?? "");
      return want.trim() === have.trim() ? [] : [{ field: "text", from: "stale", to: "updated" }];
    },

    async create(spec, ctx) {
      const channelId = ctx.state.get(String(spec.desired.channelKey ?? ""));
      if (!channelId) throw new Error("slack.message: channel not resolved yet");
      const r = await client.postMessage(channelId, render(spec, ctx) + markerFor(spec.key));
      return { externalId: r.id };
    },

    async update(spec, observed, _fields, ctx) {
      const channelId = ctx.state.get(String(spec.desired.channelKey ?? ""));
      if (!channelId) throw new Error("slack.message: channel not resolved yet");
      await client.editMessage(
        channelId,
        observed.externalId!,
        render(spec, ctx) + markerFor(spec.key),
      );
    },
  };
}

// --- mock ----------------------------------------------------------------

export function mockSlackMessage(world: MockWorld, g: GuardCtx): SlackMessageClient {
  const K = "slack.message";
  return {
    findMessage: (channelId, marker) =>
      guard(g, "observe", K, () => {
        const m = world.findMessage(channelId, marker);
        return m ? { id: m.id, text: m.text } : null;
      }),
    postMessage: (channelId, text) =>
      guard(
        g,
        "create",
        K,
        () => ({ id: world.createMessage(channelId, text).id }),
        // partial_write: the message posts, but truncated.
        () => ({ id: world.createMessage(channelId, text.slice(0, 20)).id }),
      ),
    editMessage: (_channelId, id, text) =>
      guard(g, "update", K, () => {
        const m = world.data.slack.messages.find((x) => x.id === id);
        if (m) {
          m.text = text;
          world.record("slack", "edit_message", id);
        }
      }),
  };
}

// --- live ----------------------------------------------------------------

export function liveSlackMessage(token: string, g: GuardCtx): SlackMessageClient {
  const K = "slack.message";
  const call = async (method: string, body: Record<string, unknown>, get = false) => {
    const url = "https://slack.com/api/" + method;
    const res = get
      ? await fetch(url + "?" + new URLSearchParams(body as Record<string, string>), {
          headers: { Authorization: "Bearer " + token },
        })
      : await fetch(url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        });
    const json = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
    if (!json.ok) throw new Error("slack." + method + ": " + (json.error ?? res.status));
    return json;
  };

  return {
    findMessage: (channel, marker) =>
      guard(g, "observe", K, async () => {
        const r = (await call(
          "conversations.history",
          { channel, limit: "100" },
          true,
        )) as unknown as { messages: { ts: string; text: string }[] };
        const hit = r.messages.find((m) => m.text.includes(marker));
        return hit ? { id: hit.ts, text: hit.text } : null;
      }),
    postMessage: (channel, text) =>
      guard(g, "create", K, async () => {
        const r = (await call("chat.postMessage", { channel, text })) as unknown as { ts: string };
        return { id: r.ts };
      }),
    editMessage: (channel, ts, text) =>
      guard(g, "update", K, async () => {
        await call("chat.update", { channel, ts, text });
      }),
  };
}
