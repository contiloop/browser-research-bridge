# Browser execution (Aside)

How the bridge drives the user's logged-in Aside browser. Code: `src/adapters/aside/`.

## Runtime shape

- One `aside mcp --account <account>` child per bridge process, spoken to over stdio (MCP, JSON-RPC lines). The MCP SDK client does the handshake; `McpReplClient` owns the child.
- Every browser step is one call of Aside's `repl` tool with a title (`Bridge <site>: <step>`), so the REPL log in Aside shows what ran.
- The child starts lazily. If it is gone or dies during a call, it is restarted once for that call; if it is still unavailable the step fails with `browser_unavailable`.
- Aside resets the REPL after 30 minutes idle (`replIdleTimeoutMs` in its startup event). Before a call that would hit the reset, the port closes the child and handshakes with a fresh one. Every restart increases a generation number. Tabs belong to one generation: Aside closes a REPL session's tabs when the session ends, so a handle from an older generation fails with `browser_unavailable` ("retry").
- An expired Aside CLI login gives `browser_unavailable` with action "run `aside login`". This is detected from Aside's error text, which could not be reproduced here (a signed-out local account still runs the REPL), so the pattern is a best guess.
- Under launchd, `aside` may not be on `PATH`: pass the absolute CLI path to `stdioTransportFactory({ command })`.

## Concurrency finding (verified 2026-10-05, Aside CLI 1.26.916)

- One `aside mcp` session runs concurrent `repl` calls in parallel. Each call's `console.log` output is returned to that call only.
- All calls share **one persistent top-level scope**. A second call that declares `const t0` again fails with "Identifier 't0' has already been declared".
- So the port uses one child for everything, and every call is a single `await (async () => { ... })();` with no top-level declarations. It never drives the REPL's global `page`, which `openTab` reassigns on every call. It reads `tabs` only to find popups. Tabs are addressed by the target id that `openTab` returned (`getTabByTargetId`).
- The REPL runs in its own JS realm (QuickJS-like: it has `InternalError` and `Float16Array`). Its global object exposes capability globals beyond the documented ones: `fs`, `aside`, `gmail`, `slack`, `notion`, `applePasswords`, `captcha`, `chrome`, `cua`, `installPageScript`, `attachBrowserTab`, and more.
- Aside page objects are not Playwright pages. There is no `page.route` or `page.context()`. They do expose an internal `_sendToTarget(method, params)` that sends raw CDP commands to that tab. CDP events (for example `Fetch.requestPaused`) are not delivered to the REPL, so request interception through the `Fetch` domain cannot be used.
- Tabs a REPL session opened are closed when its `aside mcp` child exits. Popups opened from those tabs are **not** closed then (verified), so the shim closes them itself.
- `Target.getTargets` lists every browser target, the user's tabs included. The shim acts only on targets whose `openerId` is a bridge tab and never reports the others.

## Scheduler

`InMemoryScheduler` (`src/adapters/aside/scheduler.ts`) implements `src/ports/scheduler.ts` and runs all browser work:

- One task per site at a time (site lock), FIFO within a site, and at most 4 active sites (`maxConcurrentSites`). Across sites, work is admitted in arrival order.
- A caller that cannot get the lock in time fails with `timeout`. The message names the lock holder ("site busy: repair running") or, when the global cap is the blocker, the active sites.
- An optional call budget (`budgetMs`, e.g. 90 s) aborts the lease signal and rejects with `timeout`. The lock stays held until the task really ends.
- Politeness: `lease.beforePageLoad()` spaces page loads on a site by `minIntervalMs`, and the spacing carries over between tasks. Navigations inside a page script use the same interval through `nextPageLoadAt()`/`recordPageLoad()`.
- Cool-down: a site is refused with `rate_limited` until `setCooldown(site, until)` expires (`ignoreCooldown` overrides this for user-initiated checks). A task that fails with `rate_limited`, or whose adapter response carries `blocked: true` (block page, captcha), starts a 10-minute cool-down through the registry; a paywall `access_denied` without the flag does not.
- Warm tabs (port): when a session ends, its first tab may stay open for 5 minutes (`warmTabTtlMs`). The next session for the same site and hostnames reuses it. All other tabs are closed.

