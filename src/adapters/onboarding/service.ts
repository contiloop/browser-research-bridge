/**
 * Onboarding job service: Add, Retry, Repair, Cancel, Remove over a global FIFO queue
 * with one running job at a time.
 *
 * States: `queued → running → (awaiting_user → queued → running →)* succeeded | failed | cancelled`.
 * A run hands the agent (port {@link AgentRunner}) the tools of ./tools.ts. When the agent calls
 * `finish`, the service itself runs the full validation of the staged folder (never trusting the
 * agent) and only on a pass promotes it (`promoteStaging`: swap with `.previous/`, hot reload,
 * `active`, auto-commit). An Add that fails leaves the site `failed` with Retry offered; a Repair
 * that fails leaves the live adapter and the site's status untouched. `report_blocked` pauses the
 * job as `awaiting_user` with the reason and the smallest user action; Retry continues the same job
 * (same id; the agent session is resumed, or a new session gets a summary of the earlier log).
 *
 * Persistence: `data/jobs/` (record + append-only log per job). On start, a job found `running`
 * was interrupted by a restart: it fails ("interrupted by restart") and its Add site becomes `failed`
 * (Retry available); queued jobs run again; paused jobs stay paused; an `onboarding` site with no
 * queued/paused job becomes `failed` too.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { OutcomeError, errorToOutcome } from "../../core/outcome.js";
import { registrableDomain } from "../../core/site-key.js";
import type { BrowserPort } from "../../ports/browser.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { Scheduler } from "../../ports/scheduler.js";
import { normalizeHostname } from "../aside/hosts.js";
import type { PromoteResult, RemoveOptions, RemoveResult } from "../registry/operations.js";
import type { HostnameCheck, RegistrySite } from "../registry/registry.js";
import { toHostname } from "../registry/registry.js";
import { SerialQueue } from "../storage/json-file.js";
import { summarizeReport } from "../validation/report.js";
import { AgentBrowser, approvalPauseMessage, resolveAgentScope } from "./agent-browser.js";
import type { ResolvedScope } from "./agent-browser.js";
import { createClaudeHelperRuntime } from "./claude-runtime.js";
import { ReferenceLibrary, STAGING_WRITABLE, StagingFiles } from "./files.js";
import { HelperRuntimes } from "./helper-runtime.js";
import type { HelperCheckResult, HelperStatus } from "./helper-runtime.js";
import { buildInitialPrompt, buildRetryPrompt, buildSystemPrompt } from "./prompt.js";
import type { PromptInput } from "./prompt.js";
import type { StagingValidation } from "./staging-validation.js";
import { createOnboardingTools } from "./tools.js";
import type { TerminalCall, ToolHost } from "./tools.js";
import { OnboardingRequestError, isActiveJobState, jobLang, jobRuntime, parseHelperLang } from "./types.js";
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunner,
  HelperLang,
  JobEvent,
  JobKind,
  JobLogLevel,
  JobLogLine,
  JobLogSource,
  JobStore,
  OnboardingJob,
} from "./types.js";

/** What the service needs from the site registry (SiteRegistryService implements it). */
export interface JobRegistry {
  get(key: string): RegistrySite | undefined;
  list(): readonly RegistrySite[];
  checkAddHostname(urlOrHostname: string): HostnameCheck;
  registerOnboarding(input: {
    hostnames: readonly string[];
    key?: string | undefined;
  }): Promise<RegistrySite>;
  markOnboarding(key: string): Promise<RegistrySite>;
  markOnboardingFailed(key: string, reason: string): Promise<RegistrySite>;
  siteDir(key: string): string;
  stagingDir(key: string): string;
  manifestOf(key: string): SiteManifest | null;
}

/** Swap and removal (src/adapters/registry/operations.ts, bound to the bridge's deps). */
export interface SiteOperations {
  promote(key: string, action: JobKind): Promise<PromoteResult>;
  remove(key: string, options: RemoveOptions): Promise<RemoveResult>;
}

export interface OnboardingJobServiceOptions {
  registry: JobRegistry;
  store: JobStore;
  /**
   * The runtimes jobs may run on and the configured choice. When absent, `runner` is the
   * only runtime, registered as Claude with `configured: "auto"`.
   */
  runtimes?: HelperRuntimes | undefined;
  /** Shorthand for a registry holding only this runner (tests, the CLI); ignored when `runtimes` is set. */
  runner?: AgentRunner | undefined;
  validation: StagingValidation;
  operations: SiteOperations;
  browser: BrowserPort;
  scheduler: Scheduler;
  repoRoot: string;
  sitesDir: string;
  /** Parent of the agent's empty per-job working directories. */
  workRoot: string;
  /** Aside account named in the agent's requested actions (default `u0`). */
  asideAccount?: string | undefined;
  /** Politeness interval when no manifest declares one (default 1500 ms). */
  defaultMinIntervalMs?: number | undefined;
  /** Budget of one agent browser step, lock wait included (default 150 s). */
  stepBudgetMs?: number | undefined;
  /** Time budget of one `browser_solve_captcha` attempt (`captchaAttemptBudgetMs`, default 45 s). */
  captchaAttemptBudgetMs?: number | undefined;
  /** `captcha.auto`: false makes `browser_solve_captcha` answer "turned off" (default true). */
  captchaAuto?: boolean | undefined;
  /** How long the helper check may take (default 180 s). */
  checkTimeoutMs?: number | undefined;
  /** How long Cancel waits for a running agent to stop (default 60 s). */
  cancelWaitMs?: number | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
  /** Job id factory (tests). */
  newId?: (() => string) | undefined;
}

