# 0010 — `requiresLogin` marks reads, and only flagged blocks start a cool-down

> **Superseded in part by [0015](0015-per-site-pool-and-no-block-cooldown.md) (2026-10-08):** a `blocked: true` outcome no longer starts a cool-down; only `rate_limited` does, and a blocked page gets an automatic captcha attempt instead ([0014](0014-captcha-attempts-and-vendor-hosts.md)). The `requiresLogin` part and the rule that a paywall is never flagged still stand. The text below is the original decision.

## Context

Naver Blog posts are public, but the neighbor-only search needs the Naver login. Reuters needs the login for both search and subscriber reads. The manifest has one `requiresLogin` flag, and validation uses it to demand an authenticated sample read with `accessLevel: subscriber`. Separately, the lifecycle rule "a detected block or captcha pauses the site" had to coexist with paywalls, which are also `access_denied`.

## Decision

- `requiresLogin` describes **reads**: true when articles need the login or a subscription (Reuters), false when posts are public even if search needs the login (Naver). Login dependence of search is expressed by the adapter returning `auth_required` from `search`, which moves the site to `needs_login` the same way.
- A cool-down starts only on `rate_limited`, or on an `access_denied` the adapter flags with `blocked: true` (block page, captcha). A paywall `access_denied` is never flagged, so one unreadable premium article does not pause the whole site.

## Alternatives

- `requiresLogin: true` for Naver: validation would then demand a subscriber-level sample read that Naver cannot provide (posts are public), failing every onboarding of a public-post site that merely scopes search by account.
- Cool-down on every `access_denied`: a single Breakingviews (separate subscription) article would pause Reuters for 10 minutes for every client.

## Consequences

- `list_sites` reports `requiresLogin: false` for Naver even though its search needs the login; clients learn about the login through the `auth_required` status entry and its action text.
- Adapters must classify blocks and captchas with `blocked: true` or they will be retried without pause.
