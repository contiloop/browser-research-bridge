/**
 * The ChatGPT connection service: the server side of "Connect ChatGPT". It ties the
 * settings store (the managed marker and `oauth.extraResources`), the connection tool port
 * (`tunnel-client`: key file, profile, managed child), and run-mode control (restart, and the hooks
 * that run the tool with the core) together.
 *
 * States: `not_configured` (no marker, no tunnel address), `external` (a tunnel address in the
 * accepted resources without the marker: made by hand, never started, stopped, or altered here),
 * and for a program-managed connection `stopped` (the core is off), `starting`, `ready`, `failed`.
 *
 * Secrets: the runtime key is passed to the tool's `prepare` once and never kept, logged, or returned.
 * Every message comes from this module or from the tool port, whose messages never hold a secret.
 */
import { existsSync, rmSync } from "node:fs";
import type { Clock } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import type {
  ConnectionTool,
  ConnectionToolInfo,
  PrepareConnectionResult,
} from "../ports/connection-tool.js";
import type { Logger } from "../ports/logger.js";
import type {
  ChatgptConnectionSetting,
  ConfigLoadResult,
  EnvironmentMap,
  SettingsView,
  SettingsWriteResult,
} from "../ports/settings-store.js";
import type { BridgeServices } from "./app.js";
import { loadConfigResult } from "./config.js";
import type { BridgeConfig } from "./config.js";
import type { RestartOptions, RestartResult, RunStatus, RunningCore, CoreHook } from "./run-mode.js";
import { RunModeBusyError } from "./run-mode.js";
import type { BridgeSettingsStore } from "./settings.js";

/** Where ChatGPT's tunnel service addresses this bridge; the tunnel id follows. Observed at acceptance; OpenAI may change it. */
export const DEFAULT_TUNNEL_RESOURCE_PREFIX =
  "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/";
export const DEFAULT_PROFILE_NAME = "browser-research-bridge";
/** The tunnel id as the platform shows it: `tunnel_` + 32 lowercase hexadecimal characters. */
export const SETUP_TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
export const PROFILE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const DETECT_CACHE_MS = 5000;

export type ChatgptState = "not_configured" | "external" | "stopped" | "starting" | "ready" | "failed";

/** `GET chatgpt`. Never holds a secret. */
export interface ChatgptStatus {
  tool: ConnectionToolInfo;
  state: ChatgptState;
  managedBy: "bridge" | "external" | null;
  tunnelId: string | null;
  profile: string | null;
  /** The managed profile's key file exists (always false when not program-managed). */
  keyStored: boolean;
  /** The last failure in a sentence, or null. */
  message: string | null;
  /** Connected apps holding at least one live token; null when the core is off. */
  connectedApps: number | null;
}

export interface ChatgptSetupInput {
  tunnelId?: unknown;
  runtimeKey?: unknown;
  profile?: unknown;
  replace?: unknown;
}

export const CHATGPT_FIELD_CODES = ["empty", "bad_format", "bad_value"] as const;
export type ChatgptFieldCode = (typeof CHATGPT_FIELD_CODES)[number];

/**
 * Error codes for the API: `invalid` (400, with `fields`), `tool_missing`, `exists`, `busy`,
 * `external`, `not_configured`, `file_unreadable`, `locked` (409), `not_running` (503),
 * `config_invalid` (409: the public side's address cannot be worked out from the configuration),
 * `prepare_failed` (500: the key file or profile could not be written; `kind` says which).
 */
export const CHATGPT_ERROR_CODES = [
  "invalid",
  "tool_missing",
  "exists",
  "busy",
  "external",
  "not_configured",
  "not_running",
  "file_unreadable",
  "locked",
  "config_invalid",
  "prepare_failed",
] as const;
export type ChatgptErrorCode = (typeof CHATGPT_ERROR_CODES)[number];

