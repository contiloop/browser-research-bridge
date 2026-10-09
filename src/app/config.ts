/**
 * Bridge configuration loader. Precedence: environment variables override
 * `config/bridge.json`, which overrides the built-in defaults below (which mirror
 * `config/bridge.example.json`). Refuses to produce a config without a valid passphrase.
 *
 * Dependency-free on purpose (Node built-ins, the pure settings rules of `src/core/settings.ts`, and
 * the shared captcha and assistant defaults of `src/core/defaults.ts`) so the composition root can call
 * it first.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  DEFAULT_ASSISTANT_FAILURE_WINDOW_MS,
  DEFAULT_ASSISTANT_PAUSE_MS,
  DEFAULT_ASSISTANT_TASK_BUDGET_MS,
  DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS,
  DEFAULT_CAPTCHA_DETECT_BUDGET_MS,
  DEFAULT_CAPTCHA_RERUN_RESERVE_MS,
} from "../core/defaults.js";
import {
  ASSISTANT_EFFORTS,
  DEFAULT_ASIDE_ACCOUNT,
  DEFAULT_ASSISTANT_AUTO,
  DEFAULT_ASSISTANT_EFFORT,
  DEFAULT_CAPTCHA_AUTO,
  DEFAULT_HELPER_RUNTIME,
  HELPER_RUNTIME_SETTINGS,
  MIN_PASSPHRASE_LENGTH,
  checkChatgptSetting,
  isAssistantAutoSetting,
  isAssistantEffort,
  isCaptchaAutoSetting,
  isHelperRuntimeSetting,
  passphraseProblem,
  type AssistantEffort,
  type ChatgptConnectionSetting,
  type ConfigProblemCode,
  type HelperRuntimeSetting,
} from "../core/settings.js";
import { isHttpUrl } from "../core/url.js";
import type { ConfigLoadResult, EnvironmentMap, SettingsPageLocation } from "../ports/settings-store.js";

export { MIN_PASSPHRASE_LENGTH };

export interface Tunables {
  searchDefaultLimit: number;
  searchMaxLimit: number;
  searchMaxPage: number;
  searchCacheTtlSeconds: number;
  readCacheTtlSeconds: number;
  pageChainTtlSeconds: number;
  fetchTextMaxChars: number;
  readDocumentsTotalMaxChars: number;
  readDocumentsMinCharsPerItem: number;
  documentMaxChars: number;
  toolCallBudgetMs: number;
  adapterStepTimeoutMs: number;
  /** Tasks of one site that run at once (tool calls share this pool; exclusive tasks hold the site alone). */
  maxConcurrentPerSite: number;
  /** Browser tasks that run at once across all sites. */
  maxConcurrentTasks: number;
  /** Minimum gap between the starts of two tasks on one site. */
  concurrentStaggerMs: number;
  defaultMinIntervalMs: number;
  coolDownSeconds: number;
  warmTabTtlSeconds: number;
  /** Time one automatic captcha attempt may take. */
  captchaAttemptBudgetMs: number;
  /**
   * Detection budget of one captcha attempt: from the start of the attempt (after the scheduler slot)
   * through the reload, the interstitial wait, and detection. A tool call attempts inline only with
   * this plus `captchaRerunReserveMs` left.
   */
  captchaDetectBudgetMs: number;
  /** Tool-call budget kept back for re-running the call after a solved captcha. */
  captchaRerunReserveMs: number;
  /** Time one Aside AI task (pass a human check, log in again) may take before it is stopped. */
  assistantTaskBudgetMs: number;
  /** Window in which repeated Aside AI failures for a site are counted. */
  assistantFailureWindowMs: number;
  /** How long Aside AI tasks for a site pause after repeated failures. */
  assistantPauseMs: number;
  consecutiveAdapterErrorsToDegrade: number;
  healthCheckIntervalSeconds: number;
  minReadChars: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  consentFailuresPerIp: number;
  consentGlobalFailures: number;
  consentLockoutSeconds: number;
  maxRegisteredClients: number;
  clientPurgeAfterDays: number;
}

export interface BridgeSecrets {
  /** `BRIDGE_PASSPHRASE`; at least {@link MIN_PASSPHRASE_LENGTH} characters. */
  readonly passphrase: string;
  /** `ANTHROPIC_API_KEY`, or null to use the local Claude Code login. */
  readonly anthropicApiKey: string | null;
}

