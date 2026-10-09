/**
 * Core factory: wires config → browser port, scheduler, cache, registry, validator, health timer,
 * captcha coordinator, Aside AI assistant and its task coordinator, OAuth server, MCP tool services,
 * and the public listener. In production the run-mode controller
 * (./run-mode.ts) calls it once per core start with the configuration it just loaded, so a restart
 * always gets a new instance (`stop()` runs once); tests call it with a fake browser and stub
 * adapter helpers.
 *
 * The settings page is not part of the core: it is started once per process (./bridge-process.ts)
 * and reaches the running core's services through the controller. `bridge.attach(listener)` before
 * `bridge.start()` still ties a listener to one core's lifetime (started after the public listener,
 * stopped before it); production does not use it.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Hono } from "hono";
import {
  AsideBrowserPort,
  AsideSiteAssistant,
  InMemoryScheduler,
  McpReplClient,
  stdioTransportFactory,
} from "../adapters/aside/index.js";
import { GitSiteCommitter } from "../adapters/git/index.js";
import type { OnboardingJobService } from "../adapters/onboarding/index.js";
import {
  AssistantTaskCoordinator,
  ChallengeCoordinator,
  ReadService,
  SearchService,
  createBridgeMcpServer,
  createMcpHttpHandler,
} from "../adapters/mcp/index.js";
import type { SiteTaskRunner } from "../adapters/mcp/index.js";
import { createOAuthServer } from "../adapters/oauth/index.js";
import type { FetchLike, OAuthEnv, OAuthServer } from "../adapters/oauth/index.js";
import { ModuleAdapterLoader, SiteRegistryService, runAdapterTask } from "../adapters/registry/index.js";
import type { AdapterRuntime, ReconcileReport } from "../adapters/registry/index.js";
import {
  FileCache,
  FileSiteStateStore,
  FileTokenStore,
  ResultCache,
  cacheDir,
  siteStatePath,
  tokenStorePath,
  ttlsFromTunables,
} from "../adapters/storage/index.js";
import { SiteValidator, createAnonymousFetcher, lightCheck } from "../adapters/validation/index.js";
import type { AdapterHelpers } from "../ports/adapter.js";
import type { SiteAssistant } from "../ports/assistant.js";
import type { BrowserPort } from "../ports/browser.js";
import { systemClock } from "../ports/clock.js";
import type { Clock } from "../ports/clock.js";
import type { LogFields, Logger } from "../ports/logger.js";
import type { SiteManifestSchemaOptions } from "../ports/manifest.js";
import type { BridgeConfig } from "./config.js";
import { HealthChecker } from "./health.js";
import type { HealthRunResult } from "./health.js";
import { createOnboardingJobs } from "./jobs.js";
import type { CreateOnboardingJobsOptions } from "./jobs.js";
import { MCP_PATH, createPublicApp, startListener } from "./public-server.js";
import type { RunningListener } from "./public-server.js";

export interface CreateAppOptions {
  config: BridgeConfig;
  /** The adapter helper API (`createAdapterHelpers()` from src/adapter-kit, injected by main.ts). */
  helpers: AdapterHelpers;
  logger: Logger;
  /** Repository root holding `src/adapter-kit` (default: the process working directory). */
  repoRoot?: string | undefined;
  /** Browser port; default: the Aside REPL port for `config.asideAccount`. */
  browser?: BrowserPort | undefined;
  /** Aside CLI executable for the default browser port and assistant (`ASIDE_CLI`); default `aside`. */
  asideCommand?: string | undefined;
  /**
   * The Aside AI (`aside exec`); default: `AsideSiteAssistant` for `asideCommand`, the data folder, and
   * `assistant.effort`. Tests inject a scripted fake (the real CLI is never run in tests).
   */
  assistant?: SiteAssistant | undefined;
  clock?: Clock | undefined;
  /** Fetch used for OAuth Client ID Metadata Documents (default global fetch). */
  oauthFetch?: FetchLike | undefined;
  /** Onboarding job options (tests inject a scripted agent runner). */
  onboarding?: CreateOnboardingJobsOptions | undefined;
}

