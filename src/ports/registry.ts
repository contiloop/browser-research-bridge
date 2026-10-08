/**
 * Site registry port, implemented by src/adapters/registry/registry.ts and consumed by the MCP
 * layer, the dashboard, and onboarding.
 */
import type { Outcome, SiteView } from "../core/models.js";
import type { SiteAdapter } from "./adapter.js";
import type { SiteManifest } from "./manifest.js";

/** A registered site in any lifecycle status (what `list_sites` shows). */
export interface RegisteredSite extends SiteView {
  name: string;
  requiresLogin: boolean;
  lastCheckedAt: string | null;
  /** Manifest present and validation passed. `onboarding`/`failed` sites are not loadable. */
  loadable: boolean;
}

export interface LoadedSiteAdapter {
  key: string;
  manifest: SiteManifest;
  adapter: SiteAdapter;
  /** Version stamp of the loaded module; changes after `reload`. */
  version: string;
}

/** A live search/read outcome fed into the lifecycle. */
export interface LiveOutcome extends Outcome {
  /** The adapter flagged a block/captcha page (`blocked: true` in its response). It does not start a cool-down; only `rate_limited` does. */
  blocked?: boolean | undefined;
}

export interface SiteRegistry {
  /** All registered sites, alphabetical by key. */
  list(): readonly RegisteredSite[];
  get(key: string): RegisteredSite | undefined;
  /** The site that owns the hostname (`www.`-insensitive), if any. */
  findByHostname(hostname: string): RegisteredSite | undefined;
  /** The loaded adapter, or undefined when the site is unknown or not loadable. */
  load(key: string): Promise<LoadedSiteAdapter | undefined>;
  /** Feeds a live search/read outcome into the lifecycle. */
  recordOutcome(key: string, outcome: LiveOutcome): Promise<void>;
  /** Re-imports the site's adapter after a swap (the only hot-reload path). */
  reload(key: string): Promise<void>;
}
