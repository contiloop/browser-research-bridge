# Settings page (dashboard)

The local page where the user sets up the program, changes its few settings, adds sites, and connects ChatGPT. Code: `src/adapters/dashboard/` (API, guards, listener) and `src/adapters/dashboard/ui/` (plain HTML, CSS, and ES modules; no build step, no external resources). `src/app/bridge-process.ts` starts it once per process; it stays up while the core is stopped, started, and restarted, so it also answers in setup-only mode (the core off because the passphrase is missing or too short or a settings file is invalid) and during a restart. The code and older documents call it the dashboard.

## Opening it

- It listens on `http://127.0.0.1:<adminPort>` only (default 8788; `adminPort` in `config/bridge.json` or `BRIDGE_ADMIN_PORT`). It is a separate listener from the public one, and no tunnel may point at it. The public port answers 404 for `/api/*` and `/`.
- **The opener** (`Open Settings.command` at the project top) is the normal way: double-click it in Finder. It checks Node.js 24+, installs the dependencies the first time, creates `.env` and `config/bridge.json` from the examples, registers the background service once after one confirmation (`ops/install-launchd.sh --bridge`) or starts it when registered but not running, waits up to 150 s for the page, and opens it signed in in the default browser. When the page already answers, it only opens it. Its messages are in Korean and English. Details: [ops/README.md](../ops/README.md#open-settingscommand).
- At every process start the bridge creates a new admin token, writes it to `data/admin-token` (0600), and prints the one-time link in the banner:

  ```
    settings page   : http://127.0.0.1:8788/?token=<token>
  ```

  Under launchd the banner goes to `~/Library/Logs/browser-research-bridge/bridge.out.log`. Opening the link sets an `HttpOnly; SameSite=Strict` cookie and redirects to `/`. The cookie works until the process restarts; core restarts (a save, Restart, ChatGPT setup or disconnect) keep it. After a process restart the page shows a bilingual "not signed in" page that says to double-click the opener.

- The token is never shown on the page. Pages and the API show OAuth client names and token ids (storage hashes), never token values, the passphrase, or the runtime key.

## Protection

- Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`; anything else gets 403. This also blocks DNS rebinding and an accidental tunnel to this port.
- Every state-changing request (POST, PUT, DELETE) needs the cookie and an `Origin` equal to the page's own origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`). Otherwise it gets 403. A page open in the Aside browser therefore cannot drive the settings page.
- Reads without the cookie get 401.
- Responses carry a strict Content-Security-Policy (`'self'` only) and `X-Frame-Options: DENY`. Request logs hold method, path, status and timing, never the query string or bodies.
- Server text (job logs can quote web pages) is inserted as text, never as HTML.
- Secrets typed into the page (passphrase, runtime key) are sent once and never come back; the fields are cleared after the program accepted them, and they are kept out of browser storage. Only the page language is stored (`localStorage`).

## Layout

A status line at the top always shows the run mode ("Program"), whether the Aside browser is reachable ("Aside browser", with **Check Aside again**), and the ChatGPT connection state. Below it a banner explains setup-only mode (passphrase missing, a settings-file mistake, or a failed start) or a restart in progress; during a restart the page stays open and reads the new state by itself.

Four tabs: **Getting started**, **Sites**, **Connection**, **Settings** (Korean: 시작하기, 사이트, 연결, 설정). Developer detail (raw job log, ids, technical failure text) is behind **Details** disclosures. Removing a site and disconnecting ask for confirmation once.

### Language

Korean or English. The first choice is Korean when the browser language is Korean, otherwise English; the language switch at the top (and under Settings) changes it, and the choice is remembered in that browser. All wording lives in `ui/i18n.js` and `ui/labels.js`; both languages have the same keys (checked by `ui.test.ts`). The raw job log and server failure texts are shown untranslated under Details. The "not signed in" page and the OAuth consent page show both languages together.

### Getting started

A checklist, not a wizard. Each step shows **Done**, **To do**, or **Cannot check yet**, computed from live state (nothing is stored). The first step not done is expanded. While step 1 is not done, steps 2–5 say "Set the access passphrase first".

