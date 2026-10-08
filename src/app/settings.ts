/**
 * Builds the settings store over the files the process starts from, with the loader's rules from
 * `config.ts`. Create it once, early at process start (it snapshots the environment then).
 *
 * Also here, next to the store and over the same sources:
 * - `previewCaptchaAuto`: the `captchaAuto` part of a `PUT settings` preview (what the store would
 *   refuse or change in `captcha.auto`), added to the settings page's preview of the other fields;
 * - `copyPassphraseToClipboard`: "Copy passphrase". It takes the passphrase from where the store
 *   validates it (`.env`; a value forced from outside `.env` is `locked` and refused) and pipes it to
 *   `pbcopy` on standard input, so the value never reaches an HTTP response, the page, a log, a
 *   command line, or the child's environment. It answers only what happened.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  PassphraseClipboardResult,
  PageSettingsChange,
  SettingsPreview,
} from "../adapters/dashboard/index.js";
import { parseEnvText } from "../adapters/settings/env-file.js";
import { FileSettingsStore } from "../adapters/settings/file-settings-store.js";
import { StartupEnvironment } from "../adapters/settings/startup-environment.js";
import { isCaptchaAutoSetting, passphraseProblem } from "../core/settings.js";
import type { EnvironmentMap, SettingsStore, SettingsView } from "../ports/settings-store.js";
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

/**
 * Adds `captchaAuto` to a `PUT settings` preview, with the store's rules: an earlier refusal stands;
 * a non-boolean is `invalid` (`bad_value`); an unreadable config file is `file_unreadable`; otherwise
 * `captchaAuto` is listed as changed when the stored value (absent = `true`) differs.
 */
export function previewCaptchaAuto(
  view: SettingsView,
  change: PageSettingsChange,
  base: SettingsPreview,
): SettingsPreview {
  if (!base.ok || change.captchaAuto === undefined) return base;
  if (!isCaptchaAutoSetting(change.captchaAuto)) {
    return {
      ok: false,
      error: "invalid",
      fields: { captchaAuto: "bad_value" },
      message: "captchaAuto: bad_value",
    };
  }
  const { configFile } = view.files;
  if (!configFile.readable) {
    return {
      ok: false,
      error: "file_unreadable",
      message: configFile.problem ?? `${configFile.path} cannot be read`,
    };
  }
  if (view.captchaAuto.value === change.captchaAuto) return base;
  return { ok: true, changed: [...base.changed, "captchaAuto"] };
}

const PASSPHRASE = "BRIDGE_PASSPHRASE";

/** macOS's clipboard tool, by absolute path so a different `pbcopy` on `PATH` never receives the value. */
export const PBCOPY = "/usr/bin/pbcopy";

const CLIPBOARD_TIMEOUT_MS = 5_000;

export interface CopyPassphraseOptions {
  /** The settings store: only its flags and the `.env` path are used (`read()` never returns a secret). */
  store: Pick<BridgeSettingsStore, "read">;
  /** The clipboard tool (default {@link PBCOPY}); tests pass a fake. */
  command?: string | undefined;
  /** How long the tool may take (default 5 s). */
  timeoutMs?: number | undefined;
}

/**
 * Puts the stored passphrase on this Mac's clipboard. `locked` when it is set outside `.env` (the
 * page refuses to handle it); `not_set` when there is no valid passphrase; `unavailable` when the
 * clipboard tool is missing, fails, or hangs. The value is read from `.env` here and written only to
 * the tool's standard input.
 */
export async function copyPassphraseToClipboard(
  options: CopyPassphraseOptions,
): Promise<PassphraseClipboardResult> {
  const view = options.store.read();
  if (view.passphrase.locked) return "locked";
  if (!view.passphrase.valid) return "not_set";
  let value: string | undefined;
  try {
    value = parseEnvText(readFileSync(view.files.envFile.path, "utf8"))[PASSPHRASE];
  } catch {
    return "not_set";
  }
  if (value === undefined || passphraseProblem(value) !== null) return "not_set";
  return (await pipeToCommand(options.command ?? PBCOPY, value, options.timeoutMs ?? CLIPBOARD_TIMEOUT_MS))
    ? "ok"
    : "unavailable";
}

/** Runs `command` without arguments and with a minimal environment, writes `text` to its input; true on exit 0. */
function pipeToCommand(command: string, text: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok);
    };
    const child = spawn(command, [], {
      stdio: ["pipe", "ignore", "ignore"],
      // UTF-8 so non-ASCII passphrases reach the clipboard unchanged; nothing of the bridge's own.
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, timeoutMs);
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    child.stdin.on("error", () => undefined);
    child.stdin.end(text, "utf8");
  });
}
