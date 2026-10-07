# src/adapters/oauth

## Scope

The built-in OAuth 2.1 authorization server and the `/mcp` bearer middleware: `server.ts` (`createOAuthServer`: Hono routes for the discovery documents and `/oauth/{register,authorize,token}`, consent handling, lockout, `bearerAuth`), `service.ts` (`OAuthService`: registration, client resolution, authorization validation, codes, token grants with rotation, access-token verification, list/revoke/purge), `client-metadata.ts` (DCR body validation, CIMD fetch and validation), `redirect-allowlist.ts`, `lockout.ts`, `consent-page.ts`, `crypto.ts`, `errors.ts`.

Not in scope: persistence (an injected `TokenStore`), the MCP tools, the dashboard UI (it calls `listClients`/`revoke`), configuration loading.

## Boundaries

- Imports `src/ports` (token store, clock, logger) only; the file-backed store is injected by `src/app`.
- `routes` must contain exactly the six OAuth paths of `oauthPublicPaths()`; the public listener relies on that to 404 everything else.
- Never log a passphrase, code, token, or secret; never return a raw token from list endpoints (token ids are storage hashes).

## Invariants

- Tokens, codes, and client secrets are 256-bit random values; only their sha256 hashes reach the store. Passphrase and PKCE comparisons are constant-time.
- PKCE `S256` is mandatory; the verifier must match `[A-Za-z0-9-._~]{43,128}`.
- A redirect URI must be registered for the client and match the allowlist at authorize time; loopback URIs match on any port.
- An omitted DCR `token_endpoint_auth_method` registers a public client. A CIMD document is accepted only when its preferred method is `none` (or omitted) or `none` is listed in `token_endpoint_auth_methods_supported`; such clients are always public.
- Accepted resources are `<issuer>/mcp` plus `extraResources`; a code exchange or refresh naming another resource fails with `invalid_target` without consuming the refresh token.
- Refresh rotation: the presented token is revoked; reuse after the 10-second grace revokes the whole family.
- Registration is refused at `maxRegisteredClients` DCR clients; stale clients (no live token, nothing issued for `clientPurgeAfterDays`) are purged before each registration and on every `purge()`.
- Lockout key is `ip:<first value of trustedProxyHeader>` (or `ip:unknown`) when a trusted header is configured, else `global`; threshold `consentFailuresPerIp` or `consentGlobalFailures` within `consentLockoutSeconds`.
- The authorize endpoint answers within the hosted clients' 2-second expectation: CIMD fetches time out after 1.5 seconds and are cached 5 minutes.

## Patterns

- Errors are `OAuthError(code, description, status)` rendered as RFC 6749 JSON; authorize errors before the redirect URI is trusted render an HTML page, afterwards they redirect with `error` and `state`.
- Consent responses carry `Cache-Control: no-store`, a `default-src 'none'` CSP, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- Repeated authorize or form parameters are rejected.

## Tests

`oauth-flow.test.ts` (full DCR + PKCE + refresh + reuse flows, lockout per IP and global), `redirect-allowlist.test.ts`, `chatgpt-connector.test.ts` (CIMD with `private_key_jwt` + `none`, per-connector redirect, tunnel resource, foreign-resource rejection). Every client quirk accepted in code needs a test that also proves the neighbouring invalid case is still rejected.
