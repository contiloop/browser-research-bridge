# Standards

## Verification gates

- Every change MUST leave `npm run verify` (`tsc --noEmit` over `src`, `sites`, `test`; `eslint .`; `vitest run`) exiting 0 before it is committed.
- A change to any file in `sites/<key>/` other than `NOTES.md`, or to `src/adapter-kit/` or the validation rules that a site depends on, MUST be followed by `npm run site:validate -- <key>` against the live site in the logged-in Aside browser, and the rewritten `validation.json` MUST be committed with the change. A `validation.json` MUST NOT be edited by hand.
- After an agent-written adapter is promoted, `npm run verify` MUST be run, because the promotion gate type-checks the adapter but does not lint it.
- Adapter validation, health checks, and acceptance MUST run against the real sites. Unit tests MAY replace the browser port with in-memory fakes (`test/support/fake-aside-repl.ts`) to test core logic; they MUST NOT stand in for a site's behavior in validation or acceptance, and a missing login, tunnel, or connector MUST be requested from the user rather than simulated.
- Tests MUST cover the core rules they touch: query parsing, normalization, dedup, cursor and id codecs, status mapping, lifecycle transitions, OAuth flows.
- Every state-changing settings-page route MUST have a test proving it is refused without the admin cookie and with a foreign `Origin` (`src/adapters/dashboard/dashboard.test.ts`).
- Page wording MUST exist in both languages with the same keys and placeholders, and every closed value set MUST have a label in both (`src/adapters/dashboard/ui.test.ts`). The Aside instruction texts MUST keep their stop sentences and MUST NOT contain a secret or the settings-page address.
- The Codex helper runtime MUST ship only while every restriction of the Claude helper is enforced and demonstrated on the installed Codex (`src/adapters/onboarding/codex-runtime.AGENTS-evidence.md`). After a Codex upgrade the evidence MUST be re-run; if a restriction cannot be enforced, the Codex entry is removed from the runtime registry (`supported: ["claude"]`), never weakened.

## Dependencies

- Dependencies MUST be pinned to exact versions in `package.json` (no ranges) with `package-lock.json` committed; npm is the only package manager.
- `typescript` and `tsx` MUST stay in `dependencies`, not `devDependencies`: the bridge runs from source under tsx, and the onboarding promotion gate and the adapter static check load the TypeScript compiler at runtime.
- `engines.node` is `>=24`.
- Site adapters MUST NOT gain dependencies: their only runtime import is `src/adapter-kit`.

## Module boundaries

- `src/core` MUST NOT import from `src/ports`, `src/adapters`, `src/app`, `src/adapter-kit`, or `sites/`; it may use `zod`, `node:crypto`, and `Buffer` only. It has no I/O and no clock of its own.
- `src/ports` MUST contain interfaces, schemas, and type-level contracts only; it may import `src/core` types and `zod`, nothing from `src/adapters` or `src/app`.
- `src/adapter-kit` MUST stay pure (no I/O, no Node built-ins) and import only `src/core` and `src/ports`.
- Concrete adapters (`src/adapters/*`) are instantiated only in `src/app/`: `app.ts` (the core), `jobs.ts` (the job service and the helper runtimes), `bridge-process.ts` (the settings-page listener, the run-mode controller, and the ChatGPT connection service), `settings.ts` (the settings store), `settings-page.ts` (the token store used while the core is off), and `main.ts` (the connection tool). Cross-adapter imports follow the existing direction (registry → validation, storage; validation → registry (loader and ownership lookups); onboarding → aside, registry, validation, storage; dashboard → oauth, onboarding, registry, and `src/app` types and helpers: `public-server.ts` for the shared listener helper, `run-mode.ts` and `chatgpt-connection.ts` types, `validateSetupInput`); `src/adapters/settings` imports only `src/core` and `src/ports` and writes only the two files it is given; `src/adapters/tunnel-client` imports only `src/ports` and Node built-ins. The two CLIs (`src/adapters/validation/cli.ts`, `src/adapters/onboarding/cli.ts`) are the only places besides `src/app/` that build a browser port and runtime, because they run without the bridge; a new edge that points the other way (for example validation importing onboarding, or storage importing anything but core/ports) MUST NOT be added.
- Run-mode control (`src/app/run-mode.ts`) is the only code that starts, stops, or restarts the core. The settings page lives outside the core for the whole process and MUST resolve the core's services per request (`core()`), never at construction. A program-managed connection tool MUST start only from the core-started hook and stop from the core-stopping hook, and MUST target the public port only.
- The settings page (`src/adapters/dashboard/ui/`) MUST stay plain files with no build step and no external resources, served only from the fixed `UI_FILES` list; server text MUST be inserted as text, never as HTML.
- `src/app/main.ts` is the only module that loads `src/adapter-kit` at runtime for the bridge process; everything else receives the helpers through `createApp`. The onboarding agent tools may import the kit's page-script builder.
- Nothing outside `sites/<key>/` MAY contain site-specific logic, hostnames, selectors, or URLs. Adding or removing a site MUST NOT change any file outside `sites/<key>/` and `data/`.

