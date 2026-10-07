# sites

## Scope

One folder per registered site, each the complete site-specific knowledge of the bridge:

```
sites/<key>/
  manifest.json     key, name, owned hostnames, extraAllowedHosts, loginUrl, requiresLogin, timezone,
                    capabilities, sampleQuery, sampleReadUrl, gatedSampleUrl, minReadChars, minIntervalMs,
                    createdBy, version
  adapter.ts        default export { search, read, smokeTest, canonicalize?, checkCompleteness? }
  NOTES.md          URLs, API calls, selectors, wall markers, date formats, pitfalls
  validation.json   written by site:validate; never edited by hand
  .staging/ .previous/   git-ignored work and rollback copies
```

Shipped folder: `reuters` (the reference adapter; agent-written, subscriber articles, DataDome-protected, client-side Arc paywall). Kept only on this Mac, not in version control (excluded locally through `.git/info/exclude`): `blog-naver` (agent-written, search limited to the user's 63 neighbor blogs read from `admin.blog.naver.com/BuddyListManage.naver`; requires the Naver login; removed and re-added once through the dashboard, current version committed as `fd416c0`).

Not in scope: merging across sites, ids, dedup, caching, cursors across sites, truncation, lifecycle, MCP, OAuth. The core does all of that; an adapter handles exactly one site.

## Boundaries

- An adapter may value-import only `../../src/adapter-kit/index.js`; `import type` may name `src/ports/*` and `src/core/*`. No Node built-ins, packages, other project code, other site folders, or sibling files; no `process`, `globalThis`, `global`, `eval`, `Function`, `require`, `module`, `exports`, `__dirname`, `__filename`, `import.meta`, `.constructor`, or global `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`. The static check rejects the folder otherwise.
- A change for one site touches only that site's folder; nothing site-specific may be added outside `sites/<key>/`.
- Network access only through `ctx.browser` (scoped to `hostnames ∪ extraAllowedHosts`); no state between calls; no files, environment, or credentials.

## Invariants

- `manifest.key` equals the folder name; owned `hostnames` belong to no other site; every host the site needs for login redirects, APIs, or CDNs is in `extraAllowedHosts`.
- `read` returns `ok` only after confirming the full article body (a positive body marker and no wall marker); login wall → `auth_required`, paywall teaser or block page → `access_denied`, throttling → `rate_limited`, missing article → `empty`. `blocked: true` only for block, captcha, or throttle pages.
- `accessLevel` is `subscriber` exactly when the full text appeared because the user is logged in or subscribed; for `requiresLogin` sites the validation sample must read as `subscriber`.
- `search` returns at most `limit` items whose URLs are on the owned hostnames, each with a `localId` (stable, no whitespace, not starting with `u_`) or a URL that `canonicalize` maps to one form; every id round-trips through `read`; the same cursor yields the same page.
- `publishedAt` is ISO 8601 in the manifest's time zone (`ctx.helpers.parseDate` with `ctx.now()`), never the browser's zone.
- Every page script is built with `pageScript` (an async IIFE), uses the tab handle it was given rather than the global `page`, does DOM work inside `page.evaluate`, and never contains `aside`, `fs`, `require`, `process`, `exec`, `memory_search`, `globalThis`, `eval`, `Function`, `constructor`, or `import`, even inside strings or CSS selectors (use `[role="complementary"]` for sidebars).
- `validation.json` matches the committed files (`adapterHash`); after any change to `adapter.ts` or `manifest.json`, re-run `npm run site:validate -- <key>` and commit the new record.
- `smokeTest` finishes within 60 seconds and reuses `search` and `read`.

## Patterns

- Prefer the site's own JSON API through `ctx.browser.fetch`, an API called from inside the site's page when bot protection blocks out-of-page calls (Reuters), or one tab per article with one page script returning fields plus the body container's `innerHTML`; snapshots are the last resort.
- Keep loads per call small (one search request per page, one tab per article, no prefetch) and raise `minIntervalMs` for sites that throttle (Reuters uses 3,000).
- Build completeness rules with the kit's `completenessChecker` and reuse the same rules inside `read` and as `checkCompleteness`.
- Record every site discovery in `NOTES.md`; a repair starts from it, bumps `version`, and keeps what works.

## Tests

Real-site validation is the gate: `npm run site:validate -- <key>` (full) and `--light` (health form) against the live site in the logged-in Aside browser, never mocked. Pure parts (canonicalize, completeness rules, id round trips) may have unit tests in `test/sites/<key>.test.ts` on recorded HTML; `test/sites/reuters.test.ts` also asserts that the reference adapter's `validation.json` hash matches its files.
