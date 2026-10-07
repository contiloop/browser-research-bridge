/**
 * Settings-page support: the parts of the settings page that work whether or not the
 * core runs, composed here so the dashboard adapter stays free of file formats and stores.
 *
 * - `info()`: the read-only information of `GET settings`, read from the current files; values the
 *   configuration does not yield are null. A missing or short passphrase does not hide the other
 *   values: they are read again with a placeholder passphrase (used for nothing else), as the
 *   ChatGPT connection's target resolver does.
 * - `preview(change)`: what a `PUT settings` would do, before anything is written: `locked`,
 *   `invalid` (the store's own rules and codes), `file_unreadable`, or the fields whose stored value
 *   would change. It compares with the place the store writes to (the `.env` value of the passphrase;
 *   it reads it only to compare and never returns it). The store's write remains authoritative.
 * - `supportedRuntimes()`: the helper runtimes this build ships.
 * - `revokeAllAppsOffline()`: deletes every OAuth client with its tokens and codes in the token file
 *   while the core (the file's only other writer) is off.
 */
import { readFileSync } from "node:fs";
import type {
  PageSettingsChange,
  SettingsInfo,
  SettingsPageSupport,
  SettingsPreview,
} from "../adapters/dashboard/index.js";
import { encodeEnvValue, parseEnvText } from "../adapters/settings/index.js";
import { FileTokenStore, tokenStorePath } from "../adapters/storage/index.js";
import { isHelperRuntimeSetting, passphraseProblem } from "../core/settings.js";
import type {
  ConfigLoadResult,
  EnvironmentMap,
  SettingsField,
  SettingsFieldCode,
  SettingsView,
} from "../ports/settings-store.js";
import { loadConfigResult } from "./config.js";
import type { BridgeConfig } from "./config.js";
import { SHIPPED_HELPER_RUNTIMES } from "./jobs.js";
import { MCP_PATH } from "./public-server.js";
import type { BridgeSettingsStore } from "./settings.js";

const PASSPHRASE = "BRIDGE_PASSPHRASE";
const PLACEHOLDER_PASSPHRASE = "placeholder-not-a-passphrase";

export interface SettingsPageSupportOptions {
  store: Pick<BridgeSettingsStore, "read" | "loadConfig" | "pageLocation">;
  /**
   * Where `info()` reads the other values from when the configuration does not load only because of
   * the passphrase (setup mode): the start environment and the project root.
   */
  fallback?: { env: EnvironmentMap; rootDir: string; configPath?: string | undefined } | undefined;
}

export function createSettingsPageSupport(options: SettingsPageSupportOptions): SettingsPageSupport {
  const { store } = options;

  const configForInfo = (): BridgeConfig | null => {
    let loaded: ConfigLoadResult<BridgeConfig>;
    try {
      loaded = store.loadConfig();
    } catch {
      return null;
    }
    if (loaded.ok) return loaded.config;
    const passphraseOnly =
      loaded.problem.code === "passphrase_missing" || loaded.problem.code === "passphrase_too_short";
    if (!passphraseOnly || options.fallback === undefined) return null;
    const { env, rootDir, configPath } = options.fallback;
    const retry = loadConfigResult({
      env: { ...env, [PASSPHRASE]: PLACEHOLDER_PASSPHRASE },
      rootDir,
      ...(configPath === undefined ? {} : { configPath }),
    });
    return retry.ok ? retry.config : null;
  };

  return {
    info(): SettingsInfo {
      const view = store.read();
      const location = store.pageLocation();
      const config = configForInfo();
      return {
        mcpUrl: config === null ? null : `${config.publicUrl}${MCP_PATH}`,
        publicUrl: config?.publicUrl ?? null,
        publicUrlConfigured: config?.publicUrlConfigured ?? null,
        publicPort: config?.publicPort ?? null,
        adminPort: location.adminPort,
        dataDir: location.dataDir,
        sitesDir: config?.sitesDir ?? null,
        configFile: view.files.configFile.path,
        envFile: view.files.envFile.path,
      };
    },

    preview(change: PageSettingsChange): SettingsPreview {
      return previewChange(store.read(), change);
    },

    supportedRuntimes: () => [...SHIPPED_HELPER_RUNTIMES],

    async revokeAllAppsOffline(): Promise<void> {
      const tokens = new FileTokenStore(tokenStorePath(store.pageLocation().dataDir));
      for (const client of await tokens.listClients()) await tokens.deleteClient(client.clientId);
    },
  };
}

/** The store's checks in its order (locked → invalid → unreadable file), then the would-be changes. */
export function previewChange(view: SettingsView, change: PageSettingsChange): SettingsPreview {
  const locked: Partial<Record<SettingsField, "locked">> = {};
  if (change.passphrase !== undefined && view.passphrase.locked) locked.passphrase = "locked";
  if (change.asideAccount !== undefined && view.asideAccount.locked) locked.asideAccount = "locked";
  if (Object.keys(locked).length > 0) {
    return {
      ok: false,
      error: "locked",
      fields: locked,
      message: `${Object.keys(locked).join(", ")} is set outside the settings files (service definition or shell) and cannot be changed here`,
    };
  }

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

  const { envFile, configFile } = view.files;
  const accountInEnv = view.asideAccount.source === "env_file";
  const needsEnv = change.passphrase !== undefined || change.asideAccount !== undefined;
  const needsConfig =
    change.helperRuntime !== undefined || (change.asideAccount !== undefined && !accountInEnv);
  if (needsEnv && !envFile.readable) {
    return {
      ok: false,
      error: "file_unreadable",
      message: envFile.problem ?? `${envFile.path} cannot be read`,
    };
  }
  if (needsConfig && !configFile.readable) {
    return {
      ok: false,
      error: "file_unreadable",
      message: configFile.problem ?? `${configFile.path} cannot be read`,
    };
  }

  const changed: SettingsField[] = [];
  if (change.passphrase !== undefined && storedPassphraseDiffers(envFile, change.passphrase)) {
    changed.push("passphrase");
  }
  if (change.helperRuntime !== undefined && view.helperRuntime.value !== change.helperRuntime) {
    changed.push("helperRuntime");
  }
  if (change.asideAccount !== undefined && view.asideAccount.value !== change.asideAccount) {
    changed.push("asideAccount");
  }
  return { ok: true, changed };
}

/** Compares with the `.env` value the store would replace; any doubt counts as a change. */
function storedPassphraseDiffers(envFile: SettingsView["files"]["envFile"], next: string): boolean {
  if (!envFile.exists) return true;
  try {
    return (parseEnvText(readFileSync(envFile.path, "utf8"))[PASSPHRASE] ?? "") !== next;
  } catch {
    return true;
  }
}
