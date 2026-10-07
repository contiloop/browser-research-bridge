# 0007 — Run from source under tsx instead of a compiled build

## Context

Adapters are added and repaired while the bridge runs and are hot-loaded with a dynamic `import()` of `sites/<key>/adapter.ts`. A staged adapter is imported from `.staging/` exactly as it will run live. The project is one user's local service, not a distributed artifact.

## Decision

`npm start`, the CLIs, and the launchd agent run the TypeScript sources through tsx. `typescript` and `tsx` are runtime dependencies; `npm run build` exists but nothing runs its output.

## Alternatives

- **Compile everything to `dist/`**: agent-written adapters would need a compile step inside the bridge before every load and a second copy of each adapter; the loader would have to keep `dist/` and `sites/` in sync.
- **Node's built-in type stripping only**: viable for adapters, but the rest of the code base uses constructor parameter properties (`constructor(private readonly …)`), which type stripping cannot run.

## Consequences

- Startup pays tsx's transform cost, and the production install must include `typescript` and `tsx`.
- `dist/` can go stale without anyone noticing; it must not be relied on.
- The dashboard UI is served from the source tree.