export interface ChatgptFailure {
  ok: false;
  error: ChatgptErrorCode;
  message: string;
  fields?: Partial<Record<"tunnelId" | "runtimeKey" | "profile", ChatgptFieldCode>>;
  /** For `prepare_failed`: the tool port's failure kind (`key_write_failed`, `profile_failed`, `invalid_input`). */
  kind?: string;
}

/** The restart a setup or disconnect triggered, once it has ended. Never rejects. */
export interface ChatgptRestartOutcome {
  status: RunStatus;
}

/**
 * Accepted: the files are written and the restart is under way (the API answers 202 now);
 * `done` resolves when the restart has ended.
 */
export interface ChatgptAccepted {
  ok: true;
  done: Promise<ChatgptRestartOutcome>;
}

export type ChatgptSetupResult = ChatgptAccepted | ChatgptFailure;
export type ChatgptDisconnectResult = ChatgptAccepted | ChatgptFailure;
export type ChatgptRetryResult = { ok: true; started: boolean; state: ChatgptState } | ChatgptFailure;

export type McpTargetResult = { ok: true; url: string } | { ok: false; message: string };

/** The run-mode control the service needs (`RunModeController`). */
export interface ChatgptRunControl {
  status(): RunStatus;
  isBusy(): boolean;
  services(): BridgeServices | null;
  restart(options?: RestartOptions): Promise<RestartResult>;
  onCoreStarted(hook: CoreHook): () => void;
  onCoreStopping(hook: CoreHook): () => void;
}

export interface ChatgptConnectionServiceOptions {
  tool: ConnectionTool;
  settings: Pick<BridgeSettingsStore, "read" | "write">;
  controller: ChatgptRunControl;
  /** The MCP address the tool's profile targets (the public side); see {@link createConfigTargetResolver}. */
  target: () => McpTargetResult;
  logger: Logger;
  clock?: Clock | undefined;
  /** Tunable; default {@link DEFAULT_TUNNEL_RESOURCE_PREFIX}. */
  tunnelResourcePrefix?: string | undefined;
  /** File existence check for `keyStored` and cleanup (tests may replace it). */
  fileExists?: ((path: string) => boolean) | undefined;
}

/**
 * The address the connection tool forwards to: the public side's `/mcp`, spelled like the address
 * the bridge advertises when that is this machine's public port over plain http (so the OAuth
 * endpoints the tool reads from the bridge's metadata are on the same origin it targets), else the
 * loopback address of the public port.
 */