export interface AddJobInput {
  /** A URL (`https://www.reuters.com`), a hostname (`reuters.com`), or a site name (`Naver Blog`). */
  input: string;
  note?: string | null | undefined;
  /** Page language for the helper's requested action (default `en`). */
  lang?: HelperLang | undefined;
}

/** Options of Retry: the page language replaces the job's when given. */
export interface RetryJobInput {
  lang?: HelperLang | undefined;
}

/** Options of Repair besides the note. */
export interface RepairJobInput {
  lang?: HelperLang | undefined;
}

interface RunningJob {
  jobId: string;
  abort: AbortController;
  cancelReason: string | null;
  done: Promise<void>;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const MAX_NOTE = 2000;
const MAX_LOG_MESSAGE = 4000;
const REPAIRABLE = new Set(["active", "degraded", "failed"]);

function defaultId(clock: Clock): string {
  const t = clock
    .now()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `job-${t}-${randomBytes(3).toString("hex")}`;
}

/** Masks things that look like credentials in log text. */
export function redactSecrets(message: string): string {
  return message
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 …");
}

/** The hostname of an Add input that names a URL or a hostname; null for a bare site name. */
export function addInputHostname(input: string): string | null {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return toHostname(s);
  if (/^[^\s/]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(s)) return toHostname(s);
  return null;
}

/** Refuses hostnames the bridge must never browse (IP literals, local names, single labels). */
export function checkPublicHostname(hostname: string): string | null {
  const h = normalizeHostname(hostname);
  if (h === null) return `"${hostname}" is not a valid hostname`;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("["))
    return "IP addresses cannot be added";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local"))
    return "local hosts cannot be added";
  if (!h.includes(".")) return `"${hostname}" is not a public hostname`;
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The requested action the service writes itself when a job needs hosts approved, per page language. */
export const HOST_APPROVAL_ACTIONS: Readonly<Record<HelperLang, string>> = {
  en: "Approve these hosts by clicking Retry (or remove them from the manifest and Retry)",
  ko: "다시 시도(Retry)를 누르면 이 호스트들에 대한 접근이 허용됩니다 (허용하지 않으려면 매니페스트에서 빼고 다시 시도하세요)",
};

/** The English host-approval action (kept for existing callers). */
export const HOST_APPROVAL_ACTION = HOST_APPROVAL_ACTIONS.en;

/**
 * The pause of a job whose staged manifest declares hosts outside the site's domain. The reason is
 * technical text and stays English; the requested action follows the job's page language.
 */
export function hostApprovalRequest(
  siteHostnames: readonly string[],
  hosts: readonly string[],
  lang: HelperLang = "en",
): { reason: string; requestedAction: string } {
  const domains = [...new Set(siteHostnames.map((h) => registrableDomain(h)))];
  const site = domains.length > 0 ? domains.join(" and ") : "the site";
  return {
    reason: `the adapter needs access to hosts outside ${site}: ${hosts.join(", ")}`,
    requestedAction: HOST_APPROVAL_ACTIONS[lang],
  };
}

async function stagedHints(stagingDir: string): Promise<{ hosts: string[]; minIntervalMs: number | null }> {
  try {
    const raw = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    const mi = raw["minIntervalMs"];
    return {
      hosts: [...list(raw["hostnames"]), ...list(raw["extraAllowedHosts"])],
      minIntervalMs: typeof mi === "number" && Number.isInteger(mi) && mi >= 0 && mi <= 600_000 ? mi : null,
    };
  } catch {
    return { hosts: [], minIntervalMs: null };
  }
}

export class OnboardingJobService {
  private readonly o: OnboardingJobServiceOptions;
  private readonly runtimes: HelperRuntimes;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly jobs = new Map<string, OnboardingJob>();
  private readonly queue: string[] = [];
  private readonly seqs = new Map<string, number>();
  private readonly writes = new SerialQueue();
  private readonly jobListeners = new Map<string, Set<(event: JobEvent) => void>>();
  private readonly allListeners = new Set<(event: JobEvent) => void>();
  private idleWaiters: (() => void)[] = [];
  private running: RunningJob | null = null;
  private started = false;
  private stopping = false;

  constructor(options: OnboardingJobServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    if (options.runtimes !== undefined) this.runtimes = options.runtimes;
    else if (options.runner !== undefined) {
      const runner = options.runner;
      this.runtimes = new HelperRuntimes({
        configured: "auto",
        runtimes: [createClaudeHelperRuntime({ runner, apiKey: null })],
        now: () => this.clock.now(),
      });
    } else throw new Error("OnboardingJobService needs runtimes or a runner");
    this.logger = options.logger ?? silentLogger;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Loads the jobs, reconciles them with the registry (restart rule), and starts the queue. */
  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    const loaded = await this.o.store.loadAll();
    for (const job of loaded) this.jobs.set(job.id, job);
    for (const job of loaded) {
      if (job.state === "running") {
        await this.failJob(job, "interrupted by restart; click Retry");
      } else if (job.state === "queued" && !this.queue.includes(job.id)) {
        this.queue.push(job.id);
      }
    }
    for (const site of this.o.registry.list()) {
      if (site.status !== "onboarding") continue;
      const pending = this.jobsFor(site.key).some((j) => j.state === "queued" || j.state === "awaiting_user");
      if (!pending) {
        await this.o.registry.markOnboardingFailed(site.key, "interrupted by restart; click Retry");
        this.logger.warn("onboarding site without a job marked failed", { site: site.key });
      }
    }
    this.started = true;
    this.pump();
  }

