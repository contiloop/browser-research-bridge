/**
 * Ports for the site registry's persistence: the runtime state file `data/sites.json`
 * and the git auto-commit of `sites/<key>/`. Implemented in src/adapters/storage and src/adapters/git.
 */
import type { SiteRuntimeState } from "../core/lifecycle.js";

export interface SiteStateStore {
  /** Every persisted site entry (malformed entries are dropped); empty when the file does not exist. */
  load(): Promise<SiteRuntimeState[]>;
  /** Replaces the persisted list atomically. */
  save(sites: readonly SiteRuntimeState[]): Promise<void>;
}

export type SiteCommitAction = "add" | "repair" | "remove";

export interface SiteCommitResult {
  committed: boolean;
  /** Commit hash when committed. */
  commit?: string | undefined;
  /** Why nothing was committed ("disabled", "nothing to commit", "not a git repository", or the git error). */
  reason?: string | undefined;
}

export interface SiteCommitter {
  /** Commits only `sites/<key>/` with message `site: <action> <key>`; never throws. */
  commitSite(key: string, action: SiteCommitAction): Promise<SiteCommitResult>;
}