## Site adapter rules

- One folder per site: `sites/<key>/` with `manifest.json`, `adapter.ts`, `NOTES.md`, `validation.json`. `<key>` matches `[a-z0-9-]{2,32}` and equals `manifest.key`.
- `adapter.ts` is the whole adapter: value imports only from `../../src/adapter-kit/index.js`; `import type` may also name `src/ports/*` and `src/core/*`. Value imports of other files in the folder, Node built-ins, packages, other project code, `import()`, `require`, `process`/`process.env`, `globalThis`, `global`, `eval`, `Function`, `module`, `exports`, `__dirname`, `__filename`, `import.meta`, `.constructor`, and the network globals `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` MUST NOT appear; the static check enforces this before the module is imported.
- Adapters MUST NOT keep state between calls (module-level caches, timers), read files or environment, or store credentials.
- Every page script MUST be built with the kit's `pageScript` (an async IIFE with values embedded as JSON literals) and MUST NOT use the REPL's global `page`; the identifiers `fs`, `aside`, `require`, `process`, `exec`, `memory_search`, and the words `globalThis`, `eval`, `Function`, `constructor`, `import`, `Reflect`, `__proto__`, `getPrototypeOf`, `fromCharCode`, `contentWindow` MUST NOT appear in a script, not even inside strings or selectors.
- Adapters MUST return statuses rather than throw, MUST NOT return `ok` before the completeness check confirmed the full body, and MUST set `blocked: true` only for block or captcha pages, never for a paywall.
- `search` result URLs MUST be on the manifest's `hostnames`; every returned id MUST round-trip through `read`; the same adapter cursor MUST yield the same page.
- `checkCompleteness` is REQUIRED when `gatedSampleUrl` is set.
- Every host a site loads pages or data from that it does not own (login/SSO redirects, data APIs, CDNs) MUST be declared in `extraAllowedHosts`, not in `hostnames`; `hostnames` is ownership and decides which site a URL belongs to.
- `manifest.version` MUST be bumped by a repair that changes behavior, and `NOTES.md` MUST record what was learned about the site.

## Contracts in code

- The outcome status set (`OUTCOME_STATUSES`) and the lifecycle status set (`LIFECYCLE_STATUSES`) in `src/core/models.ts` are closed; adding a value is a contract change for both research clients and requires updating every mapping (`targets.ts`, `outcome.ts`, `lifecycle.ts`) and the tool descriptions.
- Failures travel as `OutcomeError` with a failure status; code MUST NOT map an error to `ok` or `empty`.
- Adapter output MUST pass through the zod normalization in `src/adapters/mcp/adapter-output.ts`; a malformed successful response is `adapter_error`.
- `search` and `search_sites` MUST NOT raise; `read_documents` MUST NOT fail as a whole; only `fetch` returns an MCP tool error.
- The tool set is exactly `TOOL_NAMES` in `src/adapters/mcp/tools.ts`; no tool may accept a script, a file path, or a command.
- ChatGPT's `search` → `{ results: [{ id, title, url }] }` and `fetch` → `{ id, title, text, url, metadata }` shapes MUST stay intact; extra keys are allowed.
- Logs MUST carry metadata only: no page content, no tokens, no passphrase, no query strings of HTTP requests, no request bodies.

