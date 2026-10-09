/**
 * Assistant tasks: the bridge asks the AI built into the Aside browser (`SiteAssistant`, the "Aside
 * AI") to pass a human check (`captcha`) or to log in again (`login`) for a registered site, in the
 * background, and keeps the guard rails around it. One coordinator per core.
 *
 * - Background only: a trigger decides at once and answers with a fixed sentence (the AI is working
 *   now, or why the user must act) or null (no task: the caller keeps today's action). The caller
 *   never waits for the AI.
 * - Triggers: a live call's blocked failure after the bridge's own captcha attempt (`captcha`, see
 *   ./live-call.ts; with `after` the task starts only once that attempt's report is known, and only
 *   when it is captcha-limited or the attempt did not act); a live `auth_required` or a call that reaches a
 *   `needs_login` site, a scheduled health check or "Check now" that finds `auth_required` (`login`).
 * - One task per site (sites run in parallel); a second trigger meanwhile gets the working sentence.
 * - A task is a non-exclusive scheduler task of the site (holder `assistant`) with the budget
 *   `taskBudgetMs`; only for a serving site that is not cooling down, only while `assistant.auto` is
 *   on and the assistant answered its probe (at core start, and again after a task failed for a CLI
 *   reason).
 * - Counting: `failed` counts; a captcha `done` followed by another blocked call of the site within
 *   `failureWindowMs` counts; a login `done` is confirmed by the login confirmation (the light check,
 *   `HealthChecker.confirmLogin`), whose `auth_required` counts and whose busy or unreachable answer
 *   counts as neither. Two counted failures within `failureWindowMs` pause the site's tasks for
 *   `pauseMs` (calls keep today's action meanwhile). `needs_user` holds the site's tasks, with the
 *   reason's fixed sentence, until "Check now" (`clearHold`). A task stopped at core stop, a refusal by
 *   the scheduler, or a caller's own timeout never counts.
 * - `done` alone never makes an outcome `ok`: only the caller's own adapter call or check confirms.
 * - The AI's text never reaches this module (the port returns verdict, reason code, session id, and
 *   duration only). Logs carry metadata only: one `assistant task` line per finished task with site,
 *   purpose, verdict, reason, session id, duration, and trigger.
 */
import { isServingStatus } from "../../core/lifecycle.js";
import type { OutcomeStatus, SiteLifecycleStatus } from "../../core/models.js";
import { errorToOutcome } from "../../core/outcome.js";
import { parseHttpUrl } from "../../core/url.js";
import {
  DEFAULT_ASSISTANT_FAILURE_WINDOW_MS,
  DEFAULT_ASSISTANT_PAUSE_MS,
  DEFAULT_ASSISTANT_TASK_BUDGET_MS,
} from "../../core/defaults.js";
import { DEFAULT_ASSISTANT_AUTO } from "../../core/settings.js";
import type {
  AssistantPurpose,
  AssistantResult,
  AssistantVerdict,
  ReasonCode,
  SiteAssistant,
} from "../../ports/assistant.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { Scheduler } from "../../ports/scheduler.js";

/** Scheduler holder name of an assistant task ("site busy: … (search, assistant)"). */
export const ASSISTANT_HOLDER = "assistant";

/** How long core stop waits for running tasks to end after their signal fired. */
export const ASSISTANT_DISPOSE_WAIT_MS = 20_000;

/** What a call answers while the Aside AI works on the site. */
export const ASSISTANT_WORKING_ACTIONS: Readonly<Record<AssistantPurpose, string>> = Object.freeze({
  captcha: "The Aside AI is passing the check now; retry in a minute",
  login: "The Aside AI is logging in now; retry in a minute",
});

/**
 * The fixed sentence a call answers while the site's tasks are held after a `needs_user` verdict
 * (English; the settings page translates the reason codes itself). `account` is the Aside account the
 * bridge drives, whose window the user must use.
 */
export function assistantAction(reason: ReasonCode, account: string): string {
  const where = `the Aside window of account ${account}`;
  switch (reason) {
    case "verification_code":
      return `The site asked for a verification code — log in in ${where}, then press Logged in? Check now`;
    case "no_saved_password":
      return `No password for this site is saved in Aside — log in in ${where}, then press Logged in? Check now`;
    case "question":
      return `The site asked a question only you can answer — log in in ${where}, then press Logged in? Check now`;
    case "check_not_passed":
      return `The Aside AI could not pass the site's check — pass it in ${where}, then press Check now`;
    case "timed_out":
    case "other":
      return `The Aside AI needs your help with this site — finish it in ${where}, then press Check now`;
  }
}

