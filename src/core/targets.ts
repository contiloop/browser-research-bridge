/** Site targeting and the lifecycle → outcome mapping. */
import { resolveSiteQualifier } from "./ids.js";
import type { SiteStatusEntry, SiteView } from "./models.js";
import { loginAction } from "./outcome.js";

export const REPAIR_ACTION = "Repair in the dashboard";
export const ONBOARDING_MESSAGE = "onboarding in progress";

/** Status entry for a site that is not searched because of its lifecycle status; null for `active`. */
export function lifecycleToOutcome(site: SiteView): SiteStatusEntry | null {
  switch (site.status) {
    case "active":
      return null;
    case "needs_login":
      return {
        site: site.key,
        status: "auth_required",
        message: "login required or session expired",
        action: loginAction(site.key, site.loginUrl),
      };
    case "degraded":
      return {
        site: site.key,
        status: "adapter_error",
        message: site.lastFailure ?? "site adapter is degraded",
        action: REPAIR_ACTION,
      };
    case "failed":
      return { site: site.key, status: "adapter_error", message: site.lastFailure ?? "onboarding failed" };
    case "onboarding":
      return { site: site.key, status: "unsupported", message: ONBOARDING_MESSAGE };
  }
}

export interface SearchTargetPlan {
  /** Sites to search, alphabetical. */
  targets: string[];
  /** Entries for non-searched registered sites (alphabetical), then unknown `site:` values (input order). */
  statuses: SiteStatusEntry[];
  /** `site:` values that matched no registered site. */
  unknown: string[];
}

/**
 * Target sites = the `site:` set, else every `active` site. Non-active sites are never searched and
 * get their lifecycle entry; active sites without the search capability get `unsupported`. Unknown
 * `site:` values are reported as `unsupported` and ignored; if the caller named sites but none resolved,
 * nothing is searched (the caller asked for specific sites, not for everything).
 */
export function planSearchTargets(
  sites: readonly SiteView[],
  requested: readonly string[] | null,
): SearchTargetPlan {
  const sorted = [...sites].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const named = new Set<string>();
  const unknown: string[] = [];
  for (const value of requested ?? []) {
    const key = resolveSiteQualifier(value, sorted);
    if (key !== null) named.add(key);
    else if (!unknown.includes(value)) unknown.push(value);
  }
  const requestedAny = (requested ?? []).length > 0;
  const considered = requestedAny ? sorted.filter((s) => named.has(s.key)) : sorted;

  const targets: string[] = [];
  const statuses: SiteStatusEntry[] = [];
  for (const site of considered) {
    const entry = lifecycleToOutcome(site);
    if (entry !== null) statuses.push(entry);
    else if (!site.capabilities.search) {
      statuses.push({
        site: site.key,
        status: "unsupported",
        message: "search is not supported by this site",
      });
    } else targets.push(site.key);
  }
  for (const value of unknown) {
    statuses.push({ site: value, status: "unsupported", message: `unknown site: ${value}` });
  }
  return { targets, statuses, unknown };
}

/**
 * Read-side gate: unregistered → `unsupported`; registered but not loadable (`onboarding`, `failed`)
 * → `unsupported` "site not ready: <status>"; read capability absent → `unsupported`; otherwise null
 * (attempt the read, including `needs_login` and `degraded` sites).
 */
export function readTargetOutcome(site: SiteView | undefined, key = ""): SiteStatusEntry | null {
  if (site === undefined) return { site: key, status: "unsupported", message: `site not registered: ${key}` };
  if (site.status === "onboarding" || site.status === "failed") {
    return { site: site.key, status: "unsupported", message: `site not ready: ${site.status}` };
  }
  if (!site.capabilities.read) {
    return { site: site.key, status: "unsupported", message: "read is not supported by this site" };
  }
  return null;
}
