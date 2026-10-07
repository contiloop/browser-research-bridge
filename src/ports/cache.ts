/**
 * Local cache port (search pages, documents, and the page chain behind search cursors). Lives under
 * `data/`.
 * Entries are tagged with the sites they involve so one site's entries can be cleared.
 */

export type CacheNamespace = "search" | "read" | "page-chain";

export interface CacheSetOptions {
  ttlMs: number;
  /** Sites this entry depends on; `clearSite` removes every entry tagged with the site. */
  sites: readonly string[];
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

export interface Cache {
  /** The stored value, or undefined when absent or expired. Values are JSON round-tripped. */
  get<T>(namespace: CacheNamespace, key: string): Promise<T | undefined>;
  set<T>(namespace: CacheNamespace, key: string, value: T, options: CacheSetOptions): Promise<void>;
  delete(namespace: CacheNamespace, key: string): Promise<void>;
  clearSite(site: string): Promise<void>;
  clearAll(): Promise<void>;
  stats(): Promise<CacheStats>;
}
