/**
 * {@link AgentRunner} on the Codex CLI (`codex app-server` over stdio) with the ChatGPT sign-in of
 * this Mac. The helper may do exactly what it may do on Claude, and nothing else.
 *
 * How each restriction is enforced (evidence on Codex 0.160.0: `codex-runtime.AGENTS-evidence.md`):
 * - **Only the bridge's tools.** The thread is started with `environments: []` (no execution
 *   environment: Codex registers no shell, `apply_patch`, file, image-view, or MCP-resource tool),
 *   the bridge's tools as client-served `dynamicTools`, and a model catalog rewritten so no model
 *   asks for code mode, sub-agents, the clock tool, or hosted search. Features that add tools
 *   (shell, code mode, multi-agent, apps, plugins, browser/computer use, image generation, goals,
 *   memories, …) are disabled, `request_user_input` and `update_plan` are off, web search is
 *   `disabled`, and `mcp_servers` is empty. `--strict-config` makes Codex exit when any of these
 *   keys is unknown, so a renamed key fails closed instead of being ignored.
 *   The bridge's `CODEX_HOME` also holds `environments.toml` with `include_local = false`, so no
 *   local environment exists for `thread/resume` to re-select (resume takes no `environments`).
 * - **No user or project instructions or settings.** A bridge-owned `CODEX_HOME` with an empty
 *   `config.toml` (its only other content is that `environments.toml` and a link to the user's
 *   `auth.json`, which the bridge never reads), `project_doc_max_bytes = 0`,
 *   `project_root_markers = []`, skills off, and explicit `baseInstructions` (the bridge's system
 *   prompt replaces Codex's own).
 * - **Guards at run time.** The run is refused if the thread reports an environment (a resumed
 *   thread that does is never used: the run returns `resumeFailed` so the service starts fresh) or an
 *   instruction source, if any item other than messages, reasoning, compaction, or a bridge tool call
 *   starts, or if Codex asks for an approval, user input, or an elicitation.
 * - **Environment.** {@link helperBaseEnv} (no `BRIDGE_*`, no `ANTHROPIC_API_KEY`, no parent Claude
 *   session) minus `CODEX_*`/`OPENAI_*`, plus the bridge's `CODEX_HOME`; cwd is the job's empty folder.
 * - **Channel.** The tools travel over the child's anonymous stdio pipes ({@link JsonRpcPeer}): no
 *   listener exists; only this run's child holds the pipes; a tool call must name this run's thread
 *   and one of this run's tools; the pipes close and the child is killed when the run ends.
 *
 * Output of the Codex process is reduced to state and error kind: stderr is classified, never logged.
 * Sessions persist in the bridge's `CODEX_HOME` so Retry can `thread/resume` them.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "../../ports/logger.js";
import { JsonRpcPeer, RpcClosedError } from "./codex-rpc.js";
import type { ServerRequestReply } from "./codex-rpc.js";
import { helperBaseEnv } from "./sdk-runner.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentTool, AgentToolResult } from "./types.js";

/** The Codex CLI version the restrictions were demonstrated on. Another version logs a warning. */
export const VERIFIED_CODEX_VERSION = "0.160.0";
export const DEFAULT_CODEX_MAX_TURNS = 80;
export const CODEX_AUTH_SOURCE = "Codex sign-in (ChatGPT)";
const START_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 3_000;
const STDERR_KEEP = 8_192;

/** Codex features turned off for every helper run (each would add a tool or load outside state). */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "multi_agent",
  "multi_agent_v2",
  "hooks",
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "view_image",
  "goals",
  "sleep_tool",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "memories",
  "in_app_browser",
  "in_app_chat",
  "in_app_local_automation",
  "workspace_dependencies",
  "realtime_conversation",
  "worktrees",
  "daemon_auto_start",
  "tool_call_mcp_elicitation",
  "auth_elicitation",
] as const;

/** `-c key=value` overrides (TOML values) for every helper run. */
export const CODEX_CONFIG_OVERRIDES = [
  'web_search="disabled"',
  "tools.web_search=false",
  "tools.experimental_request_user_input.enabled=false",
  "tools.update_plan.enabled=false",
  "mcp_servers={}",
  "project_doc_max_bytes=0",
  "project_root_markers=[]",
  "skills.bundled.enabled=false",
  "skills.include_instructions=false",
  "include_apps_instructions=false",
  "include_permissions_instructions=false",
  "include_collaboration_mode_instructions=false",
  "include_environment_context=false",
  'shell_environment_policy.inherit="none"',
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'history.persistence="none"',
  "analytics.enabled=false",
] as const;

