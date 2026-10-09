# Findings

## A Cloudflare quick tunnel invalidates the Claude connector on every restart

- **Problem**: when `cloudflared` runs as a quick tunnel and restarts (reboot, sleep, crash), it gets a new `trycloudflare.com` URL. The bridge still advertises the old `PUBLIC_URL`, and Claude's connector points at the old URL, so Claude cannot reach the bridge until `PUBLIC_URL` is changed, the bridge restarted, and the connector removed and added again with a new consent.
- **Blast radius**: every Claude research session after a tunnel restart fails to use the tools; the launchd agents cannot recover this by themselves.
- **Why not now**: a stable URL needs a Cloudflare named tunnel with an account and a domain on Cloudflare (or an ngrok static domain), which only the user can provide.
- **Approach**: switch to a named tunnel and install it with `ops/install-launchd.sh --cloudflared <tunnel>`.

## Site logins can be lost when Aside's browser session drops

- **Problem**: when the Aside browser session drops ("Session with given id not found", "Chrome extension not connected"), the bridge restarts its `aside mcp` child, but the new session has at times lost a site's login (Naver twice, Reuters once during acceptance).
- **Blast radius**: the affected site turns `needs_login` and drops out of search-all until the user logs in again; an onboarding job pauses.
- **Why not now**: login state lives in Aside's browser profile, outside the bridge; the bridge must never store or replay credentials.
- **Approach**: none on the bridge side beyond reporting `auth_required` with the login action; a fix would have to come from Aside.

## `browser:check` and `browser:captcha-check` ignore the bridge's configured Aside account

- **Problem**: with `asideAccount` (or `BRIDGE_ASIDE_ACCOUNT`) set to something other than `u0`, `npm run browser:check` and `npm run browser:captcha-check` still use `u0` unless `ASIDE_ACCOUNT` or `--account` is given (`src/adapters/aside/check.ts`, `captcha-check.ts`).
- **Blast radius**: the check can pass while the bridge's own account is signed out, or fail while the bridge works; only diagnostics are affected.
- **Why not now**: diagnostics only, with a documented workaround (`-- --account <id>`); the fix is a code change in both CLIs that has not been scheduled.
- **Approach**: resolve the account as `--account` → `BRIDGE_ASIDE_ACCOUNT`/`config/bridge.json` → `u0`.

## Lint is not part of the promotion gate for agent-written adapters

- **Problem**: the onboarding gate validates against the real site and type-checks the staged adapter but does not run ESLint, so a promoted and auto-committed adapter can make `npm run verify` fail.
- **Blast radius**: the next change by anyone fails the verify gate on code they did not touch, until the adapter's style is fixed by hand.
- **Why not now**: running ESLint inside the bridge process for one folder needs a design decision first: type-aware lint needs the TypeScript project service inside the bridge process, which adds startup cost and memory.
- **Approach**: run ESLint on the staged `adapter.ts` in `SiteStagingValidation` and report violations to the agent before `finish`.

## Consent lockout and the CIMD cache reset on restart

- **Problem**: lockout counters and the 5-minute cache of fetched client metadata documents are kept in memory; restarting the bridge clears a running lockout.
- **Blast radius**: someone who can trigger restarts (or waits for one) gets a fresh set of passphrase attempts; under launchd a crash loop restarts every 30 seconds.
- **Why not now**: persisting lockout state needs a store change and a decision on retention; restarts are rare and under the user's control.
- **Approach**: persist lockout buckets (and their expiry) next to the token store.

## The login-expiry acceptance step was not demonstrated live

- **Problem**: acceptance step 5 (log out of a site in Aside → search reports `auth_required` with an action, the site shows `needs_login`, "Check now" after re-login returns it to `active`) was not run; the path is covered only by unit tests and by the agent having met real Naver login walls.
- **Blast radius**: a site-specific mistake in recognizing a lapsed session would surface only in real use, as a wrong `empty` or `adapter_error`.
- **Why not now**: it needs the user to log out of and back into a site in Aside.
- **Approach**: run it with the user next time a site's session is due to be refreshed.

