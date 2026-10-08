# src/adapters/mcp

## Scope

The remote tool surface: `tools.ts` (`createBridgeMcpServer` with exactly `search`, `fetch`, `search_sites`, `read_documents`, `list_sites`, their descriptions, encodings, and `tool call` logging), `search-service.ts` (targets, concurrent per-site calls, merge, cursor, page chain, page cache, lifecycle feedback), `read-service.ts` (ref resolution, read gate, document cache, text budgets), `live-call.ts` (one adapter call in the site's shared pool (never exclusive) within the remaining budget; outcome defaults; `recordLiveOutcome`; `callWithChallenge`, the blocked → attempt → re-run flow), `challenge.ts` (`ChallengeCoordinator`: one captcha attempt in flight per site, background attempts, abandonment, the budget arithmetic `planChallenge`/`canRerun`, the action text `captchaUnsolvedAction`), `adapter-output.ts` (zod normalization of adapter responses), `list-sites.ts`, `http-handler.ts` (stateless Streamable HTTP), `deps.ts` (tool tunables and service dependencies).

Not in scope: authentication (the bearer middleware runs before the handler), adapter loading and lifecycle storage (registry), browser control (port), cache storage (storage), route registration (`src/app/public-server.ts`).

## Boundaries

- Imports `src/core`, `src/ports`, and the cache-key helpers of `src/adapters/storage`; never `aside`, `oauth`, `onboarding`, `dashboard`, or `sites/`.
- No tool may accept a script, file path, or command, and no tool may reach a site that is not registered.

## Invariants

- `TOOL_NAMES` is exactly the five tools. `search`/`fetch` return `structuredContent` and the same JSON as text; the typed tools return text only.
- `SearchService.search` never throws; `ReadService.fetch`/`readDocuments` never throw; only the `fetch` tool returns `isError: true`.
- Every live outcome, including failures and `blocked`, is fed to `registry.recordOutcome` exactly once per site call. Only `rate_limited` starts the cool-down; `blocked` does not.
- Captcha attempts (`captcha.auto` on): a blocked failure (`blocked: true`, not `rate_limited`) gets one attempt per site and tool call, then one re-run of the same adapter call; the re-run's outcome is recorded too. Inline only with at least `captchaInlineMinRemainingMs` of the call left, for `min(captchaAttemptBudgetMs, remaining − captchaRerunReserveMs)`; otherwise the failure is returned at once and an attempt runs in the background. The re-run starts only while `captchaRerunReserveMs` is left (else the original failure). Re-run `ok`/`empty` → returned (the only confirmation; the solver never declares success); still blocked, or an attempt that could not run (no `solveChallenge`, `available: false`, refused, thrown) → the original failure with "The captcha could not be solved automatically. Open <url> in Aside, solve it, then retry"; any other re-run verdict is returned as it is. `kind: "none"`/`unknown` still re-run. No cool-down from any of it. Setting off or no coordinator → today's behavior.
- The coordinator runs at most one attempt per site at a time (later callers join and wait at most their attempt budget, then re-run their own call), as a non-exclusive pool task (holder `captcha`) with the site's scope (hostnames ∪ extraAllowedHosts) on the read's URL or `https://<first hostname>/` for searches and native ids. A background attempt is abandoned when its site disappears from the registry (polled each second; the registry has no removal hook) or the core stops (`dispose`).
- Parallel tool calls and `read_documents`' concurrent reads on one site run in parallel up to the scheduler's per-site pool.
- Search pages are cached only when every searched site returned `ok` or `empty`; documents only when `ok`; cache errors are logged and treated as misses.
- The adapter's read verdict is never upgraded: a non-`ok` verdict drops any attached document, `ok` without a valid document becomes `adapter_error`.
- Budgets: whole call 90 s (`toolCallBudgetMs`) including lock waits; `fetch` text 60,000; `read_documents` 120,000 split evenly over `ok` documents with a 10,000 floor; document cap 100,000; excerpts 1,000.
- Each POST gets a fresh `McpServer`; GET/DELETE → 405; a client disconnect closes the server, which aborts tool handlers and, through their signal, browser tasks.
- `tool call` logs carry tool, client id, query clipped to 200 characters, statuses, counts, and duration, never result text. Captcha lines (`captcha attempt` from the port or, when the port was not reached, the coordinator; `captcha re-run`; `captcha deferred to the background`) carry site, tool, kind, rounds, result, status, and duration, never a URL or page text.

## Patterns

- Tool descriptions are read by the research models; keep the qualifier syntax and the status list in them accurate when behavior changes.
- `INSTRUCTIONS` and the `search`/`fetch`/`search_sites`/`read_documents` descriptions state, in one fixed text for all sites, that the query is typed unchanged into each site's own search box (a few keywords), that results are login articles read only through `fetch`/`read_documents` and never by web browsing, that any URL on a registered site is readable, and that parallel calls are welcome; they do not point the model to its own web search. `tools.test.ts` pins these phrases, the five tool names, the ChatGPT output keys, and the ~900-character description limit.
- `settleEntry` turns an `ok` site that contributed nothing into `empty` with a specific message; keep that distinction when changing merge.

## Tests

`search-service.test.ts` and `read-service.test.ts` use stub registries and task runners (no browser); `makeMcpWorld({ challenge })` adds a coordinator over a fake port whose `solveChallenge` is scripted (or absent). `challenge.test.ts` covers the coordinator with the real scheduler (pool task, scope, target page = the read's URL, else the session's last on-site page `pageUrl`, else the homepage; coalescing, `join`, join timeout, background, dispose, removal, budget arithmetic, metadata-only logs). Cover: lifecycle entries for every non-active status, unknown `site:` values, no-terms queries, cursor round trips across pages and restarts, `page:N` chain walking, caching conditions, `blocked` feedback, read gates for each status, budget splitting, requested-id preservation, and the captcha flow (solved, unsolved, `kind: none`, setting off, no capability, inline vs background, reserve, coalesced reads, one attempt per search call, throttle pages left alone).
