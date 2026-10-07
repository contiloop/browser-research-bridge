/**
 * Cross-site merge for one search page: date post-filter, dedup by
 * normalized URL (incl. hashes seen on earlier pages), ordering, cut to `limit`, and per-site
 * `(adapterCursor, offset)` bookkeeping so unemitted results carry over to the next page.
 *
 * Selection is a k-way merge over each site's adapter page in adapter order, so every site
 * consumes a prefix of its page and the resume point is a single offset. The emitted page is then
 * sorted by publishedAt desc, undated last, ties by alphabetical site key.
 */
import { DEFAULT_QUERY_LIMITS, DEFAULT_SEEN_HASH_LIMIT } from "./defaults.js";
import type { SearchCursor, SiteCursorState } from "./cursor.js";
import type { DateWindow, OutcomeStatus, SearchResult, SiteCapabilities } from "./models.js";
import { hashUrlKey, normalizeUrl } from "./url.js";
import type { NormalizeUrlOptions } from "./url.js";

export const DATE_POST_FILTER_NOTE = "date filter applied after retrieval";

/** One site's adapter page for this search page. */
export interface SiteBatch {
  site: string;
  /** The state this adapter page was fetched with (`adapterCursor`) and where to resume (`offset`). */
  state: SiteCursorState;
  status: OutcomeStatus;
  results: readonly SearchResult[];
  /** The adapter's cursor for its next page, null when this is its last page. */
  nextCursor: string | null;
  canonicalize?: ((url: string) => string) | undefined;
  /** Window to post-filter on; null/absent when the adapter filtered natively or no filter was asked. */
  dateWindow?: DateWindow | null | undefined;
}

export interface MergeOptions {
  limit: number;
  /** Hashes from the incoming cursor. */
  seen?: readonly string[] | undefined;
  seenLimit?: number | undefined;
  normalize?: Omit<NormalizeUrlOptions, "canonicalize"> | undefined;
}

export interface SiteMergeStats {
  emitted: number;
  duplicates: number;
  filteredByDate: number;
}

export interface MergeOutcome {
  results: SearchResult[];
  /** Next per-site states. Exhausted and `empty` sites are absent; failed sites keep their input state. */
  sites: Record<string, SiteCursorState>;
  seen: string[];
  /** True when at least one successfully searched site has unconsumed results or another adapter page. */
  hasMore: boolean;
  stats: Record<string, SiteMergeStats>;
}

function instantOf(publishedAt: string | null): number | null {
  if (publishedAt === null) return null;
  const t = Date.parse(publishedAt);
  return Number.isNaN(t) ? null : t;
}

function compareSiteKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** publishedAt desc, undated last, ties by alphabetical site key; 0 within one site (keeps adapter order). */
export function compareResults(a: SearchResult, b: SearchResult): number {
  const ta = instantOf(a.publishedAt);
  const tb = instantOf(b.publishedAt);
  if (ta !== null && tb !== null && ta !== tb) return tb - ta;
  if (ta === null && tb !== null) return 1;
  if (ta !== null && tb === null) return -1;
  return compareSiteKeys(a.site, b.site);
}

/** Inclusive window check on the calendar date written in `publishedAt` (the site's own offset). */
export function inDateWindow(publishedAt: string | null, window: DateWindow): boolean {
  if (window.after === null && window.before === null) return true;
  const day = publishedAt === null ? null : /^\d{4}-\d{2}-\d{2}/.exec(publishedAt)?.[0];
  if (day === null || day === undefined) return false;
  if (window.after !== null && day < window.after) return false;
  if (window.before !== null && day > window.before) return false;
  return true;
}

/** The window the core must post-filter with for a site, or null when none applies. */
export function postFilterWindow(
  window: DateWindow,
  capabilities: Pick<SiteCapabilities, "dateFilter">,
): DateWindow | null {
  if (window.after === null && window.before === null) return null;
  return capabilities.dateFilter ? null : window;
}

export function initialSiteStates(sites: readonly string[]): Record<string, SiteCursorState> {
  return Object.fromEntries(sites.map((s) => [s, { adapterCursor: null, offset: 0 }]));
}

interface Stream {
  batch: SiteBatch;
  pos: number;
  head: { item: SearchResult; hash: string } | null;
  stats: SiteMergeStats;
}

export function mergeSearchPage(batches: readonly SiteBatch[], options: MergeOptions): MergeOutcome {
  const seenLimit = options.seenLimit ?? DEFAULT_SEEN_HASH_LIMIT;
  const seenSet = new Set(options.seen ?? []);
  const newHashes: string[] = [];
  const stats: Record<string, SiteMergeStats> = {};
  const sites: Record<string, SiteCursorState> = {};
  const streams: Stream[] = [];

  const ordered = [...batches].sort((a, b) => compareSiteKeys(a.site, b.site));
  for (const batch of ordered) {
    const s: SiteMergeStats = { emitted: 0, duplicates: 0, filteredByDate: 0 };
    stats[batch.site] = s;
    if (batch.status === "ok") {
      streams.push({ batch, pos: batch.state.offset, head: null, stats: s });
    } else if (batch.status !== "empty") {
      sites[batch.site] = { ...batch.state };
    }
  }

  const fillHead = (st: Stream): void => {
    const { batch } = st;
    while (st.head === null && st.pos < batch.results.length) {
      const item = batch.results[st.pos];
      if (item === undefined) break;
      if (batch.dateWindow && !inDateWindow(item.publishedAt, batch.dateWindow)) {
        st.stats.filteredByDate++;
        st.pos++;
        continue;
      }
      const hash = hashUrlKey(
        normalizeUrl(item.url, { ...options.normalize, canonicalize: batch.canonicalize }),
      );
      if (seenSet.has(hash)) {
        st.stats.duplicates++;
        st.pos++;
        continue;
      }
      st.head = { item, hash };
    }
  };

  const emitted: SearchResult[] = [];
  while (emitted.length < options.limit) {
    let best: Stream | null = null;
    for (const st of streams) {
      fillHead(st);
      if (st.head === null) continue;
      if (best === null || (best.head !== null && compareResults(st.head.item, best.head.item) < 0))
        best = st;
    }
    if (best === null || best.head === null) break;
    const { item, hash } = best.head;
    emitted.push(item);
    seenSet.add(hash);
    newHashes.push(hash);
    best.stats.emitted++;
    best.head = null;
    best.pos++;
  }

  let hasMore = false;
  for (const st of streams) {
    fillHead(st);
    const { batch } = st;
    if (st.pos < batch.results.length) {
      sites[batch.site] = { adapterCursor: batch.state.adapterCursor, offset: st.pos };
      hasMore = true;
    } else if (batch.nextCursor !== null) {
      sites[batch.site] = { adapterCursor: batch.nextCursor, offset: 0 };
      hasMore = true;
    }
  }

  return {
    results: emitted.sort(compareResults),
    sites,
    seen: [...(options.seen ?? []), ...newHashes].slice(-seenLimit),
    hasMore,
    stats,
  };
}

/** The cursor for the page after `page`, or null when nothing remains. */
export function nextCursorFrom(page: number, merge: MergeOutcome): SearchCursor | null {
  if (!merge.hasMore) return null;
  return { page: page + 1, sites: merge.sites, seen: merge.seen };
}

/** ChatGPT `nextPage`: `page + 1` while more results exist and the page cap is not reached. */
export function nextPageNumber(
  page: number,
  hasMore: boolean,
  maxPage: number = DEFAULT_QUERY_LIMITS.pageMax,
): number | null {
  return hasMore && page < maxPage ? page + 1 : null;
}