/** Thread items a helper run may produce; anything else (a command, file change, web search, MCP call, sub-agent, …) refuses the run. */
export const ALLOWED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "contextCompaction",
  "dynamicToolCall",
]);

/** Model catalog fields rewritten on every model so none brings tools of its own. */
export const CATALOG_RESTRICTIONS = {
  tool_mode: "direct",
  shell_type: "disabled",
  apply_patch_tool_type: null,
  multi_agent_version: null,
  experimental_supported_tools: [],
  supports_search_tool: false,
} as const;

export const CATALOG_FILE = "bridge-model-catalog.json";

/**
 * `environments.toml` of the bridge's Codex home: no local execution environment exists at all.
 * `environments: []` on `thread/start` is a per-thread selection that Codex does not persist;
 * `thread/resume` (which has no `environments` parameter) re-selects the default `local`
 * environment unless this file removes it.
 */
export const ENVIRONMENTS_FILE = "environments.toml";
export const ENVIRONMENTS_TOML = "include_local = false\n";

// ---------------------------------------------------------------------------------------------
// Pure builders (covered by tests without a Codex process)
// ---------------------------------------------------------------------------------------------

/** Environment of the Codex process. */
export function codexEnv(
  base: NodeJS.ProcessEnv,
  codexHome: string,
  nodeDir: string,
): Record<string, string> {
  const env = helperBaseEnv(base);
  for (const k of Object.keys(env)) {
    if (k.startsWith("CODEX_") || k.startsWith("OPENAI_")) delete env[k];
  }
  env["CODEX_HOME"] = codexHome;
  // The npm launcher of Codex is `#!/usr/bin/env node`; under launchd PATH has no node.
  const path = env["PATH"] ?? "/usr/bin:/bin";
  env["PATH"] = path.split(":").includes(nodeDir) ? path : `${nodeDir}:${path}`;
  return env;
}

export interface CodexLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CodexLaunchInput {
  codexBin: string;
  codexHome: string;
  catalogPath: string;
  workDir: string;
  baseEnv: NodeJS.ProcessEnv;
  nodeDir: string;
}

/** The `codex app-server` command line of one run. */
export function buildCodexLaunch(input: CodexLaunchInput): CodexLaunch {
  const args = ["app-server", "--listen", "stdio://", "--strict-config"];
  for (const f of CODEX_DISABLED_FEATURES) args.push("--disable", f);
  for (const c of CODEX_CONFIG_OVERRIDES) args.push("-c", c);
  args.push("-c", `model_catalog_json=${JSON.stringify(input.catalogPath)}`);
  return {
    command: input.codexBin,
    args,
    cwd: input.workDir,
    env: codexEnv(input.baseEnv, input.codexHome, input.nodeDir),
  };
}

/** The Codex model catalog with {@link CATALOG_RESTRICTIONS} applied to every model. */
export function restrictModelCatalog(raw: unknown): { models: Record<string, unknown>[] } {
  const models = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(models) || models.length === 0) throw new Error("the Codex model list is empty");
  return {
    ...(raw as object),
    models: models.map((m) => {
      if (typeof m !== "object" || m === null || typeof (m as { slug?: unknown }).slug !== "string")
        throw new Error("the Codex model list has an unexpected shape");
      return { ...(m as Record<string, unknown>), ...CATALOG_RESTRICTIONS };
    }),
  };
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
}

export function toDynamicTools(tools: readonly AgentTool[]): DynamicToolSpec[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(z.object(t.inputShape)) as Record<string, unknown>;
    delete schema["$schema"];
    return { type: "function", name: t.name, description: t.description, inputSchema: schema };
  });
}

type ThreadRequest = Pick<AgentRunRequest, "systemPrompt" | "tools" | "workDir">;

export function buildThreadStartParams(
  request: ThreadRequest,
  model: string | null,
): Record<string, unknown> {
  return {
    ...(model !== null ? { model } : {}),
    cwd: request.workDir,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: request.systemPrompt,
    developerInstructions: null,
    environments: [],
    dynamicTools: toDynamicTools(request.tools),
    ephemeral: false,
  };
}

export function buildThreadResumeParams(
  request: ThreadRequest,
  threadId: string,
  model: string | null,
): Record<string, unknown> {
  return {
    threadId,
    ...(model !== null ? { model } : {}),
    cwd: request.workDir,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: request.systemPrompt,
    excludeTurns: true,
  };
}