| #   | Step                      | Done when                                          | What the page offers                                                                                                                                                |
| --- | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Set the access passphrase | a valid passphrase is set                          | an explanation of the passphrase and the passphrase form (below)                                                                                                    |
| 2   | Aside browser ready       | the browser check reports reachable                | the reason, "open the Aside app", and `aside login` with a copy button                                                                                              |
| 3   | Connect ChatGPT           | at least one connected app holds a live token      | the ChatGPT sub-steps a–g (Connection, below)                                                                                                                       |
| 4   | Site-add helper ready     | the last helper check of this process succeeded    | what the helper is, which runtime would be used and which are installed and signed in, which provider receives page content, and **Check** (one short real request) |
| 5   | Sites                     | at least one site is `active` and has a last check | Reuters with "log in to reuters.com in Aside, then press Check now", and the add-site form                                                                          |

### Sites

- **Add a site**: paste an address (or a name) and press **Add**; an optional note for the helper is behind "Add a note for the helper". The page says the helper then studies the site and prepares it, which takes a few minutes and uses the user's Claude or ChatGPT subscription. The request carries the page language, and the helper writes its request to the user in that language.
- **Your sites**: each site shows its status in plain words, one sentence of what to do now (for example `needs_login` → "Log in at <login address> in Aside, then press Check now"; a paused job shows the helper's request as written), one prominent action, and the others less prominently. Details hold the key, addresses, capabilities, last problem, folder problem, latest job, the runtime the helper ran on, and the cache size.
- **Helper jobs and progress logs** (under Details): recent jobs with kind, site, state, and the helper's request; **Show progress** streams the job log live (SSE, resumes after a reconnect).
- While the core is off, the area shows the reason instead of the list.

| Button         | What it does                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Add**        | Starts a helper job (`jobs.add`). A hostname that is already registered is refused with "already registered as <key>; use Repair or Remove".                                                                                         |
| **Retry**      | Continues a paused (`awaiting_user`) or failed job, or starts a new one for a failed site. Do the requested action first, for example log in to the site in Aside, or approve hosts outside the site's domain (Retry approves them). |
| **Repair**     | The helper fixes the live adapter in staging, with an optional note. The site keeps serving until the new version passes validation.                                                                                                 |
| **Check now**  | Runs the site's light check immediately. After a pass, a `needs_login` site returns to `active` and its cache is cleared.                                                                                                            |
| **Cancel job** | Cancels a queued, paused, or running job.                                                                                                                                                                                            |
| **Remove**     | After confirmation: cancels the site's job, deletes `sites/<key>/`, its state and cache, and commits the removal.                                                                                                                    |

### Connection

The ChatGPT connection. The page explains the tunnel (a private passage OpenAI runs between ChatGPT and this Mac) and the connection tool (`tunnel-client`, which the program starts and stops). It shows the state (`not_configured`, `external`, `stopped`, `starting`, `ready`, `failed`) and the sub-steps, each marked with who does it:

| Step | Who                       | What                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a    | the program               | Detects the connection tool. If missing: a link to OpenAI's official instructions (<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>) and the command `brew install openai/tools/tunnel-client` with a copy button. The program never downloads it.                                                         |
| b    | the user, or the Aside AI | Create a tunnel on the OpenAI platform and copy its id; open the API keys page.                                                                                                                                                                                                                                              |
| c    | the user                  | Create the runtime key (Tunnels: Read and Use), paste it and the tunnel id, press **Connect**. "Advanced" holds the profile name (default `browser-research-bridge`). If a profile or key file with that name exists, the page asks to replace it ("if a connection tool is already running some other way, stop it first"). |
| d    | the program               | Stores the key file, creates the profile, adds the tunnel address to the accepted resources, records the managed marker, restarts the core, starts the tool, and waits for its readiness. **Try again** restarts a `failed` tool.                                                                                            |
| e    | the user, or the Aside AI | In ChatGPT's connector settings, turn on developer mode and fill in a new connector through this tunnel with OAuth.                                                                                                                                                                                                          |
| f    | the user                  | Submit the connector; on the approval page that opens, paste the access passphrase and approve. Steps e and f are done on this Mac when `PUBLIC_URL` is not set.                                                                                                                                                             |
| g    | the program               | Shows that ChatGPT is connected once a connected app holds a live token.                                                                                                                                                                                                                                                     |

- Steps b and e each have an **optional helper**: a text for the Aside AI with a copy button, in the page language. It tells the AI to stop before the key is created (b) or before the connector is submitted (e), never to ask for, read, or type a key or passphrase, not to act on the approval page, and not to open or operate the settings page. It contains no secret and no settings-page address. The written steps are the main route; nobody has confirmed yet that the Aside AI completes them.
- **Disconnect ChatGPT** (managed connection only, after confirmation): stops the tool, deletes the stored key, removes the tunnel address (ChatGPT's tokens for that tunnel stop working) and the marker, and restarts the core. The profile file is left.
- An `external` connection (made by hand earlier) is described and left alone; setting up with Replace moves it under program management.
- **Connected apps**: apps approved with the passphrase, each with its connections. **Disconnect this connection** revokes one token family; **Disconnect the app** deletes the app and all its tokens, so it must be approved again.
- **Connector address (for reference)**: the MCP address with a copy button; with the tunnel it is normally not typed anywhere.

### Settings

Saving a setting restarts the core automatically; the page stays open and signed in. If a helper job is running, the page asks before interrupting it.

| Setting                            | What the page does                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access passphrase                  | **Create a passphrase** generates one in the browser (four groups of six letters and digits) and shows it once in the field with **Copy**; or type one of 12+ characters. **Save passphrase** stores it in `.env`; it is never shown again, and the old one is not needed to replace it. "Also disconnect all connected apps" is offered when a passphrase already existed; without it, connected apps stay connected. A passphrase forced from outside `.env` is shown as locked. |
| Helper runtime                     | Automatic (Claude if available, otherwise Codex), Claude, or Codex; stored as `onboarding.runtime`.                                                                                                                                                                                                                                                                                                                                                                                |
| Page language                      | Korean or English; browser only, no restart.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Advanced → Aside browser account   | `asideAccount` (or the `BRIDGE_ASIDE_ACCOUNT` line in `.env` when that is where it lives); locked when forced from outside `.env`.                                                                                                                                                                                                                                                                                                                                                 |
| Advanced → Saved pages (cache)     | Total and per-site size; **Clear** one site, **Clear all**.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Advanced → Information (read only) | Connector address, public address and whether it is set in a file, program port, settings-page port, data folder, sites folder, settings file, passphrase file.                                                                                                                                                                                                                                                                                                                    |
| Advanced → Restart                 | **Restart the program** stops and starts the core, for example after fixing a settings file by hand or after `start_failed`.                                                                                                                                                                                                                                                                                                                                                       |

Hand edits of `.env` or `config/bridge.json` show on the page the next time it loads and take effect at the next restart.

## API (for scripts)

All routes are under `/api`, need the cookie, and state-changing ones need the `Origin` header. The full contract (shapes, mode table, errors) is in [docs/contracts.md](contracts.md#settings-page-api-loopback-only).

- Core routes (503 `not_running` while the core is off): `GET overview | browser | sites | jobs | jobs/:id | jobs/:id/log?after=N | jobs/:id/events | oauth/clients | cache | helper`; `POST sites {input, note?, lang?} | sites/:key/retry {lang?} | sites/:key/repair {note?, lang?} | sites/:key/check | jobs/:id/retry {lang?} | jobs/:id/cancel | oauth/revoke {clientId}|{tokenId} | cache/clear {site?} | helper/check | chatgpt/retry`; `DELETE sites/:key`.
- Routes that answer in every mode: `GET status | settings | chatgpt`; `PUT settings`, `POST restart`, `POST chatgpt/setup`, `DELETE chatgpt` (409 `busy` during a restart).
