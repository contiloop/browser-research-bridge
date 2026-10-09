# src/adapters/validation

## Scope

The registration gate for adapters: `static-check.ts` (TypeScript-parser-based check of an adapter folder before import), `validate.ts` (validation decision logic for the full and light forms), `validator.ts` (`SiteValidator`: drives validation through the scheduler and browser port, writes `validation.json`), `anonymous-fetch.ts` (cookie-less fetch for the gated check), `report.ts` (`validation.json` format, `computeAdapterHash`), `cli.ts` and `cli-args.ts` (`npm run site:validate`), and `lightCheck` used by health checks.

Not in scope: promotion and swapping (registry), job control (onboarding), deciding lifecycle status (core).

## Boundaries

- Imports `src/core`, `src/ports`, `src/adapters/registry` (folders, loader, site task), `src/adapters/storage`; `cli.ts` also imports `src/app/config.ts` and `src/adapters/aside`. Never `mcp`, `oauth`, `onboarding`, or `dashboard`.
- Validation never mocks a site: the runner is the real scheduler and browser port; only unit tests inject fakes.

## Invariants

- Every browser step of both forms runs `exclusive` in the scheduler (holder `validation` for the full form, `health check` for the light form): it waits for the site's running tool calls and holds the site alone.
- Full form steps: `manifest` (parses, key equals folder, no hostname owned by another site, search or read declared, read-only adapters have `sampleReadUrl`), `static`, `load`, `search` (`ok`, ≤ 10 results with titles and http(s) URLs on the manifest hostnames, ids that round-trip), `second_page` (when `pagination`: a next cursor and at least one new URL), `read` (`ok`, title, `text.length ≥ minReadChars`, `subscriber` when `requiresLogin`), `gated` (when `gatedSampleUrl`: `checkCompleteness` exists, logged-in read `ok` + `subscriber`, and the cookie-less form classified non-`ok`; otherwise `gatedCheck: "not_applicable"`), `smoke` (`smokeTest` `ok` within 60 s).
- Light form: search with limit 3 plus one read, within 60 s; writes nothing. With `onBlocked` it reports where a step failed on a block page (the adapter's `blocked: true` with a failure status, or a thrown blocked failure such as a page script's bot check, which is rethrown: the read's URL, else the page the session last showed, else null); `lightCheck` returns it as the outcome's `blocked` for "Check now". Validation never attempts a captcha (no form, no caller: `site:validate`, `run_validation`, the promotion gate).
- The full form writes `validation.json` into the validated folder, except that a failed re-validation of a live folder keeps an existing passed record.
- `adapterHash` is a sha256 over `manifest.json` and the folder's top-level non-test source files, in name order.
- The static check rejects Node built-ins, packages, project imports outside `src/adapter-kit` (type-only imports of `src/ports`/`src/core` allowed), value imports of sibling files, `import()`, `require`, `process.env`, the listed escape-hatch globals, `import.meta`, `.constructor`, and the global network APIs; imports are resolved as if the files were already in the live folder.
- The cookie-less fetch follows at most 5 redirects, only within the site's hosts; a redirect elsewhere is returned as-is as evidence of a wall.
- CLI exit codes: 0 passed, 1 failed, 2 setup error. The CLI reads the bridge config for the account and data paths and substitutes a placeholder passphrase because it needs none.

## Patterns

- Step failures carry `{ step, status, message, action }` so the onboarding agent and the dashboard can show the exact failing step.
- New validation rules must be reflected in the authoring contract the onboarding agent reads, or agents will fail validation without knowing why.

## Tests

`static-check.test.ts` (one case per rule, including the `aside`/`process` and sibling-import cases), `validate.test.ts` (each step with a fake adapter), `validator.test.ts` (writing rules, hash, the light form's block report, no attempt in validation), `anonymous-fetch.test.ts`, `cli-args.test.ts`. Real validation is `npm run site:validate -- <key>` against the live site.
