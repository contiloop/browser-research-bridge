import { describe, expect, it } from "vitest";
import { initialSiteStates, mergeSearchPage, nextCursorFrom, nextPageNumber } from "./merge.js";
import type { SiteBatch } from "./merge.js";
import type { SearchResult } from "./models.js";
import { hashUrlKey, normalizeUrl } from "./url.js";

function r(site: string, n: string, publishedAt: string | null, url?: string): SearchResult {
  return {
    id: `${site}:${n}`,
    site,
    title: `${site} ${n}`,
    url: url ?? `https://${site}.example/${n}`,
    publishedAt,
    datePrecision: publishedAt === null ? null : "minute",
    excerpt: null,
    author: null,
  };
}

function batch(site: string, results: SearchResult[], extra: Partial<SiteBatch> = {}): SiteBatch {
  return {
    site,
    state: { adapterCursor: null, offset: 0 },
    status: results.length > 0 ? "ok" : "empty",
    results,
    nextCursor: null,
    ...extra,
  };
}

describe("mergeSearchPage ordering", () => {
  it("orders by publishedAt desc, undated last, ties by alphabetical site key", () => {
    const out = mergeSearchPage(
      [
        batch("bsite", [r("bsite", "1", "2024-05-03T10:00:00Z"), r("bsite", "2", "2024-05-02T10:00:00Z")]),
        batch("asite", [r("asite", "1", "2024-05-02T10:00:00Z"), r("asite", "2", null)]),
      ],
      { limit: 10 },
    );
    expect(out.results.map((x) => x.id)).toEqual(["bsite:1", "asite:1", "bsite:2", "asite:2"]);
  });

  it("compares instants across UTC offsets", () => {
    const out = mergeSearchPage(
      [
        batch("aa", [r("aa", "1", "2024-05-01T23:00:00Z")]),
        batch("bb", [r("bb", "1", "2024-05-02T09:30:00+09:00")]),
      ],
      { limit: 10 },
    );
    expect(out.results.map((x) => x.id)).toEqual(["bb:1", "aa:1"]);
  });

  it("keeps undated results after all dated ones even across sites", () => {
    const out = mergeSearchPage(
      [batch("aa", [r("aa", "1", null)]), batch("zz", [r("zz", "1", "2020-01-01T00:00:00Z")])],
      { limit: 10 },
    );
    expect(out.results.map((x) => x.id)).toEqual(["zz:1", "aa:1"]);
  });
});

