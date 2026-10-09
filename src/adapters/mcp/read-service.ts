/**
 * Read behavior shared by `fetch` and `read_documents`:
 *
 * - a ref is a result id `<siteKey>:<localId>` or an http(s) URL resolved to a site by hostname
 *   (no network); a URL id (`<siteKey>:u_…`) whose URL is not on that site's hostnames →
 *   `unsupported` without calling the adapter; unknown sites → `unsupported` with `availableSites`; registered but not loadable
 *   sites (`onboarding`, `failed`) → `unsupported` "site not ready: <status>"; `needs_login` and
 *   `degraded` sites are still attempted;
 * - the adapter's verdict is passed through unchanged (completeness is the adapter's job);
 * - documents are capped at `documentMaxChars` and cached only when `ok`;
 * - the per-tool text budgets (`fetch` 60k; `read_documents` 120k split evenly with a 10k floor) cut
 *   at a paragraph boundary and set `truncated: true`;
 * - every live outcome is fed back into the site lifecycle (`rate_limited` → cool-down; `blocked` does not cool down);
 * - a blocked read (block or captcha page) gets one challenge attempt on its URL (a native id: the page
 *   the adapter last showed, else the homepage) and one re-run (`callWithChallenge`, ./live-call.ts);
 *   at most one attempt per site and tool call: the refs of one `read_documents` call that meet the
 *   challenge while it runs join it and re-run, later ones do not start another.
 */
import { finalizeDocument } from "../../core/assemble.js";
import { parseRef, resolveSiteByHostname, toAdapterRef } from "../../core/ids.js";
import type { Document, FailureStatus, Outcome, OutcomeStatus } from "../../core/models.js";
import { isServingStatus } from "../../core/lifecycle.js";
import { readTargetOutcome } from "../../core/targets.js";
import { truncateText } from "../../core/text.js";
import { hostnameKey, parseHttpUrl } from "../../core/url.js";
import { systemClock } from "../../ports/clock.js";
import type { RegisteredSite } from "../../ports/registry.js";
import { readCacheKey } from "../storage/result-cache.js";
import { adapterOutcome, normalizeReadResponse } from "./adapter-output.js";
import { DEFAULT_TOOL_TUNABLES, errorMessage } from "./deps.js";
import type { ToolServiceDeps, ToolTunables } from "./deps.js";
import { callSiteAdapter, callWithChallenge, finishOutcome } from "./live-call.js";
import type { LiveCallContext, SettledCall } from "./live-call.js";

/** The error object of a failed read (`fetch` tool error text, `read_documents` item `error`). */
export interface ReadError {
  code: FailureStatus | "empty";
  message: string;
  /** The site the ref resolved to, or the site key / hostname it named when none is registered. */
  site: string | null;
  action?: string | undefined;
  /** Registered sites that can be read, for refs naming no registered site. */
  availableSites?: string[] | undefined;
}

export interface ReadItem {
  ref: string;
  status: OutcomeStatus;
  document?: Document | undefined;
  error?: ReadError | undefined;
}

export interface ReadDocumentsOutput {
  items: ReadItem[];
}

function failure(ref: string, outcome: Outcome, site: string | null, availableSites?: string[]): ReadItem {
  const error: ReadError = {
    code: outcome.status === "ok" ? "adapter_error" : outcome.status,
    message: outcome.message ?? outcome.status,
    site,
  };
  if (outcome.action !== undefined) error.action = outcome.action;
  if (availableSites !== undefined) error.availableSites = availableSites;
  return { ref, status: error.code, error };
}

/** Cuts a document's text to `maxChars` at a paragraph boundary; `truncated` stays true once set. */
export function applyTextBudget(document: Document, maxChars: number): Document {
  const { text, truncated } = truncateText(document.text, maxChars);
  if (!truncated) return document;
  return { ...document, text, truncated: true };
}

/** Even split of the total budget over the documents, never below the per-item floor. */
export function perItemBudget(total: number, floor: number, documents: number): number {
  if (documents <= 0) return total;
  return Math.max(floor, Math.floor(total / documents));
}

export class ReadService {
  private readonly tunables: ToolTunables;
  private readonly live: LiveCallContext;

  constructor(private readonly deps: ToolServiceDeps) {
    this.tunables = { ...DEFAULT_TOOL_TUNABLES, ...deps.tunables };
    this.live = {
      registry: deps.registry,
      runSiteTask: deps.runSiteTask,
      logger: deps.logger,
      clock: deps.clock ?? systemClock,
      challenges: deps.challenges,
    };
  }

  /** `fetch`: one ref, text within the `fetch` budget. Never throws; failures come back as items. */
  async fetch(ref: string, signal?: AbortSignal): Promise<ReadItem> {
    const item = await this.readOne(ref, this.deadline(), signal, "fetch", new Set());
    if (item.document === undefined) return item;
    return { ...item, document: applyTextBudget(item.document, this.tunables.fetchTextMaxChars) };
  }

  /**
   * `read_documents`: per-item outcomes in input order; the total text budget is split evenly. The refs
   * share one captcha attempt per site: a ref of a site that already had its attempt in this call only
   * joins one still in flight.
   */
  async readDocuments(refs: readonly string[], signal?: AbortSignal): Promise<ReadDocumentsOutput> {
    const deadline = this.deadline();
    const attempted = new Set<string>();
    const items = await Promise.all(
      refs.map((ref) => this.readOne(ref, deadline, signal, "read", attempted)),
    );
    const documents = items.filter((i) => i.document !== undefined).length;
    const share = perItemBudget(
      this.tunables.readDocumentsTotalMaxChars,
      this.tunables.readDocumentsMinCharsPerItem,
      documents,
    );
    return {
      items: items.map((i) =>
        i.document === undefined ? i : { ...i, document: applyTextBudget(i.document, share) },
      ),
    };
  }

