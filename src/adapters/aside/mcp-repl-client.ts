/**
 * `ReplClient` over one long-lived `aside mcp --account <account>` child speaking MCP on stdio.
 * The MCP SDK client performs the handshake and request bookkeeping; this class owns the
 * child's lifecycle:
 * - lazy start, then one shared session for all calls (Aside runs concurrent `repl` calls in
 *   parallel; see docs/BROWSER.md);
 * - restart at most once per call when the child is gone or dies mid-call, then `browser_unavailable`;
 * - re-handshake (fresh child) before a call when the REPL has been idle long enough for Aside's
 *   30-minute idle reset; every restart bumps the generation so stale tab handles are detected;
 * - an expired CLI login maps to `browser_unavailable` with action "run `aside login`".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { OutcomeError } from "../../core/outcome.js";
import type { Logger } from "../../ports/logger.js";
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REPL_IDLE_MARGIN_MS,
  DEFAULT_REPL_IDLE_RESET_MS,
} from "./defaults.js";
import type { ReplCallRequest, ReplCallResult, ReplClient } from "./repl-client.js";

export const ASIDE_LOGIN_ACTION = "run `aside login`";

const LOGIN_PROBLEM =
  /aside login|not (?:signed|logged) in|sign(?:ed)?[ -]?in (?:is )?required|log(?:ged)?[ -]?in (?:has )?expired|login required|session (?:has )?expired|unauthori[sz]ed|re-?authenticate|\b401\b/i;

/** True when Aside's own error text points at an expired or missing CLI login. */
export function looksLikeLoginProblem(text: string): boolean {
  return LOGIN_PROBLEM.test(text);
}

export function asideUnavailable(message: string, evidence = ""): OutcomeError {
  if (looksLikeLoginProblem(`${message}\n${evidence}`)) {
    return new OutcomeError(
      "browser_unavailable",
      "the Aside CLI login has expired or is missing",
      ASIDE_LOGIN_ACTION,
    );
  }
  return new OutcomeError("browser_unavailable", message);
}

export interface SpawnedTransport {
  transport: Transport;
  /** The child's stderr, when available (diagnostics; never page content). */
  stderr?: NodeJS.ReadableStream | null | undefined;
}

export type TransportFactory = (account: string) => SpawnedTransport;

export interface StdioTransportOptions {
  /** The Aside CLI executable (default `aside`; use an absolute path when PATH lacks it, e.g. under launchd). */
  command?: string | undefined;
  /** Extra environment for the child (the SDK's safe default environment is always included). */
  env?: Record<string, string> | undefined;
}

/** Spawns `aside mcp --account <account>` with stderr piped. */
export function stdioTransportFactory(options: StdioTransportOptions = {}): TransportFactory {
  return (account) => {
    const transport = new StdioClientTransport({
      command: options.command ?? "aside",
      args: ["mcp", "--account", account],
      stderr: "pipe",
      env: { ...getDefaultEnvironment(), ...options.env },
    });
    return { transport, stderr: transport.stderr as NodeJS.ReadableStream | null };
  };
}

export interface McpReplClientOptions {
  account: string;
  transportFactory: TransportFactory;
  logger?: Logger | undefined;
  /** Epoch-ms clock; defaults to `Date.now`. */
  now?: (() => number) | undefined;
  idleResetMs?: number | undefined;
  idleMarginMs?: number | undefined;
  handshakeTimeoutMs?: number | undefined;
  clientInfo?: { name: string; version: string } | undefined;
}

