# src/adapter-kit

## Scope

The helper package site adapters import at runtime (`../../src/adapter-kit/index.js` is the only value import an adapter may have): dates with time zones and Korean/English relative forms (`dates.ts`), HTML-to-text extraction (`text.ts`, `html.ts`), the `pageScript` tagged template and `wrapPageScript`/`jsLiteral` (`page-script.ts`), site cursors (`cursor.ts`), URL helpers including `canonicalizeUrl` (`url.ts`), result builders `searchItem`, `searchResponse`, `searchFailure`, `documentOf`, `readResponse`, `readFailure` (`results.ts`), the completeness checker and `COMMON_BLOCK_MARKERS` (`completeness.ts`), and `createAdapterHelpers()` (`helpers.ts`) which builds `ctx.helpers`.

Not in scope: I/O, network, browser control, state, anything site-specific (selectors, hostnames, markers of one site belong in that site's adapter).

## Boundaries

- Imports only its own files, `src/core`, and `src/ports`; never `src/adapters/*`, `src/app`, Node built-ins, or packages. Tests may import the browser shim to check generated scripts.
- Only `src/app/main.ts` (the bridge), `site:validate`, and the onboarding agent tools (`wrapPageScript`, `jsLiteral`) import the kit outside `sites/`.

## Invariants

- Every function is pure and deterministic given its inputs (`now` and `timezone` are parameters; no `new Date()` defaults inside date resolution).
- `pageScript` output is always a single `await (async () => { … })();` with interpolated values as JSON literals, so it never leaves a top-level declaration in the shared REPL scope and passes the port's static scan when the body does.
- `parseDate` returns ISO 8601 with the site zone's offset and `datePrecision` `minute` or `day`, or null for ambiguous forms such as `01/02/2024`.
- `searchItem` clips excerpts to 300 characters; result builders never produce `id` or `site` (the core assigns them).
- `encodeSiteCursor` tokens start with `c1.`; `decodeOffsetCursor(null)` is 0 and a malformed cursor decodes to null.
- `checkPageCompleteness` applies its rules in a fixed order (HTTP 429/401, throttle and block markers including `COMMON_BLOCK_MARKERS`, login URL and login-wall markers, paywall markers, HTTP 403/404/410/5xx, then the required full-text markers) and returns `ok` only when nothing matched and, if `required` markers are configured, one of them is present; throttle and block verdicts carry `blocked: true`, paywall verdicts do not.

## Patterns

- The kit is a compatibility surface for committed adapters: changing a signature or behavior requires re-validating every site in `sites/` against the live site.
- Keep exports flowing through `index.ts`; `createAdapterHelpers()` must keep returning `parseDate`, `extractText`, `snapshotToText`, `encodeCursor`, `decodeCursor`.

## Tests

`dates.test.ts`, `text.test.ts`, `kit.test.ts`. Cover every new date form (with zone and request time fixed), extraction rules for boilerplate removal, and that generated page scripts pass `checkPageScript`.