export interface BridgeConfig {
  publicPort: number;
  adminPort: number;
  asideAccount: string;
  /** Absolute path. */
  dataDir: string;
  /** Absolute path. */
  sitesDir: string;
  /** Header carrying the real client IP behind the tunnel (e.g. `CF-Connecting-IP`), or null. */
  trustedProxyHeader: string | null;
  redirectUriAllowlist: string[];
  git: { autoCommit: boolean };
  onboarding: {
    model: string;
    effort: string;
    /** `onboarding.runtime`: which product runs the helper (`auto` picks Claude when available, else Codex). */
    runtime: HelperRuntimeSetting;
    /** `onboarding.codexModel`; null uses the Codex CLI's own default. */
    codexModel: string | null;
  };
  /** `config/bridge.json` → `chatgpt`: the program-managed ChatGPT connection, or null (absent or `null`). */
  chatgpt: ChatgptConnectionSetting | null;
  captcha: {
    /** `config/bridge.json` → `captcha.auto` (default true; no environment override). */
    auto: boolean;
  };
  /** The Aside AI assistant (`aside exec`) that passes a human check or logs in again for a site. */
  assistant: {
    /** `config/bridge.json` → `assistant.auto` (default true; no environment override). */
    auto: boolean;
    /** `config/bridge.json` → `assistant.effort`: one of Aside's effort names (default `low`; no environment override). */
    effort: AssistantEffort;
  };
  /** Locations of external executables; each defaults to the name on `PATH`. */
  executables: {
    /** `TUNNEL_CLIENT_BIN`, default `tunnel-client`. */
    tunnelClient: string;
    /** `CODEX_BIN`, default `codex`. */
    codex: string;
  };
  oauth: {
    /**
     * Extra RFC 8707 resource identifiers the OAuth server accepts besides its own `<publicUrl>/mcp`
     * (`config/bridge.json` → `oauth.extraResources`, default `[]`). ChatGPT reaching the bridge through
     * OpenAI's MCP tunnel sends the tunnel URL (e.g. `https://tunnel-service…/v1/mcp/tunnel_…`) as
     * `resource`; list it here so authorization and its tokens are accepted.
     */
    extraResources: string[];
  };
  tunables: Tunables;
  /** Public origin fronting the public listener, without trailing slash (`PUBLIC_URL`; defaults to the local public port). */
  publicUrl: string;
  /** True when `publicUrl` came from `PUBLIC_URL` rather than the local fallback. */
  publicUrlConfigured: boolean;
  /** The config file that was read, or null when none exists. */
  configFile: string | null;
  /** Non-fatal findings (unknown keys) for the caller to log. */
  warnings: string[];
  /**
   * Secret values. Non-enumerable so `JSON.stringify(config)` and `console.log(config)` never print them.
   */
  readonly secrets: BridgeSecrets;
}

export const DEFAULT_TUNABLES: Readonly<Tunables> = Object.freeze({
  searchDefaultLimit: 10,
  searchMaxLimit: 25,
  searchMaxPage: 10,
  searchCacheTtlSeconds: 600,
  readCacheTtlSeconds: 86_400,
  pageChainTtlSeconds: 1800,
  fetchTextMaxChars: 60_000,
  readDocumentsTotalMaxChars: 120_000,
  readDocumentsMinCharsPerItem: 10_000,
  documentMaxChars: 100_000,
  toolCallBudgetMs: 90_000,
  adapterStepTimeoutMs: 120_000,
  maxConcurrentPerSite: 3,
  maxConcurrentTasks: 8,
  concurrentStaggerMs: 500,
  defaultMinIntervalMs: 1500,
  coolDownSeconds: 600,
  warmTabTtlSeconds: 300,
  captchaAttemptBudgetMs: DEFAULT_CAPTCHA_ATTEMPT_BUDGET_MS,
  captchaDetectBudgetMs: DEFAULT_CAPTCHA_DETECT_BUDGET_MS,
  captchaRerunReserveMs: DEFAULT_CAPTCHA_RERUN_RESERVE_MS,
  assistantTaskBudgetMs: DEFAULT_ASSISTANT_TASK_BUDGET_MS,
  assistantFailureWindowMs: DEFAULT_ASSISTANT_FAILURE_WINDOW_MS,
  assistantPauseMs: DEFAULT_ASSISTANT_PAUSE_MS,
  consecutiveAdapterErrorsToDegrade: 3,
  healthCheckIntervalSeconds: 86_400,
  minReadChars: 200,
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2_592_000,
  consentFailuresPerIp: 5,
  consentGlobalFailures: 20,
  consentLockoutSeconds: 900,
  maxRegisteredClients: 50,
  clientPurgeAfterDays: 7,
});

