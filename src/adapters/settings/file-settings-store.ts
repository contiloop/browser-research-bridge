/**
 * File-backed {@link SettingsStore}: `.env` and `config/bridge.json`, edited in place.
 * Reads go to the files on every call; secrets are reported as flags only.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_ASIDE_ACCOUNT,
  DEFAULT_HELPER_RUNTIME,
  checkChatgptSetting,
  isHelperRuntimeSetting,
  passphraseProblem,
  type ChatgptConnectionSetting,
  type HelperRuntimeSetting,
} from "../../core/settings.js";
import { isHttpUrl } from "../../core/url.js";
import type {
  ConfigLoadResult,
  ConfigRules,
  SettingsChange,
  SettingsField,
  SettingsFieldCode,
  SettingsFileState,
  SettingsPageLocation,
  SettingsStore,
  SettingsView,
  SettingsWriteResult,
} from "../../ports/settings-store.js";
import { encodeEnvValue, parseEnvText, setEnvValue } from "./env-file.js";
import { setJsonValue } from "./json-edit.js";
import type { StartupEnvironment } from "./startup-environment.js";

const PASSPHRASE = "BRIDGE_PASSPHRASE";
const ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY";
const ASIDE_ACCOUNT = "BRIDGE_ASIDE_ACCOUNT";
const PUBLIC_URL = "PUBLIC_URL";
const ENV_FILE_MODE = 0o600;
const NEW_CONFIG_FILE_MODE = 0o644;

export interface FileSettingsStoreOptions<C> {
  /** Absolute path of the `.env` the process starts from. */
  envFile: string;
  /** Absolute path of `config/bridge.json`. */
  configFile: string;
  /** Captured once at process start. */
  startup: StartupEnvironment;
  /** The loader's rules (supplied by `src/app`). */
  rules: ConfigRules<C>;
}

type JsonObject = Record<string, unknown>;

interface EnvFileRead {
  state: SettingsFileState;
  /** "" when missing; null when unreadable. */
  text: string | null;
  values: Record<string, string>;
}

interface ConfigFileRead {
  state: SettingsFileState;
  /** "" when missing; null when unreadable. */
  text: string | null;
  /** {} when missing; null when unreadable or not an object. */
  json: JsonObject | null;
}

