# src/adapters/aside

## Scope

The only browser port implementation and the browser work scheduler:

- `mcp-repl-client.ts`: owns the long-lived `aside mcp --account <account>` child over stdio (MCP SDK client), lazy start, restarts, idle re-handshake, generations, login-error mapping;
- `repl-client.ts`: the inner `ReplClient` interface (fakes implement it in tests);
- `port.ts`: `AsideBrowserPort`, scoped sessions, tabs by target id, warm tabs (up to `maxWarmTabsPerSite` per site), politeness through the lease;
- `shim.ts`, `repl-runtime.ts`: the page-script wrapper, scope shadowing, membrane, scoped `fetch`/`openTab`, per-tab request filter and in-page guards, post-step drain and popup closing;
- `script-scan.ts`: the static scan of every page script;
- `hosts.ts`: hostname scope matching (exact or subdomain, http(s) only);
- `scheduler.ts`: `InMemoryScheduler` (per-site pool, exclusive tasks, global task cap, budgets, per-task politeness with a start stagger, cool-down);
- `captcha.ts`: the challenge solver (`BrowserPort.solveChallenge`): vendor host list, detection table, in-page detection, the privileged REPL step, the attempt loop;
- `check.ts`: `npm run browser:check`;
- `captcha-check.ts`: `npm run browser:captcha-check -- <url> [--account <id>]` (one attempt on an ad-hoc scope of the URL's host; JSON on stdout; exit 0 done, 2 setup error);
- `defaults.ts`: browser tunables' fallbacks.

Not in scope: what a site's pages look like, completeness rules, lifecycle, caching, or which hosts a site needs (those come from the manifest through the registry).

## Boundaries

- Imports `src/core` and `src/ports` only; nothing from other adapters, `src/app`, or `sites/`.
- Never touch the user's own tabs: act only on tabs this port opened and on popups whose `openerId` is one of them.
- Never weaken a shim layer or the scan to make a site work; a site that needs more hosts declares them in its manifest.

## Invariants

- One `aside mcp` child per bridge process carries every call; concurrent `repl` calls share one top-level scope, so every script the port sends is a single async IIFE with no top-level declarations, and the port never uses the REPL's global `page`.
- The child starts lazily and is restarted at most once per call when it is gone, exits mid-call, or the REPL returns "Session with given id not found", "Chrome extension not connected", "task browser window is no longer available", or "not connected to the daemon"; a second failure in the same call → `browser_unavailable`.
- A call bound to a generation (it uses a tab) never re-runs after a restart; it fails with `browser_unavailable` "…retry the request".
- With no call in flight, the child is replaced one minute before Aside's 30-minute idle reset.
- Aside error texts that look like an expired CLI login map to `browser_unavailable` with action "run `aside login`" and are never retried.
- Every page script passes, in order: static scan, compile check, scope shadowing of every non-standard REPL global (re-checked before running; unknown globals are added and the call retried), realm hardening (`constructor` pinned on function prototypes), membrane, scoped `fetch`/`openTab`, per-tab `Network.setBlockedURLs` allowlist plus isolated-world and main-world guards, and the post-step drain. A violation of any layer fails the step with `adapter_error` even if the script caught it, and is logged as `browser shim violation` with site, kind, and host or identifier only. One exception, which widens nothing (the request stays blocked and logged): in a page-script step, a violation on a captcha vendor host (`isCaptchaVendorHost`: a `CAPTCHA_VENDOR_HOSTS` host or subdomain, path limits ignored) that is not the script's own refused `fetch`/`openTab` means the site started a bot check, and the step fails with `access_denied`, `blocked: true`, "<site> answered with a bot check (<host>)"; it wins over other hosts in the same step. Other ops (open, snapshot, fetch, captcha) keep `adapter_error`.
- Scoped `fetch` allows GET/HEAD/POST, follows redirects by hand checking every hop, and drops `set-cookie`.
- Scheduler: up to `maxConcurrentPerSite` tasks per site and `maxConcurrentTasks` in total; FIFO per site, arrival order across sites; an `exclusive` task waits for the site's running tasks, holds back later tasks of the site from the moment it queues, and never overlaps a task of its site; a waiter that cannot start in time gets `timeout` naming the holders ("site busy: repair running", "site busy: 3 tasks running (search, search, fetch)", or "browser busy: …"); a task keeps its place until it settles even after its budget aborted it; each task spaces its own page loads by the lease's `minIntervalMs`, and tasks of one site are separated only by `concurrentStaggerMs` between starts; `isIdle` = no running and no waiting task; only a task failing with `rate_limited` starts the cool-down automatically (a `blocked` page does not), `setCooldown` is the only other way, and `clearCooldown` (used by site removal) ends it early.
- Warm tabs: a session's first tab may stay open `warmTabTtlMs` after the session ends; at most `maxWarmTabsPerSite` (the pool size) per site, the oldest closed first; a session takes one free warm tab of its site and hostnames or opens a new one, so parallel sessions never share a tab.

## Challenge attempts (captcha.ts)

- Aside's REPL `captcha` global has exactly `click(page, bounds)`, `drag(page, from, to, { steps })`, `readText(page, bounds?)` (non-enumerable; `readText` throws "No visual model configured…" without a vision model in Aside). It detects nothing; detection is the bridge's fixed table `CAPTCHA_WIDGETS`, run from an isolated world of the tab's main frame, giving viewport boxes of main-frame elements only (for a vendor widget, the iframe element whose `src` names the vendor). Nothing reaches inside a cross-origin frame, so a slider inside one (DataDome's captcha frame) is `unknown`.
- An attempt is privileged bridge code: no page-script scan, but the session's scope, request filter, guards, post-step drain, and popup sweep stay. Only while it runs does the tab also allow `CAPTCHA_VENDOR_HOSTS` (fixed in code; reCAPTCHA's Google hosts only under `/recaptcha/`): the `guard` op re-issues `Network.setBlockedURLs` and replaces the tab's guard init scripts by the identifiers the runtime keeps (`__brbInit`), then the challenge URL is reloaded (a fresh tab is opened with the normal guard, adopted, then widened and reloaded; the tab is made the attempt's `target` before the widen call so an abort always restores or closes it). At the end the normal filter and guard are restored; a tab whose widened guard cannot be removed is closed, never reused. Page scripts never run widened, and `captcha` stays shadowed for them.
- Tab choice: the given tab only when it is open in a live session with exactly the same site and hostnames in the current REPL generation; otherwise a fresh tab of the attempt's own session (kept warm after a normal restore like any session tab; an abandoned attempt closes and forgets its tab).
- Detection budget (`SolveChallengeOptions.detectBudgetMs`, clipped to `budgetMs`; absent → `budgetMs`, so the helper's `browser_solve_captcha` is unchanged): counted from the start of `solveChallenge`, it bounds every step until the first detection has finished — probe, open, widen, each politeness wait through the lease (raced against it), the widened reload, and the detection with its interstitial wait (`pendingWaitMs`/`noneWaitMs` clipped to it, a second short). When it ends first, or an automatic check is still `pending` after a wait it cut short, the attempt is `kind: "unknown"`, `rounds: 0`, message "detection did not finish in time" (`CAPTCHA_MESSAGES.detectLate`), after the normal restore. Action rounds after the detection use the rest of `budgetMs`.
- At most `MAX_CAPTCHA_ROUNDS` (2) action rounds within the budget; `solved` only means an action was performed and the page then showed no recognized widget or block marker (callers re-run the adapter). Unavailable capability → `available: false`; no vision model → text kind unsolved with its fixed message. A spent budget is an unsolved result ("detection did not finish in time" before the first detection, "the captcha attempt ran out of time" after it); other failures are `OutcomeError`s after the restore.
- Only the cropped captcha image (text kind) leaves the machine, through Aside's `readText` to the vision model configured in Aside. The answer is typed inside the REPL call and never returned or logged. One `captcha attempt` log line per attempt: site, kind, rounds, result, durationMs (plus `error` status when it threw).

## Patterns

- Errors are `OutcomeError`s (`browser_unavailable`, `timeout`, `adapter_error`, and the blocked `access_denied` of a bot check), never raw exceptions to callers.
- Titles of REPL calls are `Bridge <site>: <step>` so Aside's REPL log shows what ran.
- Diagnostics log hosts and identifiers, never URLs with queries or page content.

## Tests

`port.test.ts`, `shim.test.ts`, `script-scan.test.ts`, `scheduler.test.ts`, `mcp-repl-client.test.ts`, `captcha.test.ts` run against a fake REPL (`test/support/fake-aside-repl.ts`; it also fakes the `captcha` capability, a mode without it, a small DOM per URL whose vendor iframes load only when the tab's filter and guard CSP allow them, and the solver's isolated world). Detection fixtures describe pages as they look after the widened reload. The detection budget needs cases for the politeness wait, the interstitial wait, its clipping to the attempt's budget, and action rounds that outlast it. Every new escape path needs a scan or shim test that proves it is rejected; the bot-check mapping needs port cases for a vendor host, a look-alike host, a mixed step, the script's own calls, and non-script ops; restart rules need cases for child exit, session-loss text, generation mismatch, and login errors. Real behavior is proven only by `npm run browser:check` and `npm run browser:captcha-check -- <url>` against the running Aside app.
