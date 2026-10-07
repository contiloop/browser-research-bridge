# 0012 — Site-add helper on Claude or Codex, on the user's subscription

## Context

The helper (onboarding agent) ran only on the Claude Agent SDK. The audience is ChatGPT users; many have no Claude subscription and could not add a site at all. The owner wants the helper to run on the plan the user already pays for, with no API key on the settings page. Every site needs its own adapter (different search surface, article layout, and paywall), so the helper cannot simply be dropped.

## Decision

The helper runs on one of two runtimes, chosen by `onboarding.runtime` (`auto` | `claude` | `codex`, default `auto`; `auto` takes Claude when available, else Codex):

- `claude`: the Claude Agent SDK on the local Claude Code login (or `ANTHROPIC_API_KEY` when set in `.env`);
- `codex`: the Codex CLI (`codex app-server` over stdio) on the local Codex sign-in, with the bridge's own `CODEX_HOME`.

Everything the helper may and may not do is identical on both: only the bridge's helper tools, no command execution, no file or web tools of its own, no other tool servers, plugins, or user/project instructions, no `BRIDGE_*` or secret in its environment, the job's empty folder as working directory, and the service's own validation before promotion. The Codex runtime ships only because every restriction was enforced and demonstrated on the installed Codex (0.160.0; `src/adapters/onboarding/codex-runtime.AGENTS-evidence.md`). If that stops being true, Codex is removed from the runtime registry (`supported: ["claude"]`) rather than any restriction being weakened.

Each job records the runtime it ran on and the page language (`lang`) it was started from; the helper writes its request to the user in that language.

## Alternatives

- **Claude only**: ChatGPT-only users cannot add sites.
- **API keys on the page**: an extra secret to handle and a separate bill; the owner rejected it.
- **Codex with a read-only sandbox only**: a sandbox alone still leaves shell, patch, file, and image tools registered; the restrictions need the thread to have no execution environment and a rewritten model catalog.

## Consequences

- With Codex, the site address, the user's note, page snapshots, screenshots, script output, and the written adapter go to OpenAI instead of Anthropic; the page says which provider receives page content.
- The Codex restrictions depend on experimental app-server features; the evidence must be re-run after every Codex upgrade, and another version logs a warning on every run.
- The Claude probe cannot tell "not signed in" without a model call, so `auto` always picks Claude; a ChatGPT-only user must select `codex` (the guides say so). The helper check on the page performs one real round trip.
- The background service needs `CODEX_BIN` in its environment (launchd's `PATH` is minimal); the installer records it when Codex is found.
