/**
 * The launch configuration of the Codex runner: every restriction the Codex helper must keep is present in the
 * arguments, the thread parameters, the model catalog, and the environment it builds (no Codex
 * process). The real Codex behavior is recorded in `codex-runtime.AGENTS-evidence.md`.
 */
import { lstat, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import {
  ALLOWED_ITEM_TYPES,
  CATALOG_RESTRICTIONS,
  CODEX_CONFIG_OVERRIDES,
  CODEX_DISABLED_FEATURES,
  buildCodexLaunch,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  classifyStderr,
  classifyTurnError,
  codexEnv,
  prepareCodexHome,
  restrictModelCatalog,
  toDynamicToolResponse,
  toDynamicTools,
} from "./codex-runner.js";
import { classifyRoundTrip } from "./helper-runtime.js";
import type { AgentTool } from "./types.js";

const tool = (name: string): AgentTool => ({
  name,
  description: `${name} tool`,
  inputShape: { url: z.string(), n: z.number().int().optional() },
  call: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

const baseEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/me",
  BRIDGE_PASSPHRASE: "do-not-leak-this",
  BRIDGE_ADMIN_TOKEN: "admin-token",
  ANTHROPIC_API_KEY: "sk-ant-x",
  OPENAI_API_KEY: "sk-openai-x",
  CODEX_API_KEY: "codex-key",
  CODEX_HOME: "/Users/me/.codex",
  CLAUDECODE: "1",
  LANG: "en_US.UTF-8",
};

const launchInput = {
  codexBin: "/opt/bin/codex",
  codexHome: "/data/codex-home",
  catalogPath: "/data/codex-home/bridge-model-catalog.json",
  workDir: "/data/jobs/work/job-1",
  baseEnv,
  nodeDir: "/opt/node/bin",
};

function overrides(args: string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
}

describe("buildCodexLaunch", () => {
  const launch = buildCodexLaunch(launchInput);

  it("starts the app-server on stdio (no listener) with strict config, in the job's empty folder", () => {
    expect(launch.command).toBe("/opt/bin/codex");
    expect(launch.args.slice(0, 4)).toEqual(["app-server", "--listen", "stdio://", "--strict-config"]);
    expect(launch.args.join(" ")).not.toMatch(/ws:\/\/|unix:\/\/|--remote/);
    expect(launch.cwd).toBe("/data/jobs/work/job-1");
  });

  it("disables every feature that adds a tool or loads outside state", () => {
    const disabled = launch.args.flatMap((a, i) => (launch.args[i - 1] === "--disable" ? [a] : []));
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    for (const f of [
      "shell_tool",
      "unified_exec",
      "code_mode",
      "code_mode_host",
      "multi_agent",
      "multi_agent_v2",
      "apps",
      "plugins",
      "hooks",
      "browser_use",
      "computer_use",
      "image_generation",
      "view_image",
      "memories",
      "skill_search",
    ])
      expect(disabled).toContain(f);
  });

  it("turns off web search, user input, plans, MCP servers, project docs, skills, and approvals", () => {
    const c = overrides(launch.args);
    expect(c).toEqual([
      ...CODEX_CONFIG_OVERRIDES,
      'model_catalog_json="/data/codex-home/bridge-model-catalog.json"',
    ]);
    for (const expected of [
      'web_search="disabled"',
      "tools.web_search=false",
      "tools.experimental_request_user_input.enabled=false",
      "tools.update_plan.enabled=false",
      "mcp_servers={}",
      "project_doc_max_bytes=0",
      "project_root_markers=[]",
      "skills.bundled.enabled=false",
      "skills.include_instructions=false",
      'approval_policy="never"',
      'sandbox_mode="read-only"',
    ])
      expect(c).toContain(expected);
  });

  it("environment: no BRIDGE_*, no API keys, no parent session, no user Codex settings; the bridge's CODEX_HOME", () => {
    const env = launch.env;
    for (const k of Object.keys(env)) expect(k.startsWith("BRIDGE_")).toBe(false);
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["CODEX_API_KEY"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["CODEX_HOME"]).toBe("/data/codex-home");
    expect(env["PATH"]).toBe("/opt/node/bin:/usr/bin:/bin");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(JSON.stringify(env)).not.toContain("do-not-leak-this");
    expect(codexEnv({ PATH: "/opt/node/bin:/bin" }, "/h", "/opt/node/bin")["PATH"]).toBe(
      "/opt/node/bin:/bin",
    );
  });
});

describe("thread and turn parameters", () => {
  const request = { systemPrompt: "SYSTEM", tools: [tool("browser_open"), tool("finish")], workDir: "/w" };

  it("a new thread has no execution environment, only the bridge's tools, and the bridge's instructions", () => {
    const p = buildThreadStartParams(request, null);
    expect(p["environments"]).toEqual([]);
    expect((p["dynamicTools"] as { name: string }[]).map((t) => t.name)).toEqual(["browser_open", "finish"]);
    expect(p["baseInstructions"]).toBe("SYSTEM");
    expect(p["developerInstructions"]).toBeNull();
    expect(p["approvalPolicy"]).toBe("never");
    expect(p["sandbox"]).toBe("read-only");
    expect(p["cwd"]).toBe("/w");
    expect("model" in p).toBe(false);
    expect(buildThreadStartParams(request, "gpt-x")["model"]).toBe("gpt-x");
  });

  it("a resumed thread keeps the bridge's instructions; every turn disables environments again", () => {
    const r = buildThreadResumeParams(request, "thr-9", null);
    expect(r).toMatchObject({
      threadId: "thr-9",
      baseInstructions: "SYSTEM",
      approvalPolicy: "never",
      cwd: "/w",
    });
    expect(buildTurnStartParams("thr-9", "go")).toEqual({
      threadId: "thr-9",
      input: [{ type: "text", text: "go", text_elements: [] }],
      environments: [],
    });
  });

  it("tool input schemas are JSON Schema objects from the zod shapes", () => {
    const [spec] = toDynamicTools([tool("browser_open")]);
    expect(spec).toMatchObject({
      type: "function",
      name: "browser_open",
      description: "browser_open tool",
      inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    });
    expect(spec?.inputSchema).not.toHaveProperty("$schema");
  });

  it("tool results map text and images, and errors to success: false", () => {
    expect(
      toDynamicToolResponse({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: true,
      }),
    ).toEqual({
      contentItems: [
        { type: "inputText", text: "a" },
        { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
      ],
      success: false,
    });
  });

  it("only messages, reasoning, compaction, and bridge tool calls are allowed items", () => {
    expect([...ALLOWED_ITEM_TYPES].sort()).toEqual(
      ["agentMessage", "contextCompaction", "dynamicToolCall", "reasoning", "userMessage"].sort(),
    );
    for (const t of [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "webSearch",
      "collabAgentToolCall",
      "imageView",
    ])
      expect(ALLOWED_ITEM_TYPES.has(t)).toBe(false);
  });
});

describe("restrictModelCatalog", () => {
  it("rewrites every model so none brings code mode, shell, patches, sub-agents, extra tools, or search", () => {
    const out = restrictModelCatalog({
      models: [
        {
          slug: "a",
          tool_mode: "code_mode_only",
          shell_type: "unified_exec",
          multi_agent_version: "v2",
          priority: 1,
        },
        { slug: "b", experimental_supported_tools: ["clock"], supports_search_tool: true },
      ],
    });
    for (const m of out.models) expect(m).toMatchObject(CATALOG_RESTRICTIONS);
    expect(out.models[0]?.["priority"]).toBe(1);
  });

  it("refuses an empty or malformed list", () => {
    expect(() => restrictModelCatalog({ models: [] })).toThrow(/empty/);
    expect(() => restrictModelCatalog({})).toThrow();
    expect(() => restrictModelCatalog({ models: [{ name: "x" }] })).toThrow(/shape/);
  });
});

describe("error reduction", () => {
  const trip = (message: string) => ({
    result: { sessionId: null, outcome: "error" as const, message, turns: 0, costUsd: null },
    finished: null,
  });

  it("maps usage limits and sign-in failures to the helper check codes", () => {
    const limit = classifyTurnError({
      message: "You've hit your usage limit. Try again at 5pm.",
      codexErrorInfo: "usageLimitExceeded",
    });
    expect(limit).toContain("Codex usage limit reached: You've hit your usage limit");
    expect(classifyRoundTrip(trip(limit)).code).toBe("limit_reached");
    const auth = classifyTurnError({
      message: "x",
      codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } },
    });
    expect(classifyRoundTrip(trip(auth)).code).toBe("not_signed_in");
    expect(
      classifyRoundTrip(trip(classifyTurnError({ message: "", codexErrorInfo: "unauthorized" }))).code,
    ).toBe("not_signed_in");
    expect(classifyTurnError({ message: "boom", codexErrorInfo: "serverOverloaded" })).toBe(
      "Codex error (serverOverloaded): boom",
    );
  });

  it("classifies stderr by kind only", () => {
    expect(classifyStderr("Error: unknown configuration field `x` in -c/--config override")).toBe(
      "config_rejected",
    );
    // A key of the bridge's `environments.toml` that Codex no longer knows stops Codex at start.
    expect(
      classifyStderr(
        "Error: exec-server protocol error: failed to parse environment config `/h/environments.toml`: unknown field `include_local`",
      ),
    ).toBe("config_rejected");
    expect(classifyStderr("Not logged in")).toBe("not_signed_in");
    expect(classifyStderr("something else")).toBe("other");
  });
});

describe("prepareCodexHome", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it("creates an owner-only home with an empty config and a link to the user's sign-in (never copied)", async () => {
    const tmp = await makeTempDir("brb-codex-home-");
    cleanup = tmp.cleanup;
    const user = join(tmp.dir, "user-codex");
    await mkdir(user);
    await writeFile(join(user, "auth.json"), "{}");
    const home = join(tmp.dir, "data", "codex-home");
    await prepareCodexHome(home, user);
    await writeFile(join(home, "config.toml"), '[mcp_servers.x]\ncommand="x"\n');
    await prepareCodexHome(home, user);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe("");
    // No local execution environment exists in this home, so `thread/resume` cannot re-select one.
    expect(await readFile(join(home, "environments.toml"), "utf8")).toBe("include_local = false\n");
    expect((await stat(join(home, "environments.toml"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, "auth.json"))).toBe(join(user, "auth.json"));
  });
});
