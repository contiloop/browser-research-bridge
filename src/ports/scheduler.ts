/**
 * Browser work scheduler port (implemented by src/adapters/aside/scheduler.ts): a per-site pool of
 * concurrent tasks (exclusive tasks hold a site alone), a global cap on running tasks, FIFO within a
 * site, per-task politeness spacing with a short stagger between task starts on one site, and
 * cool-downs after `rate_limited`.
 */

export interface SiteTaskOptions {
  site: string;
  /**
   * Names the task for "site busy: …" timeout messages and `holders()`, e.g. "search", "fetch",
   * "health check", "repair running".
   */
  holder: string;
  /** How long to wait for a place on the site before failing with `timeout`. */
  acquireTimeoutMs: number;
  /** Minimum spacing between this task's page loads (manifest `minIntervalMs`). */
  minIntervalMs: number;
  signal?: AbortSignal | undefined;
  /**
   * Total time budget for the call (wait + task), e.g. the 90 s tool-call budget. On expiry the
   * lease signal aborts and `runForSite` rejects with `timeout`; the task keeps its place on the site
   * until it really settles.
   */
  budgetMs?: number | undefined;
  /** Runs even while the site is cooling down (e.g. a user-initiated "Check now"). */
  ignoreCooldown?: boolean | undefined;
  /**
   * Holds the site alone (default false: share the site's pool). An exclusive task waits until the
   * site's in-flight tasks finish, keeps later tasks of the site waiting from the moment it queues,
   * and never overlaps any task of its site. Used for helper/repair browser steps, real-site
   * validation, and health checks; tool calls and challenge attempts share the pool.
   */
  exclusive?: boolean | undefined;
}

export interface SiteLease {
  readonly site: string;
  /** Aborted when the caller's signal aborts or the lease is revoked. */
  readonly signal: AbortSignal;
  /**
   * Resolves once this task's politeness interval since its previous page load has elapsed (its first
   * load also waits for the site's start stagger). Other tasks' loads do not delay it.
   */
  beforePageLoad(): Promise<void>;
  /** The site's politeness interval for this lease. */
  readonly minIntervalMs?: number | undefined;
  /** Epoch ms at which this task's next page load may start (now or later). */
  nextPageLoadAt?(): number;
  /** Records a page load of this task that happened without `beforePageLoad` (e.g. inside a page script). */
  recordPageLoad?(atMs: number): void;
}

export interface Scheduler {
  /**
   * Runs `task` once the site has room for it (a pool place, or the whole site when `exclusive`).
   * Throws `OutcomeError("timeout", "site busy: …")` naming the holders when it cannot start within
   * `acquireTimeoutMs`, and `OutcomeError("rate_limited", …)` while the site cools down. A task that
   * fails with `rate_limited` starts the cool-down; no other outcome does.
   */
  runForSite<T>(options: SiteTaskOptions, task: (lease: SiteLease) => Promise<T>): Promise<T>;
  /** Holder names of the site's running tasks in start order; empty when none runs. */
  holders(site: string): string[];
  /** True when the site has no running task and no waiting one. */
  isIdle(site: string): boolean;
  /** Leaves the site alone until `untilMs` (epoch ms). */
  setCooldown(site: string, untilMs: number): void;
  /** Ends the site's cool-down now (e.g. when the site is removed). */
  clearCooldown(site: string): void;
  /** Epoch ms until which the site is cooling down, or null. */
  cooldownUntil(site: string): number | null;
}