export function buildTurnStartParams(threadId: string, prompt: string): Record<string, unknown> {
  return { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], environments: [] };
}

export function toDynamicToolResponse(r: AgentToolResult): { contentItems: unknown[]; success: boolean } {
  return {
    contentItems: r.content.map((c) =>
      c.type === "text"
        ? { type: "inputText", text: c.text }
        : { type: "inputImage", imageUrl: `data:${c.mimeType};base64,${c.data}` },
    ),
    success: r.isError !== true,
  };
}

interface TurnError {
  message?: string;
  codexErrorInfo?: unknown;
}

function errorKind(info: unknown): string {
  if (typeof info === "string") return info;
  if (typeof info === "object" && info !== null) return Object.keys(info)[0] ?? "other";
  return "other";
}

function httpStatus(info: unknown): number | null {
  if (typeof info !== "object" || info === null) return null;
  const inner = Object.values(info)[0] as { httpStatusCode?: unknown } | undefined;
  return typeof inner?.httpStatusCode === "number" ? inner.httpStatusCode : null;
}

/** A turn error reduced to its kind plus Codex's own short text (the limit message is shown to the user). */
export function classifyTurnError(error: TurnError | null | undefined): string {
  const kind = errorKind(error?.codexErrorInfo);
  const text = (error?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (kind === "usageLimitExceeded") return `Codex usage limit reached: ${text || "try again later"}`;
  if (kind === "rateLimitExceeded") return `Codex rate limit reached: ${text || "try again later"}`;
  if (kind === "unauthorized" || httpStatus(error?.codexErrorInfo) === 401)
    return "Codex is not signed in (unauthorized): sign in to Codex on this Mac (`codex login`)";
  return `Codex error (${kind})${text !== "" ? `: ${text}` : ""}`;
}

/** Kind of Codex stderr output (the text itself is never logged). */
export function classifyStderr(
  text: string,
): "config_rejected" | "not_signed_in" | "limit" | "network" | "other" {
  if (
    /unknown configuration field|invalid type|unknown variant|unknown feature|in -c\/--config override|failed to parse environment config/i.test(
      text,
    )
  )
    return "config_rejected";
  if (/not logged in|unauthori[sz]ed|\b401\b|login required/i.test(text)) return "not_signed_in";
  if (/usage limit|rate limit|quota/i.test(text)) return "limit";
  if (/connect|dns|timed? ?out|network/i.test(text)) return "network";
  return "other";
}

function earlyExitMessage(code: number | null, stderrKind: ReturnType<typeof classifyStderr>): string {
  switch (stderrKind) {
    case "config_rejected":
      return `Codex refused the helper's restriction settings (this Codex version is not supported; verified on ${VERIFIED_CODEX_VERSION})`;
    case "not_signed_in":
      return "Codex is not signed in: sign in to Codex on this Mac (`codex login`)";
    case "limit":
      return "Codex usage limit reached: try again later";
    default:
      return `Codex exited before the helper could start (exit code ${code ?? "none"}, ${stderrKind})`;
  }
}

// ---------------------------------------------------------------------------------------------
// Codex home and model catalog
// ---------------------------------------------------------------------------------------------

/**
 * The bridge's own `CODEX_HOME`: owner-only, an empty `config.toml`, an `environments.toml` without
 * the local environment ({@link ENVIRONMENTS_TOML}), and `auth.json` linked to the user's sign-in
 * (Codex rewrites that file in place on token refresh, so the link stays valid). The bridge creates
 * the link; it never opens the file.
 */
export async function prepareCodexHome(codexHome: string, userCodexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);
  await writeFile(join(codexHome, "config.toml"), "", { mode: 0o600 });
  await writeFile(join(codexHome, ENVIRONMENTS_FILE), ENVIRONMENTS_TOML, { mode: 0o600 });
  const link = join(codexHome, "auth.json");
  const target = join(userCodexHome, "auth.json");
  let current: string | null;
  try {
    current = await readlink(link);
  } catch {
    current = null;
  }
  if (current !== target) {
    await rm(link, { force: true });
    await symlink(target, link);
  }
}

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
}

/** Runs a short Codex command (no model call) and captures its output. */
export function runCodexCommand(
  command: string,
  args: string[],
  options: { cwd?: string | undefined; env: Record<string, string>; timeoutMs?: number | undefined },
): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: Captured): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
    } catch (error) {
      done({ code: null, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr: `${stderr}\ntimed out`, spawnError: null });
    }, options.timeoutMs ?? 30_000);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      if (stderr.length < STDERR_KEEP) stderr += d;
    });
    child.on("error", (error) => done({ code: null, stdout, stderr, spawnError: error }));
    child.on("close", (code) => done({ code, stdout, stderr, spawnError: null }));
  });
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

