/** `list_sites`: every registered site in every lifecycle status. */
import type { SiteCapabilities, SiteLifecycleStatus } from "../../core/models.js";
import { lifecycleToOutcome } from "../../core/targets.js";
import type { RegisteredSite } from "../../ports/registry.js";

export interface ListedSite {
  key: string;
  name: string;
  hostnames: string[];
  status: SiteLifecycleStatus;
  requiresLogin: boolean;
  loginUrl: string | null;
  capabilities: SiteCapabilities;
  lastCheckedAt: string | null;
  message?: string | undefined;
  action?: string | undefined;
}

export interface ListSitesOutput {
  sites: ListedSite[];
}

export function listSites(registry: { list(): readonly RegisteredSite[] }): ListSitesOutput {
  return {
    sites: registry.list().map((site) => {
      const listed: ListedSite = {
        key: site.key,
        name: site.name,
        hostnames: [...site.hostnames],
        status: site.status,
        requiresLogin: site.requiresLogin,
        loginUrl: site.loginUrl,
        capabilities: { ...site.capabilities },
        lastCheckedAt: site.lastCheckedAt,
      };
      const outcome = lifecycleToOutcome(site);
      if (outcome?.message !== undefined) listed.message = outcome.message;
      if (outcome?.action !== undefined) listed.action = outcome.action;
      return listed;
    }),
  };
}