/** `config.assistant.auto`, the Aside account, and the assistant tunables. */
export interface AssistantTaskSettings {
  /** `assistant.auto`: off → no task anywhere (today's actions). */
  auto: boolean;
  /** The Aside account the bridge's browser port uses (`asideAccount`); named in the hold sentences. */
  account: string;
  /** `assistantTaskBudgetMs`: the budget of every task. */
  taskBudgetMs: number;
  /** `assistantFailureWindowMs`: the window counted failures of a site are paired in. */
  failureWindowMs: number;
  /** `assistantPauseMs`: how long a site's tasks pause after two counted failures in the window. */
  pauseMs: number;
}

export const DEFAULT_ASSISTANT_TASK_SETTINGS: Readonly<AssistantTaskSettings> = Object.freeze({
  auto: DEFAULT_ASSISTANT_AUTO,
  account: "u0",
  taskBudgetMs: DEFAULT_ASSISTANT_TASK_BUDGET_MS,
  failureWindowMs: DEFAULT_ASSISTANT_FAILURE_WINDOW_MS,
  pauseMs: DEFAULT_ASSISTANT_PAUSE_MS,
});

/** The site's last (or running) task, as `GET /api/sites` shows it; kept in memory for the core's life. */
export interface AssistantSiteRecord {
  purpose: AssistantPurpose;
  /** Null while the task runs. */
  verdict: AssistantVerdict | null;
  /** Null while the task runs and after `done`. */
  reason: ReasonCode | null;
  /** ISO time the task started (while running) or ended. */
  at: string;
  running: boolean;
}

/** The report of the bridge's own captcha attempt, as far as a captcha task cares. */
export type OwnAttemptReport = { ran: boolean; limited: boolean } | null;

export interface AssistantRequest {
  /**
   * The page where the problem showed (a read's URL, else the page the adapter's session last showed);
   * a page off the site's scope, or none, becomes the site's homepage. It never reaches the AI's text.
   */
  url: string | null;
  /** What triggered the task, for the log line (`search`, `fetch`, `read`, `health check`, `check now`). */
  trigger: string;
  /**
   * Captcha only: the bridge's own attempt still running (`ChallengeGate.whenSettled`). The task then
   * starts only once its report is known, and only when it is captcha-limited, did not run, or there was
   * none (null); when the attempt acted on the page, no task starts and the next blocked call decides.
   */
  after?: Promise<OwnAttemptReport> | undefined;
}

/** What the live tools use (./live-call.ts, ./search-service.ts). */
export interface AssistantGate {
  readonly enabled: boolean;
  /** The working sentence while a task runs (or waits for the own attempt's report) for the site; else null. */
  workingAction(key: string): string | null;
  /** The working sentence, or the hold sentence after `needs_user`; null otherwise. Starts nothing. */
  currentAction(key: string): string | null;
  /** A live call met a blocked failure on the site (counts a recent captcha `done` as failed). */
  noteBlocked(key: string): void;
  /** Starts a captcha task when the rules allow; the sentence for the call, or null (today's action). */
  captcha(key: string, request: AssistantRequest): Promise<string | null>;
  /** Starts a login task when the rules allow; the sentence for the call, or null (today's action). */
  login(key: string, request: AssistantRequest): Promise<string | null>;
}

/** What the login confirmation (`HealthChecker.confirmLogin`) reports back. */
export interface LoginConfirmation {
  /** The light check's outcome; absent when it did not run (busy, already checking, not serving). */
  outcome?: { status: OutcomeStatus } | undefined;
  /** Why it did not run. */
  skipped?: string | undefined;
}

