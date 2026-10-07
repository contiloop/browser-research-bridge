/**
 * Builders for what `search` and `read` return. Adapters return items
 * without `id`/`site`: the core builds result ids from `localId` (the site's stable article id) or
 * the canonicalized URL. The builders clean whitespace, clip excerpts, stringify metadata, and pick
 * `ok`/`empty` from the result count, so an adapter cannot report `ok` with nothing in it.
 */
import type { AccessLevel, OutcomeStatus } from "../core/models.js";
import type {
  AdapterDocument,
  AdapterReadResponse,
  AdapterSearchItem,
  AdapterSearchResponse,
  ParsedDate,
} from "../ports/adapter.js";
import { cleanInlineText, clipText } from "./text.js";

/** Default excerpt length in characters. */
export const DEFAULT_EXCERPT_CHARS = 300;

export interface SearchItemInput {
  title: string;
  /** The article URL as found on the site (absolute, on the site's hostnames). */
  url: string;
  /** The site's own stable article id; omit when there is none (the URL is used). */
  localId?: string | number | null | undefined;
  /** From `parseDate`; null/omitted when the site shows no date. */
  date?: ParsedDate | null | undefined;
  excerpt?: string | null | undefined;
  author?: string | null | undefined;
}

function optionalText(value: string | null | undefined): string | null {
  const t = cleanInlineText(value);
  return t === "" ? null : t;
}

function localIdOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

export function searchItem(
  input: SearchItemInput,
  options: { excerptChars?: number } = {},
): AdapterSearchItem {
  const excerpt = optionalText(input.excerpt);
  return {
    localId: localIdOf(input.localId),
    title: cleanInlineText(input.title),
    url: input.url.trim(),
    publishedAt: input.date?.publishedAt ?? null,
    datePrecision: input.date?.datePrecision ?? null,
    excerpt: excerpt === null ? null : clipText(excerpt, options.excerptChars ?? DEFAULT_EXCERPT_CHARS),
    author: optionalText(input.author),
  };
}

export interface DocumentInput {
  title: string;
  url: string;
  /** Full Markdown-ish text (e.g. from `extractText`); never a teaser. */
  text: string;
  localId?: string | number | null | undefined;
  date?: ParsedDate | null | undefined;
  author?: string | null | undefined;
  /** `subscriber` when the page needed the login/subscription; default `public`. */
  accessLevel?: AccessLevel | undefined;
  /** Extra facts (points, section, tags …); null/undefined values are left out. */
  metadata?: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined;
}

export function documentOf(input: DocumentInput): AdapterDocument {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    if (v !== null && v !== undefined && String(v) !== "") metadata[k] = String(v);
  }
  return {
    localId: localIdOf(input.localId),
    title: cleanInlineText(input.title),
    url: input.url.trim(),
    publishedAt: input.date?.publishedAt ?? null,
    datePrecision: input.date?.datePrecision ?? null,
    author: optionalText(input.author),
    text: input.text.trim(),
    accessLevel: input.accessLevel ?? "public",
    metadata,
  };
}

export interface FailureExtras {
  /** What the user should do (required in spirit for `auth_required` / `access_denied`). */
  action?: string | undefined;
  /** A block or captcha page was detected: the site is left alone for the cool-down period. */
  blocked?: boolean | undefined;
}

/** `ok` with results, `empty` without. */
export function searchResponse(
  results: AdapterSearchItem[],
  nextCursor: string | null,
): AdapterSearchResponse {
  return {
    results,
    nextCursor: results.length > 0 ? nextCursor : null,
    status: results.length > 0 ? "ok" : "empty",
  };
}

export function searchFailure(
  status: Exclude<OutcomeStatus, "ok">,
  message: string,
  extras: FailureExtras = {},
): AdapterSearchResponse {
  const out: AdapterSearchResponse = { results: [], nextCursor: null, status, message };
  if (extras.action !== undefined) out.action = extras.action;
  if (extras.blocked) out.blocked = true;
  return out;
}

export function readResponse(document: AdapterDocument): AdapterReadResponse {
  return { status: "ok", document };
}

export function readFailure(
  status: Exclude<OutcomeStatus, "ok">,
  message: string,
  extras: FailureExtras = {},
): AdapterReadResponse {
  const out: AdapterReadResponse = { status, message };
  if (extras.action !== undefined) out.action = extras.action;
  if (extras.blocked) out.blocked = true;
  return out;
}
