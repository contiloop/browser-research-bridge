# src/ports

## Scope

The contracts between the core and its adapters: `adapter.ts` (site adapter module, `AdapterContext`, helper API, completeness input), `browser.ts` (browser port, scoped session, tabs, cookie-bearing fetch, and the optional `solveChallenge` captcha attempt with its `ChallengeAttempt` result, reachable from bridge code only), `manifest.ts` (zod schema of `sites/<key>/manifest.json`), `registry.ts` (registered sites, loaded adapters, live outcomes), `scheduler.ts` (per-site pool with `exclusive` tasks, `holders(site)`, lease with per-task politeness, cool-down), `cache.ts`, `site-store.ts` (site state and the site committer), `settings-store.ts` (settings files: set-only secrets, field codes, locked, classified configuration problems, page location), `token-store.ts` (OAuth persistence; `revokeToken` returns true only for the call that revoked the token, `markTokenIssued` updates a client's last-issued time without rewriting the record), `clock.ts`, `logger.ts`, `json.ts`, `connection-tool.ts` (the program-managed connection tool for ChatGPT: detect, prepare key file and profile, run with readiness and restart, diagnose, remove key; the runtime key is accepted by `prepare` only and never returned). Barrel: `index.ts`.

Not in scope: implementations, defaults beyond schema defaults, I/O.

## Boundaries

- May import `src/core` (types and small helpers such as site-key validation) and `zod`; never `src/adapters/*`, `src/app`, `src/adapter-kit`, or `sites/`.
- Site adapters may `import type` from here; therefore nothing exported here may be a runtime value an adapter would need at runtime.

## Invariants

- `parseSiteManifest` enforces: `key` valid, `hostnames` non-empty and unique, `extraAllowedHosts` unique, `timezone` a valid IANA zone, `sampleQuery` non-empty when `capabilities.search` is true, defaults `minReadChars` 200 and `minIntervalMs` 1500 (overridable through schema options from the tunables).
- `hostnames` means ownership (URL → site, duplicate check); `extraAllowedHosts` widens only the browser scope. Keep the two fields separate in every new contract.
- Browser port errors are `OutcomeError`s: `browser_unavailable`, `timeout`, or `adapter_error` for a shim violation.
- `ConnectionTool` failure messages are the implementation's own wording, never raw tool output, and never contain the runtime key.
- `TokenStore` only ever sees hashes of tokens, codes, and client secrets.
- `BrowserSession` never attaches to user tabs; `dispose()` closes the session's tabs except a warm tab the port may keep.
- `BrowserSession.lastUrl()` is the last on-site page URL the session loaded (null before any load); the challenge coordinator targets it for a search's attempt.

## Patterns

- Interfaces describe behavior and failure modes in doc comments; implementations live under `src/adapters/*`.
- Adding a field to the manifest schema: give it a default so committed manifests stay valid, and update the authoring contract the onboarding agent reads.

## Tests

`manifest.test.ts` covers schema defaults and rejections; add a case for every new field or refinement. Interfaces themselves are exercised through their implementations' tests.
