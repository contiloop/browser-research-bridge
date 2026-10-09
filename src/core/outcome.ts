/** Outcome statuses, error → status mapping, and message/action defaults. */
import { OUTCOME_STATUSES } from "./models.js";
import type { FailureOutcome, FailureStatus, Outcome, OutcomeStatus } from "./models.js";

const STATUS_SET: ReadonlySet<string> = new Set(OUTCOME_STATUSES);

export function isOutcomeStatus(value: unknown): value is OutcomeStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export function isFailureStatus(value: unknown): value is FailureStatus {
  return isOutcomeStatus(value) && value !== "ok" && value !== "empty";
}

export interface OutcomeErrorOptions {
  cause?: unknown;
  /**
   * The failure is a block or captcha page met while the step ran (for example a page script that ran
   * into a bot check), like an adapter's returned `blocked: true`. Callers that run challenge attempts
   * read it with {@link isBlockedError}; it never becomes part of the outcome.
   */
  blocked?: boolean | undefined;
}

/**
 * Typed failure thrown by ports and adapters. A non-failure status passed at runtime is coerced to
 * `adapter_error`, so an error can never surface as `ok` or `empty`.
 */
export class OutcomeError extends Error {
  readonly status: FailureStatus;
  readonly action: string | undefined;
  /** A block or captcha page (see `OutcomeErrorOptions.blocked`); false unless given. */
  readonly blocked: boolean;

  constructor(status: FailureStatus, message: string, action?: string, options?: OutcomeErrorOptions) {
    super(message, options !== undefined && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "OutcomeError";
    this.status = isFailureStatus(status) ? status : "adapter_error";
    this.action = action;
    this.blocked = options?.blocked === true;
  }
}

/**
 * Whether something thrown is a failure flagged `blocked` (a block or captcha page): an object with a
 * failure status and `blocked: true`, as an `OutcomeError` carries it. Read where a returned adapter
 * verdict's `blocked` would be read.
 */
export function isBlockedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; blocked?: unknown };
  return e.blocked === true && isFailureStatus(e.status);
}

export const DEFAULT_STATUS_MESSAGES: Readonly<Record<Exclude<OutcomeStatus, "ok">, string>> = {
  empty: "no results",
  auth_required: "login required or session expired",
  unsupported: "not supported",
  access_denied: "access denied (paywall, block page, or captcha)",
  rate_limited: "the site is throttling requests; try again later",
  timeout: "time budget exceeded",
  adapter_error: "the site adapter failed",
  browser_unavailable: "the Aside browser is not reachable",
};

/** User action for a site that needs a login. */
export function loginAction(site: string | undefined, loginUrl: string | null | undefined): string {
  const target = loginUrl ?? site ?? "the site";
  return `Log in to ${target} in Aside, then click Check now in the dashboard`;
}

export function accessDeniedAction(site: string | undefined): string {
  return `Open ${site ?? "the site"} in Aside and check the subscription, captcha, or block page, then retry`;
}

function hasStringField<K extends string>(value: object, key: K): value is Record<K, string> {
  return key in value && typeof (value as Record<K, unknown>)[key] === "string";
}

/** Maps anything thrown to a failure outcome; never `ok` or `empty`. */
export function errorToOutcome(err: unknown): FailureOutcome {
  if (typeof err === "object" && err !== null) {
    const message = hasStringField(err, "message") && err.message.trim() !== "" ? err.message : undefined;
    if ("status" in err && isFailureStatus(err.status)) {
      const out: FailureOutcome = {
        status: err.status,
        message: message ?? DEFAULT_STATUS_MESSAGES[err.status],
      };
      if (hasStringField(err, "action") && err.action !== "") out.action = err.action;
      return out;
    }
    if (hasStringField(err, "name") && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { status: "timeout", message: message ?? DEFAULT_STATUS_MESSAGES.timeout };
    }
    return { status: "adapter_error", message: message ?? DEFAULT_STATUS_MESSAGES.adapter_error };
  }
  if (typeof err === "string" && err.trim() !== "") return { status: "adapter_error", message: err };
  return { status: "adapter_error", message: "unknown error" };
}

export interface OutcomeContext {
  site?: string | undefined;
  loginUrl?: string | null | undefined;
}

/** Ensures every non-ok outcome has a message and `auth_required`/`access_denied` carry an action. */
export function withOutcomeDefaults(outcome: Outcome, context: OutcomeContext): Outcome {
  const { status } = outcome;
  if (status === "ok") return { ...outcome };
  const out: Outcome = {
    status,
    message:
      outcome.message !== undefined && outcome.message.trim() !== ""
        ? outcome.message
        : DEFAULT_STATUS_MESSAGES[status],
  };
  if (outcome.action !== undefined && outcome.action.trim() !== "") out.action = outcome.action;
  else if (status === "auth_required") out.action = loginAction(context.site, context.loginUrl);
  else if (status === "access_denied") out.action = accessDeniedAction(context.site);
  return out;
}

/**
 * Validates an adapter-reported status: unknown values → `adapter_error`; `ok` with no results →
 * `empty`; `empty` with results → `ok`. Failure statuses pass through unchanged (never `empty`).
 */
export function coerceAdapterStatus(status: unknown, resultCount: number): OutcomeStatus {
  if (!isOutcomeStatus(status)) return "adapter_error";
  if (status === "ok" && resultCount === 0) return "empty";
  if (status === "empty" && resultCount > 0) return "ok";
  return status;
}
