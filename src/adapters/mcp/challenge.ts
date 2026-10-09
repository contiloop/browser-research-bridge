/**
 * Challenge (captcha) attempts after an adapter reported a block page (`blocked: true`).
 *
 * The coordinator runs the browser port's solver (`BrowserPort.solveChallenge`) for one site at a time:
 *
 * - one attempt in flight per site: a caller that meets a challenge while an attempt runs (inline or in
 *   the background) joins it and waits at most its own budget; attempts never run in parallel on a site;
 *   `join` only joins (a tool call that already had its attempt for the site starts no second one);
 * - an attempt is a shared pool task of the site in the scheduler (holder `captcha`, never exclusive),
 *   so it respects the site's pool and politeness, with the site's browser scope (manifest `hostnames`
 *   ∪ `extraAllowedHosts`, like every other session of the site);
 * - it targets the page the caller names (the failed read's URL, else the page the adapter's browser
 *   session last showed, which for a search is the site's search page), else the site's homepage;
 * - background attempts (fire and forget, logged) run when a tool call has too little budget left;
 * - an attempt is abandoned when its site is removed (checked before it starts and polled while it
 *   runs, since the registry has no removal hook) or when the core stops (`dispose`); the port then
 *   ends the attempt and restores or closes its tab.
 *
 * Every attempt is a quick one: the port gets a detection budget (`captchaDetectBudgetMs`, clipped to
 * the port's own budget) that starts once the scheduler slot is held and covers the politeness wait,
 * the widened reload, the interstitial wait, and detection. Only when it detected something it can act
 * on do action rounds use the rest of the attempt budget. An attempt that did not act on the page —
 * `kind: "unknown"` with `rounds: 0` (nothing recognized, or detection not finished in time), or no
 * solver at all (`unavailable`) — is captcha-limited (`limited: true`): the caller answers at once,
 * without a re-run. Nothing about a site is remembered between attempts.
 *
 * The solver never declares success: a report with `ran: true` only tells the caller to re-run its own
 * adapter call once, and only that re-run (`ok`/`empty`) confirms the challenge is gone. The report
 * carries the solver's fixed message (never page content), and the action for an unsolved attempt
 * names it. Logs carry metadata only (site, kind, rounds, result, duration, that fixed message); the
 * port logs its own `captcha attempt` line when it runs, the coordinator logs one when the attempt
 * could not reach the port.
 */
import {
  DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS,
  DEFAULT_CAPTCHA_DETECT_BUDGET_MS,
  DEFAULT_CAPTCHA_RERUN_RESERVE_MS,
} from "../../core/defaults.js";
import type { FailureStatus } from "../../core/models.js";
import { errorToOutcome } from "../../core/outcome.js";
import { DEFAULT_CAPTCHA_AUTO } from "../../core/settings.js";
import type { BrowserPort, ChallengeAttempt, ChallengeKind } from "../../ports/browser.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { Scheduler } from "../../ports/scheduler.js";

/** Scheduler holder name of a challenge attempt ("site busy: … (search, captcha)"). */
export const CAPTCHA_HOLDER = "captcha";

/** How often a running attempt checks that its site is still registered. */
export const DEFAULT_REMOVAL_POLL_MS = 1000;

/** Part of an attempt's budget kept back for the port to restore the tab after its own budget ran out. */
export const RESTORE_MARGIN_MS = 2000;

/** The report's message when the browser port has no solver at all. */
export const NO_SOLVER_MESSAGE = "captcha solving is not available in this browser";

/** `config.captcha.auto` and the captcha tunables (names match `config/bridge.json`). */
export interface ChallengeSettings {
  /** Attempts on (`captcha.auto`). Off: no attempt anywhere; behavior as before. */
  auto: boolean;
  /** Time one attempt may take (`captchaAttemptBudgetMs`). */
  attemptBudgetMs: number;
  /**
   * Detection budget of an attempt (`captchaDetectBudgetMs`), from the moment the port's attempt starts
   * (after the scheduler slot) through the reload, the interstitial wait, and detection; clipped to the
   * attempt's budget. An inline attempt also needs this plus `rerunReserveMs` of the tool call left.
   */
  detectBudgetMs: number;
  /** Tool-call budget kept back for the re-run after an attempt (`captchaRerunReserveMs`). */
  rerunReserveMs: number;
}

