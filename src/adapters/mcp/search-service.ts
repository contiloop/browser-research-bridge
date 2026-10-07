/**
 * Search behavior shared by `search` and `search_sites`:
 *
 * - targets: the `site:` set, else every `active` site; every registered (or named) site gets a
 *   `siteStatuses` entry, non-searched ones through the lifecycle → outcome mapping;
 * - each target's adapter runs concurrently through the scheduler within the tool-call budget;
 * - results are merged/deduplicated/ordered and cut to `limit` by the core merge, which also records
 *   each site's `(adapterCursor, offset)` for the next page;
 * - pagination: `nextCursor` for `search_sites`; `nextPage` plus the server-side page chain
 *   `(normalized query, page) → cursor` for `search`'s `page:N` (walked sequentially when missing);
 * - caching of whole pages when every searched site returned `ok`/`empty`;
 * - every live outcome is fed back into the site lifecycle (incl. `blocked` → cool-down).
 *
 * `search()` never throws: a failing site contributes zero results and its status entry.
 */
import { toSearchResult } from "../../core/assemble.js";
import { decodeCursor, encodeCursor } from "../../core/cursor.js";
import type { SearchCursor, SiteCursorState } from "../../core/cursor.js";
import type { QueryLimits } from "../../core/defaults.js";
import {
  DATE_POST_FILTER_NOTE,
  initialSiteStates,
  mergeSearchPage,
  nextCursorFrom,
  nextPageNumber,
  postFilterWindow,
} from "../../core/merge.js";
import type { MergeOutcome, SiteBatch } from "../../core/merge.js";
import type { DateWindow, Outcome, SearchRequest, SearchResult, SiteStatusEntry } from "../../core/models.js";
import { NO_SEARCH_TERMS_MESSAGE, buildSearchRequest } from "../../core/query.js";
import type { StructuredSearchFields } from "../../core/query.js";
import { lifecycleToOutcome, planSearchTargets } from "../../core/targets.js";
import { truncateText } from "../../core/text.js";
import { systemClock } from "../../ports/clock.js";
import type { RegisteredSite } from "../../ports/registry.js";
import { searchCacheKey } from "../storage/result-cache.js";
import { adapterOutcome, normalizeSearchResponse } from "./adapter-output.js";
import { DEFAULT_TOOL_TUNABLES, errorMessage } from "./deps.js";
import type { ToolServiceDeps, ToolTunables } from "./deps.js";
import { callSiteAdapter, finishOutcome, recordLiveOutcome } from "./live-call.js";
import type { LiveCallContext } from "./live-call.js";

export type SearchMode = "search" | "search_sites";

export interface SearchInput {
  query: string;
  /** `search` reads `page:N` (page chain); `search_sites` reads the structured fields and `cursor`. */
  mode: SearchMode;
  fields?: StructuredSearchFields | undefined;
  signal?: AbortSignal | undefined;
}

export interface SearchOutput {
  results: SearchResult[];
  /** Typed pagination token (`search_sites`). */
  nextCursor: string | null;
  /** ChatGPT pagination (`search`): `page + 1` or null. */
  nextPage: number | null;
  siteStatuses: SiteStatusEntry[];
  /** The page this response is. */
  page: number;
  /** Structured fields that were invalid and ignored (`search_sites`). */
  ignoredFields: string[];
  /** Served from the search page cache. */
  cached: boolean;
}

/** Search excerpts are snippets; a longer one is cut so a page stays small. */
export const EXCERPT_MAX_CHARS = 1000;
export const NO_MORE_RESULTS_MESSAGE = "no more results for this query";

/** One computed (or cached) search page. */
interface PageRun {
  results: SearchResult[];
  nextCursor: string | null;
  nextPage: number | null;
  /** Status entries of the sites searched on this page. */
  entries: SiteStatusEntry[];
  /** Sites searched on this page, alphabetical. */
  searched: string[];
}

interface PageStart {
  page: number;
  cursor: SearchCursor | null;
  /** The cursor token this page was requested with (cache key); null for page 1. */
  token: string | null;
}

/** Everything one tool call shares across the pages it computes. */
interface CallContext {
  request: SearchRequest;
  targets: ReadonlySet<string>;
  views: ReadonlyMap<string, RegisteredSite>;
  /** Registered sites that are not searched (their entries come from the lifecycle mapping). */
  nonSearched: readonly string[];
  /** Normalized query identity for the page chain (query + sites + window + limit). */
  chainQuery: string;
  deadline: number;
  signal: AbortSignal | undefined;
}

