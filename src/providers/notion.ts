import type { Observed, Provider, ResourceSpec } from "../types.js";
import { diffProps, guard, type GuardCtx } from "./support.js";
import type { MockWorld } from "./mockworld.js";

/**
 * Notion account-record provider.
 *
 * Natural key is (parent page, title). Notion does not enforce title
 * uniqueness, which is precisely why a script that blindly creates pages ends
 * up with six "Acme Corp" records after six retries. We search first, always.
 */

export interface NotionClient {
  findPage(parentId: string, title: string): Promise<NotionPageView | null>;
  createPage(parentId: string, title: string, summary: string): Promise<{ id: string }>;
  updatePage(id: string, title: string, summary: string): Promise<void>;
}

export interface NotionPageView {
  id: string;
  title: string;
  summary: string;
  archived: boolean;
}

const FIELDS = ["summary"];

export function notionPageProvider(client: NotionClient): Provider {
  return {
    kind: "notion.page",

    async observe(spec: ResourceSpec): Promise<Observed> {
      const parent = String(spec.desired.parentId ?? "");
      const pg = await client.findPage(parent, spec.naturalKey);
      if (!pg || pg.archived) return { exists: false, props: {} };
      return { exists: true, externalId: pg.id, props: { summary: pg.summary } };
    },

    diff(spec, observed) {
      return diffProps(spec, observed, FIELDS);
    },

    async create(spec) {
      const r = await client.createPage(
        String(spec.desired.parentId ?? ""),
        spec.naturalKey,
        String(spec.desired.summary ?? ""),
      );
      return { externalId: r.id };
    },

    async update(spec, observed) {
      await client.updatePage(
        observed.externalId!,
        spec.naturalKey,
        String(spec.desired.summary ?? ""),
      );
    },
  };
}

// --- mock ----------------------------------------------------------------

export function mockNotion(world: MockWorld, g: GuardCtx): NotionClient {
  const K = "notion.page";
  return {
    findPage: (parentId, title) =>
      guard(g, "observe", K, () => {
        const p = world.findPage(parentId, title);
        return p
          ? {
              id: p.id,
              title: p.title,
              summary: String(p.props.summary ?? ""),
              archived: p.archived,
            }
          : null;
      }),
    createPage: (parentId, title, summary) =>
      guard(
        g,
        "create",
        K,
        () => ({ id: world.createPage(parentId, title, { summary }).id }),
        // partial_write: page exists, body never written.
        () => ({ id: world.createPage(parentId, title, { summary: "" }).id }),
      ),
    updatePage: (id, _title, summary) =>
      guard(g, "update", K, () => {
        const p = world.data.notion.pages.find((x) => x.id === id);
        if (p) {
          p.props.summary = summary;
          world.record("notion", "update_page", p.title);
        }
      }),
  };
}

// --- live ----------------------------------------------------------------

export function liveNotion(token: string, g: GuardCtx): NotionClient {
  const K = "notion.page";
  const H = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
  const api = async (p: string, init: RequestInit) => {
    const res = await fetch(`https://api.notion.com/v1${p}`, { ...init, headers: H });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(`notion ${p}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  };
  const norm = (id: string) => id.replace(/-/g, "");

  return {
    findPage: (parentId, title) =>
      guard(g, "observe", K, async () => {
        const r = (await api("/search", {
          method: "POST",
          body: JSON.stringify({
            query: title,
            filter: { property: "object", value: "page" },
            page_size: 50,
          }),
        })) as { results: any[] };
        const hit = r.results.find((p) => {
          const t = p.properties?.title?.title?.[0]?.plain_text ?? "";
          const parent = p.parent?.page_id ? norm(p.parent.page_id) : "";
          return t === title && parent === norm(parentId);
        });
        if (!hit) return null;
        // Read the first paragraph back as the summary — this is the read-back
        // that proves the body actually landed, not just the page shell.
        const kids = (await api(`/blocks/${hit.id}/children?page_size=10`, {
          method: "GET",
        })) as { results: any[] };
        const para = kids.results.find((b) => b.type === "paragraph");
        const summary = para?.paragraph?.rich_text?.[0]?.plain_text ?? "";
        return { id: hit.id, title, summary, archived: !!hit.archived };
      }),

    createPage: (parentId, title, summary) =>
      guard(g, "create", K, async () => {
        const r = (await api("/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { page_id: parentId },
            properties: { title: { title: [{ text: { content: title } }] } },
            children: summary
              ? [
                  {
                    object: "block",
                    type: "paragraph",
                    paragraph: { rich_text: [{ type: "text", text: { content: summary } }] },
                  },
                ]
              : [],
          }),
        })) as { id: string };
        return { id: r.id };
      }),

    updatePage: (id, _title, summary) =>
      guard(g, "update", K, async () => {
        const kids = (await api(`/blocks/${id}/children?page_size=10`, {
          method: "GET",
        })) as { results: any[] };
        const para = kids.results.find((b) => b.type === "paragraph");
        const rich = [{ type: "text", text: { content: summary } }];
        if (para) {
          await api(`/blocks/${para.id}`, {
            method: "PATCH",
            body: JSON.stringify({ paragraph: { rich_text: rich } }),
          });
        } else {
          await api(`/blocks/${id}/children`, {
            method: "PATCH",
            body: JSON.stringify({
              children: [{ object: "block", type: "paragraph", paragraph: { rich_text: rich } }],
            }),
          });
        }
      }),
  };
}
