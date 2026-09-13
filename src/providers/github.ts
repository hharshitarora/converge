import { execFileSync } from "node:child_process";
import type { Observed, Provider, ResourceSpec } from "../types.js";
import { diffProps, guard, type GuardCtx } from "./support.js";
import type { MockWorld } from "./mockworld.js";

/**
 * GitHub repo provider. Natural key is the repo name under the target owner,
 * which GitHub enforces as unique -- the strongest natural key of the four.
 */

export interface GithubClient {
  findRepo(name: string): Promise<GithubRepoView | null>;
  createRepo(name: string, description: string): Promise<{ id: string }>;
  updateRepo(name: string, description: string): Promise<void>;
}

export interface GithubRepoView {
  id: string;
  name: string;
  description: string;
}

const FIELDS = ["description"];

export function githubRepoProvider(client: GithubClient): Provider {
  return {
    kind: "github.repo",

    async observe(spec: ResourceSpec): Promise<Observed> {
      const r = await client.findRepo(spec.naturalKey);
      if (!r) return { exists: false, props: {} };
      return {
        exists: true,
        externalId: r.id,
        props: { description: r.description },
      };
    },

    diff(spec, observed, _ctx) {
      return diffProps(spec, observed, FIELDS);
    },

    async create(spec) {
      const r = await client.createRepo(
        spec.naturalKey,
        String(spec.desired.description ?? ""),
      );
      return { externalId: r.id };
    },

    async update(spec) {
      await client.updateRepo(
        spec.naturalKey,
        String(spec.desired.description ?? ""),
      );
    },
  };
}

// --- mock ----------------------------------------------------------------

export function mockGithub(world: MockWorld, g: GuardCtx): GithubClient {
  const K = "github.repo";
  return {
    findRepo: (name) =>
      guard(g, "observe", K, () => {
        const r = world.findRepo(name);
        return r ? { id: r.id, name: r.name, description: r.description } : null;
      }),
    createRepo: (name, description) =>
      guard(
        g,
        "create",
        K,
        () => ({ id: world.createRepo(name, description).id }),
        // partial_write: repo exists, description never lands.
        () => ({ id: world.createRepo(name, "").id }),
      ),
    updateRepo: (name, description) =>
      guard(g, "update", K, () => {
        const r = world.findRepo(name);
        if (r) {
          r.description = description;
          world.record("github", "update_repo", name);
        }
      }),
  };
}

// --- live ----------------------------------------------------------------

/** Uses the already-authenticated gh CLI, so no extra token setup is needed. */
export function liveGithub(owner: string, g: GuardCtx): GithubClient {
  const K = "github.repo";
  const gh = (args: string[]): string => {
    try {
      return execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      const err = String(e.stderr ?? e.message ?? e);
      // A 404 is a legitimate "does not exist", not a failure to observe.
      if (/Not Found|404/i.test(err)) return "__404__";
      throw new Error("gh " + args[0] + ": " + err.slice(0, 200));
    }
  };

  return {
    findRepo: (name) =>
      guard(g, "observe", K, () => {
        const out = gh(["api", "repos/" + owner + "/" + name]);
        if (out === "__404__") return null;
        const j = JSON.parse(out) as {
          node_id: string;
          name: string;
          description: string | null;
        };
        return { id: j.node_id, name: j.name, description: j.description ?? "" };
      }),
    createRepo: (name, description) =>
      guard(g, "create", K, () => {
        const out = gh([
          "api", "-X", "POST", "user/repos",
          "-f", "name=" + name,
          "-f", "description=" + description,
          "-F", "private=true",
        ]);
        const j = JSON.parse(out) as { node_id: string };
        return { id: j.node_id };
      }),
    updateRepo: (name, description) =>
      guard(g, "update", K, () => {
        gh([
          "api", "-X", "PATCH", "repos/" + owner + "/" + name,
          "-f", "description=" + description,
        ]);
      }),
  };
}
