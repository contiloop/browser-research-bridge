/**
 * The settings-page API through the whole process (`startBridgeProcess`): real `.env` /
 * `config/bridge.json` in a temp project, the real settings store, run-mode control, and settings
 * page on port 0, a fake browser, a fake helper runtime, and a fake connection tool. Nothing runs
 * the real tool, a real helper, or the owner's bridge.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSiteAssistant } from "../../test/support/fake-site-assistant.js";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { fakeBrowser } from "../../test/support/site-fixtures.js";
import { HelperRuntimes } from "../adapters/onboarding/index.js";
import type {
  AgentRunner,
  HelperCheckCode,
  HelperRuntime,
  HelperRuntimeId,
  RuntimeProbe,
} from "../adapters/onboarding/index.js";
import { FileTokenStore, tokenStorePath } from "../adapters/storage/index.js";
import type {
  ConnectionDiagnostics,
  ConnectionPaths,
  ConnectionTool,
  ConnectionToolInfo,
  ConnectionToolStatus,
  PrepareConnectionInput,
  PrepareConnectionResult,
} from "../ports/connection-tool.js";
import type { EnvironmentMap } from "../ports/settings-store.js";
import { createApp } from "./app.js";
import type { BridgeApp } from "./app.js";
import { startBridgeProcess } from "./bridge-process.js";
import type { BridgeProcess } from "./bridge-process.js";
import type { BridgeConfig } from "./config.js";
import { createSettingsStore } from "./settings.js";

const OLD = "the old passphrase 1";
const NEW = `a "new" passphrase # with 'quotes' and 한글`;
const KEY = "sk-runtime-key-SECRET-0123456789";
const TUNNEL = `tunnel_${"0123456789abcdef".repeat(2)}`;

/** A fake `pbcopy` that records its standard input and argument count (the real one is never run). */
function fakePbcopy(dir: string): { command: string; out: string; args: string } {
  mkdirSync(dir, { recursive: true });
  const paths = { command: join(dir, "pbcopy"), out: join(dir, "out"), args: join(dir, "args") };
  writeFileSync(paths.command, `#!/bin/sh\nprintf '%s' "$#" > '${paths.args}'\ncat > '${paths.out}'\n`, {
    mode: 0o755,
  });
  return paths;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Writes real key and profile files into a temp folder; a scripted run state. */
class FakeTool implements ConnectionTool {
  private current: ConnectionToolStatus = {
    state: "stopped",
    profileName: null,
    lastFailure: null,
    consecutiveFailures: 0,
  };
  constructor(private readonly dir: string) {}
  async detect(): Promise<ConnectionToolInfo> {
    return { installed: true, version: "0.0.14" };
  }
  paths(profileName: string): ConnectionPaths {
    return {
      profileFile: join(this.dir, "profiles", `${profileName}.yaml`),
      keyFile: join(this.dir, "keys", `${profileName}-runtime-key`),
    };
  }
  async prepare(input: PrepareConnectionInput): Promise<PrepareConnectionResult> {
    const paths = this.paths(input.profileName);
    if (!input.replace && (existsSync(paths.profileFile) || existsSync(paths.keyFile))) {
      return { ok: false, error: "exists", message: "a profile or key file already exists" };
    }
    mkdirSync(dirname(paths.keyFile), { recursive: true });
    mkdirSync(dirname(paths.profileFile), { recursive: true });
    writeFileSync(paths.keyFile, input.runtimeKey, { mode: 0o600 });
    writeFileSync(paths.profileFile, `tunnel: ${input.tunnelId}\nkey: file:${paths.keyFile}\n`);
    return { ok: true, ...paths };
  }
  start(profileName: string): void {
    this.current = { ...this.current, state: "ready", profileName };
  }
  async stop(): Promise<void> {
    this.current = { ...this.current, state: "stopped" };
  }
  status(): ConnectionToolStatus {
    return { ...this.current };
  }
  onStatusChange(): () => void {
    return () => undefined;
  }
  async diagnose(): Promise<ConnectionDiagnostics> {
    return { ok: true, failedChecks: [], kinds: [], summary: "all checks passed" };
  }
  async removeKey(profileName: string): Promise<void> {
    rmSync(this.paths(profileName).keyFile, { force: true });
  }
}

interface Checks {
  /** Checks made on any runtime. */
  count: number;
  byRuntime: Record<HelperRuntimeId, number>;
  probe: Record<HelperRuntimeId, RuntimeProbe>;
  code: HelperCheckCode;
}

/** A helper runtime whose probe and check are scripted and make no model call. */
function fakeRuntime(id: HelperRuntimeId, checks: Checks): HelperRuntime {
  return {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    signInHint: `sign in to ${id} on this Mac`,
    runner: {} as AgentRunner,
    probe: async () => ({ ...checks.probe[id] }),
    check: async () => {
      checks.count++;
      checks.byRuntime[id]++;
      return {
        code: checks.code,
        message: checks.code === "ok" ? "round trip passed" : "usage limit reached",
      };
    },
  };
}

describe("settings-page API through the process", () => {
  let root: string;
  let logger: MemoryLogger;
  let cores: BridgeApp[];
  let proc: BridgeProcess | null;
  let checks: Checks;
  /** The runtimes the cores register (`["claude"]` unless a test adds Codex). */
  let shipped: HelperRuntimeId[];
  let clip: { command: string; out: string; args: string };
  let cookie: string;
  const bodies: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "brb-settings-api-"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "sites"));
    writeConfig({ publicPort: await freePort() });
    logger = new MemoryLogger();
    cores = [];
    proc = null;
    checks = {
      count: 0,
      byRuntime: { claude: 0, codex: 0 },
      probe: { claude: { installed: true, signedIn: null }, codex: { installed: true, signedIn: true } },
      code: "ok",
    };
    shipped = ["claude"];
    clip = fakePbcopy(join(root, "clip"));
    bodies.length = 0;
  });
  afterEach(async () => {
    await proc?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const envPath = () => join(root, ".env");
  const writeEnv = (text: string) => writeFileSync(envPath(), text, { mode: 0o600 });
  const writeConfig = (value: unknown) =>
    writeFileSync(join(root, "config", "bridge.json"), JSON.stringify(value, null, 2));
  const createCore = (config: BridgeConfig): BridgeApp => {
    const app = createApp({
      config,
      helpers: stubHelpers,
      logger,
      browser: fakeBrowser(),
      // The real Aside CLI is never run in tests.
      assistant: new FakeSiteAssistant(),
      repoRoot: process.cwd(),
      onboarding: {
        runtimes: new HelperRuntimes({
          configured: config.onboarding.runtime,
          runtimes: shipped.map((id) => fakeRuntime(id, checks)),
        }),
      },
    });
    cores.push(app);
    return app;
  };
  const boot = async (env: EnvironmentMap = {}): Promise<BridgeProcess> => {
    proc = await startBridgeProcess({
      store: createSettingsStore({ rootDir: root, env }),
      logger,
      createCore,
      repoRoot: process.cwd(),
      adminPort: 0,
      probeBrowser: false,
      connectionTool: new FakeTool(join(root, "tool")),
      chatgptTargetFallback: { env: {}, rootDir: root },
      helperAutoCheckDelayMs: 0,
      clipboardCommand: clip.command,
    });
    const res = await fetch(proc.openUrl()!, { redirect: "manual" });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return proc;
  };
  const record = async (res: Response): Promise<{ status: number; json: Record<string, unknown> }> => {
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const get = async (path: string) =>
    record(await fetch(`${proc!.dashboard.url}/api/${path}`, { headers: { cookie } }));
  const send = async (method: string, path: string, body?: unknown) =>
    record(
      await fetch(`${proc!.dashboard.url}/api/${path}`, {
        method,
        headers: { cookie, origin: proc!.dashboard.url, "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    );
  const settled = async () => {
    await vi.waitFor(() => expect(proc!.controller.isBusy()).toBe(false), { timeout: 5000, interval: 10 });
    // The automatic helper check of the core that just started (delay 0 here).
    await proc!.helperChecks.settled();
  };
  const noSecretAnywhere = () => {
    const all = [...bodies, ...logger.lines].join("\n");
    for (const secret of [OLD, NEW, KEY]) expect(all).not.toContain(secret);
    const token = readFileSync(proc!.tokenFile, "utf8").trim();
    expect(all).not.toContain(token);
  };
  /** A fresh store instance reads the file again (the store keeps what it read in memory). */
  const tokenFile = () => new FileTokenStore(tokenStorePath(join(root, "data")));
  /** Two connected apps with a live token each, written before the core reads the file. */
  const seedApps = async () => {
    const store = tokenFile();
    const now = new Date();
    for (const clientId of ["client-a", "client-b"]) {
      await store.putClient({
        clientId,
        clientName: clientId,
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        source: "dcr",
        createdAt: now.toISOString(),
        lastTokenIssuedAt: now.toISOString(),
      });
      await store.putToken({
        tokenHash: `hash-${clientId}`,
        kind: "refresh",
        clientId,
        scope: null,
        resource: null,
        familyId: `fam-${clientId}`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        revokedAt: null,
      });
    }
  };

  it("setup → set the passphrase on the page → running; the passphrase is never shown again", async () => {
    writeEnv("");
    const p = await boot();
    expect((await get("status")).json).toMatchObject({
      mode: "setup",
      problem: { code: "passphrase_missing" },
      restartedAt: null,
    });
    const before = await get("settings");
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({
      passphrase: { set: false, valid: false, locked: false },
      helperRuntime: { value: "auto", supported: ["claude", "codex"] },
      asideAccount: { value: "u0", locked: false },
      info: {
        publicUrlConfigured: false,
        adminPort: p.dashboard.port,
        configFile: join(root, "config", "bridge.json"),
        envFile: envPath(),
      },
    });
    const info = before.json["info"] as Record<string, unknown>;
    expect(info["publicPort"]).toEqual(expect.any(Number));
    expect(info["mcpUrl"]).toBe(`http://localhost:${String(info["publicPort"])}/mcp`);
    expect((await get("chatgpt")).json).toMatchObject({ state: "not_configured", connectedApps: null });
    expect((await get("helper")).status).toBe(503);
    expect((await send("POST", "helper/check")).status).toBe(503);
    expect((await send("POST", "chatgpt/retry")).status).toBe(503);

    const saved = await send("PUT", "settings", { passphrase: NEW });
    expect(saved).toEqual({
      status: 202,
      json: { changed: ["passphrase"], restarting: true, appsDisconnected: null },
    });
    await settled();
    expect((await get("status")).json).toMatchObject({ mode: "running", problem: null });
    expect((await get("settings")).json).toMatchObject({ passphrase: { set: true, valid: true } });
    expect(cores).toHaveLength(1);
    expect(cores[0]!.services.config.secrets.passphrase).toBe(NEW);
    expect(readFileSync(envPath(), "utf8")).toContain("BRIDGE_PASSPHRASE=");

    // The same value again: nothing to do, no restart.
    expect(await send("PUT", "settings", { passphrase: NEW })).toEqual({
      status: 200,
      json: { changed: [], restarting: false, appsDisconnected: null },
    });
    expect(await send("PUT", "settings", { helperRuntime: "auto", asideAccount: "u0" })).toEqual({
      status: 200,
      json: { changed: [], restarting: false, appsDisconnected: null },
    });
    expect(cores).toHaveLength(1);
    noSecretAnywhere();
  });

  it("invalid values name each field; nothing is written", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    const envBefore = readFileSync(envPath(), "utf8");
    expect(await send("PUT", "settings", { passphrase: "short" })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { passphrase: "too_short" } },
    });
    expect(await send("PUT", "settings", { passphrase: `${NEW}\nX=1` })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { passphrase: "unsupported_characters" } },
    });
    expect(await send("PUT", "settings", { asideAccount: " ", helperRuntime: "nope" })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { helperRuntime: "bad_value" } },
    });
    expect(await send("PUT", "settings", { asideAccount: " " })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { asideAccount: "empty" } },
    });
    expect(readFileSync(envPath(), "utf8")).toBe(envBefore);
    expect(cores).toHaveLength(1);
    noSecretAnywhere();
  });

  it("a passphrase forced by the environment is locked", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot({ BRIDGE_PASSPHRASE: "set by the service definition" });
    expect((await get("settings")).json).toMatchObject({ passphrase: { locked: true } });
    expect(await send("PUT", "settings", { passphrase: NEW })).toMatchObject({
      status: 409,
      json: { error: "locked", fields: { passphrase: "locked" } },
    });
  });

  it("a malformed bridge.json: file_unreadable for a change that goes there; .env changes still work", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    writeFileSync(join(root, "config", "bridge.json"), "{ not json");
    await boot();
    expect((await get("status")).json).toMatchObject({ mode: "setup", problem: { code: "config_invalid" } });
    const settings = await get("settings");
    expect(settings.json).toMatchObject({
      helperRuntime: { value: null },
      info: { mcpUrl: null, publicPort: null, sitesDir: null },
    });
    expect(await send("PUT", "settings", { helperRuntime: "claude" })).toMatchObject({
      status: 409,
      json: { error: "file_unreadable" },
    });
    expect((await send("PUT", "settings", { passphrase: NEW })).status).toBe(202);
    await settled();
    expect(readFileSync(envPath(), "utf8")).not.toContain(OLD);
  });

  it("disconnectApps with a running core removes every connected app through the OAuth server", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await seedApps();
    await boot();
    expect((await get("chatgpt")).json).toMatchObject({ connectedApps: 2 });
    const saved = await send("PUT", "settings", { passphrase: NEW, disconnectApps: true });
    expect(saved).toEqual({
      status: 202,
      json: { changed: ["passphrase"], restarting: true, appsDisconnected: true },
    });
    await settled();
    expect(await tokenFile().listClients()).toEqual([]);
    expect(await tokenFile().listTokens()).toEqual([]);
    expect((await get("chatgpt")).json).toMatchObject({ connectedApps: 0 });
    noSecretAnywhere();
  });

  it("disconnectApps with the core off removes them from the token file", async () => {
    writeEnv("BRIDGE_PASSPHRASE=short\n");
    const p = await boot();
    expect(p.controller.status().mode).toBe("setup");
    await seedApps();
    const saved = await send("PUT", "settings", { passphrase: NEW, disconnectApps: true });
    expect(saved.json).toEqual({ changed: ["passphrase"], restarting: true, appsDisconnected: true });
    await settled();
    expect(p.controller.status().mode).toBe("running");
    expect(await tokenFile().listClients()).toEqual([]);
  });

  it("without disconnectApps the connected apps stay", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await seedApps();
    await boot();
    expect((await send("PUT", "settings", { passphrase: NEW })).json).toMatchObject({
      appsDisconnected: null,
    });
    await settled();
    expect(await tokenFile().listClients()).toHaveLength(2);
  });

  it("the automatic helper check runs once after the start, is kept in data/, and is not repeated", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    const first = await boot();
    await settled();
    expect(checks.count).toBe(1);
    const helper = await get("helper");
    expect(helper.json).toMatchObject({
      configured: "auto",
      supported: ["claude"],
      runtimes: { claude: { installed: true, signedIn: null }, codex: null },
      wouldUse: "claude",
      lastCheck: { runtime: "claude", ok: true, code: "ok", message: "round trip passed" },
    });
    const lastCheck = (helper.json as { lastCheck: Record<string, unknown> }).lastCheck;
    expect(JSON.parse(readFileSync(join(root, "data", "helper-check.json"), "utf8"))).toEqual({
      version: 1,
      at: lastCheck["at"],
      runtime: "claude",
      result: "ok",
      message: "round trip passed",
    });
    expect(logger.lines.some((l) => l.includes("helper check") && l.includes('"trigger":"automatic"'))).toBe(
      true,
    );

    // A core restart: an ok is recorded for the runtime in use, so no new request.
    expect((await send("POST", "restart", {})).json).toEqual({ restarting: true });
    await settled();
    expect(cores).toHaveLength(2);
    expect(checks.count).toBe(1);
    expect(((await get("helper")).json as { lastCheck: unknown }).lastCheck).toEqual(lastCheck);

    // A new process over the same data folder reads the record and does not check again.
    await first.stop();
    await boot();
    await settled();
    expect(checks.count).toBe(1);
    expect(((await get("helper")).json as { lastCheck: unknown }).lastCheck).toEqual(lastCheck);

    // The Check button still runs a real check and replaces the record.
    const manual = await send("POST", "helper/check");
    expect(manual).toMatchObject({ status: 200, json: { runtime: "claude", ok: true, code: "ok" } });
    expect(checks.count).toBe(2);
    expect(((await get("helper")).json as { lastCheck: unknown }).lastCheck).toEqual(manual.json);
    noSecretAnywhere();
  });

  it("after the helper runtime setting changes, the automatic check runs on the runtime now in use", async () => {
    shipped = ["claude", "codex"];
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    await settled();
    expect(checks.byRuntime).toEqual({ claude: 1, codex: 0 });
    expect((await send("PUT", "settings", { helperRuntime: "codex" })).status).toBe(202);
    await settled();
    expect(checks.byRuntime).toEqual({ claude: 1, codex: 1 });
    expect((await get("helper")).json).toMatchObject({ wouldUse: "codex", lastCheck: { runtime: "codex" } });
    // Saving something else restarts the core but spends no request.
    expect((await send("PUT", "settings", { asideAccount: "u2" })).status).toBe(202);
    await settled();
    expect(checks.byRuntime).toEqual({ claude: 1, codex: 1 });
  });

  it("no automatic check while the runtime's probe says it is not installed or not signed in", async () => {
    shipped = ["claude", "codex"];
    writeConfig({ publicPort: await freePort(), onboarding: { runtime: "codex" } });
    checks.probe.codex = { installed: true, signedIn: false };
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    await settled();
    checks.probe.codex = { installed: false, signedIn: null };
    expect((await send("POST", "restart", {})).status).toBe(202);
    await settled();
    expect(checks.count).toBe(0);
    expect((await get("helper")).json).toMatchObject({ wouldUse: null, lastCheck: null });
    expect(existsSync(join(root, "data", "helper-check.json"))).toBe(false);
  });

  it("a failed automatic check is recorded and retried only at the next core start", async () => {
    checks.code = "limit_reached";
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    await settled();
    expect(checks.count).toBe(1);
    expect((await get("helper")).json).toMatchObject({
      lastCheck: { runtime: "claude", ok: false, code: "limit_reached" },
    });
    checks.code = "ok";
    expect((await send("POST", "restart", {})).status).toBe(202);
    await settled();
    expect(checks.count).toBe(2);
    expect((await get("helper")).json).toMatchObject({ lastCheck: { ok: true, code: "ok" } });
  });

  it("helper runtime and browser account are saved to bridge.json and restart the core", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    const saved = await send("PUT", "settings", { helperRuntime: "claude", asideAccount: "u1" });
    expect(saved).toEqual({
      status: 202,
      json: { changed: ["helperRuntime", "asideAccount"], restarting: true, appsDisconnected: null },
    });
    await settled();
    expect(cores).toHaveLength(2);
    expect(cores[1]!.services.config.onboarding.runtime).toBe("claude");
    expect(cores[1]!.services.config.asideAccount).toBe("u1");
    const json = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ asideAccount: "u1", onboarding: { runtime: "claude" } });
  });

  it("ChatGPT setup, retry, and disconnect through the API; the runtime key never comes back", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    expect(await send("POST", "chatgpt/setup", { tunnelId: TUNNEL, runtimeKey: KEY })).toEqual({
      status: 202,
      json: { restarting: true },
    });
    await settled();
    expect((await get("chatgpt")).json).toMatchObject({
      state: "ready",
      managedBy: "bridge",
      tunnelId: TUNNEL,
      profile: "browser-research-bridge",
      keyStored: true,
    });
    expect(await send("POST", "chatgpt/retry")).toEqual({ status: 200, json: { state: "ready" } });
    expect(await send("POST", "chatgpt/setup", { tunnelId: TUNNEL, runtimeKey: KEY })).toMatchObject({
      status: 409,
      json: { error: "exists" },
    });
    expect((await send("DELETE", "chatgpt", {})).json).toEqual({ restarting: true });
    await settled();
    expect((await get("chatgpt")).json).toMatchObject({ state: "not_configured" });
    expect(await send("DELETE", "chatgpt", {})).toMatchObject({
      status: 409,
      json: { error: "not_configured" },
    });
    noSecretAnywhere();
  });

  it("Copy passphrase puts the .env passphrase on the clipboard through pbcopy's input only", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    expect(await send("POST", "settings/passphrase/clipboard")).toEqual({ status: 200, json: { ok: true } });
    expect(readFileSync(clip.out, "utf8")).toBe(OLD);
    expect(readFileSync(clip.args, "utf8")).toBe("0");
    // After a change on the page it copies the new value, also while the core restarts.
    expect((await send("PUT", "settings", { passphrase: NEW })).status).toBe(202);
    expect((await send("POST", "settings/passphrase/clipboard")).status).toBe(200);
    expect(readFileSync(clip.out, "utf8")).toBe(NEW);
    await settled();
    noSecretAnywhere();
  });

  it("Copy passphrase: not_set in setup mode, locked when set outside .env, unavailable without pbcopy", async () => {
    writeEnv("BRIDGE_PASSPHRASE=short\n");
    const p = await boot();
    expect(p.controller.status().mode).toBe("setup");
    expect(await send("POST", "settings/passphrase/clipboard")).toMatchObject({
      status: 409,
      json: { error: "not_set" },
    });
    await p.stop();

    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot({ BRIDGE_PASSPHRASE: "set by the service definition" });
    expect(await send("POST", "settings/passphrase/clipboard")).toMatchObject({
      status: 409,
      json: { error: "locked", fields: { passphrase: "locked" } },
    });
    expect(existsSync(clip.out)).toBe(false);
    await proc!.stop();

    clip.command = join(root, "no-such-pbcopy");
    await boot();
    expect(await send("POST", "settings/passphrase/clipboard")).toMatchObject({
      status: 500,
      json: { error: "unavailable" },
    });
    // Refused without the cookie or with a foreign Origin.
    const url = `${proc!.dashboard.url}/api/settings/passphrase/clipboard`;
    expect((await fetch(url, { method: "POST", headers: { origin: proc!.dashboard.url } })).status).toBe(403);
    expect(
      (await fetch(url, { method: "POST", headers: { cookie, origin: "https://evil.example" } })).status,
    ).toBe(403);
    noSecretAnywhere();
  });

  it("captchaAuto: read, saved to captcha.auto in bridge.json, restarts the core, refused when invalid", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    await boot();
    expect((await get("settings")).json).toMatchObject({ captchaAuto: true });
    expect(await send("PUT", "settings", { captchaAuto: true })).toEqual({
      status: 200,
      json: { changed: [], restarting: false, appsDisconnected: null },
    });
    expect(await send("PUT", "settings", { captchaAuto: "off" })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { captchaAuto: "bad_value" } },
    });
    expect(await send("PUT", "settings", { captchaAuto: false })).toEqual({
      status: 202,
      json: { changed: ["captchaAuto"], restarting: true, appsDisconnected: null },
    });
    await settled();
    expect(cores).toHaveLength(2);
    expect(cores[1]!.services.config.captcha.auto).toBe(false);
    const json = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(json["captcha"]).toEqual({ auto: false });
    expect((await get("settings")).json).toMatchObject({ captchaAuto: false });

    writeFileSync(join(root, "config", "bridge.json"), "{ not json");
    expect(await send("PUT", "settings", { captchaAuto: true })).toMatchObject({
      status: 409,
      json: { error: "file_unreadable" },
    });
    expect((await get("settings")).json).toMatchObject({ captchaAuto: null });
  });

  it("assistantAuto: read, saved to assistant.auto in bridge.json (keeping effort), restarts the core, refused when invalid", async () => {
    writeEnv(`BRIDGE_PASSPHRASE='${OLD}'\n`);
    const current = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8")) as object;
    writeConfig({ ...current, assistant: { effort: "medium" } });
    await boot();
    expect((await get("settings")).json).toMatchObject({ assistantAuto: true, captchaAuto: true });
    expect(cores[0]!.services.assistant.enabled).toBe(true);
    expect(await send("PUT", "settings", { assistantAuto: true })).toEqual({
      status: 200,
      json: { changed: [], restarting: false, appsDisconnected: null },
    });
    expect(await send("PUT", "settings", { assistantAuto: "off" })).toMatchObject({
      status: 400,
      json: { error: "invalid", fields: { assistantAuto: "bad_value" } },
    });
    expect(await send("PUT", "settings", { assistantAuto: false })).toEqual({
      status: 202,
      json: { changed: ["assistantAuto"], restarting: true, appsDisconnected: null },
    });
    await settled();
    expect(cores).toHaveLength(2);
    expect(cores[1]!.services.config.assistant).toEqual({ auto: false, effort: "medium" });
    expect(cores[1]!.services.assistant.enabled).toBe(false);
    const json = JSON.parse(readFileSync(join(root, "config", "bridge.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(json["assistant"]).toEqual({ effort: "medium", auto: false });
    expect((await get("settings")).json).toMatchObject({ assistantAuto: false });
    // The overview answers whether the Aside AI is available (unknown: this core was not probed).
    expect((await get("overview")).json).toMatchObject({ assistantAvailable: null });

    writeFileSync(join(root, "config", "bridge.json"), "{ not json");
    expect(await send("PUT", "settings", { assistantAuto: true })).toMatchObject({
      status: 409,
      json: { error: "file_unreadable" },
    });
    expect((await get("settings")).json).toMatchObject({ assistantAuto: null });
  });
});
