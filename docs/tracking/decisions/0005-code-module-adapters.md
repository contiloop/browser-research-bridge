# 0005 — Site adapters as validated code modules instead of declarative configs

## Context

Sites differ in how they search (Reuters' API callable only from inside its page because of DataDome, Naver's per-neighbor-blog search, Algolia for Hacker News), how they paginate, how dates are written, and how a paywall or login wall shows up (Reuters adds its wall client-side seconds after load). Adapters are written by an onboarding agent from a URL and a note, and a site must be addable without touching the core.

## Decision

Each site is a TypeScript module `sites/<key>/adapter.ts` implementing `search`, `read`, `smokeTest`, optional `canonicalize` and `checkCompleteness`, with a manifest, notes, and a `validation.json`. Adapters run in the bridge process but may value-import only `src/adapter-kit`; a static check rejects Node built-ins, environment access, global network APIs, and escape hatches before import; every page script passes the port's shim; and a full validation against the real site gates loading.

## Alternatives

- **Declarative configs (selectors, URL templates)**: cannot express in-page API calls, per-neighbor fan-out, late client-side walls, or multi-step completeness rules without growing into an interpreter.
- **Out-of-process sandbox per adapter**: stronger isolation, but a second runtime, IPC, and lifecycle to build before any site works; kept as future scope.

## Consequences

- Agent-written code runs inside the process that holds the OAuth store; the static check and the shim are the trust boundary and must not be weakened for convenience.
- Every adapter edit needs a new real-site validation (the hash in `validation.json`).
- The adapter-kit API is a compatibility surface: changing it can break committed adapters and requires re-validating every site.