export interface AssistantTaskCoordinatorOptions {
  settings: AssistantTaskSettings;
  assistant: SiteAssistant;
  scheduler: Pick<Scheduler, "runForSite" | "cooldownUntil">;
  /** Site lookup (the registry): lifecycle, hostnames, login address, and the manifest's scope. */
  registry: {
    get(key: string):
      | {
          status: SiteLifecycleStatus;
          loadable: boolean;
          hostnames: readonly string[];
          loginUrl: string | null;
        }
      | undefined;
    load(
      key: string,
    ): Promise<{ manifest: Pick<SiteManifest, "extraAllowedHosts" | "minIntervalMs"> } | undefined>;
  };
  logger: Logger;
  clock?: Clock | undefined;
  /**
   * Re-checks a site after a login task reported `done` (the light check, recorded like a health check;
   * `HealthChecker.confirmLogin`). Bound late in the composition root (the checker is built after).
   * `signal` fires at core stop; the check then ends early and records nothing.
   */
  confirmLogin?: ((key: string, signal: AbortSignal) => Promise<LoginConfirmation>) | undefined;
}

interface SiteState {
  record: AssistantSiteRecord | null;
  /** Times of counted failures inside the window. */
  failures: number[];
  pausedUntil: number | null;
  /** The reason of a `needs_user` verdict; tasks wait for "Check now". */
  held: ReasonCode | null;
  /** When a captcha task last reported `done` (a later blocked call within the window counts it failed). */
  captchaDoneAt: number | null;
}

/** A site being worked on: waiting for the own attempt, running, or confirming a login. */
interface Slot {
  purpose: AssistantPurpose;
  controller: AbortController;
  done: Promise<void>;
}

export class AssistantTaskCoordinator implements AssistantGate {
  readonly settings: Readonly<AssistantTaskSettings>;
  private readonly clock: Clock;
  private readonly slots = new Map<string, Slot>();
  private readonly states = new Map<string, SiteState>();
  private availability: boolean | null = null;
  private probing: Promise<boolean> | null = null;
  private disposed = false;

  constructor(private readonly options: AssistantTaskCoordinatorOptions) {
    this.settings = Object.freeze({ ...options.settings });
    this.clock = options.clock ?? systemClock;
  }

  get enabled(): boolean {
    return this.settings.auto && !this.disposed;
  }

  /** Whether the assistant answered its last probe; null before the first probe has answered. */
  available(): boolean | null {
    return this.availability;
  }

  /** Probes the Aside CLI (core start; after a task failed for a CLI reason). Never throws. */
  probe(): Promise<boolean> {
    const probe: Promise<boolean> = this.options.assistant
      .available({ reprobe: true })
      .catch(() => false)
      .then((value) => {
        if (this.probing === probe) {
          this.availability = value;
          this.probing = null;
        }
        return value;
      });
    this.probing = probe;
    return probe;
  }

  /** The site's last or running task, or null when none ran on this core. */
  view(key: string): AssistantSiteRecord | null {
    const record = this.states.get(key)?.record;
    return record === undefined || record === null ? null : { ...record };
  }

  workingAction(key: string): string | null {
    if (!this.enabled) return null;
    const slot = this.slots.get(key);
    return slot === undefined ? null : ASSISTANT_WORKING_ACTIONS[slot.purpose];
  }

  currentAction(key: string): string | null {
    if (!this.enabled) return null;
    const answer = this.blocker(key);
    return answer === undefined ? null : answer;
  }

  noteBlocked(key: string): void {
    if (!this.enabled) return;
    const state = this.states.get(key);
    if (state?.captchaDoneAt === undefined || state.captchaDoneAt === null) return;
    const at = this.now();
    const doneAt = state.captchaDoneAt;
    state.captchaDoneAt = null;
    if (at - doneAt > this.settings.failureWindowMs) return;
    this.options.logger.info("assistant captcha task counted as failed", { site: key });
    this.countFailure(key, at);
  }

  captcha(key: string, request: AssistantRequest): Promise<string | null> {
    return this.request(key, "captcha", request);
  }

  login(key: string, request: AssistantRequest): Promise<string | null> {
    return this.request(key, "login", { url: request.url, trigger: request.trigger });
  }