export const DEFAULT_CHALLENGE_SETTINGS: Readonly<ChallengeSettings> = Object.freeze({
  auto: DEFAULT_CAPTCHA_AUTO,
  attemptBudgetMs: DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS,
  detectBudgetMs: DEFAULT_CAPTCHA_DETECT_BUDGET_MS,
  rerunReserveMs: DEFAULT_CAPTCHA_RERUN_RESERVE_MS,
});

/** What the attempt amounted to, for logs: the solver's own word, never proof. */
export type ChallengeResult = "solved" | "unsolved" | "unavailable";

export interface ChallengeReport {
  /**
   * The solver acted on the page, found the check gone (`kind: "none"`), or met a kind it can act on:
   * the caller re-runs its adapter call once. False when it is captcha-limited (`limited`) or nothing
   * was done (setting off, refused or failed before or during the page work).
   */
  ran: boolean;
  /**
   * Captcha-limited: the attempt could not act on this check — `kind: "unknown"` with `rounds: 0`
   * (nothing recognized, or detection not finished in time) or no solver (`unavailable`). The caller
   * answers at once with `access_denied` and `action` (the captcha-limited sentence), no re-run.
   */
  limited: boolean;
  result: ChallengeResult;
  kind: ChallengeKind;
  rounds: number;
  /** The page the attempt targeted: the failed read's URL, the adapter's last page, or the homepage. */
  url: string;
  /**
   * The action for a failure that is still blocked: open `url` in Aside and solve it by hand (naming
   * the solver's message when the attempt did not report `solved`); for a captcha-limited report the
   * captcha-limited sentence, which is also the failure's message.
   */
  action: string;
  /**
   * The solver's own message (e.g. "text captcha: no vision model is configured in Aside"), one of its
   * fixed texts and never page content; absent when no solver ran.
   */
  message?: string | undefined;
  /** Why the attempt did not run to the end (`timeout`, `rate_limited`, `browser_unavailable`, …). */
  error?: FailureStatus | undefined;
}

export interface ChallengeAttemptOptions {
  /** Time for the attempt (or for waiting on the site's running one); default `attemptBudgetMs`. */
  budgetMs?: number | undefined;
  /** The caller's own signal: it stops waiting (the attempt itself goes on for the next call). */
  signal?: AbortSignal | undefined;
}

/** What the tool services and the health checker use. */
export interface ChallengeGate {
  readonly enabled: boolean;
  readonly settings: Readonly<ChallengeSettings>;
  /** The page an attempt for this failure targets (`url`, else the site's homepage). */
  challengeUrl(key: string, url: string | null): string;
  /** Runs the site's attempt now, or joins the one in flight. Never throws. */
  attempt(key: string, url: string | null, options?: ChallengeAttemptOptions): Promise<ChallengeReport>;
  /**
   * Joins the site's attempt in flight like `attempt`, or returns null when none runs (starting none):
   * for a tool call that already had its one attempt for the site. Never throws.
   */
  join(key: string, url: string | null, options?: ChallengeAttemptOptions): Promise<ChallengeReport> | null;
  /** Starts a background attempt unless one is in flight for the site; true when one was started. */
  background(key: string, url: string | null): boolean;
  /**
   * The report of the site's attempt in flight once it has ended (the port's work included), or null
   * at once when none runs. Joins nothing and starts nothing; never rejects. The assistant's captcha
   * task waits for it, so it starts only after the bridge's own attempt is known.
   */
  whenSettled(key: string): Promise<ChallengeReport | null>;
}

/** Where an attempt runs when a tool call meets a challenge with `remainingMs` of its budget left. */
export type ChallengePlan = { mode: "inline"; budgetMs: number } | { mode: "background" };

/**
 * Inline only with at least `detectBudgetMs + rerunReserveMs` left, for `min(attemptBudgetMs,
 * remaining − rerunReserveMs)` (the slot wait included); otherwise (or when that leaves no time) the
 * failure is answered at once and the attempt runs in the background.
 */
