/**
 * Browser work scheduler port (implemented by src/adapters/aside/scheduler.ts): one in-flight task per site (site lock),
 * a global cap on concurrently active sites, FIFO within a site, per-site politeness interval, and
 * cool-downs after `access_denied`/`rate_limited`.
 */

export interface SiteTaskOptions {
  site: string;
  /** Names the holder for "site busy: <holder>" timeout messages, e.g. "search", "repair running". */
  holder: string;
  /** How long to wait for the site lock before failing with `timeout`. */
  acquireTimeoutMs: number;
  /** Minimum spacing between page loads on this site (manifest `minIntervalMs`). */
  minIntervalMs: number;
  signal?: AbortSignal | undefined;
  /**
   * Total time budget for the call (lock wait + task), e.g. the 90 s tool-call budget. On expiry the
   * lease signal aborts and `runForSite` rejects with `timeout`; the site lock is released only once
   * the task settles.
   */
  budgetMs?: number | undefined;
  /** Runs even while the site is cooling down (e.g. a user-initiated "Check now"). */
  ignoreCooldown?: boolean | undefined;
}

export interface SiteLease {
  readonly site: string;
  /** Aborted when the caller's signal aborts or the lease is revoked. */
  readonly signal: AbortSignal;
  /** Resolves once the site's politeness interval since the previous page load has elapsed. */
  beforePageLoad(): Promise<void>;
  /** The site's politeness interval for this lease. */
  readonly minIntervalMs?: number | undefined;
  /** Epoch ms at which the next page load may start (now or later). */
  nextPageLoadAt?(): number;
  /** Records a page load that happened without `beforePageLoad` (e.g. inside a page script). */
  recordPageLoad?(atMs: number): void;
}

export interface Scheduler {
  /**
   * Runs `task` while holding the site's lock. Throws `OutcomeError("timeout", "site busy: <holder>")`
   * when the lock is not acquired within `acquireTimeoutMs`.
   */
  runForSite<T>(options: SiteTaskOptions, task: (lease: SiteLease) => Promise<T>): Promise<T>;
  /** Current lock holder's name, or null when the site is idle. */
  currentHolder(site: string): string | null;
  isIdle(site: string): boolean;
  /** Leaves the site alone until `untilMs` (epoch ms). */
  setCooldown(site: string, untilMs: number): void;
  /** Ends the site's cool-down now (e.g. when the site is removed). */
  clearCooldown(site: string): void;
  /** Epoch ms until which the site is cooling down, or null. */
  cooldownUntil(site: string): number | null;
}
