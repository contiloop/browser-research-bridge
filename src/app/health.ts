/**
 * Health-check runner: runs the light validation of each serving
 * site (`active`, `needs_login`, `degraded`) daily (tunable) and on demand ("Check now"), only when
 * the site is idle in the scheduler (no running or waiting task; the check itself then holds the site
 * alone, see the validator's light form), and feeds the outcome into the lifecycle: `auth_required` →
 * `needs_login` (with the login action), any other failure → `degraded` with the message, success →
 * `active` (clearing the site's cache when it recovers from `needs_login`). `browser_unavailable`
 * leaves the status alone; the check is retried at the next run.
 *
 * "Check now" only: when the light check meets a block or captcha page and captcha attempts are on,
 * one quick challenge attempt runs (a pool task, after the check's exclusive task ended). When it
 * acted or found the check gone, the light check runs once more and the second result sets the status
 * (with the captcha action when it is still blocked, and the solver's fixed message added to the
 * failure message, so the site card shows why). When it is captcha-limited (nothing it can act on, or
 * no solver), the second check is skipped and the first result stands with the captcha-limited
 * sentence as message and action. Scheduled checks never attempt.
 *
 * The Aside AI (`assistant`, the assistant task coordinator of src/adapters/mcp/assistant-tasks.ts):
 * "Check now" first clears the site's assistant pause and hold. A scheduled check or "Check now" that
 * finds `auth_required` starts a login task in the background (the result carries its sentence) and
 * leaves the re-check to `confirmLogin`, which the coordinator calls after the task reported `done`:
 * the light check once more, waiting for the site's exclusive slot within the check's own bounded wait
 * (no idle precondition), recorded like a health check, with no captcha attempt and no new task. A
 * check that found no place in time (busy) or a site cooling down records nothing.
 */
import { isServingStatus } from "../core/lifecycle.js";
import type { Outcome, SiteLifecycleStatus } from "../core/models.js";
import { errorToOutcome, isBlockedError, isFailureStatus } from "../core/outcome.js";
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

/** A light check's outcome; `blocked` when it failed on a block or captcha page. */
export interface HealthCheckOutcome extends Outcome {
  /**
   * The page the block was met on: a read's URL, else the page the adapter's session last showed (a
   * search page); null when unknown (the attempt then targets the homepage).
   */
  blocked?: { url: string | null } | undefined;
}

/** Runs the light validation of one site and returns its outcome (`ok` or a failure). */
export type HealthCheckFn = (
  key: string,
  options: { signal?: AbortSignal | undefined; ignoreCooldown: boolean },
) => Promise<HealthCheckOutcome>;

/** The challenge coordinator as "Check now" uses it (src/adapters/mcp/challenge.ts). */
export interface HealthChallenges {
  readonly enabled: boolean;
  /**
   * One quick attempt (or the site's running one); `ran` false when there is nothing to re-check.
   * `limited`: captcha-limited, `action` is then the captcha-limited sentence. `message` is the solver's
   * fixed text (never page content), absent when no solver ran.
   */
  attempt(
    key: string,
    url: string | null,
  ): Promise<{
    ran: boolean;
    limited?: boolean | undefined;
    result?: string;
    action: string;
    message?: string | undefined;
  }>;
}

/** The assistant task coordinator as the health runner uses it (src/adapters/mcp/assistant-tasks.ts). */
export interface HealthAssistant {
  /** "Check now": the site's assistant pause and hold end. */
  clearHold(key: string): void;
  /**
   * Starts a login task in the background when the rules allow; the sentence for the result (the AI is
   * logging in now, or why the user must act), or null (today's action).
   */
  login(key: string, request: { url: string | null; trigger: string }): Promise<string | null>;
}

