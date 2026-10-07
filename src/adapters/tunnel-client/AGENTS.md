# src/adapters/tunnel-client

## Scope

`TunnelClientConnectionTool` implements the `ConnectionTool` port (`src/ports/connection-tool.ts`) for OpenAI's `tunnel-client` (Secure MCP Tunnel), the program-managed connection to ChatGPT. It does the steps of connecting ChatGPT that happen on this Mac: detect the tool and its version, store the runtime key file, create the profile, run the tool as a managed child with readiness, restart, and stop, run its diagnostics, and delete the key file.

Not in scope: validating the tunnel id against the platform, `oauth.extraResources`, the managed marker, the six ChatGPT connection states, `external` detection, starting with the core, and restarting the core. Those belong to the ChatGPT connection service in `src/app/chatgpt-connection.ts`, which composes this adapter with the tool location from `TUNNEL_CLIENT_BIN`.

## Boundaries

- Imports `src/ports` only (connection-tool, logger, clock) and Node built-ins. Instantiated only by the composition in `src/app/`.
- `process.ts` is the process seam (`ProcessRunner`: `exec` for short commands, `spawn` for `run`) and the readiness seam (`HttpProbe`). Both are injected; unit tests never run the real tool.
- File locations are constructor options: `binary` (default `tunnel-client` on `PATH`), `keyDir` (default `~/.config/browser-research-bridge`), `profileDir` (default `$XDG_CONFIG_HOME/tunnel-client` or `~/.config/tunnel-client`), `stateDir` (default `keyDir`, holds `<profile>-health.url`). Timings: `restartDelaysMs` (1 s, 2 s, 5 s, 10 s, 30 s; the last repeats), `maxFailures` (5), `readyTimeoutMs` (60 s), `readyPollMs` (500 ms), `stopTimeoutMs` (10 s), `commandTimeoutMs` (15 s), `doctorTimeoutMs` (60 s).

## Invariants

- The runtime key never appears in an argument, an environment value, a log line, a return value, or a failure message. The tool gets it as `--control-plane-api-key-ref file:<keyFile>`. The child environment is an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, locale, `TZ`, proxy variables); `CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY`, `BRIDGE_*`, and the tool's own `TUNNEL_CLIENT_*`/`HEALTH_*`/`LOG_*` overrides never reach it.
- Key file: `<keyDir>/<profile>-runtime-key`, folder 0700 (tightened when it already exists), file 0600, written through a `wx` temp file and renamed, with no trailing newline. Profile: `<profileDir>/<profile>.yaml`.
- `prepare` order: validate → `detect` (`tool_missing` writes nothing) → `exists` unless `replace` → key file → `init` → check the YAML references the key file and does not contain the key → append `harpoon:\n  allow_plaintext_http: true`. On failure every step is undone in reverse: created files and folders are removed, files set aside for `replace` (`*.replaced-<id>`) are restored. On success the set-aside copies are deleted.
- Tool output is reduced to an error kind (`output.ts`) the moment it is read; raw lines are never kept, logged, or returned. Every user-facing text comes from `KIND_MESSAGES`. Check names from `doctor --json` are sanitized and are the only tool text that passes through.
- Run: one managed child per adapter instance. States `stopped → starting → ready`; an exit or a readiness timeout counts as a failed attempt, restarts after the next delay, and after `maxFailures` consecutive failures (or at once for `tool_missing`) the state is `failed`; reaching `ready` resets the count. A final not-ready failure appends the `doctor` summary to the failure message. `start` from `failed` or `stopped` starts again with the count reset ("Try again"). `stop` cancels a pending restart, sends SIGTERM, waits `stopTimeoutMs`, then SIGKILL.
- The health listener is always `127.0.0.1:0` with `--health.url-file`, so it never collides with 8080 or with a tool run some other way. Readiness is `GET <base>/readyz` = 200, and only a loopback `http` base read from the url file is probed.

## Confirmed tool interface (tunnel-client 0.0.14, from `--help` on this Mac)

- Version: `tunnel-client --version` → `0.0.14+<sha> (git sha: <sha>)`.
- Profile: `tunnel-client init --sample sample_mcp_with_dcr --profile <name> --profile-dir <dir> --tunnel-id <id> --mcp-server-url <url> --control-plane-api-key-ref file:<path> --health-listen-addr 127.0.0.1:0` (`--force` replaces an existing profile; this adapter sets the old file aside instead). The sample YAML has no `harpoon` section; `harpoon.allow_plaintext_http` is also a `run` flag (`--harpoon.allow-plaintext-http`), but the profile is where the manual procedure put it.
- Run: `tunnel-client run --profile <name> --profile-dir <dir> --health.listen-addr 127.0.0.1:0 --health.url-file <file>`. The tool writes its resolved health base URL to the file and serves `/healthz` (liveness), `/readyz` (includes the OAuth discovery and MCP probe gates), `/ui`. Flags override environment, which overrides YAML.
- Diagnostics: `tunnel-client doctor --profile <name> --profile-dir <dir> --json` (also `--explain`). The JSON shape of 0.0.14 has not been observed (`doctor` has not been run against a real profile); the parser looks for objects with a name and a failing status at any depth and otherwise falls back to the exit code and kinds.
- The tool's help says not to supervise it with `nohup`/`disown`; a foreground `run` attached to the parent is the intended form. `tunnel-client health --url-file <file>` exists as a probe, not used here.
- Not confirmed: the exact file name `init` writes under `--profile-dir` (assumed `<name>.yaml`, matching the owner's existing profile; `prepare` fails as `profile_failed` and cleans up if it is not there), and the exact wording of error lines (the classification patterns in `output.ts` come from the tool's help and troubleshooting texts and from observed log lines such as `harpoon host auto-registration failed … base URL must use https`, which a profile without `harpoon.allow_plaintext_http: true` logs for the bridge's loopback `http` OAuth endpoints).

## Official install instructions (confirmed 2026-10-07)

- OpenAI's guide "Secure MCP Tunnel": <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>. It says: open Platform tunnel settings (<https://platform.openai.com/settings/organization/tunnels>) and use the download link there, or the latest public release from <https://github.com/openai/tunnel-client/releases/latest>; then `tunnel-client help quickstart`.
- The official repository <https://github.com/openai/tunnel-client> (owner `openai`, Apache-2.0; the installed binary's own help and SBOM name the same repository) gives Homebrew as the supported macOS install:
  1. `brew install openai/tools/tunnel-client`
  2. `tunnel-client --version`
  3. `tunnel-client help quickstart`
     It warns that directly downloaded release ZIPs are not notarized and can be blocked by Gatekeeper, and says not to bypass that with `xattr`, `spctl`, or "Open Anyway" but to install from the official tap instead.
- The settings page and the install guides link the OpenAI guide as the official page; on macOS they show the Homebrew command. The program never downloads or installs the tool itself.

## Tests

`tunnel-client.test.ts` uses a fake `ProcessRunner` that behaves like the tool for `--version`, `init`, `doctor`, and a fake child for `run`, over temporary folders: preparation order and the exact `init` arguments, 0700/0600 permissions, `invalid_input`, `tool_missing` writing nothing, `exists` and `replace`, cleanup and restore on midway failure, a profile holding the key rejected, `key_write_failed`, `run` arguments, readiness from `/readyz`, non-loopback health URL ignored, restart with increasing delay and the switch to `failed`, reset on ready, not-ready with the diagnostics summary, launch failure, stop with cancelled restart and SIGKILL escalation, and the key absent from every argument, environment, log entry, status, and result. `process.test.ts` exercises the real runner with `node` itself (never the tool).