## Configuration

- Precedence MUST stay: environment variables > `config/bridge.json` > built-in defaults in `src/app/config.ts`. An empty environment value counts as unset.
- A new tunable MUST be added to `DEFAULT_TUNABLES` in `src/app/config.ts` and to `config/bridge.example.json`; unknown keys are warned about and ignored, and a tunable value must be a positive finite number or startup fails.
- A new environment variable MUST be documented in `.env.example`.
- Secrets (`BRIDGE_PASSPHRASE`, `ANTHROPIC_API_KEY`) MUST stay in the non-enumerable `config.secrets` and never be copied into enumerable config, logs, responses, or the helper's environment (`BRIDGE_*` is stripped there). The tunnel runtime key MUST NOT enter the configuration at all: it is passed once to the connection tool port, written to its key file outside the project, and handed to `tunnel-client` only as a `file:` reference, never as an argument value or environment variable.
- Settings MUST be written only through the settings store (`src/adapters/settings`): validation with the loader's rules before any write, minimal-change edits that keep every other line, key, and comment, atomic writes, `.env` always 0600, and the value written where the winning value lives. A value set outside `.env` at process start is locked and MUST NOT be overwritten from the page. The store MUST NOT return a secret value, only `set`/`valid`/`locked` flags.
- New keys follow the same rules: `onboarding.runtime` is exactly `auto`, `claude`, or `codex` (no environment override); `onboarding.codexModel` is a string or null; `chatgpt` is null/absent or `{ managed: boolean, tunnelId: tunnel_ + 32 hex, profile }` and is written only by the ChatGPT connection service; `TUNNEL_CLIENT_BIN` and `CODEX_BIN` default to the names on `PATH`. Each is in `config/bridge.example.json` or `.env.example` and in the loader's known keys.
- The program MUST NOT download or install an executable and MUST NOT start the Aside AI. Output of the connection tool and of the Codex CLI MUST be reduced to state and error kind before it is logged.
- `PUBLIC_URL` MUST be an origin only (no path, query, fragment, credentials); the bridge refuses anything else.
- `.env`, `config/bridge.json`, `data/`, `sites/*/.staging`, `sites/*/.previous` MUST stay git-ignored; adapter folders MUST be committed, except a site folder the user keeps private: it is listed in the clone's local `.git/info/exclude` (on the owner's Mac: `sites/blog-naver/`), is never added by the auto-commit (which then logs `site folder not committed` and commits nothing), and MUST NOT be added back by an ordinary commit. A fresh clone does not contain it.
- The repository ships exactly one site, `sites/reuters/`, which is also the helper's reference adapter.

## Commits

- The bridge's auto-commit (`git.autoCommit`, default on) MUST stage and commit only the pathspec `sites/<key>/`, with the message `site: add <key>`, `site: repair <key>`, or `site: remove <key>`, and MUST NOT push. Other staged changes stay staged and are not included.
- Human or agent commits MUST NOT include `.env`, `config/bridge.json`, `data/`, runtime keys, or tunnel credentials.

## Documentation the agent reads

- `docs/ADAPTERS.md` and `docs/BROWSER.md` are inputs of the onboarding agent: `src/adapters/onboarding/files.ts` allowlists them by path and the agent prompt and tool descriptions cite ADAPTERS.md §10 (validation) and §12 (onboarding checklist). Renaming either file or renumbering those sections breaks onboarding and MUST be done together with the matching code change.