export interface CodexAgentRunnerOptions {
  /** `config.executables.codex` (`CODEX_BIN`). */
  codexBin: string;
  /** `config.onboarding.codexModel`; null uses the Codex CLI's default. */
  model: string | null;
  /** The bridge's own Codex home (under the data folder). */
  codexHome: string;
  /** Where the user's Codex sign-in lives (`$CODEX_HOME` of the bridge's environment, else `~/.codex`). */
  userCodexHome: string;
  maxTurns?: number | undefined;
  /** Environment the Codex process starts from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  logger?: Logger | undefined;
}

class RefusedError extends Error {}

export class CodexAgentRunner implements AgentRunner {
  readonly maxTurns: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly nodeDir = dirname(process.execPath);

  constructor(private readonly o: CodexAgentRunnerOptions) {
    this.maxTurns = o.maxTurns ?? DEFAULT_CODEX_MAX_TURNS;
    this.baseEnv = o.baseEnv ?? process.env;
  }

  /** Model (null: the CLI's default), turn limit, and Codex home in use (for logs and tests). */
  describe(): { model: string | null; maxTurns: number; codexHome: string } {
    return { model: this.o.model, maxTurns: this.maxTurns, codexHome: this.o.codexHome };
  }

  /** The launch of one run (exposed for tests). */
  launch(workDir: string): CodexLaunch {
    return buildCodexLaunch({
      codexBin: this.o.codexBin,
      codexHome: this.o.codexHome,
      catalogPath: join(this.o.codexHome, CATALOG_FILE),
      workDir,
      baseEnv: this.baseEnv,
      nodeDir: this.nodeDir,
    });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const fail = (message: string, resumeFailed = false): AgentRunResult => ({
      sessionId: request.resumeSessionId,
      outcome: request.signal.aborted ? "aborted" : "error",
      message,
      turns: 0,
      costUsd: null,
      resumeFailed,
    });
    if (request.signal.aborted) return fail("aborted");
    const launch = this.launch(request.workDir);
    try {
      await prepareCodexHome(this.o.codexHome, this.o.userCodexHome);
      const models = await this.writeCatalog(launch);
      if (this.o.model !== null && !models.includes(this.o.model))
        return fail(`the configured Codex model "${this.o.model}" is not in Codex's model list`);
    } catch (error) {
      return fail((error as Error).message);
    }
    return new CodexRun(request, launch, this.o, this.maxTurns).execute();
  }

  /** Writes the restricted catalog from Codex's own model list; returns the model ids. */
  private async writeCatalog(launch: CodexLaunch): Promise<string[]> {
    const r = await runCodexCommand(launch.command, ["debug", "models"], {
      cwd: launch.cwd,
      env: launch.env,
      timeoutMs: 60_000,
    });
    if (r.spawnError !== null) throw new Error(`Codex executable not found (CODEX_BIN=${launch.command})`);
    if (r.code !== 0) throw new Error(earlyExitMessage(r.code, classifyStderr(r.stderr)));
    let raw: unknown;
    try {
      raw = JSON.parse(r.stdout);
    } catch {
      throw new Error("the Codex model list could not be read");
    }
    const catalog = restrictModelCatalog(raw);
    await writeFile(join(this.o.codexHome, CATALOG_FILE), JSON.stringify(catalog), { mode: 0o600 });
    return catalog.models.map((m) => m["slug"] as string);
  }
}

/** One run: one `codex app-server` child, one thread, one turn. */
class CodexRun {
  private child: ChildProcessWithoutNullStreams | null = null;
  private peer: JsonRpcPeer | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private toolCalls = 0;
  private lastText: string | null = null;
  private refused: string | null = null;
  private maxTurnsHit = false;
  private stderr = "";
  private exited: { code: number | null } | null = null;
  private settle!: (r: { status: string; error: TurnError | null } | { exit: number | null }) => void;
  private readonly ended = new Promise<{ status: string; error: TurnError | null } | { exit: number | null }>(
    (r) => (this.settle = r),
  );
  private readonly tools: Map<string, AgentTool>;
  private markClosed!: () => void;
  /** Resolves when the child's process and pipes are gone. */
  private readonly childClosed = new Promise<void>((r) => (this.markClosed = r));