export class FileSettingsStore<C> implements SettingsStore<C> {
  private readonly envFile: string;
  private readonly configFile: string;
  private readonly startup: StartupEnvironment;
  private readonly rules: ConfigRules<C>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileSettingsStoreOptions<C>) {
    this.envFile = options.envFile;
    this.configFile = options.configFile;
    this.startup = options.startup;
    this.rules = options.rules;
  }

  read(): SettingsView {
    const envRead = this.readEnvFile();
    const configRead = this.readConfigFile();
    const env = this.startup.compose(envRead.values);
    const json = configRead.json;
    const passphrase = env[PASSPHRASE] ?? "";
    return {
      passphrase: {
        set: passphrase.trim() !== "",
        valid: passphraseProblem(passphrase) === null,
        locked: this.startup.isOutside(PASSPHRASE),
      },
      anthropicApiKey: {
        set: nonBlank(env[ANTHROPIC_API_KEY]) !== undefined,
        locked: this.startup.isOutside(ANTHROPIC_API_KEY),
      },
      helperRuntime: { value: json === null ? null : storedRuntime(json) },
      asideAccount: this.asideAccount(env, envRead, json),
      chatgpt: json === null ? null : storedChatgpt(json),
      oauthExtraResources: json === null ? null : storedExtraResources(json),
      publicUrl: this.publicUrl(env, envRead),
      files: { envFile: envRead.state, configFile: configRead.state },
    };
  }

  write(change: SettingsChange): Promise<SettingsWriteResult> {
    const result = this.queue.then(() => this.writeNow(change));
    this.queue = result.catch(() => undefined);
    return result;
  }

  loadConfig(): ConfigLoadResult<C> {
    const envRead = this.readEnvFile();
    if (envRead.text === null) {
      return { ok: false, problem: { code: "config_invalid", message: envRead.state.problem ?? "" } };
    }
    return this.rules.load(this.startup.compose(envRead.values));
  }

  pageLocation(): SettingsPageLocation {
    return this.rules.pageLocation(this.startup.compose(this.readEnvFile().values));
  }

  private async writeNow(change: SettingsChange): Promise<SettingsWriteResult> {
    const locked: Partial<Record<SettingsField, "locked">> = {};
    if (change.passphrase !== undefined && this.startup.isOutside(PASSPHRASE)) locked.passphrase = "locked";
    if (change.asideAccount !== undefined && this.startup.isOutside(ASIDE_ACCOUNT))
      locked.asideAccount = "locked";
    if (Object.keys(locked).length > 0) {
      return {
        ok: false,
        error: "locked",
        fields: locked,
        message: `${Object.keys(locked).join(", ")} is set outside the settings files (service definition or shell) and cannot be changed here`,
      };
    }

    const fields = validate(change);
    if (Object.keys(fields).length > 0) {
      return {
        ok: false,
        error: "invalid",
        fields,
        message: Object.entries(fields)
          .map(([field, code]) => `${field}: ${code}`)
          .join("; "),
      };
    }

    const envRead = this.readEnvFile();
    const configRead = this.readConfigFile();
    const accountInEnv = nonBlank(envRead.values[ASIDE_ACCOUNT]) !== undefined;
    const needsEnv = change.passphrase !== undefined || (change.asideAccount !== undefined && accountInEnv);
    const needsConfig =
      change.helperRuntime !== undefined ||
      change.chatgpt !== undefined ||
      change.oauthExtraResources !== undefined ||
      (change.asideAccount !== undefined && !accountInEnv);
    // An unreadable .env cannot tell where the account lives, so it blocks an account change too.
    if ((needsEnv || change.asideAccount !== undefined) && envRead.text === null) {
      return unreadable(this.envFile, envRead.state);
    }
    if (needsConfig && (configRead.text === null || configRead.json === null)) {
      return unreadable(this.configFile, configRead.state);
    }

    const changed: SettingsField[] = [];
    let envText = envRead.text ?? "";
    let configText = configRead.text ?? "";
    const json = configRead.json ?? {};

    if (change.passphrase !== undefined && (envRead.values[PASSPHRASE] ?? "") !== change.passphrase) {
      envText = setEnvValue(envText, PASSPHRASE, change.passphrase);
      changed.push("passphrase");
    }
    if (change.helperRuntime !== undefined && storedRuntime(json) !== change.helperRuntime) {
      configText = setJsonValue(configText, ["onboarding", "runtime"], change.helperRuntime);
      changed.push("helperRuntime");
    }
    if (change.asideAccount !== undefined) {
      if (accountInEnv) {
        if (envRead.values[ASIDE_ACCOUNT] !== change.asideAccount) {
          envText = setEnvValue(envText, ASIDE_ACCOUNT, change.asideAccount);
          changed.push("asideAccount");
        }
      } else if ((json["asideAccount"] ?? DEFAULT_ASIDE_ACCOUNT) !== change.asideAccount) {
        configText = setJsonValue(configText, ["asideAccount"], change.asideAccount);
        changed.push("asideAccount");
      }
    }
    if (change.chatgpt !== undefined && !sameChatgpt(json["chatgpt"], change.chatgpt)) {
      configText = setJsonValue(configText, ["chatgpt"], change.chatgpt);
      changed.push("chatgpt");
    }
    if (change.oauthExtraResources !== undefined) {
      const current = storedExtraResources(json) ?? [];
      const add = change.oauthExtraResources.add ?? [];
      const remove = new Set(change.oauthExtraResources.remove ?? []);
      const next = [...new Set([...current, ...add])].filter((v) => !remove.has(v));
      if (next.length !== current.length || next.some((v, i) => v !== current[i])) {
        configText = setJsonValue(configText, ["oauth", "extraResources"], next);
        changed.push("oauthExtraResources");
      }
    }

    if (envText !== (envRead.text ?? "")) await writeTextAtomic(this.envFile, envText, ENV_FILE_MODE);
    if (configText !== (configRead.text ?? "")) {
      await writeTextAtomic(
        this.configFile,
        configText,
        configRead.state.exists ? fileMode(this.configFile) : NEW_CONFIG_FILE_MODE,
      );
    }
    return { ok: true, changed };
  }

  private asideAccount(
    env: Record<string, string>,
    envRead: EnvFileRead,
    json: JsonObject | null,
  ): SettingsView["asideAccount"] {
    if (this.startup.isOutside(ASIDE_ACCOUNT)) {
      return { value: env[ASIDE_ACCOUNT] ?? null, locked: true, source: "environment" };
    }
    const fromFile = nonBlank(envRead.values[ASIDE_ACCOUNT]);
    if (fromFile !== undefined) return { value: fromFile, locked: false, source: "env_file" };
    if (json === null) return { value: null, locked: false, source: "config_file" };
    const raw = json["asideAccount"];
    if (raw === undefined) return { value: DEFAULT_ASIDE_ACCOUNT, locked: false, source: "default" };
    return {
      value: typeof raw === "string" && raw.trim() !== "" ? raw : null,
      locked: false,
      source: "config_file",
    };
  }

  private publicUrl(env: Record<string, string>, envRead: EnvFileRead): SettingsView["publicUrl"] {
    if (this.startup.isOutside(PUBLIC_URL)) return { set: true, source: "environment" };
    if (nonBlank(envRead.values[PUBLIC_URL]) !== undefined) return { set: true, source: "env_file" };
    return { set: nonBlank(env[PUBLIC_URL]) !== undefined, source: null };
  }

  private readEnvFile(): EnvFileRead {
    const path = this.envFile;
    try {
      const text = readFileSync(path, "utf8");
      return { state: fileState(path, true, true, null), text, values: parseEnvText(text) };
    } catch (error) {
      if (isMissing(error)) return { state: fileState(path, false, true, null), text: "", values: {} };
      return {
        state: fileState(path, true, false, `cannot read ${path}: ${errorText(error)}`),
        text: null,
        values: {},
      };
    }
  }

  private readConfigFile(): ConfigFileRead {
    const path = this.configFile;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return { state: fileState(path, false, true, null), text: "", json: {} };
      return {
        state: fileState(path, true, false, `cannot read ${path}: ${errorText(error)}`),
        text: null,
        json: null,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        state: fileState(path, true, false, `${path} is not valid JSON: ${errorText(error)}`),
        text,
        json: null,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { state: fileState(path, true, false, `${path} must contain a JSON object`), text, json: null };
    }
    return { state: fileState(path, true, true, null), text, json: parsed as JsonObject };
  }
}