export function planChallenge(settings: ChallengeSettings, remainingMs: number): ChallengePlan {
  if (remainingMs < settings.detectBudgetMs + settings.rerunReserveMs) return { mode: "background" };
  const budgetMs = Math.min(settings.attemptBudgetMs, remainingMs - settings.rerunReserveMs);
  return budgetMs > 0 ? { mode: "inline", budgetMs } : { mode: "background" };
}

/** The re-run starts only while the reserve is still there. */
export function canRerun(settings: ChallengeSettings, remainingMs: number): boolean {
  return remainingMs >= settings.rerunReserveMs;
}

/**
 * The action for a challenge that is still there. `detail` is the solver's fixed message when it did
 * not report `solved` (e.g. "text captcha: no vision model is configured in Aside").
 */
export function captchaUnsolvedAction(url: string, detail?: string): string {
  const why = detail !== undefined && detail !== "" ? ` (${detail})` : "";
  return `The captcha could not be solved automatically${why}. Open ${url} in Aside, solve it, then retry`;
}

/**
 * The answer for a check the solver cannot act on (captcha-limited); it is both the failure's message
 * and its action.
 */
export function captchaLimitedAction(site: string, url: string): string {
  return `${site} is captcha-limited: its bot check cannot be solved automatically. Open ${url} in Aside, solve it, then retry`;
}

/** The solver message worth showing with a failure: none after a reported `solved` (only the re-run judges). */
function unsolvedDetail(report: Pick<ChallengeReport, "result" | "message">): string | undefined {
  return report.result === "solved" ? undefined : report.message;
}

/** The action of a report for the page `url`. */
function actionFor(
  key: string,
  url: string,
  report: Pick<ChallengeReport, "limited" | "result" | "message">,
): string {
  return report.limited ? captchaLimitedAction(key, url) : captchaUnsolvedAction(url, unsolvedDetail(report));
}

/**
 * Captcha-limited: the attempt did not act on the check. `kind: "unknown"` with `rounds: 0` covers
 * "nothing recognized" and "detection did not finish in time".
 */
function isLimited(attempt: Pick<ChallengeAttempt, "available" | "kind" | "rounds">): boolean {
  return !attempt.available || (attempt.kind === "unknown" && attempt.rounds === 0);
}

/** The site's homepage: `https://<first hostname>/`. */
export function siteHomepage(hostnames: readonly string[]): string | null {
  const host = hostnames[0];
  return host === undefined ? null : `https://${host}/`;
}

/**
 * Browser scope of a site, as every other session of the site gets it (the same rule as the registry's
 * `browserHostnames`, which this module may not import: hostnames ∪ extraAllowedHosts).
 */
function scopeHostnames(manifest: Pick<SiteManifest, "hostnames" | "extraAllowedHosts">): string[] {
  return [...new Set([...manifest.hostnames, ...(manifest.extraAllowedHosts ?? [])])];
}

export interface ChallengeCoordinatorOptions {
  settings: ChallengeSettings;
  /** `solveChallenge` is optional on the port; without it every attempt is `unavailable`. */
  browser: Pick<BrowserPort, "solveChallenge">;
  scheduler: Pick<Scheduler, "runForSite">;
  /** Site lookup (the registry): presence and hostnames, and the manifest for scope and politeness. */
  registry: {
    get(key: string): { hostnames: readonly string[] } | undefined;
    load(key: string): Promise<{ manifest: SiteManifest } | undefined>;
  };
  logger: Logger;
  clock?: Clock | undefined;
  /** How often a running attempt checks that its site is still registered (default 1 s). */
  removalPollMs?: number | undefined;
}

interface Flight {
  /** The attempt's report (resolves when the attempt ends or its budget is spent). */
  promise: Promise<ChallengeReport>;
  /** Resolves once the port's work has really ended; the site's slot is held until then. */
  done: Promise<void>;
  controller: AbortController;
}

/** The port call of an attempt, which may outlive the report by its restore. */
interface PortWork {
  task: Promise<unknown> | null;
  settled: boolean;
}

export class ChallengeCoordinator implements ChallengeGate {
  readonly settings: Readonly<ChallengeSettings>;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly flights = new Map<string, Flight>();
  private disposed = false;

  constructor(private readonly options: ChallengeCoordinatorOptions) {
    this.settings = Object.freeze({ ...options.settings });
    this.clock = options.clock ?? systemClock;
    this.pollMs = Math.max(1, options.removalPollMs ?? DEFAULT_REMOVAL_POLL_MS);
  }