interface Connection {
  client: Client;
  generation: number;
  closed: boolean;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function isMcpError(err: unknown, code: number): boolean {
  return err instanceof McpError && err.code === code;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** REPL error texts that mean the browser session behind the child is gone. */
const SESSION_LOST =
  /Session with given id not found|Chrome extension not connected|task browser window is no longer available|not connected to the daemon/i;

function tabLost(): OutcomeError {
  return new OutcomeError(
    "browser_unavailable",
    "the Aside REPL was restarted during the task and its tabs were closed; retry the request",
  );
}

export class McpReplClient implements ReplClient {
  readonly account: string;
  private readonly factory: TransportFactory;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly idleResetMs: number;
  private readonly idleMarginMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly clientInfo: { name: string; version: string };

  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private gen = 0;
  private lastActivity = 0;
  private inFlight = 0;
  private shutDown = false;
  private stderrTail: string[] = [];

  constructor(options: McpReplClientOptions) {
    this.account = options.account;
    this.factory = options.transportFactory;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.idleResetMs = options.idleResetMs ?? DEFAULT_REPL_IDLE_RESET_MS;
    this.idleMarginMs = options.idleMarginMs ?? DEFAULT_REPL_IDLE_MARGIN_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.clientInfo = options.clientInfo ?? { name: "browser-research-bridge", version: "0.1.0" };
  }

  generation(): number {
    return this.gen;
  }

  async ensureReady(): Promise<number> {
    let attempt = 0;
    for (;;) {
      try {
        return (await this.connection()).generation;
      } catch (err) {
        attempt += 1;
        if (attempt > 1 || this.shutDown || this.isLoginError(err)) throw err;
      }
    }
  }

  async call(request: ReplCallRequest): Promise<ReplCallResult> {
    let restarted = false;
    for (;;) {
      if (request.signal?.aborted)
        throw new OutcomeError("timeout", "browser step cancelled (time budget spent)");
      let conn: Connection;
      try {
        conn = await this.connection();
      } catch (err) {
        if (restarted || this.shutDown || this.isLoginError(err)) throw err;
        restarted = true;
        continue;
      }
      if (request.generation !== undefined && conn.generation !== request.generation) throw tabLost();
      this.inFlight += 1;
      try {
        const result = await conn.client.callTool(
          { name: "repl", arguments: { title: request.title, code: request.code } },
          undefined,
          request.signal
            ? { timeout: request.timeoutMs, signal: request.signal }
            : { timeout: request.timeoutMs },
        );
        const content = Array.isArray(result.content)
          ? (result.content as Array<{ type?: unknown; text?: unknown }>)
          : [];
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        if (result.isError === true && SESSION_LOST.test(text)) {
          // The child is alive but its browser session is gone (Aside window closed, extension
          // disconnected, stale session id). Treat it like a dead child: restart once.
          this.logger.warn("aside browser session lost; restarting the aside mcp child", {
            account: this.account,
          });
          await this.drop(conn);
          if (request.generation !== undefined) throw tabLost();
          if (restarted) throw asideUnavailable("the Aside browser session is unavailable after a restart", text);
          restarted = true;
          continue;
        }
        return { text, isError: result.isError === true, generation: conn.generation };
      } catch (err) {
        if (request.signal?.aborted)
          throw new OutcomeError("timeout", "browser step cancelled (time budget spent)");
        if (isMcpError(err, ErrorCode.RequestTimeout)) {
          throw new OutcomeError(
            "timeout",
            `browser step exceeded ${Math.round(request.timeoutMs / 1000)} s`,
          );
        }
        if (conn.closed || isMcpError(err, ErrorCode.ConnectionClosed)) {
          this.logger.warn("aside mcp child exited during a call", { account: this.account });
          await this.drop(conn);
          if (request.generation !== undefined) throw tabLost();
          if (restarted)
            throw asideUnavailable(
              "Aside stopped responding (the `aside mcp` child exited again after a restart)",
              this.stderr(),
            );
          restarted = true;
          continue;
        }
        throw asideUnavailable(`the Aside REPL call failed: ${errorText(err)}`, this.stderr());
      } finally {
        this.inFlight -= 1;
        this.lastActivity = this.now();
      }
    }
  }

  async close(): Promise<void> {
    this.shutDown = true;
    const pending = this.connecting;
    if (pending) await pending.catch(() => undefined);
    if (this.conn) await this.drop(this.conn);
  }

  private isLoginError(err: unknown): boolean {
    return err instanceof OutcomeError && err.action === ASIDE_LOGIN_ACTION;
  }

  private stderr(): string {
    return this.stderrTail.join("\n");
  }

  private connection(): Promise<Connection> {
    if (this.shutDown)
      return Promise.reject(new OutcomeError("browser_unavailable", "the browser port is shut down"));
    if (this.connecting) return this.connecting;
    const current = this.conn;
    if (current && !current.closed) {
      const idleFor = this.now() - this.lastActivity;
      if (this.inFlight === 0 && idleFor >= this.idleResetMs - this.idleMarginMs) {
        this.conn = null;
        this.connecting = (async () => {
          this.logger.info("aside REPL idle reset: re-handshaking", {
            account: this.account,
            idleMs: idleFor,
          });
          await this.drop(current);
          return this.connect();
        })().finally(() => {
          this.connecting = null;
        });
        return this.connecting;
      }
      return Promise.resolve(current);
    }
    this.conn = null;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Connection> {
    this.stderrTail = [];
    let spawned: SpawnedTransport;
    try {
      spawned = this.factory(this.account);
    } catch (err) {
      throw asideUnavailable(`could not start \`aside mcp\`: ${errorText(err)}`);
    }
    spawned.stderr?.on("data", (chunk: Buffer | string) => this.onStderr(String(chunk)));
    const client = new Client(this.clientInfo, { capabilities: {} });
    const conn: Connection = { client, generation: this.gen + 1, closed: false };
    client.onclose = () => {
      conn.closed = true;
    };
    client.onerror = (err) => {
      this.logger.debug("aside mcp transport error", {
        account: this.account,
        error: errorText(err).slice(0, 200),
      });
    };
    try {
      await client.connect(spawned.transport, { timeout: this.handshakeTimeoutMs });
    } catch (err) {
      conn.closed = true;
      await client.close().catch(() => undefined);
      // Let the child's last stderr lines (e.g. a login error) arrive before classifying.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const hint = /ENOENT/.test(errorText(err)) ? " (is the Aside CLI installed and on PATH?)" : "";
      throw asideUnavailable(
        `could not start \`aside mcp --account ${this.account}\`: ${errorText(err)}${hint}`,
        this.stderr(),
      );
    }
    if (this.shutDown) {
      await this.drop(conn);
      throw new OutcomeError("browser_unavailable", "the browser port is shut down");
    }
    this.gen = conn.generation;
    this.conn = conn;
    this.lastActivity = this.now();
    this.logger.info("aside mcp connected", { account: this.account, generation: conn.generation });
    return conn;
  }

  private async drop(conn: Connection): Promise<void> {
    conn.closed = true;
    if (this.conn === conn) this.conn = null;
    await conn.client.close().catch(() => undefined);
  }

  private onStderr(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      this.stderrTail.push(line.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      if (line.startsWith("{")) {
        try {
          const ev = JSON.parse(line) as { event?: unknown; reason?: unknown };
          if (typeof ev.event === "string") {
            this.logger.debug("aside mcp event", {
              account: this.account,
              event: ev.event,
              reason: typeof ev.reason === "string" ? ev.reason : undefined,
            });
          }
        } catch {
          // not JSON; kept only in the tail for error messages
        }
      }
    }
  }
}
