/**
 * What the dashboard needs from the bridge. A narrow view of `BridgeServices` so the
 * admin app depends only on these operations and tests can pass fakes; `bridge.services` satisfies
 * it structurally.
 */
import type { HelperCheckResult, HelperRuntimeId, OnboardingJobService } from "../onboarding/index.js";
import type { OAuthServer } from "../oauth/index.js";
import type { RegistrySite } from "../registry/index.js";
import type { BrowserPort } from "../../ports/browser.js";
import type { CacheStats } from "../../ports/cache.js";
import type { Logger } from "../../ports/logger.js";
import type { HealthRunResult } from "../../app/health.js";
import type { ChatgptConnectionService } from "../../app/chatgpt-connection.js";
import type { RunModeController } from "../../app/run-mode.js";
import type { SettingsField, SettingsFieldCode, SettingsStore } from "../../ports/settings-store.js";

export interface DashboardConfig {
  /** Public origin fronting the public listener (`PUBLIC_URL`, or the local fallback). */
  publicUrl: string;
  publicUrlConfigured: boolean;
  /** Loopback port of the admin listener. */
  adminPort: number;
  /** Aside account the browser port is bound to. */
  asideAccount: string;
  /** Absolute path of `data/` (the admin token file lives there). */
  dataDir: string;
}

export interface DashboardDeps {
  config: DashboardConfig;
  logger: Logger;
  registry: { list(): readonly RegistrySite[] };
  jobs: Pick<
    OnboardingJobService,
    | "add"
    | "retry"
    | "retryJob"
    | "repair"
    | "cancelJob"
    | "remove"
    | "list"
    | "get"
    | "getJob"
    | "log"
    | "subscribe"
    | "helperStatus"
    | "helperCheck"
  >;
  health: { runNow(key: string): Promise<HealthRunResult>; isChecking(key: string): boolean };
  oauth: Pick<OAuthServer, "listClients" | "revoke" | "resource">;
  /** Raw cache store: sizes. */
  fileCache: { stats(): Promise<CacheStats>; statsBySite(): Promise<Record<string, CacheStats>> };
  /** Cache with the caching rules: clearing. */
  cache: { clearSite(site: string): Promise<void>; clearAll(): Promise<void> };
  browser: Pick<BrowserPort, "status">;
}

/** The run-mode control the settings page uses (status, restart). */
export type DashboardRunMode = Pick<RunModeController, "status" | "isBusy" | "restart">;

/** The settings store the settings page uses (never returns a secret). */
export type DashboardSettings = Pick<SettingsStore<unknown>, "read" | "write" | "pageLocation">;

/** The ChatGPT connection service the settings page uses (`GET/POST/DELETE chatgpt…`). */
export type DashboardChatgpt = Pick<ChatgptConnectionService, "state" | "setup" | "retry" | "disconnect">;

/** The settings the settings page changes with `PUT settings`. */
export interface PageSettingsChange {
  passphrase?: string;
  helperRuntime?: string;
  asideAccount?: string;
  /** `captcha.auto` in `config/bridge.json`. */
  captchaAuto?: boolean;
}

/**
 * The last helper check of this install, kept outside the core (src/app: `data/helper-check.json`),
 * shared by `POST helper/check` and the automatic check after a core start.
 */
export interface HelperCheckLog {
  /** The last recorded check, or null. No model call. */
  last(): Promise<HelperCheckResult | null>;
  /**
   * Runs one check on this core's job service (one model call; a check already in progress on the
   * same core is shared), records it, and logs metadata only.
   */
  run(jobs: Pick<DashboardDeps["jobs"], "helperCheck">): Promise<HelperCheckResult>;
}

/**
 * What "Copy passphrase" did: the stored passphrase was put on this Mac's clipboard (`ok`), there is
 * no valid passphrase (`not_set`), it is set outside `.env` (`locked`), or the clipboard tool is
 * missing or failed (`unavailable`). Never the value itself.
 */
