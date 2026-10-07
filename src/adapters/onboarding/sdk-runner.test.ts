/**
 * Option construction of the Claude Agent SDK runner (no network, no agent process). The real
 * round-trip (auth + tool call) is the smoke check `npm run site:onboard -- --sdk-check`.
 */
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  ClaudeAgentRunner,
  agentEnv,
  buildSdkOptions,
  denyNonBridgeTools,
  effortLevel,
} from "./sdk-runner.js";
import type { AgentTool } from "./types.js";

const tool = (name: string): AgentTool => ({
  name,
  description: name,
  inputShape: { x: z.string().optional() },
  call: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

const server = createSdkMcpServer({ name: "bridge", version: "1.0.0", tools: [] });

describe("buildSdkOptions", () => {
  const base = {
    model: "claude-opus-5-5",
    effort: effortLevel("high"),
    maxTurns: 80,
    apiKey: null,
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      BRIDGE_PASSPHRASE: "do-not-leak-this",
      ANTHROPIC_API_KEY: "",
    },
  };
  const request = {
    systemPrompt: "SYSTEM",
    tools: [tool("browser_open"), tool("finish")],
    resumeSessionId: null,
    workDir: "/tmp/job-1",
  };

  it("exposes only the bridge tools: no built-ins, no user settings, no other MCP servers", () => {
    const o = buildSdkOptions(base, request, server, new AbortController());
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(["mcp__bridge__browser_open", "mcp__bridge__finish"]);
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Read", "Write", "Edit", "WebFetch", "Task"]),
    );
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.skills).toEqual([]);
    expect(o.plugins).toEqual([]);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["bridge"]);
    expect(o.cwd).toBe("/tmp/job-1");
    expect(o.systemPrompt).toBe("SYSTEM");
    expect(o.hooks?.PreToolUse).toHaveLength(1);
  });

  it("uses the configured model, effort, and turn limit; resumes a session when asked", () => {
    const o = buildSdkOptions(
      { ...base, effort: effortLevel("max"), maxTurns: 12 },
      { ...request, resumeSessionId: "abc" },
      server,
      new AbortController(),
    );
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.effort).toBe("max");
    expect(o.maxTurns).toBe(12);
    expect(o.resume).toBe("abc");
    expect(o.persistSession).toBe(true);
    expect("resume" in buildSdkOptions(base, request, server, new AbortController())).toBe(false);
  });

  it("auth: no key → the Claude Code login (no key invented); a configured key is passed through", () => {
    const login = buildSdkOptions(base, request, server, new AbortController()).env ?? {};
    expect("ANTHROPIC_API_KEY" in login).toBe(false);
    expect(login["BRIDGE_PASSPHRASE"]).toBeUndefined();
    expect(login["PATH"]).toBe("/usr/bin");
    expect(login["HOME"]).toBe("/Users/me");
    const keyed =
      buildSdkOptions({ ...base, apiKey: "sk-ant-test" }, request, server, new AbortController()).env ?? {};
    expect(keyed["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
  });

  it("agentEnv drops the bridge's settings and secrets", () => {
    const env = agentEnv(
      {
        BRIDGE_PASSPHRASE: "p",
        BRIDGE_DATA_DIR: "/d",
        CLAUDECODE: "1",
        CLAUDE_EFFORT: "low",
        CLAUDE_CODE_SESSION_ID: "x",
        LANG: "en",
      },
      null,
    );
    expect(env).toEqual({ LANG: "en", CLAUDE_AGENT_SDK_CLIENT_APP: "browser-research-bridge/onboarding" });
  });

  it("unknown effort values fall back to high", () => {
    expect(effortLevel("extreme")).toBe("high");
    expect(effortLevel("xhigh")).toBe("xhigh");
    expect(new ClaudeAgentRunner({ apiKey: null, effort: "bogus" }).describe()).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      maxTurns: 80,
      auth: "claude_code_login",
    });
  });
});

describe("tool gatekeepers", () => {
  const signal = new AbortController().signal;

  it("the PreToolUse hook denies everything outside the bridge server", async () => {
    const input = (tool_name: string) =>
      ({
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: {},
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "",
        cwd: "",
      }) as never;
    expect(await denyNonBridgeTools(input("mcp__bridge__finish"), "t", { signal })).toEqual({
      continue: true,
    });
    for (const name of [...BUILTIN_TOOLS, "mcp__other__x"]) {
      const out = (await denyNonBridgeTools(input(name), "t", { signal })) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });
});