  constructor(
    private readonly request: AgentRunRequest,
    private readonly launch: CodexLaunch,
    private readonly o: CodexAgentRunnerOptions,
    private readonly maxTurns: number,
  ) {
    this.tools = new Map(request.tools.map((t) => [t.name, t]));
  }

  async execute(): Promise<AgentRunResult> {
    const req = this.request;
    const onAbort = (): void => this.stop();
    req.signal.addEventListener("abort", onAbort, { once: true });
    let resumeFailed = false;
    let outcome: AgentRunResult["outcome"] = "error";
    let message: string | null;
    try {
      this.spawnChild();
      const peer = this.peer as JsonRpcPeer;
      const version = (await this.withTimeout(
        peer.request("initialize", {
          clientInfo: { name: "browser-research-bridge", title: null, version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      )) as { userAgent?: string } | undefined;
      peer.notify("initialized");
      const ua = version?.userAgent ?? "";
      if (!ua.includes(`/${VERIFIED_CODEX_VERSION} `))
        req.onEvent({
          type: "warning",
          message: `Codex version differs from the verified ${VERIFIED_CODEX_VERSION}; the run guards still apply`,
        });

      let started: {
        thread?: { id?: string; environments?: unknown };
        model?: string;
        instructionSources?: unknown;
      };
      if (req.resumeSessionId !== null) {
        try {
          started = (await this.withTimeout(
            peer.request("thread/resume", buildThreadResumeParams(req, req.resumeSessionId, this.o.model)),
          )) as typeof started;
        } catch {
          resumeFailed = true;
          throw new Error("the earlier Codex session could not be resumed");
        }
      } else {
        started = (await this.withTimeout(
          peer.request("thread/start", buildThreadStartParams(req, this.o.model)),
        )) as typeof started;
      }
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string") throw new Error("Codex did not start a session");
      this.threadId = threadId;
      const envs = started.thread?.environments;
      if (envs !== undefined && !(Array.isArray(envs) && envs.length === 0)) {
        // No turn ever starts on such a thread. A resumed one falls back to a fresh session
        // (`thread/start` with `environments: []`, guarded the same way) instead of failing the job.
        if (req.resumeSessionId !== null) {
          resumeFailed = true;
          throw new RefusedError(
            "the resumed Codex session has an execution environment; refusing to resume it",
          );
        }
        throw new RefusedError("the Codex session has an execution environment; refusing to run");
      }
      const sources = started.instructionSources;
      if (Array.isArray(sources) && sources.length > 0)
        throw new RefusedError("the Codex session loaded instruction files; refusing to run");
      req.onEvent({
        type: "session",
        sessionId: threadId,
        model: started.model ?? this.o.model ?? "codex default",
        authSource: CODEX_AUTH_SOURCE,
        tools: req.tools.map((t) => t.name),
      });

      const turn = (await this.withTimeout(
        peer.request("turn/start", buildTurnStartParams(threadId, req.prompt)),
      )) as { turn?: { id?: string } } | undefined;
      this.turnId = turn?.turn?.id ?? this.turnId;

      const end = await this.ended;
      if (this.refused !== null) {
        message = this.refused;
      } else if (req.signal.aborted) {
        outcome = "aborted";
        message = "aborted";
      } else if (this.maxTurnsHit) {
        outcome = "max_turns";
        message = `maximum of ${this.maxTurns} turns reached`;
      } else if ("exit" in end) {
        message = `Codex exited during the run (exit code ${end.exit ?? "none"}, ${classifyStderr(this.stderr)})`;
      } else if (end.status === "completed") {
        outcome = "completed";
        message = this.lastText;
      } else if (end.status === "interrupted") {
        outcome = "aborted";
        message = "interrupted";
      } else {
        message = classifyTurnError(end.error);
      }
    } catch (error) {
      // The pipes can close a moment before the exit is reported; wait briefly for the exit and stderr.
      if (error instanceof RpcClosedError && this.child !== null)
        await Promise.race([this.childClosed, new Promise((r) => setTimeout(r, 2_000).unref())]);
      if (this.refused !== null) message = this.refused;
      else if (error instanceof RefusedError) message = error.message;
      else if (req.signal.aborted) {
        outcome = "aborted";
        message = "aborted";
      } else if (this.exited !== null && !resumeFailed)
        message = earlyExitMessage(this.exited.code, classifyStderr(this.stderr));
      else message = (error as Error).message;
      if (outcome !== "aborted") outcome = "error";
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      this.close();
    }
    this.o.logger?.info("codex helper run ended", {
      runId: req.runId,
      outcome,
      turns: this.toolCalls,
      stderrKind: this.stderr === "" ? "none" : classifyStderr(this.stderr),
    });
    return {
      sessionId: this.threadId ?? req.resumeSessionId,
      outcome,
      message,
      turns: this.toolCalls,
      costUsd: null,
      resumeFailed,
    };
  }

  private spawnChild(): void {
    const { command, args, cwd, env } = this.launch;
    const child = spawn(command, args, { cwd, env, stdio: "pipe" });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (this.stderr.length < STDERR_KEEP) this.stderr += d;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") this.stderr += `\nexecutable not found`;
      this.onExit(null);
      this.markClosed();
    });
    child.on("exit", (code) => this.onExit(code));
    child.on("close", (code) => {
      this.onExit(code);
      this.markClosed();
    });
    this.peer = new JsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onServerRequest(method, params),
      onGarbage: (length) => this.o.logger?.debug("codex wrote a non-JSON line", { length }),
    });
  }

  private onExit(code: number | null): void {
    if (this.exited !== null) return;
    this.exited = { code };
    this.peer?.close("Codex exited");
    this.settle({ exit: code });
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex did not answer in time")), START_TIMEOUT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private refuse(reason: string): void {
    if (this.refused === null) this.refused = reason;
    this.stop();
  }

  /** Interrupts the turn and ends the child. */
  private stop(): void {
    if (this.peer !== null && !this.peer.isClosed && this.threadId !== null && this.turnId !== null) {
      void this.peer
        .request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
        .catch(() => undefined);
    }
    this.close();
  }

  private close(): void {
    this.peer?.close("the helper run ended");
    const child = this.child;
    if (child !== null && this.exited === null) {
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.exited === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    }
    this.settle({ exit: null });
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (p["threadId"] !== undefined && this.threadId !== null && p["threadId"] !== this.threadId) return;
    switch (method) {
      case "item/started":
      case "item/completed": {
        const item = (p["item"] ?? {}) as { type?: unknown; text?: unknown };
        const type = typeof item.type === "string" ? item.type : "unknown";
        if (!ALLOWED_ITEM_TYPES.has(type)) {
          this.refuse(
            `the Codex session used a capability other than the bridge's tools (${type}); refusing to run`,
          );
          return;
        }
        if (method === "item/completed" && type === "agentMessage" && typeof item.text === "string") {
          this.lastText = item.text;
          if (item.text.trim() !== "") this.request.onEvent({ type: "text", text: item.text });
        }
        return;
      }
      case "turn/started": {
        const turn = p["turn"] as { id?: unknown } | undefined;
        if (typeof turn?.id === "string") this.turnId = turn.id;
        return;
      }
      case "turn/completed": {
        const turn = (p["turn"] ?? {}) as { status?: unknown; error?: TurnError | null };
        this.settle({
          status: typeof turn.status === "string" ? turn.status : "failed",
          error: turn.error ?? null,
        });
        return;
      }
      case "configWarning":
        this.refuse(
          "Codex reported a configuration problem with the helper's restriction settings; refusing to run",
        );
        return;
      default:
        return;
    }
  }

  private async onServerRequest(method: string, params: unknown): Promise<ServerRequestReply> {
    if (method !== "item/tool/call") {
      if (/approval|userinput|elicitation|permission/i.test(method))
        this.refuse(`Codex asked for ${method}, which the helper never grants; refusing to run`);
      return { error: { code: -32601, message: "not supported by the bridge" } };
    }
    const p = (params ?? {}) as {
      threadId?: unknown;
      tool?: unknown;
      namespace?: unknown;
      arguments?: unknown;
    };
    const tool = typeof p.tool === "string" ? this.tools.get(p.tool) : undefined;
    if (p.threadId !== this.threadId || tool === undefined || (p.namespace ?? null) !== null) {
      return {
        result: toDynamicToolResponse({ content: [{ type: "text", text: "unknown tool" }], isError: true }),
      };
    }
    this.toolCalls += 1;
    if (this.toolCalls > this.maxTurns) {
      this.maxTurnsHit = true;
      this.stop();
      return {
        result: toDynamicToolResponse({
          content: [{ type: "text", text: "turn limit reached" }],
          isError: true,
        }),
      };
    }
    const result = await tool.call(p.arguments ?? {});
    return { result: toDynamicToolResponse(result) };
  }
}
