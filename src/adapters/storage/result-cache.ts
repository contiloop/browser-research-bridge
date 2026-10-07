/**
 * Caching rules on top of the {@link Cache} port:
 *
 * - Search pages: 10 minutes (tunable), keyed by normalized query + sites + date window + limit +
 *   cursor; cached only when every **searched** site returned `ok` or `empty` (status entries of
 *   non-active sites do not block caching).
 * - Documents: 24 hours (tunable), only when the read status is `ok`.
 * - Page chain `(normalized query, page) → cursor`: 30 minutes (tunable).
 *
 * Every entry is tagged with the sites it involves, so `clearSite` removes them.
 */
import type { OutcomeStatus } from "../../core/models.js";
import type { Cache, CacheStats } from "../../ports/cache.js";

export interface ResultCacheTtls {
  searchTtlMs: number;
  readTtlMs: number;
  pageChainTtlMs: number;
}

export const DEFAULT_RESULT_CACHE_TTLS: Readonly<ResultCacheTtls> = Object.freeze({
  searchTtlMs: 600_000,
  readTtlMs: 86_400_000,
  pageChainTtlMs: 1_800_000,
});

/** TTLs from the config tunables (`searchCacheTtlSeconds`, `readCacheTtlSeconds`, `pageChainTtlSeconds`). */
export function ttlsFromTunables(t: {
  searchCacheTtlSeconds: number;
  readCacheTtlSeconds: number;
  pageChainTtlSeconds: number;
}): ResultCacheTtls {
  return {
    searchTtlMs: t.searchCacheTtlSeconds * 1000,
    readTtlMs: t.readCacheTtlSeconds * 1000,
    pageChainTtlMs: t.pageChainTtlSeconds * 1000,
  };
}

export interface SearchCacheKeyInput {
  text: string;
  /** Requested or resolved site keys; order-insensitive. Null = all active sites. */
  sites: readonly string[] | null;
  after: string | null;
  before: string | null;
  limit: number;
  cursor: string | null;
}

/** Normalized search text: trimmed, whitespace collapsed, lowercased. */
export function normalizeQueryText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function searchCacheKey(input: SearchCacheKeyInput): string {
  return JSON.stringify([
    normalizeQueryText(input.text),
    input.sites === null ? null : [...new Set(input.sites)].sort(),
    input.after,
    input.before,
    input.limit,
    input.cursor,
  ]);
}

/** Read cache key: the site plus the adapter ref (native local id, else the URL). */
export function readCacheKey(
  site: string,
  ref: { localId?: string | undefined; url?: string | undefined },
): string {
  return ref.localId !== undefined ? `${site}:id:${ref.localId}` : `${site}:url:${ref.url ?? ""}`;
}

export function pageChainKey(normalizedQuery: string, page: number): string {
  return JSON.stringify([normalizedQuery, page]);
}

export interface SearchedSiteOutcome {
  site: string;
  status: OutcomeStatus;
}

/** A search page is cacheable only when every searched site returned `ok` or `empty`. */
export function isCacheableSearch(searched: readonly SearchedSiteOutcome[]): boolean {
  return searched.every((s) => s.status === "ok" || s.status === "empty");
}

/** A document is cacheable only with status `ok`. */
export function isCacheableRead(status: OutcomeStatus): boolean {
  return status === "ok";
}

export class ResultCache {
  readonly ttls: ResultCacheTtls;

  constructor(
    readonly cache: Cache,
    ttls: Partial<ResultCacheTtls> = {},
  ) {
    this.ttls = { ...DEFAULT_RESULT_CACHE_TTLS, ...ttls };
  }

  getSearchPage<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>("search", key);
  }

  /**
   * Stores the page when cacheable; returns whether it was stored. `extraSites` are other sites the
   * page mentions (status entries), added to the tags so clearing them also drops the page.
   */
  async putSearchPage<T>(
    key: string,
    page: T,
    searched: readonly SearchedSiteOutcome[],
    extraSites: readonly string[] = [],
  ): Promise<boolean> {
    if (!isCacheableSearch(searched)) return false;
    const sites = [...searched.map((s) => s.site), ...extraSites];
    await this.cache.set("search", key, page, { ttlMs: this.ttls.searchTtlMs, sites });
    return true;
  }

  getDocument<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>("read", key);
  }

  /** Stores the document only when `status` is `ok`; returns whether it was stored. */
  async putDocument<T>(key: string, site: string, status: OutcomeStatus, document: T): Promise<boolean> {
    if (!isCacheableRead(status)) return false;
    await this.cache.set("read", key, document, { ttlMs: this.ttls.readTtlMs, sites: [site] });
    return true;
  }

  getPageChain(normalizedQuery: string, page: number): Promise<string | undefined> {
    return this.cache.get<string>("page-chain", pageChainKey(normalizedQuery, page));
  }

  async putPageChain(
    normalizedQuery: string,
    page: number,
    cursor: string,
    sites: readonly string[],
  ): Promise<void> {
    await this.cache.set("page-chain", pageChainKey(normalizedQuery, page), cursor, {
      ttlMs: this.ttls.pageChainTtlMs,
      sites,
    });
  }

  clearSite(site: string): Promise<void> {
    return this.cache.clearSite(site);
  }

  clearAll(): Promise<void> {
    return this.cache.clearAll();
  }

  stats(): Promise<CacheStats> {
    return this.cache.stats();
  }
}