interface SiteCall {
  batch: SiteBatch;
  entry: SiteStatusEntry;
}

function bySite(a: SiteStatusEntry, b: SiteStatusEntry): number {
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((k) => set.has(k));
}

function entryOf(site: string, outcome: Outcome): SiteStatusEntry {
  const entry: SiteStatusEntry = { site, status: outcome.status };
  if (outcome.message !== undefined) entry.message = outcome.message;
  if (outcome.action !== undefined) entry.action = outcome.action;
  return entry;
}

function capExcerpt(result: SearchResult): SearchResult {
  if (result.excerpt === null || result.excerpt.length <= EXCERPT_MAX_CHARS) return result;
  const { text } = truncateText(result.excerpt, EXCERPT_MAX_CHARS);
  return { ...result, excerpt: `${text}…` };
}

/**
 * An adapter page that said `ok` but contributed nothing and has nothing left (everything was outside
 * the date window or already returned) is reported as `empty`. A site that still has more pages stays
 * `ok` even with zero results on this page (e.g. a page the date post-filter emptied), so `ok` means
 * "worked; continue with the cursor", not "results came".
 */
function settleEntry(entry: SiteStatusEntry, merge: MergeOutcome): SiteStatusEntry {
  if (entry.status !== "ok") return entry;
  const stats = merge.stats[entry.site];
  if (stats === undefined || stats.emitted > 0 || entry.site in merge.sites) return entry;
  const message =
    stats.filteredByDate > 0
      ? "no results in the date window"
      : stats.duplicates > 0
        ? "no new results (all were returned on earlier pages)"
        : "no results";
  return { ...entry, status: "empty", message };
}

export class SearchService {
  private readonly tunables: ToolTunables;
  private readonly limits: QueryLimits;
  private readonly live: LiveCallContext;

  constructor(private readonly deps: ToolServiceDeps) {
    this.tunables = { ...DEFAULT_TOOL_TUNABLES, ...deps.tunables };
    this.limits = {
      limitDefault: this.tunables.searchDefaultLimit,
      limitMin: 1,
      limitMax: this.tunables.searchMaxLimit,
      pageDefault: 1,
      pageMin: 1,
      pageMax: this.tunables.searchMaxPage,
    };
    this.live = {
      registry: deps.registry,
      runSiteTask: deps.runSiteTask,
      logger: deps.logger,
      clock: deps.clock ?? systemClock,
    };
  }

  /** Never throws. */
  async search(input: SearchInput): Promise<SearchOutput> {
    const deadline = this.live.clock.now().getTime() + this.tunables.toolCallBudgetMs;
    try {
      return await this.run(input, deadline);
    } catch (error) {
      this.deps.logger.error("search failed unexpectedly", { tool: input.mode, error: errorMessage(error) });
      return this.fallback(input, error);
    }
  }

  private async run(input: SearchInput, deadline: number): Promise<SearchOutput> {
    const built = buildSearchRequest(
      input.query,
      input.mode === "search_sites" ? (input.fields ?? {}) : {},
      this.limits,
    );
    const { request } = built;
    const sites = this.deps.registry.list();
    const plan = planSearchTargets(sites, request.sites);
    const unknown = new Set(plan.unknown);
    const lifecycleEntries = plan.statuses.filter((s) => !unknown.has(s.site));
    const unknownEntries = plan.statuses.filter((s) => unknown.has(s.site));
    const assemble = (entries: readonly SiteStatusEntry[]): SiteStatusEntry[] => [
      ...[...lifecycleEntries, ...entries].sort(bySite),
      ...unknownEntries,
    ];
    const respond = (
      page: number,
      entries: readonly SiteStatusEntry[],
      run?: PageRun & { cached: boolean },
    ): SearchOutput => ({
      results: run?.results ?? [],
      nextCursor: run?.nextCursor ?? null,
      nextPage: input.mode === "search" ? (run?.nextPage ?? null) : null,
      siteStatuses: assemble(entries),
      page,
      ignoredFields: [...built.ignoredFields],
      cached: run?.cached ?? false,
    });

    const targets = plan.targets;
    if (!built.hasTerms) {
      const page = input.mode === "search" ? built.page : 1;
      return respond(
        page,
        targets.map((site) => ({ site, status: "empty", message: NO_SEARCH_TERMS_MESSAGE })),
      );
    }

    const ctx: CallContext = {
      request,
      targets: new Set(targets),
      views: new Map(sites.map((s) => [s.key, s])),
      nonSearched: lifecycleEntries.map((e) => e.site),
      chainQuery: searchCacheKey({ ...request, cursor: null }),
      deadline,
      signal: input.signal,
    };

    let start: PageStart;
    if (input.mode === "search_sites") {
      if (request.cursor === null) {
        start = { page: 1, cursor: null, token: null };
      } else {
        const decoded = decodeCursor(request.cursor, { isKnownSite: (k) => ctx.views.has(k) });
        if (!decoded.ok) {
          return respond(
            1,
            targets.map((site) => ({
              site,
              status: "unsupported",
              message: `invalid cursor: ${decoded.error}`,
            })),
          );
        }
        start = { page: decoded.cursor.page, cursor: decoded.cursor, token: request.cursor };
      }
    } else if (built.page <= 1) {
      start = { page: 1, cursor: null, token: null };
    } else {
      const walked = await this.cursorForPage(ctx, built.page);
      if (walked.kind === "end") return respond(built.page, walked.entries);
      start = walked.start;
    }

    const run = await this.runPage(ctx, start);
    const exhausted = targets
      .filter((t) => !run.searched.includes(t))
      .map((site): SiteStatusEntry => ({ site, status: "empty", message: NO_MORE_RESULTS_MESSAGE }));
    return respond(start.page, [...run.entries, ...exhausted], run);
  }