  private deadline(): number {
    return this.live.clock.now().getTime() + this.tunables.toolCallBudgetMs;
  }

  private availableSites(sites: readonly RegisteredSite[]): string[] {
    return sites
      .filter((s) => s.loadable && isServingStatus(s.status) && s.capabilities.read)
      .map((s) => s.key);
  }

  /** One ref; never throws. `attempted`: sites that had their captcha attempt in this tool call. */
  async readOne(
    ref: string,
    deadline: number,
    signal?: AbortSignal,
    holder = "read",
    attempted: Set<string> = new Set(),
  ): Promise<ReadItem> {
    try {
      return await this.readOneUnsafe(ref, deadline, signal, holder, attempted);
    } catch (error) {
      this.deps.logger.error("read failed unexpectedly", { error: errorMessage(error) });
      return failure(
        ref,
        { status: "adapter_error", message: `internal error: ${errorMessage(error)}` },
        null,
      );
    }
  }

  private async readOneUnsafe(
    ref: string,
    deadline: number,
    signal: AbortSignal | undefined,
    holder: string,
    attempted: Set<string>,
  ): Promise<ReadItem> {
    const sites = this.deps.registry.list();
    const parsed = parseRef(ref);
    if (parsed.kind === "invalid") {
      return failure(
        ref,
        { status: "unsupported", message: `invalid ref: ${parsed.reason}` },
        null,
        this.availableSites(sites),
      );
    }

    let key: string;
    if (parsed.kind === "url") {
      const owner = resolveSiteByHostname(parsed.hostname, sites);
      if (owner === null) {
        return failure(
          ref,
          { status: "unsupported", message: `no registered site owns ${parsed.hostname.toLowerCase()}` },
          parsed.hostname.toLowerCase(),
          this.availableSites(sites),
        );
      }
      key = owner;
    } else {
      key = parsed.siteKey;
    }
    const site = this.deps.registry.get(key);
    const gate = readTargetOutcome(site, key);
    if (gate !== null) {
      return failure(
        ref,
        { status: gate.status, ...(gate.message !== undefined ? { message: gate.message } : {}) },
        key,
        site === undefined ? this.availableSites(sites) : undefined,
      );
    }
    // A URL id names its site twice (key and URL host); both must agree, so an id cannot steer one
    // site's adapter (and its logged-in session) to a URL on another host.
    if (parsed.kind === "id" && parsed.url !== null) {
      const host = parseHttpUrl(parsed.url)?.hostname ?? "";
      const ownHost = site?.hostnames.some((h) => hostnameKey(h) === hostnameKey(host)) ?? false;
      if (!ownHost && resolveSiteByHostname(host, sites) !== key) {
        return failure(
          ref,
          {
            status: "unsupported",
            message: `the URL in this id is on ${host.toLowerCase()}, which is not a hostname of ${key}`,
          },
          key,
        );
      }
    }
    const loginUrl = site?.loginUrl ?? null;
    const adapterRef = toAdapterRef(parsed);
    const requestedId = parsed.kind === "id" ? `${key}:${parsed.localId}` : null;
    const withRequestedId = (doc: Document): Document =>
      requestedId === null || doc.id === requestedId ? doc : { ...doc, id: requestedId };

    const cacheKey = readCacheKey(key, adapterRef);
    const cached = await this.cacheCall(() => this.deps.cache?.getDocument<Document>(cacheKey));
    if (cached !== undefined) {
      return { ref, status: "ok", document: withRequestedId(cached) };
    }

    const once = async (): Promise<SettledCall<Document | null>> => {
      const call = await callSiteAdapter(
        this.live,
        key,
        { holder, deadline, signal },
        async (loaded, actx) => {
          const response = normalizeReadResponse(await loaded.adapter.read(adapterRef, actx));
          if (response.document === null) return { response, document: null };
          const adapter = loaded.adapter;
          const document = finalizeDocument(key, response.document, {
            fetchedAt: actx.now().toISOString(),
            maxChars: this.tunables.documentMaxChars,
            canonicalize: adapter.canonicalize ? (url: string) => adapter.canonicalize!(url) : undefined,
          });
          return { response, document };
        },
      );
      if (!call.ok)
        return {
          outcome: finishOutcome(call.outcome, key, loginUrl),
          // A thrown failure may be a block page too (a page script that ran into a bot check).
          blocked: call.blocked,
          value: null,
          pageUrl: call.pageUrl,
        };
      const { response, document } = call.value;
      return {
        outcome: finishOutcome(adapterOutcome(response), key, loginUrl),
        blocked: response.blocked,
        value: document,
        pageUrl: call.pageUrl,
      };
    };

    // An attempt targets the page of the failed read; a native id has no URL, so the page the
    // adapter last showed (else the homepage). One attempt per site for the whole tool call.
    const settled = await callWithChallenge(
      this.live,
      { key, holder, deadline, signal, url: adapterRef.url ?? null, attempted },
      once,
    );
    const { outcome, blocked, value: document } = settled;

    if (outcome.status !== "ok" || document === null) {
      this.deps.logger.info("site read outcome", { site: key, status: outcome.status, blocked });
      return failure(ref, outcome, key);
    }
    await this.cacheCall(() => this.deps.cache?.putDocument(cacheKey, key, "ok", document));
    return { ref, status: "ok", document: withRequestedId(document) };
  }

  private async cacheCall<T>(fn: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.deps.logger.warn("read cache operation failed", { error: errorMessage(error) });
      return undefined;
    }
  }
}
