/**
 * The Codex runner against a fake `codex` process (`codex-test-fixtures.ts`): the stdio channel,
 * its per-run checks and closure, the run guards, resume, error kinds, the probe, and the job
 * service driven end to end through the helper runtime registry.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { CodexAgentRunner } from "./codex-runner.js";
import { createCodexHelperRuntime, probeCodex } from "./codex-runtime.js";
import { installFakeCodex } from "./codex-test-fixtures.js";
import type { FakeCodex } from "./codex-test-fixtures.js";
import { HelperRuntimes, helperRoundTrip } from "./helper-runtime.js";
import { makeHarness } from "./test-fixtures.js";
import type { AgentEvent, AgentRunRequest, AgentTool, OnboardingJob } from "./types.js";

const CANARY = "canary-passphrase-for-codex-tests";

let tmp: { dir: string; cleanup: () => Promise<void> };
let fake: FakeCodex;
let workDir: string;
let userHome: string;

beforeEach(async () => {
  tmp = await makeTempDir("brb-codex-");
  fake = await installFakeCodex(tmp.dir);
  workDir = join(tmp.dir, "work", "job-1");
  await mkdir(workDir, { recursive: true });
  userHome = join(tmp.dir, "user-codex");
  await mkdir(userHome);
});
afterEach(async () => {
  await tmp.cleanup();
});

function runner(maxTurns = 10): CodexAgentRunner {
  return new CodexAgentRunner({
    codexBin: fake.bin,
    model: null,
    codexHome: join(tmp.dir, "data", "codex-home"),
    userCodexHome: userHome,
    maxTurns,
    baseEnv: { ...process.env, ...fake.env, BRIDGE_PASSPHRASE: CANARY, OPENAI_API_KEY: "sk-test" },
  });
}

function recorder(name: string, calls: unknown[]): AgentTool {
  return {
    name,
    description: name,
    inputShape: { summary: z.string().optional() },
    async call(args) {
      calls.push([name, args]);
      return { content: [{ type: "text", text: `${name} ok` }] };
    },
  };
}

function request(
  tools: AgentTool[],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    runId: "job-1#1",
    systemPrompt: "SYSTEM PROMPT",
    prompt: "go",
    tools,
    resumeSessionId: null,
    workDir,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    events,
    ...overrides,
  };
}

const kind = (k: string) => (r: Record<string, unknown>) => r["kind"] === k;

describe("CodexAgentRunner with a fake Codex process", () => {
  it("serves the tools over the child's stdio, in the job folder, with a stripped environment", async () => {
    const calls: unknown[] = [];
    await fake.setScenario({ runs: [[{ call: "finish", args: { summary: "done" } }, { text: "all done" }]] });
    const req = request([recorder("finish", calls)]);
    const result = await runner().run(req);
    expect(result).toMatchObject({ outcome: "completed", message: "all done", sessionId: "thr-1", turns: 1 });
    expect(calls).toEqual([["finish", { summary: "done" }]]);
    expect(req.events[0]).toMatchObject({ type: "session", sessionId: "thr-1", tools: ["finish"] });

    const records = await fake.records();
    const launch = records.find(kind("launch")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      catalog: { models: Record<string, unknown>[] };
    };
    expect(launch.argv.slice(0, 4)).toEqual(["app-server", "--listen", "stdio://", "--strict-config"]);
    expect(launch.cwd.endsWith(join("work", "job-1"))).toBe(true);
    expect(JSON.stringify(launch.env)).not.toContain(CANARY);
    expect(launch.env["OPENAI_API_KEY"]).toBeUndefined();
    expect(launch.env["CODEX_HOME"]).toBe(join(tmp.dir, "data", "codex-home"));
    expect(launch.catalog.models[0]).toMatchObject({
      slug: "fake-model",
      tool_mode: "direct",
      shell_type: "disabled",
      multi_agent_version: null,
    });
    const start = records.find((r) => r["kind"] === "request" && r["method"] === "thread/start") as {
      params: Record<string, unknown>;
    };
    expect(start.params).toMatchObject({ environments: [], baseInstructions: "SYSTEM PROMPT" });
    expect(records.some((r) => r["kind"] === "stdin-closed" || r["kind"] === "sigterm")).toBe(true);
  });

  it("the channel answers only this run's thread and tools", async () => {
    const calls: unknown[] = [];
    await fake.setScenario({
      runs: [
        [
          { call: "finish", threadId: "another-thread" },
          { call: "not_a_tool" },
          { call: "finish", namespace: "functions" },
          { call: "finish", args: { summary: "ok" } },
        ],
      ],
    });
    const result = await runner().run(request([recorder("finish", calls)]));
    expect(result.outcome).toBe("completed");
    expect(calls).toEqual([["finish", { summary: "ok" }]]);
    const replies = (await fake.records()).filter(kind("tool-result")) as {
      reply: { result: { success: boolean } };
    }[];
    expect(replies.map((r) => r.reply.result.success)).toEqual([false, false, false, true]);
  });

  it("refuses a run that uses any other capability (a command, a file change, an MCP call)", async () => {
    for (const item of [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "webSearch",
      "collabAgentToolCall",
    ]) {
      await fake.setScenario({ runs: [[{ item }, { call: "finish" }]] });
      const calls: unknown[] = [];
      const result = await runner().run(request([recorder("finish", calls)]));
      expect(result.outcome).toBe("error");
      expect(result.message).toContain(`(${item}); refusing to run`);
      expect(calls).toEqual([]);
      await import("node:fs/promises").then((fs) => fs.rm(fake.recordFile, { force: true }));
    }
  });

  it("refuses approval and user-input requests, a configuration warning, an environment, or instruction files", async () => {
    await fake.setScenario({
      runs: [[{ request: "item/commandExecution/requestApproval" }, { hang: true }]],
    });
    expect((await runner().run(request([]))).message).toContain("refusing to run");
    await fake.setScenario({ runs: [[], [{ configWarning: true }, { hang: true }]] });
    expect((await runner().run(request([]))).message).toContain("configuration problem");
    await fake.setScenario({ environments: [{ id: "local" }] });
    expect((await runner().run(request([]))).message).toContain("execution environment");
    await fake.setScenario({ instructionSources: ["/repo/AGENTS.md"] });
    expect((await runner().run(request([]))).message).toContain("instruction files");
  });

  it("resumes the earlier session on retry, and reports when it cannot", async () => {
    await fake.setScenario({ runs: [[{ call: "finish" }]] });
    const result = await runner().run(request([recorder("finish", [])], { resumeSessionId: "thr-7" }));
    expect(result).toMatchObject({ outcome: "completed", sessionId: "thr-7", resumeFailed: false });
    expect((await fake.records()).some((r) => r["method"] === "thread/resume")).toBe(true);
    await fake.setScenario({ resumeFails: true });
    const failed = await runner().run(request([], { resumeSessionId: "thr-7" }));
    expect(failed).toMatchObject({ outcome: "error", resumeFailed: true });
  });

  it("a resumed thread that reports an execution environment is never used: resumeFailed, no turn", async () => {
    // The shape Codex 0.160.0 answered `thread/resume` with before the bridge's home removed the
    // local environment (`environments.toml`): the default `local` environment re-selected.
    await fake.setScenario({
      resumeEnvironments: [{ environmentId: "local", cwd: workDir, runtimeWorkspaceRoots: [workDir] }],
      runs: [[{ call: "finish" }]],
    });
    const calls: unknown[] = [];
    const req = request([recorder("finish", calls)], { resumeSessionId: "thr-7" });
    const result = await runner().run(req);
    expect(result).toMatchObject({ outcome: "error", resumeFailed: true, turns: 0 });
    expect(result.message).toContain("execution environment");
    expect(calls).toEqual([]);
    expect(req.events.some((e) => e.type === "session")).toBe(false);
    const records = await fake.records();
    expect(records.some((r) => r["method"] === "turn/start")).toBe(false);
    // The run gives the fake the bridge's home, which removes the local environment.
    const launch = records.find(kind("launch")) as { env: Record<string, string> };
    expect(await readFile(join(launch.env["CODEX_HOME"] as string, "environments.toml"), "utf8")).toBe(
      "include_local = false\n",
    );
  });

  it("a fresh thread that reports an execution environment is refused, not retried", async () => {
    await fake.setScenario({ environments: [{ environmentId: "local" }] });
    const result = await runner().run(request([]));
    expect(result).toMatchObject({ outcome: "error", resumeFailed: false });
    expect(result.message).toBe("the Codex session has an execution environment; refusing to run");
  });

  it("reports the usage limit with Codex's message and a rejected configuration as unsupported", async () => {
    await fake.setScenario({
      runs: [[{ fail: "usageLimitExceeded", message: "You've hit your usage limit." }]],
    });
    const trip = await helperRoundTrip(runner(), { workDir, signal: new AbortController().signal });
    expect(trip.result.message).toBe("Codex usage limit reached: You've hit your usage limit.");
    await fake.setScenario({
      rejectWith: "Error: unknown configuration field `tools.update_plan` in -c/--config override",
    });
    const r = await runner().run(request([]));
    expect(r.outcome).toBe("error");
    expect(r.message).toContain("refused the helper's restriction settings");
  });

  it("aborts: interrupts the turn and ends the child; stops at the turn limit", async () => {
    await fake.setScenario({ runs: [[{ hang: true }]] });
    const ac = new AbortController();
    const pending = runner().run(request([], { signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    expect((await pending).outcome).toBe("aborted");
    await fake.setScenario({
      runs: [[], [{ call: "finish" }, { call: "finish" }, { call: "finish" }, { hang: true }]],
    });
    const limited = await runner(2).run(request([recorder("finish", [])]));
    expect(limited.outcome).toBe("max_turns");
  });

  it("the probe reads installed and signed-in state from exit codes", async () => {
    const env = { ...process.env, ...fake.env };
    expect(await probeCodex({ codexBin: fake.bin, userCodexHome: userHome, baseEnv: env })).toEqual({
      installed: true,
      signedIn: true,
    });
    await fake.setScenario({ signedOut: true });
    expect(await probeCodex({ codexBin: fake.bin, userCodexHome: userHome, baseEnv: env })).toEqual({
      installed: true,
      signedIn: false,
    });
    expect(
      await probeCodex({ codexBin: join(tmp.dir, "missing-codex"), userCodexHome: userHome, baseEnv: env }),
    ).toEqual({ installed: false, signedIn: null });
  });
});

describe("the job service on the Codex runtime (fake process)", () => {
  it("adds a site through the registry: blocked → Retry resumes the same Codex session → failure", async () => {
    const h = await makeHarness();
    try {
      await fake.setScenario({
        runs: [
          [
            {
              call: "report_blocked",
              args: {
                reason: "login wall",
                requestedAction: "Log in to demo.example.com in Aside, then click Retry",
              },
            },
          ],
          [{ call: "report_failure", args: { reason: "the site has no search" } }],
        ],
      });
      const codex = runner();
      const runtimes = new HelperRuntimes({
        configured: "codex",
        runtimes: [
          createCodexHelperRuntime({
            runner: codex,
            codexBin: fake.bin,
            userCodexHome: userHome,
            baseEnv: { ...process.env, ...fake.env },
          }),
        ],
      });
      expect((await runtimes.status()).wouldUse).toBe("codex");
      const svc = h.makeService({ runtimes });
      try {
        await svc.add({ input: "demo.example.com" });
        await svc.start();
        await svc.whenIdle();
        const paused = svc.get("demo-example") as OnboardingJob;
        expect(paused).toMatchObject({ state: "awaiting_user", runtime: "codex", sessionId: "thr-1" });
        expect(paused.requestedAction).toBe("Log in to demo.example.com in Aside, then click Retry");
        await svc.retry("demo-example");
        await svc.whenIdle();
        const failed = svc.get("demo-example") as OnboardingJob;
        expect(failed).toMatchObject({ state: "failed", runtime: "codex" });
        expect(failed.reason).toContain("the site has no search");
        const resumed = (await fake.records()).find((r) => r["method"] === "thread/resume") as {
          params: { threadId: string };
        };
        expect(resumed.params.threadId).toBe("thr-1");
      } finally {
        await svc.stop();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("Retry whose resumed thread reports an environment continues in a fresh session, not a failed job", async () => {
    const h = await makeHarness();
    try {
      await fake.setScenario({
        resumeEnvironments: [{ environmentId: "local", cwd: "/x", runtimeWorkspaceRoots: ["/x"] }],
        runs: [
          [{ call: "report_blocked", args: { reason: "login wall", requestedAction: "Log in, then click Retry" } }],
          [],
          [{ call: "report_failure", args: { reason: "the site has no search" } }],
        ],
      });
      const runtimes = new HelperRuntimes({
        configured: "codex",
        runtimes: [
          createCodexHelperRuntime({
            runner: runner(),
            codexBin: fake.bin,
            userCodexHome: userHome,
            baseEnv: { ...process.env, ...fake.env },
          }),
        ],
      });
      const svc = h.makeService({ runtimes });
      try {
        await svc.add({ input: "demo.example.com" });
        await svc.start();
        await svc.whenIdle();
        expect(svc.get("demo-example")).toMatchObject({ state: "awaiting_user", sessionId: "thr-1" });
        await svc.retry("demo-example");
        await svc.whenIdle();
        const job = svc.get("demo-example") as OnboardingJob;
        // The fresh session (third launch) ran the helper's turn; the job ended on the helper's report.
        expect(job).toMatchObject({ state: "failed", runtime: "codex", sessionId: "thr-3" });
        expect(job.reason).toContain("the site has no search");
        const methods = (await fake.records()).filter(kind("request")).map((r) => r["method"]);
        expect(methods.filter((m) => m === "thread/resume")).toHaveLength(1);
        expect(methods.filter((m) => m === "thread/start")).toHaveLength(2);
        expect(methods.filter((m) => m === "turn/start")).toHaveLength(2);
      } finally {
        await svc.stop();
      }
    } finally {
      await h.cleanup();
    }
  });
});
