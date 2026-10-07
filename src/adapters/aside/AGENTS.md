# src/adapters/aside

## Scope

The only browser port implementation and the browser work scheduler:
- `mcp-repl-client.ts`: owns the long-lived `aside mcp --account <account>` child over stdio (MCP SDK client), lazy start, restarts, idle re-handshake, generations, login-error mapping;
- `repl-client.ts`: the inner `ReplClient` interface (fakes implement it in tests);
- `port.ts`: `AsideBrowserPort`, scoped sessions, tabs by target id, warm tabs, politeness through the lease;
- `shim.ts`, `repl-runtime.ts`: the page-script wrapper, scope shadowing, membrane, scoped `fetch`/`openTab`, per-tab request filter and in-page guards, post-step drain and popup closing;
- `script-scan.ts`: the static scan of every page script;
- `hosts.ts`: hostname scope matching (exact or subdomain, http(s) only);
- `scheduler.ts`: `InMemoryScheduler` (site lock, 4-site cap, budgets, politeness, cool-down);
- `check.ts`: `npm run browser:check`;
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
- Every page script passes, in order: static scan, compile check, scope shadowing of every non-standard REPL global (re-checked before running; unknown globals are added and the call retried), realm hardening (`constructor` pinned on function prototypes), membrane, scoped `fetch`/`openTab`, per-tab `Network.setBlockedURLs` allowlist plus isolated-world and main-world guards, and the post-step drain. A violation of any layer fails the step with `adapter_error` even if the script caught it, and is logged as `browser shim violation` with site, kind, and host or identifier only.
- Scoped `fetch` allows GET/HEAD/POST, follows redirects by hand checking every hop, and drops `set-cookie`.
- Scheduler: one task per site, FIFO per site, arrival order across sites, at most `maxConcurrentSites` sites; a waiter that cannot start in time gets `timeout` naming the holder; the lock is held until the task settles even after its budget aborted it; page loads on a site are spaced by the lease's `minIntervalMs` across tasks; `rate_limited` starts the cool-down automatically, `setCooldown` is the only other way, and `clearCooldown` (used by site removal) ends it early.

## Patterns

- Errors are `OutcomeError`s (`browser_unavailable`, `timeout`, `adapter_error`), never raw exceptions to callers.
- Titles of REPL calls are `Bridge <site>: <step>` so Aside's REPL log shows what ran.
- Diagnostics log hosts and identifiers, never URLs with queries or page content.

## Tests

`port.test.ts`, `shim.test.ts`, `script-scan.test.ts`, `scheduler.test.ts`, `mcp-repl-client.test.ts` run against a fake REPL (`test/support/fake-aside-repl.ts`). Every new escape path needs a scan or shim test that proves it is rejected; restart rules need cases for child exit, session-loss text, generation mismatch, and login errors. Real behavior is proven only by `npm run browser:check` against the running Aside app.