/**
 * Tunables that may also be 0; every other tunable must be positive. `concurrentStaggerMs: 0` turns
 * off the gap between the starts of overlapping tasks on one site.
 */
const ZERO_ALLOWED_TUNABLES: ReadonlySet<string> = new Set<keyof Tunables>(["concurrentStaggerMs"]);

export const DEFAULT_REDIRECT_URI_ALLOWLIST: readonly string[] = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
]);

export class ConfigError extends Error {
  override name = "ConfigError";
  /** Which of the three configuration problems this is; `config_invalid` unless it is about the passphrase. */
  readonly code: ConfigProblemCode;

  constructor(message: string, code: ConfigProblemCode = "config_invalid") {
    super(message);
    this.code = code;
  }
}

export interface LoadConfigOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: EnvironmentMap;
  /** Base directory for relative paths; defaults to `process.cwd()`. */
  rootDir?: string;
  /** Config file path (relative to `rootDir`); defaults to `config/bridge.json`. A missing file means defaults. */
  configPath?: string;
}

type JsonObject = Record<string, unknown>;

const TOP_LEVEL_KEYS = new Set([
  "publicPort",
  "adminPort",
  "asideAccount",
  "dataDir",
  "sitesDir",
  "trustedProxyHeader",
  "redirectUriAllowlist",
  "git",
  "onboarding",
  "oauth",
  "chatgpt",
  "captcha",
  "assistant",
  "tunables",
]);

const DEFAULT_ADMIN_PORT = 8788;
const DEFAULT_DATA_DIR = "data";

