/** Query language. */
import { DEFAULT_QUERY_LIMITS } from "./defaults.js";
import type { QueryLimits } from "./defaults.js";
import type { SearchRequest } from "./models.js";

export const NO_SEARCH_TERMS_MESSAGE = "no search terms";

export interface ParsedQuery {
  /** Free text with qualifiers removed, whitespace collapsed. */
  text: string;
  terms: string[];
  /** `site:` values (lowercased, de-duplicated, in order) or null when none given. */
  sites: string[] | null;
  after: string | null;
  before: string | null;
  limit: number;
  page: number;
  /** False when no words remain after stripping qualifiers → `empty` with {@link NO_SEARCH_TERMS_MESSAGE}. */
  hasTerms: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const QUALIFIER = /^(site|after|before|limit|page):(.+)$/i;
const INTEGER = /^-?\d+$/;

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveLimits(options: Partial<QueryLimits> | undefined): QueryLimits {
  return { ...DEFAULT_QUERY_LIMITS, ...options };
}

export function parseQuery(raw: string, options?: Partial<QueryLimits>): ParsedQuery {
  const limits = resolveLimits(options);
  const terms: string[] = [];
  const sites: string[] = [];
  let after: string | null = null;
  let before: string | null = null;
  let limit = limits.limitDefault;
  let page = limits.pageDefault;

  for (const token of raw.split(/\s+/)) {
    if (token === "") continue;
    const m = QUALIFIER.exec(token);
    const name = m?.[1]?.toLowerCase();
    const value = m?.[2];
    if (name === undefined || value === undefined) {
      terms.push(token);
      continue;
    }
    if (name === "site") {
      const site = value.toLowerCase();
      if (!sites.includes(site)) sites.push(site);
    } else if (name === "after" || name === "before") {
      if (!isValidIsoDate(value)) {
        terms.push(token);
      } else if (name === "after") {
        after = value;
      } else {
        before = value;
      }
    } else if (!INTEGER.test(value)) {
      terms.push(token);
    } else if (name === "limit") {
      limit = clamp(Number(value), limits.limitMin, limits.limitMax);
    } else {
      page = clamp(Number(value), limits.pageMin, limits.pageMax);
    }
  }

  return {
    text: terms.join(" "),
    terms,
    sites: sites.length > 0 ? sites : null,
    after,
    before,
    limit,
    page,
    hasTerms: terms.length > 0,
  };
}

/** Structured fields of `search_sites`; each wins over the matching qualifier. */
export interface StructuredSearchFields {
  sites?: readonly string[] | undefined;
  after?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface BuiltSearchRequest {
  request: SearchRequest;
  /** `page:N` (meaningful for `search`; `search_sites` uses the cursor). */
  page: number;
  hasTerms: boolean;
  /** Structured fields that were present but invalid and therefore ignored. */
  ignoredFields: ("after" | "before" | "limit")[];
}

export function buildSearchRequest(
  query: string,
  fields: StructuredSearchFields = {},
  options?: Partial<QueryLimits>,
): BuiltSearchRequest {
  const limits = resolveLimits(options);
  const parsed = parseQuery(query, limits);
  const ignoredFields: BuiltSearchRequest["ignoredFields"] = [];

  let sites = parsed.sites;
  if (fields.sites !== undefined && fields.sites.length > 0) {
    sites = [...new Set(fields.sites.map((s) => s.trim().toLowerCase()).filter((s) => s !== ""))];
    if (sites.length === 0) sites = parsed.sites;
  }

  const pickDate = (
    name: "after" | "before",
    value: string | undefined,
    fallback: string | null,
  ): string | null => {
    if (value === undefined) return fallback;
    if (isValidIsoDate(value)) return value;
    ignoredFields.push(name);
    return fallback;
  };

  let limit = parsed.limit;
  if (fields.limit !== undefined) {
    if (Number.isFinite(fields.limit))
      limit = clamp(Math.trunc(fields.limit), limits.limitMin, limits.limitMax);
    else ignoredFields.push("limit");
  }

  return {
    request: {
      text: parsed.text,
      sites,
      after: pickDate("after", fields.after, parsed.after),
      before: pickDate("before", fields.before, parsed.before),
      limit,
      cursor: fields.cursor ?? null,
    },
    page: parsed.page,
    hasTerms: parsed.hasTerms,
    ignoredFields,
  };
}
