/**
 * Run-mode control and the process composition: real `.env` / `config/bridge.json` files in a temp
 * project, the real settings store and loader, the real admin listener on port 0, a fake browser.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { fakeBrowser } from "../../test/support/site-fixtures.js";
import type { FakeBrowser } from "../../test/support/site-fixtures.js";
import { createApp } from "./app.js";
import type { BridgeApp } from "./app.js";
import { processBanner, startBridgeProcess } from "./bridge-process.js";
import type { BridgeProcess } from "./bridge-process.js";
import type { BridgeConfig } from "./config.js";
import { RunModeBusyError, RunModeController } from "./run-mode.js";
import { createSettingsStore } from "./settings.js";

const GOOD = "a passphrase for tests";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/anything`);
    return true;
  } catch {
    return false;
  }
}

describe("run-mode control", () => {
  let root: string;
  let publicPort: number;
  let logger: MemoryLogger;
  let browsers: FakeBrowser[];
  let cores: BridgeApp[];
  let proc: BridgeProcess | null;
  let blockers: Server[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "brb-runmode-"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "sites"));
    publicPort = await freePort();
    writeConfig({ publicPort });
    logger = new MemoryLogger();
    browsers = [];
    cores = [];
    proc = null;
    blockers = [];
  });
  afterEach(async () => {
    await proc?.stop();
    for (const b of blockers) await new Promise<void>((resolve) => b.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const writeEnv = (text: string) => writeFileSync(join(root, ".env"), text, { mode: 0o600 });
  const writeConfig = (value: unknown) =>
    writeFileSync(
      join(root, "config", "bridge.json"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const createCore = (config: BridgeConfig): BridgeApp => {
    const browser = fakeBrowser();
    browsers.push(browser);
    const app = createApp({ config, helpers: stubHelpers, logger, browser, repoRoot: process.cwd() });
    cores.push(app);
    return app;
  };
  const boot = async (): Promise<BridgeProcess> => {
    const store = createSettingsStore({ rootDir: root, env: {} });
    proc = await startBridgeProcess({
      store,
      logger,
      createCore,
      repoRoot: process.cwd(),
      adminPort: 0,
      probeBrowser: false,
    });
    return proc;
  };
  /** Exchanges the one-time link for the cookie. */
  const signIn = async (p: BridgeProcess): Promise<string> => {
    const res = await fetch(p.openUrl()!, { redirect: "manual" });
    expect(res.status).toBe(303);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const api = (p: BridgeProcess, path: string, cookie: string) =>
    fetch(`${p.dashboard.url}/api/${path}`, { headers: { cookie } });

  for (const [name, env, config, code] of [
    ["no passphrase", "", null, "passphrase_missing"],
    ["a short passphrase", "BRIDGE_PASSPHRASE=short\n", null, "passphrase_too_short"],
    ["a malformed bridge.json", `BRIDGE_PASSPHRASE='${GOOD}'\n`, "{ not json", "config_invalid"],
  ] as const) {
    it(`${name} → setup (${code}); the public port stays closed and the settings page answers`, async () => {
      writeEnv(env);
      if (config !== null) writeConfig(config);
      const p = await boot();
      const status = p.controller.status();
      expect(status.mode).toBe("setup");
      expect(status.problem?.code).toBe(code);
      expect(status.problem?.message).not.toContain(GOOD);
      expect(status.restartedAt).toBeNull();
      expect(p.controller.services()).toBeNull();
      expect(cores).toHaveLength(0);
      expect(await listening(publicPort)).toBe(false);

      const cookie = await signIn(p);
      const page = await fetch(`${p.dashboard.url}/`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const sites = await api(p, "sites", cookie);
      expect(sites.status).toBe(503);
      expect(((await sites.json()) as { error: string }).error).toBe("not_running");
      expect(processBanner(p)).toContain("setup");
      expect(processBanner(p)).toContain(code);
      expect(processBanner(p)).toContain(p.openUrl()!);
    });
  }

  it("a valid configuration → running; the core serves the public port and the dashboard API", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const p = await boot();
    const status = p.controller.status();
    expect(status).toMatchObject({ mode: "running", problem: null });
    expect(status.restartedAt).not.toBeNull();
    expect(p.controller.services()).toBe(cores[0]!.services);
    expect((await fetch(`http://127.0.0.1:${publicPort}/mcp`, { method: "POST" })).status).toBe(401);
    const cookie = await signIn(p);
    expect((await api(p, "sites", cookie)).status).toBe(200);
    const banner = processBanner(p);
    expect(banner).toContain("running");
    expect(banner).toContain(p.openUrl()!);
    expect(banner).not.toContain(GOOD);
  });

  it("restart builds a new core; the settings page keeps its link and cookie", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const p = await boot();
    const cookie = await signIn(p);
    const link = p.openUrl();
    const first = p.controller.services();
    const firstStarted = p.controller.status().restartedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await p.controller.restart();
    expect(result.restarted).toBe(true);
    expect(result.status.mode).toBe("running");
    expect(cores).toHaveLength(2);
    expect(p.controller.services()).toBe(cores[1]!.services);
    expect(p.controller.services()).not.toBe(first);
    expect(p.controller.status().restartedAt).not.toBe(firstStarted);
    expect(p.openUrl()).toBe(link);
    expect((await api(p, "sites", cookie)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${publicPort}/mcp`, { method: "POST" })).status).toBe(401);
  });

  it("from setup, fixing the file and restarting starts the core (the files are read again)", async () => {
    writeEnv("");
    const p = await boot();
    const cookie = await signIn(p);
    expect(p.controller.status().mode).toBe("setup");
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const result = await p.controller.restart();
    expect(result.status).toMatchObject({ mode: "running", problem: null });
    expect(await listening(publicPort)).toBe(true);
    expect((await api(p, "sites", cookie)).status).toBe(200);
  });

  it("refuses a second restart while one is in progress (busy)", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const p = await boot();
    const firstRestart = p.controller.restart();
    expect(p.controller.isBusy()).toBe(true);
    await expect(p.controller.restart()).rejects.toBeInstanceOf(RunModeBusyError);
    await expect(p.controller.restart()).rejects.toMatchObject({ code: "busy" });
    expect(p.controller.status().mode).toBe("restarting");
    expect(p.controller.services()).toBeNull();
    await firstRestart;
    expect(p.controller.isBusy()).toBe(false);
    expect(p.controller.status().mode).toBe("running");
    expect(cores).toHaveLength(2);
  });

  it("port conflict → setup with start_failed; the previous core is fully stopped", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const p = await boot();
    let shutdowns = 0;
    browsers[0]!.shutdown = async () => {
      shutdowns += 1;
    };
    const taken = await freePort();
    blockers.push(await occupy(taken));
    writeConfig({ publicPort: taken });

    const result = await p.controller.restart();
    expect(result.status.mode).toBe("setup");
    expect(result.status.problem?.code).toBe("start_failed");
    expect(result.status.problem?.message).toMatch(/EADDRINUSE|in use/);
    expect(p.controller.services()).toBeNull();
    expect(shutdowns).toBe(1);
    expect(await listening(publicPort)).toBe(false);
    // The failed second core released what it had started (its browser port was shut down too).
    expect(cores).toHaveLength(2);
  });

  it("a conflict at the first start leaves the settings page up in setup", async () => {
    const taken = await freePort();
    blockers.push(await occupy(taken));
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    writeConfig({ publicPort: taken });
    const p = await boot();
    expect(p.controller.status()).toMatchObject({ mode: "setup", problem: { code: "start_failed" } });
    const cookie = await signIn(p);
    expect((await api(p, "overview", cookie)).status).toBe(503);
  });

  it("stop closes the core and the settings page", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const p = await boot();
    const url = p.dashboard.url;
    await p.stop();
    proc = null;
    expect(await listening(publicPort)).toBe(false);
    await expect(fetch(`${url}/`)).rejects.toThrow();
    expect(p.controller.services()).toBeNull();
    await expect(p.controller.restart()).rejects.toThrow(/shutting down/);
  });
});

describe("RunModeController", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "brb-runmode-unit-"));
    mkdirSync(join(root, "sites"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const controller = (logger = new MemoryLogger()) => {
    writeFileSync(join(root, ".env"), `BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const store = createSettingsStore({ rootDir: root, env: {} });
    return new RunModeController({
      settings: store,
      createCore: (config) =>
        createApp({ config, helpers: stubHelpers, logger, browser: fakeBrowser(), repoRoot: process.cwd() }),
      logger,
      startOptions: { publicPort: 0, probeBrowser: false },
    });
  };

  it("runs the started hook after the core is up and the stopping hook before it stops", async () => {
    const logger = new MemoryLogger();
    const c = controller(logger);
    const events: string[] = [];
    c.onCoreStarted(async (core) => {
      events.push(`started ${core.started.public.port > 0} ${c.status().mode}`);
    });
    const off = c.onCoreStopping(async (core) => {
      events.push(`stopping ${await listening(core.started.public.port)}`);
    });
    c.onCoreStarted(() => {
      throw new Error("hook failed");
    });
    await c.start();
    expect(c.status().mode).toBe("running");
    await c.restart();
    off();
    await c.stop();
    expect(events).toEqual(["started true running", "stopping true", "started true running"]);
    expect(logger.lines.some((l) => l.includes("hook failed"))).toBe(true);
  });

  it("prepare runs inside the exclusive section; false skips the restart, a throw changes nothing", async () => {
    const c = controller();
    await c.start();
    const before = c.services();
    const seen: unknown[] = [];
    const skipped = await c.restart({
      prepare: async (services) => {
        seen.push(services);
        await expect(c.restart()).rejects.toBeInstanceOf(RunModeBusyError);
        return false;
      },
    });
    expect(skipped.restarted).toBe(false);
    expect(seen).toEqual([before]);
    expect(c.services()).toBe(before);
    await expect(
      c.restart({
        prepare: async () => {
          throw new Error("write failed");
        },
      }),
    ).rejects.toThrow("write failed");
    expect(c.status().mode).toBe("running");
    expect(c.services()).toBe(before);
    expect(c.isBusy()).toBe(false);
    await c.stop();
  });

  it("status copies are not shared, and problem is null outside setup", async () => {
    const c = controller();
    expect(c.status().mode).toBe("restarting");
    await c.start();
    const a = c.status();
    expect(a.problem).toBeNull();
    expect(c.status()).not.toBe(a);
    await c.stop();
  });
});
