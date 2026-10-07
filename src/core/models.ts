/** Core vocabulary and contracts. Pure types plus the exact status sets. */

/** Outcome status set, exact. */
export const OUTCOME_STATUSES = [
  "ok",
  "empty",
  "auth_required",
  "unsupported",
  "access_denied",
  "rate_limited",
  "timeout",
  "adapter_error",
  "browser_unavailable",
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Every status that reports a failure. `ok` and `empty` are never produced for a failure. */
export type FailureStatus = Exclude<OutcomeStatus, "ok" | "empty">;

/** Site lifecycle statuses, exact. */
export const LIFECYCLE_STATUSES = ["onboarding", "active", "needs_login", "degraded", "failed"] as const;

export type SiteLifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export type DatePrecision = "minute" | "day";

export type AccessLevel = "public" | "subscriber";

/** A search request. Dates are `YYYY-MM-DD`. `sites` holds the requested `site:` values (keys or hostnames). */
export interface SearchRequest {
  text: string;
  sites: string[] | null;
  after: string | null;
  before: string | null;
  limit: number;
  cursor: string | null;
}

/** One search result. `publishedAt` is ISO 8601 with offset. */
export interface SearchResult {
  id: string;
  site: string;
  title: string;
  url: string;
  publishedAt: string | null;
  datePrecision: DatePrecision | null;
  excerpt: string | null;
  author: string | null;
}

/** A read document (full text). */
export interface Document {
  id: string;
  site: string;
  title: string;
  url: string;
  publishedAt: string | null;
  datePrecision: DatePrecision | null;
  author: string | null;
  text: string;
  truncated: boolean;
  accessLevel: AccessLevel;
  fetchedAt: string;
  metadata: Record<string, string>;
}

/** What an adapter's `read` receives. */
export interface DocumentRef {
  localId?: string;
  url?: string;
}

/** The manifest's `capabilities`. */
export interface SiteCapabilities {
  search: boolean;
  read: boolean;
  dateFilter: boolean;
  pagination: boolean;
}

/** One entry of `siteStatuses`; `note` carries e.g. the date post-filter notice. */
export interface SiteStatusEntry {
  site: string;
  status: OutcomeStatus;
  message?: string;
  action?: string;
  note?: string;
}

/** A status with its human message / user action. */
export interface Outcome {
  status: OutcomeStatus;
  message?: string;
  action?: string;
}

/** Failure outcome: always carries a message. */
export interface FailureOutcome {
  status: FailureStatus;
  message: string;
  action?: string;
}

/** Inclusive published-date window, `YYYY-MM-DD` bounds. */
export interface DateWindow {
  after: string | null;
  before: string | null;
}

/** The registry facts the pure core needs about a registered site. */
export interface SiteView {
  key: string;
  status: SiteLifecycleStatus;
  hostnames: readonly string[];
  loginUrl: string | null;
  /** Last failure message (degraded) or failure reason (failed). */
  lastFailure: string | null;
  capabilities: SiteCapabilities;
}