export function loadConfig(options: LoadConfigOptions = {}): BridgeConfig {
  const env = options.env ?? process.env;
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const configFile = resolve(rootDir, options.configPath ?? "config/bridge.json");
  const warnings: string[] = [];

  const file = readConfigFile(configFile);
  const json: JsonObject = file ?? {};
  for (const key of Object.keys(json)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown config key "${key}" ignored`);
  }

  const envValue = (name: string): string | undefined => nonBlank(env[name]);

  const publicPort = port(envValue("BRIDGE_PUBLIC_PORT") ?? json["publicPort"] ?? 8787, "publicPort");
  const adminPort = port(
    envValue("BRIDGE_ADMIN_PORT") ?? json["adminPort"] ?? DEFAULT_ADMIN_PORT,
    "adminPort",
  );
  const asideAccount = nonEmptyString(
    envValue("BRIDGE_ASIDE_ACCOUNT") ?? json["asideAccount"] ?? DEFAULT_ASIDE_ACCOUNT,
    "asideAccount",
  );
  const dataDir = absolutePath(
    rootDir,
    nonEmptyString(envValue("BRIDGE_DATA_DIR") ?? json["dataDir"] ?? DEFAULT_DATA_DIR, "dataDir"),
  );
  const sitesDir = absolutePath(rootDir, nonEmptyString(json["sitesDir"] ?? "sites", "sitesDir"));

  const trustedRaw = json["trustedProxyHeader"] ?? null;
  const trustedProxyHeader =
    trustedRaw === null ? null : nonEmptyString(trustedRaw, "trustedProxyHeader").trim();

  const allowRaw = json["redirectUriAllowlist"] ?? DEFAULT_REDIRECT_URI_ALLOWLIST;
  if (
    !Array.isArray(allowRaw) ||
    !allowRaw.every((v): v is string => typeof v === "string" && v.length > 0)
  ) {
    throw new ConfigError("redirectUriAllowlist must be an array of non-empty strings");
  }
  const redirectUriAllowlist = [...allowRaw];

  const gitRaw = objectOrEmpty(json["git"], "git");
  const autoCommit = gitRaw["autoCommit"] ?? true;
  if (typeof autoCommit !== "boolean") throw new ConfigError("git.autoCommit must be a boolean");

  const onboardingRaw = objectOrEmpty(json["onboarding"], "onboarding");
  const onboarding = {
    model: nonEmptyString(onboardingRaw["model"] ?? "claude-opus-5-5", "onboarding.model"),
    effort: nonEmptyString(onboardingRaw["effort"] ?? "high", "onboarding.effort"),
    runtime: helperRuntime(onboardingRaw["runtime"]),
    codexModel:
      (onboardingRaw["codexModel"] ?? null) === null
        ? null
        : nonEmptyString(onboardingRaw["codexModel"], "onboarding.codexModel"),
  };

  const chatgpt = chatgptSetting(json["chatgpt"]);
  const captchaRaw = objectOrEmpty(json["captcha"], "captcha");
  const captchaAuto = captchaRaw["auto"] === undefined ? DEFAULT_CAPTCHA_AUTO : captchaRaw["auto"];
  if (!isCaptchaAutoSetting(captchaAuto)) throw new ConfigError("captcha.auto must be a boolean");
  const captcha = { auto: captchaAuto };
  const assistant = assistantSetting(json["assistant"]);
  const executables = {
    tunnelClient: envValue("TUNNEL_CLIENT_BIN") ?? "tunnel-client",
    codex: envValue("CODEX_BIN") ?? "codex",
  };

  const oauthRaw = objectOrEmpty(json["oauth"], "oauth");
  const extraRaw = oauthRaw["extraResources"] ?? [];
  if (
    !Array.isArray(extraRaw) ||
    !extraRaw.every((v): v is string => typeof v === "string" && isHttpUrl(v))
  ) {
    throw new ConfigError("oauth.extraResources must be an array of absolute http(s) URLs");
  }
  const oauth = { extraResources: [...extraRaw] };

  const tunables: Tunables = { ...DEFAULT_TUNABLES };
  for (const [key, value] of Object.entries(objectOrEmpty(json["tunables"], "tunables"))) {
    if (!(key in DEFAULT_TUNABLES)) {
      warnings.push(`unknown tunable "${key}" ignored`);
      continue;
    }
    const zeroAllowed = ZERO_ALLOWED_TUNABLES.has(key);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (value === 0 && !zeroAllowed)) {
      throw new ConfigError(`tunables.${key} must be a ${zeroAllowed ? "non-negative" : "positive"} number`);
    }
    tunables[key as keyof Tunables] = value;
  }

  const passphrase = env["BRIDGE_PASSPHRASE"] ?? "";
  const problem = passphraseProblem(passphrase);
  if (problem === "empty") {
    throw new ConfigError(
      `BRIDGE_PASSPHRASE is not set; refusing to start (set it in .env, at least ${MIN_PASSPHRASE_LENGTH} characters)`,
      "passphrase_missing",
    );
  }
  if (problem === "too_short") {
    throw new ConfigError(
      `BRIDGE_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters; refusing to start`,
      "passphrase_too_short",
    );
  }

  const publicUrlEnv = envValue("PUBLIC_URL");
  const publicUrl =
    publicUrlEnv === undefined ? `http://localhost:${publicPort}` : normalizePublicUrl(publicUrlEnv);

  const config: Omit<BridgeConfig, "secrets"> = {
    publicPort,
    adminPort,
    asideAccount,
    dataDir,
    sitesDir,
    trustedProxyHeader,
    redirectUriAllowlist,
    git: { autoCommit },
    onboarding,
    chatgpt,
    captcha,
    assistant,
    executables,
    oauth,
    tunables,
    publicUrl,
    publicUrlConfigured: publicUrlEnv !== undefined,
    configFile: file === null ? null : configFile,
    warnings,
  };
  const secrets: BridgeSecrets = Object.freeze({
    passphrase,
    anthropicApiKey: envValue("ANTHROPIC_API_KEY") ?? null,
  });
  Object.defineProperty(config, "secrets", { value: secrets, enumerable: false, writable: false });
  return config as BridgeConfig;
}

/**
 * {@link loadConfig} without throwing: a valid configuration, or the classified problem
 * (`passphrase_missing`, `passphrase_too_short`, `config_invalid`) with the loader's message.
 * Errors other than {@link ConfigError} are programming errors and are rethrown.
 */
export function loadConfigResult(options: LoadConfigOptions = {}): ConfigLoadResult<BridgeConfig> {
  try {
    return { ok: true, config: loadConfig(options) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, problem: { code: error.code, message: error.message } };
  }
}

/**
 * The settings page's port and the data folder, available even when the configuration is invalid:
 * each from the environment override when valid, else from the config file when it is readable and
 * the value is valid, else the built-in default. Never throws.
 */
export function resolveSettingsPageLocation(options: LoadConfigOptions = {}): SettingsPageLocation {
  const env = options.env ?? process.env;
  const rootDir = resolve(options.rootDir ?? process.cwd());
  let json: JsonObject;
  try {
    json = readConfigFile(resolve(rootDir, options.configPath ?? "config/bridge.json")) ?? {};
  } catch {
    json = {};
  }
  const first = <T>(candidates: unknown[], check: (value: unknown) => T, fallback: T): T => {
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      try {
        return check(candidate);
      } catch {
        // invalid here; try the next source
      }
    }
    return fallback;
  };
  const adminPort = first(
    [nonBlank(env["BRIDGE_ADMIN_PORT"]), json["adminPort"]],
    (v) => port(v, "adminPort"),
    DEFAULT_ADMIN_PORT,
  );
  const dataDir = first(
    [nonBlank(env["BRIDGE_DATA_DIR"]), json["dataDir"]],
    (v) => nonEmptyString(v, "dataDir"),
    DEFAULT_DATA_DIR,
  );
  return { adminPort, dataDir: absolutePath(rootDir, dataDir) };
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function helperRuntime(value: unknown): HelperRuntimeSetting {
  if (value === undefined) return DEFAULT_HELPER_RUNTIME;
  if (!isHelperRuntimeSetting(value)) {
    throw new ConfigError(`onboarding.runtime must be one of ${HELPER_RUNTIME_SETTINGS.join(", ")}`);
  }
  return value;
}

/** `assistant` from the config file only: `{ auto?: boolean, effort?: one of Aside's effort names }`. */
function assistantSetting(value: unknown): BridgeConfig["assistant"] {
  const raw = objectOrEmpty(value, "assistant");
  const auto = raw["auto"] === undefined ? DEFAULT_ASSISTANT_AUTO : raw["auto"];
  if (!isAssistantAutoSetting(auto)) throw new ConfigError("assistant.auto must be a boolean");
  const effort = raw["effort"] === undefined ? DEFAULT_ASSISTANT_EFFORT : raw["effort"];
  if (!isAssistantEffort(effort)) {
    throw new ConfigError(`assistant.effort must be one of ${ASSISTANT_EFFORTS.join(", ")}`);
  }
  return { auto, effort };
}

function chatgptSetting(value: unknown): ChatgptConnectionSetting | null {
  const checked = checkChatgptSetting(value);
  if (!checked.ok) {
    throw new ConfigError(
      "chatgpt must be null or { managed: boolean, tunnelId: tunnel_ + 32 hex characters, profile: non-empty string }",
    );
  }
  return checked.value;
}

function readConfigFile(path: string): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new ConfigError(`${path} must contain a JSON object`);
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOrEmpty(value: unknown, name: string): JsonObject {
  if (value === undefined) return {};
  if (!isObject(value)) throw new ConfigError(`${name} must be an object`);
  return value;
}

function port(value: unknown, name: string): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new ConfigError(`${name} must be an integer port between 1 and 65535`);
  }
  return n;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ConfigError(`${name} must be a non-empty string`);
  return value;
}

function absolutePath(rootDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

/** An http(s) origin; a path, query, or fragment would move the OAuth routes away from the tunnel root. */
function normalizePublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("PUBLIC_URL must be an absolute URL such as https://bridge.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ConfigError("PUBLIC_URL must use https");
  if (
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== ""
  ) {
    throw new ConfigError("PUBLIC_URL must be an origin only (no path, query, fragment, or credentials)");
  }
  return url.origin;
}
