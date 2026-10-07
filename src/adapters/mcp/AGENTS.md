# src/adapters/mcp

## Scope

The remote tool surface: `tools.ts` (`createBridgeMcpServer` with exactly `search`, `fetch`, `search_sites`, `read_documents`, `list_sites`, their descriptions, encodings, and `tool call` logging), `search-service.ts` (targets, concurrent per-site calls, merge, cursor, page chain, page cache, lifecycle feedback), `read-service.ts` (ref resolution, read gate, document cache, text budgets), `live-call.ts` (one adapter call under the site lock within the remaining budget; outcome defaults; `recordLiveOutcome`), `adapter-output.ts` (zod normalization of adapter responses), `list-sites.ts`, `http-handler.ts` (stateless Streamable HTTP), `deps.ts` (tool tunables and service dependencies).

Not in scope: authentication (the bearer middleware runs before the handler), adapter loading and lifecycle storage (registry), browser control (port), cache storage (storage), route registration (`src/app/public-server.ts`).

## Boundaries

- Imports `src/core`, `src/ports`, and the cache-key helpers of `src/adapters/storage`; never `aside`, `oauth`, `onboarding`, `dashboard`, or `sites/`.
- No tool may accept a script, file path, or command, and no tool may reach a site that is not registered.

## Invariants

- `TOOL_NAMES` is exactly the five tools. `search`/`fetch` return `structuredContent` and the same JSON as text; the typed tools return text only.
- `SearchService.search` never throws; `ReadService.fetch`/`readDocuments` never throw; only the `fetch` tool returns `isError: true`.
- Every live outcome, including failures and `blocked`, is fed to `registry.recordOutcome` exactly once per site call.
- Search pages are cached only when every searched site returned `ok` or `empty`; documents only when `ok`; cache errors are logged and treated as misses.
- The adapter's read verdict is never upgraded: a non-`ok` verdict drops any attached document, `ok` without a valid document becomes `adapter_error`.
- Budgets: whole call 90 s (`toolCallBudgetMs`) including lock waits; `fetch` text 60,000; `read_documents` 120,000 split evenly over `ok` documents with a 10,000 floor; document cap 100,000; excerpts 1,000.
- Each POST gets a fresh `McpServer`; GET/DELETE → 405; a client disconnect closes the server, which aborts tool handlers and, through their signal, browser tasks.
- `tool call` logs carry tool, client id, query clipped to 200 characters, statuses, counts, and duration, never result text.

## Patterns

- Tool descriptions are read by the research models; keep the qualifier syntax and the status list in them accurate when behavior changes.
- `settleEntry` turns an `ok` site that contributed nothing into `empty` with a specific message; keep that distinction when changing merge.

## Tests

`search-service.test.ts` and `read-service.test.ts` use stub registries and task runners (no browser). Cover: lifecycle entries for every non-active status, unknown `site:` values, no-terms queries, cursor round trips across pages and restarts, `page:N` chain walking, caching conditions, `blocked` feedback, read gates for each status, budget splitting, and requested-id preservation.