export function mcpTargetUrl(config: Pick<BridgeConfig, "publicPort" | "publicUrl">): string {
  try {
    const url = new URL(config.publicUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const port = url.port === "" ? 80 : Number(url.port);
    if (url.protocol === "http:" && loopback && port === config.publicPort) return `${url.origin}/mcp`;
  } catch {
    // fall through to the loopback address
  }
  return `http://127.0.0.1:${config.publicPort}/mcp`;
}

export interface ConfigTargetResolverOptions {
  store: Pick<BridgeSettingsStore, "loadConfig">;
  /**
   * In setup mode the configuration may not load because the passphrase is missing or short; the
   * public port and `PUBLIC_URL` are then read with this environment and a placeholder passphrase
   * (used for nothing else).
   */
  fallback?: { env: EnvironmentMap; rootDir: string; configPath?: string | undefined } | undefined;
}

const PLACEHOLDER_PASSPHRASE = "placeholder-not-a-passphrase";

/** Resolves the target from the current files: the store's configuration, or the fallback in setup mode. */
export function createConfigTargetResolver(options: ConfigTargetResolverOptions): () => McpTargetResult {
  return () => {
    let loaded: ConfigLoadResult<BridgeConfig>;
    try {
      loaded = options.store.loadConfig();
    } catch (error) {
      return { ok: false, message: `cannot read the configuration: ${errorMessage(error)}` };
    }
    if (loaded.ok) return { ok: true, url: mcpTargetUrl(loaded.config) };
    const passphraseProblem =
      loaded.problem.code === "passphrase_missing" || loaded.problem.code === "passphrase_too_short";
    if (passphraseProblem && options.fallback) {
      const { env, rootDir, configPath } = options.fallback;
      const retry = loadConfigResult({
        env: { ...env, BRIDGE_PASSPHRASE: PLACEHOLDER_PASSPHRASE },
        rootDir,
        ...(configPath === undefined ? {} : { configPath }),
      });
      if (retry.ok) return { ok: true, url: mcpTargetUrl(retry.config) };
      return { ok: false, message: retry.problem.message };
    }
    return { ok: false, message: loaded.problem.message };
  };
}

type Connection =
  | { kind: "none" }
  | { kind: "external"; tunnelId: string | null }
  | { kind: "managed"; marker: ChatgptConnectionSetting };

export class ChatgptConnectionService {
  private readonly o: ChatgptConnectionServiceOptions;
  private readonly clock: Clock;
  private readonly prefix: string;
  private readonly fileExists: (path: string) => boolean;
  private detected: { at: number; info: ConnectionToolInfo } | null = null;
  private readonly unsubscribe: (() => void)[];

  constructor(options: ChatgptConnectionServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.prefix = options.tunnelResourcePrefix ?? DEFAULT_TUNNEL_RESOURCE_PREFIX;
    this.fileExists = options.fileExists ?? existsSync;
    this.unsubscribe = [
      options.controller.onCoreStarted((core) => this.onCoreStarted(core)),
      options.controller.onCoreStopping(() => this.onCoreStopping()),
    ];
  }

  /** The tunnel's address in the accepted resources. */
  tunnelAddress(tunnelId: string): string {
    return `${this.prefix}${tunnelId}`;
  }

  /** `GET chatgpt`. Answers in every mode. */
  async state(): Promise<ChatgptStatus> {
    const tool = await this.detect(false);
    const connection = this.classify(this.o.settings.read());
    const services = this.o.controller.services();
    const connectedApps = services === null ? null : await this.countConnectedApps(services);
    const base = { tool, connectedApps };
    if (connection.kind === "none") {
      return {
        ...base,
        state: "not_configured",
        managedBy: null,
        tunnelId: null,
        profile: null,
        keyStored: false,
        message: null,
      };
    }
    if (connection.kind === "external") {
      return {
        ...base,
        state: "external",
        managedBy: "external",
        tunnelId: connection.tunnelId,
        profile: null,
        keyStored: false,
        message: null,
      };
    }
    const { marker } = connection;
    const { state, message } = this.managedState(services !== null);
    return {
      ...base,
      state,
      managedBy: "bridge",
      tunnelId: marker.tunnelId,
      profile: marker.profile,
      keyStored: this.keyStored(marker.profile),
      message,
    };
  }

  /**
   * `POST chatgpt/setup`: validate → tool installed → (exclusive) the tool's `prepare` → write the
   * address and the marker → restart the core; the tool starts from the core-started hook. A failure
   * before the restart leaves the settings unchanged and removes the files this call created.
   * Allowed in setup mode (the files are written and a start of the core is attempted).
   */
  async setup(input: ChatgptSetupInput): Promise<ChatgptSetupResult> {
    const checked = validateSetupInput(input);
    if (!checked.ok) return checked;
    const { tunnelId, runtimeKey, profile, replace } = checked;
    if (this.o.controller.isBusy()) return busy();
    const info = await this.detect(true);
    if (!info.installed) {
      return {
        ok: false,
        error: "tool_missing",
        message: "the connection tool (tunnel-client) is not installed",
      };
    }
    const unreadable = configFileProblem(this.o.settings.read());
    if (unreadable) return unreadable;
    const target = this.o.target();
    if (!target.ok) {
      return {
        ok: false,
        error: "config_invalid",
        message: `the bridge's public address cannot be worked out: ${target.message}`,
      };
    }

    return this.restartAfter("chatgpt setup", async () => {
      const paths = this.o.tool.paths(profile);
      const existed = { profile: this.fileExists(paths.profileFile), key: this.fileExists(paths.keyFile) };
      const prepared = await this.o.tool.prepare({
        tunnelId,
        runtimeKey,
        profileName: profile,
        targetMcpUrl: target.url,
        replace,
      });
      if (!prepared.ok) return prepareFailure(prepared);

      const view = this.o.settings.read();
      const previous = view.chatgpt?.managed === true ? view.chatgpt : null;
      const address = this.tunnelAddress(tunnelId);
      const remove =
        previous !== null && previous.tunnelId !== tunnelId ? [this.tunnelAddress(previous.tunnelId)] : [];
      let written: SettingsWriteResult;
      try {
        written = await this.o.settings.write({
          chatgpt: { managed: true, tunnelId, profile },
          oauthExtraResources: { add: [address], remove },
        });
      } catch (error) {
        written = {
          ok: false,
          error: "file_unreadable",
          file: "config/bridge.json",
          message: errorMessage(error),
        };
      }
      if (!written.ok) {
        await this.removeCreated(profile, existed);
        return writeFailure(written);
      }
      this.o.logger.info("chatgpt connection set up", { tunnelId, profile, target: target.url });
      return null;
    });
  }

  /** `POST chatgpt/retry`: start the managed tool again when it is `failed` (or stopped while the core runs). */
  async retry(): Promise<ChatgptRetryResult> {
    const connection = this.classify(this.o.settings.read());
    const refused = refuseUnmanaged(connection);
    if (refused) return refused;
    if (connection.kind !== "managed") return notConfigured();
    if (this.o.controller.services() === null) {
      return { ok: false, error: "not_running", message: "the bridge's core is not running" };
    }
    const current = this.managedState(true).state;
    if (current === "starting" || current === "ready") return { ok: true, started: false, state: current };
    this.o.tool.start(connection.marker.profile);
    this.o.logger.info("chatgpt connection tool started again", { profile: connection.marker.profile });
    return { ok: true, started: true, state: this.managedState(true).state };
  }

  /**
   * `DELETE chatgpt`: stop the managed tool → delete its key file → remove the tunnel's address and
   * the marker → restart the core. Refused for `external` and `not_configured`. The profile file is left.
   */
  async disconnect(): Promise<ChatgptDisconnectResult> {
    const refused = refuseUnmanaged(this.classify(this.o.settings.read()));
    if (refused) return refused;
    if (this.o.controller.isBusy()) return busy();
    const unreadable = configFileProblem(this.o.settings.read());
    if (unreadable) return unreadable;

    return this.restartAfter("chatgpt disconnect", async () => {
      const connection = this.classify(this.o.settings.read());
      const again = refuseUnmanaged(connection);
      if (again) return again;
      if (connection.kind !== "managed") return notConfigured();
      const { marker } = connection;
      await this.o.tool.stop();
      await this.o.tool.removeKey(marker.profile);
      let written: SettingsWriteResult;
      try {
        written = await this.o.settings.write({
          chatgpt: null,
          oauthExtraResources: { remove: [this.tunnelAddress(marker.tunnelId)] },
        });
      } catch (error) {
        written = {
          ok: false,
          error: "file_unreadable",
          file: "config/bridge.json",
          message: errorMessage(error),
        };
      }
      if (!written.ok) return writeFailure(written);
      this.o.logger.info("chatgpt connection disconnected", {
        tunnelId: marker.tunnelId,
        profile: marker.profile,
      });
      return null;
    });
  }

  /** Removes the hooks (tests). */
  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Runs `step` inside the controller's exclusive section, then restarts. Resolves with the step's
   * failure (no restart), or as soon as the step succeeded with `done` following the restart.
   */
  private restartAfter(
    reason: string,
    step: () => Promise<ChatgptFailure | null>,
  ): Promise<ChatgptAccepted | ChatgptFailure> {
    return new Promise((resolve) => {
      let settled = false;
      const answer = (result: ChatgptAccepted | ChatgptFailure): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      let finish!: (outcome: ChatgptRestartOutcome) => void;
      const done = new Promise<ChatgptRestartOutcome>((r) => (finish = r));
      // A failure is answered once the exclusive section has ended, so the caller can try again at once.
      let failure: ChatgptFailure | null = null;
      const run = this.o.controller.restart({
        reason,
        prepare: async () => {
          failure = await step();
          if (failure) return false;
          answer({ ok: true, done });
          return true;
        },
      });
      run.then(
        (result) => {
          if (failure) answer(failure);
          finish({ status: result.status });
        },
        (error: unknown) => {
          if (error instanceof RunModeBusyError) answer(busy());
          else {
            this.o.logger.warn(`${reason} failed`, { error: errorMessage(error) });
            answer({
              ok: false,
              error: "prepare_failed",
              message: `${reason} failed: ${errorMessage(error)}`,
            });
          }
          finish({ status: this.o.controller.status() });
        },
      );
    });
  }

  private onCoreStarted(core: RunningCore): void {
    const marker = core.config.chatgpt;
    if (marker === null || !marker.managed) return;
    // Only a running core reaches here: it started with a valid passphrase (gate 1).
    this.o.tool.start(marker.profile);
  }

  private async onCoreStopping(): Promise<void> {
    await this.o.tool.stop();
  }

  private managedState(coreRunning: boolean): { state: ChatgptState; message: string | null } {
    if (!coreRunning) return { state: "stopped", message: null };
    const status = this.o.tool.status();
    const failure = status.lastFailure?.message ?? null;
    switch (status.state) {
      case "ready":
        return { state: "ready", message: null };
      case "starting":
        return { state: "starting", message: failure };
      case "failed":
        return { state: "failed", message: failure ?? "the connection tool stopped after repeated failures" };
      case "stopped":
        return { state: "stopped", message: failure };
    }
  }

  private classify(view: SettingsView): Connection {
    if (view.chatgpt !== null && view.chatgpt.managed) return { kind: "managed", marker: view.chatgpt };
    const address = (view.oauthExtraResources ?? []).find((r) => r.startsWith(this.prefix));
    if (address === undefined) return { kind: "none" };
    const id = address.slice(this.prefix.length);
    return { kind: "external", tunnelId: /^tunnel_[0-9a-fA-F]{32}$/.test(id) ? id : null };
  }

  private keyStored(profile: string): boolean {
    try {
      return this.fileExists(this.o.tool.paths(profile).keyFile);
    } catch {
      return false;
    }
  }

  private async detect(fresh: boolean): Promise<ConnectionToolInfo> {
    const now = this.clock.now().getTime();
    if (!fresh && this.detected !== null && now - this.detected.at < DETECT_CACHE_MS)
      return { ...this.detected.info };
    const info = await this.o.tool.detect();
    this.detected = { at: now, info };
    return { ...info };
  }

  private async countConnectedApps(services: BridgeServices): Promise<number | null> {
    try {
      return (await services.oauth.listClients()).filter((c) => c.activeTokens > 0).length;
    } catch (error) {
      this.o.logger.warn("cannot count connected apps", { error: errorMessage(error) });
      return null;
    }
  }

  /** Undo of a prepare whose settings write failed: remove the files that did not exist before. */
  private async removeCreated(profile: string, existed: { profile: boolean; key: boolean }): Promise<void> {
    const paths = this.o.tool.paths(profile);
    try {
      if (!existed.key) await this.o.tool.removeKey(profile);
      if (!existed.profile) rmSync(paths.profileFile, { force: true });
    } catch (error) {
      this.o.logger.warn("chatgpt setup cleanup failed", { profile, error: errorMessage(error) });
    }
    if (existed.key || existed.profile) {
      this.o.logger.warn("chatgpt setup failed after replacing existing files; they were not restored", {
        profile,
      });
    }
  }
}

type ValidSetup = { ok: true; tunnelId: string; runtimeKey: string; profile: string; replace: boolean };

/** The tunnel id and runtime key rules plus the profile name rule. Field codes: `empty`, `bad_format`, `bad_value`. */
export function validateSetupInput(input: ChatgptSetupInput): ValidSetup | ChatgptFailure {
  const fields: NonNullable<ChatgptFailure["fields"]> = {};
  const tunnelId = typeof input.tunnelId === "string" ? input.tunnelId.trim() : "";
  if (input.tunnelId !== undefined && typeof input.tunnelId !== "string") fields.tunnelId = "bad_format";
  else if (tunnelId === "") fields.tunnelId = "empty";
  else if (!SETUP_TUNNEL_ID_PATTERN.test(tunnelId)) fields.tunnelId = "bad_format";

  let runtimeKey = typeof input.runtimeKey === "string" ? input.runtimeKey : "";
  runtimeKey = runtimeKey.replace(/\r?\n$/, "");
  if (input.runtimeKey !== undefined && typeof input.runtimeKey !== "string")
    fields.runtimeKey = "bad_format";
  else if (runtimeKey.trim() === "") fields.runtimeKey = "empty";
  else if (/[\r\n]/.test(runtimeKey)) fields.runtimeKey = "bad_format";

  let profile = DEFAULT_PROFILE_NAME;
  if (input.profile !== undefined && input.profile !== null && input.profile !== "") {
    if (typeof input.profile !== "string" || !PROFILE_NAME_PATTERN.test(input.profile))
      fields.profile = "bad_value";
    else profile = input.profile;
  }
  if (input.replace !== undefined && typeof input.replace !== "boolean") {
    return { ok: false, error: "invalid", message: "replace must be true or false", fields };
  }
  if (Object.keys(fields).length > 0) {
    return { ok: false, error: "invalid", message: `invalid: ${Object.keys(fields).join(", ")}`, fields };
  }
  return { ok: true, tunnelId, runtimeKey, profile, replace: input.replace === true };
}

function refuseUnmanaged(connection: Connection): ChatgptFailure | null {
  if (connection.kind === "external") {
    return {
      ok: false,
      error: "external",
      message: "this ChatGPT connection was set up by hand; the bridge does not manage it",
    };
  }
  if (connection.kind === "none") return notConfigured();
  return null;
}

function notConfigured(): ChatgptFailure {
  return { ok: false, error: "not_configured", message: "no ChatGPT connection is configured" };
}

function busy(): ChatgptFailure {
  return {
    ok: false,
    error: "busy",
    message: "a restart is already in progress; try again when it has finished",
  };
}

function configFileProblem(view: SettingsView): ChatgptFailure | null {
  const file = view.files.configFile;
  if (!file.exists || file.readable) return null;
  return { ok: false, error: "file_unreadable", message: file.problem ?? `${file.path} cannot be read` };
}

function prepareFailure(result: Extract<PrepareConnectionResult, { ok: false }>): ChatgptFailure {
  switch (result.error) {
    case "tool_missing":
      return { ok: false, error: "tool_missing", message: result.message };
    case "exists":
      return { ok: false, error: "exists", message: result.message };
    default:
      return { ok: false, error: "prepare_failed", kind: result.error, message: result.message };
  }
}

function writeFailure(result: Extract<SettingsWriteResult, { ok: false }>): ChatgptFailure {
  switch (result.error) {
    case "file_unreadable":
      return { ok: false, error: "file_unreadable", message: result.message };
    case "locked":
      return { ok: false, error: "locked", message: result.message };
    case "invalid":
      return { ok: false, error: "invalid", message: result.message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
