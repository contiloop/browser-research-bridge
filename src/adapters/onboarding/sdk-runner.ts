/**
 * {@link AgentRunner} over the Claude Agent SDK: model and effort from
 * `config.onboarding` (default `claude-opus-5-5`, high), authentication through `ANTHROPIC_API_KEY`
 * when set, otherwise the local Claude Code login (no key is invented).
 *
 * The agent's capabilities are exactly the job's tools, served by an in-process MCP server:
 * - `tools: []` removes every built-in tool (no Bash, no file tools, no web tools, no subagents);
 *   `disallowedTools` names them again, `permissionMode: "dontAsk"` denies anything not pre-approved,
 *   a PreToolUse hook denies anything outside the bridge server, and the run is aborted if the
 *   session still reports a built-in tool;
 * - `settingSources: []`, `strictMcpConfig`, `skills: []`, `plugins: []`: no user/project settings,
 *   CLAUDE.md, hooks, plugins, skills, or other MCP servers leak into the session;
 * - the working directory is an empty per-job folder; the bridge's own secrets are not passed in the
 *   environment.
 * Sessions are persisted by the SDK (local `~/.claude/projects/`) so Retry can `resume` them.
 */
import type {
  EffortLevel,
  HookCallback,
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../../ports/logger.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentToolResult } from "./types.js";

export const MCP_SERVER_NAME = "bridge";
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const DEFAULT_MAX_TURNS = 80;
export const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Built-in Claude Code tools named explicitly in `disallowedTools` (on top of `tools: []`). */
export const BUILTIN_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "Skill",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

export interface ClaudeAgentRunnerOptions {
  model?: string | undefined;
  /** `config.onboarding.effort`; unknown values fall back to `high`. */
  effort?: string | undefined;
  maxTurns?: number | undefined;
  /** `config.secrets.anthropicApiKey`; null → the local Claude Code login. */
  apiKey: string | null;
  /** Environment the agent process starts from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Claude Code executable (default: the one bundled with the SDK). */
  pathToClaudeCodeExecutable?: string | undefined;
  logger?: Logger | undefined;
}

export function effortLevel(value: string | undefined): EffortLevel {
  return EFFORTS.includes(value as EffortLevel) ? (value as EffortLevel) : "high";
}

/**
 * Variables a parent Claude Code session sets for its own children (when the bridge itself was
 * started from Claude Code). They must not make the agent process join or mimic that session.
 */
const PARENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
]);

/**
 * The environment every helper process (Claude or Codex) starts from: the bridge's environment
 * without its own settings and secrets (`BRIDGE_*`), without `ANTHROPIC_API_KEY`, and without a
 * parent Claude Code session's variables.
 */
export function helperBaseEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith("BRIDGE_") || k === "ANTHROPIC_API_KEY" || PARENT_SESSION_VARS.has(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Environment of the agent process: the bridge's environment without its own settings and secrets
 * (`BRIDGE_*`) and without a parent Claude Code session's variables, with `ANTHROPIC_API_KEY` only
 * when configured (else the local Claude Code login is used).
 */
export function agentEnv(base: NodeJS.ProcessEnv, apiKey: string | null): Record<string, string> {
  const env = helperBaseEnv(base);
  if (apiKey !== null && apiKey.trim() !== "") env["ANTHROPIC_API_KEY"] = apiKey;
  env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "browser-research-bridge/onboarding";
  return env;
}

const isBridgeTool = (name: string): boolean => name.startsWith(TOOL_PREFIX);

export const denyNonBridgeTools: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || isBridgeTool(input.tool_name)) return { continue: true };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "only the bridge's onboarding tools are available",
    },
  };
};

export interface SdkOptionInput {
  model: string;
  effort: EffortLevel;
  maxTurns: number;
  apiKey: string | null;
  baseEnv: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable?: string | undefined;
  stderr?: ((data: string) => void) | undefined;
}

/** The SDK options of one run (pure; covered by a test without network). */
export function buildSdkOptions(
  input: SdkOptionInput,
  request: Pick<AgentRunRequest, "systemPrompt" | "tools" | "resumeSessionId" | "workDir">,
  server: McpSdkServerConfigWithInstance,
  abortController: AbortController,
): Options {
  const options: Options = {
    model: input.model,
    effort: input.effort,
    thinking: { type: "adaptive" },
    maxTurns: input.maxTurns,
    systemPrompt: request.systemPrompt,
    tools: [],
    mcpServers: { [MCP_SERVER_NAME]: server },
    allowedTools: request.tools.map((t) => `${TOOL_PREFIX}${t.name}`),
    disallowedTools: [...BUILTIN_TOOLS],
    permissionMode: "dontAsk",
    hooks: { PreToolUse: [{ hooks: [denyNonBridgeTools] }] },
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    plugins: [],
    cwd: request.workDir,
    persistSession: true,
    abortController,
    env: agentEnv(input.baseEnv, input.apiKey),
  };
  if (request.resumeSessionId !== null) options.resume = request.resumeSessionId;
  if (input.pathToClaudeCodeExecutable !== undefined)
    options.pathToClaudeCodeExecutable = input.pathToClaudeCodeExecutable;
  if (input.stderr !== undefined) options.stderr = input.stderr;
  return options;
}

