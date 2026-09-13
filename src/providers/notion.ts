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
  archivePage(id: string): Promise<void>;
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

    diff(spec, observed, _ctx) {
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

    // Notion's own "delete" is archiving, and it is undoable from the trash.
    async destroy(_spec, observed) {
      await client.archivePage(observed.externalId!);
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
    archivePage: (id) =>
      guard(g, "update", K, () => {
        const p = world.data.notion.pages.find((x) => x.id === id);
        if (p) {
          p.archived = true;
          world.record("notion", "archive_page", p.title);
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
  /**
   * Accept whatever a human pasted. Notion ids appear as bare hex, dashed
   * UUIDs, full page URLs, and URLs with a `?v=` view parameter; the last is
   * easy to copy by accident from a database view and produces a 404 that
   * looks exactly like a permissions problem.
   */
  const norm = (id: string) => {
    const cleaned = id.split("?")[0] ?? id;
    const hex = cleaned.replace(/[^0-9a-fA-F]/g, "");
    return hex.slice(-32);
  };

  return {
    findPage: (parentId, title) =>
      guard(g, "observe", K, async () => {
        /**
         * Listing the parent's children, NOT /v1/search.
         *
         * Search is eventually consistent: a page created seconds ago is not
         * indexed yet, so a search-based lookup answers "absent" about a page
         * that definitely exists. Under convergence that is catastrophic --
         * every pass re-creates, and a run against real Notion produced four
         * identical pages before the pass limit stopped it.
         *
         * The whole no-duplicate guarantee rests on an assumption that was
         * never written down: that finding a resource by natural key is
         * read-after-write consistent. Child listing is; search is not.
         */
        let cursor = "";
        let hit: { id: string; archived?: boolean } | undefined;
        for (let page = 0; page < 20 && !hit; page++) {
          const q = cursor ? "&start_cursor=" + cursor : "";
          const r = (await api(
            "/blocks/" + norm(parentId) + "/children?page_size=100" + q,
            { method: "GET" },
          )) as { results: any[]; next_cursor?: string; has_more?: boolean };

          hit = r.results.find(
            (b) => b.type === "child_page" && b.child_page?.title === title,
          );
          if (hit || !r.has_more) break;
          cursor = r.next_cursor ?? "";
          if (!cursor) break;
        }
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
        // Notion answers 404 both for "does not exist" and "your integration
        // cannot see it", and a database id pointed at this provider produces
        // the same 404 a third way. Three very different fixes behind one
        // status code, so name which one it is before failing.
        const parent = norm(parentId);
        const asDb = await fetch("https://api.notion.com/v1/databases/" + parent, {
          headers: H,
        });
        if (asDb.ok) {
          throw new Error(
            "notion: NOTION_PARENT_PAGE_ID points at a database, not a page. " +
              "This provider creates child pages under a page parent. Create a " +
              "plain page, share it with the integration, and use its id.",
          );
        }

        const r = (await api("/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { page_id: parent },
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

    archivePage: (id) =>
      guard(g, "update", K, async () => {
        await api("/pages/" + id, {
          method: "PATCH",
          body: JSON.stringify({ archived: true }),
        });
      }),
  };
}
