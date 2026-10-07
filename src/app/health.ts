/**
 * Health-check runner: runs the light validation of each serving
 * site (`active`, `needs_login`, `degraded`) daily (tunable) and on demand ("Check now"), only when
 * the site is idle in the scheduler, and feeds the outcome into the lifecycle: `auth_required` →
 * `needs_login` (with the login action), any other failure → `degraded` with the message, success →
 * `active` (clearing the site's cache when it recovers from `needs_login`). `browser_unavailable`
 * leaves the status alone; the check is retried at the next run.
 */
import { isServingStatus } from "../core/lifecycle.js";
import type { Outcome, SiteLifecycleStatus } from "../core/models.js";
import { errorToOutcome } from "../core/outcome.js";
import type { Clock } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { RegisteredSite } from "../ports/registry.js";
import type { Scheduler } from "../ports/scheduler.js";

/** The registry surface the health runner needs (implemented by `SiteRegistryService`). */
export interface HealthRegistry {
  list(): readonly RegisteredSite[];
  get(key: string): RegisteredSite | undefined;
  recordHealthCheck(key: string, outcome: Outcome): Promise<RegisteredSite>;
}

/** Runs the light validation of one site and returns its outcome (`ok` or a failure). */
export type HealthCheckFn = (
  key: string,
  options: { signal?: AbortSignal | undefined; ignoreCooldown: boolean },
) => Promise<Outcome>;

export interface HealthCheckerOptions {
  registry: HealthRegistry;
  scheduler: Pick<Scheduler, "isIdle" | "currentHolder" | "cooldownUntil">;
  check: HealthCheckFn;
  /** Time between checks of one site (`healthCheckIntervalSeconds`, default daily). */
  intervalMs: number;
  /** How often the timer looks for due sites (default: min(interval, 1 hour)). */
  tickMs?: number | undefined;
  /** Delay before the first timer pass after `start()` (default 60 s). */
  initialDelayMs?: number | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
}

export interface HealthRunResult {
  site: string;
  ran: boolean;
  /** Why the check did not run (busy, cooling down, not serving, already running, unknown site). */
  skipped?: string | undefined;
  outcome?: Outcome | undefined;
  /** Lifecycle status after the check. */
  status?: SiteLifecycleStatus | undefined;
}

export class HealthChecker {
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly initialDelayMs: number;
  private readonly running = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pass: Promise<HealthRunResult[]> | null = null;
  private stopped = true;

  constructor(private readonly options: HealthCheckerOptions) {
    this.clock = options.clock ?? systemClock;
    this.tickMs = Math.max(1000, options.tickMs ?? Math.min(options.intervalMs, 3_600_000));
    this.initialDelayMs = Math.max(0, options.initialDelayMs ?? 60_000);
  }

  /** Starts the daily timer (unref'd, so it never keeps the process alive). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True while a check of the site is in progress. */
  isChecking(key: string): boolean {
    return this.running.has(key);
  }

  /** Sites whose last check is older than the interval (or that were never checked). */
  dueSites(): string[] {
    const now = this.clock.now().getTime();
    return this.options.registry
      .list()
      .filter((s) => s.loadable && isServingStatus(s.status))
      .filter((s) => s.lastCheckedAt === null || now - Date.parse(s.lastCheckedAt) >= this.options.intervalMs)
      .map((s) => s.key);
  }

  /** One timer pass: checks every due, idle, not-cooling-down site, one after another. */
  runDue(): Promise<HealthRunResult[]> {
    this.pass ??= (async () => {
      const results: HealthRunResult[] = [];
      try {
        for (const key of this.dueSites()) {
          results.push(await this.runOne(key, false));
        }
      } finally {
        this.pass = null;
      }
      return results;
    })();
    return this.pass;
  }

  /** "Check now": runs the site's check immediately if it is idle (ignores the cool-down). */
  runNow(key: string): Promise<HealthRunResult> {
    return this.runOne(key, true);
  }

  private async runOne(key: string, onDemand: boolean): Promise<HealthRunResult> {
    const { registry, scheduler, logger } = this.options;
    const site = registry.get(key);
    if (!site) return { site: key, ran: false, skipped: "site not registered" };
    if (!site.loadable || !isServingStatus(site.status)) {
      return { site: key, ran: false, skipped: `site not ready: ${site.status}`, status: site.status };
    }
    if (this.running.has(key))
      return { site: key, ran: false, skipped: "a check is already running", status: site.status };
    if (!scheduler.isIdle(key)) {
      const holder = scheduler.currentHolder(key);
      return {
        site: key,
        ran: false,
        skipped: `site busy${holder ? `: ${holder}` : ""}`,
        status: site.status,
      };
    }
    if (!onDemand && scheduler.cooldownUntil(key) !== null) {
      return { site: key, ran: false, skipped: "site is cooling down", status: site.status };
    }
    this.running.add(key);
    try {
      let outcome: Outcome;
      try {
        outcome = await this.options.check(key, { ignoreCooldown: onDemand });
      } catch (error) {
        outcome = errorToOutcome(error);
      }
      const after = await registry.recordHealthCheck(key, outcome);
      logger?.info("health check finished", {
        site: key,
        outcome: outcome.status,
        status: after.status,
        onDemand,
      });
      return { site: key, ran: true, outcome, status: after.status };
    } finally {
      this.running.delete(key);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDue()
        .catch((error: unknown) => {
          this.options.logger?.error("health check pass failed", { error: (error as Error).message });
        })
        .finally(() => this.schedule(this.tickMs));
    }, delayMs);
    this.timer.unref?.();
  }
}