## Anyone who reaches the public URL can fill the client registration cap

- **Problem**: `POST /oauth/register` needs no authentication and has no rate limit; it is bounded only by the 50-client cap on DCR registrations and a 64 KiB body limit. Clients that never obtain a token are purged only 7 days after registration.
- **Blast radius**: after 50 junk registrations, Claude (which registers through DCR) cannot add the connector again until the user revokes clients in the dashboard; ChatGPT (CIMD) is unaffected.
- **Why not now**: choosing a rate limit (per IP behind `trustedProxyHeader`, global otherwise) or a shorter purge for never-used clients is a design decision the user has not made.
- **Approach**: purge registrations that never received a token after a short period (for example an hour) and rate-limit registrations like consent attempts.

## A hand-edited live adapter loads without re-validation

- **Problem**: the loader requires a passed full `validation.json` but does not compare its `adapterHash` with the files, so an edited `adapter.ts` or `manifest.json` in a live folder is loaded after the next restart without a real-site validation. Only the Reuters reference adapter has a unit test that catches a stale hash.
- **Blast radius**: an unvalidated adapter (still static-checked) serves research clients; a completeness regression could return teaser text as `ok`.
- **Why not now**: refusing to load on a hash mismatch changes startup behavior for every site and needs a decision on how a user is told (status `failed` with a "validate again" reason is one option).
- **Approach**: compare the hash in `inspectSiteFolder` and treat a mismatch as not loadable, or extend the hash test to every committed site.

## The Codex helper's restrictions depend on experimental app-server features

- **Problem**: the Codex runtime is restricted by giving its thread no execution environment (`environments: []`), passing the bridge's tools as dynamic tools, disabling tool-adding features by name, and rewriting the model catalog Codex reports. These are experimental app-server interfaces of Codex 0.160.0; a later Codex may rename keys, change the catalog, or add a tool that produces no thread item.
- **Blast radius**: a renamed key fails closed (`--strict-config` refuses to start, the job fails); a new tool that bypasses the item guard would give the helper a capability beyond the bridge's tools on Codex only.
- **Why not now**: there is no stable Codex interface for "only these tools"; the verified version is the best available evidence.
- **Approach**: the runner warns on every run with another version (`VERIFIED_CODEX_VERSION`); re-run `src/adapters/onboarding/codex-runtime.AGENTS-evidence.md` after each Codex upgrade, and remove the Codex entry from the runtime registry if a restriction cannot be shown.

## Claude's sign-in state cannot be probed without a model call, so `auto` always picks Claude

- **Problem**: the Claude probe reports `installed` whenever the Agent SDK resolves (it is a dependency) and `signedIn: null` unless `ANTHROPIC_API_KEY` is set. `null` counts as available, so `onboarding.runtime: auto` selects Claude on every Mac, including one that has only Codex signed in.
- **Blast radius**: a ChatGPT-only user who keeps `auto` gets helper jobs that fail with a Claude sign-in message; Getting started step 4 stays "to do" after Check, and the automatic helper check tries Claude again after every core start (nothing `ok` is recorded for it). The guides tell such users to select Codex.
- **Why not now**: telling whether Claude Code is signed in needs a model call or reading Claude Code's credential store, which the bridge must not do.
- **Approach**: fall back to Codex in `auto` when a Claude run fails with "not signed in", or remember the last helper check's result for the selection.

## The connection tool's profile keeps the target address it was created with

- **Problem**: the program-managed tunnel-client profile is written once at setup with `--mcp-server-url` set to the public side's address of that moment. Changing `publicPort` or `PUBLIC_URL` later does not rewrite the profile.
- **Blast radius**: after such a change the managed tool forwards ChatGPT's traffic to the old address; the state may still reach `ready` only if the old address answers, else `failed`; ChatGPT cannot reach the program until the connection is set up again.
- **Why not now**: ports and `PUBLIC_URL` are file-only settings and rarely change; rewriting the profile on every start needs the runtime key path and a decision on replacing a profile the user may have edited.
- **Approach**: compare the profile's target with `mcpTargetUrl(config)` at core start and report a mismatch on the Connection area; until then, run ChatGPT setup again with "replace".

