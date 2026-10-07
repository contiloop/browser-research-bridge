/**
 * Inner port of the Aside adapter: something that runs JavaScript in the Aside REPL. The production
 * implementation is `McpReplClient` (a long-lived `aside mcp` child over stdio); tests use a fake.
 *
 * Errors are thrown as `OutcomeError`: `browser_unavailable` when Aside cannot be reached (with
 * action "run `aside login`" when the CLI login looks expired), `timeout` when the call exceeds its
 * time or is aborted.
 */

export interface ReplCallRequest {
  /** Shown in Aside's REPL log. */
  title: string;
  code: string;
  /** Client-side limit for the whole call. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /**
   * The REPL generation the code depends on (tabs live in one generation). When set and the REPL
   * was restarted since, the call fails with `browser_unavailable` instead of running, and a call
   * interrupted by a child death is not re-run.
   */
  generation?: number | undefined;
}

export interface ReplCallResult {
  /** Concatenated text content of the tool result. */
  text: string;
  /** The REPL reported an error (uncaught exception, syntax error, its own timeout). */
  isError: boolean;
  /** Generation that ran the call. */
  generation: number;
}

export interface ReplClient {
  readonly account: string;
  /** Connects (or reconnects after an idle reset) and returns the current generation. */
  ensureReady(signal?: AbortSignal): Promise<number>;
  /** Current generation; increases on every (re)start of the REPL session. 0 before the first start. */
  generation(): number;
  call(request: ReplCallRequest): Promise<ReplCallResult>;
  close(): Promise<void>;
}