export interface HealthCheckerOptions {
  registry: HealthRegistry;
  scheduler: Pick<Scheduler, "isIdle" | "holders" | "cooldownUntil">;
  check: HealthCheckFn;
  /** Time between checks of one site (`healthCheckIntervalSeconds`, default daily). */
  intervalMs: number;
  /** How often the timer looks for due sites (default: min(interval, 1 hour)). */
  tickMs?: number | undefined;
  /** Delay before the first timer pass after `start()` (default 60 s). */
  initialDelayMs?: number | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
  /** Captcha attempts for "Check now"; absent → none. */
  challenges?: HealthChallenges | undefined;
  /** Aside AI login tasks after a check found `auth_required`; absent → none. */
  assistant?: HealthAssistant | undefined;
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
          results.push(await this.withLoginTask(await this.runOne(key, false), "health check"));
        }
      } finally {
        this.pass = null;
      }
      return results;
    })();
    return this.pass;
  }

  /**
   * "Check now": clears the site's assistant pause and hold, then runs the site's check immediately if
   * it is idle (ignores the cool-down).
   */
  async runNow(key: string): Promise<HealthRunResult> {
    this.options.assistant?.clearHold(key);
    return this.withLoginTask(await this.runOne(key, true), "check now");
  }

  /**
   * After an Aside AI login task reported `done`: the light check once more, for a serving site that is
   * not already being checked and not cooling down, without waiting for the site to be idle (the check
   * waits for its exclusive slot within its own bounded wait). Recorded like a health check (a pass →
   * `active`; `auth_required` keeps `needs_login`), except that a check that got no place in time
   * (busy), met a cool-down, or was stopped by `signal` (core stop) records nothing. No captcha
   * attempt, no assistant task.
   */
  async confirmLogin(key: string, signal?: AbortSignal): Promise<HealthRunResult> {
    const { registry, scheduler, logger } = this.options;
    const site = registry.get(key);
    if (!site) return { site: key, ran: false, skipped: "site not registered" };
    if (!site.loadable || !isServingStatus(site.status)) {
      return { site: key, ran: false, skipped: `site not ready: ${site.status}`, status: site.status };
    }
    if (this.running.has(key))
      return { site: key, ran: false, skipped: "a check is already running", status: site.status };
    if (scheduler.cooldownUntil(key) !== null) {
      return { site: key, ran: false, skipped: "site is cooling down", status: site.status };
    }
    this.running.add(key);
    try {
      let checked: HealthCheckOutcome;
      try {
        checked = await this.options.check(key, { signal, ignoreCooldown: false });
      } catch (error) {
        checked = errorToOutcome(error);
      }
      const outcome = withoutBlocked(checked);
      if (signal?.aborted === true) {
        return {
          site: key,
          ran: false,
          skipped: "stopped",
          status: registry.get(key)?.status ?? site.status,
        };
      }
      const busy = busyMessage(outcome);
      if (busy !== null || outcome.status === "rate_limited") {
        const skipped = busy ?? "site is cooling down";
        logger?.info("login confirmation skipped", { site: key, outcome: outcome.status });
        return { site: key, ran: false, skipped, status: registry.get(key)?.status ?? site.status };
      }
      const after = await registry.recordHealthCheck(key, outcome);
      logger?.info("health check finished", {
        site: key,
        outcome: outcome.status,
        status: after.status,
        onDemand: false,
        trigger: "login confirmation",
      });
      return { site: key, ran: true, outcome, status: after.status };
    } finally {
      this.running.delete(key);
    }
  }

  /** A check that found `auth_required` starts a login task; its sentence becomes the result's action. */
  private async withLoginTask(result: HealthRunResult, trigger: string): Promise<HealthRunResult> {
    const assistant = this.options.assistant;
    if (assistant === undefined || result.outcome?.status !== "auth_required") return result;
    const action = await assistant.login(result.site, { url: null, trigger });
    return action === null ? result : { ...result, outcome: { ...result.outcome, action } };
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
      const holders = scheduler.holders(key);
      return {
        site: key,
        ran: false,
        skipped: `site busy${holders.length > 0 ? `: ${holders.join(", ")}` : ""}`,
        status: site.status,
      };
    }
    if (!onDemand && scheduler.cooldownUntil(key) !== null) {
      return { site: key, ran: false, skipped: "site is cooling down", status: site.status };
    }
    this.running.add(key);
    try {
      const check = async (): Promise<HealthCheckOutcome> => {
        try {
          return await this.options.check(key, { ignoreCooldown: onDemand });
        } catch (error) {
          // A thrown blocked failure is a block page whose URL is unknown (the attempt aims at the homepage).
          const outcome: HealthCheckOutcome = errorToOutcome(error);
          if (isBlockedError(error)) outcome.blocked = { url: null };
          return outcome;
        }
      };
      let checked = await check();
      const challenges = this.options.challenges;
      if (onDemand && challenges?.enabled === true && isChallenge(checked)) {
        // The check's exclusive task has ended; the attempt is a pool task of the site.
        const report = await challenges.attempt(key, checked.blocked?.url ?? null);
        const limited = report.limited === true;
        const recheck = report.ran && !limited;
        if (recheck) checked = await check();
        logger?.info("check now captcha attempt", {
          site: key,
          attempt: report.result ?? null,
          limited,
          rechecked: recheck,
          outcome: checked.status,
          message: report.message ?? null,
        });
        if (limited) {
          // The first result stands, with the captcha-limited sentence the site card shows.
          checked = { ...checked, message: report.action, action: report.action };
        } else if (!report.ran || isChallenge(checked)) {
          const detail = report.result === "solved" ? undefined : report.message;
          checked = {
            ...checked,
            action: report.action,
            ...(detail !== undefined && detail !== ""
              ? { message: `${checked.message ?? checked.status} (captcha attempt: ${detail})` }
              : {}),
          };
        }
      }
      const outcome = withoutBlocked(checked);
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

/** A blocked failure the solver may help with; a throttle page (`rate_limited`) is left alone. */
function isChallenge(outcome: HealthCheckOutcome): boolean {
  return (
    outcome.blocked !== undefined && isFailureStatus(outcome.status) && outcome.status !== "rate_limited"
  );
}

/** "site busy: …" / "browser busy: …" when the check got no place on the site in time; else null. */
function busyMessage(outcome: Outcome): string | null {
  if (outcome.status !== "timeout") return null;
  const match = /\b(?:site|browser) busy\b.*$/.exec(outcome.message ?? "");
  return match === null ? null : match[0];
}

function withoutBlocked(outcome: HealthCheckOutcome): Outcome {
  const { blocked: _blocked, ...rest } = outcome;
  return rest;
}