  /** Stops the queue; a running agent is aborted and its job fails ("interrupted by shutdown"). */
  async stop(): Promise<void> {
    if (!this.started && this.running === null) return;
    this.started = false;
    this.stopping = true;
    const run = this.running;
    if (run) {
      run.abort.abort();
      await this.waitFor(run.done, this.o.cancelWaitMs ?? 60_000);
    }
    await this.flush();
    this.resolveIdle();
  }

  // -------------------------------------------------------------------------------------------
  // Queries and streaming
  // -------------------------------------------------------------------------------------------

  /** All jobs, newest first. */
  list(): OnboardingJob[] {
    return [...this.jobs.values()]
      .sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id),
      )
      .map((j) => structuredClone(j));
  }

  /** The latest job of a site. */
  get(key: string): OnboardingJob | undefined {
    const job = this.latest(key);
    return job ? structuredClone(job) : undefined;
  }

  getJob(jobId: string): OnboardingJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  /** The job's log lines (all, or those after `after`). */
  async log(jobId: string, options: { after?: number | undefined } = {}): Promise<JobLogLine[]> {
    if (!this.jobs.has(jobId)) return [];
    await this.flush();
    const lines = await this.o.store.readLog(jobId);
    const after = options.after ?? 0;
    return lines.filter((l) => l.seq > after);
  }

  /** Live events of one job (log lines and record changes). Returns the unsubscribe function. */
  subscribe(jobId: string, callback: (event: JobEvent) => void): () => void {
    const set = this.jobListeners.get(jobId) ?? new Set();
    set.add(callback);
    this.jobListeners.set(jobId, set);
    return () => {
      set.delete(callback);
      if (set.size === 0) this.jobListeners.delete(jobId);
    };
  }

  /** Live events of every job. Returns the unsubscribe function. */
  subscribeAll(callback: (event: JobEvent) => void): () => void {
    this.allListeners.add(callback);
    return () => this.allListeners.delete(callback);
  }

  /** Resolves when no job is running or queued (and every write is flushed). */
  async whenIdle(): Promise<void> {
    if (this.running !== null || (this.started && this.queue.length > 0)) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
    await this.flush();
  }

  // -------------------------------------------------------------------------------------------
  // Helper runtime
  // -------------------------------------------------------------------------------------------

  /**
   * `GET helper` (no model call). `lastCheck` is whatever the caller kept from an earlier
   * {@link helperCheck}; the service does not store it, so it can outlive the service.
   */
  helperStatus(lastCheck: HelperCheckResult | null = null): Promise<HelperStatus> {
    return this.runtimes.status(lastCheck);
  }

  /** `POST helper/check`: one real round trip on the runtime a job started now would use. */
  async helperCheck(): Promise<HelperCheckResult> {
    const workDir = join(this.o.workRoot, "helper-check");
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    return this.runtimes.check({ workDir, signal: AbortSignal.timeout(this.o.checkTimeoutMs ?? 180_000) });
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  /** Add: a URL/hostname is checked and registered as `onboarding` at once; a bare name is resolved by the agent. */
  async add(request: AddJobInput): Promise<OnboardingJob> {
    const input = request.input.trim();
    if (input === "") throw new OnboardingRequestError("enter a URL or a site name");
    if (input.length > 500) throw new OnboardingRequestError("the input is too long");
    const note = (request.note ?? "").trim();
    if (note.length > MAX_NOTE)
      throw new OnboardingRequestError(`the note is too long (limit ${MAX_NOTE} characters)`);
    const hostname = addInputHostname(input);
    let key: string | null = null;
    let hostnames: string[] = [];
    if (hostname !== null) {
      const problem = checkPublicHostname(hostname);
      if (problem !== null) throw new OnboardingRequestError(problem);
      const check = this.o.registry.checkAddHostname(hostname);
      if (!check.ok) throw new OnboardingRequestError(check.message, "conflict");
      try {
        const site = await this.o.registry.registerOnboarding({ hostnames: [check.hostname] });
        key = site.key;
        hostnames = [check.hostname];
      } catch (error) {
        throw new OnboardingRequestError(errorToOutcome(error).message ?? String(error), "conflict");
      }
    }
    const job = this.newJob({
      kind: "add",
      key,
      input,
      note: note === "" ? null : note,
      hostnames,
      lang: parseHelperLang(request.lang),
    });
    await this.save(job);
    this.appendLog(
      job,
      "job",
      "info",
      key === null
        ? `Add "${input}" queued; the agent resolves the homepage first`
        : `Add ${hostname ?? input} queued as site "${key}"`,
    );
    this.enqueue(job);
    return structuredClone(job);
  }

  /** Retry of the site's latest job (awaiting_user or failed), or a new Add job for a failed site without one. */
  async retry(key: string, options: RetryJobInput = {}): Promise<OnboardingJob> {
    const job = this.latest(key);
    if (job && (job.state === "awaiting_user" || job.state === "failed"))
      return this.retryJob(job.id, options);
    if (job && (job.state === "queued" || job.state === "running")) {
      throw new OnboardingRequestError(`a job is already ${job.state} for ${key}`, "conflict");
    }
    const site = this.o.registry.get(key);
    if (!site) throw new OnboardingRequestError(`site not registered: ${key}`, "not_found");
    if (site.status === "failed" && !site.loadable) {
      const hostnames = [
        ...(site.provisionalHostnames.length > 0 ? site.provisionalHostnames : site.hostnames),
      ];
      await this.o.registry.markOnboarding(key);
      const fresh = this.newJob({
        kind: "add",
        key,
        input: hostnames[0] ?? key,
        note: job?.note ?? null,
        hostnames,
        lang: options.lang !== undefined ? parseHelperLang(options.lang) : job ? jobLang(job) : "en",
      });
      await this.save(fresh);
      this.appendLog(fresh, "job", "info", `Retry: new onboarding job for "${key}"`);
      this.enqueue(fresh);
      return structuredClone(fresh);
    }
    throw new OnboardingRequestError(`nothing to retry for ${key}`);
  }

  /** Retry by job id (also for a bare-name Add that failed before it had a key). */
  async retryJob(jobId: string, options: RetryJobInput = {}): Promise<OnboardingJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new OnboardingRequestError(`unknown job: ${jobId}`, "not_found");
    if (job.state !== "awaiting_user" && job.state !== "failed") {
      throw new OnboardingRequestError(
        `job ${jobId} is ${job.state}; only paused or failed jobs can be retried`,
        "conflict",
      );
    }
    if (job.key !== null) {
      const site = this.o.registry.get(job.key);
      if (!site) throw new OnboardingRequestError(`site not registered: ${job.key}`, "not_found");
      if (job.kind === "add" && site.status === "failed") await this.o.registry.markOnboarding(job.key);
      if (job.kind === "add" && site.status !== "failed" && site.status !== "onboarding") {
        throw new OnboardingRequestError(`site ${job.key} is ${site.status}; use Repair`, "conflict");
      }
    }
    const approvedNow = job.state === "awaiting_user" ? job.pendingHosts : [];
    if (approvedNow.length > 0) {
      job.approvedHosts = [...new Set([...job.approvedHosts, ...approvedNow])];
    }
    job.pendingHosts = [];
    // The page language of this Retry replaces the job's (old records read as English).
    job.lang = options.lang !== undefined ? parseHelperLang(options.lang) : jobLang(job);
    job.state = "queued";
    job.finishedAt = null;
    await this.save(job);
    this.appendLog(job, "job", "info", "Retry requested");
    if (approvedNow.length > 0) {
      this.appendLog(job, "job", "info", `The user approved browser access to ${approvedNow.join(", ")}`);
    }
    this.enqueue(job);
    return structuredClone(job);
  }

  /** Repair: the agent fixes the live adapter in staging; the site keeps its status meanwhile. */
  async repair(key: string, note?: string | null, options: RepairJobInput = {}): Promise<OnboardingJob> {
    const site = this.o.registry.get(key);
    if (!site) throw new OnboardingRequestError(`site not registered: ${key}`, "not_found");
    const active = this.jobsFor(key).find((j) => isActiveJobState(j.state));
    if (active) throw new OnboardingRequestError(`a job is already ${active.state} for ${key}`, "conflict");
    if (!REPAIRABLE.has(site.status)) {
      throw new OnboardingRequestError(
        `Repair is available for active, degraded and failed sites; ${key} is ${site.status}`,
        "conflict",
      );
    }
    const live = this.o.registry.siteDir(key);
    if (!(await exists(join(live, "manifest.json"))) || !(await exists(join(live, "adapter.ts")))) {
      throw new OnboardingRequestError(`${key} has no adapter to repair; use Retry`, "conflict");
    }
    const trimmed = (note ?? "").trim();
    if (trimmed.length > MAX_NOTE)
      throw new OnboardingRequestError(`the note is too long (limit ${MAX_NOTE} characters)`);
    const job = this.newJob({
      kind: "repair",
      key,
      input: key,
      note: trimmed === "" ? null : trimmed,
      hostnames: [...site.hostnames],
      lang: parseHelperLang(options.lang),
    });
    job.lastFailure = site.lastFailure;
    await this.save(job);
    this.appendLog(job, "job", "info", `Repair of "${key}" queued (site stays ${site.status})`);
    this.enqueue(job);
    return structuredClone(job);
  }

  /** Cancels the site's queued, paused, or running job. True when one was cancelled. */
  async cancel(key: string, reason = "cancelled by the user"): Promise<boolean> {
    let any = false;
    for (const job of this.jobsFor(key)) {
      if (isActiveJobState(job.state)) any = (await this.cancelJob(job.id, reason)) || any;
    }
    return any;
  }

  async cancelJob(jobId: string, reason = "cancelled by the user"): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || !isActiveJobState(job.state)) return false;
    const run = this.running;
    if (run && run.jobId === jobId) {
      run.cancelReason = reason;
      run.abort.abort();
      this.appendLog(job, "job", "warn", `Cancel requested: ${reason}`);
      await this.waitFor(run.done, this.o.cancelWaitMs ?? 60_000);
      return true;
    }
    const i = this.queue.indexOf(jobId);
    if (i >= 0) this.queue.splice(i, 1);
    await this.markCancelled(job, reason);
    return true;
  }

  /** Remove: cancels the site's job, then deletes the folder, state, and cache, and commits. */
  async remove(key: string): Promise<RemoveResult> {
    return this.o.operations.remove(key, {
      cancelJob: async (k) => {
        await this.cancel(k, "site removed");
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Queue and runs
  // -------------------------------------------------------------------------------------------

  private enqueue(job: OnboardingJob): void {
    if (!this.queue.includes(job.id)) this.queue.push(job.id);
    this.pump();
  }

  private pump(): void {
    if (!this.started || this.stopping || this.running !== null) return;
    let next: OnboardingJob | undefined;
    while (this.queue.length > 0 && next === undefined) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (job && job.state === "queued") next = job;
    }
    if (next === undefined) {
      this.resolveIdle();
      return;
    }
    const job = next;
    const run: RunningJob = {
      jobId: job.id,
      abort: new AbortController(),
      cancelReason: null,
      done: Promise.resolve(),
    };
    this.running = run;
    run.done = this.execute(job, run)
      .catch((error: unknown) => {
        this.logger.error("onboarding job crashed", { job: job.id, error: (error as Error).message });
      })
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  private async execute(job: OnboardingJob, run: RunningJob): Promise<void> {
    const previous = { reason: job.reason, requestedAction: job.requestedAction };
    const recorded = jobRuntime(job);
    const selection = await this.runtimes.select(recorded);
    // A session belongs to the runtime that made it: another runtime starts fresh with a log summary.
    const switched = selection.ok && recorded !== null && selection.runtime.id !== recorded;
    if (switched) job.sessionId = null;
    const resume = job.sessionId !== null && job.attempts > 0;
    job.state = "running";
    job.attempts += 1;
    job.startedAt = this.nowIso();
    job.finishedAt = null;
    job.reason = null;
    job.requestedAction = null;
    job.blockKind = "other";
    job.lang = jobLang(job);
    if (selection.ok) job.runtime = selection.runtime.id;
    else job.runtime = recorded;
    await this.save(job);
    if (!selection.ok) {
      await this.failJob(job, selection.message);
      return;
    }
    const runtime = selection.runtime;
    this.appendLog(
      job,
      "job",
      "info",
      `Run ${job.attempts} started (${job.kind}, helper ${runtime.label}${resume ? ", continuing the agent session" : ""})`,
    );
    if (switched) {
      this.appendLog(
        job,
        "job",
        "warn",
        `The earlier helper (${recorded}) is not available; running on ${runtime.label} in a new session with a summary`,
      );
    }

    let host: RunHost | null = null;
    try {
      if (job.key !== null) {
        const problem = await this.prepareSite(job, resume);
        if (problem !== null) {
          await this.failJob(job, problem);
          return;
        }
      }
      const workDir = join(this.o.workRoot, job.id);
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      host = new RunHost(this, job, run.abort.signal);
      const tools = createOnboardingTools(host);
      const promptInput: PromptInput = {
        kind: job.kind,
        key: job.key,
        input: job.input,
        hostnames: job.hostnames,
        note: job.note,
        asideAccount: this.o.asideAccount ?? "u0",
        lastFailure: job.lastFailure,
        lang: jobLang(job),
      };
      const base = {
        runId: `${job.id}#${job.attempts}`,
        systemPrompt: buildSystemPrompt(promptInput),
        tools,
        workDir,
        signal: run.abort.signal,
        onEvent: (event: AgentEvent) => this.onAgentEvent(job, event),
      };
      let result: AgentRunResult;
      if (resume) {
        result = await runtime.runner.run({
          ...base,
          prompt: `${buildRetryPrompt(previous, jobLang(job))}${job.key !== null ? `\nThe site key is "${job.key}".` : ""}`,
          resumeSessionId: job.sessionId,
        });
        if (result.resumeFailed === true && !run.abort.signal.aborted && host.terminal() === null) {
          this.appendLog(
            job,
            "job",
            "warn",
            "The earlier agent session could not be resumed; starting a new one with a summary",
          );
          const summary = await this.priorSummary(job);
          result = await runtime.runner.run({
            ...base,
            prompt: buildInitialPrompt({ ...promptInput, key: job.key }, summary),
            resumeSessionId: null,
          });
        }
      } else {
        const summary = job.attempts > 1 ? await this.priorSummary(job) : null;
        result = await runtime.runner.run({
          ...base,
          prompt: buildInitialPrompt(promptInput, summary),
          resumeSessionId: null,
        });
      }
      if (result.sessionId !== null) job.sessionId = result.sessionId;
      this.appendLog(
        job,
        "job",
        "info",
        `Agent run ended: ${result.outcome} after ${result.turns} turns${result.costUsd !== null ? `, ~$${result.costUsd.toFixed(2)}` : ""}`,
      );
      await host.dispose();
      await this.conclude(job, run, host.terminal(), result);
    } catch (error) {
      await host?.dispose();
      if (run.cancelReason !== null) await this.markCancelled(job, run.cancelReason);
      else await this.failJob(job, `onboarding error: ${errorToOutcome(error).message ?? String(error)}`);
    }
  }

  /** Checks the site still fits the job and prepares `.staging/`. Returns a failure reason or null. */
  private async prepareSite(job: OnboardingJob, resume: boolean): Promise<string | null> {
    const key = job.key as string;
    const site = this.o.registry.get(key);
    if (!site) return `site not registered: ${key}`;
    if (job.kind === "add") {
      if (site.status === "failed") await this.o.registry.markOnboarding(key);
      else if (site.status !== "onboarding") return `site ${key} is ${site.status}; use Repair`;
    }
    const staging = this.stagingFiles(key);
    if (job.kind === "repair" && !resume && job.attempts === 1) {
      // A repair starts from a copy of the live files; validation.json is never copied.
      await rm(staging.dir, { recursive: true, force: true });
      await staging.ensure();
      const live = this.o.registry.siteDir(key);
      for (const name of STAGING_WRITABLE) {
        if (await exists(join(live, name))) await copyFile(join(live, name), join(staging.dir, name));
      }
    } else {
      await staging.ensure();
    }
    return null;
  }

  private async conclude(
    job: OnboardingJob,
    run: RunningJob,
    terminal: TerminalCall | null,
    result: AgentRunResult,
  ): Promise<void> {
    if (run.cancelReason !== null) return this.markCancelled(job, run.cancelReason);
    if (this.stopping) return this.failJob(job, "interrupted by shutdown; click Retry");
    if (terminal?.kind === "blocked") {
      job.state = "awaiting_user";
      job.reason = terminal.reason;
      job.requestedAction = terminal.requestedAction;
      job.pendingHosts = terminal.pendingHosts ?? [];
      job.blockKind = terminal.blockKind ?? "other";
      await this.save(job);
      this.appendLog(
        job,
        "job",
        "warn",
        `Waiting for the user (${job.blockKind}): ${terminal.reason} — ${terminal.requestedAction}`,
      );
      return;
    }
    if (terminal?.kind === "failure") return this.failJob(job, terminal.reason);
    if (terminal?.kind === "finish") {
      job.summary = terminal.summary;
      return this.complete(job, run);
    }
    const reason =
      result.outcome === "max_turns"
        ? `the agent used all its turns (${result.turns}) without finishing`
        : result.outcome === "error"
          ? `agent error: ${result.message ?? "unknown"}`
          : result.outcome === "aborted"
            ? "the agent run was aborted"
            : "the agent ended without calling finish";
    return this.failJob(job, reason);
  }

  /** The service's own gate: full validation of staging, then promotion (never the agent's claim). */
  private async complete(job: OnboardingJob, run: RunningJob): Promise<void> {
    const key = job.key as string;
    const unapproved = (await this.scopeOf(job)).needsApproval;
    if (unapproved.length > 0) {
      const pause = hostApprovalRequest(job.hostnames, unapproved, jobLang(job));
      return this.conclude(
        job,
        run,
        { kind: "blocked", ...pause, pendingHosts: unapproved, blockKind: "other" },
        { sessionId: null, outcome: "completed", message: null, turns: 0, costUsd: null },
      );
    }
    this.appendLog(
      job,
      "job",
      "info",
      "The agent finished; running the full validation of the staged adapter",
    );
    let report;
    try {
      // The promotion gate runs even while the site cools down (it is the decisive check).
      report = await this.o.validation.full(key, run.abort.signal, { ignoreCooldown: true });
    } catch (error) {
      if (run.cancelReason !== null) return this.markCancelled(job, run.cancelReason);
      return this.failJob(job, `validation could not run: ${errorToOutcome(error).message ?? String(error)}`);
    }
    job.validation = summarizeReport(report);
    if (run.cancelReason !== null) return this.markCancelled(job, run.cancelReason);
    if (!report.passed) {
      const f = report.failure;
      return this.failJob(
        job,
        `validation failed at ${f?.step ?? "?"} [${f?.status ?? "?"}]: ${f?.message ?? "unknown"}`,
      );
    }
    this.appendLog(job, "job", "info", `Validation passed: ${job.validation}`);
    const promoted = await this.o.operations.promote(key, job.kind);
    if (!promoted.ok) return this.failJob(job, `promotion failed: ${promoted.reason}`);
    job.state = "succeeded";
    job.finishedAt = this.nowIso();
    job.commit = promoted.commit.committed ? (promoted.commit.commit ?? null) : null;
    await this.save(job);
    this.appendLog(
      job,
      "job",
      "info",
      `Promoted: site "${key}" is active (${promoted.action}); ${
        promoted.commit.committed
          ? `committed ${promoted.commit.commit ?? ""}`
          : `not committed (${promoted.commit.reason ?? "disabled"})`
      }`,
    );
  }

  private async failJob(job: OnboardingJob, reason: string): Promise<void> {
    job.state = "failed";
    job.reason = reason;
    job.requestedAction = null;
    job.blockKind = "other";
    job.finishedAt = this.nowIso();
    await this.save(job);
    this.appendLog(job, "job", "error", `Failed: ${reason}`);
    // An Add leaves the site failed (Retry or Remove offered); a Repair leaves the site untouched.
    if (job.kind === "add" && job.key !== null && this.o.registry.get(job.key)?.status === "onboarding") {
      await this.o.registry.markOnboardingFailed(job.key, reason);
    }
  }

  private async markCancelled(job: OnboardingJob, reason: string): Promise<void> {
    job.state = "cancelled";
    job.reason = reason;
    job.requestedAction = null;
    job.blockKind = "other";
    job.finishedAt = this.nowIso();
    await this.save(job);
    this.appendLog(job, "job", "warn", `Cancelled: ${reason}`);
    if (job.kind === "add" && job.key !== null && this.o.registry.get(job.key)?.status === "onboarding") {
      await this.o.registry.markOnboardingFailed(job.key, reason);
    }
  }

  private onAgentEvent(job: OnboardingJob, event: AgentEvent): void {
    switch (event.type) {
      case "session":
        this.appendLog(
          job,
          "job",
          "info",
          `Agent session ${event.sessionId} (model ${event.model}, auth: ${describeAuth(event.authSource)})`,
        );
        break;
      case "text":
        if (event.text.trim() !== "") this.appendLog(job, "agent", "info", event.text.trim());
        break;
      case "warning":
        this.appendLog(job, "job", "warn", event.message);
        break;
    }
  }

  /** A summary of the earlier runs for a new session (when the old one cannot be resumed). */
  private async priorSummary(job: OnboardingJob): Promise<string> {
    await this.flush();
    const lines = await this.o.store.readLog(job.id);
    const text = lines
      .slice(-80)
      .map((l) => `- [${l.source}] ${l.message.replace(/\s+/g, " ").slice(0, 300)}`)
      .join("\n");
    return text.length > 8000 ? text.slice(-8000) : text;
  }

  // -------------------------------------------------------------------------------------------
  // Internals shared with RunHost
  // -------------------------------------------------------------------------------------------

  /** @internal */
  stagingFiles(key: string): StagingFiles {
    return new StagingFiles({
      siteDir: this.o.registry.siteDir(key),
      stagingDir: this.o.registry.stagingDir(key),
      key,
    });
  }

  /** @internal */
  get options(): OnboardingJobServiceOptions {
    return this.o;
  }

  /** @internal Browser scope of a job (see ./agent-browser.ts). */
  async scopeOf(job: OnboardingJob): Promise<ResolvedScope> {
    const key = job.key as string;
    const live = this.o.registry.manifestOf(key);
    const staged = await stagedHints(this.o.registry.stagingDir(key));
    const otherSites = new Map<string, string[]>();
    for (const s of this.o.registry.list()) {
      if (s.key !== key) otherSites.set(s.key, [...new Set([...s.hostnames, ...s.provisionalHostnames])]);
    }
    return resolveAgentScope({
      provisional: job.hostnames,
      declared: [...(live?.hostnames ?? []), ...(live?.extraAllowedHosts ?? [])],
      staged: staged.hosts,
      approved: job.approvedHosts,
      otherSites,
    });
  }

  /** @internal */
  async minIntervalOf(job: OnboardingJob): Promise<number> {
    const key = job.key as string;
    const staged = await stagedHints(this.o.registry.stagingDir(key));
    return (
      staged.minIntervalMs ??
      this.o.registry.manifestOf(key)?.minIntervalMs ??
      this.o.defaultMinIntervalMs ??
      1500
    );
  }

  /** @internal Bare-name Add: the agent named the homepage. */
  async resolveSite(
    job: OnboardingJob,
    url: string,
  ): Promise<{ ok: true; key: string; hostnames: string[] } | { ok: false; message: string }> {
    const hostname = addInputHostname(url) ?? toHostname(url);
    const problem = checkPublicHostname(hostname);
    if (problem !== null) return { ok: false, message: problem };
    const check = this.o.registry.checkAddHostname(hostname);
    if (!check.ok) return { ok: false, message: check.message };
    let site: RegistrySite;
    try {
      site = await this.o.registry.registerOnboarding({ hostnames: [check.hostname] });
    } catch (error) {
      return { ok: false, message: errorToOutcome(error).message ?? String(error) };
    }
    job.key = site.key;
    job.hostnames = [check.hostname];
    await this.save(job);
    await this.stagingFiles(site.key).ensure();
    this.appendLog(
      job,
      "job",
      "info",
      `Resolved "${job.input}" to ${check.hostname}; site "${site.key}" is onboarding`,
    );
    return { ok: true, key: site.key, hostnames: [check.hostname] };
  }

  /** @internal Appends a log line (ordered with record writes) and notifies subscribers. */
  appendLog(job: OnboardingJob, source: JobLogSource, level: JobLogLevel, message: string): void {
    const at = this.nowIso();
    const text = redactSecrets(
      message.length > MAX_LOG_MESSAGE ? `${message.slice(0, MAX_LOG_MESSAGE)}…` : message,
    );
    const id = job.id;
    if (source === "job") this.logger.info(`onboarding: ${text}`, { job: id, site: job.key });
    else this.logger.debug(`onboarding ${source}: ${text.slice(0, 300)}`, { job: id, site: job.key });
    void this.writes.run(async () => {
      let seq = this.seqs.get(id);
      if (seq === undefined) {
        const existing = await this.o.store.readLog(id).catch(() => []);
        seq = existing.at(-1)?.seq ?? 0;
      }
      seq += 1;
      this.seqs.set(id, seq);
      const line: JobLogLine = { seq, at, level, source, message: text };
      try {
        await this.o.store.appendLog(id, line);
      } catch (error) {
        this.logger.warn("job log write failed", { job: id, error: (error as Error).message });
      }
      this.emit({ type: "log", jobId: id, line });
    });
  }

  private async save(job: OnboardingJob): Promise<void> {
    job.updatedAt = this.nowIso();
    this.jobs.set(job.id, job);
    const copy = structuredClone(job);
    await this.writes.run(async () => {
      await this.o.store.save(copy);
      this.emit({ type: "job", job: copy });
    });
  }

  private emit(event: JobEvent): void {
    const id = event.type === "log" ? event.jobId : event.job.id;
    for (const cb of [...(this.jobListeners.get(id) ?? []), ...this.allListeners]) {
      try {
        cb(event);
      } catch (error) {
        this.logger.warn("job event listener failed", { error: (error as Error).message });
      }
    }
  }

  private async flush(): Promise<void> {
    await this.writes.run(async () => undefined);
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async waitFor(p: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  private newJob(input: {
    kind: JobKind;
    key: string | null;
    input: string;
    note: string | null;
    hostnames: string[];
    lang: HelperLang;
  }): OnboardingJob {
    const at = this.nowIso();
    return {
      version: 1,
      id: (this.o.newId ?? (() => defaultId(this.clock)))(),
      kind: input.kind,
      key: input.key,
      input: input.input,
      note: input.note,
      hostnames: input.hostnames,
      state: "queued",
      reason: null,
      requestedAction: null,
      summary: null,
      validation: null,
      lastFailure: null,
      sessionId: null,
      attempts: 0,
      approvedHosts: [],
      pendingHosts: [],
      lang: input.lang,
      runtime: null,
      blockKind: "other",
      commit: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      finishedAt: null,
    };
  }

  private latest(key: string): OnboardingJob | undefined {
    const list = this.jobsFor(key);
    return list[list.length - 1];
  }

  /** The site's jobs, oldest first. */
  private jobsFor(key: string): OnboardingJob[] {
    return [...this.jobs.values()]
      .filter((j) => j.key === key)
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id),
      );
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

function describeAuth(source: string): string {
  if (source === "ANTHROPIC_API_KEY") return "API key (ANTHROPIC_API_KEY)";
  if (source === "none") return "Claude Code login";
  return source;
}

/** The {@link ToolHost} of one run. */
class RunHost implements ToolHost {
  readonly kind: JobKind;
  readonly references: ReferenceLibrary;
  private terminalCall: TerminalCall | null = null;
  private agentBrowser: AgentBrowser | null = null;

  constructor(
    private readonly service: OnboardingJobService,
    private readonly job: OnboardingJob,
    readonly signal: AbortSignal,
  ) {
    this.kind = job.kind;
    const o = service.options;
    this.references = new ReferenceLibrary({
      repoRoot: o.repoRoot,
      sitesDir: o.sitesDir,
      repairSite: job.kind === "repair" ? job.key : null,
    });
  }

  get validation(): StagingValidation {
    return this.service.options.validation;
  }

  key(): string | null {
    return this.job.key;
  }

  browser(): AgentBrowser {
    if (this.job.key === null) throw new Error("the site is not resolved yet");
    if (this.agentBrowser === null) {
      const o = this.service.options;
      this.agentBrowser = new AgentBrowser({
        browser: o.browser,
        scheduler: o.scheduler,
        key: this.job.key,
        holder: this.job.kind === "repair" ? "repair running" : "onboarding running",
        scope: () => this.service.scopeOf(this.job),
        minIntervalMs: () => this.service.minIntervalOf(this.job),
        stepBudgetMs: o.stepBudgetMs ?? 150_000,
        signal: this.signal,
        note: (m) => this.log("job", "info", m),
        pauseForApproval: (hosts) => this.pauseForApproval(hosts),
        challengeBudgetMs: o.captchaAttemptBudgetMs,
        challengesEnabled: o.captchaAuto,
      });
    }
    return this.agentBrowser;
  }

  staging(): StagingFiles {
    if (this.job.key === null) throw new Error("the site is not resolved yet");
    return this.service.stagingFiles(this.job.key);
  }

  resolveSite(url: string) {
    return this.service.resolveSite(this.job, url);
  }

  terminal(): TerminalCall | null {
    return this.terminalCall;
  }

  setTerminal(call: TerminalCall): void {
    this.terminalCall ??= call;
  }

  log(source: JobLogSource, level: JobLogLevel, message: string): void {
    this.service.appendLog(this.job, source, level, message);
  }

  jobActive(): boolean {
    return !this.signal.aborted && this.job.state === "running";
  }

  async requireApprovedHosts(): Promise<void> {
    if (this.job.key === null) return;
    const hosts = (await this.service.scopeOf(this.job)).needsApproval;
    if (hosts.length === 0) return;
    this.pauseForApproval(hosts);
    throw new OutcomeError("adapter_error", approvalPauseMessage(hosts));
  }

  private pauseForApproval(hosts: readonly string[]): void {
    const pause = hostApprovalRequest(this.job.hostnames, hosts, jobLang(this.job));
    this.setTerminal({ kind: "blocked", ...pause, pendingHosts: [...hosts], blockKind: "other" });
  }

  async dispose(): Promise<void> {
    const b = this.agentBrowser;
    this.agentBrowser = null;
    await b?.reset();
  }
}
