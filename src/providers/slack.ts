import type { Observed, Provider, ResourceSpec, RunContext } from "../types.js";
import { diffProps, guard, type GuardCtx } from "./support.js";
import type { MockWorld } from "./mockworld.js";

/**
 * Slack channel provider.
 *
 * Natural key is the channel name, which Slack already enforces as unique in a
 * workspace. That is what lets us stay idempotent with no local state: we ask
 * Slack "is there a channel called acme-onboarding?" rather than trusting a
 * ledger that may be stale, missing, or from someone else's laptop.
 */

export interface SlackClient {
  findChannel(name: string): Promise<SlackChannelView | null>;
  createChannel(name: string): Promise<{ id: string }>;
  setTopic(id: string, topic: string): Promise<void>;
  setPurpose(id: string, purpose: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  archive(id: string): Promise<void>;
}

export interface SlackChannelView {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  archived: boolean;
}

const FIELDS = ["topic", "purpose"];

export function slackChannelProvider(client: SlackClient): Provider {
  return {
    kind: "slack.channel",

    async observe(spec: ResourceSpec): Promise<Observed> {
      const ch = await client.findChannel(spec.naturalKey);
      if (!ch) return { exists: false, props: {} };
      // An archived channel still OWNS the name -- Slack rejects a create
      // while it exists. So it is present-but-wrong, not absent. Reporting it
      // as absent sends the engine into a create loop that can never succeed:
      // every pass re-creates, every pass re-finds the archived one. The
      // repair is to unarchive, which is an update.
      return {
        exists: true,
        externalId: ch.id,
        props: { topic: ch.topic, purpose: ch.purpose, archived: ch.archived },
      };
    },

    diff(spec, observed, _ctx) {
      const fields = diffProps(spec, observed, FIELDS);
      // `archived: false` is an implicit part of every channel's desired
      // state; no spec should have to remember to say so.
      if (observed.exists && observed.props.archived === true) {
        fields.unshift({ field: "archived", from: true, to: false });
      }
      return fields;
    },

    async create(spec) {
      const { id } = await client.createChannel(spec.naturalKey);
      if (spec.desired.topic) await client.setTopic(id, String(spec.desired.topic));
      if (spec.desired.purpose)
        await client.setPurpose(id, String(spec.desired.purpose));
      return { externalId: id };
    },

    // Archive, never delete: Slack itself offers no channel deletion, and the
    // history stays readable. Reversible beats thorough.
    async destroy(_spec, observed) {
      await client.archive(observed.externalId!);
    },

    async update(spec, observed, fields) {
      const id = observed.externalId!;
      // Unarchive first: topic and purpose writes fail on an archived channel.
      if (fields.some((f) => f.field === "archived")) await client.unarchive(id);
      for (const f of fields) {
        if (f.field === "topic") await client.setTopic(id, String(f.to));
        if (f.field === "purpose") await client.setPurpose(id, String(f.to));
      }
    },
  };
}

// --- mock ----------------------------------------------------------------

export function mockSlack(world: MockWorld, g: GuardCtx): SlackClient {
  const K = "slack.channel";
  return {
    findChannel: (name) =>
      guard(g, "observe", K, () => {
        const c = world.findChannel(name);
        return c
          ? {
              id: c.id,
              name: c.name,
              topic: c.topic,
              purpose: c.purpose,
              archived: c.archived,
            }
          : null;
      }),
    createChannel: (name) =>
      guard(
        g,
        "create",
        K,
        () => ({ id: world.createChannel(name).id }),
        // partial_write: the channel appears, but topic/purpose never land.
        () => ({ id: world.createChannel(name).id, __partial: true }) as { id: string },
      ),
    setTopic: (id, topic) =>
      guard(g, "update", K, () => {
        const c = world.data.slack.channels.find((x) => x.id === id);
        if (c) {
          c.topic = topic;
          world.record("slack", "set_topic", c.name);
        }
      }),
    setPurpose: (id, purpose) =>
      guard(g, "update", K, () => {
        const c = world.data.slack.channels.find((x) => x.id === id);
        if (c) {
          c.purpose = purpose;
          world.record("slack", "set_purpose", c.name);
        }
      }),
    unarchive: (id) =>
      guard(g, "update", K, () => {
        const c = world.data.slack.channels.find((x) => x.id === id);
        if (c) {
          c.archived = false;
          world.record("slack", "unarchive", c.name);
        }
      }),
    archive: (id) =>
      guard(g, "update", K, () => {
        const c = world.data.slack.channels.find((x) => x.id === id);
        if (c) {
          c.archived = true;
          world.record("slack", "archive", c.name);
        }
      }),
  };
}

// --- live ----------------------------------------------------------------

export function liveSlack(token: string, g: GuardCtx): SlackClient {
  const K = "slack.channel";

  /**
   * Listing private channels needs `groups:read` on top of `channels:read`.
   * Rather than demand the broader scope from every install, we ask for both
   * and narrow to public-only the first time Slack says `missing_scope`. An
   * install that can see every public channel is far more useful than one that
   * cannot read anything, and the narrowing is remembered so we do not pay a
   * failed call per page.
   */
  let privateVisible = true;

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

  interface ListResponse {
    channels: {
      id: string;
      name: string;
      is_archived: boolean;
      topic?: { value: string };
      purpose?: { value: string };
    }[];
    response_metadata?: { next_cursor?: string };
  }

  return {
    findChannel: (name) =>
      guard(g, "observe", K, async () => {
        let cursor = "";
        // Paginate: the channel we want may not be on page one, and a false
        // "not found" here would cause a duplicate create.
        for (let page = 0; page < 20; page++) {
          const body: Record<string, string> = {
            types: privateVisible ? "public_channel,private_channel" : "public_channel",
            limit: "200",
            exclude_archived: "false",
          };
          if (cursor) body.cursor = cursor;

          let r: ListResponse;
          try {
            r = (await call("conversations.list", body, true)) as unknown as ListResponse;
          } catch (e) {
            if (privateVisible && /missing_scope/.test(String(e))) {
              privateVisible = false;
              continue; // same page, narrower scope
            }
            throw e;
          }

          const hit = r.channels.find((c) => c.name === name);
          if (hit) {
            return {
              id: hit.id,
              name: hit.name,
              topic: hit.topic?.value ?? "",
              purpose: hit.purpose?.value ?? "",
              archived: hit.is_archived,
            };
          }
          cursor = r.response_metadata?.next_cursor ?? "";
          if (!cursor) break;
        }
        return null;
      }),

    createChannel: (name) =>
      guard(g, "create", K, async () => {
        const r = (await call("conversations.create", { name })) as unknown as {
          channel: { id: string };
        };
        return { id: r.channel.id };
      }),

    setTopic: (channel, topic) =>
      guard(g, "update", K, async () => {
        await call("conversations.setTopic", { channel, topic });
      }),

    setPurpose: (channel, purpose) =>
      guard(g, "update", K, async () => {
        await call("conversations.setPurpose", { channel, purpose });
      }),

    unarchive: (channel) =>
      guard(g, "update", K, async () => {
        await call("conversations.unarchive", { channel });
      }),

    archive: (channel) =>
      guard(g, "update", K, async () => {
        await call("conversations.archive", { channel });
      }),
  };
}
