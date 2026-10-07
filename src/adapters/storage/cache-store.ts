/**
 * File-backed {@link Cache} under `data/cache/`. Never leaves the
 * machine. Layout: one value file per entry (`<namespace>/<hash>.json`) plus `index.json` holding
 * each entry's key, expiry, site tags, and size, so `clearSite` and `stats` need no value reads.
 * Expired entries are dropped lazily on access and on load. Operations are serialized in-process.
 */
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Cache, CacheNamespace, CacheSetOptions, CacheStats } from "../../ports/cache.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import { SerialQueue, readJsonFile, writeFileAtomic, writeJsonAtomic } from "./json-file.js";

const NAMESPACES: readonly CacheNamespace[] = ["search", "read", "page-chain"];

interface IndexEntry {
  namespace: CacheNamespace;
  key: string;
  file: string;
  expiresAt: number;
  sites: string[];
  bytes: number;
}

interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}

/** Default cache directory inside the data dir. */
export function cacheDir(dataDir: string): string {
  return join(dataDir, "cache");
}

export interface FileCacheOptions {
  clock?: Clock | undefined;
}

export class FileCache implements Cache {
  private readonly queue = new SerialQueue();
  private readonly clock: Clock;
  private index: Map<string, IndexEntry> | null = null;

  constructor(
    readonly dir: string,
    options: FileCacheOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined> {
    return this.queue.run(async () => {
      const index = await this.load();
      const id = entryId(namespace, key);
      const entry = index.get(id);
      if (!entry) return undefined;
      if (entry.expiresAt <= this.now()) {
        await this.drop(index, id);
        return undefined;
      }
      try {
        return JSON.parse(await readFile(join(this.dir, entry.file), "utf8")) as T;
      } catch {
        await this.drop(index, id);
        return undefined;
      }
    });
  }

  set<T>(namespace: CacheNamespace, key: string, value: T, options: CacheSetOptions): Promise<void> {
    return this.queue.run(async () => {
      if (!(options.ttlMs > 0)) return;
      const text = JSON.stringify(value);
      if (text === undefined) return;
      const index = await this.load();
      const id = entryId(namespace, key);
      const file = `${namespace}/${id}.json`;
      await writeFileAtomic(join(this.dir, file), text);
      index.set(id, {
        namespace,
        key,
        file,
        expiresAt: this.now() + options.ttlMs,
        sites: [...new Set(options.sites)].sort(),
        bytes: Buffer.byteLength(text, "utf8"),
      });
      await this.persist(index);
    });
  }

  delete(namespace: CacheNamespace, key: string): Promise<void> {
    return this.queue.run(async () => {
      const index = await this.load();
      await this.drop(index, entryId(namespace, key));
    });
  }

  clearSite(site: string): Promise<void> {
    return this.queue.run(async () => {
      const index = await this.load();
      const ids = [...index.entries()].filter(([, e]) => e.sites.includes(site)).map(([id]) => id);
      await this.dropMany(index, ids);
    });
  }

  clearAll(): Promise<void> {
    return this.queue.run(async () => {
      const index = await this.load();
      index.clear();
      for (const ns of NAMESPACES) await rm(join(this.dir, ns), { recursive: true, force: true });
      await this.persist(index);
    });
  }

  stats(): Promise<CacheStats> {
    return this.queue.run(async () => {
      const index = await this.load();
      await this.purgeExpiredIn(index);
      let bytes = 0;
      for (const e of index.values()) bytes += e.bytes;
      return { entries: index.size, bytes };
    });
  }

  /** Entries and bytes per site tag (an entry tagged with several sites counts for each). */
  statsBySite(): Promise<Record<string, CacheStats>> {
    return this.queue.run(async () => {
      const index = await this.load();
      await this.purgeExpiredIn(index);
      const out: Record<string, CacheStats> = {};
      for (const e of index.values()) {
        for (const site of e.sites) {
          const s = (out[site] ??= { entries: 0, bytes: 0 });
          s.entries += 1;
          s.bytes += e.bytes;
        }
      }
      return out;
    });
  }

  /** Removes expired entries; returns how many were removed. */
  purgeExpired(): Promise<number> {
    return this.queue.run(async () => this.purgeExpiredIn(await this.load()));
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  private async load(): Promise<Map<string, IndexEntry>> {
    if (this.index) return this.index;
    const index = new Map<string, IndexEntry>();
    let raw: unknown;
    try {
      raw = await readJsonFile(this.indexPath());
    } catch {
      raw = undefined; // a corrupt index only loses cache entries
    }
    const file = raw as Partial<IndexFile> | undefined;
    if (file && file.version === 1 && Array.isArray(file.entries)) {
      for (const e of file.entries) {
        if (!isIndexEntry(e)) continue;
        try {
          await stat(join(this.dir, e.file));
        } catch {
          continue;
        }
        index.set(e.file.slice(e.namespace.length + 1, -".json".length), e);
      }
    }
    this.index = index;
    await this.purgeExpiredIn(index);
    return index;
  }

  private async purgeExpiredIn(index: Map<string, IndexEntry>): Promise<number> {
    const now = this.now();
    const ids = [...index.entries()].filter(([, e]) => e.expiresAt <= now).map(([id]) => id);
    if (ids.length > 0) await this.dropMany(index, ids);
    return ids.length;
  }

  private async drop(index: Map<string, IndexEntry>, id: string): Promise<void> {
    await this.dropMany(index, [id]);
  }

  private async dropMany(index: Map<string, IndexEntry>, ids: readonly string[]): Promise<void> {
    let removed = false;
    for (const id of ids) {
      const entry = index.get(id);
      if (!entry) continue;
      index.delete(id);
      removed = true;
      await rm(join(this.dir, entry.file), { force: true });
    }
    if (removed) await this.persist(index);
  }

  private async persist(index: Map<string, IndexEntry>): Promise<void> {
    const file: IndexFile = { version: 1, entries: [...index.values()] };
    await writeJsonAtomic(this.indexPath(), file);
  }
}

function entryId(namespace: CacheNamespace, key: string): string {
  return createHash("sha256").update(`${namespace}\u0000${key}`, "utf8").digest("hex").slice(0, 40);
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["namespace"] === "string" &&
    (NAMESPACES as readonly string[]).includes(e["namespace"]) &&
    typeof e["key"] === "string" &&
    typeof e["file"] === "string" &&
    /^[a-z-]+\/[0-9a-f]{40}\.json$/.test(e["file"]) &&
    typeof e["expiresAt"] === "number" &&
    typeof e["bytes"] === "number" &&
    Array.isArray(e["sites"]) &&
    e["sites"].every((s) => typeof s === "string")
  );
}
