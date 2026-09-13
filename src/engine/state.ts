import fs from "node:fs";
import path from "node:path";
import type { LedgerEntry, ResourceKey, ResourceSpec, StateLedger } from "../types.js";

/**
 * The state ledger.
 *
 * For everything except deletion it is a pure cache. Every resource is findable
 * by natural key, so losing this file changes performance and nothing else —
 * `converge forget` proves that on demand, and the eval suite proves it 53
 * times over.
 *
 * Deletion is the single exception, and it is worth being precise about why.
 * "This should no longer exist" is not a fact any external app can report: you
 * cannot look at Slack and discover that a channel is unwanted. It is only
 * knowable by remembering that we once asked for it and no longer do. So
 * orphan detection — alone among everything here — genuinely needs recorded
 * history.
 *
 * That asymmetry decides the failure direction, which is the part that matters.
 * A lost ledger means we under-delete: resources linger that could have been
 * cleaned up. It can never mean we delete something we shouldn't have, because
 * we only ever remove what we can still prove we created.
 */

interface Persisted {
  version: 2;
  entries: Record<string, LedgerEntry>;
}

export class FileStateLedger implements StateLedger {
  private map: Record<string, LedgerEntry>;

  constructor(private file: string) {
    this.map = FileStateLedger.read(file);
  }

  private static read(file: string): Record<string, LedgerEntry> {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as
        | Persisted
        | Record<string, string>;
      if (raw && typeof raw === "object" && "version" in raw && raw.version === 2) {
        return (raw as Persisted).entries;
      }
      // Older ledgers stored key -> id. They carry no kind or natural key, so
      // their resources can still be resolved but never identified as orphans;
      // that is the safe direction, so upgrade quietly rather than discard.
      const out: Record<string, LedgerEntry> = {};
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        if (typeof v === "string") {
          out[k] = { externalId: v, kind: "slack.channel", naturalKey: "", desired: {} };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  get(key: ResourceKey) {
    return this.map[key]?.externalId;
  }

  set(key: ResourceKey, externalId: string) {
    const existing = this.map[key];
    if (existing) existing.externalId = externalId;
    else
      this.map[key] = { externalId, kind: "slack.channel", naturalKey: "", desired: {} };
  }

  record(spec: ResourceSpec, externalId: string) {
    this.map[spec.key] = {
      externalId,
      kind: spec.kind,
      naturalKey: spec.naturalKey,
      desired: spec.desired,
    };
  }

  entries(): [ResourceKey, LedgerEntry][] {
    // Only entries we can actually identify again are eligible to be orphans.
    return Object.entries(this.map).filter(([, e]) => !!e.naturalKey);
  }

  drop(key: ResourceKey) {
    delete this.map[key];
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload: Persisted = { version: 2, entries: this.map };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2));
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
  private map = new Map<ResourceKey, LedgerEntry>();

  get(k: ResourceKey) {
    return this.map.get(k)?.externalId;
  }
  set(k: ResourceKey, id: string) {
    const e = this.map.get(k);
    if (e) e.externalId = id;
    else this.map.set(k, { externalId: id, kind: "slack.channel", naturalKey: "", desired: {} });
  }
  record(spec: ResourceSpec, externalId: string) {
    this.map.set(spec.key, {
      externalId,
      kind: spec.kind,
      naturalKey: spec.naturalKey,
      desired: spec.desired,
    });
  }
  entries(): [ResourceKey, LedgerEntry][] {
    return [...this.map].filter(([, e]) => !!e.naturalKey);
  }
  drop(k: ResourceKey) {
    this.map.delete(k);
  }
  save() {}
  forget() {
    this.map.clear();
  }
}