## Page-script shim (every script, adapter or onboarding agent)

A session is scoped to a site's hostnames: an exact match or a subdomain (`reuters.com` covers `www.reuters.com`; `blog.naver.com` does not cover `naver.com`). Only `http(s)` URLs are allowed. Declare every host the site really loads pages or data from, including login/SSO redirect hosts. A page that ends up on another host (for example after a server redirect) counts as a violation.

`session.runScript(script, { tab, args })` runs `script` as the body of an async strict-mode function. Available names: `page` (the tab, behind a membrane), `args`, `openTab(url)`, `closeTab(page)`, `fetch(url, init)`, `snapshot(page, opts)`, `sleep(ms)`, a silent `console`, and the standard JS globals. Return a JSON-serializable value. Tabs a script opens with `openTab` are closed when the script ends; use `session.openTab` for tabs that must outlive one step.

Layers, in order:

1. **Static scan** (`script-scan.ts`) runs before anything is sent. It rejects:
   - `fs`, `aside`, `require`, `process`, `exec`, and `memory_search` used as identifiers. They are allowed as property names after a dot, so `/re/.exec(s)` is fine.
   - In any position, including strings: `globalThis`, `eval`, `Function`, `constructor`, `import`, `Reflect`, `__proto__`, `getPrototypeOf`, `fromCharCode`, `contentWindow`, Aside tab-attachment helpers, `_sendToTarget`, and the shim's own `__brb*` names.
   - Member access with a key built at runtime from strings, templates, or calls, such as `x['f' + 's']` or ``x[`${a}`]``.

   `\u`/`\x` escapes are decoded before scanning. The scan is deliberately conservative: a false rejection only means the script has to be rewritten.