  /**
   * The cursor for `page:N` (N ≥ 2): the page chain entry when present, else the nearest lower chain
   * entry (or page 1) walked forward page by page, recording chain entries on the way.
   */
  private async cursorForPage(
    ctx: CallContext,
    page: number,
  ): Promise<{ kind: "start"; start: PageStart } | { kind: "end"; entries: SiteStatusEntry[] }> {
    const isKnownSite = (k: string): boolean => ctx.views.has(k);
    let current: PageStart = { page: 1, cursor: null, token: null };
    for (let p = page; p >= 2; p--) {
      const token = await this.cacheCall(() => this.deps.cache?.getPageChain(ctx.chainQuery, p));
      if (token === undefined) continue;
      const decoded = decodeCursor(token, { isKnownSite });
      if (decoded.ok) {
        current = { page: p, cursor: decoded.cursor, token };
        break;
      }
    }
    while (current.page < page) {
      const run = await this.runPage(ctx, current);
      const decoded = run.nextCursor === null ? null : decodeCursor(run.nextCursor, { isKnownSite });
      if (decoded === null || !decoded.ok || run.nextCursor === null) {
        const entries = run.entries.map((e): SiteStatusEntry =>
          e.status === "ok" || e.status === "empty"
            ? { site: e.site, status: "empty", message: NO_MORE_RESULTS_MESSAGE }
            : e,
        );
        for (const t of ctx.targets) {
          if (!run.searched.includes(t))
            entries.push({ site: t, status: "empty", message: NO_MORE_RESULTS_MESSAGE });
        }
        return { kind: "end", entries };
      }
      current = { page: current.page + 1, cursor: decoded.cursor, token: run.nextCursor };
    }
    return { kind: "start", start: current };
  }

  /** Computes one page (or serves it from the cache) and records the chain entry for the next page. */
  private async runPage(ctx: CallContext, start: PageStart): Promise<PageRun & { cached: boolean }> {
    const { request } = ctx;
    const states: Record<string, SiteCursorState> =
      start.cursor === null
        ? initialSiteStates([...ctx.targets])
        : Object.fromEntries(Object.entries(start.cursor.sites).filter(([k]) => ctx.targets.has(k)));
    const searched = Object.keys(states).sort();
    const pageKey = searchCacheKey({ ...request, cursor: start.token });

    const hit = await this.cacheCall(() => this.deps.cache?.getSearchPage<PageRun>(pageKey));
    if (hit !== undefined && sameKeys(hit.searched, searched)) {
      if (hit.nextCursor !== null) await this.putChain(ctx, start.page + 1, hit.nextCursor, searched);
      return { ...hit, cached: true };
    }

    const calls = await Promise.all(
      searched.map((key) => this.searchSite(ctx, key, states[key] ?? { adapterCursor: null, offset: 0 })),
    );
    const merge = mergeSearchPage(
      calls.map((c) => c.batch),
      { limit: request.limit, seen: start.cursor?.seen ?? [] },
    );
    const next = nextCursorFrom(start.page, merge);
    const run: PageRun = {
      results: merge.results,
      nextCursor: next === null ? null : encodeCursor(next),
      nextPage: nextPageNumber(start.page, merge.hasMore, this.tunables.searchMaxPage),
      entries: calls.map((c) => settleEntry(c.entry, merge)),
      searched,
    };

    if (searched.length > 0) {
      await this.cacheCall(() =>
        this.deps.cache?.putSearchPage(
          pageKey,
          run,
          run.entries.map((e) => ({ site: e.site, status: e.status })),
          ctx.nonSearched,
        ),
      );
    }
    if (run.nextCursor !== null) await this.putChain(ctx, start.page + 1, run.nextCursor, searched);
    return { ...run, cached: false };
  }

