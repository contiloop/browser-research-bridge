# 0008 — Adapters committed to git, with bridge auto-commit

## Context

Adapters are produced at runtime by the onboarding agent, but the setup must be reproducible: a fresh clone on a new Mac should recover every onboarded site without re-running the agent (which costs model usage and needs the user's logins and attention).

## Decision

Adapter folders (`manifest.json`, `adapter.ts`, `NOTES.md`, `validation.json`) are committed. After a successful add, repair, or removal the bridge itself commits only the pathspec `sites/<key>/` with `site: add|repair|remove <key>` (`git.autoCommit`, default on), skipping hooks and never pushing. Runtime state in `data/` stays uncommitted; at startup a loadable committed folder without state is registered as `active`.

## Alternatives

- **Adapters under `data/` (git-ignored)**: lost with the machine; every site would have to be onboarded again.
- **Manual commits only**: easy to forget after a dashboard Add, leaving the repository out of step with the running bridge.

## Consequences

- The bridge writes to the user's git history on whatever branch is checked out; running it from a feature branch puts site commits there.
- A site removal is a commit too, so history keeps every adapter ever onboarded.
- Pushing to a remote is the user's step; a clone recovers only what was pushed.
