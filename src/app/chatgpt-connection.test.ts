/**
 * The ChatGPT connection service over the real settings store (temp `.env` / `config/bridge.json`),
 * the real run-mode controller and settings page (port 0), a fake browser, and a fake connection
 * tool that writes its key and profile files into a temp folder. Nothing runs the real tool.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { fakeBrowser } from "../../test/support/site-fixtures.js";
import { FileTokenStore, tokenStorePath } from "../adapters/storage/index.js";
import type {
  ConnectionDiagnostics,
  ConnectionPaths,
  ConnectionTool,
  ConnectionToolFailure,
  ConnectionToolInfo,
  ConnectionToolStatus,
  PrepareConnectionInput,
  PrepareConnectionResult,
} from "../ports/connection-tool.js";
import type { SettingsChange, SettingsWriteResult } from "../ports/settings-store.js";
import { createApp } from "./app.js";
import type { BridgeApp } from "./app.js";
import { startBridgeProcess } from "./bridge-process.js";
import type { BridgeProcess } from "./bridge-process.js";
import {
  DEFAULT_TUNNEL_RESOURCE_PREFIX,
  mcpTargetUrl,
  type ChatgptConnectionService,
} from "./chatgpt-connection.js";
import type { BridgeConfig } from "./config.js";
import { createSettingsStore } from "./settings.js";
import type { BridgeSettingsStore } from "./settings.js";

const GOOD = "a passphrase for tests";
const TUNNEL = `tunnel_${"0123456789abcdef".repeat(2)}`;
const OTHER_TUNNEL = `tunnel_${"fedcba9876543210".repeat(2)}`;
const ADDRESS = `${DEFAULT_TUNNEL_RESOURCE_PREFIX}${TUNNEL}`;
const KEY = "sk-runtime-key-SECRET-0123456789";

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

/** Behaves like the tool for the service: real files in a temp folder, a scripted run state. */
class FakeTool implements ConnectionTool {
  installed = true;
  failPrepare: Extract<PrepareConnectionResult, { ok: false }> | null = null;
  inputs: Omit<PrepareConnectionInput, "runtimeKey">[] = [];
  private current: ConnectionToolStatus = {
    state: "stopped",
    profileName: null,
    lastFailure: null,
    consecutiveFailures: 0,
  };
  private readonly listeners = new Set<(s: ConnectionToolStatus) => void>();

  constructor(
    private readonly dir: string,
    private readonly events: string[],
  ) {}

