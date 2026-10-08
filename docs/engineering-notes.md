# Engineering notes

## Traps

### "Identifier 'x' has already been declared" from a page script

- **Symptom**: a page script fails with a redeclaration error, or two scripts that run concurrently overwrite each other's variables; a script that worked alone fails when a second site is searched at the same time.
- **Cause**: one `aside mcp` session runs concurrent `repl` calls in parallel, and all of them share one persistent top-level scope. A top-level `const`, `let`, or `function` survives the call and collides with the next one. The REPL's global `page` is also shared and is reassigned by every `openTab`.
- **Response**: build every script with the kit's `pageScript` tagged template, which wraps it in its own `await (async () => { … })();` and embeds values as JSON literals. Never declare anything at the REPL top level and never use the global `page`; pass the tab handle that `openTab` returned. The shim already wraps adapter scripts; code that talks to the REPL directly (port internals, `browser:check`) must do the same.

### The bridge disappears after an unrelated `pkill`

- **Symptom**: during acceptance the bridge process vanished mid-run with no error in its own log.
- **Cause**: another process ran `pkill -f src/app/main.ts`. The pattern matches the bridge's command line (`tsx … src/app/main.ts`), the bridge stops gracefully on SIGTERM, and a graceful stop exits 0.
- **Response**: never stop or restart the bridge by pattern-matching its command line. Run it as the launchd agent and control it with `launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge` (restart) or `launchctl bootout gui/$(id -u)/com.browser-research-bridge` (stop). The agent's `KeepAlive` restarts it after any exit, including a SIGTERM; check `launchctl print gui/$(id -u)/com.browser-research-bridge | grep -E 'state|pid|last exit'` after any incident.

### Reuters search returns a 401 captcha page from `fetch`

- **Symptom**: calling Reuters' content API from the REPL realm (the scoped `fetch` outside the page) gets HTTP 401 with a `captcha-delivery.com` interstitial ("Please enable JS and disable any ad blocker").
- **Cause**: Reuters sits behind DataDome, which accepts the API call only from a real page context with its own cookies and script state.
- **Response**: open the site's own page in a bridge tab and call the API with `window.fetch` inside `page.evaluate`. The Reuters adapter opens `https://www.reuters.com/site-search/?query=<q>` and calls `GET /pf/api/v3/content/fetch/articles-by-search-v2?query=<json>&_website=reuters` (JSON keys `keyword`, `offset`, `orderby: "display_date:desc"`, `size`, `website: "reuters"`, `start_date`, `end_date`) from inside it, one page load per search page; `dd.reuters.com` (DataDome's first-party endpoint) is in `extraAllowedHosts`. Keep `minIntervalMs` at 3,000 for this site.

### A page script is rejected because it contains the word `aside`

