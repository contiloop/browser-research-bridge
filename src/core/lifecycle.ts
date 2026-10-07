/**
 * Site lifecycle: the runtime state kept per registered site in
 * `data/sites.json` and the pure transition function over the exact status set
 * (`onboarding`, `active`, `needs_login`, `degraded`, `failed`).
 *
 * The function never performs side effects; it returns the next state plus the effects the caller
 * must apply (clear the site's cache, start the browser cool-down). The lifecycle → outcome mapping
 * used by search and `list_sites` is `lifecycleToOutcome` in ./targets.ts.
 */
import { LIFECYCLE_STATUSES } from "./models.js";
import type { Outcome, OutcomeStatus, SiteLifecycleStatus } from "./models.js";

/** Default for the `consecutiveAdapterErrorsToDegrade` tunable. */
export const DEFAULT_ADAPTER_ERRORS_TO_DEGRADE = 3;

/** One registered site's runtime state (`data/sites.json` is the source of truth for registration). */
export interface SiteRuntimeState {
  key: string;
  status: SiteLifecycleStatus;
  /** Last failure message (`degraded`, `needs_login`) or failure reason (`failed`); null when healthy. */
  lastFailure: string | null;
  /** ISO time of the last completed health check or validation; null = never (checked at the next run). */
  lastCheckedAt: string | null;
  /** ISO time a passing check last confirmed the site's login after `needs_login`. */
  lastLoginConfirmedAt: string | null;
  /** Hostnames resolved at Add time; ownership for sites that have no manifest yet. */
  provisionalHostnames: string[];
  /** Consecutive live `adapter_error` outcomes; reset by `ok`/`empty`, a passing check, or a swap. */
  consecutiveAdapterErrors: number;
  createdAt: string;
  updatedAt: string;
}

export interface LifecycleOptions {
  /** Consecutive live `adapter_error` outcomes that move an `active` site to `degraded` (default 3). */
  adapterErrorsToDegrade?: number | undefined;
}

export type LifecycleEvent =
  /** Add or Retry: the onboarding job starts (a Repair keeps the current status and sends no event). */
  | { type: "onboarding_started"; at: string }
  /** The onboarding job failed for good (`failed` with the reason). No-op for sites not onboarding. */
  | { type: "onboarding_failed"; reason: string; at: string }
  /** A validated adapter was moved into place (Add or Repair): the site is `active`. */
  | { type: "promoted"; at: string }
  /** A live search/read outcome. `blocked` marks a block/captcha page. */
  | { type: "live_outcome"; outcome: Outcome; blocked?: boolean | undefined; at: string }
  /** A health check (light validation) result. */
  | { type: "health_check"; outcome: Outcome; at: string }
  /** Startup found the adapter folder unusable for a site that should be serving. */
  | { type: "folder_incomplete"; reason: string; at: string };

export interface LifecycleEffects {
  /** Clear the site's cache entries (search pages and documents). */
  clearCache: boolean;
  /** Leave the site alone for the cool-down period (scheduler `setCooldown`). */
  coolDown: boolean;
}

export interface LifecycleTransition {
  state: SiteRuntimeState;
  effects: LifecycleEffects;
  /** True when anything in the state changed (the caller persists only then). */
  changed: boolean;
}

const STATUS_SET: ReadonlySet<string> = new Set(LIFECYCLE_STATUSES);

export function isLifecycleStatus(value: unknown): value is SiteLifecycleStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** Sites whose adapter is loadable and serving (searched when `active`, read when any of these). */
export function isServingStatus(status: SiteLifecycleStatus): boolean {
  return status === "active" || status === "needs_login" || status === "degraded";
}

export interface NewSiteStateInput {
  key: string;
  status: SiteLifecycleStatus;
  at: string;
  provisionalHostnames?: readonly string[] | undefined;
  lastFailure?: string | null | undefined;
}