## The opener on a fresh folder can find another copy's settings page on port 8788

- **Problem**: the opener probes the settings-page port from the folder's own `.env`/`config/bridge.json`, defaulting to 8788. In a second checkout without its own port setting, a bridge of another folder already answers there, so the opener skips installation and registration and waits for its own `data/admin-token`, which never appears.
- **Blast radius**: after 150 s the opener reports that another program answers on the port; nothing is changed. Affects a second copy on the same Mac (development, a test instance), not a single install.
- **Why not now**: telling "this folder's bridge" from another one needs a check of the answering process's working directory or a folder-specific marker in the page's answer.
- **Approach**: give each checkout its own `BRIDGE_ADMIN_PORT` in `.env` before double-clicking (documented for test instances), or add a folder marker the opener can compare.

## The owner's tunnel-client was not installed the official way

- **Problem**: the owner's copy of tunnel-client 0.0.14 lives at `~/.local/opt/tunnel-client/0.0.14/` (symlinked from `~/.local/bin/tunnel-client`), which does not match the Homebrew layout the official repository gives as the supported macOS install; how it was installed is unknown.
- **Blast radius**: this Mac only. The program finds the tool on `PATH` or through `TUNNEL_CLIENT_BIN`, so it works either way; but the tool's interface was confirmed on this copy, and a copy not from the official tap may differ from what users install with `brew install openai/tools/tunnel-client`, and may not be notarized.
- **Why not now**: replacing the tool on the owner's Mac is the owner's decision and touches files outside the project.
- **Approach**: the owner installs from the official tap (`brew install openai/tools/tunnel-client`), removes the old copy, and re-runs `tunnel-client --version` and the ChatGPT connection check.

## Adapter-kit doc comments still say a block page starts a cool-down

- **Problem**: since decision 0015 only `rate_limited` starts a cool-down, but the doc comments in `src/adapter-kit/completeness.ts` (the `blockPage` rule and the `blocked` verdict) and `src/adapter-kit/results.ts` (`blocked` of `searchFailure`/`readFailure`) still say a block or captcha page makes the site cool down. These files are also served to the helper through `read_reference`.
- **Blast radius**: the helper or a person writing an adapter may expect a pause that no longer happens and report a throttle page with `blocked` only; code behavior is correct.
- **Why not now**: any change to `src/adapter-kit/` requires a live `npm run site:validate -- <key>` for every site (`docs/standards.md`), which needs the Aside app and the site logins.
- **Approach**: correct the comments together with the next kit change that is validated live; until then `docs/ADAPTERS.md` §5 states the current rule.

## DataDome's slider sits in a cross-origin frame the solver cannot see

- **Problem**: the captcha solver detects widgets in the tab's main frame only and never reaches inside a cross-origin frame. DataDome (Reuters) draws its slider inside its own `captcha-delivery.com` iframe, so the attempt reports `kind: unknown` and does nothing.
- **Blast radius**: a Reuters read or search that meets DataDome's slider is captcha-limited (decision 0016): the call answers at once with "reuters is captcha-limited: its bot check cannot be solved automatically. Open <url> in Aside, solve it, then retry", after one quick attempt bounded by `captchaDetectBudgetMs` (20 s); the user has to solve every such check by hand. Other vendors whose challenge lives inside their frame behave the same.
- **Why not now**: acting inside the frame needs the frame's own coordinates (CDP frame targets or a script in the vendor's frame), which would bypass the shim's frame rules. On 2026-10-08 a live DataDome check ended `unknown` with no round because the widened reload never reached detection within the 45 s budget, so the in-frame case itself is still unobserved, and so is the captcha-limited answer.
- **Approach**: confirm with `npm run browser:captcha-check -- <reuters url>`; if DataDome sliders are common, design a frame-aware detection that stays inside the bridge's privileged step and never runs page scripts in vendor frames (for example through the accessibility tree of the vendor frame).
