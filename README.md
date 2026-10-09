# Browser Research Bridge

English · [한국어](README.ko.md)

Browser Research Bridge is a program for your Mac that lets ChatGPT search and read websites you are logged in to, such as a news site you subscribe to. It does this through your own Aside browser, so the sites see your normal login and your passwords never leave the Mac. You set it up and change it on a settings page that opens only on your Mac.

## What you need, and why

| What                                                                             | Why                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Mac                                                                            | The program runs only on macOS.                                                                                                                       |
| Node.js 24 or later ([nodejs.org](https://nodejs.org/), the LTS installer)       | The program is written for it.                                                                                                                        |
| The Aside app, open, with its command-line tool signed in (`aside login`)        | The program opens websites in your Aside browser, where you are logged in to them.                                                                    |
| Homebrew ([brew.sh](https://brew.sh)) and OpenAI's connection tool               | The connection tool (`tunnel-client`) keeps a private tunnel between ChatGPT and your Mac. Homebrew installs it.                                      |
| Claude Code or Codex, signed in with your subscription                           | The site-add helper, an AI that prepares a new site for the program, runs on a Claude or ChatGPT subscription you already have. No API key is needed. |
| ChatGPT with developer mode (Settings → Apps & Connectors → Advanced settings)   | ChatGPT connects to the program as a custom connector.                                                                                                |
| An OpenAI platform account ([platform.openai.com](https://platform.openai.com/)) | The tunnel and its key are created there.                                                                                                             |
| A Reuters subscription, only if you want Reuters                                 | Reuters comes with the program. You can add other sites instead.                                                                                      |

## Install: let an AI do it (easiest)

Paste this sentence into the AI in Aside, into Claude Code, or into Codex. Replace `<project page address>` with the address of this page (the address in your browser's address bar when you look at this project on GitHub):

```text
Install Browser Research Bridge on this Mac for me. Read and follow INSTALL-WITH-AI.md from <project page address> step by step, stop and ask me whenever it says only I can do something, and talk to me in my language.
```

The AI follows [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md). It stops and asks you whenever something only you may do comes up: typing your Mac password, signing in, creating the runtime key, creating the access passphrase, and approving ChatGPT's connection. Never give it a key, a password, or the passphrase.

## Install: by hand

1. Install Node.js 24 or later from [nodejs.org](https://nodejs.org/) (the LTS installer), Homebrew from [brew.sh](https://brew.sh), the Aside app, and Claude Code or Codex. Sign in to Aside's command-line tool and to Claude Code or Codex.
2. Open the Terminal app (press Command-Space, type `Terminal`, press Return). Paste each line below, one at a time, and press Return after each.

   Install OpenAI's connection tool (the official method from [OpenAI's repository](https://github.com/openai/tunnel-client)):

   ```sh
   brew install openai/tools/tunnel-client
   ```

   Sign Aside's command-line tool in, if you have not done so (the Aside app must be open):

   ```sh
   aside login
   ```

   Get the program. Replace `<project page address>` with the address of this page:

   ```sh
   cd ~
   ```

   ```sh
   git clone <project page address> browser-research-bridge
   ```

   Open the program's folder in Finder:

   ```sh
   open ~/browser-research-bridge
   ```

3. In that Finder window, double-click **Open Settings.command**. A Terminal window opens. The first time, it:
   - checks Node.js;
   - installs the program's components (this can take a few minutes);
   - creates the two settings files;
   - asks once whether to register the program as a background service that starts at every login. Press Return to agree;
   - opens the settings page in your default browser.

   When it says the window can be closed, close it.

4. On the settings page, follow **Getting started**. It is a checklist of five steps, and each step checks itself: set the access passphrase, check the Aside browser, connect ChatGPT, check the site-add helper, and log in to a site (Reuters, or add your own). The page explains each step.

The access passphrase is a long password only you know. You type it once, when ChatGPT connects to the program for the first time, so nobody else can connect. The page can create one for you; keep it in a safe place such as your password manager.

If you use only a ChatGPT subscription (Codex) and not Claude, open the **Settings** tab and choose **Codex (ChatGPT subscription)** under **Helper runtime** before you add a site.

## Every day

The program starts by itself when you log in to your Mac and keeps running in the background. It works while the Mac is awake and the Aside app is open. To open the settings page again, double-click **Open Settings.command** in the `browser-research-bridge` folder in your home folder.

When a site shows a bot check or has logged you out, the program asks the AI inside the Aside browser (the Aside AI) to pass the check, or to log in again with the password saved in the Aside browser, and tells ChatGPT to try again in a minute. This uses your Aside plan; you can turn it off on the settings page under Settings → Aside AI. If the Aside AI needs you, for example because the site asks for a verification code, the site's card on the settings page says what to do: do it in the Aside browser, then press **Check now**.

## Update

Double-click **Open Settings.command**. When a new version is available, it says so and asks first: press Return to update now, or type `n` and press Return to skip (it opens the current version and asks again next time). The update downloads the new version, installs its components, restarts the background service, and opens the settings page. Your settings, your data, and sites you keep only on this Mac are kept.

The opener skips the update, and says why, when you changed files in the program's folder yourself. While the site-add helper is working on a site, it waits: double-click again after the helper is done. If installing the components fails, check the internet connection and double-click the opener again.

To update by hand instead (the opener does the same steps), paste these lines in Terminal, one at a time:

```sh
cd ~/browser-research-bridge
```

```sh
git pull
```

```sh
npm ci
```

```sh
ops/install-launchd.sh --bridge
```

The last line restarts the background service with the new version. Then double-click **Open Settings.command** to open the settings page again (a restarted program needs a new sign-in, which the opener does for you). Your settings and the sites you added are kept.

## Stop or remove

To stop the program and remove its background service (your settings and sites stay in the folder):

```sh
cd ~/browser-research-bridge
```

```sh
ops/install-launchd.sh --uninstall --bridge
```

To start it again later, double-click **Open Settings.command**; it asks again before registering the background service. To remove the program completely, run the two lines above, then delete the `browser-research-bridge` folder.

## Common sticking points

| What you see                                                                                       | What to do                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS says **Open Settings.command** cannot be opened because it is from an unidentified developer | This happens when the program was downloaded as a ZIP file. Getting it with `git clone` as above avoids it. Otherwise, Control-click the file, choose **Open**, then **Open** again. On newer macOS versions, try to open it once, then go to System Settings → Privacy & Security and choose **Open Anyway** for this file. The labels may differ by macOS version. |
| `brew: command not found`                                                                          | Homebrew is not installed, or the Terminal window does not know it yet. Install it from [brew.sh](https://brew.sh); at the end it prints "Next steps" lines: paste and run them, then open a new Terminal window.                                                                                                                                                    |
| macOS asks to install "command line developer tools" when you run `git`                            | Click **Install** and wait, then run the `git clone` line again.                                                                                                                                                                                                                                                                                                     |
| The opener says Node.js is missing or too old                                                      | Install the LTS version (24 or later) from [nodejs.org](https://nodejs.org/), then double-click the opener again.                                                                                                                                                                                                                                                    |
| The settings page says it is no longer signed in                                                   | The program was restarted. Double-click **Open Settings.command**.                                                                                                                                                                                                                                                                                                   |
| The page says only the settings page is running                                                    | Step 1 of Getting started (the access passphrase) is not done, or a settings file has a mistake. The message at the top of the page says which.                                                                                                                                                                                                                      |
| The page says the connection tool or Codex is not installed, but you installed it                  | The background service looks for these tools when it is registered. Run `cd ~/browser-research-bridge` and then `ops/install-launchd.sh --bridge` in Terminal, then double-click the opener.                                                                                                                                                                         |
| The page cannot reach Aside                                                                        | Open the Aside app. If it is open, run `aside login` in Terminal. Then press **Check again**.                                                                                                                                                                                                                                                                        |
| Adding a site fails with a Claude sign-in message, but you use ChatGPT                             | Choose **Codex (ChatGPT subscription)** under Settings → Helper runtime, then press **Retry** on the site.                                                                                                                                                                                                                                                           |
| The opener says the background service is registered for another folder                            | An older copy of the program is registered. Run `ops/install-launchd.sh --bridge` in the new folder to move the registration, or keep using the old folder.                                                                                                                                                                                                          |

---

# For developers and advanced setups

Everything below is for people who work on the code or set things up by hand. The beginner route above covers ChatGPT only; this part also covers Claude.

```
ChatGPT ──(OpenAI Secure MCP Tunnel: tunnel-client)──┐
                                                     ├──> 127.0.0.1:8787  public side: /mcp + OAuth  ──> Aside browser (your logins)
Claude ───(Cloudflare Tunnel: cloudflared)───────────┘
You ──> http://127.0.0.1:8788  settings page (loopback only, never tunneled): Getting started, sites, connection, settings
```

- MCP tools: `search`, `fetch` (ChatGPT's contract), `search_sites`, `read_documents` (typed, for Claude), `list_sites`. Only registered sites are reachable.
- A site is added by pasting its address on the settings page: the helper (Claude Agent SDK or Codex CLI, on the local subscription) writes and validates an adapter in `sites/<key>/`, which is committed to git.
- One process runs the settings page for its whole life and the core (public side, OAuth, tools, sites, jobs) under run-mode control. Without a valid `BRIDGE_PASSPHRASE` the process stays in setup-only mode: the public side and the connection tool are not started. See [docs/business-rules.md](docs/business-rules.md#run-modes) and [docs/security.md](docs/security.md).

Documentation: [operations](docs/operations.md) (setup order, configuration, launchd, upgrades) · [security](docs/security.md) · [DASHBOARD](docs/DASHBOARD.md) (the settings page) · [ONBOARDING](docs/ONBOARDING.md) (the helper) · [ADAPTERS](docs/ADAPTERS.md) (writing adapters) · [BROWSER](docs/BROWSER.md) (Aside port and page-script shim) · [ops/](ops/README.md) (launchd and the opener). Contributors and coding agents start at [AGENTS.md](AGENTS.md) (same as [CLAUDE.md](CLAUDE.md)).

## 1. Prerequisites

| Requirement                         | Check / how                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS, `git`                        | `git --version`                                                                                                                                                                                  |
| **Node.js ≥ 24** (with npm)         | `node --version` → `v24.x` or later (`package.json` `engines`)                                                                                                                                   |
| **Aside app** installed and running | Keep it open whenever the bridge should answer.                                                                                                                                                  |
| **Aside CLI** signed in             | `aside --version`; `aside login`; `aside account` lists account ids (`u0`, `u1`, …). The bridge uses `u0` unless you set `asideAccount`. If `aside` is not on `PATH`, set `ASIDE_CLI` in `.env`. |
| **Site logins inside Aside**        | Log in, in the Aside browser and with the same account, to every login-only site you will add (e.g. reuters.com with your subscription).                                                         |
| Helper runtime                      | Claude Code signed in on this Mac (or `ANTHROPIC_API_KEY` in `.env`), or Codex signed in (`codex login status`). Needed only to add or repair sites. Chosen by `onboarding.runtime`.             |
| Tunnel for ChatGPT                  | OpenAI's `tunnel-client` (`brew install openai/tools/tunnel-client`; `tunnel-client --version`) and access to Tunnels in your OpenAI organization.                                               |
| Tunnel for Claude                   | `cloudflared` (`brew install cloudflared`); a Cloudflare account and domain only for a named tunnel (Path B).                                                                                    |
| ChatGPT / Claude plans              | ChatGPT with developer mode for custom MCP connectors; Claude with custom connectors and Research.                                                                                               |

## 2. Install from source

```sh
git clone <repository URL> browser-research-bridge
cd browser-research-bridge
npm install                                  # exact versions pinned in package.json and package-lock.json
cp .env.example .env && chmod 600 .env
cp config/bridge.example.json config/bridge.json
```

The passphrase can be set on the settings page (Getting started step 1) or in `.env` (`BRIDGE_PASSPHRASE=`, 12 or more characters). Without it the bridge starts in setup-only mode. The opener (`Open Settings.command`) does the same steps and registers the launchd agent; see [ops/README.md](ops/README.md).

`config/bridge.json` holds ports, Aside account, data directory, redirect-URI allowlist, `trustedProxyHeader`, `git.autoCommit`, onboarding model and runtime, the managed ChatGPT connection marker, and tunables. Precedence: **environment variables > `config/bridge.json` > built-in defaults**. The full table is in [docs/operations.md](docs/operations.md#configuration-by-role).

## 3. Verify

```sh
npm run verify                               # typecheck + lint + unit tests; must exit 0
npm run browser:check                        # real Aside check (app running, CLI signed in); add -- --account u1 for another account
```

`browser:check` opens example.com in a bridge tab, proves the page-script shim blocks off-site access, and closes the tab. Every line must say `PASS`.

Other scripts: `npm run build` (compile to `dist/`, optional; the bridge runs from source with `tsx`), `npm run dev` (same as start), `npm run format`.

## 4. Run in the foreground

The launchd agent is the normal way to run the bridge. For development, stop the agent first (`launchctl bootout gui/$(id -u)/com.browser-research-bridge`) or use other ports and a separate data folder, then:

```sh
npm start
```

The banner shows the mode. Running:

```
Browser Research Bridge is running
  public listener : http://127.0.0.1:8787 (loopback; expose it through the tunnel)
  public URL      : ...
  MCP server URL  : <PUBLIC_URL>/mcp (OAuth protected resource; add this URL as the connector)
  Aside account   : u0
  sites           : 1 registered
  settings page   : http://127.0.0.1:8788/?token=<one-time token>
```

In setup-only mode it says `Browser Research Bridge is in setup mode: only the settings page runs (no public listener)` with the reason (`passphrase_missing`, `passphrase_too_short`, `config_invalid`, `start_failed`).

Open the settings-page link in a browser on this Mac. It sets a cookie that stays valid until the process restarts (core restarts from the page keep it); the token is also in `data/admin-token`. See [docs/DASHBOARD.md](docs/DASHBOARD.md).

Quick self-test: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp` prints `401` when running, and fails to connect in setup-only mode.

Stop with `Ctrl-C`. The public listener serves only `/mcp` and the OAuth routes (`/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`); everything else is 404. The settings-page port is loopback only and must never be tunneled.

## 5. Connect the research clients

The bridge listens on `127.0.0.1` only. Each research client reaches it through a tunnel. ChatGPT and Claude use different tunnels; both can run at once against the same bridge. In every step below, **the exact UI labels may differ** from what ChatGPT, Claude and the OpenAI platform show today.

**Which `PUBLIC_URL`?** The bridge advertises `<PUBLIC_URL>` as its OAuth issuer and `<PUBLIC_URL>/mcp` as the protected resource, and your browser opens the consent page at `<PUBLIC_URL>/oauth/authorize`.

- ChatGPT alone: leave `PUBLIC_URL` unset (`http://localhost:<publicPort>`) or set it to `http://127.0.0.1:8787`. tunnel-client reads the OAuth metadata from the bridge locally, and the consent page opens in a browser on this Mac.
- Claude (Path B) needs `PUBLIC_URL` = the HTTPS URL of the Cloudflare tunnel. With both clients, ChatGPT's OAuth then also uses it.
- Through tunnel-client, ChatGPT sends the tunnel-service URL as the OAuth `resource` (`https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_<32 hex>`); it must be in `oauth.extraResources`, or consent fails with `invalid_target`. The settings page adds it for you.

Changing `PUBLIC_URL` needs a restart, and connected clients must be removed and re-added (tokens issued for the old URL stop working).

### Path A — ChatGPT through OpenAI's Secure MCP Tunnel (`tunnel-client`)

**Recommended: through the settings page.** Connection → follow sub-steps a–g. You paste a tunnel id and a runtime key; the program stores the key in `~/.config/browser-research-bridge/<profile>-runtime-key` (0600, folder 0700), creates the tunnel-client profile `~/.config/tunnel-client/<profile>.yaml` (referencing the key file, with `harpoon.allow_plaintext_http: true`), adds the tunnel-service address to `oauth.extraResources`, writes the `chatgpt` marker into `config/bridge.json`, restarts the core, and runs tunnel-client as a child of the bridge. Details: [docs/DASHBOARD.md](docs/DASHBOARD.md#connection).

**By hand** (a connection made this way shows as `external` on the page; the program leaves it alone):

1. **Create the tunnel.** In the OpenAI platform, Tunnels management (<https://platform.openai.com/settings/organization/tunnels>), create a tunnel and copy its id, `tunnel_` followed by 32 lowercase hexadecimal characters (0-9, a-f).
2. **Create a runtime key.** Under API keys (<https://platform.openai.com/settings/organization/api-keys>), create a key with **Tunnels Read + Use** for that tunnel. Store it in a file outside the repository, readable only by you:

   ```sh
   mkdir -p ~/.config/browser-research-bridge && chmod 700 ~/.config/browser-research-bridge
   ( umask 077; pbpaste > ~/.config/browser-research-bridge/tunnel-runtime-key )   # after copying the key
   ```

3. **Create the tunnel-client profile** (written to `~/.config/tunnel-client/`; it stores a reference to the key file, not the key):

   ```sh
   tunnel-client init --sample sample_mcp_with_dcr \
     --profile browser-research-bridge \
     --tunnel-id tunnel_<32 hex> \
     --mcp-server-url http://127.0.0.1:8787/mcp \
     --control-plane-api-key-ref file:$HOME/.config/browser-research-bridge/tunnel-runtime-key
   ```

   Then append to `~/.config/tunnel-client/browser-research-bridge.yaml`:

   ```yaml
   harpoon:
     allow_plaintext_http: true
   ```

   Without it tunnel-client refuses to register the bridge's plain-`http` loopback OAuth endpoints (`harpoon: target ... base URL must use https`), and ChatGPT's sign-in never reaches the bridge. The profile's health listener defaults to `127.0.0.1:8080` (`--health-listen-addr` changes it).

4. **Start the bridge** with `"oauth": { "extraResources": ["https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_<32 hex>"] }` in `config/bridge.json`.
5. **Validate the profile**: `tunnel-client doctor --profile browser-research-bridge --explain`; fix every `FAIL`.
6. **Run the tunnel**: `tunnel-client run --profile browser-research-bridge` (foreground), or the launchd agent `ops/install-launchd.sh --tunnel-client browser-research-bridge` ([ops/README.md](ops/README.md)). `curl -fsS http://127.0.0.1:8080/readyz` → 200 when ready.

**Then, either way:**

7. **Add the connector in ChatGPT**: Settings → Apps & Connectors (<https://chatgpt.com/#settings/Connectors>) → Advanced settings → turn on **Developer mode**. Create a connector: name "Browser Research Bridge", choose the **tunnel** (instead of a public URL), authentication **OAuth**, confirm that you trust it.
8. **Consent.** The bridge's consent page opens. Check that the redirect host is `chatgpt.com`, type the access passphrase, approve.
9. **Use it.** In a new chat, enable the connector (Deep Research or plain chat). Each call appears in the bridge log as a `tool call` line.

### Path B — Claude through a Cloudflare Tunnel (`cloudflared`)

Claude needs a public HTTPS URL. Two options:

**Quick tunnel** (no account; the URL changes every time `cloudflared` restarts). The bridge must know its public URL when the core starts:

1. Start the tunnel first, in its own terminal: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787`.
2. Read the printed URL, `https://<random words>.trycloudflare.com`.
3. Put it into `.env`: `PUBLIC_URL=https://<random words>.trycloudflare.com` (no trailing slash).
4. Restart the core: **Restart the program** on the settings page (Settings → Advanced), `launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge`, or `npm start`. The banner shows `MCP server URL : https://<random words>.trycloudflare.com/mcp`.
5. Check from outside: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<random words>.trycloudflare.com/mcp` → `401`.

When `cloudflared` restarts you get a new URL: repeat steps 2–4, then remove the connector in Claude and add it again.

**Named tunnel** (stable hostname; needs a Cloudflare account and a domain on Cloudflare):

```sh
cloudflared tunnel login                                              # once; writes ~/.cloudflared/cert.pem
cloudflared tunnel create browser-research-bridge                     # once; writes ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns browser-research-bridge bridge.example.com
cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:8787 browser-research-bridge
```

Set `PUBLIC_URL=https://bridge.example.com` and restart. For background operation use `ops/install-launchd.sh --cloudflared browser-research-bridge`.

With either Cloudflare option you can set `"trustedProxyHeader": "CF-Connecting-IP"` in `config/bridge.json`, so consent lockouts count per client IP instead of globally ([docs/security.md](docs/security.md)).

**Add the connector in Claude:** Customize (or Settings) → Connectors → Add custom connector. Name "Browser Research Bridge", URL `<PUBLIC_URL>/mcp`, no client id or secret. Add, then Connect; on the consent page check that the redirect host is `claude.ai`, type the passphrase, approve. In a chat, enable the connector and turn on Research.

## 6. Add sites

The Reuters adapter (`reuters`, also the helper's reference adapter) ships in `sites/` and registers itself at first start; it needs your Reuters login in Aside.

- **Settings page:** Sites → paste a URL (`https://www.example.com`) or a site name, optionally a note for the helper, **Add**, and follow the job log under Details. If the job pauses (login wall, captcha, consent banner, or hosts outside the site's domain to approve), do what it asks, then **Retry**.
- **Command line** (stop the bridge first; the CLI refuses while the public port answers):

  ```sh
  npm run site:onboard -- https://www.example.com
  npm run site:onboard -- https://www.example.com --note "search only the archive section"
  npm run site:onboard -- --retry <key>        # after the action the helper asked for
  npm run site:onboard -- --sdk-check          # check the Claude runtime and its authentication only
  ```

  Exit codes: 0 succeeded, 1 failed, 2 setup error, 3 waiting for you.

Details: [docs/ONBOARDING.md](docs/ONBOARDING.md). A new adapter is committed as `site: add <key>` touching only `sites/<key>/`. Afterwards run `npm run verify`, and push the repository to your own remote if you keep one, so a fresh clone recovers the adapter.

**Required site logins.** The bridge never handles credentials. For every site with `requiresLogin`, stay logged in inside Aside (same account as `asideAccount`). When a login expires, the site turns `needs_login` and searches report `auth_required` with the action to take. With the Aside AI on (`assistant.auto`, default; Settings → Aside AI), the program first asks the Aside AI to log in again with the password saved in Aside's password manager, in the background, and returns the site to `active` after a light check ([docs/business-rules.md](docs/business-rules.md#assistant-tasks-the-aside-ai)). Otherwise, or when it needs you, log in again in Aside, then **Check now**.

## 7. Validation procedure

Every adapter must pass a real-site validation (no mocks) before it is loaded ([docs/ADAPTERS.md](docs/ADAPTERS.md) §10):

```sh
npm run browser:check                         # Aside reachable and the shim enforced
npm run browser:captcha-check -- <url>        # one captcha attempt on a page that shows a captcha; prints one JSON line
npm run site:validate -- <key>                # full: static check, sample search (+ page 2), sample read, gated-page check; writes sites/<key>/validation.json
npm run site:validate -- <key> --light        # health-check form; prints only
npm run site:validate -- <key> --staging      # validate sites/<key>/.staging/
```

Exit code 0 means passed. Run the full form after any manual edit of `sites/<key>/adapter.ts` or `manifest.json`, and after upgrades that change `src/adapter-kit`. On the settings page, **Check now** runs the light form for one site.

## 8. Troubleshooting

| Symptom                                                                                   | Cause and fix                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banner or page: setup mode, `passphrase_missing`/`_too_short`                             | Set the passphrase on the settings page (Getting started step 1), or in `.env` and restart.                                                                                                                                                                                     |
| Setup mode, `config_invalid`                                                              | A settings file has a mistake; the message names the file and value. Fix it and save on the page, or press **Restart the program**.                                                                                                                                             |
| Setup mode, `start_failed` with `EADDRINUSE`                                              | Port 8787 is taken (often a second bridge). Stop it, or change `publicPort` and the tunnel target. If the settings-page port 8788 is taken, the process exits with code 1.                                                                                                      |
| `401` on `/mcp`                                                                           | Expected without a token. From a connected client: the token expired and could not be refreshed, was revoked on the page, the tunnel address was removed from `oauth.extraResources`, or `PUBLIC_URL` changed. Remove and re-add the connector, then consent again.             |
| Claude: "Couldn't reach the MCP server"                                                   | The tunnel or the bridge is down, or the quick-tunnel URL changed. `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_URL/mcp"`; anything but `401` means the path is broken. Restart in Path B order and re-add the connector if the URL changed.                      |
| ChatGPT cannot create or use the connector                                                | Managed connection: the Connection area shows the state and the last problem; **Try again** restarts the tool. Hand-made connection: `tunnel-client doctor --profile <profile> --explain` and `curl -fsS http://127.0.0.1:8080/readyz`. The connector must use the same tunnel. |
| Consent page: "redirect_uri is not allowed by this bridge"                                | Add the client's callback URL to `redirectUriAllowlist` in `config/bridge.json` and restart.                                                                                                                                                                                    |
| Consent page: too many failed attempts                                                    | Lockout after wrong passphrases (5 per IP with `trustedProxyHeader`, else 20 globally). Wait 15 minutes.                                                                                                                                                                        |
| `browser_unavailable`                                                                     | Aside is not running, the Aside CLI is signed out, or `aside` is not found. Open Aside, run `aside login`, check `aside account`, then `npm run browser:check`. Under launchd `ASIDE_CLI` must be the absolute path (the installer sets it).                                    |
| Site `needs_login` / status `auth_required`                                               | The site's login in Aside expired. Log in again in Aside (same account), then **Check now**.                                                                                                                                                                                    |
| Site `degraded` / `adapter_error`                                                         | Three consecutive adapter errors or a failed health check. Read the last failure, try **Check now**, then **Repair**.                                                                                                                                                           |
| `rate_limited`                                                                            | The site throttled. The bridge leaves it alone for 10 minutes. If it happens with several calls at once, lower `tunables.maxConcurrentPerSite`.                                                                                                                                 |
| `access_denied` "The captcha could not be solved automatically"                           | The site showed a captcha or block page and the bridge's one automatic attempt did not clear it (Settings → Captchas). Open the named page in Aside, solve it, then retry.                                                                                                      |
| `access_denied` "<site> is captcha-limited"                                               | The site showed a bot check the bridge cannot act on (for example DataDome's slider on Reuters), so it answered at once without retrying. Open the named page in Aside, solve it, then retry.                                                                                   |
| Action "The Aside AI is passing the check now" / "… is logging in now; retry in a minute" | The bridge handed the bot check or the login to the Aside AI in the background (Settings → Aside AI). Retry after a minute; the site's card shows the task and its result.                                                                                                      |
| Action "The site asked for a verification code — …" (or another Aside AI reason)          | The Aside AI stopped because only you can go on. Do what it says in the Aside window of the named account, then **Check now**; until then the program starts no further Aside AI task for that site.                                                                            |
| Settings → Aside AI warns that Aside's command-line tool was not found or is signed out   | `aside account status` did not answer. Run `aside login` (under launchd check `ASIDE_CLI`), then **Restart the program**.                                                                                                                                                       |
| A helper job fails at once                                                                | The page's helper check (Getting started step 4) shows the runtime and the reason. Claude: sign in to Claude Code or set `ANTHROPIC_API_KEY`; Codex: `codex login`. A usage limit fails the job; Retry later.                                                                   |
| Settings page shows 401/403                                                               | Double-click `Open Settings.command`, or open the newest link (each process start issues a new token; it is in `data/admin-token`). Use `127.0.0.1` or `localhost`, not another hostname.                                                                                       |

More in [docs/operations.md](docs/operations.md).

## 9. Background service (launchd)

```sh
ops/install-launchd.sh                                                    # bridge (what the opener runs)
ops/install-launchd.sh --bridge --tunnel-client browser-research-bridge    # + a hand-made ChatGPT tunnel
ops/install-launchd.sh --bridge --cloudflared browser-research-bridge      # + named Cloudflare tunnel
ops/install-launchd.sh --uninstall                                         # removes all agents (bridge and tunnels)
ops/install-launchd.sh --uninstall --bridge                                # removes only the bridge agent
```

A program-managed ChatGPT connection needs no tunnel agent: the bridge runs tunnel-client itself. Logs go to `~/Library/Logs/browser-research-bridge/`. Details and caveats: [ops/README.md](ops/README.md).

## 10. Fresh clone recovery

Everything needed to rebuild the setup is in the repository, including every onboarded adapter (`sites/<key>/`, committed), except a site folder you keep out of git on purpose (see [docs/standards.md](docs/standards.md#configuration)). Machine-specific state lives outside it:

1. Install the prerequisites (section 1).
2. `git clone`, then double-click `Open Settings.command` (or `npm install`, copy the two example files, `npm run verify`, `npm start`).
3. On the settings page: set the passphrase, check Aside, log in to every login-only site inside Aside.
4. Connect ChatGPT again through the page (a new runtime key; the old key file is outside the repository) and/or recreate the Cloudflare tunnel (Path B).
5. Committed adapters with a passed `validation.json` are registered as `active` automatically; `data/` (registry state, OAuth clients, cache, jobs) starts empty, so connectors must be added again.
