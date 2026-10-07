/** Helper runtime registry: selection (auto / claude / codex, retry rule), `GET helper` and `POST helper/check` shapes and codes. */
import { describe, expect, it } from "vitest";
import { createClaudeHelperRuntime } from "./claude-runtime.js";
import { HelperRuntimes, classifyRoundTrip, helperRoundTrip } from "./helper-runtime.js";
import type { HelperCheckCode, HelperRuntime, RuntimeProbe } from "./helper-runtime.js";
import { ScriptedRunner } from "./test-fixtures.js";
import type { AgentRunResult, HelperRuntimeId } from "./types.js";

const AT = new Date("2026-10-07T01:02:03.000Z");
const checkInput = { workDir: "/nonexistent/helper-check", signal: new AbortController().signal };

function fakeRuntime(
  id: HelperRuntimeId,
  probe: RuntimeProbe,
  check: { code: HelperCheckCode; message: string | null } = { code: "ok", message: "done" },
): HelperRuntime & { checks: number } {
  const r = {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    signInHint: `sign in to ${id}`,
    runner: new ScriptedRunner(),
    checks: 0,
    async probe() {
      return probe;
    },
    async check() {
      r.checks += 1;
      return check;
    },
  };
  return r;
}

const up: RuntimeProbe = { installed: true, signedIn: true };
const unknown: RuntimeProbe = { installed: true, signedIn: null };
const signedOut: RuntimeProbe = { installed: true, signedIn: false };
const missing: RuntimeProbe = { installed: false, signedIn: null };

function registry(configured: "auto" | "claude" | "codex", ...runtimes: HelperRuntime[]): HelperRuntimes {
  return new HelperRuntimes({ configured, runtimes, now: () => AT });
}

async function selected(r: HelperRuntimes, recorded: HelperRuntimeId | null = null): Promise<string> {
  const s = await r.select(recorded);
  return s.ok ? s.runtime.id : `none:${s.code}`;
}

describe("HelperRuntimes selection", () => {
  it("auto prefers Claude, falls back to Codex, and counts an unknown sign-in as available", async () => {
    expect(await selected(registry("auto", fakeRuntime("claude", up), fakeRuntime("codex", up)))).toBe("claude");
    expect(await selected(registry("auto", fakeRuntime("claude", unknown), fakeRuntime("codex", up)))).toBe(
      "claude",
    );
    expect(await selected(registry("auto", fakeRuntime("claude", signedOut), fakeRuntime("codex", up)))).toBe(
      "codex",
    );
    expect(await selected(registry("auto", fakeRuntime("claude", missing), fakeRuntime("codex", unknown)))).toBe(
      "codex",
    );
  });

  it("claude and codex force one runtime", async () => {
    expect(await selected(registry("codex", fakeRuntime("claude", up), fakeRuntime("codex", up)))).toBe("codex");
    expect(await selected(registry("claude", fakeRuntime("claude", signedOut), fakeRuntime("codex", up)))).toBe(
      "none:not_signed_in",
    );
    // A build without Codex: forcing it leaves nothing to run on.
    const onlyClaude = registry("codex", fakeRuntime("claude", up));
    const s = await onlyClaude.select(null);
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.code).toBe("not_installed");
      expect(s.message).toContain("not supported by this build");
    }
  });

  it("a retry keeps the recorded runtime while it is available, else uses the configured one", async () => {
    const both = registry("claude", fakeRuntime("claude", up), fakeRuntime("codex", up));
    expect(await selected(both, "codex")).toBe("codex");
    const codexGone = registry("auto", fakeRuntime("claude", up), fakeRuntime("codex", signedOut));
    expect(await selected(codexGone, "codex")).toBe("claude");
    const notShipped = registry("auto", fakeRuntime("claude", up));
    expect(await selected(notShipped, "codex")).toBe("claude");
  });

  it("names the sign-in needed when nothing is available", async () => {
    const s = await registry("auto", fakeRuntime("claude", signedOut), fakeRuntime("codex", missing)).select();
    expect(s).toEqual({
      ok: false,
      code: "not_signed_in",
      message: "no helper is available: Claude is not signed in (sign in to claude); Codex is not installed",
    });
  });

  it("a probe that throws reports the runtime as not installed", async () => {
    const broken: HelperRuntime = {
      ...fakeRuntime("claude", up),
      async probe() {
        throw new Error("boom");
      },
    };
    expect(await registry("auto", broken).probeAll()).toEqual({
      claude: { installed: false, signedIn: null },
      codex: null,
    });
  });
});