describe("mergeSearchPage per-site consumption", () => {
  const aPage = [1, 2, 3, 4, 5].map((i) =>
    r("aa", String(i), `2024-05-${String(20 - i * 2).padStart(2, "0")}T00:00:00Z`),
  );
  const bPage = [1, 2, 3, 4, 5].map((i) =>
    r("bb", String(i), `2024-05-${String(19 - i * 2).padStart(2, "0")}T00:00:00Z`),
  );

  it("cuts to limit and records (adapterCursor, offset) so the next page resumes without loss", () => {
    const states = initialSiteStates(["aa", "bb"]);
    const page1 = mergeSearchPage(
      [
        batch("aa", aPage, { state: states["aa"]!, nextCursor: "a2" }),
        batch("bb", bPage, { state: states["bb"]!, nextCursor: null }),
      ],
      { limit: 3 },
    );
    expect(page1.results.map((x) => x.id)).toEqual(["aa:1", "bb:1", "aa:2"]);
    expect(page1.sites).toEqual({
      aa: { adapterCursor: null, offset: 2 },
      bb: { adapterCursor: null, offset: 1 },
    });
    expect(page1.hasMore).toBe(true);

    const cursor = nextCursorFrom(1, page1);
    expect(cursor?.page).toBe(2);

    // Page 2: the core re-runs each site's current adapter page (same adapterCursor) and resumes at offset.
    const page2 = mergeSearchPage(
      [
        batch("aa", aPage, { state: cursor!.sites["aa"]!, nextCursor: "a2" }),
        batch("bb", bPage, { state: cursor!.sites["bb"]!, nextCursor: null }),
      ],
      { limit: 3, seen: cursor!.seen },
    );
    expect(page2.results.map((x) => x.id)).toEqual(["bb:2", "aa:3", "bb:3"]);
    const all = [...page1.results, ...page2.results].map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("advances to the adapter's next cursor when the current page is fully emitted", () => {
    const out = mergeSearchPage([batch("aa", aPage.slice(0, 2), { nextCursor: "a2" })], { limit: 5 });
    expect(out.sites).toEqual({ aa: { adapterCursor: "a2", offset: 0 } });
    expect(out.hasMore).toBe(true);
  });

  it("drops a site whose results are exhausted and reports no more pages", () => {
    const out = mergeSearchPage([batch("aa", aPage.slice(0, 2)), batch("bb", [])], { limit: 5 });
    expect(out.sites).toEqual({});
    expect(out.hasMore).toBe(false);
    expect(nextCursorFrom(1, out)).toBeNull();
  });

  it("retains a failed site's state for retry but a failed site alone does not keep the chain alive", () => {
    const failed: SiteBatch = {
      site: "bb",
      state: { adapterCursor: "b7", offset: 2 },
      status: "timeout",
      results: [],
      nextCursor: null,
    };
    const out = mergeSearchPage([batch("aa", aPage.slice(0, 1)), failed], { limit: 5 });
    expect(out.results.map((x) => x.id)).toEqual(["aa:1"]);
    expect(out.sites).toEqual({ bb: { adapterCursor: "b7", offset: 2 } });
    expect(out.hasMore).toBe(false);

    const withMore = mergeSearchPage([batch("aa", aPage, { nextCursor: "a2" }), failed], { limit: 2 });
    expect(withMore.sites["bb"]).toEqual({ adapterCursor: "b7", offset: 2 });
    expect(withMore.hasMore).toBe(true);
  });

  it("ignores results returned with a non-ok status", () => {
    const out = mergeSearchPage([{ ...batch("aa", aPage), status: "auth_required" }], { limit: 5 });
    expect(out.results).toEqual([]);
  });

  it("restarts from the next adapter page when the resumed offset is past the end", () => {
    const out = mergeSearchPage(
      [batch("aa", aPage.slice(0, 2), { state: { adapterCursor: "a1", offset: 9 }, nextCursor: "a2" })],
      { limit: 5 },
    );
    expect(out.results).toEqual([]);
    expect(out.sites).toEqual({ aa: { adapterCursor: "a2", offset: 0 } });
  });
});

describe("mergeSearchPage dedup", () => {
  it("dedups by normalized URL within a page (www., utm, trailing slash, fragment)", () => {
    const out = mergeSearchPage(
      [
        batch("aa", [
          r("aa", "1", "2024-05-03T00:00:00Z", "https://www.e.com/story/?utm_source=x"),
          r("aa", "2", "2024-05-02T00:00:00Z", "https://e.com/story#top"),
          r("aa", "3", "2024-05-01T00:00:00Z", "https://e.com/other"),
        ]),
      ],
      { limit: 10 },
    );
    expect(out.results.map((x) => x.id)).toEqual(["aa:1", "aa:3"]);
    expect(out.stats["aa"]).toMatchObject({ emitted: 2, duplicates: 1 });
  });

  it("suppresses URLs already returned on earlier pages via the seen hashes", () => {
    const seen = [hashUrlKey(normalizeUrl("https://e.com/story"))];
    const out = mergeSearchPage(
      [batch("aa", [r("aa", "1", null, "https://e.com/story/"), r("aa", "2", null, "https://e.com/new")])],
      { limit: 10, seen },
    );
    expect(out.results.map((x) => x.id)).toEqual(["aa:2"]);
    expect(out.seen).toEqual([...seen, hashUrlKey(normalizeUrl("https://e.com/new"))]);
  });

  it("uses the site canonicalizer before normalization", () => {
    const canonicalize = (u: string): string => u.replace("://m.", "://");
    const out = mergeSearchPage(
      [
        batch(
          "aa",
          [r("aa", "1", null, "https://m.blog.e.com/p/1"), r("aa", "2", null, "https://blog.e.com/p/1")],
          { canonicalize },
        ),
      ],
      { limit: 10 },
    );
    expect(out.results).toHaveLength(1);
  });

  it("bounds the seen list", () => {
    const results = Array.from({ length: 6 }, (_, i) => r("aa", String(i), null));
    const out = mergeSearchPage([batch("aa", results)], { limit: 6, seen: ["x1", "x2"], seenLimit: 4 });
    expect(out.seen).toHaveLength(4);
    expect(out.seen).not.toContain("x1");
  });
});

describe("mergeSearchPage date post-filter", () => {
  it("drops results outside the inclusive window and undated ones, consuming them", () => {
    const window = { after: "2024-05-02", before: "2024-05-03" };
    const out = mergeSearchPage(
      [
        batch(
          "aa",
          [
            r("aa", "1", "2024-05-04T00:00:00+09:00"),
            r("aa", "2", "2024-05-03T23:59:00+09:00"),
            r("aa", "3", "2024-05-02T00:00:00Z"),
            r("aa", "4", "2024-05-01T23:00:00Z"),
            r("aa", "5", null),
          ],
          { dateWindow: window },
        ),
      ],
      { limit: 10 },
    );
    expect(out.results.map((x) => x.id)).toEqual(["aa:2", "aa:3"]);
    expect(out.stats["aa"]).toMatchObject({ emitted: 2, filteredByDate: 3 });
    expect(out.sites).toEqual({});
  });

  it("does not filter when the batch has no window (native date filtering)", () => {
    const out = mergeSearchPage([batch("aa", [r("aa", "1", "2000-01-01T00:00:00Z")])], { limit: 10 });
    expect(out.results).toHaveLength(1);
  });
});

describe("nextPageNumber", () => {
  it("is page+1 while more results exist and the page cap is not reached", () => {
    expect(nextPageNumber(1, true)).toBe(2);
    expect(nextPageNumber(1, false)).toBeNull();
    expect(nextPageNumber(10, true)).toBeNull();
    expect(nextPageNumber(10, true, 12)).toBe(11);
  });
});