  get enabled(): boolean {
    return this.settings.auto && !this.disposed;
  }

  challengeUrl(key: string, url: string | null): string {
    if (url !== null) return url;
    return siteHomepage(this.options.registry.get(key)?.hostnames ?? []) ?? key;
  }

  /** True while an attempt runs for the site. */
  inFlight(key: string): boolean {
    return this.flights.has(key);
  }

  async attempt(
    key: string,
    url: string | null,
    options: ChallengeAttemptOptions = {},
  ): Promise<ChallengeReport> {
    const target = this.challengeUrl(key, url);
    if (!this.enabled) return this.report(key, target, { ran: false, result: "unsolved" });
    const budgetMs = Math.max(0, options.budgetMs ?? this.settings.attemptBudgetMs);
    const running = this.flights.get(key);
    if (running !== undefined) {
      this.options.logger.debug("joining the running captcha attempt", { site: key });
      return this.wait(key, running.promise, target, budgetMs, options.signal);
    }
    return this.wait(
      key,
      this.start(key, target, budgetMs, "inline").promise,
      target,
      Infinity,
      options.signal,
    );
  }

  join(
    key: string,
    url: string | null,
    options: ChallengeAttemptOptions = {},
  ): Promise<ChallengeReport> | null {
    if (!this.enabled) return null;
    const running = this.flights.get(key);
    if (running === undefined) return null;
    this.options.logger.debug("joining the running captcha attempt", { site: key });
    const budgetMs = Math.max(0, options.budgetMs ?? this.settings.attemptBudgetMs);
    return this.wait(key, running.promise, this.challengeUrl(key, url), budgetMs, options.signal);
  }

  background(key: string, url: string | null): boolean {
    if (!this.enabled || this.flights.has(key) || this.options.registry.get(key) === undefined) return false;
    this.options.logger.info("captcha attempt started in the background", { site: key });
    this.start(key, this.challengeUrl(key, url), this.settings.attemptBudgetMs, "background");
    return true;
  }

  whenSettled(key: string): Promise<ChallengeReport | null> {
    const flight = this.flights.get(key);
    if (flight === undefined) return Promise.resolve(null);
    return flight.promise.then(
      async (report) => {
        await flight.done;
        return report;
      },
      () => null,
    );
  }