function toCallToolResult(r: AgentToolResult) {
  return {
    content: r.content.map((c) =>
      c.type === "text"
        ? { type: "text" as const, text: c.text }
        : { type: "image" as const, data: c.data, mimeType: c.mimeType },
    ),
    ...(r.isError === true ? { isError: true } : {}),
  };
}

export class ClaudeAgentRunner implements AgentRunner {
  private readonly input: SdkOptionInput;
  private readonly logger: Logger | undefined;

  constructor(options: ClaudeAgentRunnerOptions) {
    this.logger = options.logger;
    this.input = {
      model: options.model ?? DEFAULT_MODEL,
      effort: effortLevel(options.effort),
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      apiKey: options.apiKey,
      baseEnv: options.baseEnv ?? process.env,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      stderr: (data) => this.logger?.debug("agent process stderr", { text: data.slice(0, 300) }),
    };
    if (options.effort !== undefined && effortLevel(options.effort) !== options.effort) {
      this.logger?.warn("unknown onboarding effort; using high", { effort: options.effort });
    }
  }

  /** Model, effort, turns, and auth mode in use (for logs and the dashboard). */
  describe(): {
    model: string;
    effort: EffortLevel;
    maxTurns: number;
    auth: "api_key" | "claude_code_login";
  } {
    return {
      model: this.input.model,
      effort: this.input.effort,
      maxTurns: this.input.maxTurns,
      auth: this.input.apiKey !== null ? "api_key" : "claude_code_login",
    };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const server = sdk.createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: "1.0.0",
      alwaysLoad: true,
      tools: request.tools.map((t) =>
        sdk.tool(t.name, t.description, t.inputShape, async (args) => toCallToolResult(await t.call(args))),
      ),
    });
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    if (request.signal.aborted) abortController.abort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    const options = buildSdkOptions(this.input, request, server, abortController);
    let sessionId: string | null = null;
    let turns = 0;
    let costUsd: number | null = null;
    let outcome: AgentRunResult["outcome"] = "error";
    let message: string | null = "the agent produced no result";
    let assistantMessages = 0;
    let refused: string | null = null;

    const q = sdk.query({ prompt: request.prompt, options });
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
          const unexpected = msg.tools.filter((name) => !isBridgeTool(name));
          request.onEvent({
            type: "session",
            sessionId: msg.session_id,
            model: msg.model,
            authSource: msg.apiKeySource,
            tools: msg.tools,
          });
          const dangerous = unexpected.filter((n) => (BUILTIN_TOOLS as readonly string[]).includes(n));
          if (dangerous.length > 0) {
            refused = `the agent session exposes built-in tools (${dangerous.join(", ")}); refusing to run`;
            abortController.abort();
            break;
          }
          if (unexpected.length > 0) {
            request.onEvent({
              type: "warning",
              message: `agent session also lists: ${unexpected.join(", ")}`,
            });
          }
        } else if (msg.type === "assistant") {
          if (msg.parent_tool_use_id !== null) continue;
          assistantMessages += 1;
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text.trim() !== "")
              request.onEvent({ type: "text", text: block.text });
          }
          if (msg.error !== undefined)
            request.onEvent({ type: "warning", message: `agent API error: ${String(msg.error)}` });
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          turns = msg.num_turns;
          costUsd = msg.total_cost_usd;
          if (msg.subtype === "success") {
            outcome = msg.is_error ? "error" : "completed";
            message = msg.result;
          } else if (msg.subtype === "error_max_turns") {
            outcome = "max_turns";
            message = `maximum of ${this.input.maxTurns} turns reached`;
          } else {
            outcome = "error";
            message = msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype;
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted && refused === null) {
        outcome = "aborted";
        message = "aborted";
      } else {
        outcome = "error";
        message = (error as Error).message;
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // already closed
      }
    }
    if (refused !== null) {
      outcome = "error";
      message = refused;
    } else if (request.signal.aborted) {
      outcome = "aborted";
    }
    const resumeFailed = request.resumeSessionId !== null && assistantMessages === 0 && outcome === "error";
    return { sessionId, outcome, message, turns, costUsd, resumeFailed };
  }
}
