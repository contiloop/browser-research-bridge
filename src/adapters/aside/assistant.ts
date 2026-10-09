/**
 * `SiteAssistant` over the Aside CLI: one `aside exec` child per task, confined as follows.
 *
 * - Arguments: exactly `exec --account <account> --host local --permission guard --effort <effort>
 *   <instruction>`, the instruction one argument and one of the fixed texts of `assistant-prompts.ts`
 *   (no shell; the account must be a plain account id, so it cannot pose as a flag).
 * - Working directory: `<dataDir>/assistant-work/`, an owner-only (0700) folder emptied before a run
 *   when no other run is active; never the repository, and refused when it is a symbolic link.
 * - Environment: the same minimal set the `aside mcp` child gets (`getDefaultEnvironment()`: HOME,
 *   LOGNAME, PATH, SHELL, TERM, USER), with every `BRIDGE_*`, `ANTHROPIC_*`, `OPENAI_*` name removed.
 * - Standard input: closed (`/dev/null`), so a task stuck on a prompt runs into its budget.
 *
 * Observed CLI contract (2026-10-09): `aside exec` blocks until the task is done, prints `created new
 * session: <id>` on standard error and the AI's reply on standard output, both with terminal color codes,
 * and exits 0; `aside session stop --account <account> <id>` stops a session. The session id is taken
 * from the first such line only (the CLI prints it before the reply) and only in a plain form; the
 * verdict from the reply's last `RESULT:` line. Both streams are scanned line by line, each with its own
 * line buffer and with the color codes stripped, and dropped: the AI's text is never kept, logged, or
 * returned. When the budget runs out
 * or the caller's signal fires, the session is stopped (when its id is known), then the child is killed
 * (SIGTERM, SIGKILL after a grace), and the verdict is `failed`/`timed_out`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ASSISTANT_EFFORTS,
  DEFAULT_ASSISTANT_EFFORT,
  isAssistantEffort,
  type AssistantEffort,
} from "../../core/settings.js";
import {
  ASSISTANT_REASON_CODES,
  type AssistantAvailabilityOptions,
  type AssistantResult,
  type AssistantTask,
  type AssistantVerdict,
  type ReasonCode,
  type SiteAssistant,
} from "../../ports/assistant.js";
import type { Logger } from "../../ports/logger.js";
import { buildAssistantInstruction } from "./assistant-prompts.js";
import { checkUrlInScope } from "./hosts.js";

/** The folder under the data folder the Aside AI runs in. */
export const ASSISTANT_WORK_DIR = "assistant-work";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for the child's exit before giving up on it. */
const KILL_WAIT_MS = 5_000;
/** A line longer than this is not a session or result line; its text is dropped unread. */
const MAX_LINE_CHARS = 4_096;

/** An Aside account id: one short word that cannot start like a flag (`u0`, `u3`, `work.profile`). */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
/** The CLI's session line; the id must be a plain token that cannot start like a flag. */
const SESSION_LINE = /^created new session:\s*(\S+)\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Removes terminal escape sequences (colors, cursor moves) the Aside CLI adds to its output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_ENV = /^(BRIDGE_|ANTHROPIC_|OPENAI_)/i;

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface AsideSiteAssistantOptions {
  /** The Aside CLI executable (`ASIDE_CLI`; default `aside`, found on the child's `PATH`). */
  command?: string | undefined;
  /** The bridge's data folder (absolute); the AI runs in `<dataDir>/assistant-work/`. */
  dataDir: string;
  /** `assistant.effort` (default `low`); anything but one of Aside's effort names throws. */
  effort?: AssistantEffort | undefined;
  logger?: Logger | undefined;
  /** Epoch-ms clock for durations; defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** How long `aside account status` may take in `available()` (default 5 s). */
  probeTimeoutMs?: number | undefined;
  /** How long `aside session stop` may take (default 10 s). */
  stopTimeoutMs?: number | undefined;
  /** Time between SIGTERM and SIGKILL when a child is killed (default 2 s). */
  killGraceMs?: number | undefined;
}

/** The environment of every Aside CLI child: the MCP SDK's minimal set without any bridge or AI key. */
export function assistantEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const name of Object.keys(env)) {
    if (FORBIDDEN_ENV.test(name)) delete env[name];
  }
  return env;
}

