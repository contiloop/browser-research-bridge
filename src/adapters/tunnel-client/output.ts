/**
 * Reduces tunnel-client output to error kinds. The raw line is never stored, returned, or logged:
 * callers keep only the kind, and every message shown to the user comes from `KIND_MESSAGES`.
 */
import type { ConnectionToolErrorKind } from "../../ports/connection-tool.js";

const PATTERNS: ReadonlyArray<readonly [RegExp, ConnectionToolErrorKind]> = [
  [
    /referenced by --control-plane\.api-key is empty|api.key is required|control plane api key is required/i,
    "key_missing",
  ],
  [/invalid tunnel id|tunnel id is required|tunnel-id is required/i, "tunnel_id_invalid"],
  [/base url must use https|harpoon host auto-registration failed/i, "plaintext_http_blocked"],
  [/\b401\b|unauthori[sz]ed|invalid api key|incorrect api key|invalid_api_key/i, "key_rejected"],
  [/\b403\b|forbidden|insufficient permissions|missing scope/i, "permission_denied"],
  [
    /oauth discovery failed|oauth auth-server metadata fetch failed|failed to fetch oauth discovery/i,
    "oauth_discovery_failed",
  ],
  [/mcp probe failed|connection refused|no such host|dial tcp/i, "mcp_unreachable"],
  [/address already in use|bind: /i, "port_in_use"],
  [/profile .*not found|no such profile|profile file .*does not exist/i, "profile_missing"],
];

const ERROR_LEVEL =
  /"level"\s*:\s*"(error|fatal|panic)"|\blevel=(error|fatal|panic)\b|^(error|fatal|panic)\b/i;

/** The kind a line indicates, or null when the line carries no recognized problem. */
export function classifyLine(line: string): ConnectionToolErrorKind | null {
  for (const [pattern, kind] of PATTERNS) if (pattern.test(line)) return kind;
  return ERROR_LEVEL.test(line) ? "tool_error" : null;
}

/** Distinct kinds found in a block of output, in order of first appearance. */
export function classifyOutput(text: string): ConnectionToolErrorKind[] {
  const kinds: ConnectionToolErrorKind[] = [];
  for (const line of text.split(/\r?\n/)) {
    const kind = classifyLine(line);
    if (kind !== null && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

export const KIND_MESSAGES: Readonly<Record<ConnectionToolErrorKind, string>> = {
  invalid_input: "The tunnel id, runtime key, profile name, or target address is not valid.",
  tool_missing: "The connection tool (tunnel-client) is not installed.",
  exists: "A connection profile or key file with this name already exists.",
  key_write_failed: "The runtime key file could not be written.",
  profile_failed: "The connection tool could not create its profile.",
  spawn_failed: "The connection tool could not be started.",
  exited: "The connection tool stopped unexpectedly.",
  not_ready: "The connection tool started but did not become ready in time.",
  key_missing: "The connection tool could not read the runtime key.",
  key_rejected: "OpenAI rejected the runtime key.",
  permission_denied: "The runtime key lacks permission for this tunnel (it needs Tunnels Read + Use).",
  tunnel_id_invalid: "The tunnel id was not accepted.",
  plaintext_http_blocked: "The connection tool refused the program's local http sign-in addresses.",
  oauth_discovery_failed: "The connection tool could not read the program's sign-in information.",
  mcp_unreachable: "The connection tool could not reach the program's public side.",
  port_in_use: "The connection tool's status port was already in use.",
  profile_missing: "The connection tool could not find its profile.",
  tool_error: "The connection tool reported an error.",
};