- **Symptom**: a script fails the static scan although it never touches the Aside API; the offending text is a CSS selector such as `document.querySelectorAll("aside")`.
- **Cause**: the scan rejects the identifier `aside` (the REPL's Aside API global), and it decodes `\u`/`\x` escapes before scanning, so spelling tricks fail too. The same applies to `fs`, `require`, `process`, `exec`, `memory_search`, and to the words `constructor`, `import`, `eval`, `Function`, `globalThis` anywhere, including strings.
- **Response**: select sidebars with `[role="complementary"]` instead of `aside`; rename variables that collide (`proc`, not `process`); never build member names at runtime (`x["a" + b]` is rejected).

### Site logins are gone after Aside's browser session drops

- **Symptom**: browser steps fail with "Session with given id not found" or "Chrome extension not connected"; afterwards a site that was logged in (Naver twice, Reuters once) reports `auth_required`, and onboarding pauses asking for a login.
- **Cause**: the Aside browser window or its extension disconnected; the `aside mcp` child stays alive with a dead session, and the new browser session does not always keep the site's login.
- **Response**: the port treats those texts (and "task browser window is no longer available", "not connected to the daemon") like a dead child: it drops the child and starts a new one, once per call. A call bound to a tab of the old generation fails with `browser_unavailable` ("retry the request") instead of re-running. Then ask the user to log in to the affected site in Aside, and use "Check now" (live site) or "Retry" (paused job). A second session loss in the same call reports `browser_unavailable`.

### An edited adapter is loaded, validated, or promoted on stale evidence

- **Symptom**: after editing `adapter.ts` or `manifest.json`, promotion refuses with "the staged files changed after validation; validate again", or `npm run verify` fails on the Reuters test "carries a passed full validation.json for exactly these files"; for other live sites nothing fails at all.
- **Cause**: `validation.json` records `adapterHash`, a sha256 over `manifest.json` and the folder's non-test source files. Promotion and the Reuters unit test compare it with the files; the live loader only requires a passed full validation and does not compare the hash, so a hand-edited live adapter keeps loading on its old record.
- **Response**: after every edit run `npm run site:validate -- <key>` (or `--staging` for a staged folder) and commit the rewritten `validation.json`. A failed re-validation of a live folder keeps the previous passed record, so the site stays loadable and the failure shows up in health checks instead.

### `Document` is the browser's DOM type

- **Symptom**: code that handles documents type-checks but the object has DOM properties, or field access on a document fails with confusing errors.
- **Cause**: `tsconfig.json` includes the `DOM` library (page-script helpers need it), so an un-imported `Document` resolves to the DOM global.
- **Response**: always `import type { Document } from "…/core/index.js"` (or `core/models.js`) where the bridge's document is meant.

### `npm run build` output is not what runs

- **Symptom**: a change built into `dist/` has no effect, or a stale `dist/` seems to be used for an adapter.
- **Cause**: `npm start`, `npm run dev`, the CLIs, and the launchd agent all run the TypeScript sources through tsx; `dist/` is optional. Only a bridge that itself runs from `dist/` would prefer `dist/sites/<key>/adapter.js`, and only when it is at least as new as `adapter.ts`.
- **Response**: restart the bridge to pick up source changes (adapters are hot-reloaded only by promotion); do not rely on `dist/`.

### The dashboard UI comes from the source tree

- **Symptom**: a compiled run of the dashboard serves the source UI, or fails when the source tree is absent.
- **Cause**: `src/adapters/dashboard/ui/` (static HTML, CSS, JS) is not compiled or copied by the build; the server reads it from next to its module, else from `<repoRoot>/src/adapters/dashboard/ui/`, on every request.
- **Response**: edit the UI files in place and reload the browser; no restart is needed for UI-only changes.

### Startup or onboarding fails after installing without dev dependencies

- **Symptom**: adapters fail to load or promotion fails with a module-not-found error for `typescript`.
- **Cause**: the adapter static check (run before every adapter import) and the promotion type check import the TypeScript compiler at runtime.
- **Response**: keep `typescript` and `tsx` in `dependencies`; install with plain `npm install`.

### Booting the bridge without touching the real browser

- **Symptom**: a smoke test of startup, OAuth, or the dashboard opens tabs in the user's Aside window or competes with a running research session.
- **Cause**: the browser port starts `aside mcp` lazily on the first browser step and probes it once at startup.
- **Response**: start with `ASIDE_CLI=/nonexistent/aside` (and a separate `BRIDGE_DATA_DIR`, ports, and a test passphrase). The probe logs "browser not reachable", the dashboard shows Aside unreachable, and tools answer `browser_unavailable`, while OAuth, `/mcp`, `list_sites`, and the dashboard work normally. A fresh data folder has no helper check recorded, so 30 seconds after the core starts the automatic helper check makes one real model call on the local Claude or Codex sign-in (Claude is always tried under `auto`, because its sign-in cannot be ruled out without a call); stop the instance within 30 seconds when no helper quota may be spent.

### An onboarding job fails at once with a usage-limit message

- **Symptom**: a job ends `failed` within seconds; its log shows the Claude Code session limit ("session limit · resets 11:40pm Asia/Seoul").
- **Cause**: without `ANTHROPIC_API_KEY` the agent runs on the local Claude Code login and draws from the subscription's allowance; when it is exhausted the SDK run errors out.
- **Response**: click Retry after the reset time (the same job continues; the agent session is resumed or a new one gets a summary of the log), or set `ANTHROPIC_API_KEY` in `.env` and restart. `npm run site:onboard -- --sdk-check` shows the model, auth source, and whether a tool round trip works. On Codex the job fails with "Codex usage limit reached: …"; the same Retry rule applies, or switch the helper runtime on the settings page.

### ChatGPT's OAuth fails with `invalid_target` or `invalid_client`

- **Symptom**: ChatGPT's connector creation fails after the consent page, or the consent page never appears.
- **Cause**: ChatGPT registers through a Client ID Metadata Document (`https://chatgpt.com/oauth/<id>/client.json`) that prefers `private_key_jwt`, redirects to `https://chatgpt.com/connector/oauth/<id>`, and, when it comes through OpenAI's tunnel, sends the tunnel-service URL as `resource` instead of `<PUBLIC_URL>/mcp`.
- **Response**: the bridge accepts a CIMD client as public when its document lists `none` among the supported methods; keep `https://chatgpt.com/connector/oauth/*` in `redirectUriAllowlist`; put the tunnel's resource URL (`https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/<tunnel id>`) into `oauth.extraResources` and restart.

### Connectors stop working after a tunnel or `PUBLIC_URL` change

- **Symptom**: `/mcp` answers 401 to a client that was connected, or Claude reports it cannot reach the MCP server.
- **Cause**: a Cloudflare quick tunnel gets a new URL on every restart; the issuer and resource are derived from `PUBLIC_URL`, and tokens are bound to the resource they were issued for.
- **Response**: start `cloudflared` first, put the printed URL into `PUBLIC_URL`, restart the bridge, then remove and re-add the connector in the client. Use a named tunnel for a stable URL.

### A redirect to another host fails a browser step

- **Symptom**: a step fails with `adapter_error` and a `browser shim violation` log naming a host such as `nid.naver.com`.
- **Cause**: bridge-initiated requests and navigations, including server redirects, may only reach the site's `hostnames ∪ extraAllowedHosts` (subdomains included); requests the site's own scripts make to undeclared hosts are merely blocked and logged at debug level.
- **Response**: declare login/SSO, API, and CDN hosts in `extraAllowedHosts`. Run with `BRIDGE_LOG_LEVEL=debug` and read the `requests blocked by the tab filter` lines to learn which hosts a site needs (Reuters needs `arcpublishing.com` for images and API data).

### A block page does not pause the site

- **Symptom**: a site keeps being called while it shows a block or captcha page; the bridge log shows `captcha attempt` lines but no cool-down.
- **Cause**: by design (decision 0015) only `rate_limited` starts the 10-minute cool-down. A `blocked: true` failure instead gets one challenge attempt and one re-run per tool call (with `captcha.auto` on), and the user is told to solve the captcha in Aside when that fails. Older documents, and the doc comments in `src/adapter-kit/completeness.ts` and `results.ts`, still say a block page cools the site down.
- **Response**: report real throttling ("too many requests", HTTP 429) as `rate_limited`, which still pauses the site; report a block or captcha page as `access_denied` with `blocked: true` (`readFailure`/`searchFailure` take `{ blocked }`); a paywall never sets it. To stop attempts altogether, turn off Settings → Captchas (`captcha.auto: false`).

### A challenge attempt sees no widget although the page shows one

- **Symptom**: `browser_solve_captcha`, a live attempt, or `npm run browser:captcha-check` reports `kind: none` or `unknown` on a page where Aside visibly shows a captcha checkbox, or the widget's frame stays empty in the bridge tab.
- **Cause**: a bridge tab's request filter (`Network.setBlockedURLs`) and guard CSP block every host outside the site's scope, so the vendor's widget frame (`google.com/recaptcha/…`, `hcaptcha.com`, `challenges.cloudflare.com`, `captcha-delivery.com`, `geetest.com`) was never loaded. Re-issuing the filter alone does not help: the guard's CSP `<meta>` and the init scripts belong to the already loaded document, and `Page.addScriptToEvaluateOnNewDocument` scripts apply only to the next one.
- **Response**: the attempt widens the tab (filter re-issued, both guard init scripts removed by the identifiers kept in `__brbInit` and replaced with widened ones) and then reloads the challenge URL; a fresh tab is first opened normally and adopted, then widened and reloaded the same way. The tab is the attempt's target before the widening call goes out, so the restore (or the close) always covers it. Keep that order when changing `captcha.ts`/`repl-runtime.ts`; detection fixtures in `captcha.test.ts` describe pages as they look after the widened reload. A tab whose init scripts are unknown or cannot be removed must be closed, never reused.

### DataDome's slider is reported `unknown`

- **Symptom**: on Reuters (or another DataDome site) the attempt returns `kind: unknown` with the slider visible, and the read keeps failing with "The captcha could not be solved automatically. Open <url> in Aside, solve it, then retry".
- **Cause**: detection runs in the main frame only and sees inside no cross-origin frame. DataDome draws its slider inside its own `captcha-delivery.com` iframe, so only the frame's box is visible to the bridge, and Aside's `captcha.drag` needs the handle and track coordinates.
- **Response**: none yet; the user solves it in Aside. Confirm the behavior live with `npm run browser:captcha-check -- <reuters url>` (`docs/tracking/findings.md`). Do not reach into the frame with page scripts or CDP frame targets; that would bypass the shim's frame rules.

### Parallel calls hit a site faster than `minIntervalMs`

- **Symptom**: a site shows "too many requests" or a block page only when several calls run at once; the bridge log shows page loads of one site less than `minIntervalMs` apart.
- **Cause**: politeness is per task since the per-site pool (decision 0015): each task spaces its own loads by `minIntervalMs`, and overlapping tasks of one site are separated only by `concurrentStaggerMs` (500 ms) between their starts. Up to `maxConcurrentPerSite` (3) tasks of a site run at once, so a burst can load 3 pages within about a second.
- **Response**: lower `tunables.maxConcurrentPerSite` (1 restores one task per site; it applies to every site) or raise `concurrentStaggerMs` (0 turns the stagger off; it is the only tunable that may be 0). The adapter must report throttling as `rate_limited` so the site cools down.

### Copy passphrase answers `unavailable`

- **Symptom**: the Copy passphrase button (ChatGPT step f) says the clipboard could not be used; `POST /api/settings/passphrase/clipboard` answers 500 `unavailable`.
- **Cause**: the program runs `/usr/bin/pbcopy` by absolute path (launchd's `PATH` is minimal, and a `PATH` entry must not be able to stand in for it), with no arguments and only `PATH`, `LANG`, `LC_ALL` in its environment, and gives up after 5 seconds. It fails when `pbcopy` is missing or fails, for example in a session without access to the user's pasteboard.
- **Response**: run the bridge in the user's login session (the launchd agent does); copy the passphrase from the password manager instead. Tests inject a fake command through `startBridgeProcess({ clipboardCommand })`; never switch the production path to a `PATH` lookup or pass the value as an argument.

### A process test waits for the automatic helper check

- **Symptom**: a test that starts `startBridgeProcess` and expects the automatic helper check never sees it, or times out after vitest's 5-second limit.
- **Cause**: the automatic check runs 30 seconds after each core start (`HELPER_AUTO_CHECK_DELAY_MS`), longer than a test's timeout; the core-stopping hook cancels a pending one.
- **Response**: pass `helperAutoCheckDelayMs: 0` (as `settings-api.test.ts` does) and wait with `helperChecks.settled()`; never raise the test timeout to 30 seconds. Tests that do not care leave the default and stop the process, which cancels the timer.

### A page script cannot see `document`

- **Symptom**: `document is not defined` or `performance is not defined` inside a page script.
- **Cause**: page scripts run in the Aside REPL realm, not in the page.
- **Response**: put DOM work inside `page.evaluate(() => …)`, which runs in the page and cannot see REPL variables; pass data in through `pageScript` interpolation.

### `site:onboard` refuses to run

- **Symptom**: "something listens on 127.0.0.1:8787 (the bridge?)".
- **Cause**: the CLI and the running bridge would both manage `data/` (registry state, jobs) and race.
- **Response**: stop the bridge or use the dashboard's Add; `--force` skips the check only when the listener is something else.

### `browser:check` or `browser:captcha-check` uses a different account than the bridge

- **Symptom**: `npm run browser:check` passes while the bridge reports `browser_unavailable`, or the reverse; `npm run browser:captcha-check` meets a different login or captcha state than the bridge.
- **Cause**: both CLIs take the account from `--account`, then `ASIDE_ACCOUNT`, then `u0`; they ignore `asideAccount` in `config/bridge.json` and `BRIDGE_ASIDE_ACCOUNT`. `site:validate` does use the config.
- **Response**: pass `-- --account <id>` explicitly when the bridge uses an account other than `u0`.

### The bridge commits onto whatever branch is checked out

- **Symptom**: `site: add <key>` commits appear on a feature branch or in the middle of your own work.
- **Cause**: auto-commit runs `git add`/`git commit` with the `sites/<key>/` pathspec in the working tree the bridge runs from, with `--no-verify`, on the current branch.
- **Response**: run the bridge from a checkout of the main branch, or set `git.autoCommit: false` while working on a branch and commit adapter folders yourself.

### tunnel-client ignores the bridge's OAuth endpoints over plain http

- **Symptom**: `tunnel-client` starts and fetches the protected-resource metadata, but logs `harpoon host auto-registration failed … base URL must use https` for `oauth-token-endpoint-0` and `oauth-registration-endpoint-0`; ChatGPT's connector sign-in then fails or hangs.
- **Cause**: the bridge advertises loopback `http://127.0.0.1:8787` OAuth endpoints, and tunnel-client only proxies `https` targets by default.
- **Response**: a profile created by the settings page already has it. For a hand-made profile add `harpoon:\n  allow_plaintext_http: true` to the profile YAML and restart the agent; the log must show `harpoon host auto-registered oauth-token-endpoint-0` (and `-registration-endpoint-0`, `-issuer-0`). Verify with `tunnel-client doctor --profile browser-research-bridge`.

### A branch checked out in the project folder goes live at the next restart

- **Symptom**: the background service suddenly runs unfinished code, the settings page changes look mid-edit, or a site folder vanishes from a running install.
- **Cause**: the launchd agent's `WorkingDirectory` is the project folder and it runs `src/app/main.ts` from source; the settings page reads its UI files from disk on every request, and any restart of the agent (login, crash, `KeepAlive`, reboot) loads whatever is checked out. Checking out a commit that deletes a site folder deletes it from that working tree.
- **Response**: develop and test in a second checkout (`git worktree` or a clone) with its own `.env`, `config/bridge.json`, data folder, and ports; switch the live folder only on purpose, then restart the agent (`ops/install-launchd.sh --bridge` or `launchctl kickstart -k …`). Copy a locally excluded site folder aside before checking out or merging a commit that removes it, and restore it afterwards.

### The settings page says a setting is locked, or a hand edit of `.env` seems ignored

- **Symptom**: `PUT settings` answers 409 `locked` for the passphrase or the Aside account; or a value edited in `.env` while the program runs does not appear in the running core.
- **Cause**: the settings store takes a snapshot of the environment at process start (`StartupEnvironment.capture`) and compares it with `.env` at that moment. A non-empty variable that differs from the file's value (exported in the shell that ran `npm start`, or set in the launchd plist) is "set outside" and wins over the file, so the page refuses to change it. Node's `--env-file` never overrides a variable that already exists. Values from `.env` are re-read at every core start; a hand edit takes effect only at the next core restart.
- **Response**: unset the variable in the shell or the service definition and restart the process; after a hand edit press **Restart the program** on the page. Never "fix" a lock by writing the value elsewhere.

### The Codex helper starts warning about its version, or refuses to start

- **Symptom**: helper runs on Codex log "Codex version differs from the verified 0.160.0", or fail with "Codex refused the helper's restriction settings".
- **Cause**: the Codex restrictions rely on experimental app-server features (`environments: []`, dynamic tools) and on configuration keys and a model catalog shape of the verified version (`VERIFIED_CODEX_VERSION` in `codex-runner.ts`). `--strict-config` turns a renamed or removed key into a start failure (fail closed); a new tool that produces no thread item would not be caught by the run guards.
- **Response**: after every Codex upgrade re-run the evidence of `src/adapters/onboarding/codex-runtime.AGENTS-evidence.md` (the model-visible tool list capture and the refusal runs) and update `VERIFIED_CODEX_VERSION`. If a restriction cannot be enforced any more, remove the Codex entry from the helper runtime registry (`supported: ["claude"]`); never weaken a restriction. Until then, users can select Claude.

### A private site folder must stay out of git

- **Symptom**: `site folder not committed` with "git add failed: … ignored" in the log after a repair of that site; or a commit that would add `sites/<key>/` back.
- **Cause**: a site the user keeps only on this Mac (on the owner's Mac: `sites/blog-naver/`) is listed in `.git/info/exclude`, which is per clone and shared by its worktrees. The auto-commit's `git add` refuses an ignored path, so the bridge commits nothing for that site, by design.
- **Response**: never `git add -f` it; keep the exclude line; back the folder up separately. A fresh clone does not contain it, and the registry drops its entry at the next start there.

### The host-approval pause shows a sentence the helper did not write

- **Symptom**: a paused job's request reads "Approve these hosts by clicking Retry (or remove them from the manifest and Retry)" (or its Korean form) instead of the helper's own words; the reason listing the hosts is in English.
- **Cause**: when a staged manifest declares a host outside the site's registrable domains, the job service (not the helper) pauses the job and writes `requestedAction` from `HOST_APPROVAL_ACTIONS` in the job's `lang`; reasons and logs are always English. The page shows `requestedAction` as written.
- **Response**: any change to that sentence must change both languages in `HOST_APPROVAL_ACTIONS` (`service-helper.test.ts` checks both). For a non-coder the only actionable part is "press Retry"; editing the manifest is a developer's alternative.

## Site knowledge

- **Naver Blog neighbors (`blog-naver`, kept only on the owner's Mac, not in the repository)**: Naver's blog search has no neighbor filter and the neighbor feed (`section.blog.naver.com/ajax/BuddyPostList.naver`) keeps only about 150 recent posts, so the adapter searches neighbor by neighbor. It reads the logged-in identity from `section.blog.naver.com/ajax/BlogUserInfo.naver` (needs a `referer` on `section.blog.naver.com`, else the API answers `{"result":{"code":"csrf"}}`; the body starts with the XSSI guard `)]}',`; not logged in → `auth_required`), the neighbor list from `admin.blog.naver.com/BuddyListManage.naver?blogId=<domainIdOrUserId>&currentPage=N` (50 rows per page; the plain userId yields an alert page), then per neighbor `m.blog.naver.com/api/blogs/<blogId>/search/post?query=…` (20 hits per page, relevance order). The cursor is `{n, b, k}` (neighbor index, neighbor blogId, hits already returned); a call stops after 12 neighbor searches once it has results or at a 55 s scan budget, so a page can be short while more neighbors remain. Posts are read server-rendered from `blog.naver.com/PostView.naver?blogId=&logNo=` through the cookie-bearing fetch (no tab: tabs on section pages tripped the scope guard because of the ad host `siape.veta.naver.com`). Dates are KST, relative forms like `53분 전` resolved by the kit.
- **Reuters** (reference adapter): the server HTML carries the full paragraphs for everyone, and the wall is added client-side by the Arc paywall, sometimes several seconds after load (Breakingviews), so `read` waits up to about 15 seconds for the AccountButton, sign-in link, or a wall and then 6 more seconds for a late wall before judging completeness. The header "Subscribe" button shows even for subscribers and is not a logged-out marker. The visible dateline is in the browser's zone; dates come from JSON-LD and the manifest zone is `UTC`.

## Checklists

### Adding a site

1. Make sure the user is logged in to the site in Aside under the bridge's account.
2. Settings page → Sites → Add with the URL (and a note when the scope is special, for example "search only my neighbors' blogs"); watch the job log under Details. Check Getting started step 4 first (the helper runtime and its sign-in).
3. On `awaiting_user`, ask the user for exactly the requested action, then Retry.
4. Verify: the job is `succeeded`, `git log -1 --stat` shows `site: add <key>` touching only `sites/<key>/`, and `list_sites` shows the site `active`.
5. Run `npm run verify` (lint is not part of the promotion gate) and fix style by hand if needed; run `npm run site:validate -- <key>` again after any fix.

### Changing an adapter by hand

1. Read the site's `NOTES.md` and the current `validation.json` failure.
2. Edit `adapter.ts`/`manifest.json`; bump `version` when behavior changes; update `NOTES.md`.
3. `npm run site:validate -- <key>`; verify exit 0 and `"passed": true` with a new `adapterHash` in `validation.json`.
4. `npm run verify`; restart the bridge (a hand edit is not hot-reloaded), then "Check now" in the dashboard and verify the site is `active`.

### Changing a tool or the query language

1. Keep `search`/`fetch` ChatGPT-compatible and the status sets closed.
2. Update the tool description strings and `INSTRUCTIONS` in `src/adapters/mcp/tools.ts` together, since the research models read them; `tools.test.ts` pins their key phrases (query typed unchanged into the site's search box, login articles read only through `fetch`/`read_documents`, any URL on a registered site, parallel calls). Do not reintroduce wording that sends the model to its own web search (`aff1f07`, reverted).
3. Verify with unit tests and, for anything visible to clients, one real call from each client (ChatGPT `search` → `fetch`; Claude `search_sites` → `read_documents`) visible as `tool call` lines in the bridge log.

### Restarting with a Cloudflare quick tunnel

1. `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787` and read the new URL.
2. Set `PUBLIC_URL` in `.env`, then `launchctl kickstart -k gui/$(id -u)/com.browser-research-bridge` (or restart `npm start`).
3. Verify: `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_URL/mcp"` prints `401` and `curl -s "$PUBLIC_URL/.well-known/oauth-protected-resource/mcp"` names `"resource": "<PUBLIC_URL>/mcp"`.
4. Remove and re-add the Claude connector; consent with the passphrase.
