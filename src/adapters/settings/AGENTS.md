# src/adapters/settings

## Scope

The file-backed settings store: reading and writing the settings the settings page may change, in the files the process starts from, and turning those files into a configuration for the core.

- `file-settings-store.ts`: `FileSettingsStore` (implements `SettingsStore` from `src/ports/settings-store.ts`);
- `startup-environment.ts`: `StartupEnvironment`, the process environment captured at start, split into "from `.env`" and "set outside" (locked);
- `env-file.ts`: `.env` text with Node's own semantics (`parseEnvText` = `util.parseEnv`, `encodeEnvValue`, `setEnvValue`, `listEnvDefinitions`/`findEnvDefinition`);
- `json-edit.ts`: `setJsonValue`, minimal-change edits of `config/bridge.json`.

Barrel: `index.ts`. The store is built by `createSettingsStore` in `src/app/settings.ts`, which supplies the loader's rules.

Not in scope: HTTP, request parsing, the settings-page API and its error statuses (they map the results below), restarting the core, deciding which helper runtimes this build supports (the caller checks `bad_value` for an unsupported runtime), the connection tool's profile and key files.

## Interface

```ts
import { createSettingsStore, type BridgeSettingsStore } from "src/app/settings.js";
const store = createSettingsStore({ rootDir, env: process.env, envFile: ".env" }); // once, early at process start
store.read(); // SettingsView: flags for secrets, values and sources for the rest; never a secret
await store.write(change); // SettingsChange → SettingsWriteResult
store.loadConfig(); // ConfigLoadResult<BridgeConfig>: { ok, config } | { ok: false, problem: { code, message } }
store.pageLocation(); // { adminPort, dataDir }, also with a malformed config file
```

- `SettingsChange` fields: `passphrase`, `helperRuntime`, `asideAccount`, `chatgpt` (marker object, or `null` to clear), `oauthExtraResources: { add?, remove? }`, `captchaAuto` (boolean; anything else is `bad_value`). Only fields present are touched. `read()` reports it as `captchaAuto: { value }` (absent → `true`; `null` when the config file is unreadable or holds a non-boolean; never locked).
- `SettingsWriteResult`: `{ ok: true, changed }` (`changed: []` means nothing was written, so no restart is needed), or `{ ok: false, error: "invalid", fields }` with codes `empty`, `too_short`, `unsupported_characters`, `bad_format`, `bad_value`, or `{ error: "locked", fields }`, or `{ error: "file_unreadable", file }`. Messages never contain a submitted value.
- `problem.code` is `passphrase_missing`, `passphrase_too_short`, or `config_invalid`; `start_failed` belongs to run-mode control.

## Boundaries

- Imports `src/core` and `src/ports` only; the loader's rules arrive as `ConfigRules` from `src/app`.
- Writes only `.env` and `config/bridge.json` (the two paths it is given); never `data/`, `sites/`, or anything else.

## Invariants

- No read returns a secret value (`BRIDGE_PASSPHRASE`, `ANTHROPIC_API_KEY`): only `set`/`valid`/`locked`. The only path carrying a secret out is `loadConfig()`, whose configuration keeps it in non-enumerable `secrets`.
- Writes replace only the named items: the value of the winning `.env` definition (an `export` prefix and a trailing comment stay) or one JSON value span; every other line, key, comment, order, and formatting is kept. A missing definition is appended; a missing file is created.
- Every write is atomic (temp file in the same directory, exact mode, rename). `.env` is always written 0600; `config/bridge.json` keeps its mode (0644 when new). Validation is all-or-nothing and happens before any file is touched; writes are serialized.
- A value written to `.env` reads back identically through `util.parseEnv` and `node --env-file` (quotes, `#`, spaces, non-ASCII): the encoder tries single quotes, backticks, double quotes, then bare text, and keeps the first candidate Node reads back exactly. A line break, another control character (tab is allowed), an unpaired surrogate, or a value no candidate can hold is `unsupported_characters`.
- Where a setting lives: the passphrase in `.env`; the helper runtime in `onboarding.runtime`; automatic captcha handling in `captcha.auto` (absent counts as `true`, so saving `true` there writes nothing); the browser account where the winning value lives (a non-empty `BRIDGE_ASIDE_ACCOUNT` line in `.env`, else `asideAccount`). Commented-out lines are not definitions; the last definition wins, as in Node.
- Locked: a variable set outside `.env` with a non-empty value at process start (`StartupEnvironment.capture` compares `process.env` with the file's value at that moment). Locked settings (`BRIDGE_PASSPHRASE`, `BRIDGE_ASIDE_ACCOUNT`) are refused with `locked` and keep winning over the file in `loadConfig()`. An empty outside value counts as unset; an outside value equal to the file's value counts as from `.env`.
- `loadConfig()` and `pageLocation()` read the files again on every call and build the environment as: start environment minus the values that came from `.env`, then the current `.env` values for every name not set outside. A line removed from `.env` after start is gone.
- A malformed `config/bridge.json` makes values that live there `null` in `read()`, refuses changes that must go there (`file_unreadable`), and still allows a separate `.env` change.

## Tests

`env-file.test.ts` (encoding through Node's parser and a real `node --env-file` child, refusals, in-place edits, multi-line values, duplicates), `json-edit.test.ts` (byte preservation, insertion in one-line and multi-line objects, created parents), and `src/app/settings.test.ts` (the store with the real loader: flags without values, locked detection, write-where-it-lives, permissions, created files, no-change, `file_unreadable`, the three problem codes, page location with a malformed file).
