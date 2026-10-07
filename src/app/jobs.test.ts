/** The onboarding job service inside the bridge: wired into BridgeServices, started and stopped with it. */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { fakeBrowser, makeTempDir } from "../../test/support/site-fixtures.js";
import { ScriptedRunner, untilAborted } from "../adapters/onboarding/test-fixtures.js";
import { createApp } from "./app.js";
import type { BridgeApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  SHIPPED_HELPER_RUNTIMES,
  bridgeCodexHome,
  createHelperRuntimes,
  onboardingMaxTurns,
} from "./jobs.js";
import { CodexAgentRunner } from "../adapters/onboarding/index.js";
import { systemClock } from "../ports/clock.js";

let bridge: BridgeApp | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await bridge?.stop();
  await cleanup?.();
  bridge = null;
  cleanup = null;
});

describe("onboarding jobs in the bridge", () => {
  it("runs jobs while the bridge runs, persists them under data/jobs, and stops them with it", async () => {
    const tmp = await makeTempDir("brb-jobs-");
    cleanup = tmp.cleanup;
    await mkdir(join(tmp.dir, "sites"), { recursive: true });
    const config = loadConfig({
      env: { BRIDGE_PASSPHRASE: "a passphrase for tests", BRIDGE_DATA_DIR: join(tmp.dir, "data") },
      rootDir: tmp.dir,
    });
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const runner = new ScriptedRunner([
      async (ctx) => {
        started();
        return untilAborted(ctx.req.signal);
      },
    ]);
    bridge = createApp({
      config,
      helpers: stubHelpers,
      logger: new MemoryLogger(),
      browser: fakeBrowser(),
      repoRoot: process.cwd(),
      onboarding: { runner },
    });
    const { jobs, registry } = bridge.services;
    await bridge.start({ publicPort: 0, probeBrowser: false });
    const job = await jobs.add({ input: "https://news.example.org", note: "front page only" });
    await running;
    expect(jobs.get("news-example")?.state).toBe("running");
    expect(registry.get("news-example")?.status).toBe("onboarding");
    await bridge.stop();
    bridge = null;
    expect(jobs.getJob(job.id)?.state).toBe("failed");
    expect(registry.get("news-example")?.status).toBe("failed");
    expect((await readdir(join(tmp.dir, "data", "jobs"))).sort()).toEqual(
      [`${job.id}.json`, `${job.id}.log.jsonl`, "work"].sort(),
    );
  });

  it("reads the turn limit from BRIDGE_ONBOARDING_MAX_TURNS", () => {
    expect(onboardingMaxTurns({})).toBe(80);
    expect(onboardingMaxTurns({ BRIDGE_ONBOARDING_MAX_TURNS: "120" })).toBe(120);
    expect(onboardingMaxTurns({ BRIDGE_ONBOARDING_MAX_TURNS: "-3" })).toBe(80);
  });

  it("builds the helper runtime registry from onboarding.runtime with Claude and Codex", async () => {
    const tmp = await makeTempDir("brb-jobs-");
    cleanup = tmp.cleanup;
    const { writeFile } = await import("node:fs/promises");
    await mkdir(join(tmp.dir, "config"), { recursive: true });
    const load = async (runtime: string) => {
      await writeFile(join(tmp.dir, "config", "bridge.json"), JSON.stringify({ onboarding: { runtime } }));
      return loadConfig({ env: { BRIDGE_PASSPHRASE: "a passphrase for tests" }, rootDir: tmp.dir });
    };
    const deps = async (runtime: string) => ({
      config: await load(runtime),
      logger: new MemoryLogger(),
      clock: systemClock,
    });
    const runner = new ScriptedRunner();
    const codexRunner = new ScriptedRunner();
    let codexProbe = { installed: true, signedIn: true as boolean | null };
    const options = { runner, codexRunner, codexProbe: async () => codexProbe };
    const auto = createHelperRuntimes(await deps("auto"), options);
    expect(auto.supported()).toEqual(["claude", "codex"]);
    // The settings page reads the shipped list without a core; it must match the registry.
    expect(auto.supported()).toEqual([...SHIPPED_HELPER_RUNTIMES]);
    expect(await auto.status()).toMatchObject({
      configured: "auto",
      runtimes: { claude: { installed: true }, codex: { installed: true, signedIn: true } },
      wouldUse: "claude",
    });
    expect(auto.get("claude")?.runner).toBe(runner);
    expect(auto.get("codex")?.runner).toBe(codexRunner);
    const codex = createHelperRuntimes(await deps("codex"), options);
    expect(await codex.status()).toMatchObject({
      configured: "codex",
      supported: ["claude", "codex"],
      wouldUse: "codex",
    });
    codexProbe = { installed: true, signedIn: false };
    expect((await codex.status()).wouldUse).toBeNull();
    expect((await createHelperRuntimes(await deps("claude"), options).status()).wouldUse).toBe("claude");
  });

  it("the default Codex runner uses CODEX_BIN, onboarding.codexModel, and the bridge's own Codex home", async () => {
    const tmp = await makeTempDir("brb-jobs-");
    cleanup = tmp.cleanup;
    const { writeFile } = await import("node:fs/promises");
    await mkdir(join(tmp.dir, "config"), { recursive: true });
    await writeFile(
      join(tmp.dir, "config", "bridge.json"),
      JSON.stringify({ onboarding: { codexModel: "gpt-x" } }),
    );
    const env = {
      BRIDGE_PASSPHRASE: "a passphrase for tests",
      CODEX_BIN: "/opt/codex/bin/codex",
      PATH: "/usr/bin",
    };
    const config = loadConfig({ env, rootDir: tmp.dir });
    const runtimes = createHelperRuntimes(
      { config, logger: new MemoryLogger(), clock: systemClock },
      { codexProbe: async () => ({ installed: false, signedIn: null }) },
      env,
    );
    const codex = runtimes.get("codex")?.runner;
    expect(codex).toBeInstanceOf(CodexAgentRunner);
    const launch = (codex as CodexAgentRunner).launch("/w");
    expect(launch.command).toBe("/opt/codex/bin/codex");
    expect(launch.env["CODEX_HOME"]).toBe(bridgeCodexHome(config.dataDir));
    expect(launch.env["BRIDGE_PASSPHRASE"]).toBeUndefined();
    expect((codex as CodexAgentRunner).describe()).toMatchObject({ model: "gpt-x", maxTurns: 80 });
  });
});
