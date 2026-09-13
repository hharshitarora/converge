import type { Observed, Provider, ResourceSpec, RunContext } from "../types.js";
import { diffProps, guard, type GuardCtx } from "./support.js";
import type { MockWorld } from "./mockworld.js";

/**
 * Linear issue provider.
 *
 * Natural key is (team key, title). Sub-issues declare `dependsOn` on their
 * parent so the engine orders them; the parent's external id is resolved from
 * the run's ledger at apply time, never hardcoded into the spec.
 */

export interface LinearClient {
  findIssue(teamKey: string, title: string): Promise<LinearIssueView | null>;
  createIssue(
    teamKey: string,
    title: string,
    description: string,
    parentExternalId?: string,
  ): Promise<{ id: string; identifier: string }>;
  updateIssue(id: string, description: string): Promise<void>;
  archiveIssue(id: string): Promise<void>;
}

export interface LinearIssueView {
  id: string;
  identifier: string;
  title: string;
  description: string;
  parentId?: string;
}

const FIELDS = ["description"];

export function linearIssueProvider(client: LinearClient): Provider {
  return {
    kind: "linear.issue",

    async observe(spec: ResourceSpec): Promise<Observed> {
      const iss = await client.findIssue(
        String(spec.desired.teamKey ?? ""),
        spec.naturalKey,
      );
      if (!iss) return { exists: false, props: {} };
      return {
        exists: true,
        externalId: iss.id,
        props: { description: iss.description, identifier: iss.identifier },
      };
    },

    diff(spec, observed, _ctx) {
      return diffProps(spec, observed, FIELDS);
    },

    async create(spec, ctx: RunContext) {
      // Resolve the parent through the ledger populated earlier in this run.
      const parentKey = spec.dependsOn?.[0];
      const parentId = parentKey ? ctx.state.get(parentKey) : undefined;
      const r = await client.createIssue(
        String(spec.desired.teamKey ?? ""),
        spec.naturalKey,
        String(spec.desired.description ?? ""),
        parentId,
      );
      return { externalId: r.id };
    },

    // Linear archives rather than destroys, and it is restorable.
    async destroy(_spec, observed) {
      await client.archiveIssue(observed.externalId!);
    },

    async update(spec, observed) {
      await client.updateIssue(
        observed.externalId!,
        String(spec.desired.description ?? ""),
      );
    },
  };
}

// --- mock ----------------------------------------------------------------

export function mockLinear(world: MockWorld, g: GuardCtx): LinearClient {
  const K = "linear.issue";
  return {
    findIssue: (teamKey, title) =>
      guard(g, "observe", K, () => {
        const i = world.findIssue(teamKey, title);
        return i
          ? {
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              description: i.description,
              parentId: i.parentId,
            }
          : null;
      }),
    createIssue: (teamKey, title, description, parentId) =>
      guard(
        g,
        "create",
        K,
        () => {
          const i = world.createIssue(teamKey, title, description, parentId);
          return { id: i.id, identifier: i.identifier };
        },
        // partial_write: issue exists, description never lands.
        () => {
          const i = world.createIssue(teamKey, title, "", parentId);
          return { id: i.id, identifier: i.identifier };
        },
      ),
    updateIssue: (id, description) =>
      guard(g, "update", K, () => {
        const i = world.data.linear.issues.find((x) => x.id === id);
        if (i) {
          i.description = description;
          world.record("linear", "update_issue", i.title);
        }
      }),
    archiveIssue: (id) =>
      guard(g, "update", K, () => {
        const idx = world.data.linear.issues.findIndex((x) => x.id === id);
        if (idx >= 0) {
          world.record("linear", "archive_issue", world.data.linear.issues[idx]!.title);
          world.data.linear.issues.splice(idx, 1);
        }
      }),
  };
}

// --- live ----------------------------------------------------------------

export function liveLinear(apiKey: string, g: GuardCtx): LinearClient {
  const K = "linear.issue";
  const teamIds = new Map<string, string>();

  const gql = async (query: string, variables: Record<string, unknown> = {}) => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as {
      data?: any;
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error("linear: " + json.errors[0]!.message);
    return json.data;
  };

  const teamId = async (key: string) => {
    if (teamIds.has(key)) return teamIds.get(key)!;
    const d = await gql(
      "query($k:String!){ teams(filter:{key:{eq:$k}}, first:1){ nodes{ id key } } }",
      { k: key },
    );
    const id = d?.teams?.nodes?.[0]?.id;
    if (!id) throw new Error("linear: no team with key " + key);
    teamIds.set(key, id);
    return id;
  };

  const FIND = [
    "query($k:String!,$t:String!){",
    "  issues(filter:{team:{key:{eq:$k}}, title:{eq:$t}}, first:1){",
    "    nodes{ id identifier title description parent{ id } } } }",
  ].join("\n");

  const CREATE = [
    "mutation($i:IssueCreateInput!){",
    "  issueCreate(input:$i){ success issue{ id identifier } } }",
  ].join("\n");

  const UPDATE = [
    "mutation($id:String!,$i:IssueUpdateInput!){",
    "  issueUpdate(id:$id,input:$i){ success } }",
  ].join("\n");

  const ARCHIVE = "mutation($id:String!){ issueArchive(id:$id){ success } }";

  return {
    findIssue: (teamKey, title) =>
      guard(g, "observe", K, async () => {
        const d = await gql(FIND, { k: teamKey, t: title });
        const n = d?.issues?.nodes?.[0];
        return n
          ? {
              id: n.id,
              identifier: n.identifier,
              title: n.title,
              description: n.description ?? "",
              parentId: n.parent?.id,
            }
          : null;
      }),

    createIssue: (teamKey, title, description, parentId) =>
      guard(g, "create", K, async () => {
        const tid = await teamId(teamKey);
        const d = await gql(CREATE, {
          i: { teamId: tid, title, description, parentId },
        });
        const iss = d?.issueCreate?.issue;
        if (!iss) throw new Error("linear: issueCreate returned no issue");
        return { id: iss.id, identifier: iss.identifier };
      }),

    updateIssue: (id, description) =>
      guard(g, "update", K, async () => {
        await gql(UPDATE, { id, i: { description } });
      }),

    archiveIssue: (id) =>
      guard(g, "update", K, async () => {
        await gql(ARCHIVE, { id });
      }),
  };
}