describe("HelperRuntimes status and check", () => {
  it("GET helper: supported, per-runtime probe, codex null when not shipped, wouldUse, lastCheck passed through", async () => {
    const claude = fakeRuntime("claude", unknown);
    const r = registry("auto", claude);
    expect(await r.status()).toEqual({
      configured: "auto",
      supported: ["claude"],
      runtimes: { claude: { installed: true, signedIn: null }, codex: null },
      wouldUse: "claude",
      lastCheck: null,
    });
    const last = { at: AT.toISOString(), runtime: "claude" as const, ok: true, code: "ok" as const, message: "done" };
    expect((await r.status(last)).lastCheck).toEqual(last);
    expect(claude.checks).toBe(0);
    expect((await registry("codex", claude).status()).wouldUse).toBeNull();
    expect((await registry("auto", fakeRuntime("claude", signedOut)).status()).wouldUse).toBeNull();
  });

  it("POST helper/check: one round trip on wouldUse, with its code", async () => {
    const claude = fakeRuntime("claude", up, { code: "limit_reached", message: "session limit · resets 11pm" });
    const codex = fakeRuntime("codex", up);
    expect(await registry("auto", claude, codex).check(checkInput)).toEqual({
      at: AT.toISOString(),
      runtime: "claude",
      ok: false,
      code: "limit_reached",
      message: "session limit · resets 11pm",
    });
    expect([claude.checks, codex.checks]).toEqual([1, 0]);
    expect(await registry("codex", claude, codex).check(checkInput)).toMatchObject({
      runtime: "codex",
      ok: true,
      code: "ok",
    });
  });

  it("POST helper/check without an available runtime makes no call and returns runtime null", async () => {
    const claude = fakeRuntime("claude", missing);
    expect(await registry("auto", claude).check(checkInput)).toEqual({
      at: AT.toISOString(),
      runtime: null,
      ok: false,
      code: "not_installed",
      message: "no helper is available: Claude is not installed; the codex helper is not supported by this build",
    });
    expect((await registry("auto", fakeRuntime("claude", signedOut)).check(checkInput)).code).toBe(
      "not_signed_in",
    );
    expect(claude.checks).toBe(0);
  });

  it("a check that throws is failed", async () => {
    const claude: HelperRuntime = {
      ...fakeRuntime("claude", up),
      async check() {
        throw new Error("spawn failed");
      },
    };
    expect(await registry("auto", claude).check(checkInput)).toMatchObject({
      runtime: "claude",
      ok: false,
      code: "failed",
      message: "spawn failed",
    });
  });
});

describe("round trip", () => {
  const result = (r: Partial<AgentRunResult>): AgentRunResult => ({
    sessionId: "s",
    outcome: "completed",
    message: "done",
    turns: 2,
    costUsd: null,
    ...r,
  });

  it("classifies a round trip into the five codes", () => {
    expect(classifyRoundTrip({ result: result({}), finished: "sdk check ok" })).toEqual({
      code: "ok",
      message: "done",
    });
    expect(classifyRoundTrip({ result: result({}), finished: null }).code).toBe("failed");
    const err = (message: string) =>
      classifyRoundTrip({ result: result({ outcome: "error", message }), finished: null }).code;
    expect(err("Claude AI usage limit reached|1760000000")).toBe("limit_reached");
    expect(err("session limit · resets 11:40pm Asia/Seoul")).toBe("limit_reached");
    expect(err("Invalid API key · Please run /login")).toBe("not_signed_in");
    expect(err("Not logged in")).toBe("not_signed_in");
    expect(err("spawn claude ENOENT")).toBe("not_installed");
    expect(err("socket hang up")).toBe("failed");
  });

  it("runs the finish-tool round trip through the runner and the Claude runtime's check", async () => {
    const runner = new ScriptedRunner([
      async (ctx) => {
        await ctx.call("finish", { summary: "sdk check ok" });
      },
      async () => ({ outcome: "error", message: "Not logged in · Please run /login" }),
    ]);
    const trip = await helperRoundTrip(runner, checkInput);
    expect(trip.finished).toBe("sdk check ok");
    expect(runner.requests[0]?.tools.map((t) => t.name)).toEqual(["finish"]);
    expect(runner.requests[0]?.workDir).toBe(checkInput.workDir);

    const claude = createClaudeHelperRuntime({
      runner: new ScriptedRunner(),
      checkRunner: runner,
      apiKey: null,
    });
    expect(await claude.check(checkInput)).toEqual({
      code: "not_signed_in",
      message: "Not logged in · Please run /login",
    });
  });

  it("the Claude probe reports the SDK installed; signed in only known with an API key", async () => {
    const runner = new ScriptedRunner();
    expect(await createClaudeHelperRuntime({ runner, apiKey: null }).probe()).toEqual({
      installed: true,
      signedIn: null,
    });
    expect(await createClaudeHelperRuntime({ runner, apiKey: "sk-ant-test" }).probe()).toEqual({
      installed: true,
      signedIn: true,
    });
  });
});