/**
 * Reads one reply line: null when it is not a `RESULT:` line; else the verdict and reason it states.
 * `DONE` (optionally with a period) is done; `FAILED`/`NEEDS_USER` take the next word as the code, an
 * unknown or missing code being `other`; anything else after `RESULT:` is failed/other. Surrounding
 * Markdown emphasis or code marks are ignored.
 */
export function parseAssistantResult(
  line: string,
): { verdict: AssistantVerdict; reason: ReasonCode | null } | null {
  const text = line
    .trim()
    .replace(/^[*_`\s]+/, "")
    .replace(/[*_`\s]+$/, "");
  const match = /^RESULT:\s*(.*)$/i.exec(text);
  if (!match) return null;
  const words = (match[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const keyword = (words[0] ?? "").replace(/\.$/, "").toUpperCase();
  if (keyword === "DONE") {
    return words.length === 1 ? { verdict: "done", reason: null } : { verdict: "failed", reason: "other" };
  }
  if (keyword === "FAILED" || keyword === "NEEDS_USER") {
    const code = (words[1] ?? "").replace(/[.,;:!]+$/, "").toLowerCase();
    const reason = (ASSISTANT_REASON_CODES as readonly string[]).includes(code)
      ? (code as ReasonCode)
      : "other";
    return { verdict: keyword === "FAILED" ? "failed" : "needs_user", reason };
  }
  return { verdict: "failed", reason: "other" };
}

/**
 * The scan of the CLI's output: keeps only the session id and the last verdict. Standard output (the
 * reply and its `RESULT:` line) and standard error (the `created new session: <id>` line) each get their
 * own line buffer (`stream()`), so a line that one stream leaves unfinished is never joined to text of
 * the other; both feed the same session id and verdict. Terminal escape codes are stripped before
 * matching; every line is dropped after it is read.
 */
class OutputScanner {
  sessionId: string | null = null;
  result: { verdict: AssistantVerdict; reason: ReasonCode | null } | null = null;
  private sessionSeen = false;
  private readonly streams: StreamLines[] = [];

  /** A line buffer for one output stream. */
  stream(): StreamLines {
    const stream = new StreamLines((line, resultSeen) => this.line(line, resultSeen));
    this.streams.push(stream);
    return stream;
  }

  /** The streams have ended: each one's unfinished last line is read. */
  end(): void {
    for (const stream of this.streams) stream.end();
  }

  /** Returns true when the line was a `RESULT:` line. */
  private line(raw: string, resultSeen: boolean): boolean {
    // The CLI colors its output (`\x1b[2m…\x1b[0m`); strip the terminal escape codes before matching.
    const text = stripAnsi(raw).trim();
    if (text === "") return false;
    // Only the first session line counts, and only before a `RESULT:` line of its own stream (the CLI
    // prints it before the reply, so a look-alike line later in the reply is ignored); an id that could
    // pose as a flag is not taken.
    if (!this.sessionSeen && !resultSeen) {
      const session = SESSION_LINE.exec(text);
      if (session) {
        this.sessionSeen = true;
        const id = session[1] ?? "";
        if (SESSION_ID.test(id)) this.sessionId = id;
        return false;
      }
    }
    const parsed = parseAssistantResult(text);
    if (parsed === null) return false;
    this.result = parsed;
    return true;
  }
}

/** One output stream's partial-line buffer; complete lines go to the shared scan. */
class StreamLines {
  private partial = "";
  private overlong = false;
  private resultSeen = false;

  constructor(private readonly onLine: (line: string, resultSeen: boolean) => boolean) {}

  feed(chunk: string): void {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      this.line(this.partial + rest.slice(0, newline));
      this.partial = "";
      this.overlong = false;
      rest = rest.slice(newline + 1);
    }
    if (this.overlong) return;
    this.partial += rest;
    if (this.partial.length > MAX_LINE_CHARS) {
      this.partial = "";
      this.overlong = true;
    }
  }

  end(): void {
    if (!this.overlong && this.partial !== "") this.line(this.partial);
    this.partial = "";
  }

  private line(raw: string): void {
    if (this.overlong || raw.length > MAX_LINE_CHARS) return;
    if (this.onLine(raw, this.resultSeen)) this.resultSeen = true;
  }
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The child could not be started (for example ENOENT). */
  spawnError: boolean;
}

export class AsideSiteAssistant implements SiteAssistant {
  private readonly command: string;
  private readonly workDir: string;
  private readonly effort: AssistantEffort;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly killGraceMs: number;
  private probe: Promise<boolean> | null = null;
  private active = 0;

  constructor(options: AsideSiteAssistantOptions) {
    const effort = options.effort ?? DEFAULT_ASSISTANT_EFFORT;
    if (!isAssistantEffort(effort)) {
      throw new Error(`assistant effort must be one of ${ASSISTANT_EFFORTS.join(", ")}`);
    }
    this.command = options.command ?? "aside";
    this.workDir = join(options.dataDir, ASSISTANT_WORK_DIR);
    this.effort = effort;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  available(options: AssistantAvailabilityOptions = {}): Promise<boolean> {
    if (options.reprobe !== true && this.probe !== null) return this.probe;
    const probe = this.runProbe().catch(() => false);
    this.probe = probe;
    return probe;
  }

  async run(task: AssistantTask): Promise<AssistantResult> {
    const started = this.now();
    this.active += 1;
    try {
      return await this.runTask(task, started);
    } catch {
      // Never thrown to the caller (the port's contract). The error text is not logged: a spawn
      // argument error would quote the arguments, the instruction among them.
      const result: AssistantResult = {
        verdict: "failed",
        reason: "other",
        sessionId: null,
        durationMs: Math.max(0, this.now() - started),
      };
      this.logger.warn("assistant run", {
        site: task.site,
        purpose: task.purpose,
        verdict: result.verdict,
        reason: result.reason,
        durationMs: result.durationMs,
        error: "unexpected",
      });
      return result;
    } finally {
      this.active -= 1;
    }
  }

  private async runTask(task: AssistantTask, started: number): Promise<AssistantResult> {
    const finish = (
      verdict: AssistantVerdict,
      reason: ReasonCode | null,
      sessionId: string | null,
      extra: Record<string, string | number | boolean | null> = {},
    ): AssistantResult => {
      const result: AssistantResult = {
        verdict,
        reason,
        sessionId,
        durationMs: Math.max(0, this.now() - started),
      };
      this.logger.info("assistant run", {
        site: task.site,
        purpose: task.purpose,
        verdict,
        reason,
        sessionId,
        durationMs: result.durationMs,
        ...extra,
      });
      return result;
    };

    if (aborted(task.signal)) return finish("failed", "timed_out", null, { started: false });
    if (!Number.isFinite(task.budgetMs) || task.budgetMs <= 0) {
      return finish("failed", "timed_out", null, { started: false });
    }
    if (typeof task.account !== "string" || !ACCOUNT.test(task.account)) {
      return finish("failed", "other", null, { started: false, refused: "account" });
    }
    const extraHosts = task.extraAllowedHosts ?? [];
    if (!pageOnSite(task.url, task.hostnames, extraHosts)) {
      return finish("failed", "other", null, { started: false, refused: "url" });
    }
    const instruction = buildAssistantInstruction({
      purpose: task.purpose,
      hostnames: task.hostnames,
      extraAllowedHosts: extraHosts,
      loginUrl: task.purpose === "login" ? task.loginUrl : null,
    });
    if (instruction === null)
      return finish("failed", "other", null, { started: false, refused: "hostnames" });

    let cwd: string;
    try {
      cwd = await this.prepareWorkDir();
    } catch {
      return finish("failed", "other", null, { started: false, refused: "work_dir" });
    }
    // The work folder is ready; a signal that fired meanwhile still keeps the CLI from starting.
    if (aborted(task.signal)) return finish("failed", "timed_out", null, { started: false });

    const scanner = new OutputScanner();
    const child = this.spawnCli(
      [
        "exec",
        "--account",
        task.account,
        "--host",
        "local",
        "--permission",
        "guard",
        "--effort",
        this.effort,
        instruction,
      ],
      cwd,
      "pipe",
    );
    // The reply and its RESULT line come on stdout, the "created new session" line on stderr. Each
    // stream is read line by line through its own buffer, and neither is ever logged.
    const out = scanner.stream();
    const err = scanner.stream();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => out.feed(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => err.feed(chunk));

    // Set once by `expire` (budget spent or signal): the session stop, then the kill.
    const stop: { running: Promise<void> | null; sessionStopped: boolean | null } = {
      running: null,
      sessionStopped: null,
    };
    const exited = waitForExit(child);
    const expire = (): void => {
      if (stop.running !== null) return;
      stop.running = (async () => {
        const sessionId = scanner.sessionId;
        if (sessionId !== null) stop.sessionStopped = await this.stopSession(task.account, sessionId, cwd);
        await this.kill(child, exited);
      })();
    };
    const timer = setTimeout(expire, task.budgetMs);
    task.signal?.addEventListener("abort", expire, { once: true });

    let exit: ChildExit;
    try {
      exit = await exited;
    } finally {
      clearTimeout(timer);
      task.signal?.removeEventListener("abort", expire);
    }
    scanner.end();
    if (stop.running !== null) {
      // The CLI may return as soon as its session is stopped; let the stop (and kill) finish first.
      await stop.running;
      const meta = { exitCode: exit.code, signal: exit.signal, sessionStopped: stop.sessionStopped };
      return finish("failed", "timed_out", scanner.sessionId, meta);
    }
    const meta = { exitCode: exit.code, signal: exit.signal };
    if (exit.spawnError) return finish("failed", "other", null, { ...meta, started: false });
    if (exit.code !== 0) return finish("failed", "other", scanner.sessionId, meta);
    const result = scanner.result;
    if (result === null) return finish("failed", "other", scanner.sessionId, meta);
    return finish(
      result.verdict,
      result.verdict === "done" ? null : (result.reason ?? "other"),
      scanner.sessionId,
      meta,
    );
  }

  /** `aside account status` exits 0 within the probe time. */
  private async runProbe(): Promise<boolean> {
    let cwd: string;
    try {
      cwd = await this.prepareWorkDir();
    } catch {
      return false;
    }
    const child = this.spawnCli(["account", "status"], cwd, "ignore");
    const exited = waitForExit(child);
    const timer = setTimeout(() => void this.kill(child, exited), this.probeTimeoutMs);
    const exit = await exited;
    clearTimeout(timer);
    const ok = !exit.spawnError && exit.code === 0;
    this.logger.debug("assistant probe", { available: ok });
    return ok;
  }

  /** `aside session stop --account <account> <id>`, bounded; true when it exited 0. */
  private async stopSession(account: string, sessionId: string, cwd: string): Promise<boolean> {
    const child = this.spawnCli(["session", "stop", "--account", account, sessionId], cwd, "ignore");
    const exited = waitForExit(child);
    const timer = setTimeout(() => void this.kill(child, exited), this.stopTimeoutMs);
    const exit = await exited;
    clearTimeout(timer);
    return !exit.spawnError && exit.code === 0;
  }

  private spawnCli(args: string[], cwd: string, stdout: "pipe" | "ignore"): ChildProcess {
    return spawn(this.command, args, {
      cwd,
      env: assistantEnvironment(),
      stdio: ["ignore", stdout, stdout],
      shell: false,
      windowsHide: true,
    });
  }

  /** SIGTERM, then SIGKILL after the grace, then a bounded wait for the exit. */
  private async kill(child: ChildProcess, exited: Promise<ChildExit>): Promise<void> {
    let done = false;
    void exited.then(() => {
      done = true;
    });
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([exited, delay(this.killGraceMs)]);
    if (done) return;
    child.kill("SIGKILL");
    await Promise.race([exited, delay(KILL_WAIT_MS)]);
  }

  /** Creates `<dataDir>/assistant-work` (0700), refuses a symlink, and empties it when no other run is active. */
  private async prepareWorkDir(): Promise<string> {
    const dir = this.workDir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("the assistant work folder is not a plain folder");
    await chmod(dir, 0o700);
    if (this.active <= 1) {
      for (const entry of await readdir(dir)) {
        await rm(join(dir, entry), { recursive: true, force: true });
      }
    }
    return dir;
  }
}

/** The problem page is an http(s) address on the site's hostnames or extra allowed hosts. */
function pageOnSite(url: unknown, hostnames: readonly string[], extra: readonly string[]): boolean {
  if (typeof url !== "string" || hostnames.length === 0) return false;
  return checkUrlInScope(
    url,
    [...hostnames, ...extra].map((h) => h.trim().toLowerCase().replace(/\.$/, "")),
  ).ok;
}

/** Read through a function so a check after an `await` is not narrowed by an earlier one. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise<ChildExit>((resolve) => {
    let settled = false;
    const settle = (exit: ChildExit): void => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.on("error", () => {
      // A child that never started emits no exit; one that did is followed by `close`.
      if (child.pid === undefined) settle({ code: null, signal: null, spawnError: true });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ code, signal, spawnError: false }),
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
