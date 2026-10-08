/**
 * Default values for the tunables used by the pure core.
 * Logic never hard-codes these numbers; functions accept them as options and fall back to these.
 */
export interface QueryLimits {
  /** `limit:N` default (10). */
  readonly limitDefault: number;
  /** Lower clamp for `limit:N` (1). */
  readonly limitMin: number;
  /** Upper clamp for `limit:N` (25). */
  readonly limitMax: number;
  /** `page:N` default (1). */
  readonly pageDefault: number;
  /** Lower clamp for `page:N` (1). */
  readonly pageMin: number;
  /** Upper clamp for `page:N` (10). */
  readonly pageMax: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = {
  limitDefault: 10,
  limitMin: 1,
  limitMax: 25,
  pageDefault: 1,
  pageMin: 1,
  pageMax: 10,
};

/** Most recent URL hashes kept in a search cursor. */
export const DEFAULT_SEEN_HASH_LIMIT = 200;

/** Maximum accepted cursor token length; guards against oversized input. */
export const DEFAULT_CURSOR_MAX_LENGTH = 32_768;

/** Document text cap before paragraph-boundary truncation. */
export const DEFAULT_DOCUMENT_MAX_CHARS = 100_000;

/** Manifest default for the minimum readable text length. */
export const DEFAULT_MIN_READ_CHARS = 200;

/** Manifest default politeness interval between page loads on one site. */
export const DEFAULT_MIN_INTERVAL_MS = 1500;

// Captcha attempt defaults, defined only here: the config loader's tunables, the challenge
// coordinator, and the browser port's solver all fall back to these.

/** Time one automatic captcha attempt may take (`captchaAttemptBudgetMs`). */
export const DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS = 45_000;

/** Tool-call budget that must remain for an attempt inside the call (`captchaInlineMinRemainingMs`). */
export const DEFAULT_CAPTCHA_INLINE_MIN_REMAINING_MS = 40_000;

/** Tool-call budget kept back for the re-run after an attempt (`captchaRerunReserveMs`). */
export const DEFAULT_CAPTCHA_RERUN_RESERVE_MS = 15_000;
