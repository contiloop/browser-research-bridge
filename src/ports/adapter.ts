/**
 * Site adapter contract. `sites/<key>/adapter.ts` default-exports a {@link SiteAdapter}.
 *
 * Adapters return items without `id`/`site`: the core builds result ids with `makeResultId`
 * (src/core/ids.ts) from `localId` (the site's stable article id, when extractable) or the
 * canonicalized URL, so every id round-trips through `read`.
 */
import type { DatePrecision, Document, DocumentRef, OutcomeStatus, SearchResult } from "../core/models.js";
import type { BrowserSession } from "./browser.js";
import type { JsonValue } from "./json.js";
import type { Logger } from "./logger.js";
import type { SiteManifest } from "./manifest.js";

/** What one site's adapter receives for one search page. */
export interface AdapterSearchRequest {
  /** Free text with qualifiers removed. */
  text: string;
  /** Apply natively only when `capabilities.dateFilter`; otherwise the core post-filters. */
  after: string | null;
  before: string | null;
  limit: number;
  /** The adapter's own cursor from a previous `nextCursor`; null for its first page. */
  cursor: string | null;
}

export interface AdapterSearchItem extends Omit<SearchResult, "id" | "site"> {
  /** Stable site article id; omit/null to fall back to the URL. Must not start with `u_` or contain whitespace. */
  localId?: string | null | undefined;
}

export interface AdapterSearchResponse {
  results: AdapterSearchItem[];
  nextCursor: string | null;
  status: OutcomeStatus;
  message?: string | undefined;
  action?: string | undefined;
  /**
   * The adapter detected a block or captcha page (as opposed to a paywall): the site is left alone
   * for the cool-down period. `rate_limited` starts the cool-down without this flag.
   */
  blocked?: boolean | undefined;
}

export interface AdapterDocument extends Omit<Document, "id" | "site" | "truncated" | "fetchedAt"> {
  localId?: string | null | undefined;
}

export interface AdapterReadResponse {
  /** Present only with status `ok`; the full text, never a teaser. */
  document?: AdapterDocument | undefined;
  status: OutcomeStatus;
  message?: string | undefined;
  action?: string | undefined;
  /** See {@link AdapterSearchResponse.blocked}. */
  blocked?: boolean | undefined;
}

/** A fetched page handed to the adapter's completeness detector. */
export interface CompletenessInput {
  /** Final URL after redirects. */
  url: string;
  /** HTTP status of the final response. */
  httpStatus: number;
  html: string;
}

/**
 * The completeness detector's verdict: `ok` only when the page carries the full article text;
 * otherwise `auth_required` (login wall, lapsed session) or `access_denied` (paywall teaser,
 * block page, captcha), with the marker that matched as `reason`.
 */
export interface CompletenessVerdict {
  status: OutcomeStatus;
  reason?: string | undefined;
}

export interface SmokeTestResult {
  status: OutcomeStatus;
  message?: string | undefined;
}

export interface ParsedDate {
  /** ISO 8601 with offset. */
  publishedAt: string;
  datePrecision: DatePrecision;
}

/** Options of {@link AdapterHelpers.extractText}. */
export interface ExtractTextOptions {
  /**
   * Keep the regions dropped by default as boilerplate: `nav`, `aside`, `footer`, `dialog`, elements
   * with a navigation/banner/contentinfo/complementary/search/menu/dialog role, hidden elements, and
   * elements whose class or id marks ads, comments, share bars, newsletters, related links, cookie
   * notices, breadcrumbs, or sidebars. `script`, `style`, `template`, form controls, `svg` and
   * similar non-text elements are always dropped.
   */
  keepBoilerplate?: boolean | undefined;
  /** Extra class names or ids (exact tokens, case-insensitive) whose elements are dropped. */
  dropClassNames?: readonly string[] | undefined;
  /** `text` (default): a link becomes its text; `inline`: `text (url)` when the URL differs from the text. */
  links?: "text" | "inline" | undefined;
  /** Resolves relative link URLs for `links: "inline"`. */
  baseUrl?: string | undefined;
}

/**
 * Helper API injected as `ctx.helpers` (implemented in src/adapter-kit: `createAdapterHelpers()`).
 * Date parsing resolves relative dates ("3시간 전") against the manifest time zone and the clock.
 * The adapter-kit package exports the same functions (and more utilities) for direct import.
 */
export interface AdapterHelpers {
  parseDate(input: string, options?: { timezone?: string; now?: Date }): ParsedDate | null;
  /** HTML → Markdown-ish plain text (paragraphs, headings, lists; links as text; boilerplate dropped). */
  extractText(html: string, options?: ExtractTextOptions): string;
  /** Aside accessibility snapshot (`ctx.browser.snapshot`) → Markdown-ish plain text. */
  snapshotToText(snapshot: string): string;
  /** Opaque per-site cursor codec for `nextCursor` (base64url JSON). */
  encodeCursor(state: JsonValue): string;
  /** Inverse of `encodeCursor`; null for null, empty, or malformed input. */
  decodeCursor(cursor: string | null): JsonValue | null;
}

export interface AdapterContext {
  browser: BrowserSession;
  helpers: AdapterHelpers;
  manifest: SiteManifest;
  logger: Logger;
  /** Aborted when the tool-call budget is spent. */
  signal: AbortSignal;
  now(): Date;
}

export interface SiteAdapter {
  /** One site's search page. Read-only sites (`capabilities.search = false`) return `unsupported`. */
  search(request: AdapterSearchRequest, ctx: AdapterContext): Promise<AdapterSearchResponse>;
  read(ref: DocumentRef, ctx: AdapterContext): Promise<AdapterReadResponse>;
  /** Runs `sampleQuery` (if search) and reads `sampleReadUrl` or the first result within 60 s. */
  smokeTest(ctx: AdapterContext): Promise<SmokeTestResult>;
  /** Site-specific URL canonicalizer; runs before dedup normalization and before fallback ids. */
  canonicalize?(url: string): string;
  /**
   * The adapter's completeness detector (its teaser/login-wall markers) applied to raw page HTML.
   * Validation step d runs it on the logged-out form of `gatedSampleUrl` and requires a
   * non-`ok` verdict; required when the manifest sets `gatedSampleUrl`. Pure: no browser access.
   */
  checkCompleteness?(page: CompletenessInput): CompletenessVerdict;
}