function validate(change: SettingsChange): Partial<Record<SettingsField, SettingsFieldCode>> {
  const fields: Partial<Record<SettingsField, SettingsFieldCode>> = {};
  if (change.passphrase !== undefined) {
    const problem = passphraseProblem(change.passphrase);
    if (problem === "empty") fields.passphrase = "empty";
    else if (encodeEnvValue(change.passphrase) === null) fields.passphrase = "unsupported_characters";
    else if (problem === "too_short") fields.passphrase = "too_short";
  }
  if (change.helperRuntime !== undefined && !isHelperRuntimeSetting(change.helperRuntime)) {
    fields.helperRuntime = "bad_value";
  }
  if (change.asideAccount !== undefined) {
    if (change.asideAccount.trim() === "") fields.asideAccount = "empty";
    else if (encodeEnvValue(change.asideAccount) === null) fields.asideAccount = "unsupported_characters";
  }
  if (change.chatgpt !== undefined) {
    const checked = checkChatgptSetting(change.chatgpt);
    if (!checked.ok) fields.chatgpt = checked.code;
  }
  if (change.oauthExtraResources !== undefined) {
    const { add = [], remove = [] } = change.oauthExtraResources;
    if (
      !add.every((v) => typeof v === "string" && isHttpUrl(v)) ||
      !remove.every((v) => typeof v === "string")
    ) {
      fields.oauthExtraResources = "bad_value";
    }
  }
  return fields;
}

function storedRuntime(json: JsonObject): HelperRuntimeSetting | null {
  const onboarding = json["onboarding"];
  if (onboarding === undefined) return DEFAULT_HELPER_RUNTIME;
  if (typeof onboarding !== "object" || onboarding === null || Array.isArray(onboarding)) return null;
  const raw = (onboarding as JsonObject)["runtime"];
  if (raw === undefined) return DEFAULT_HELPER_RUNTIME;
  return isHelperRuntimeSetting(raw) ? raw : null;
}

function storedChatgpt(json: JsonObject): ChatgptConnectionSetting | null {
  const checked = checkChatgptSetting(json["chatgpt"]);
  return checked.ok ? checked.value : null;
}

function storedExtraResources(json: JsonObject): string[] | null {
  const oauth = json["oauth"];
  if (oauth === undefined) return [];
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return null;
  const raw = (oauth as JsonObject)["extraResources"];
  if (raw === undefined) return [];
  return Array.isArray(raw) && raw.every((v): v is string => typeof v === "string") ? [...raw] : null;
}

function sameChatgpt(stored: unknown, next: ChatgptConnectionSetting | null): boolean {
  if (next === null) return stored === null || stored === undefined;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false;
  const current = stored as JsonObject;
  return (
    Object.keys(current).length === 3 &&
    current["managed"] === next.managed &&
    current["tunnelId"] === next.tunnelId &&
    current["profile"] === next.profile
  );
}

function unreadable(file: string, state: SettingsFileState): SettingsWriteResult {
  return { ok: false, error: "file_unreadable", file, message: state.problem ?? `cannot read ${file}` };
}

function fileState(
  path: string,
  exists: boolean,
  readable: boolean,
  problem: string | null,
): SettingsFileState {
  return { path, exists, readable, problem };
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return NEW_CONFIG_FILE_MODE;
  }
}

/** Temp file in the same directory, exact mode (not reduced by the umask), then rename. */
async function writeTextAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
