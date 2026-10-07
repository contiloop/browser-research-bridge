/**
 * Builds the settings store over the files the process starts from, with the loader's rules from
 * `config.ts`. Create it once, early at process start (it snapshots the environment then).
 */
import { resolve } from "node:path";
import { FileSettingsStore } from "../adapters/settings/file-settings-store.js";
import { StartupEnvironment } from "../adapters/settings/startup-environment.js";
import type { EnvironmentMap, SettingsStore } from "../ports/settings-store.js";
import { loadConfigResult, resolveSettingsPageLocation, type BridgeConfig } from "./config.js";

export type BridgeSettingsStore = SettingsStore<BridgeConfig>;

export interface CreateSettingsStoreOptions {
  /** Project root; defaults to `process.cwd()`. */
  rootDir?: string;
  /** The process environment at start; defaults to `process.env`. */
  env?: EnvironmentMap;
  /** The `.env` the process was started with (`--env-file`), relative to `rootDir`; default `.env`. */
  envFile?: string;
  /** Config file relative to `rootDir`; default `config/bridge.json`. */
  configPath?: string;
}

export function createSettingsStore(options: CreateSettingsStoreOptions = {}): BridgeSettingsStore {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const envFile = resolve(rootDir, options.envFile ?? ".env");
  const configPath = options.configPath ?? "config/bridge.json";
  return new FileSettingsStore<BridgeConfig>({
    envFile,
    configFile: resolve(rootDir, configPath),
    startup: StartupEnvironment.capture(options.env ?? process.env, envFile),
    rules: {
      load: (env) => loadConfigResult({ env, rootDir, configPath }),
      pageLocation: (env) => resolveSettingsPageLocation({ env, rootDir, configPath }),
    },
  });
}
