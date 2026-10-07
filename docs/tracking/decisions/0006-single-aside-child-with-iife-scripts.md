# 0006 — One long-lived `aside mcp` child with IIFE-wrapped scripts

## Context

Aside is the only browser engine; its CLI exposes a `repl` tool over MCP (`aside mcp --account <account>`). A probe showed that one session runs concurrent `repl` calls in parallel, but all calls share one persistent top-level scope (a second `const t0` fails), the REPL's global `page` is reassigned by every `openTab`, and the context resets after 30 minutes idle. Tabs a session opened are closed when its child exits.

## Decision

One long-lived `aside mcp` child per bridge process carries all browser work (tool calls, health checks, validation, onboarding). Every script is one async IIFE with no top-level declarations; tabs are addressed by their target id, never through the global `page`. Per-site concurrency lives in the scheduler (site lock, 4-site cap), not in separate processes. The child is restarted at most once per call when it dies or reports a lost browser session, re-handshaked one minute before the idle reset, and each restart bumps a generation so stale tab handles fail as `browser_unavailable`.

## Alternatives

- **One child per site**: isolates top-level scopes, but multiplies handshakes and REPL sessions for a few sites, and each child's tabs vanish whenever it is recycled.
- **One child per call**: a fresh scope every time, but an MCP handshake (allowed up to 20 seconds) before every step, no warm tabs, and every tab closed as soon as its step ends, so a read could not open a tab in one step and extract in the next.
- **Serializing all calls**: would avoid shared-scope collisions without the IIFE rule but cap throughput at one site at a time.

## Consequences

- A script that declares anything at the top level corrupts other concurrent scripts; the IIFE rule is mandatory for every script, including diagnostics.
- A single child is a single point of failure: when Aside's session drops, every in-flight task on every site fails and is retried once.
- Tab handles do not survive a restart; long multi-step operations must tolerate `browser_unavailable` and retry.