/** Everything the bridge is made of; the admin listener and onboarding build on these. */
export interface BridgeServices {
  config: BridgeConfig;
  logger: Logger;
  clock: Clock;
  repoRoot: string;
  helpers: AdapterHelpers;
  browser: BrowserPort;
  scheduler: InMemoryScheduler;
  /** Browser + scheduler + helpers for `runAdapterTask` (validation, onboarding, live calls). */
  runtime: AdapterRuntime;
  /** The raw cache store (`clearSite`, `clearAll`, `stats`). */
  fileCache: FileCache;
  /** Caching rules on top of the store (search pages, documents, page chain). */
  cache: ResultCache;
  loader: ModuleAdapterLoader;
  registry: SiteRegistryService;
  validator: SiteValidator;
  health: HealthChecker;
  /** Captcha attempts after a blocked live call or "Check now" (`captcha.auto` and its tunables). */
  challenges: ChallengeCoordinator;
  /**
   * Aside AI tasks in the background (captcha, login) after live calls and health checks
   * (`assistant.auto`, the Aside account, and the assistant tunables); its last task per site and the
   * probe result feed the settings page.
   */
  assistant: AssistantTaskCoordinator;
  committer: GitSiteCommitter;
  oauth: OAuthServer;
  search: SearchService;
  read: ReadService;
  manifestOptions: SiteManifestSchemaOptions;
  /** Onboarding jobs (Add / Retry / Repair / Remove, job log streaming); see src/app/jobs.ts. */
  jobs: OnboardingJobService;
}

/** A listener attached to the bridge lifecycle (e.g. the admin listener). */
export interface BridgeListener {
  readonly name: string;
  start(): Promise<RunningListener | void>;
  stop(): Promise<void>;
}

export interface StartedBridge {
  public: RunningListener;
  /** Public origin the clients use (`PUBLIC_URL`, or the local fallback). */
  publicUrl: string;
  publicUrlConfigured: boolean;
  /** OAuth protected resource (`publicUrl + /mcp`): the MCP server URL to register in the clients. */
  resource: string;
  reconcile: ReconcileReport;
  /** Attached listeners that reported where they listen. */
  listeners: { name: string; url: string }[];
}

export interface StartOptions {
  /** Overrides `config.publicPort` (0 = any free port; tests). */
  publicPort?: number | undefined;
  /**
   * Probe the browser and the Aside AI's CLI in the background and log whether Aside is reachable
   * (default true). Off, the assistant's availability stays unknown and no task starts.
   */
  probeBrowser?: boolean | undefined;
}

export interface BridgeApp {
  readonly services: BridgeServices;
  readonly publicApp: Hono<OAuthEnv>;
  /** Adds a listener started after the public listener (call before `start`). */
  attach(listener: BridgeListener): void;
  start(options?: StartOptions): Promise<StartedBridge>;
  /**
   * Graceful shutdown: timers, captcha attempts, assistant tasks, onboarding jobs, attached listeners,
   * public listener, browser port. Idempotent.
   */
  stop(): Promise<void>;
}