export type PassphraseClipboardResult = "ok" | "not_set" | "locked" | "unavailable";

/**
 * What a `PUT settings` would do, worked out before anything is written: refused (`locked`,
 * `invalid`, `file_unreadable`) or the fields whose stored value would change (`[]`: nothing to do).
 * The store's own write stays authoritative; this only lets the page answer "no change" and
 * `job_running` without writing first.
 */
export type SettingsPreview =
  | { ok: true; changed: SettingsField[] }
  | {
      ok: false;
      error: "invalid";
      fields: Partial<Record<SettingsField, SettingsFieldCode>>;
      message: string;
    }
  | { ok: false; error: "locked"; fields: Partial<Record<SettingsField, "locked">>; message: string }
  | { ok: false; error: "file_unreadable"; message: string };

/** Read-only information of `GET settings` (`info`); a value the configuration does not yield is null. */
export interface SettingsInfo {
  mcpUrl: string | null;
  publicUrl: string | null;
  publicUrlConfigured: boolean | null;
  publicPort: number | null;
  adminPort: number;
  dataDir: string;
  sitesDir: string | null;
  configFile: string;
  envFile: string;
}

/**
 * The parts of the settings page that work whether or not the core runs (composed in src/app):
 * read-only information, the save preview, the helper runtimes this build ships, and removing every
 * connected app from the token file while the core is off.
 */
export interface SettingsPageSupport {
  info(): SettingsInfo;
  preview(change: PageSettingsChange): SettingsPreview;
  supportedRuntimes(): HelperRuntimeId[];
  /** Deletes every OAuth client with its tokens and codes directly in the token file (core off only). */
  revokeAllAppsOffline(): Promise<void>;
}

/**
 * What the dashboard is built from when it outlives the core: the page's own location and logger,
 * and a provider of the running core's services that returns null while the core is off
 * (`setup`, `restarting`). Routes resolve the services on every request.
 */
export interface DashboardSource {
  logger: Logger;
  /** Where the settings page listens and keeps its token file (fixed for the process). */
  location: { adminPort: number; dataDir: string };
  core(): DashboardDeps | null;
  runMode?: DashboardRunMode | undefined;
  settings?: DashboardSettings | undefined;
  /** Settings-page support (information, save preview, offline app removal). */
  settingsPage?: SettingsPageSupport | undefined;
  /** The ChatGPT connection service; null or absent when no connection tool is wired. */
  chatgpt?: DashboardChatgpt | null | undefined;
  /** The persisted last helper check; absent → kept in memory for the life of the page (tests). */
  helperChecks?: HelperCheckLog | undefined;
  /**
   * "Copy passphrase": puts the stored passphrase on this Mac's clipboard from the server process
   * and answers only what happened. Works whether or not the core runs.
   */
  copyPassphrase?: (() => Promise<PassphraseClipboardResult>) | undefined;
}

/** The core is off; routes that need it answer 503 `not_running`. */
export class CoreNotRunningError extends Error {
  override name = "CoreNotRunningError";
}

export function isDashboardSource(value: DashboardDeps | DashboardSource): value is DashboardSource {
  return typeof (value as Partial<DashboardSource>).core === "function";
}

/** A fixed set of services (tests, or a dashboard bound to one core) as a source. */
export function toDashboardSource(value: DashboardDeps | DashboardSource): DashboardSource {
  if (isDashboardSource(value)) return value;
  return {
    logger: value.logger,
    location: { adminPort: value.config.adminPort, dataDir: value.config.dataDir },
    core: () => value,
  };
}

/**
 * `DashboardDeps` whose fields are looked up through `resolve()` on every access, so a route sees
 * the core that is running when it runs. `resolve` throws {@link CoreNotRunningError} when there is none.
 */
export function lazyDashboardDeps(resolve: () => DashboardDeps): DashboardDeps {
  return new Proxy({} as DashboardDeps, {
    get: (_target, key) => resolve()[key as keyof DashboardDeps],
  });
}
