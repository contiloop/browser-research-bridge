# 0003 — Reject URLs of unregistered sites instead of a generic reader

## Context

`fetch` and `read_documents` accept URLs. A generic fallback reader would let research clients read any page with the user's logged-in browser. The user's stated boundary is that remote requests are restricted to approved sites, and the public endpoint fronts the user's sessions.

## Decision

A URL is resolved to a site only through a hostname that a registered site owns; anything else is `unsupported` with the list of readable sites. Only registered sites can be searched or read, and only through their validated adapters.

## Alternatives

- **Generic reader for any URL**: convenient for research, but widens the public endpoint's reach to every site the user is logged into (mail, banking, admin consoles) and needs no adapter to define what "complete" means, so login walls would come back as text.
- **Generic reader limited to logged-out fetches**: duplicates the research clients' own web access and still exposes the Mac's network position.

## Consequences

- Reading a new site always requires onboarding it first (an agent run and a real-site validation).
- Hosts a site merely loads from (`extraAllowedHosts`) own nothing; URLs on them are `unsupported`.
- A generic fallback must not be added.
