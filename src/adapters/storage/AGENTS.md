# src/adapters/storage

## Scope

File-backed implementations of the persistence ports under `data/`: `site-state-store.ts` (`FileSiteStateStore`, `data/sites.json`), `token-store.ts` (`FileTokenStore`, `data/oauth/token-store.json`), `cache-store.ts` (`FileCache`, `data/cache/` with `index.json` and one value file per entry, namespaces `search`, `read`, `page-chain`), `result-cache.ts` (`ResultCache`: what may be cached and for how long, cache keys), `helper-check-store.ts` (`FileHelperCheckStore`, `data/helper-check.json`: the last helper check `{ version: 1, at, runtime, result, message }`), `json-file.ts` (atomic JSON writes, `SerialQueue`).

Not in scope: deciding lifecycle, hashing tokens (the OAuth server hands in hashes), adapter folders, job records (the onboarding job store).

## Boundaries

- Imports `src/core` and `src/ports` only.
- Writes only inside the configured data directory; never `sites/`, `config/`, or `.env`.

## Invariants

- Every write is atomic (temp file in the same directory, then rename) with file mode 0600 and directory mode 0700.
- Operations of one store are serialized in-process; only one bridge process may use a data directory at a time (the onboarding CLI refuses while the bridge runs).
- A missing file reads as empty; a malformed entry in `sites.json` is dropped, not fatal.
- `ResultCache` stores a search page only when every searched site returned `ok` or `empty` (non-searched sites do not block), a document only when `ok`; TTLs come from `searchCacheTtlSeconds` (600), `readCacheTtlSeconds` (86,400), `pageChainTtlSeconds` (1,800).
- Every cache entry is tagged with its sites so `clearSite` removes all of a site's entries without reading values; expired entries are dropped lazily on access and on load.
- The token store holds hashes only; deleting a client deletes its codes and tokens.
- The helper-check record stores values as given (`runtime` a string or null, `result` the check code, `message` clipped to 2,000 characters); a missing, malformed, or other-version file reads as no record (losing it costs one check, never a failure). Which runtimes and codes are valid is decided in `src/app/helper-check.ts`.

## Patterns

- Cache keys are built from the normalized query text, sites, date window, limit, and cursor (`searchCacheKey`), or site plus adapter ref (`readCacheKey`); both search and read services import these helpers so keys never diverge.
- Store files carry `version: 1`; a format change needs a reader for the old version.

## Tests

`site-state-store.test.ts`, `token-store.test.ts`, `cache-store.test.ts`, `helper-check-store.test.ts` run on temporary directories. Cover atomic replace, permissions, expiry, per-site clearing, and the caching conditions.
