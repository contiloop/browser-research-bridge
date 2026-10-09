# Browser Research Bridge

A single-user service on one Mac that gives ChatGPT and Claude research sessions five MCP tools for searching and reading login-only websites (Reuters, also the reference adapter; the user's Naver Blog neighbors, kept only on this Mac) through the user's own logged-in Aside browser. A local settings page (loopback only, Korean and English) is how a non-coder installs it, changes its few settings, adds sites, and connects ChatGPT. Scale: one user, a handful of registered sites, tens of tool calls per research session; TypeScript on Node 24 run from source with tsx, JSON files under `data/` instead of a database, one Aside account, two tunnels in front of one loopback port. The public endpoint fronts the user's logged-in sessions, so access control, credential locality, and site isolation matter far more than throughput or scale.

**Installing, not developing?** An AI agent that was asked to install this program for a user follows [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md) instead of this file.

## Project structure

```
browser-research-bridge/
├── CLAUDE.md                        ← entry point for Claude Code (identical to AGENTS.md)
├── AGENTS.md                        ← entry point for Codex (identical to CLAUDE.md)
├── README.md                        ← beginner guide (top), then the developer guide: install, tunnels, connectors, troubleshooting
├── README.ko.md                     ← the beginner guide in Korean
├── INSTALL-WITH-AI.md               ← procedure for an AI agent installing the program for a user
├── Open Settings.command            ← double-click opener: first-run setup, background service, opens the settings page
├── docs/
│   ├── architecture.md              ← components, end-to-end request flow, module map, external systems
│   ├── business-rules.md            ← run modes, search/read/cursor/cache rules, outcome statuses, site lifecycle, jobs
│   ├── security.md                  ← public surface, OAuth flow and failure paths, authorization matrix, audit, credentials
│   ├── standards.md                 ← MUST / MUST NOT: verify gate, module boundaries, adapter rules, commits, config
│   ├── engineering-notes.md         ← traps (symptom → cause → response), non-obvious mechanisms, checklists
│   ├── operations.md                ← setup order, env/config by role, run/verify commands, tunnels, launchd
│   ├── contracts.md                 ← wire contracts: MCP tools, OAuth endpoints, settings-page API, CLI exit codes
│   ├── ADAPTERS.md                  ← adapter authoring manual; the onboarding agent reads it (§12 cited by its prompt; §10 is the validation rule set `run_validation` enforces)
│   ├── BROWSER.md                   ← Aside port and page-script shim manual; the onboarding agent reads it
│   ├── ONBOARDING.md                ← helper (onboarding agent) manual: Claude/Codex runtimes, tools, job states, CLI
│   ├── DASHBOARD.md                 ← settings page manual (areas, Getting started, opener) and admin API
│   ├── ACCEPTANCE.md                ← real-environment acceptance record with evidence
│   └── tracking/
│       ├── status.md                ← built and verified vs remaining scope
│       ├── findings.md              ← unresolved problems with why-not-now
│       └── decisions/
│           ├── index.md             ← decision index
│           ├── 0001-chatgpt-compatible-and-typed-tools.md
│           ├── 0002-inline-query-qualifiers.md
│           ├── 0003-reject-unregistered-site-urls.md
│           ├── 0004-built-in-oauth-behind-tunnels.md
│           ├── 0005-code-module-adapters.md
│           ├── 0006-single-aside-child-with-iife-scripts.md
│           ├── 0007-run-from-source-under-tsx.md
│           ├── 0008-adapters-in-git-with-auto-commit.md
│           ├── 0009-onboarding-agent-on-claude-code-login.md
│           ├── 0010-login-flags-and-cooldown-policy.md
│           ├── 0011-setup-only-mode-and-in-process-restart.md
│           ├── 0012-helper-on-claude-or-codex-subscriptions.md
│           ├── 0013-reuters-as-reference-adapter.md
│           ├── 0014-captcha-attempts-and-vendor-hosts.md
│           ├── 0015-per-site-pool-and-no-block-cooldown.md
│           └── 0016-quick-captcha-attempt-and-captcha-limited.md
├── src/
│   ├── core/
│   │   └── AGENTS.md                ← pure domain logic: query, ids, cursor, merge, outcomes, lifecycle
│   ├── ports/
│   │   └── AGENTS.md                ← contracts between core and adapters (browser, adapter, registry, scheduler, stores, settings store, connection tool)
│   ├── adapter-kit/
│   │   └── AGENTS.md                ← the only runtime import site adapters may use
│   ├── adapters/
│   │   ├── aside/
│   │   │   └── AGENTS.md            ← Aside REPL browser port, page-script shim, per-site pool scheduler,
│   │   │                                  captcha solver (captcha.ts, browser:captcha-check in captcha-check.ts)
│   │   ├── oauth/
│   │   │   └── AGENTS.md            ← built-in OAuth 2.1 server and bearer middleware
│   │   ├── mcp/
│   │   │   └── AGENTS.md            ← the five tools, search/read services, challenge coordinator (challenge.ts),
│   │   │                                  Streamable HTTP handler
│   │   ├── registry/
│   │   │   └── AGENTS.md            ← site registration, loading, lifecycle effects, swap and removal
│   │   ├── validation/
│   │   │   └── AGENTS.md            ← static check, real-site validation, validation.json, site:validate
│   │   ├── onboarding/
│   │   │   ├── AGENTS.md            ← helper job runner on Claude or Codex, agent tools, staging gate, site:onboard
│   │   │   └── codex-runtime.AGENTS-evidence.md ← real-environment evidence of the Codex restrictions
│   │   ├── dashboard/
│   │   │   └── AGENTS.md            ← settings page: loopback listener, guards, API, static bilingual UI
│   │   ├── settings/
│   │   │   └── AGENTS.md            ← settings store: .env and config/bridge.json read/write, locked detection
│   │   ├── tunnel-client/
│   │   │   └── AGENTS.md            ← OpenAI's connection tool: key file, profile, managed child, readiness
│   │   ├── storage/
│   │   │   └── AGENTS.md            ← JSON-file stores under data/: sites, tokens, cache, last helper check
│   │   └── git/
│   │       └── AGENTS.md            ← per-site auto-commit
│   └── app/
│       └── AGENTS.md                ← config loading, composition root (app.ts, bridge-process.ts), run modes (run-mode.ts),
│                                      ChatGPT connection (chatgpt-connection.ts), settings-page support (settings-page.ts,
│                                      settings.ts), helper checks (helper-check.ts), listeners, health timer
├── sites/
│   └── AGENTS.md                    ← one adapter folder per site (reuters, …)
├── ops/
│   └── AGENTS.md                    ← launchd templates, installer, the opener's Node search and update check (update-check.sh)
└── test/ops/update-check.test.sh    ← the opener's update check in temporary clones (not part of npm run verify)
```

## Hard gates

1. **Exactly five remote tools, exactly the public routes; no public side without a passphrase.** The public listener serves only `/mcp` (bearer token required) and the OAuth discovery/register/authorize/token routes; everything else is 404. The tools are `search`, `fetch`, `search_sites`, `read_documents`, `list_sites`; they reach registered sites only, and none accepts a script, file path, or command. The settings page binds `127.0.0.1` and is never tunneled. Without a valid `BRIDGE_PASSPHRASE` (12 or more characters) the public listener is never started and no connection tool is started; only the loopback settings page runs. A connection tool the program starts targets the public port only.
2. **Credentials never leave the machine; secrets are set-only.** The access passphrase and the tunnel runtime key may be received by the local settings page and written to their files. No code path returns, shows, logs, or commits them, or hands them to the helper or to any AI. The same holds for cookies, passwords, the Aside profile, OAuth tokens, and the admin token. The instruction texts for the Aside AI and the AI install guide must make the AI stop before a key is created, before the connector is submitted, and before any passphrase is entered. Logs carry metadata only, never page content.
3. **Site isolation.** Everything site-specific lives in `sites/<key>/`. Adding, repairing, or removing a site changes nothing outside that folder and `data/`, and the bridge's own commits touch only `sites/<key>/`.
4. **Truthful outcomes against real sites.** A read that cannot confirm the full text returns `auth_required` or `access_denied`, never `ok` with a teaser; search never raises and never reports a login or access failure as `empty`. Adapter validation and acceptance run against the live sites with the user's real logins; a missing login, tunnel, or connector is requested from the user, never stubbed.
5. **Verify before commit.** `npm run verify` (typecheck, lint, unit tests) exits 0 for every change; any change to a site adapter also passes `npm run site:validate -- <key>` against the live site, which rewrites its `validation.json`. Removing a site folder needs no site validation.

The complete rule set is in `docs/standards.md`.

## Before you start

- Always read `docs/standards.md`, `docs/engineering-notes.md`, and the `AGENTS.md` of every module you will touch.
- Touching OAuth, the public listener, the dashboard guards, or anything that decides who may call what: read the authentication flow and the authorization matrix in `docs/security.md` and the OAuth section of `docs/contracts.md` first.
- Changing a tool's input, output, status values, or pagination: read `docs/contracts.md` and the search, read, and cursor sections of `docs/business-rules.md`; ChatGPT's `search`/`fetch` shapes are fixed by ChatGPT, not by this project.
- Editing the browser port, the shim, the captcha solver, or any page script: read the REPL shared-scope, `aside`-word, session-loss, and challenge-attempt entries in `docs/engineering-notes.md`, plus `docs/BROWSER.md`; the captcha vendor hosts live only in `CAPTCHA_VENDOR_HOSTS` (`docs/standards.md`).
- Editing an adapter in `sites/` or anything in `src/adapter-kit/`: read `docs/ADAPTERS.md` and the validation-hash entry in `docs/engineering-notes.md`; re-run `npm run site:validate -- <key>` afterwards.
- Changing the onboarding prompt or tools, or editing `docs/ADAPTERS.md`/`docs/BROWSER.md`: the agent reads those two files by path and its prompt cites ADAPTERS.md §12 and the tools rely on §10 (validation); keep paths and section numbers stable.
- Changing lifecycle, health-check, scheduler, captcha-attempt, or registry behavior: read the lifecycle, browser-scheduling, challenge-attempt, and onboarding-job sections of `docs/business-rules.md`.
- Touching the settings page, run-mode control, the settings store, the ChatGPT connection, or the opener (`src/adapters/dashboard/`, `src/adapters/settings/`, `src/adapters/tunnel-client/`, `src/app/{run-mode,bridge-process,chatgpt-connection,settings-page,settings,helper-check}.ts`, `Open Settings.command`, `ops/update-check.sh`): read the settings-page sections of `docs/security.md` and `docs/contracts.md`, `docs/DASHBOARD.md`, and the run-mode section of `docs/business-rules.md`; every new state-changing route needs a test that it is refused without the cookie and with a foreign `Origin`; a change to the opener or `ops/update-check.sh` must pass `bash test/ops/update-check.test.sh`.
- Touching the Codex helper runtime or upgrading Codex: read `src/adapters/onboarding/codex-runtime.AGENTS-evidence.md`; re-run that evidence on the installed Codex, and if a restriction can no longer be enforced, ship Claude only rather than weaken it.
- Starting, stopping, or restarting the bridge, or running anything against the real Aside browser: read `docs/operations.md` (launchd, tunnel start order); the live background service runs from this folder's working tree; never kill it with `pkill -f src/app/main.ts`.

## Problem routing

Stop and report to the user immediately when you find:

- a credential exposure: a cookie, password, OAuth token, admin token, passphrase, tunnel runtime key, or API key in a log line, tool result, API response, page, job log, commit, the helper's environment, or an instruction text for an AI;
- a reach beyond the approved surface: a public route other than `/mcp` and the OAuth routes, a tool or page script that reaches a host outside the site's declared hosts (only the bridge's own challenge attempt may also reach the fixed `CAPTCHA_VENDOR_HOSTS`, on its tab and while it runs), a shim layer that can be bypassed, the settings page answering without the admin cookie and same-origin checks, the public listener or a connection tool started without a valid passphrase, a connection tool targeting anything but the public port, or a helper (Claude or Codex) with a tool, file, network, or command capability beyond the bridge's helper tools;
- an OAuth bypass: `/mcp` answering without a valid token, a token accepted for a resource the bridge does not serve, consent granted without the passphrase, or a code exchanged without a matching PKCE verifier;
- a bridge commit, onboarding write, or adapter change outside `sites/<key>/`;
- a read that returns `ok` with partial text, or a login or access failure reported as `empty`;
- a step that needs something only the user holds (a site login, tunnel credentials, connector registration, an account): request that exact action instead of substituting a stub.

Everything else that you cannot fix in the current session goes into `docs/tracking/findings.md` with the condition, the symptom, the blast radius, and why it cannot be fixed now.
