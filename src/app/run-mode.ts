/**
 * Run-mode control: starts, stops, and restarts the core (everything `createApp` builds: public
 * listener, OAuth, MCP tools, registry, onboarding jobs, health timer, browser port) while the
 * settings page, which lives outside the core, stays up for the life of the process.
 *
 * Modes: `setup` (the core is off; `problem` says why, the public port is not bound), `running`,
 * `restarting` (the core is being stopped and started). Every start reads the configuration again
 * through the settings store (`store.loadConfig()`), so edited files take effect at the next start,
 * and builds a NEW `createApp` instance (a stopped core is never reused). One start/restart at a
 * time; a request while one is in progress is refused with {@link RunModeBusyError}.
 */
import type { Clock } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import { CONFIG_PROBLEM_CODES } from "../core/settings.js";
import type { ConfigLoadResult } from "../ports/settings-store.js";
import type { BridgeApp, BridgeServices, StartOptions, StartedBridge } from "./app.js";
import type { BridgeConfig } from "./config.js";

export type RunMode = "setup" | "running" | "restarting";

/** The three configuration problems of the settings store, plus `start_failed` (the core threw while starting). */
export const RUN_PROBLEM_CODES = [...CONFIG_PROBLEM_CODES, "start_failed"] as const;
export type RunProblemCode = (typeof RUN_PROBLEM_CODES)[number];

export interface RunProblem {
  code: RunProblemCode;
  /** Names the file or value and the reason, or the start error; never a secret. */
  message: string;
}

export interface RunStatus {
  mode: RunMode;
  /** Non-null exactly when `mode` is `setup`. */
  problem: RunProblem | null;
  /** ISO time the core last started successfully, or null. */
  restartedAt: string | null;
}

/** The running core handed to the hooks. */
export interface RunningCore {
  app: BridgeApp;
  services: BridgeServices;
  started: StartedBridge;
  config: BridgeConfig;
}

export type CoreHook = (core: RunningCore) => Promise<void> | void;

export interface RestartOptions {
  /** Logged with the restart (metadata only). */
  reason?: string | undefined;
  /**
   * Runs first, inside the exclusive section (other restarts are refused meanwhile) while the
   * current core, if any, is still up and passed in (e.g. write the settings files, disconnect apps).
   * Returning `false` ends the call without a restart; a throw ends it with nothing changed.
   */
  prepare?: ((services: BridgeServices | null) => Promise<boolean | void>) | undefined;
}

export interface RestartResult {
  /** False when `prepare` returned false (nothing was stopped or started). */
  restarted: boolean;
  status: RunStatus;
}

export interface RunModeControllerOptions {
  /** The settings store (`createSettingsStore`); its `loadConfig()` re-reads the files on every call. */
  settings: { loadConfig(): ConfigLoadResult<BridgeConfig> };
  /** Builds a new, unstarted core (production: `createApp` with the helpers, logger, Aside CLI). */
  createCore: (config: BridgeConfig) => BridgeApp;
  logger: Logger;
  clock?: Clock | undefined;
  /** Passed to every `core.start()` (tests: `publicPort: 0`, `probeBrowser: false`). */
  startOptions?: StartOptions | undefined;
}

/** A start, restart, or save was requested while another one is in progress (the API's 409 `busy`). */
export class RunModeBusyError extends Error {
  override name = "RunModeBusyError";
  readonly code = "busy" as const;
  constructor() {
    super("a restart is already in progress; try again when it has finished");
  }
}

/** A start or restart was requested after `stop()` (process shutdown). */
export class RunModeStoppedError extends Error {
  override name = "RunModeStoppedError";
  readonly code = "stopped" as const;
  constructor() {
    super("the bridge is shutting down");
  }
}

export class RunModeController {
  private readonly options: RunModeControllerOptions;
  private readonly clock: Clock;
  private mode: RunMode = "restarting";
  private problem: RunProblem | null = null;
  private restartedAt: string | null = null;
  private core: RunningCore | null = null;
  private busy = false;
  private cycle: Promise<unknown> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly startedHooks = new Set<CoreHook>();
  private readonly stoppingHooks = new Set<CoreHook>();