  /** Resolves when every attempt in flight has ended (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.flights.size > 0) {
      await Promise.all([...this.flights.values()].map((f) => f.done));
    }
  }

  /** Core stop: abandons every running attempt and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    for (const flight of this.flights.values()) flight.controller.abort();
  }

  private start(key: string, url: string, budgetMs: number, mode: "inline" | "background"): Flight {
    const controller = new AbortController();
    const work: PortWork = { task: null, settled: true };
    const release = (): void => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    // The flight leaves with its report unless the port is still at work (a task that outlived its
    // budget while restoring the tab); then it stays until the port is done, so attempts never overlap.
    const promise = this.run(key, url, budgetMs, mode, controller, work).then((report) => {
      if (work.settled) release();
      return report;
    });
    const done = promise
      .then(() => work.task)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(release);
    const flight: Flight = { promise, done, controller };
    this.flights.set(key, flight);
    return flight;
  }

  /** One attempt; never throws. */
  private async run(
    key: string,
    url: string,
    budgetMs: number,
    mode: "inline" | "background",
    controller: AbortController,
    work: PortWork,
  ): Promise<ChallengeReport> {
    const { browser, scheduler, registry, logger } = this.options;
    const started = this.clock.now().getTime();
    const log = (fields: { result: ChallengeResult; error?: FailureStatus; message?: string }): void => {
      const line: LogFields = {
        site: key,
        kind: "unknown",
        rounds: 0,
        result: fields.result,
        durationMs: this.clock.now().getTime() - started,
        mode,
      };
      if (fields.message !== undefined) line["message"] = fields.message;
      if (fields.error !== undefined) line["error"] = fields.error;
      logger.info("captcha attempt", line);
    };
    // The site is gone (removed) → the attempt is abandoned.
    const poll = setInterval(() => {
      if (registry.get(key) === undefined) controller.abort();
    }, this.pollMs);
    poll.unref?.();
    let portCalled = false;
    try {
      const loaded = registry.get(key) === undefined ? undefined : await registry.load(key);
      if (loaded === undefined || controller.signal.aborted) {
        log({ result: "unsolved", error: "unsupported" });
        return this.report(key, url, { ran: false, result: "unsolved", error: "unsupported" });
      }
      const solve = browser.solveChallenge;
      if (typeof solve !== "function") {
        log({ result: "unavailable", message: NO_SOLVER_MESSAGE });
        return this.report(key, url, {
          ran: false,
          limited: true,
          result: "unavailable",
          message: NO_SOLVER_MESSAGE,
        });
      }
      const { manifest } = loaded;
      const attempt: ChallengeAttempt = await scheduler.runForSite(
        {
          site: key,
          holder: CAPTCHA_HOLDER,
          acquireTimeoutMs: budgetMs,
          minIntervalMs: manifest.minIntervalMs,
          signal: controller.signal,
          budgetMs,
        },
        (lease) => {
          portCalled = true;
          // The slot is held: what the wait left is the port's budget; the detection budget starts now,
          // whole, and is clipped to that budget.
          const left = budgetMs - (this.clock.now().getTime() - started);
          // Leave the port time to restore the tab inside the task's budget when there is room for it.
          const solveBudgetMs = Math.max(0, left > 2 * RESTORE_MARGIN_MS ? left - RESTORE_MARGIN_MS : left);
          const task = solve.call(browser, {
            scope: { siteKey: key, hostnames: scopeHostnames(manifest), signal: lease.signal, lease },
            url,
            budgetMs: solveBudgetMs,
            detectBudgetMs: Math.max(0, Math.min(this.settings.detectBudgetMs, solveBudgetMs)),
          });
          work.settled = false;
          // Tracks only when the port is done; its failure reaches the caller through `task`.
          work.task = task.then(
            () => {
              work.settled = true;
            },
            () => {
              work.settled = true;
            },
          );
          return task;
        },
      );
      if (!attempt.available)
        return this.report(key, url, {
          ran: false,
          limited: true,
          result: "unavailable",
          kind: attempt.kind,
          message: attempt.message,
        });
      const limited = isLimited(attempt);
      return this.report(key, url, {
        ran: !limited,
        limited,
        result: attempt.solved ? "solved" : "unsolved",
        kind: attempt.kind,
        rounds: attempt.rounds,
        message: attempt.message,
      });
    } catch (error) {
      const status = errorToOutcome(error).status;
      // The port logs its own line for an attempt it ran; a refusal before the port is logged here.
      if (!portCalled) log({ result: "unsolved", error: status });
      return this.report(key, url, { ran: false, result: "unsolved", error: status });
    } finally {
      clearInterval(poll);
    }
  }

  /**
   * The flight's report for this caller's page, or a timeout report once `budgetMs` passes or the
   * caller's signal aborts.
   */
  private wait(
    key: string,
    promise: Promise<ChallengeReport>,
    url: string,
    budgetMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ChallengeReport> {
    const timedOut = (): ChallengeReport =>
      this.report(key, url, { ran: false, result: "unsolved", error: "timeout" });
    if (signal?.aborted) return Promise.resolve(timedOut());
    return new Promise<ChallengeReport>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (report: ChallengeReport): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(report);
      };
      const onAbort = (): void => finish(timedOut());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (Number.isFinite(budgetMs)) timer = setTimeout(() => finish(timedOut()), budgetMs);
      void promise.then((report) => finish({ ...report, url, action: actionFor(key, url, report) }));
    });
  }

  private report(
    key: string,
    url: string,
    fields: Pick<ChallengeReport, "ran" | "result"> &
      Partial<Omit<ChallengeReport, "url" | "action" | "ran" | "result">>,
  ): ChallengeReport {
    const limited = fields.limited ?? false;
    const out: ChallengeReport = {
      ran: fields.ran,
      limited,
      result: fields.result,
      kind: fields.kind ?? "unknown",
      rounds: fields.rounds ?? 0,
      url,
      action: actionFor(key, url, { limited, result: fields.result, message: fields.message }),
    };
    if (fields.message !== undefined) out.message = fields.message;
    if (fields.error !== undefined) out.error = fields.error;
    return out;
  }
}
