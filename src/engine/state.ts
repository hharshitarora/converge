import fs from "node:fs";
import path from "node:path";
import type { ResourceKey, StateLedger } from "../types.js";

/**
 * The state ledger: a cache of resource key -> external id.
 *
 * Deliberately NOT the source of truth. Terraform-style tools treat their
 * state file as authoritative, which is why a lost or stale state file is a
 * catastrophe there. Here the ledger is only ever an optimisation: every
 * resource is still findable by natural key, so deleting this file changes
 * performance and nothing else.
 *
 * `converge apply --forget` proves it: it wipes the ledger, re-runs, and the
 * census is unchanged -- no duplicates.
 */
export class FileStateLedger implements StateLedger {
  private map: Record<string, string>;

  constructor(private file: string) {
    try {
      this.map = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      this.map = {};
    }
  }

  get(key: ResourceKey) {
    return this.map[key];
  }

  set(key: ResourceKey, externalId: string) {
    this.map[key] = externalId;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
  }

  forget() {
    this.map = {};
  }

  size() {
    return Object.keys(this.map).length;
  }
}

/** Ledger that keeps nothing, used by evals to prove state-independence. */
export class MemoryStateLedger implements StateLedger {
  private map = new Map<string, string>();
  get(k: ResourceKey) {
    return this.map.get(k);
  }
  set(k: ResourceKey, id: string) {
    this.map.set(k, id);
  }
  save() {}
}