const OAUTH_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createApp(options: CreateAppOptions): BridgeApp {
  const { config, helpers, logger } = options;
  const { tunables } = config;
  const clock = options.clock ?? systemClock;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const coolDownMs = tunables.coolDownSeconds * 1000;
  const manifestOptions: SiteManifestSchemaOptions = {
    defaultMinReadChars: tunables.minReadChars,
    defaultMinIntervalMs: tunables.defaultMinIntervalMs,
  };

  const scheduler = new InMemoryScheduler({
    maxConcurrentPerSite: tunables.maxConcurrentPerSite,
    maxConcurrentTasks: tunables.maxConcurrentTasks,
    concurrentStaggerMs: tunables.concurrentStaggerMs,
    coolDownMs,
    now: () => clock.now().getTime(),
  });
  const browser =
    options.browser ??
    new AsideBrowserPort({
      repl: new McpReplClient({
        account: config.asideAccount,
        transportFactory: stdioTransportFactory(
          options.asideCommand ? { command: options.asideCommand } : {},
        ),
        logger,
      }),
      logger,
      stepTimeoutMs: tunables.adapterStepTimeoutMs,
      warmTabTtlMs: tunables.warmTabTtlSeconds * 1000,
      // One warm tab per pool place, so parallel calls on a site can each reuse one.
      maxWarmTabsPerSite: tunables.maxConcurrentPerSite,
    });
  const runtime: AdapterRuntime = { browser, scheduler, helpers, logger, clock };

  const fileCache = new FileCache(cacheDir(config.dataDir), { clock });
  const cache = new ResultCache(fileCache, ttlsFromTunables(tunables));
  const loader = new ModuleAdapterLoader({ repoRoot });
  const registry = new SiteRegistryService({
    sitesDir: config.sitesDir,
    stateStore: new FileSiteStateStore(siteStatePath(config.dataDir)),
    loader,
    cache: fileCache,
    scheduler,
    clock,
    logger,
    adapterErrorsToDegrade: tunables.consecutiveAdapterErrorsToDegrade,
    coolDownMs,
    manifestOptions,
  });
  const validator = new SiteValidator({
    sitesDir: config.sitesDir,
    repoRoot,
    loader,
    runtime,
    anonymousFetch: createAnonymousFetcher(),
    loadLive: (key) => registry.load(key),
    hostnameOwner: (hostname) => registry.hostnameOwner(hostname),
    manifestOptions,
    stepBudgetMs: tunables.toolCallBudgetMs,
    clock,
    logger,
  });
  // One coordinator per core: the live tools and "Check now" share each site's single attempt.
  const challenges = new ChallengeCoordinator({
    settings: {
      auto: config.captcha.auto,
      attemptBudgetMs: tunables.captchaAttemptBudgetMs,
      detectBudgetMs: tunables.captchaDetectBudgetMs,
      rerunReserveMs: tunables.captchaRerunReserveMs,
    },
    browser,
    scheduler,
    registry,
    logger,
    clock,
  });
  const siteAssistant =
    options.assistant ??
    new AsideSiteAssistant({
      command: options.asideCommand,
      dataDir: resolve(config.dataDir),
      effort: config.assistant.effort,
      logger,
      now: () => clock.now().getTime(),
    });
  // One coordinator per core: live calls and health checks share each site's single task. A login
  // task's `done` is confirmed by the health checker's light check (built just below; the closure only
  // runs after a task, long after construction).
  const assistant: AssistantTaskCoordinator = new AssistantTaskCoordinator({
    settings: {
      auto: config.assistant.auto,
      account: config.asideAccount,
      taskBudgetMs: tunables.assistantTaskBudgetMs,
      failureWindowMs: tunables.assistantFailureWindowMs,
      pauseMs: tunables.assistantPauseMs,
    },
    assistant: siteAssistant,
    scheduler,
    registry,
    logger,
    clock,
    confirmLogin: (key: string, signal: AbortSignal): Promise<HealthRunResult> =>
      health.confirmLogin(key, signal),
  });
  const health: HealthChecker = new HealthChecker({
    registry,
    scheduler,
    check: lightCheck(validator),
    intervalMs: tunables.healthCheckIntervalSeconds * 1000,
    clock,
    logger,
    challenges,
    assistant,
  });
  const committer = new GitSiteCommitter({
    sitesDir: config.sitesDir,
    enabled: config.git.autoCommit,
    logger,
  });
  const oauth = createOAuthServer({
    publicUrl: config.publicUrl,
    mcpPath: MCP_PATH,
    passphrase: config.secrets.passphrase,
    redirectUriAllowlist: config.redirectUriAllowlist,
    trustedProxyHeader: config.trustedProxyHeader,
    extraResources: config.oauth.extraResources,
    store: new FileTokenStore(tokenStorePath(config.dataDir)),
    logger,
    tunables,
    clock,
    ...(options.oauthFetch ? { fetch: options.oauthFetch } : {}),
  });

  const runSiteTask: SiteTaskRunner = (site, taskOptions, task) =>
    runAdapterTask(runtime, site, taskOptions, task);
  const toolDeps = { registry, runSiteTask, cache, tunables, logger, clock, challenges, assistant };
  const search = new SearchService(toolDeps);
  const read = new ReadService(toolDeps);
  const mcp = createMcpHttpHandler({
    createServer: (clientId) => createBridgeMcpServer({ search, read, registry, logger, clock }, clientId),
    logger,
  });
  const publicApp = createPublicApp({ oauth, mcp, logger });

  const jobs = createOnboardingJobs(
    {
      config,
      logger,
      clock,
      repoRoot,
      browser,
      scheduler,
      registry,
      validator,
      committer,
      manifestOptions,
    },
    options.onboarding,
  );

  const services: BridgeServices = {
    config,
    logger,
    clock,
    repoRoot,
    helpers,
    browser,
    scheduler,
    runtime,
    fileCache,
    cache,
    loader,
    registry,
    validator,
    health,
    challenges,
    assistant,
    committer,
    oauth,
    search,
    read,
    manifestOptions,
    jobs,
  };

  const attached: BridgeListener[] = [];
  const startedAttached: BridgeListener[] = [];
  let publicListener: RunningListener | null = null;
  let purgeTimer: ReturnType<typeof setInterval> | null = null;
  let stopping: Promise<void> | null = null;

  const purgeClients = async (): Promise<void> => {
    try {
      const result = await oauth.purge();
      logger.info("oauth client purge", {
        expiredRecords: result.expiredRecords,
        staleClients: result.staleClients,
      });
    } catch (error) {
      logger.warn("oauth client purge failed", { error: (error as Error).message });
    }
  };

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      health.stop();
      // Running captcha attempts are abandoned; the browser shutdown below closes their tabs.
      challenges.dispose();
      // Running Aside AI tasks are stopped (the assistant stops the Aside session and its child).
      await assistant.dispose();
      if (purgeTimer !== null) clearInterval(purgeTimer);
      await jobs.stop().catch((error: unknown) => {
        logger.warn("onboarding jobs stop failed", { error: (error as Error).message });
      });
      for (const listener of startedAttached.reverse()) {
        await listener.stop().catch((error: unknown) => {
          logger.warn("listener stop failed", { listener: listener.name, error: (error as Error).message });
        });
      }
      await publicListener?.close();
      await browser.shutdown().catch((error: unknown) => {
        logger.warn("browser shutdown failed", { error: (error as Error).message });
      });
    })();
    return stopping;
  };

  return {
    services,
    publicApp,
    attach(listener) {
      if (publicListener !== null) throw new Error("attach listeners before start()");
      attached.push(listener);
    },
    async start(startOptions = {}) {
      if (publicListener !== null) throw new Error("the bridge is already started");
      await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      const reconcile = await registry.init();
      logger.info("site registry ready", {
        sites: registry.list().length,
        registered: reconcile.registered.join(",") || null,
        dropped: reconcile.dropped.join(",") || null,
        failed: reconcile.failed.join(",") || null,
        ignored: reconcile.ignored.map((i) => i.key).join(",") || null,
      });
      await purgeClients();
      // Onboarding jobs: restart reconciliation, then the queue runs (one job at a time).
      await jobs.start();

      publicListener = await startListener(publicApp, {
        port: startOptions.publicPort ?? config.publicPort,
        hostname: "127.0.0.1",
      });
      purgeTimer = setInterval(() => void purgeClients(), OAUTH_PURGE_INTERVAL_MS);
      purgeTimer.unref();
      health.start();

      const listeners: { name: string; url: string }[] = [];
      try {
        for (const listener of attached) {
          const running = await listener.start();
          startedAttached.push(listener);
          if (running) listeners.push({ name: listener.name, url: running.url });
        }
      } catch (error) {
        await stop();
        throw error;
      }

      if (startOptions.probeBrowser !== false) {
        void assistant.probe().then((available) => logger.info("aside assistant probe", { available }));
        void browser.status().then(
          (status) => {
            if (status.reachable) logger.info("browser reachable", { account: status.account });
            else
              logger.warn("browser not reachable; tools report browser_unavailable until it is", {
                account: status.account,
                message: status.message ?? null,
                action: status.action ?? null,
              });
          },
          (error: unknown) => logger.warn("browser probe failed", { error: (error as Error).message }),
        );
      }

      return {
        public: publicListener,
        publicUrl: config.publicUrl,
        publicUrlConfigured: config.publicUrlConfigured,
        resource: oauth.resource,
        reconcile,
        listeners,
      };
    },
    stop,
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVELS;
}

/**
 * Line-oriented console logger: `<ISO time> <LEVEL> <message> {fields}`; info/debug to stdout,
 * warn/error to stderr. Callers pass metadata only (never page content or tokens).
 */
export function createConsoleLogger(
  options: { level?: LogLevel | undefined; clock?: Clock | undefined } = {},
): Logger {
  const min = LEVELS[options.level ?? "info"];
  const clock = options.clock ?? systemClock;
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVELS[level] < min) return;
    const defined = Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined));
    const tail = Object.keys(defined).length > 0 ? ` ${JSON.stringify(defined)}` : "";
    const line = `${clock.now().toISOString()} ${level.toUpperCase()} ${message}${tail}\n`;
    (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
