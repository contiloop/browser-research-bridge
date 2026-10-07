/**
 * Connection tool port: the program-managed process that connects the public side to ChatGPT
 * (OpenAI's `tunnel-client`, Secure MCP Tunnel). The service that owns the ChatGPT connection
 * (setup, disconnect, the six connection states) talks only to this contract.
 *
 * Secrets: the runtime key is accepted once by `prepare` and written to an owner-only file. No method
 * returns it, and implementations never put it in a command-line argument, an environment value, a
 * log line, or a failure message. Failure messages are the implementation's own wording, never raw
 * tool output.
 */

/** Run state of the managed tool process. `ready` means the tool itself reports ready. */
export type ConnectionToolRunState = "stopped" | "starting" | "ready" | "failed";

/**
 * Closed set of failure kinds. Prepare kinds: `invalid_input`, `tool_missing`, `exists`,
 * `key_write_failed`, `profile_failed`. Run kinds: `spawn_failed`, `exited`, `not_ready`, plus the kinds
 * recognized in the tool's output (`key_missing`, `key_rejected`, `permission_denied`,
 * `tunnel_id_invalid`, `plaintext_http_blocked`, `oauth_discovery_failed`, `mcp_unreachable`,
 * `port_in_use`, `profile_missing`), and `tool_error` for an error line nothing else matched.
 */
export type ConnectionToolErrorKind =
  | "invalid_input"
  | "tool_missing"
  | "exists"
  | "key_write_failed"
  | "profile_failed"
  | "spawn_failed"
  | "exited"
  | "not_ready"
  | "key_missing"
  | "key_rejected"
  | "permission_denied"
  | "tunnel_id_invalid"
  | "plaintext_http_blocked"
  | "oauth_discovery_failed"
  | "mcp_unreachable"
  | "port_in_use"
  | "profile_missing"
  | "tool_error";

export interface ConnectionToolInfo {
  installed: boolean;
  /** `major.minor.patch` as the tool reports it, or null when not installed or unparseable. */
  version: string | null;
}

export interface PrepareConnectionInput {
  /** `tunnel_` + 32 lowercase hexadecimal characters. */
  tunnelId: string;
  /** The runtime key: one non-empty line (a single trailing line break is tolerated). Never returned. */
  runtimeKey: string;
  /** Lowercase letters, digits, and hyphens, 1–64 characters. */
  profileName: string;
  /** The MCP URL the tool forwards to: always the public side's `/mcp`, never the settings page. */
  targetMcpUrl: string;
  /** Overwrite an existing profile file or key file instead of refusing with `exists`. */
  replace?: boolean | undefined;
}

export interface ConnectionPaths {
  /** The tool's profile YAML (holds the key file's location, never the key). */
  profileFile: string;
  /** The owner-only runtime key file. */
  keyFile: string;
}

export type PrepareConnectionResult =
  | ({ ok: true } & ConnectionPaths)
  | {
      ok: false;
      error: Extract<
        ConnectionToolErrorKind,
        "invalid_input" | "tool_missing" | "exists" | "key_write_failed" | "profile_failed"
      >;
      /** Plain words, no secret, no raw tool output. */
      message: string;
    };

export interface ConnectionToolFailure {
  kind: ConnectionToolErrorKind;
  /** Plain words, no secret, no raw tool output. */
  message: string;
  /** ISO time. */
  at: string;
}

export interface ConnectionToolStatus {
  state: ConnectionToolRunState;
  /** Profile the managed process runs, or null when nothing was started. */
  profileName: string | null;
  /** Most recent failure; kept after a later success or stop so the page can explain it. */
  lastFailure: ConnectionToolFailure | null;
  /** Consecutive failed attempts since the last `ready` or `start`. */
  consecutiveFailures: number;
}

export interface ConnectionDiagnostics {
  /** True when the tool's own diagnostics exited successfully. */
  ok: boolean;
  /** Names of failed checks as the tool labels them (sanitized), possibly empty. */
  failedChecks: string[];
  /** Error kinds recognized in the diagnostics output. */
  kinds: ConnectionToolErrorKind[];
  /** One plain sentence for the page; no secret, no raw output. */
  summary: string;
}

export interface ConnectionTool {
  /** Whether the tool is installed and which version. Never throws. */
  detect(): Promise<ConnectionToolInfo>;
  /** Where `prepare` writes for this profile name (pure; no I/O). */
  paths(profileName: string): ConnectionPaths;
  /**
   * Stores the key file, then creates the profile. Refuses with `exists` when either file exists and
   * `replace` is not set; refuses with `tool_missing` before writing anything. A failure midway
   * removes what this call created and restores what it replaced. Never throws.
   */
  prepare(input: PrepareConnectionInput): Promise<PrepareConnectionResult>;
  /**
   * Starts the managed process for `profileName` (no-op while it is already `starting` or `ready`
   * for that profile; from `failed` or `stopped` it starts again with the failure count reset).
   * Returns once the process has been launched; readiness is reported through `status()`.
   */
  start(profileName: string): void;
  /** Stops the managed process gracefully (escalating after a timeout) and cancels pending restarts. */
  stop(): Promise<void>;
  status(): ConnectionToolStatus;
  /** Called after every status change; returns an unsubscribe function. */
  onStatusChange(listener: (status: ConnectionToolStatus) => void): () => void;
  /** Runs the tool's own diagnostics for a profile and reduces them to a summary. Never throws. */
  diagnose(profileName: string): Promise<ConnectionDiagnostics>;
  /** Deletes the stored key file of a profile (absent is fine). The profile file is left. */
  removeKey(profileName: string): Promise<void>;
}
