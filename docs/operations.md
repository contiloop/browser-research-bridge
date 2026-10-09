# Operations

## Prerequisites

| Requirement                                                                                                                                                                                | Check                                                                                                               | Needed for                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| macOS with `git`                                                                                                                                                                           | `git --version`                                                                                                     | everything; auto-commit of adapters                   |
| Node.js 24 or later with npm                                                                                                                                                               | `node --version` → `v24.x` or later                                                                                 | everything                                            |
| Aside app installed and running                                                                                                                                                            | the app window is open                                                                                              | every browser step                                    |
| Aside CLI signed in                                                                                                                                                                        | `aside --version`; `aside login`; `aside account` lists `u0`; `aside account status` exits 0 (the Aside AI's probe) | every browser step; the Aside AI                      |
| For the Aside AI (`assistant.auto`, on by default): an Aside plan that includes its AI, and site passwords saved in Aside's password manager                                               | Settings → Aside AI on the settings page shows no warning                                                           | passing bot checks and logging in again automatically |
| Site logins inside Aside, same account                                                                                                                                                     | log in to reuters.com, … in the Aside browser                                                                       | login-only sites                                      |
| Helper runtime: Claude Code signed in (or `ANTHROPIC_API_KEY`), or Codex signed in (`codex login`)                                                                                         | the settings page's helper check (Getting started step 4); `npm run site:onboard -- --sdk-check` for Claude         | adding and repairing sites only                       |
| Homebrew and OpenAI `tunnel-client` (`brew install openai/tools/tunnel-client`, the official tap per <https://github.com/openai/tunnel-client>), Tunnels access in the OpenAI organization | `tunnel-client --version`                                                                                           | ChatGPT                                               |
| `cloudflared` (`brew install cloudflared`); a Cloudflare account and domain for a named tunnel                                                                                             | `cloudflared --version`                                                                                             | Claude                                                |
| ChatGPT with developer mode; Claude with custom connectors and Research                                                                                                                    | —                                                                                                                   | connecting the clients                                |

Install the connection tool and Codex before the background service is registered: the installer records their locations (`TUNNEL_CLIENT_BIN`, `CODEX_BIN`) in the service definition, because launchd's `PATH` is minimal. After installing one later, run `ops/install-launchd.sh --bridge` again.

## Initial setup (run in order)

The normal way for a user is the beginner guide in `README.md`: `git clone`, then double-click `Open Settings.command`, which installs the dependencies, creates `.env` (0600) and `config/bridge.json` from the examples, registers the background service, and opens the settings page; Getting started on the page does the rest. The steps below are the developer's equivalent.

```sh
# 1. Code and pinned dependencies (exact versions from package-lock.json)
git clone <repository URL> browser-research-bridge
cd browser-research-bridge
npm install

# 2. Local configuration (both files are git-ignored)
cp .env.example .env && chmod 600 .env
cp config/bridge.example.json config/bridge.json
# The passphrase (12+ characters) can be set later on the settings page; until then the bridge runs
# in setup-only mode. To set it by hand: openssl rand -base64 24, paste after BRIDGE_PASSPHRASE= in .env

# 3. Offline gate: typecheck, lint, unit tests; needs no browser
npm run verify                   # must exit 0

# 4. Real browser gate: needs the Aside app running and the CLI signed in
npm run browser:check            # every line PASS, exit 0; add -- --account <id> when not u0
```

Step 3 must pass before anything else is debugged. Step 4 fails with `browser_unavailable` until Aside is running and `aside login` was done; it opens and closes one bridge tab on example.com.

## Setup-only mode

The process always starts the settings page first (on `adminPort`, from a valid environment override, else a valid value in a readable `config/bridge.json`, else 8788; likewise `dataDir`). Then it tries to start the core. Without a valid `BRIDGE_PASSPHRASE`, with a malformed or invalid setting, or when the core fails to start (for example the public port is in use), the process stays up in `setup` with only the settings page: the public port is not bound and no connection tool runs. The banner and the page say why (`passphrase_missing`, `passphrase_too_short`, `config_invalid`, `start_failed`). Fixing the setting on the page and saving starts the core; after a hand edit, press **Restart the program** (Settings → Advanced) or restart the service. Only a settings-page port that cannot be bound ends the process (exit code 1).

Check: in setup mode `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp` cannot connect; when running it prints `401`. `GET /api/status` on the settings page reports the mode.

## Exposure and start order

Each client reaches the bridge through its own tunnel; both may run at once against the same bridge. The core must know its public origin (`PUBLIC_URL`) when it starts, because the OAuth issuer and resource are derived from it.

### ChatGPT through the settings page (normal)

Connection → sub-steps a–g on the settings page: the user installs the tool if missing, creates a tunnel and a runtime key on the OpenAI platform, pastes both, then adds the connector in ChatGPT and approves it with the passphrase. Given a tunnel id and a runtime key, the program writes the key to `~/.config/browser-research-bridge/<profile>-runtime-key` (0600, folder 0700), runs `tunnel-client init` for `~/.config/tunnel-client/<profile>.yaml` (key referenced as `file:<path>`, health listener `127.0.0.1:0`, `harpoon.allow_plaintext_http: true` appended), adds `https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/<tunnel id>` to `oauth.extraResources`, writes `"chatgpt": { "managed": true, "tunnelId", "profile" }` to `config/bridge.json`, restarts the core, and runs `tunnel-client run` as its child after every core start (restarted with increasing delay after an exit: 1, 2, 5, 10, 30 s; `failed` after 5 consecutive failures, then **Try again**). The profile targets the public side's `/mcp`: `http://localhost:<publicPort>/mcp` with the default `PUBLIC_URL`, else `http://127.0.0.1:<publicPort>/mcp`. No tunnel-client launchd agent is needed. Disconnect undoes all of it except the profile file.

A connection made by hand (below) without the marker is `external`; the page leaves it and any agent running it alone. Do not run a managed and a hand-made tool for the same tunnel at once.

### Claude through a Cloudflare quick tunnel (no account; URL changes on every tunnel restart)

```sh
# 1. Tunnel first, in its own terminal
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787
# 2. Copy the printed https://<words>.trycloudflare.com into .env (no trailing slash)
#    PUBLIC_URL=https://<words>.trycloudflare.com
# 3. Start (or restart) the bridge
npm start
# 4. Check from outside: 401 means the tunnel and the bridge answer and a token is required
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://<words>.trycloudflare.com/mcp"
```

Starting the bridge before step 2 makes it advertise the wrong issuer; restart it after setting `PUBLIC_URL`. Every `cloudflared` restart means: new URL → `PUBLIC_URL` → bridge restart → remove and re-add the Claude connector.

### Claude through a Cloudflare named tunnel (stable hostname)

```sh
cloudflared tunnel login                                              # once; writes ~/.cloudflared/cert.pem
cloudflared tunnel create browser-research-bridge                     # once; writes ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns browser-research-bridge bridge.example.com
cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8787 browser-research-bridge
```

Set `PUBLIC_URL=https://bridge.example.com`, then start the bridge. With either Cloudflare option, set `"trustedProxyHeader": "CF-Connecting-IP"` in `config/bridge.json` so consent lockouts count per client IP.

### ChatGPT through OpenAI's Secure MCP Tunnel, by hand

```sh
# 1. In the OpenAI platform (Settings → Organization → Tunnels) create a tunnel and copy its id tunnel_<32 hex>.
# 2. Create a runtime API key with Tunnels Read + Use for that tunnel; store it outside the repository:
mkdir -p ~/.config/browser-research-bridge && chmod 700 ~/.config/browser-research-bridge
( umask 077; pbpaste > ~/.config/browser-research-bridge/tunnel-runtime-key )
# 3. Profile (stores a reference to the key file, not the key)
tunnel-client init --sample sample_mcp_with_dcr \
  --profile browser-research-bridge \
  --tunnel-id tunnel_<32 hex> \
  --mcp-server-url http://127.0.0.1:8787/mcp \
  --control-plane-api-key-ref file:$HOME/.config/browser-research-bridge/tunnel-runtime-key
# 3b. Allow the plain-http loopback OAuth endpoints (otherwise tunnel-client logs
#     "harpoon host auto-registration failed ... base URL must use https" and ChatGPT's sign-in cannot reach the bridge)
printf 'harpoon:\n  allow_plaintext_http: true\n' >> ~/.config/tunnel-client/browser-research-bridge.yaml
# 4. Add the tunnel's OAuth resource to config/bridge.json, then (re)start the bridge:
#    "oauth": { "extraResources": ["https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_<32 hex>"] }
npm start
# 5. Validate the profile against the running bridge, then run the tunnel
tunnel-client doctor --profile browser-research-bridge --explain     # fix every FAIL it explains
tunnel-client run --profile browser-research-bridge                  # keep running
curl -fsS http://127.0.0.1:8080/readyz                               # 200 when ready; UI at http://127.0.0.1:8080/ui
```

`doctor` needs the bridge running, because tunnel-client discovers the OAuth metadata from `http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp`. At acceptance, ChatGPT's tunnel ran next to a Cloudflare quick tunnel with `PUBLIC_URL` set to the Cloudflare URL, so the consent page opened through that URL. If the bridge's `publicPort` changes, change the port in `--mcp-server-url` too.

### Connecting the clients

- **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode on → Create: name "Browser Research Bridge", choose the tunnel, authentication OAuth. On the consent page check that the redirect host is `chatgpt.com`, type the passphrase, approve.
- **Claude**: Settings → Connectors → Add custom connector: URL `<PUBLIC_URL>/mcp` (the `MCP server URL` line of the banner), no client id or secret. Connect, check that the redirect host is `claude.ai`, type the passphrase, approve.
- Verify: a tool call from each client appears in the bridge log as `tool call` with that client's id.

Full order after a reboot: Aside app → (quick tunnel: `cloudflared`, then `PUBLIC_URL`) → bridge → `tunnel-client` → clients. Exact UI labels in ChatGPT, Claude, and the OpenAI platform may differ from the ones above.

## Configuration by role

Precedence: environment variables > `config/bridge.json` > built-in defaults. An empty variable counts as unset. Settings saved on the settings page restart the core automatically; any other change (a hand edit of `.env` or `config/bridge.json`) takes effect at the next core restart (**Restart the program** on the page) — except `adminPort`, `dataDir`, `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, and `BRIDGE_LOG_LEVEL`, which are read once at process start and need a process restart.

The page edits only `BRIDGE_PASSPHRASE`, `onboarding.runtime`, `captcha.auto`, `assistant.auto`, `asideAccount` (or the `BRIDGE_ASIDE_ACCOUNT` line in `.env` when that is where the winning value lives), and, through the ChatGPT connection, `chatgpt` and `oauth.extraResources`; it leaves every other line, key, and comment untouched. A setting whose value comes from an environment variable set outside `.env` (the service definition or the shell) is locked on the page.

| Setting                                                                             | Where                                            | Default                               | Role and valid scope                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRIDGE_PASSPHRASE`                                                                 | `.env` (page: Settings / Getting started step 1) | —                                     | consent-page passphrase, 12+ characters, no line break; without a valid one only the settings page runs (setup-only mode)                                                                                                       |
| `PUBLIC_URL`                                                                        | `.env`                                           | `http://localhost:<publicPort>`       | public origin of the tunnel, no path; issuer = this, resource = this + `/mcp`; changing it invalidates connected clients' tokens                                                                                                |
| `ANTHROPIC_API_KEY`                                                                 | `.env`                                           | unset (local Claude Code login)       | onboarding agent only                                                                                                                                                                                                           |
| `BRIDGE_PUBLIC_PORT` / `publicPort`                                                 | env / config                                     | 8787                                  | loopback port the tunnels target                                                                                                                                                                                                |
| `BRIDGE_ADMIN_PORT` / `adminPort`                                                   | env / config                                     | 8788                                  | dashboard port, loopback only, never tunneled                                                                                                                                                                                   |
| `BRIDGE_ASIDE_ACCOUNT` / `asideAccount`                                             | env / config                                     | `u0`                                  | Aside account whose logins the bridge uses (bridge and `site:validate`; `browser:check` and `browser:captcha-check` read `ASIDE_ACCOUNT` instead)                                                                               |
| `BRIDGE_DATA_DIR` / `dataDir`                                                       | env / config                                     | `data`                                | registry state, OAuth store, cache, jobs, admin token, last helper check                                                                                                                                                        |
| `sitesDir`                                                                          | config                                           | `sites`                               | adapter folders (must be inside the git work tree for auto-commit)                                                                                                                                                              |
| `trustedProxyHeader`                                                                | config                                           | null                                  | header with the real client IP (`CF-Connecting-IP` behind Cloudflare); selects per-IP lockout                                                                                                                                   |
| `redirectUriAllowlist`                                                              | config                                           | Claude, ChatGPT (two forms), loopback | OAuth redirect URIs clients may use                                                                                                                                                                                             |
| `oauth.extraResources`                                                              | config                                           | `[]`                                  | additional OAuth resources accepted (ChatGPT's tunnel-service URL)                                                                                                                                                              |
| `git.autoCommit`                                                                    | config                                           | true                                  | commit `sites/<key>/` after add, repair, remove                                                                                                                                                                                 |
| `onboarding.model`, `onboarding.effort`                                             | config                                           | `claude-opus-5-5`, `high`             | Claude helper model                                                                                                                                                                                                             |
| `onboarding.runtime`                                                                | config (page: Settings → Helper runtime)         | `auto`                                | `auto` (Claude when available, else Codex), `claude`, or `codex`; no environment override, never locked                                                                                                                         |
| `onboarding.codexModel`                                                             | config                                           | null (the Codex CLI's default)        | Codex helper model, one of the Codex CLI's model list                                                                                                                                                                           |
| `chatgpt`                                                                           | config (written by the page)                     | null                                  | the program-managed ChatGPT connection marker `{ managed, tunnelId: tunnel_ + 32 hex, profile }`; absent or null = none                                                                                                         |
| `captcha.auto`                                                                      | config (page: Settings → Captchas)               | true                                  | automatic captcha attempts (live calls, Check now, the helper's captcha tool); a boolean, no environment override, never locked                                                                                                 |
| `tunables.*`                                                                        | config                                           | see `config/bridge.example.json`      | limits, budgets, TTLs, lockout, health interval; positive numbers only, except `concurrentStaggerMs`, which may also be 0                                                                                                       |
| `tunables.maxConcurrentPerSite`, `maxConcurrentTasks`, `concurrentStaggerMs`        | config                                           | 3, 8, 500                             | browser pool: tasks per site at once (also warm tabs per site), tasks across all sites, ms between the starts of overlapping tasks of one site; replaces `maxConcurrentSites`, which is now warned about as unknown and ignored |
| `tunables.captchaAttemptBudgetMs`, `captchaDetectBudgetMs`, `captchaRerunReserveMs` | config                                           | 45000, 20000, 15000                   | one attempt's time; its detection budget (after the slot, until the first detection; a tool call attempts inline only with this plus the reserve left, else in the background); time kept back for the re-run                   |
| `assistant.auto`                                                                    | config (page: Settings → Aside AI)               | true                                  | Aside AI tasks (pass a bot check, log in again with the password saved in Aside) after the bridge's own means failed; a boolean, no environment override, never locked                                                          |
| `assistant.effort`                                                                  | config                                           | `low`                                 | the effort Aside's AI works with: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultrabrowse` (`aside exec --effort`); higher efforts use more of the Aside plan                                                |
| `tunables.assistantTaskBudgetMs`, `assistantFailureWindowMs`, `assistantPauseMs`    | config                                           | 120000, 600000, 600000                | one Aside AI task's time (and its longest wait for a place on the site); the window in which two counted failures pause a site's tasks; how long that pause lasts                                                               |
| `ASIDE_CLI`                                                                         | `.env` / launchd                                 | `aside` on `PATH`                     | absolute Aside CLI path for the REPL child and the Aside AI's `aside exec`, `aside session stop`, `aside account status`; set by the installer under launchd                                                                    |
| `TUNNEL_CLIENT_BIN`                                                                 | `.env` / launchd                                 | `tunnel-client` on `PATH`             | OpenAI's connection tool for the program-managed ChatGPT connection; set by the installer when found                                                                                                                            |
| `CODEX_BIN`                                                                         | `.env` / launchd                                 | `codex` on `PATH`                     | the Codex CLI for the Codex helper runtime; set by the installer when found                                                                                                                                                     |
| `BRIDGE_LOG_LEVEL`                                                                  | `.env`                                           | `info`                                | `debug` adds blocked-request hosts and browser details                                                                                                                                                                          |
| `BRIDGE_ONBOARDING_MAX_TURNS`                                                       | `.env`                                           | 80                                    | agent turn limit per run (1–1000)                                                                                                                                                                                               |
| `ASIDE_ACCOUNT`                                                                     | shell                                            | `u0`                                  | account for `browser:check` and `browser:captcha-check` only                                                                                                                                                                    |

## Run and verify

| Command                                            | Purpose                                                                                                          | Needs                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm start` (= `npm run dev`)                      | run the bridge in the foreground from source under tsx (developers; the launchd agent is the normal way)         | nothing; without a passphrase it runs in setup-only mode |
| `npm run verify`                                   | typecheck + lint + unit tests                                                                                    | nothing external                                         |
| `npm run browser:check`                            | real Aside check of the port and the shim                                                                        | Aside running, CLI signed in                             |
| `npm run browser:captcha-check -- <url>`           | one real challenge attempt on `<url>` (scoped to its host); prints one JSON line; `--account <id>` when not `u0` | Aside running, CLI signed in; a page showing a captcha   |
| `bash test/ops/update-check.test.sh`               | the opener's update check in temporary clones with stubs (not part of `verify`)                                  | stock macOS tools (bash, git, curl, perl)                |
| `npm run site:validate -- <key>`                   | full real-site validation, writes `validation.json`                                                              | Aside, site login                                        |
| `npm run site:validate -- <key> --light`           | health-check form, prints only                                                                                   | Aside, site login                                        |
| `npm run site:validate -- <key> --staging`         | validate `sites/<key>/.staging/`                                                                                 | Aside, site login                                        |
| `npm run site:onboard -- <url\|name> [--note "…"]` | onboarding without the dashboard                                                                                 | bridge stopped                                           |
| `npm run build`                                    | compile to `dist/` (optional; nothing runs it)                                                                   | —                                                        |
| `npm run format`                                   | Prettier over the repository                                                                                     | —                                                        |

Health checks of a running bridge:

| What                            | Command                                                                      | Healthy                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| public listener                 | `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp` | `401`                                                   |
| OAuth metadata                  | `curl -s http://127.0.0.1:8787/.well-known/oauth-protected-resource/mcp`     | `resource` is `<PUBLIC_URL>/mcp`                        |
| through Cloudflare              | `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_URL/mcp"`         | `401`                                                   |
| program-managed tunnel-client   | settings page → Connection state, or `GET /api/chatgpt`                      | `ready`                                                 |
| hand-made tunnel-client         | `curl -fsS http://127.0.0.1:8080/readyz`                                     | `200`                                                   |
| named cloudflared under launchd | `curl -fsS http://127.0.0.1:20241/ready`                                     | `200`                                                   |
| one site                        | `npm run site:validate -- <key> --light`                                     | exit 0                                                  |
| the Aside AI's CLI              | `aside account status` (the program's probe; under launchd use `ASIDE_CLI`)  | exit 0; the page's Settings → Aside AI shows no warning |

`browser:check`, `browser:captcha-check`, and `site:validate` start their own `aside mcp` child; run them when no research session is in progress so they do not compete for the same site.

## Settings page

Double-click `Open Settings.command`; it opens the page signed in. Alternatively open the `settings page : http://127.0.0.1:8788/?token=…` line of the banner (in `bridge.out.log` under launchd). Each process start issues a new token; core restarts keep it. Use `127.0.0.1` or `localhost`, nothing else. Never paste the link or `data/admin-token` into a chat with an AI.

Routine: `needs_login` → log in to the site in the Aside window of the account the card names (`asideAccount`, default `u0`; or paste the offered Aside AI login text), then **Logged in? Check now** (the status changes only then); `degraded` → read the last failure, **Check now** if the cause was temporary (it also makes one captcha attempt on a block page), else **Repair**; `failed` → **Retry** or **Remove**; paused job → do the requested action in Aside, then **Retry**; "The captcha could not be solved automatically" or "<site> is captcha-limited" → open the named page in Aside, solve it, then retry; "The Aside AI is passing the check now" or "… is logging in now; retry in a minute" → nothing to do, retry after a minute (the card says the Aside AI is working on the site); a card with the Aside AI's reason ("The site asked for a verification code — …") → do that in the Aside window of the named account, then **Check now** (until then the program starts no further Aside AI task for the site). Each Aside AI task uses the Aside plan; turn it off under Settings → Aside AI.

## Background operation (launchd)

```sh
ops/install-launchd.sh                                                       # bridge only
ops/install-launchd.sh --bridge --tunnel-client browser-research-bridge      # + ChatGPT tunnel
ops/install-launchd.sh --bridge --cloudflared browser-research-bridge        # + named Cloudflare tunnel
ops/install-launchd.sh --bridge --cloudflared my-tunnel --dry-run /tmp/brb-plists   # preview only
ops/install-launchd.sh --uninstall                                           # remove all agents
```

- The normal registration is the opener's first run (`ops/install-launchd.sh --bridge` after one confirmation). The installer finds `node` (24+), the Aside CLI, `tunnel-client`, the Codex CLI, and `cloudflared` (override with `NODE_BIN`, `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, `CODEX_BIN`, `CLOUDFLARED_BIN`), the env file (`ENV_FILE`, default `<repo>/.env`), and the public port (`PUBLIC_PORT`); fills the templates in `ops/launchd/`; checks them with `plutil -lint`; writes them to `~/Library/LaunchAgents/`; and bootstraps them. It is idempotent: run it again after moving the repository, changing Node, or pulling new templates. No secret is written into a plist.
- Labels: `com.browser-research-bridge`, `com.browser-research-bridge.tunnel-client`, `com.browser-research-bridge.cloudflared`. A quick tunnel is not offered as an agent, because its URL changes on every start.
- The bridge agent runs `node node_modules/tsx/dist/cli.mjs --env-file=<.env> src/app/main.ts` in the repository (the working tree is what runs: a checkout, pull, or edit there takes effect at the next process start) with `PATH`, `ASIDE_CLI`, `TUNNEL_CLIENT_BIN`, and `CODEX_BIN` set for the tools found. It restarts whenever it exits, including after a stray SIGTERM, at most every 30 seconds, and gets 20 seconds for a graceful stop; stop it on purpose with `launchctl bootout`, never with `kill`. A configuration problem does not end the process (setup-only mode); a missing `.env` or an unbindable settings-page port does, and then repeats in `bridge.err.log` every 30 seconds until fixed. Tunnel agents restart whenever they exit.
- Control: `launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge` (restart), `launchctl bootout gui/$(id -u)/com.browser-research-bridge` (stop until the next install or login), `launchctl print gui/$(id -u)/com.browser-research-bridge | grep -E 'state|pid|last exit'` (state).
- Logs: `~/Library/Logs/browser-research-bridge/bridge.out.log` (banner with the settings-page link, info), `bridge.err.log` (warnings, errors), `tunnel-client.{out,err}.log`, `cloudflared.{out,err}.log`; the folder is 0700. launchd does not rotate them: `: > ~/Library/Logs/browser-research-bridge/bridge.out.log`.
- LaunchAgents run only while the user is logged in and the Mac is awake; add Aside to the login items so it is running too.

## Availability

The bridge answers only while the Mac is awake, Aside is running with the CLI signed in, the bridge and the relevant tunnel are running, and the site logins are valid. Keep the Mac awake during research with `caffeinate -dimsu` (or `caffeinate -i -w <bridge pid>`). After wake, the bridge reconnects to Aside by itself (a REPL idle for 30 minutes is replaced with a fresh session; warm tabs are gone); a restarted quick tunnel needs the quick-tunnel procedure again.

## Data and recovery

- `data/` is created at the first start (0700) and can be deleted while the bridge is stopped: registry state, OAuth clients, cache, jobs, and the last helper check (`helper-check.json`; the automatic check then runs again after the next start) start empty; committed adapters with a passed `validation.json` re-register as `active`; every connector must then be added again.
- Clear only the cache: dashboard **Cache → Clear/Clear all**, or stop the bridge and `rm -rf data/cache`.
- Drop every OAuth client: stop the bridge, delete `data/oauth/token-store.json`, start it.
- Fresh clone on a new Mac: prerequisites → `git clone` → double-click `Open Settings.command` → Getting started on the page (passphrase, Aside, ChatGPT connection with a new runtime key, helper check, site logins in Aside) → for Claude, recreate the Cloudflare tunnel (`cloudflared tunnel login`, then reuse `~/.cloudflared/<uuid>.json` or create a new tunnel). A site folder kept private is listed in the clone's local `.git/info/exclude` (on the owner's Mac `sites/blog-naver/`), is never committed, and so is not in a fresh clone; copy it over by hand if needed.

## Upgrade

The normal way is to double-click `Open Settings.command`. Its update check (`ops/update-check.sh`; details in [ops/README.md](../ops/README.md#update-check-opsupdate-checksh)) runs when the folder is the top of a git clone whose branch has an upstream and the background service is registered for this folder (or not registered while nothing runs):

1. `git fetch` of the upstream, ended after 15 s; any failure skips the check silently.
2. The state from the fetch: `behind N` offers the update; `up_to_date` and `no_upstream` show nothing; `diverged` or `dirty` (a tracked file changed) says the update was skipped because of local changes; `excluded` (the update would write to an untracked path that exists here, such as a site folder in `.git/info/exclude`, or change a tracked path listed there) says it was skipped because of files that exist only on this Mac.
3. While the program runs it asks the settings page, through the admin token's cookie exchange, whether a helper job is `running`; then the update waits.
4. Enter (an empty answer) updates: `git pull --ff-only --no-rebase` → `npm ci` → `ops/install-launchd.sh --bridge` (re-renders the plist and restarts the service). `n` or any other answer opens the current version and asks again next time.
5. After a failed `npm ci` or installer, `<git dir>/brb-update-pending` stays and the next double-click offers to finish (`npm ci` and the installer again).

It never force-pulls or resets, and never touches `.env`, `config/bridge.json`, `data/`, or an excluded site folder. By hand, the same steps:

```sh
cd ~/browser-research-bridge     # the project folder
git pull --ff-only
npm ci                           # pinned versions from package-lock.json
npm run verify                   # developers: must exit 0
ops/install-launchd.sh --bridge  # rewrites the plist (new templates, tool locations) and restarts the service
```

Then double-click `Open Settings.command` (a new process needs a new sign-in). `launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge` restarts without rewriting the plist. A folder whose service is registered for another folder, or a program started by hand from a terminal, is not updated by the opener.

Carry new keys from `config/bridge.example.json` and `.env.example` into your copies (missing `assistant` and `tunables.assistant*` keys take their defaults: the Aside AI is on; unknown keys are reported as `config warning` and ignored; for example `tunables.maxConcurrentSites` is now unknown: replace it with `maxConcurrentPerSite`/`maxConcurrentTasks`; an old `tunables.captchaInlineMinRemainingMs` in `config/bridge.json` is likewise warned about and ignored: delete it, and set `captchaDetectBudgetMs` if you want another detection budget). If `src/adapter-kit` or the validation rules changed, run `npm run site:validate -- <key>` for every site. If `ops/launchd/` changed, re-run the installer with the same options. After `aside update` or a tunnel binary upgrade, run `npm run browser:check` (after `aside update` also `npm run browser:captcha-check -- <url>` on a page that shows a captcha, because the solver relies on Aside's `captcha` capability, and `aside account status`; then watch the next `assistant run` log lines: tasks that keep ending `failed`/`other` may mean the `aside exec` output has changed, see `docs/engineering-notes.md`). After a Codex upgrade, re-run the evidence in `src/adapters/onboarding/codex-runtime.AGENTS-evidence.md` (the bridge logs a warning on every run with a version other than the verified one).