export function newSiteState(input: NewSiteStateInput): SiteRuntimeState {
  return {
    key: input.key,
    status: input.status,
    lastFailure: input.lastFailure ?? null,
    lastCheckedAt: null,
    lastLoginConfirmedAt: null,
    provisionalHostnames: [...(input.provisionalHostnames ?? [])],
    consecutiveAdapterErrors: 0,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

const NO_EFFECTS: LifecycleEffects = { clearCache: false, coolDown: false };

function messageOf(outcome: Outcome): string {
  const m = outcome.message?.trim();
  return m !== undefined && m !== "" ? m : outcome.status;
}

function isSuccess(status: OutcomeStatus): boolean {
  return status === "ok" || status === "empty";
}

/**
 * The lifecycle transition function. Rules:
 *
 * - Live outcomes (only for serving sites; `onboarding`/`failed` sites are never searched or read):
 *   `auth_required` → `needs_login` at once and the cache is cleared; `adapter_error` counts toward
 *   `degraded` (N consecutive, tunable, from `active`); `ok`/`empty` reset the count; `rate_limited`
 *   or a `blocked` page start the cool-down without a status change; `access_denied`, `timeout`,
 *   `browser_unavailable`, `unsupported` never change the status or the count.
 * - Health check (serving sites): `ok` → `active` (clearing the cache and recording the login
 *   confirmation when recovering from `needs_login`); `auth_required` → `needs_login`;
 *   `browser_unavailable` → no change (the check did not reach the site; it is retried at the next
 *   run); any other failure → `degraded` with the message.
 * - `promoted` → `active` with failures cleared; `onboarding_started` → `onboarding`;
 *   `onboarding_failed` (from `onboarding`) → `failed`; `folder_incomplete` → `failed`.
 */
export function transitionSite(
  state: SiteRuntimeState,
  event: LifecycleEvent,
  options: LifecycleOptions = {},
): LifecycleTransition {
  const threshold = Math.max(1, options.adapterErrorsToDegrade ?? DEFAULT_ADAPTER_ERRORS_TO_DEGRADE);
  const next: SiteRuntimeState = { ...state, provisionalHostnames: [...state.provisionalHostnames] };
  const effects: LifecycleEffects = { ...NO_EFFECTS };

  switch (event.type) {
    case "onboarding_started":
      next.status = "onboarding";
      next.lastFailure = null;
      next.consecutiveAdapterErrors = 0;
      break;

    case "onboarding_failed":
      if (state.status !== "onboarding") return unchanged(state);
      next.status = "failed";
      next.lastFailure = event.reason;
      break;

    case "promoted":
      next.status = "active";
      next.lastFailure = null;
      next.consecutiveAdapterErrors = 0;
      next.lastCheckedAt = event.at;
      break;

    case "folder_incomplete":
      next.status = "failed";
      next.lastFailure = event.reason;
      next.consecutiveAdapterErrors = 0;
      break;

    case "live_outcome": {
      if (!isServingStatus(state.status)) return unchanged(state);
      const { status } = event.outcome;
      effects.coolDown = status === "rate_limited" || event.blocked === true;
      if (isSuccess(status)) {
        next.consecutiveAdapterErrors = 0;
      } else if (status === "auth_required") {
        next.status = "needs_login";
        next.lastFailure = messageOf(event.outcome);
        next.consecutiveAdapterErrors = 0;
        effects.clearCache = true;
      } else if (status === "adapter_error") {
        next.consecutiveAdapterErrors = state.consecutiveAdapterErrors + 1;
        if (state.status === "active" && next.consecutiveAdapterErrors >= threshold) {
          next.status = "degraded";
          next.lastFailure = messageOf(event.outcome);
        } else if (state.status === "degraded") {
          next.lastFailure = messageOf(event.outcome);
        }
      }
      // access_denied, rate_limited, timeout, browser_unavailable, unsupported: no status change.
      break;
    }

    case "health_check": {
      if (!isServingStatus(state.status)) return unchanged(state);
      const { status } = event.outcome;
      if (status === "browser_unavailable") return unchanged(state);
      next.lastCheckedAt = event.at;
      if (status === "ok") {
        next.status = "active";
        next.lastFailure = null;
        next.consecutiveAdapterErrors = 0;
        if (state.status === "needs_login") {
          effects.clearCache = true;
          next.lastLoginConfirmedAt = event.at;
        }
      } else if (status === "auth_required") {
        next.status = "needs_login";
        next.lastFailure = messageOf(event.outcome);
        if (state.status !== "needs_login") effects.clearCache = true;
      } else {
        next.status = "degraded";
        next.lastFailure =
          status === "empty"
            ? "health check: the sample search returned no results"
            : messageOf(event.outcome);
      }
      break;
    }
  }

  const changed = !sameState(state, next);
  if (changed) next.updatedAt = event.at;
  return { state: changed ? next : state, effects, changed };
}

function unchanged(state: SiteRuntimeState): LifecycleTransition {
  return { state, effects: { ...NO_EFFECTS }, changed: false };
}

function sameState(a: SiteRuntimeState, b: SiteRuntimeState): boolean {
  return (
    a.status === b.status &&
    a.lastFailure === b.lastFailure &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.lastLoginConfirmedAt === b.lastLoginConfirmedAt &&
    a.consecutiveAdapterErrors === b.consecutiveAdapterErrors &&
    a.provisionalHostnames.length === b.provisionalHostnames.length &&
    a.provisionalHostnames.every((h, i) => h === b.provisionalHostnames[i])
  );
}

/** Parses one persisted state entry; null when it is malformed (the caller drops it). */
export function parseSiteRuntimeState(value: unknown): SiteRuntimeState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown): x is string => typeof x === "string";
  const strOrNull = (x: unknown): string | null => (str(x) ? x : null);
  if (!str(v["key"]) || !isLifecycleStatus(v["status"])) return null;
  const created = str(v["createdAt"]) ? v["createdAt"] : new Date(0).toISOString();
  const count = v["consecutiveAdapterErrors"];
  return {
    key: v["key"],
    status: v["status"],
    lastFailure: strOrNull(v["lastFailure"]),
    lastCheckedAt: strOrNull(v["lastCheckedAt"]),
    lastLoginConfirmedAt: strOrNull(v["lastLoginConfirmedAt"]),
    provisionalHostnames: Array.isArray(v["provisionalHostnames"])
      ? v["provisionalHostnames"].filter(str)
      : [],
    consecutiveAdapterErrors: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0,
    createdAt: created,
    updatedAt: str(v["updatedAt"]) ? v["updatedAt"] : created,
  };
}