2. **Compile check.** The script is compiled (not run) as a standalone function body with the shim's parameters. This means it cannot close the wrapper early and run code outside the shadowed scope.
3. **Scope shadowing.** The function's parameters shadow, with `undefined`, every global on the REPL's global object that is not on the standard list (`STANDARD_GLOBALS` in `shim.ts`). That covers `fs`, `aside`, `require`, `process`, `exec`, `memory_search`, `globalThis`, `Function`, `page`, `tabs`, and the skill globals. Before running, the REPL side checks for globals that are not shadowed. If it finds any, it refuses, and the port adds them and retries, so a global added in a future Aside version cannot leak into scripts.
4. **Realm hardening.** `constructor` on the REPL realm's function prototypes is pinned to `undefined`, so `(async () => {})[k]` with `k` built at runtime cannot reach the Function constructor and, through it, the real global object.
5. **Membrane.** Page objects are proxies that hide Aside internals (`_*`, `cdp`, `browser`, `frameManager`, `context`, `close`, `screenshot`, `setInputFiles`, `pdf`, ...) and refuse `call`/`apply`/`bind`. `goto` is checked against the hostnames, and `goto`/`reload`/`goBack`/`goForward` wait for the politeness gate. Results can be annotated by the script without changing the underlying objects.
6. **Scoped `fetch`/`openTab`.** Both accept only the scope's hostnames. `fetch` (cookie-bearing) follows redirects by hand and checks every hop. It drops `set-cookie` from responses and allows only GET/HEAD/POST.
7. **Per-tab filters and in-page guards.** Each bridge tab opens at `about:blank`. Before its first real load the shim installs:
   - **Request filter.** CDP `Network.setBlockedURLs` with an allowlist (the site's hostnames pass, `*://*/*` is blocked). It blocks subresource, `fetch`, XHR, WebSocket and iframe requests to other hosts, including those from `page.evaluate`, and survives navigations. It does **not** stop top-level navigations (verified).
   - **`Network.setBypassServiceWorker`.** Page requests never go through a service worker.
   - **Isolated-world guard.** An init script that runs in a named isolated world of every frame (`Page.addScriptToEvaluateOnNewDocument` with `worldName`). Page scripts run in the main world, so they cannot see or reset it. The guard:
     - cancels off-site navigations (Navigation API `navigate` event), link clicks, and form submits;
     - strips `target` from off-site links. Aside's click on a `target=_blank` link opens the URL in a new tab itself without any DOM event (verified); with the target stripped, the click becomes an ordinary, guarded one;
     - adds a CSP `<meta>` once the document has a head. It covers `connect-src`, `frame-src`, `child-src`, `worker-src`, `img-src`, `media-src`, `font-src`, `style-src`, `script-src`, `form-action`, and `object-src 'none'`, all limited to the hostnames; inline scripts and eval stay allowed. The meta is not inserted at document start because doing that stalls Aside's page-readiness wait (verified);
     - records every blocked attempt (kind and host only) from `securitypolicyviolation` events and its own checks in a store only that world can read.
   - **Main-world guard** (every frame, including `about:blank` child frames, so `frames[0].open(...)` is covered):
     - `window.open` returns `null` and reports off-site attempts;
     - `navigator.serviceWorker` and `SharedWorker` are removed;
     - off-site `src`/`href` assignments on image, script, link, media, source, embed, and object elements, `setAttribute` of those, and `new EventSource` are reported. Chrome's request filter blocks these loads before CSP sees them, so no violation event would fire.

   Reports go to the top frame's isolated world through a DOM event (`kind|attributed|url`).

8. **After every step**, the REPL side:
   - drains the guard store of every frame of each tab the step used (`Page.createIsolatedWorld` with the guard's world name, then `Runtime.evaluate`);
   - checks the main-frame URL. A tab found off-site, for example after a server redirect, is sent to `about:blank`;
   - closes popups: tabs in the REPL session's `tabs` that the bridge did not open (Aside attaches popups of session tabs there, including `noopener` ones), and CDP targets whose `openerId` is a bridge tab (`Target.getTargets`/`Target.closeTarget`).

   The bridge keeps the target ids of its own tabs in a non-enumerable REPL global (`__brbTabs`) that scripts cannot name or reach. Popups still open when a tab is closed are closed then too. Off-site popups are logged.

A violation of any layer fails the step with `adapter_error`, even if the script caught the error. It is logged as `browser shim violation` with the site, kind, and host or identifier only, never the URL query or page content.

A blocked in-page request counts as the script's when it comes from injected code (`page.evaluate` and handlers it installed). Such code has no source URL: an empty `sourceFile` on the CSP violation, and no `http(s)` frame in the stack for the main-world hooks. Requests the site's own scripts make to undeclared hosts (analytics, CDNs) are blocked but do not fail the step. They are logged at debug level as `requests blocked by the tab filter` with their hosts, which also tells the onboarding agent which hosts a site needs. For example, reuters.com loads its images and API from `*.arcpublishing.com`.

Remaining gaps. They exist because the Aside tab API exposes CDP commands but no CDP events, so requests cannot be paused or observed at the network layer, and auto-attach with `waitForDebuggerOnStart` stalls navigations in Aside (verified):

- **Popups are closed after the fact.** A popup that gets past the in-page guards is closed at the end of the step (or when the tab closes), but its first request has already been sent. Gesture-less popups are blocked by Chrome itself, and `window.open` and off-site `_blank` links are blocked in the page, so this needs a path the guards do not cover.
- **Some blocked loads are not reported, only blocked.** This covers subresources the page parser inserts before the CSP meta exists, `srcset`, CSS `url()` loads, and requests from dedicated workers (their CSP violations fire inside the worker). The request filter or the inherited CSP still blocks them, so only the reporting is missing.
- **Service-worker traffic outside the page.** A service worker the site registered on an earlier visit can still make its own requests, for example on push or background sync. The page cannot reach it, because `navigator.serviceWorker` is removed and requests bypass it.
- **Attribution relies on stack traces and `sourceFile`.** Code injected through `page.evaluate` could spoof `Error.prepareStackTrace` to look like site code. That only suppresses the report; the request is still blocked.

Real-environment proof: `npm run browser:check` (Aside running, CLI signed in).
