# 0009 — Onboarding agent on the local Claude Code login by default

## Context

Onboarding needs a capable agent (Claude Agent SDK, Opus 5.5 at high effort) for a handful of runs. The user offered no separate API key; Claude Code is signed in on the Mac with the user's subscription.

## Decision

The agent uses `ANTHROPIC_API_KEY` when it is set and otherwise the local Claude Code login. Model and effort are configurable (`onboarding.model`, `onboarding.effort`). The SDK session is stripped of every built-in tool and of user and project settings; its only tools are served by the bridge.

## Alternatives

- **Require an API key**: one more secret and a separate bill for a few onboarding runs.
- **Hand-written adapters only**: would not meet the goal of adding a site from the dashboard by URL.

## Consequences

- Onboarding draws on the subscription's SDK allowance; when the session usage limit is hit, jobs fail at once and must be retried after the reset (this blocked the Naver re-add during acceptance).
- Session transcripts are written to `~/.claude/projects/` so Retry can resume; they can contain page snapshots.
- The bridge's own variables (`BRIDGE_*`) must be removed from the agent's environment, since the agent process inherits the bridge's environment otherwise.
