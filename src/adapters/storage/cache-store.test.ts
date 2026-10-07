import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import type { Clock } from "../../ports/clock.js";
import { FileCache } from "./cache-store.js";
import { ResultCache, isCacheableSearch, readCacheKey, searchCacheKey } from "./result-cache.js";

class FakeClock implements Clock {
  constructor(public ms = Date.parse("2026-10-05T10:00:00Z")) {}
  now(): Date {
    return new Date(this.ms);
  }
}

describe("FileCache (data/cache)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let clock: FakeClock;
  let cache: FileCache;
  beforeEach(async () => {
    tmp = await makeTempDir();
    clock = new FakeClock();
    cache = new FileCache(join(tmp.dir, "cache"), { clock });
  });
  afterEach(async () => tmp.cleanup());

  it("stores JSON values until their TTL expires", async () => {
    await cache.set("read", "a:1", { text: "hello" }, { ttlMs: 1000, sites: ["a"] });
    expect(await cache.get("read", "a:1")).toEqual({ text: "hello" });
    clock.ms += 999;
    expect(await cache.get("read", "a:1")).toEqual({ text: "hello" });
    clock.ms += 1;
    expect(await cache.get("read", "a:1")).toBeUndefined();
    expect(await cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("keeps namespaces apart and survives a restart", async () => {
    await cache.set("search", "k", 1, { ttlMs: 60_000, sites: ["a"] });
    await cache.set("read", "k", 2, { ttlMs: 60_000, sites: ["a"] });
    const reopened = new FileCache(join(tmp.dir, "cache"), { clock });
    expect(await reopened.get("search", "k")).toBe(1);
    expect(await reopened.get("read", "k")).toBe(2);
  });

  it("clears one site's entries (including multi-site pages) and leaves others", async () => {
    await cache.set("read", "a:1", "A", { ttlMs: 60_000, sites: ["a"] });
    await cache.set("read", "b:1", "B", { ttlMs: 60_000, sites: ["b"] });
    await cache.set("search", "ab", "AB", { ttlMs: 60_000, sites: ["a", "b"] });
    await cache.clearSite("a");
    expect(await cache.get("read", "a:1")).toBeUndefined();
    expect(await cache.get("search", "ab")).toBeUndefined();
    expect(await cache.get("read", "b:1")).toBe("B");
    expect((await cache.stats()).entries).toBe(1);
    const files = await readdir(join(tmp.dir, "cache", "read"));
    expect(files).toHaveLength(1);
  });

  it("reports sizes overall and per site, and clears everything", async () => {
    await cache.set("read", "a:1", "x".repeat(100), { ttlMs: 60_000, sites: ["a"] });
    await cache.set("read", "b:1", "y".repeat(10), { ttlMs: 60_000, sites: ["b"] });
    expect(await cache.stats()).toEqual({ entries: 2, bytes: 102 + 12 });
    expect(await cache.statsBySite()).toEqual({
      a: { entries: 1, bytes: 102 },
      b: { entries: 1, bytes: 12 },
    });
    await cache.clearAll();
    expect(await cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("recovers from a corrupt index by starting empty", async () => {
    await cache.set("read", "a:1", "A", { ttlMs: 60_000, sites: ["a"] });
    await writeFile(join(tmp.dir, "cache", "index.json"), "{not json");
    const reopened = new FileCache(join(tmp.dir, "cache"), { clock });
    expect(await reopened.get("read", "a:1")).toBeUndefined();
    await reopened.set("read", "a:2", "B", { ttlMs: 60_000, sites: ["a"] });
    expect(await reopened.get("read", "a:2")).toBe("B");
  });
});

describe("ResultCache rules", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let clock: FakeClock;
  let rc: ResultCache;
  beforeEach(async () => {
    tmp = await makeTempDir();
    clock = new FakeClock();
    rc = new ResultCache(new FileCache(join(tmp.dir, "cache"), { clock }), {
      searchTtlMs: 600_000,
      readTtlMs: 86_400_000,
      pageChainTtlMs: 1_800_000,
    });
  });
  afterEach(async () => tmp.cleanup());

  it("caches documents only when the read is ok, for 24 hours", async () => {
    const key = readCacheKey("a", { localId: "42" });
    expect(await rc.putDocument(key, "a", "auth_required", { text: "teaser" })).toBe(false);
    expect(await rc.getDocument(key)).toBeUndefined();
    expect(await rc.putDocument(key, "a", "ok", { text: "full" })).toBe(true);
    expect(await rc.getDocument(key)).toEqual({ text: "full" });
    clock.ms += 86_400_000;
    expect(await rc.getDocument(key)).toBeUndefined();
  });

  it("caches a search page only when every searched site returned ok or empty, for 10 minutes", async () => {
    expect(
      isCacheableSearch([
        { site: "a", status: "ok" },
        { site: "b", status: "empty" },
      ]),
    ).toBe(true);
    expect(
      isCacheableSearch([
        { site: "a", status: "ok" },
        { site: "b", status: "timeout" },
      ]),
    ).toBe(false);
    const key = searchCacheKey({
      text: "Oil  Prices",
      sites: ["b", "a"],
      after: null,
      before: null,
      limit: 10,
      cursor: null,
    });
    expect(key).toBe(
      searchCacheKey({
        text: "oil prices",
        sites: ["a", "b"],
        after: null,
        before: null,
        limit: 10,
        cursor: null,
      }),
    );
    expect(await rc.putSearchPage(key, { results: [] }, [{ site: "a", status: "auth_required" }])).toBe(
      false,
    );
    // A needs_login site's status entry (not searched) does not block caching.
    expect(await rc.putSearchPage(key, { results: [1] }, [{ site: "a", status: "ok" }], ["c"])).toBe(true);
    expect(await rc.getSearchPage(key)).toEqual({ results: [1] });
    await rc.clearSite("c");
    expect(await rc.getSearchPage(key)).toBeUndefined();
    await rc.putSearchPage(key, { results: [2] }, [{ site: "a", status: "ok" }]);
    clock.ms += 600_000;
    expect(await rc.getSearchPage(key)).toBeUndefined();
  });

  it("keeps the page chain for 30 minutes", async () => {
    await rc.putPageChain("oil", 2, "cursor-2", ["a"]);
    expect(await rc.getPageChain("oil", 2)).toBe("cursor-2");
    clock.ms += 1_800_000;
    expect(await rc.getPageChain("oil", 2)).toBeUndefined();
  });
});
