/**
 * Settings store port: reads and writes the settings the settings page may change, in the files
 * the process starts from (`.env` and `config/bridge.json`), and turns those files into a
 * configuration for the core.
 *
 * Secrets (`BRIDGE_PASSPHRASE`, `ANTHROPIC_API_KEY`) are set-only: reads report whether they are
 * set and valid, never their values. The only path that carries a secret out is
 * {@link SettingsStore.loadConfig}, whose configuration keeps it in a non-enumerable field.
 */
import type { ChatgptConnectionSetting, ConfigProblemCode, HelperRuntimeSetting } from "../core/settings.js";

export type { ChatgptConnectionSetting };

export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export interface ConfigProblem {
  code: ConfigProblemCode;
  /** Names the file or value and the reason; never contains a secret. */
  message: string;
}

export type ConfigLoadResult<C> = { ok: true; config: C } | { ok: false; problem: ConfigProblem };

/** Where the settings page listens and keeps its data, known even when the configuration is invalid. */
export interface SettingsPageLocation {
  adminPort: number;
  /** Absolute path. */
  dataDir: string;
}

/** The configuration rules the store applies to an environment (supplied by the composition root). */
export interface ConfigRules<C> {
  /** Classified load: a valid configuration or one of the three configuration problems. */
  load(env: EnvironmentMap): ConfigLoadResult<C>;
  /** Environment override → readable config file → defaults; never fails. */
  pageLocation(env: EnvironmentMap): SettingsPageLocation;
}

/**
 * Where an effective value comes from. `environment` is a variable set outside `.env` (service
 * definition or shell) at process start; such a setting is locked.
 */
export type SettingSource = "environment" | "env_file" | "config_file" | "default";

export interface SettingsFileState {
  /** Absolute path. */
  path: string;
  exists: boolean;
  /** False when the file exists but cannot be read or parsed. */
  readable: boolean;
  /** Why it is not readable, naming the file; null when readable. */
  problem: string | null;
}

/** What the settings page may see. No field holds a secret value. */
export interface SettingsView {
  passphrase: { set: boolean; valid: boolean; locked: boolean };
  anthropicApiKey: { set: boolean; locked: boolean };
  /** `onboarding.runtime`; null when the config file cannot be read or holds an invalid value. */
  helperRuntime: { value: HelperRuntimeSetting | null };
  /**
   * `captcha.auto` (absent → the default `true`); null when the config file cannot be read or holds
   * a non-boolean. No environment override, so never locked.
   */
  captchaAuto: { value: boolean | null };
  /** Effective browser account; `value` null when the winning place holds an unreadable or invalid value. */
  asideAccount: { value: string | null; locked: boolean; source: SettingSource };
  /** The program-managed connection marker, or null when absent, null, invalid, or unreadable. */
  chatgpt: ChatgptConnectionSetting | null;
  /** `oauth.extraResources` (the accepted tunnel addresses); null when unreadable or invalid. */
  oauthExtraResources: string[] | null;
  /** Whether `PUBLIC_URL` is set, and where. */
  publicUrl: { set: boolean; source: "environment" | "env_file" | null };
  files: { envFile: SettingsFileState; configFile: SettingsFileState };
}

/** Only the fields present are changed. */
export interface SettingsChange {
  /** Written to `BRIDGE_PASSPHRASE` in `.env`. */
  passphrase?: string;
  /** Written to `onboarding.runtime`; must be one of the three settings (build support is the caller's check). */
  helperRuntime?: string;
  /** Written where the winning value lives: an active `BRIDGE_ASIDE_ACCOUNT` line in `.env`, else `asideAccount`. */
  asideAccount?: string;
  /** Sets the marker; null writes `"chatgpt": null` (no program-managed connection). */
  chatgpt?: ChatgptConnectionSetting | null;
  /** Adds and removes accepted addresses in `oauth.extraResources`; other entries and their order are kept. */
  oauthExtraResources?: { add?: readonly string[]; remove?: readonly string[] };
  /** Written to `captcha.auto` in `config/bridge.json`; must be a boolean (no environment override, never locked). */
  captchaAuto?: boolean;
}

export type SettingsField = keyof SettingsChange;

export const SETTINGS_FIELD_CODES = [
  "too_short",
  "empty",
  "unsupported_characters",
  "bad_format",
  "bad_value",
] as const;
export type SettingsFieldCode = (typeof SETTINGS_FIELD_CODES)[number];

export type SettingsWriteResult =
  /** `changed` lists the fields whose stored value actually changed; empty means nothing was written. */
  | { ok: true; changed: SettingsField[] }
  | {
      ok: false;
      error: "invalid";
      fields: Partial<Record<SettingsField, SettingsFieldCode>>;
      message: string;
    }
  | { ok: false; error: "locked"; fields: Partial<Record<SettingsField, "locked">>; message: string }
  /** The file the change must go to cannot be read or parsed; nothing was written. */
  | { ok: false; error: "file_unreadable"; file: string; message: string };

export interface SettingsStore<C> {
  /** Current file contents (read on every call) and the startup environment. Never returns a secret. */
  read(): SettingsView;
  /**
   * Validates every field, refuses locked ones, then writes only the named items atomically,
   * preserving all other lines, keys, comments, and order. `.env` is written owner-only (0600);
   * a missing file is created. All-or-nothing on validation; writes are serialized.
   */
  write(change: SettingsChange): Promise<SettingsWriteResult>;
  /** Reads the files again and returns the configuration the core would start with, or the problem. */
  loadConfig(): ConfigLoadResult<C>;
  /** The settings page's port and data folder; works with a malformed config file. */
  pageLocation(): SettingsPageLocation;
}