  constructor(options: RunModeControllerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  /** A copy of the current mode, problem, and last start time. Before the first `start()` the mode is `restarting`. */
  status(): RunStatus {
    return {
      mode: this.mode,
      problem: this.problem === null ? null : { ...this.problem },
      restartedAt: this.restartedAt,
    };
  }

  /** True while a start, restart (including its `prepare`), or shutdown is in progress. */
  isBusy(): boolean {
    return this.busy || this.stopping !== null;
  }

  /** The running core's services, or null when the core is off (`setup`, `restarting`). */
  services(): BridgeServices | null {
    return this.mode === "running" && this.core !== null ? this.core.services : null;
  }

  /** The running core (app, services, start result, configuration), or null. */
  current(): RunningCore | null {
    return this.mode === "running" ? this.core : null;
  }

  /** Runs after each successful core start (mode is already `running`); awaited, errors are logged. */
  onCoreStarted(hook: CoreHook): () => void {
    this.startedHooks.add(hook);
    return () => this.startedHooks.delete(hook);
  }

  /** Runs before each core stop (the core is still up); awaited, errors are logged. */
  onCoreStopping(hook: CoreHook): () => void {
    this.stoppingHooks.add(hook);
    return () => this.stoppingHooks.delete(hook);
  }

  /** First start of the core; the same procedure as {@link restart} without a core to stop. */
  async start(): Promise<RunStatus> {
    return (await this.restart({ reason: "start" })).status;
  }

  /**
   * Stop the core gracefully → `settings.loadConfig()` → build a new core → start it. A load
   * problem or a start error ends in `setup` with the reason (nothing is rolled back). The busy
   * check happens synchronously when called: a call while another is in progress rejects with
   * {@link RunModeBusyError}, and {@link isBusy} is true as soon as this call returns.
   */
  restart(options: RestartOptions = {}): Promise<RestartResult> {
    if (this.stopping !== null) return Promise.reject(new RunModeStoppedError());
    if (this.busy) return Promise.reject(new RunModeBusyError());
    this.busy = true;
    const run = this.runCycle(options).finally(() => {
      this.busy = false;
      this.cycle = null;
    });
    this.cycle = run;
    return run;
  }

  /** Process shutdown: waits for a cycle in progress, then stops the core. Idempotent; later restarts are refused. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      await this.cycle?.catch(() => undefined);
      if (this.core !== null) {
        this.mode = "restarting";
        await this.stopCore();
      }
    })();
    return this.stopping;
  }

  private async runCycle(options: RestartOptions): Promise<RestartResult> {
    if (options.prepare) {
      const proceed = await options.prepare(this.services());
      if (proceed === false) return { restarted: false, status: this.status() };
    }
    const reason = options.reason ?? "restart";
    this.mode = "restarting";
    this.problem = null;
    this.options.logger.info("core restarting", { reason });
    await this.stopCore();
    if (this.stopping !== null) return { restarted: false, status: this.status() };
    await this.startCore();
    return { restarted: true, status: this.status() };
  }

  private enterSetup(problem: RunProblem): void {
    this.mode = "setup";
    this.problem = problem;
    this.options.logger.warn("core not running (setup mode)", {
      code: problem.code,
      problem: problem.message,
    });
  }

  private async startCore(): Promise<void> {
    const { logger } = this.options;
    let loaded: ConfigLoadResult<BridgeConfig>;
    try {
      loaded = this.options.settings.loadConfig();
    } catch (error) {
      this.enterSetup({
        code: "start_failed",
        message: `cannot read the configuration: ${errorMessage(error)}`,
      });
      return;
    }
    if (!loaded.ok) {
      this.enterSetup({ code: loaded.problem.code, message: loaded.problem.message });
      return;
    }
    const config = loaded.config;
    for (const warning of config.warnings) logger.warn("config warning", { warning });

    let app: BridgeApp | null = null;
    let started: StartedBridge;
    try {
      app = this.options.createCore(config);
      started = await app.start(this.options.startOptions);
    } catch (error) {
      // A failed start may have started jobs, timers, or the browser port before throwing.
      await app?.stop().catch((stopError: unknown) => {
        logger.warn("core cleanup after a failed start failed", { error: errorMessage(stopError) });
      });
      this.enterSetup({
        code: "start_failed",
        message: `the bridge could not start: ${errorMessage(error)}`,
      });
      return;
    }

    const core: RunningCore = { app, services: app.services, started, config };
    this.core = core;
    this.mode = "running";
    this.problem = null;
    this.restartedAt = this.clock.now().toISOString();
    logger.info("core running", {
      publicListener: started.public.url,
      resource: started.resource,
      sites: app.services.registry.list().length,
    });
    await this.runHooks(this.startedHooks, core, "core started hook failed");
  }

  private async stopCore(): Promise<void> {
    const core = this.core;
    if (core === null) return;
    await this.runHooks(this.stoppingHooks, core, "core stopping hook failed");
    this.core = null;
    await core.app.stop().catch((error: unknown) => {
      this.options.logger.warn("core stop failed", { error: errorMessage(error) });
    });
  }

  private async runHooks(hooks: Set<CoreHook>, core: RunningCore, failure: string): Promise<void> {
    for (const hook of [...hooks]) {
      try {
        await hook(core);
      } catch (error) {
        this.options.logger.warn(failure, { error: errorMessage(error) });
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
