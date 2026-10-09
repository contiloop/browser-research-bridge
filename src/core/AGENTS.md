# src/core

## Scope

Pure domain logic shared by every other module: the exact status sets and models (`models.ts`), query parsing (`query.ts`), result ids and refs (`ids.ts`), URL normalization and its hash (`url.ts`), the search cursor codec (`cursor.ts`), the cross-site merge (`merge.ts`), search targeting and the lifecycle → outcome mapping (`targets.ts`), outcome defaults and error mapping (`outcome.ts`), the lifecycle transition function (`lifecycle.ts`), site-key derivation (`site-key.ts`), the rules of the user-changeable settings (`settings.ts`: passphrase length counted in code points, helper runtime values, `captcha.auto` (boolean, default true), `assistant.auto` (boolean, default true), `assistant.effort` (one of Aside's effort names `ASSISTANT_EFFORTS`, default `low`), configuration problem codes, tunnel id format, the ChatGPT marker check), paragraph-boundary truncation (`text.ts`), id/document assembly (`assemble.ts`), and the default limits (`defaults.ts`, including the captcha and assistant time defaults). Barrel: `index.ts`.

Not in scope: I/O of any kind, clocks, logging, caching, scheduling, HTTP, MCP, OAuth, browser access, and anything site-specific. Functions take times and tunables as arguments.

## Boundaries

- Imports only its own files, `zod`, and `node:crypto` (plus the `Buffer` global). Never import `src/ports`, `src/adapters/*`, `src/app`, `src/adapter-kit`, or `sites/`.
- No site hostname, selector, or key may appear here.

## Invariants

- `OUTCOME_STATUSES` has exactly nine values and `LIFECYCLE_STATUSES` exactly five; every `switch` over them is exhaustive.
- `errorToOutcome` and `OutcomeError` never yield `ok` or `empty`; `OutcomeError` may carry `blocked` (a block or captcha page, read with `isBlockedError`), which never becomes an outcome field; `coerceAdapterStatus` turns unknown statuses into `adapter_error`, `ok` with zero results into `empty`, `empty` with results into `ok`, and passes failures through.
- `withOutcomeDefaults` gives every non-`ok` outcome a message and every `auth_required`/`access_denied` an action.
- `makeResultId` uses the adapter's canonicalizer, never `normalizeUrl`; a native local id never starts with `u_`; `parseRef(makeResultId(...))` round-trips.
- `normalizeUrl` strips `www.`, fragment, `utm_*`, `fbclid`, `gclid`, `ref`, `src`, sorts parameters, and drops a non-root trailing slash; `hashUrlKey` is the first 12 base64url characters of its sha256.
- The cursor wire format is version 1 (`{ v, p, s, h }`); unknown sites are dropped on decode, the seen list keeps the last 200 hashes, tokens over 32,768 characters are rejected.
- `mergeSearchPage` consumes a prefix of each site's adapter page, keeps failed sites' cursor state, drops exhausted and `empty` sites, and sorts the emitted page by `publishedAt` desc, undated last, ties by site key.
- `transitionSite` is pure: it returns the next state plus `clearCache`/`coolDown` effects and changes nothing for `onboarding`/`failed` sites on live outcomes and health checks. `coolDown` is set only for a live `rate_limited`; a `blocked` page does not cool the site down.
- `planSearchTargets` searches only `active` sites with the search capability, and searches nothing when every named site is unknown.

## Patterns

- Tunables are optional parameters that default to `defaults.ts` (`DEFAULT_QUERY_LIMITS`, `DEFAULT_SEEN_HASH_LIMIT`, …); never hard-code a number in logic.
- `Document` here collides with the DOM global; other modules must `import type { Document }` from this barrel.
- Validation of untrusted input (cursor tokens) uses zod schemas.

## Tests

Each file has a sibling `*.test.ts`. Changes must keep coverage of: qualifier parsing edge cases (invalid dates as text, clamping, case-insensitive names, `sites: []`), id round-trips for native and `u_` ids, normalization rules, cursor decode failures and dropped sites, merge ordering/dedup/resume offsets across pages, every lifecycle transition row including the no-op ones, and the lifecycle → outcome mapping per status.