  /** One site's adapter page for this search page; never throws. */
  private async searchSite(ctx: CallContext, key: string, state: SiteCursorState): Promise<SiteCall> {
    const { request } = ctx;
    const loginUrl = ctx.views.get(key)?.loginUrl ?? null;
    const window: DateWindow = { after: request.after, before: request.before };
    const call = await callSiteAdapter(
      this.live,
      key,
      { holder: "search", deadline: ctx.deadline, signal: ctx.signal },
      async (loaded, actx) => {
        const native = loaded.manifest.capabilities.dateFilter;
        const raw = await loaded.adapter.search(
          {
            text: request.text,
            after: native ? request.after : null,
            before: native ? request.before : null,
            limit: request.limit,
            cursor: state.adapterCursor,
          },
          actx,
        );
        const response = normalizeSearchResponse(raw);
        const adapter = loaded.adapter;
        const canonicalize = adapter.canonicalize ? (url: string) => adapter.canonicalize!(url) : undefined;
        const results = response.items.map((item) => capExcerpt(toSearchResult(key, item, canonicalize)));
        return {
          response,
          results,
          canonicalize,
          window: postFilterWindow(window, loaded.manifest.capabilities),
        };
      },
    );

    let outcome: Outcome;
    let batch: SiteBatch;
    let blocked = false;
    if (call.ok) {
      const { response, results, canonicalize } = call.value;
      outcome = finishOutcome(adapterOutcome(response), key, loginUrl);
      blocked = response.blocked;
      batch = {
        site: key,
        state,
        status: outcome.status,
        results,
        nextCursor: response.nextCursor,
        canonicalize,
        dateWindow: call.value.window,
      };
    } else {
      outcome = finishOutcome(call.outcome, key, loginUrl);
      batch = { site: key, state, status: outcome.status, results: [], nextCursor: null };
    }
    await recordLiveOutcome(this.live, key, outcome, blocked);
    if (outcome.status !== "ok") {
      this.deps.logger.info("site search outcome", {
        site: key,
        status: outcome.status,
        blocked,
        message: outcome.message?.slice(0, 200) ?? null,
      });
    }

    const entry = entryOf(key, outcome);
    if (batch.dateWindow && (outcome.status === "ok" || outcome.status === "empty")) {
      entry.note = DATE_POST_FILTER_NOTE;
    }
    return { batch, entry };
  }

  private async putChain(
    ctx: CallContext,
    page: number,
    cursor: string,
    sites: readonly string[],
  ): Promise<void> {
    if (page > this.tunables.searchMaxPage) return;
    await this.cacheCall(() => this.deps.cache?.putPageChain(ctx.chainQuery, page, cursor, sites));
  }

  /** Cache failures are logged and treated as misses; they never fail a tool call. */
  private async cacheCall<T>(fn: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.deps.logger.warn("search cache operation failed", { error: errorMessage(error) });
      return undefined;
    }
  }

  /** Last-resort response for an unexpected internal failure: statuses only, no results. */
  private fallback(input: SearchInput, error: unknown): SearchOutput {
    let siteStatuses: SiteStatusEntry[];
    try {
      const built = buildSearchRequest(
        input.query,
        input.mode === "search_sites" ? (input.fields ?? {}) : {},
      );
      const sites = this.deps.registry.list();
      const plan = planSearchTargets(sites, built.request.sites);
      const failed = plan.targets.map((site): SiteStatusEntry => ({
        site,
        status: "adapter_error",
        message: `internal error: ${errorMessage(error)}`,
      }));
      siteStatuses = [...plan.statuses, ...failed];
      siteStatuses.sort(bySite);
    } catch {
      try {
        siteStatuses = this.deps.registry
          .list()
          .map(
            (s) =>
              lifecycleToOutcome(s) ?? { site: s.key, status: "adapter_error", message: "internal error" },
          );
      } catch {
        siteStatuses = [];
      }
    }
    return {
      results: [],
      nextCursor: null,
      nextPage: null,
      siteStatuses,
      page: 1,
      ignoredFields: [],
      cached: false,
    };
  }
}