  /** "Check now": the site's pause and hold end (and its failure count starts over). */
  clearHold(key: string): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    if (state.held !== null || state.pausedUntil !== null) {
      this.options.logger.info("assistant hold cleared", { site: key });
    }
    state.held = null;
    state.pausedUntil = null;
    state.failures = [];
    state.captchaDoneAt = null;
  }

  /** Resolves when no task runs, waits, or confirms (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.slots.size > 0) {
      await Promise.all([...this.slots.values()].map((slot) => slot.done));
    }
  }

  /**
   * Core stop: refuses new tasks and stops running ones through their signal (the port stops the
   * Aside session and the child); waits for them at most `ASSISTANT_DISPOSE_WAIT_MS`.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const slot of this.slots.values()) slot.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ASSISTANT_DISPOSE_WAIT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([this.settled(), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ internals

  private now(): number {
    return this.clock.now().getTime();
  }

  private state(key: string): SiteState {
    let state = this.states.get(key);
    if (state === undefined) {
      state = { record: null, failures: [], pausedUntil: null, held: null, captchaDoneAt: null };
      this.states.set(key, state);
    }
    return state;
  }

  private paused(state: SiteState | undefined): boolean {
    return state?.pausedUntil !== undefined && state.pausedUntil !== null && this.now() < state.pausedUntil;
  }

  /**
   * What a trigger answers without a new task: the working sentence (a task runs), the hold sentence
   * (`needs_user`), null (paused: today's action); undefined when a task may start.
   */
  private blocker(key: string): string | null | undefined {
    const slot = this.slots.get(key);
    if (slot !== undefined) return ASSISTANT_WORKING_ACTIONS[slot.purpose];
    const state = this.states.get(key);
    if (state?.held !== undefined && state.held !== null) {
      return assistantAction(state.held, this.settings.account);
    }
    if (this.paused(state)) return null;
    return undefined;
  }

  /** The probe's answer; a probe still running (core start) is waited for. Never probes by itself. */
  private async isAvailable(): Promise<boolean> {
    if (this.probing !== null) return this.probing;
    return this.availability === true;
  }

  /** A serving, loadable site that is not cooling down (the scheduler would refuse it). */
  private eligible(key: string): boolean {
    const site = this.options.registry.get(key);
    if (site === undefined || !site.loadable || !isServingStatus(site.status)) return false;
    return this.options.scheduler.cooldownUntil(key) === null;
  }

  private async request(
    key: string,
    purpose: AssistantPurpose,
    request: AssistantRequest,
  ): Promise<string | null> {
    if (!this.enabled) return null;
    const first = this.blocker(key);
    if (first !== undefined) return first;
    if (!(await this.isAvailable())) return null;
    if (!this.enabled) return null;
    // Another trigger may have started a task while the probe was awaited.
    const again = this.blocker(key);
    if (again !== undefined) return again;
    if (!this.eligible(key)) return null;
    this.begin(key, purpose, request);
    return ASSISTANT_WORKING_ACTIONS[purpose];
  }

  private begin(key: string, purpose: AssistantPurpose, request: AssistantRequest): void {
    const controller = new AbortController();
    const slot: Slot = { purpose, controller, done: Promise.resolve() };
    this.slots.set(key, slot);
    slot.done = this.run(key, purpose, request, controller.signal)
      .catch((error: unknown) => {
        this.options.logger.warn("assistant task failed unexpectedly", {
          site: key,
          purpose,
          error: errorToOutcome(error).status,
        });
      })
      .finally(() => {
        if (this.slots.get(key) === slot) this.slots.delete(key);
      });
  }

  /** One task: the own attempt's report (captcha), the scheduler slot, the AI, the counting. */
  private async run(
    key: string,
    purpose: AssistantPurpose,
    request: AssistantRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { registry, scheduler, assistant, logger } = this.options;
    if (request.after !== undefined) {
      const report = await untilAborted(
        request.after.catch((): OwnAttemptReport => null),
        signal,
      );
      if (signal.aborted) return;
      if (report !== null && report.ran && !report.limited) {
        // The bridge's own attempt acted on the page: the next blocked call decides.
        logger.debug("assistant task not needed", { site: key, purpose, trigger: request.trigger });
        return;
      }
      // The rules again: the site may have changed while the attempt ran.
      const state = this.states.get(key);
      if (
        !this.enabled ||
        (state?.held !== undefined && state.held !== null) ||
        this.paused(state) ||
        this.availability === false ||
        !this.eligible(key)
      ) {
        logger.debug("assistant task not started", { site: key, purpose, trigger: request.trigger });
        return;
      }
    }
    const site = registry.get(key);
    const loaded = site === undefined ? undefined : await registry.load(key);
    if (site === undefined || loaded === undefined || signal.aborted) return;
    const extraAllowedHosts = [...(loaded.manifest.extraAllowedHosts ?? [])];
    const url = onScope(request.url, [...site.hostnames, ...extraAllowedHosts])
      ? request.url
      : homepage(site.hostnames);
    if (url === null) return;

    let result: AssistantResult;
    try {
      result = await scheduler.runForSite(
        {
          site: key,
          holder: ASSISTANT_HOLDER,
          acquireTimeoutMs: this.settings.taskBudgetMs,
          minIntervalMs: loaded.manifest.minIntervalMs ?? 0,
          signal,
        },
        (lease) => {
          this.state(key).record = {
            purpose,
            verdict: null,
            reason: null,
            at: new Date(this.now()).toISOString(),
            running: true,
          };
          return assistant.run({
            site: key,
            purpose,
            url,
            hostnames: [...site.hostnames],
            extraAllowedHosts,
            loginUrl: purpose === "login" ? site.loginUrl : null,
            account: this.settings.account,
            budgetMs: this.settings.taskBudgetMs,
            signal: lease.signal,
          });
        },
      );
    } catch (error) {
      // Refused (cooling down, no place in time) or stopped before it started: not counted.
      logger.info("assistant task not started", {
        site: key,
        purpose,
        trigger: request.trigger,
        error: errorToOutcome(error).status,
      });
      return;
    }
    await this.finish(key, purpose, request.trigger, result, signal);
  }

  private async finish(
    key: string,
    purpose: AssistantPurpose,
    trigger: string,
    result: AssistantResult,
    signal: AbortSignal,
  ): Promise<void> {
    const at = this.now();
    const state = this.state(key);
    state.record = {
      purpose,
      verdict: result.verdict,
      reason: result.reason,
      at: new Date(at).toISOString(),
      running: false,
    };
    this.options.logger.info("assistant task", {
      site: key,
      purpose,
      verdict: result.verdict,
      reason: result.reason,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      trigger,
    });
    // Stopped by core stop: not the task's failure.
    if (signal.aborted || this.disposed) return;
    switch (result.verdict) {
      case "failed":
        this.countFailure(key, at);
        // No session at all: the CLI itself failed (not started, refused, exited early).
        if (result.reason === "other" && result.sessionId === null) await this.probe();
        return;
      case "needs_user":
        state.held = result.reason ?? "other";
        return;
      case "done":
        if (purpose === "captcha") state.captchaDoneAt = at;
        else await this.confirm(key, signal);
        return;
    }
  }

  /** After a login `done`: the light check decides; `auth_required` counts, busy/unreachable do not. */
  private async confirm(key: string, signal: AbortSignal): Promise<void> {
    const confirmLogin = this.options.confirmLogin;
    if (confirmLogin === undefined) return;
    let confirmation: LoginConfirmation;
    try {
      confirmation = await confirmLogin(key, signal);
    } catch (error) {
      this.options.logger.warn("assistant login confirmation failed", {
        site: key,
        error: errorToOutcome(error).status,
      });
      return;
    }
    if (this.disposed) return;
    const status = confirmation.outcome?.status ?? null;
    const counted = status === "auth_required";
    this.options.logger.info("assistant login confirmation", {
      site: key,
      outcome: status,
      skipped: confirmation.skipped ?? null,
      counted,
    });
    if (counted) this.countFailure(key, this.now());
  }

  /** One counted failure; the second within the window pauses the site's tasks. */
  private countFailure(key: string, at: number): void {
    const state = this.state(key);
    state.failures = state.failures.filter((t) => at - t <= this.settings.failureWindowMs);
    state.failures.push(at);
    if (state.failures.length < 2) return;
    state.failures = [];
    state.pausedUntil = at + this.settings.pauseMs;
    this.options.logger.info("assistant tasks paused", { site: key, pauseMs: this.settings.pauseMs });
  }
}

/** The site's homepage, `https://<first hostname>/`; null without hostnames. */
function homepage(hostnames: readonly string[]): string | null {
  const host = hostnames[0];
  return host === undefined ? null : `https://${host}/`;
}

/** An http(s) page on one of the hosts or a subdomain of one. */
function onScope(url: string | null, hosts: readonly string[]): url is string {
  if (url === null) return false;
  const parsed = parseHttpUrl(url);
  if (parsed === null || parsed.username !== "" || parsed.password !== "") return false;
  const host = normalizeHost(parsed.hostname);
  return hosts.some((h) => {
    const scope = normalizeHost(h);
    return scope !== "" && (host === scope || host.endsWith(`.${scope}`));
  });
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** The promise's value, or null as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}
