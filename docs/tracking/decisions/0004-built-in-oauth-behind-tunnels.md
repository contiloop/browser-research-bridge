# 0004 — Built-in OAuth 2.1 behind tunnels instead of an unauthenticated secret URL

## Context

Both hosted clients need a public HTTPS endpoint, but the bridge runs on a Mac behind NAT and fronts the user's logged-in sessions. Both clients support OAuth for MCP connectors: Claude through Dynamic Client Registration, ChatGPT through Client ID Metadata Documents. ChatGPT can additionally reach a local server through OpenAI's Secure MCP Tunnel without any public URL.

## Decision

The bridge listens on 127.0.0.1 only and is exposed through tunnels the user runs: OpenAI's tunnel-client for ChatGPT and a Cloudflare tunnel (quick or named) for Claude, both targeting the same port. It contains its own OAuth 2.1 authorization server (DCR, CIMD, PKCE S256, rotating refresh tokens, redirect allowlist) whose consent page asks for one bridge passphrase, with a lockout against guessing. The server is tunnel-agnostic; `PUBLIC_URL` sets the issuer and resource, and `oauth.extraResources` admits resource identifiers a tunnel presents (ChatGPT's tunnel-service URL).

## Alternatives

- **No auth, secret URL**: any leak of the URL (logs, screenshots, the client's own telemetry) hands out the user's logged-in sessions, and there is no revocation short of changing the URL.
- **External identity provider**: an account and service dependency for a single user, and still a consent step.

## Consequences

- Every connector must complete a consent with the passphrase; changing `PUBLIC_URL` invalidates tokens bound to the old resource and requires re-adding connectors, which happens on every quick-tunnel restart.
- The bridge must track client quirks in config rather than code: ChatGPT's `private_key_jwt`-preferring metadata document (accepted as public because it lists `none`), its per-connector callback `https://chatgpt.com/connector/oauth/*`, and the tunnel-service resource.
- The passphrase is the single secret protecting the endpoint; tunnel operators terminate TLS and see it when typed.
- The dashboard must stay on a separate loopback port that no tunnel targets.