  async detect(): Promise<ConnectionToolInfo> {
    return this.installed ? { installed: true, version: "0.0.14" } : { installed: false, version: null };
  }
  paths(profileName: string): ConnectionPaths {
    return {
      profileFile: join(this.dir, "profiles", `${profileName}.yaml`),
      keyFile: join(this.dir, "keys", `${profileName}-runtime-key`),
    };
  }
  async prepare(input: PrepareConnectionInput): Promise<PrepareConnectionResult> {
    this.events.push("prepare");
    const { runtimeKey, ...rest } = input;
    this.inputs.push(rest);
    if (this.failPrepare) return this.failPrepare;
    const paths = this.paths(input.profileName);
    if (!input.replace && (existsSync(paths.profileFile) || existsSync(paths.keyFile))) {
      return { ok: false, error: "exists", message: "a profile or key file already exists" };
    }
    mkdirSync(dirname(paths.keyFile), { recursive: true });
    mkdirSync(dirname(paths.profileFile), { recursive: true });
    writeFileSync(paths.keyFile, runtimeKey, { mode: 0o600 });
    writeFileSync(paths.profileFile, `tunnel: ${input.tunnelId}\nkey: file:${paths.keyFile}\n`);
    return { ok: true, ...paths };
  }
  start(profileName: string): void {
    this.events.push(`tool:start ${profileName}`);
    if (this.current.state === "starting" || this.current.state === "ready") return;
    this.set({ state: "starting", profileName, consecutiveFailures: 0 });
  }
  async stop(): Promise<void> {
    this.events.push("tool:stop");
    this.set({ state: "stopped" });
  }
  status(): ConnectionToolStatus {
    return { ...this.current };
  }
  onStatusChange(listener: (status: ConnectionToolStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async diagnose(): Promise<ConnectionDiagnostics> {
    return { ok: true, failedChecks: [], kinds: [], summary: "all checks passed" };
  }
  async removeKey(profileName: string): Promise<void> {
    this.events.push("removeKey");
    rmSync(this.paths(profileName).keyFile, { force: true });
  }
  /** Test control: move the run state. */
  set(next: Partial<ConnectionToolStatus>): void {
    this.current = { ...this.current, ...next };
    for (const l of this.listeners) l(this.status());
  }
  fail(message: string): void {
    const failure: ConnectionToolFailure = { kind: "not_ready", message, at: new Date().toISOString() };
    this.set({ state: "failed", lastFailure: failure, consecutiveFailures: 5 });
  }
}

describe("ChatGPT connection service", () => {
  let root: string;
  let publicPort: number;
  let logger: MemoryLogger;
  let events: string[];
  let tool: FakeTool;
  let cores: BridgeApp[];
  let proc: BridgeProcess | null;
  let blockers: Server[];
  let failWrite: SettingsWriteResult | null;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "brb-chatgpt-"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "sites"));
    publicPort = await freePort();
    writeConfig({ publicPort });
    logger = new MemoryLogger();
    events = [];
    tool = new FakeTool(join(root, "tool"), events);
    cores = [];
    proc = null;
    blockers = [];
    failWrite = null;
  });
  afterEach(async () => {
    await proc?.stop();
    for (const b of blockers) await new Promise<void>((resolve) => b.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const configPath = () => join(root, "config", "bridge.json");
  const writeEnv = (text: string) => writeFileSync(join(root, ".env"), text, { mode: 0o600 });
  const writeConfig = (value: unknown) => writeFileSync(configPath(), JSON.stringify(value, null, 2));
  const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;

  const createCore = (config: BridgeConfig): BridgeApp => {
    const app = createApp({
      config,
      helpers: stubHelpers,
      logger,
      browser: fakeBrowser(),
      repoRoot: process.cwd(),
    });
    cores.push(app);
    const start = app.start.bind(app);
    const stop = app.stop.bind(app);
    return {
      services: app.services,
      publicApp: app.publicApp,
      attach: (listener) => app.attach(listener),
      start: async (options) => {
        const started = await start(options);
        events.push("core:up");
        return started;
      },
      stop: async () => {
        events.push("core:down");
        await stop();
      },
    };
  };

  /** The real store, with writes and loads recorded (and a write failure on demand). */
  const recordingStore = (): BridgeSettingsStore => {
    const store = createSettingsStore({ rootDir: root, env: {} });
    return {
      read: () => store.read(),
      write: async (change: SettingsChange) => {
        events.push("write");
        if (failWrite) return failWrite;
        return store.write(change);
      },
      loadConfig: () => {
        events.push("load");
        return store.loadConfig();
      },
      pageLocation: () => store.pageLocation(),
    };
  };

  const boot = async (): Promise<{ p: BridgeProcess; svc: ChatgptConnectionService }> => {
    proc = await startBridgeProcess({
      store: recordingStore(),
      logger,
      createCore,
      repoRoot: process.cwd(),
      adminPort: 0,
      probeBrowser: false,
      connectionTool: tool,
      chatgptTargetFallback: { env: {}, rootDir: root },
    });
    if (proc.chatgpt === null) throw new Error("no ChatGPT service");
    return { p: proc, svc: proc.chatgpt };
  };

  const setupInput = (extra: Record<string, unknown> = {}) => ({
    tunnelId: TUNNEL,
    runtimeKey: KEY,
    ...extra,
  });

  it("not_configured: no marker and no tunnel address; nothing is started", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const state = await svc.state();
    expect(state).toEqual({
      tool: { installed: true, version: "0.0.14" },
      state: "not_configured",
      managedBy: null,
      tunnelId: null,
      profile: null,
      keyStored: false,
      message: null,
      connectedApps: 0,
    });
    expect(events.filter((e) => e.startsWith("tool:start"))).toEqual([]);
  });

  it("external: a hand-made tunnel address without the marker is left alone", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    writeConfig({ publicPort, oauth: { extraResources: [ADDRESS] } });
    const before = readFileSync(configPath(), "utf8");
    const { svc } = await boot();
    const state = await svc.state();
    expect(state).toMatchObject({
      state: "external",
      managedBy: "external",
      tunnelId: TUNNEL,
      profile: null,
    });
    expect(await svc.retry()).toMatchObject({ ok: false, error: "external" });
    expect(await svc.disconnect()).toMatchObject({ ok: false, error: "external" });
    expect(events.filter((e) => e.startsWith("tool:") || e === "write" || e === "removeKey")).toEqual([]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(cores).toHaveLength(1);
  });

  it("not_configured refusals for retry and disconnect", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    expect(await svc.retry()).toMatchObject({ ok: false, error: "not_configured" });
    expect(await svc.disconnect()).toMatchObject({ ok: false, error: "not_configured" });
  });

  it("stopped: a managed connection with the core off (setup mode); the tool is never started", async () => {
    writeEnv("");
    writeConfig({
      publicPort,
      chatgpt: { managed: true, tunnelId: TUNNEL, profile: "browser-research-bridge" },
      oauth: { extraResources: [ADDRESS] },
    });
    const { p, svc } = await boot();
    expect(p.controller.status().mode).toBe("setup");
    const state = await svc.state();
    expect(state).toMatchObject({
      state: "stopped",
      managedBy: "bridge",
      tunnelId: TUNNEL,
      profile: "browser-research-bridge",
      keyStored: false,
      connectedApps: null,
    });
    expect(await svc.retry()).toMatchObject({ ok: false, error: "not_running" });
    expect(events.filter((e) => e.startsWith("tool:start"))).toEqual([]);
  });

  it("a managed connection starts with the core; starting → ready → failed, and retry semantics", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    writeConfig({
      publicPort,
      chatgpt: { managed: true, tunnelId: TUNNEL, profile: "my-profile" },
      oauth: { extraResources: [ADDRESS] },
    });
    const { svc } = await boot();
    expect(events).toEqual(["load", "core:up", "tool:start my-profile"]);
    expect((await svc.state()).state).toBe("starting");
    expect(await svc.retry()).toEqual({ ok: true, started: false, state: "starting" });

    tool.set({ state: "ready" });
    expect(await svc.state()).toMatchObject({ state: "ready", message: null });
    expect(await svc.retry()).toEqual({ ok: true, started: false, state: "ready" });

    tool.fail("the connection tool did not become ready");
    expect(await svc.state()).toMatchObject({
      state: "failed",
      message: "the connection tool did not become ready",
    });
    const retried = await svc.retry();
    expect(retried).toEqual({ ok: true, started: true, state: "starting" });
    expect(events.filter((e) => e.startsWith("tool:start"))).toHaveLength(2);
  });

  it("setup: validate → prepare → write → restart; the tool starts after the core is up and stops before it goes down", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { p, svc } = await boot();
    events.length = 0;

    const result = await svc.setup(setupInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const done = await result.done;
    expect(done.status.mode).toBe("running");
    expect(events).toEqual([
      "load", // the profile target is worked out from the current configuration
      "prepare",
      "write",
      "tool:stop",
      "core:down",
      "load",
      "core:up",
      "tool:start browser-research-bridge",
    ]);
    expect(tool.inputs[0]).toEqual({
      tunnelId: TUNNEL,
      profileName: "browser-research-bridge",
      targetMcpUrl: `http://localhost:${publicPort}/mcp`,
      replace: false,
    });
    const config = readConfig();
    expect(config["chatgpt"]).toEqual({
      managed: true,
      tunnelId: TUNNEL,
      profile: "browser-research-bridge",
    });
    expect((config["oauth"] as { extraResources: string[] }).extraResources).toEqual([ADDRESS]);
    expect(cores).toHaveLength(2);
    expect(p.controller.current()?.config.oauth.extraResources).toEqual([ADDRESS]);
    expect(await svc.state()).toMatchObject({
      state: "starting",
      managedBy: "bridge",
      tunnelId: TUNNEL,
      profile: "browser-research-bridge",
      keyStored: true,
    });

    // A later restart stops the tool before the core stops and starts it after the core is up.
    events.length = 0;
    await p.controller.restart();
    expect(events).toEqual([
      "tool:stop",
      "core:down",
      "load",
      "core:up",
      "tool:start browser-research-bridge",
    ]);
  });

  it("setup validates its input (field codes) and touches nothing", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    events.length = 0;
    const before = readFileSync(configPath(), "utf8");
    expect(await svc.setup({ tunnelId: "tunnel_XYZ", runtimeKey: "", profile: "Bad Name" })).toMatchObject({
      ok: false,
      error: "invalid",
      fields: { tunnelId: "bad_format", runtimeKey: "empty", profile: "bad_value" },
    });
    expect(await svc.setup({ tunnelId: "", runtimeKey: "a\nb" })).toMatchObject({
      ok: false,
      error: "invalid",
      fields: { tunnelId: "empty", runtimeKey: "bad_format" },
    });
    expect(
      await svc.setup({ tunnelId: TUNNEL.toUpperCase().replace("TUNNEL_", "tunnel_"), runtimeKey: KEY }),
    ).toMatchObject({ ok: false, error: "invalid", fields: { tunnelId: "bad_format" } });
    expect(await svc.setup({ tunnelId: TUNNEL, runtimeKey: KEY, profile: "x".repeat(65) })).toMatchObject({
      ok: false,
      fields: { profile: "bad_value" },
    });
    expect(events).toEqual([]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("a single trailing line break on the key is tolerated", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const result = await svc.setup(setupInput({ runtimeKey: `${KEY}\n` }));
    expect(result.ok).toBe(true);
    if (result.ok) await result.done;
    expect(readFileSync(tool.paths("browser-research-bridge").keyFile, "utf8")).toBe(KEY);
  });

  it("tool missing → tool_missing; nothing is prepared or written and no restart happens", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    tool.installed = false;
    events.length = 0;
    const before = readFileSync(configPath(), "utf8");
    expect(await svc.setup(setupInput())).toMatchObject({ ok: false, error: "tool_missing" });
    expect(events).toEqual([]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(cores).toHaveLength(1);
    expect((await svc.state()).tool).toEqual({ installed: false, version: null });
  });

  it("prepare fails (exists, then profile_failed) → settings unchanged, no restart", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const paths = tool.paths("browser-research-bridge");
    mkdirSync(dirname(paths.profileFile), { recursive: true });
    writeFileSync(paths.profileFile, "hand-made\n");
    const before = readFileSync(configPath(), "utf8");
    events.length = 0;

    expect(await svc.setup(setupInput())).toMatchObject({ ok: false, error: "exists" });
    tool.failPrepare = { ok: false, error: "profile_failed", message: "the profile could not be created" };
    expect(await svc.setup(setupInput({ replace: true }))).toMatchObject({
      ok: false,
      error: "prepare_failed",
      kind: "profile_failed",
      message: "the profile could not be created",
    });
    expect(events).toEqual(["load", "prepare", "load", "prepare"]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(cores).toHaveLength(1);
    expect(readFileSync(paths.profileFile, "utf8")).toBe("hand-made\n");
  });

  it("the settings write fails after prepare → the files this call created are removed, no restart", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const before = readFileSync(configPath(), "utf8");
    failWrite = {
      ok: false,
      error: "file_unreadable",
      file: configPath(),
      message: "config/bridge.json is malformed",
    };
    events.length = 0;
    expect(await svc.setup(setupInput())).toMatchObject({ ok: false, error: "file_unreadable" });
    expect(events).toEqual(["load", "prepare", "write", "removeKey"]);
    const paths = tool.paths("browser-research-bridge");
    expect(existsSync(paths.keyFile)).toBe(false);
    expect(existsSync(paths.profileFile)).toBe(false);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(cores).toHaveLength(1);
  });

  it("an unreadable config file is refused before anything is prepared", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    writeFileSync(configPath(), "{ not json");
    events.length = 0;
    expect(await svc.setup(setupInput())).toMatchObject({ ok: false, error: "file_unreadable" });
    expect(events).toEqual([]);
  });

  it("the restart fails (public port in use) → files written, setup + start_failed, the tool is not started", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    blockers.push(await occupy(publicPort));
    const { p, svc } = await boot();
    expect(p.controller.status().problem?.code).toBe("start_failed");
    const result = await svc.setup(setupInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const done = await result.done;
    expect(done.status).toMatchObject({ mode: "setup", problem: { code: "start_failed" } });
    expect(readConfig()["chatgpt"]).toEqual({
      managed: true,
      tunnelId: TUNNEL,
      profile: "browser-research-bridge",
    });
    expect(existsSync(tool.paths("browser-research-bridge").keyFile)).toBe(true);
    expect(events.filter((e) => e.startsWith("tool:start"))).toEqual([]);
    expect(await svc.state()).toMatchObject({ state: "stopped", managedBy: "bridge", connectedApps: null });
  });

  it("setup in setup mode (no passphrase): files written, a start is attempted, nothing is started", async () => {
    writeEnv("");
    const { p, svc } = await boot();
    expect(p.controller.status().mode).toBe("setup");
    const result = await svc.setup(setupInput({ profile: "work-1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const done = await result.done;
    expect(done.status).toMatchObject({ mode: "setup", problem: { code: "passphrase_missing" } });
    expect(tool.inputs[0]?.targetMcpUrl).toBe(`http://localhost:${publicPort}/mcp`);
    expect(readConfig()["chatgpt"]).toEqual({ managed: true, tunnelId: TUNNEL, profile: "work-1" });
    expect(events.filter((e) => e.startsWith("tool:start"))).toEqual([]);
    expect(cores).toHaveLength(0);
    expect((await svc.state()).state).toBe("stopped");
  });

  it("setup with replace moves a hand-made connection under program management", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    writeConfig({ publicPort, oauth: { extraResources: ["https://example.test/keep", ADDRESS] } });
    const { svc } = await boot();
    const result = await svc.setup(setupInput({ replace: true }));
    expect(result.ok).toBe(true);
    if (result.ok) await result.done;
    expect((readConfig()["oauth"] as { extraResources: string[] }).extraResources).toEqual([
      "https://example.test/keep",
      ADDRESS,
    ]);
    expect(await svc.state()).toMatchObject({ state: "starting", managedBy: "bridge" });
  });

  it("a new managed tunnel replaces the previous managed tunnel's address", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const first = await svc.setup(setupInput());
    if (first.ok) await first.done;
    const second = await svc.setup(setupInput({ tunnelId: OTHER_TUNNEL, replace: true }));
    expect(second.ok).toBe(true);
    if (second.ok) await second.done;
    expect((readConfig()["oauth"] as { extraResources: string[] }).extraResources).toEqual([
      `${DEFAULT_TUNNEL_RESOURCE_PREFIX}${OTHER_TUNNEL}`,
    ]);
  });

  it("setup during a restart is refused (busy)", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { p, svc } = await boot();
    const restarting = p.controller.restart();
    expect(await svc.setup(setupInput())).toMatchObject({ ok: false, error: "busy" });
    expect(await svc.disconnect()).toMatchObject({ ok: false, error: "not_configured" });
    await restarting;
  });

  it("disconnect: stop → delete the key → remove the address and the marker → restart", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    writeConfig({ publicPort, oauth: { extraResources: ["https://example.test/keep"] } });
    const { svc } = await boot();
    const setup = await svc.setup(setupInput());
    if (setup.ok) await setup.done;
    tool.set({ state: "ready" });
    events.length = 0;

    const result = await svc.disconnect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.done).status.mode).toBe("running");
    expect(events).toEqual(["tool:stop", "removeKey", "write", "tool:stop", "core:down", "load", "core:up"]);
    const config = readConfig();
    expect(config["chatgpt"]).toBeNull();
    expect((config["oauth"] as { extraResources: string[] }).extraResources).toEqual([
      "https://example.test/keep",
    ]);
    const paths = tool.paths("browser-research-bridge");
    expect(existsSync(paths.keyFile)).toBe(false);
    expect(existsSync(paths.profileFile)).toBe(true);
    expect(await svc.state()).toMatchObject({ state: "not_configured", managedBy: null, keyStored: false });
  });

  it("disconnect is allowed in setup mode (stopped)", async () => {
    writeEnv("");
    writeConfig({
      publicPort,
      chatgpt: { managed: true, tunnelId: TUNNEL, profile: "browser-research-bridge" },
      oauth: { extraResources: [ADDRESS] },
    });
    const { svc } = await boot();
    const result = await svc.disconnect();
    expect(result.ok).toBe(true);
    if (result.ok) expect((await result.done).status.mode).toBe("setup");
    expect(readConfig()["chatgpt"]).toBeNull();
    expect(events.filter((e) => e.startsWith("tool:start"))).toEqual([]);
  });

  it("connectedApps counts only apps holding a live (unexpired, unrevoked) token", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const tokens = new FileTokenStore(tokenStorePath(join(root, "data")));
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    const client = (clientId: string) =>
      tokens.putClient({
        clientId,
        clientName: clientId,
        redirectUris: ["https://chatgpt.com/connector/oauth/x"],
        source: "dcr",
        createdAt: iso(-1000),
        lastTokenIssuedAt: iso(-1000),
      });
    const token = (clientId: string, tokenHash: string, expiresIn: number, revoked: boolean) =>
      tokens.putToken({
        tokenHash,
        kind: "access",
        clientId,
        scope: null,
        resource: null,
        familyId: tokenHash,
        createdAt: iso(-1000),
        expiresAt: iso(expiresIn),
        revokedAt: revoked ? iso(-500) : null,
      });
    await client("live");
    await token("live", "h1", 3_600_000, false);
    await token("live", "h1b", -1000, false);
    await client("expired");
    await token("expired", "h2", -1000, false);
    await client("revoked");
    await token("revoked", "h3", 3_600_000, true);
    await client("none");
    const { svc } = await boot();
    expect((await svc.state()).connectedApps).toBe(1);
  });

  it("no status, result, message, settings file, or log line contains the runtime key", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${GOOD}'\n`);
    const { svc } = await boot();
    const outputs: unknown[] = [];
    const setup = await svc.setup(setupInput());
    outputs.push(setup.ok ? { ok: true } : setup);
    if (setup.ok) outputs.push(await setup.done);
    tool.fail("the connection tool did not become ready");
    outputs.push(await svc.state(), await svc.retry());
    outputs.push(await svc.setup(setupInput()));
    const dis = await svc.disconnect();
    if (dis.ok) outputs.push(await dis.done);
    outputs.push(await svc.state());
    const text = JSON.stringify(outputs) + readFileSync(configPath(), "utf8") + logger.lines.join("\n");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(GOOD);
  });
});

describe("mcpTargetUrl", () => {
  it("follows the advertised address when it is this machine's public port, else the loopback address", () => {
    expect(mcpTargetUrl({ publicPort: 8787, publicUrl: "http://localhost:8787" })).toBe(
      "http://localhost:8787/mcp",
    );
    expect(mcpTargetUrl({ publicPort: 8787, publicUrl: "http://127.0.0.1:8787" })).toBe(
      "http://127.0.0.1:8787/mcp",
    );
    expect(mcpTargetUrl({ publicPort: 8787, publicUrl: "https://bridge.example.com" })).toBe(
      "http://127.0.0.1:8787/mcp",
    );
    expect(mcpTargetUrl({ publicPort: 8787, publicUrl: "http://localhost:9000" })).toBe(
      "http://127.0.0.1:8787/mcp",
    );
    expect(mcpTargetUrl({ publicPort: 80, publicUrl: "http://localhost" })).toBe("http://localhost/mcp");
  });
});
