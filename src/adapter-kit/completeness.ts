/**
 * Completeness checks: decide from a fetched page whether it holds
 * the full article or a login wall, paywall teaser, block/captcha page, or throttling page. An
 * adapter declares its site's markers once and uses the checker both in `read` (before returning
 * `ok`) and as its `checkCompleteness` export, which validation runs on the logged-out form of
 * `gatedSampleUrl`. Pure: no browser access.
 */
import type { OutcomeStatus } from "../core/models.js";
import type { CompletenessInput, CompletenessVerdict } from "../ports/adapter.js";

/** A literal substring (case-sensitive) or a regular expression. */
export type Marker = string | RegExp;

export interface CompletenessRules {
  /** Login wall or lapsed-session markers (e.g. a sign-in form on the article page) → `auth_required`. */
  loginWall?: readonly Marker[] | undefined;
  /** Final-URL markers of a redirect to the login page → `auth_required`. */
  loginUrls?: readonly Marker[] | undefined;
  /** Paywall / subscription teaser markers → `access_denied`. */
  paywall?: readonly Marker[] | undefined;
  /** Block or captcha page markers → `access_denied` with `blocked: true` (cool-down). */
  blockPage?: readonly Marker[] | undefined;
  /** Throttling page markers → `rate_limited` with `blocked: true`. */
  rateLimit?: readonly Marker[] | undefined;
  /**
   * Full-text markers: at least one must be present (e.g. the article body container or the
   * "end of article" element that teasers lack). Missing → `access_denied`.
   */
  required?: readonly Marker[] | undefined;
  /** Also check {@link COMMON_BLOCK_MARKERS} (default true). */
  commonBlockMarkers?: boolean | undefined;
}

export interface CompletenessResult extends CompletenessVerdict {
  /** True for block/captcha/throttle pages: report `blocked: true` so the site cools down. */
  blocked?: boolean | undefined;
}

/** Challenge pages of common bot-protection services (Cloudflare, DataDome, PerimeterX, Akamai). */
export const COMMON_BLOCK_MARKERS: readonly Marker[] = [
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /window\._cf_chl_opt/,
  /Attention Required! \| Cloudflare/i,
  /captcha-delivery\.com/i,
  /id="px-captcha"/i,
  /<title>\s*Access Denied\s*<\/title>/i,
];

function describe(marker: Marker): string {
  return typeof marker === "string" ? JSON.stringify(marker.slice(0, 60)) : String(marker).slice(0, 80);
}

/** The first marker found in `text`, or null. */
export function findMarker(text: string, markers: readonly Marker[] | undefined): Marker | null {
  for (const marker of markers ?? []) {
    if (typeof marker === "string") {
      if (marker !== "" && text.includes(marker)) return marker;
    } else {
      marker.lastIndex = 0;
      if (marker.test(text)) return marker;
    }
  }
  return null;
}

function verdict(status: OutcomeStatus, reason: string, blocked = false): CompletenessResult {
  return blocked ? { status, reason, blocked: true } : { status, reason };
}

/**
 * Applies the rules in this order: HTTP 429/401, throttling and block markers, login redirects and
 * login-wall markers, paywall markers, HTTP 403/404/410/5xx, then the required full-text markers.
 */
export function checkPageCompleteness(page: CompletenessInput, rules: CompletenessRules): CompletenessResult {
  const html = page.html ?? "";
  const status = page.httpStatus;
  if (status === 429) return verdict("rate_limited", "HTTP 429", true);
  if (status === 401) return verdict("auth_required", "HTTP 401");
  let m = findMarker(html, rules.rateLimit);
  if (m) return verdict("rate_limited", `throttling marker ${describe(m)}`, true);
  m = findMarker(html, rules.blockPage);
  if (!m && rules.commonBlockMarkers !== false) m = findMarker(html, COMMON_BLOCK_MARKERS);
  if (m) return verdict("access_denied", `block page marker ${describe(m)}`, true);
  m = findMarker(page.url ?? "", rules.loginUrls);
  if (m) return verdict("auth_required", `redirected to a login URL (${describe(m)})`);
  m = findMarker(html, rules.loginWall);
  if (m) return verdict("auth_required", `login wall marker ${describe(m)}`);
  m = findMarker(html, rules.paywall);
  if (m) return verdict("access_denied", `paywall marker ${describe(m)}`);
  if (status === 403) return verdict("access_denied", "HTTP 403");
  if (status === 404 || status === 410) return verdict("empty", `HTTP ${status}: no such page`);
  if (status >= 500) return verdict("adapter_error", `HTTP ${status} from the site`);
  if (rules.required && rules.required.length > 0 && findMarker(html, rules.required) === null) {
    return verdict("access_denied", "the full-text marker is missing (teaser or truncated page)");
  }
  return { status: "ok" };
}

/** A checker bound to one site's rules; usable directly as the adapter's `checkCompleteness`. */
export function completenessChecker(
  rules: CompletenessRules,
): (page: CompletenessInput) => CompletenessResult {
  return (page) => checkPageCompleteness(page, rules);
}
