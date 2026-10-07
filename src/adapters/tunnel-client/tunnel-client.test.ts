import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../../ports/logger.js";
import type { ChildProcessHandle, CommandResult, ProcessRunner } from "./process.js";
import { classifyLine, classifyOutput } from "./output.js";
import {
  normalizeRuntimeKey,
  TunnelClientConnectionTool,
  type TunnelClientOptions,
} from "./tunnel-client.js";

const TUNNEL = `tunnel_${"0123456789abcdef".repeat(2)}`;
const KEY = "sk-proj-SECRETKEYVALUE-1234567890";
const TARGET = "http://127.0.0.1:8787/mcp";

class FakeChild implements ChildProcessHandle {
  readonly pid = 4242;
  readonly killed: string[] = [];
  /** When false, SIGTERM is ignored (only SIGKILL ends the process). */
  exitOnTerm = true;
  private lineListeners: Array<(line: string) => void> = [];
  private exitListeners: Array<
    (code: number | null, signal: string | null, spawnError?: "not_found") => void
  > = [];
  private exitArgs: [number | null, string | null, ("not_found" | undefined)?] | null = null;
  constructor(
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv,
  ) {}
  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }
  onExit(listener: (code: number | null, signal: string | null, spawnError?: "not_found") => void): void {
    if (this.exitArgs !== null) listener(...this.exitArgs);
    else this.exitListeners.push(listener);
  }
  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal);
    if (signal === "SIGKILL" || this.exitOnTerm) this.exit(null, signal);
  }
  failLaunch(): void {
    if (this.exitArgs !== null) return;
    this.exitArgs = [null, null, "not_found"];
    for (const l of this.exitListeners) l(null, null, "not_found");
  }
  emit(line: string): void {
    for (const l of this.lineListeners) l(line);
  }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exitArgs !== null) return;
    this.exitArgs = [code, signal];
    for (const l of this.exitListeners) l(code, signal);
  }
  get urlFile(): string {
    const index = this.args.indexOf("--health.url-file");
    return this.args[index + 1] ?? "";
  }
  /** Simulates the tool writing its resolved health base URL. */
  announce(url = "http://127.0.0.1:54321"): void {
    writeFileSync(this.urlFile, `${url}\n`);
  }
}

interface Call {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  readonly children: FakeChild[] = [];
  handler: (args: readonly string[]) => CommandResult | Promise<CommandResult> = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });
  onSpawn: (child: FakeChild) => void = () => undefined;
  async exec(
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ): Promise<CommandResult> {
    this.calls.push({ file, args, env: options.env });
    return this.handler(args);
  }
  spawn(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): ChildProcessHandle {
    this.calls.push({ file, args, env: options.env });
    const child = new FakeChild(args, options.env);
    this.children.push(child);
    queueMicrotask(() => this.onSpawn(child));
    return child;
  }
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Behaves like `tunnel-client` 0.0.14 for `--version`, `init`, and `doctor`. */
function toolLike(
  options: { initCode?: number; initWritesKey?: boolean; onInit?: () => Promise<void> } = {},
) {
  return async (args: readonly string[]): Promise<CommandResult> => {
    if (args[0] === "--version") {
      return { code: 0, stdout: "0.0.14+0f870e50 (git sha: 0f870e50)\n", stderr: "" };
    }
    if (args[0] === "init") {
      await options.onInit?.();
      const dir = argValue(args, "--profile-dir") ?? "";
      const profile = argValue(args, "--profile") ?? "";
      const ref = argValue(args, "--control-plane-api-key-ref") ?? "";
      const yaml =
        `config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "${argValue(args, "--tunnel-id")}"\n` +
        `  api_key: "${options.initWritesKey === true ? KEY : ref}"\nhealth:\n  listen_addr: "${argValue(args, "--health-listen-addr")}"\n` +
        `mcp:\n  server_urls:\n    - channel: main\n      url: "${argValue(args, "--mcp-server-url")}"`;
      await writeFile(join(dir, `${profile}.yaml`), yaml);
      if ((options.initCode ?? 0) !== 0) {
        return { code: options.initCode ?? 1, stdout: "", stderr: `error: something failed near ${KEY}\n` };
      }
      return { code: 0, stdout: "created\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields: LogFields | undefined }> = [];
  debug(message: string, fields?: LogFields) {
    this.entries.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields) {
    this.entries.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields) {
    this.entries.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields) {
    this.entries.push({ level: "error", message, fields });
  }
  text(): string {
    return JSON.stringify(this.entries);
  }
}

let root: string;
let keyDir: string;
let profileDir: string;
let runner: FakeRunner;
let logger: RecordingLogger;
let tools: TunnelClientConnectionTool[];

function make(extra: Partial<TunnelClientOptions> = {}): TunnelClientConnectionTool {
  const tool = new TunnelClientConnectionTool({
    binary: "/opt/fake/tunnel-client",
    keyDir,
    profileDir,
    runner,
    logger,
    probe: async () => 200,
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      CONTROL_PLANE_API_KEY: "sk-env-should-not-pass",
      OPENAI_API_KEY: "sk-env-should-not-pass",
      BRIDGE_PASSPHRASE: "do-not-pass-this-one",
      TUNNEL_CLIENT_PROFILE: "other",
      HEALTH_LISTEN_ADDR: "127.0.0.1:8080",
    },
    restartDelaysMs: [5, 10, 20],
    maxFailures: 3,
    readyTimeoutMs: 200,
    readyPollMs: 5,
    stopTimeoutMs: 30,
    ...extra,
  });
  tools.push(tool);
  return tool;
}

const input = (over: Record<string, unknown> = {}) => ({
  tunnelId: TUNNEL,
  runtimeKey: `${KEY}\n`,
  profileName: "browser-research-bridge",
  targetMcpUrl: TARGET,
  ...over,
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function assertNoSecretAnywhere(): void {
  for (const call of runner.calls) {
    expect(call.args.join(" ")).not.toContain(KEY);
    expect(JSON.stringify(call.env)).not.toContain(KEY);
    expect(call.env["CONTROL_PLANE_API_KEY"]).toBeUndefined();
    expect(call.env["OPENAI_API_KEY"]).toBeUndefined();
    expect(call.env["BRIDGE_PASSPHRASE"]).toBeUndefined();
    expect(call.env["TUNNEL_CLIENT_PROFILE"]).toBeUndefined();
    expect(call.env["HEALTH_LISTEN_ADDR"]).toBeUndefined();
  }
  expect(logger.text()).not.toContain(KEY);
  expect(logger.text()).not.toContain("SECRETKEY");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tc-test-"));
  keyDir = join(root, "config", "browser-research-bridge");
  profileDir = join(root, "config", "tunnel-client");
  runner = new FakeRunner();
  runner.handler = toolLike();
  logger = new RecordingLogger();
  tools = [];
});

afterEach(async () => {
  for (const tool of tools) await tool.stop();
  await rm(root, { recursive: true, force: true });
});

describe("detect", () => {
  it("reports installed and the version", async () => {
    expect(await make().detect()).toEqual({ installed: true, version: "0.0.14" });
    expect(runner.calls[0]).toMatchObject({ file: "/opt/fake/tunnel-client", args: ["--version"] });
  });

  it("reports not installed when the executable is missing", async () => {
    runner.handler = () => ({ code: null, stdout: "", stderr: "", failure: "not_found" });
    expect(await make().detect()).toEqual({ installed: false, version: null });
  });

  it("defaults to tunnel-client on PATH", async () => {
    const tool = new TunnelClientConnectionTool({ runner, keyDir, profileDir });
    await tool.detect();
    expect(runner.calls[0]?.file).toBe("tunnel-client");
  });
});

describe("prepare", () => {
  it("writes the key file first (0700 folder, 0600 file), then creates the profile with a file reference", async () => {
    const tool = make();
    const { keyFile, profileFile } = tool.paths("browser-research-bridge");
    let keyPresentAtInit = false;
    runner.handler = toolLike({
      onInit: async () => {
        keyPresentAtInit = (await readFile(keyFile, "utf8")) === KEY;
      },
    });

    const result = await tool.prepare(input());

    expect(result).toEqual({ ok: true, keyFile, profileFile });
    expect(keyFile).toBe(join(keyDir, "browser-research-bridge-runtime-key"));
    expect(profileFile).toBe(join(profileDir, "browser-research-bridge.yaml"));
    expect(keyPresentAtInit).toBe(true);
    expect((await stat(keyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(keyFile, "utf8")).toBe(KEY);

    const init = runner.calls.find((c) => c.args[0] === "init");
    expect(init?.args).toEqual([
      "init",
      "--sample",
      "sample_mcp_with_dcr",
      "--profile",
      "browser-research-bridge",
      "--profile-dir",
      profileDir,
      "--tunnel-id",
      TUNNEL,
      "--mcp-server-url",
      TARGET,
      "--control-plane-api-key-ref",
      `file:${keyFile}`,
      "--health-listen-addr",
      "127.0.0.1:0",
    ]);
    const yaml = await readFile(profileFile, "utf8");
    expect(yaml).toContain(`file:${keyFile}`);
    expect(yaml).not.toContain(KEY);
    expect(yaml.endsWith("\nharpoon:\n  allow_plaintext_http: true\n")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    assertNoSecretAnywhere();
  });

  it("refuses invalid input without touching anything", async () => {
    const tool = make();
    for (const bad of [
      { tunnelId: "tunnel_ABC" },
      { tunnelId: `tunnel_${"A".repeat(32)}` },
      { runtimeKey: "" },
      { runtimeKey: "two\nlines" },
      { profileName: "Bad_Name" },
      { profileName: "x".repeat(65) },
      { targetMcpUrl: "ftp://x/mcp" },
      { targetMcpUrl: "not a url" },
    ]) {
      expect(await tool.prepare(input(bad))).toMatchObject({ ok: false, error: "invalid_input" });
    }
    expect(runner.calls).toHaveLength(0);
    expect(await exists(keyDir)).toBe(false);
  });

  it("refuses with tool_missing before writing any file", async () => {
    runner.handler = () => ({ code: null, stdout: "", stderr: "", failure: "not_found" });
    expect(await make().prepare(input())).toMatchObject({ ok: false, error: "tool_missing" });
    expect(await exists(keyDir)).toBe(false);
    expect(await exists(profileDir)).toBe(false);
  });

  it("refuses with exists when the profile or the key file exists, and replace overwrites both", async () => {
    const tool = make();
    const { keyFile, profileFile } = tool.paths("browser-research-bridge");
    await mkdir(profileDir, { recursive: true });
    await writeFile(profileFile, "old profile\n");

    expect(await tool.prepare(input())).toMatchObject({ ok: false, error: "exists" });
    expect(await readFile(profileFile, "utf8")).toBe("old profile\n");
    expect(await exists(keyFile)).toBe(false);
    expect(runner.calls.some((c) => c.args[0] === "init")).toBe(false);

    await rm(profileFile);
    await mkdir(keyDir, { recursive: true });
    await writeFile(keyFile, "old-key");
    expect(await tool.prepare(input())).toMatchObject({ ok: false, error: "exists" });
    expect(await readFile(keyFile, "utf8")).toBe("old-key");

    await writeFile(profileFile, "old profile\n");
    expect(await tool.prepare(input({ replace: true }))).toMatchObject({ ok: true });
    expect(await readFile(keyFile, "utf8")).toBe(KEY);
    expect(await readFile(profileFile, "utf8")).toContain("allow_plaintext_http: true");
    const leftovers = readdirSync(keyDir).concat(readdirSync(profileDir));
    expect(leftovers.filter((f) => f.includes(".replaced-") || f.includes(".tmp-"))).toEqual([]);
  });

  it("removes everything it created when the profile cannot be created", async () => {
    runner.handler = toolLike({ initCode: 1 });
    const tool = make();
    const result = await tool.prepare(input());
    expect(result).toMatchObject({ ok: false, error: "profile_failed" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(await exists(keyDir)).toBe(false);
    expect(await exists(profileDir)).toBe(false);
    assertNoSecretAnywhere();
  });

  it("restores the replaced files when a replace fails midway", async () => {
    const tool = make();
    const { keyFile, profileFile } = tool.paths("browser-research-bridge");
    await mkdir(profileDir, { recursive: true });
    await mkdir(keyDir, { recursive: true });
    await writeFile(profileFile, "old profile\n");
    await writeFile(keyFile, "old-key");
    runner.handler = toolLike({ initCode: 2 });

    expect(await tool.prepare(input({ replace: true }))).toMatchObject({
      ok: false,
      error: "profile_failed",
    });
    expect(await readFile(profileFile, "utf8")).toBe("old profile\n");
    expect(await readFile(keyFile, "utf8")).toBe("old-key");
    expect(readdirSync(keyDir)).toEqual(["browser-research-bridge-runtime-key"]);
    expect(readdirSync(profileDir)).toEqual(["browser-research-bridge.yaml"]);
  });

  it("rejects and removes a profile that holds the key itself", async () => {
    runner.handler = toolLike({ initWritesKey: true });
    const tool = make();
    expect(await tool.prepare(input())).toMatchObject({ ok: false, error: "profile_failed" });
    expect(await exists(tool.paths("browser-research-bridge").profileFile)).toBe(false);
    expect(await exists(keyDir)).toBe(false);
  });

  it("reports key_write_failed when the key folder cannot be created", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(keyDir, "a file in the way");
    expect(await make().prepare(input())).toMatchObject({ ok: false, error: "key_write_failed" });
    expect(runner.calls.some((c) => c.args[0] === "init")).toBe(false);
    expect(await exists(profileDir)).toBe(false);
  });

  it("normalizes the key to one line", () => {
    expect(normalizeRuntimeKey("  abc \r\n")).toBe("abc");
    expect(normalizeRuntimeKey("a\nb")).toBeNull();
    expect(normalizeRuntimeKey("\n")).toBeNull();
  });
});

describe("removeKey", () => {
  it("deletes the key file and leaves the profile", async () => {
    const tool = make();
    await tool.prepare(input());
    const { keyFile, profileFile } = tool.paths("browser-research-bridge");
    await tool.removeKey("browser-research-bridge");
    expect(await exists(keyFile)).toBe(false);
    expect(await exists(profileFile)).toBe(true);
    await tool.removeKey("browser-research-bridge"); // absent is fine
  });
});

describe("run", () => {
  it("runs the profile on an OS-chosen loopback health port and reports ready from /readyz", async () => {
    const probed: string[] = [];
    let ready = false;
    const tool = make({
      probe: async (url) => {
        probed.push(url);
        return ready ? 200 : 503;
      },
    });
    runner.onSpawn = (child) => child.announce("http://127.0.0.1:54321");
    const states: string[] = [];
    tool.onStatusChange((s) => states.push(s.state));

    tool.start("browser-research-bridge");
    expect(tool.status().state).toBe("starting");
    const child = runner.children[0];
    expect(child?.args).toEqual([
      "run",
      "--profile",
      "browser-research-bridge",
      "--profile-dir",
      profileDir,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      join(keyDir, "browser-research-bridge-health.url"),
    ]);
    await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
    expect(tool.status().state).toBe("starting");
    ready = true;
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    expect(probed[0]).toBe("http://127.0.0.1:54321/readyz");
    expect(states).toEqual(["starting", "ready"]);

    tool.start("browser-research-bridge"); // no-op while ready
    expect(runner.children).toHaveLength(1);
    assertNoSecretAnywhere();
  });

  it("does not probe a non-loopback health URL", async () => {
    const probed: string[] = [];
    const tool = make({ probe: async (url) => (probed.push(url), 200) });
    runner.onSpawn = (child) => child.announce("http://203.0.113.5:8080");
    tool.start("p1");
    await new Promise((r) => setTimeout(r, 40));
    expect(probed).toEqual([]);
    expect(tool.status().state).toBe("starting");
  });

  it("restarts with increasing delay after exits and switches to failed after repeated failure", async () => {
    const tool = make({ probe: async () => 503 });
    const spawnTimes: number[] = [];
    runner.onSpawn = (child) => {
      spawnTimes.push(Date.now());
      child.emit(`{"level":"ERROR","msg":"control plane poll failed: 401 Unauthorized key=${KEY}"}`);
      child.exit(1);
    };
    tool.start("browser-research-bridge");
    await vi.waitFor(() => expect(tool.status().state).toBe("failed"));
    expect(runner.children).toHaveLength(3);
    const status = tool.status();
    expect(status.consecutiveFailures).toBe(3);
    expect(status.lastFailure?.kind).toBe("key_rejected");
    expect(status.lastFailure?.message).toBe("OpenAI rejected the runtime key.");
    const gaps = [spawnTimes[1]! - spawnTimes[0]!, spawnTimes[2]! - spawnTimes[1]!];
    expect(gaps[0]).toBeGreaterThanOrEqual(4);
    expect(gaps[1]).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(status)).not.toContain(KEY);
    assertNoSecretAnywhere();
    expect(logger.entries.some((e) => e.level === "warn" && e.fields?.["kind"] === "key_rejected")).toBe(
      true,
    );

    // Try again: starts from scratch with the count reset.
    runner.onSpawn = (child) => child.announce();
    tool.start("browser-research-bridge");
    expect(tool.status().consecutiveFailures).toBe(0);
    await vi.waitFor(() => expect(runner.children).toHaveLength(4));
  });

  it("restarts after an exit from ready and resets the failure count on ready", async () => {
    const tool = make();
    runner.onSpawn = (child) => child.announce();
    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    runner.children[0]?.exit(2);
    expect(tool.status()).toMatchObject({ state: "starting", consecutiveFailures: 1 });
    expect(tool.status().lastFailure?.kind).toBe("exited");
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    expect(runner.children).toHaveLength(2);
    expect(tool.status().consecutiveFailures).toBe(0);
  });

  it("fails with not_ready and the diagnostics summary when the tool never becomes ready", async () => {
    runner.handler = async (args) =>
      args[0] === "doctor"
        ? {
            code: 1,
            stdout: JSON.stringify({
              checks: [
                { name: "profile loads", status: "pass" },
                { name: "oauth metadata", status: "fail", detail: `secret ${KEY}` },
              ],
            }),
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    const tool = make({ probe: async () => 503, maxFailures: 1, readyTimeoutMs: 30 });
    runner.onSpawn = (child) => child.announce();
    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("failed"));
    expect(runner.children[0]?.killed[0]).toBe("SIGTERM");
    await vi.waitFor(() =>
      expect(tool.status().lastFailure?.message).toContain("Failed checks: oauth metadata."),
    );
    expect(tool.status().lastFailure?.kind).toBe("not_ready");
    expect(JSON.stringify(tool.status())).not.toContain(KEY);
    const doctor = runner.calls.find((c) => c.args[0] === "doctor");
    expect(doctor?.args).toEqual(["doctor", "--profile", "p1", "--profile-dir", profileDir, "--json"]);
    assertNoSecretAnywhere();
  });

  it("reports tool_missing at once when the executable cannot be launched", async () => {
    const tool = make();
    runner.onSpawn = (child) => child.failLaunch();
    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("failed"));
    expect(tool.status().lastFailure?.kind).toBe("tool_missing");
    expect(runner.children).toHaveLength(1);
  });

  it("stops gracefully with SIGTERM and cancels a pending restart", async () => {
    const tool = make({ restartDelaysMs: [10_000] });
    runner.onSpawn = (child) => child.announce();
    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    await tool.stop();
    expect(runner.children[0]?.killed).toEqual(["SIGTERM"]);
    expect(tool.status().state).toBe("stopped");
    expect(await exists(join(keyDir, "p1-health.url"))).toBe(false);

    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    runner.children[1]?.exit(1); // schedules a restart in 10 s
    expect(tool.status().state).toBe("starting");
    await tool.stop();
    expect(tool.status().state).toBe("stopped");
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.children).toHaveLength(2);
  });

  it("escalates to SIGKILL when the tool ignores SIGTERM", async () => {
    const tool = make();
    runner.onSpawn = (child) => {
      child.exitOnTerm = false;
      child.announce();
    };
    tool.start("p1");
    await vi.waitFor(() => expect(tool.status().state).toBe("ready"));
    await tool.stop();
    expect(runner.children[0]?.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tool.status().state).toBe("stopped");
  });

  it("refuses an invalid profile name without spawning", () => {
    const tool = make();
    tool.start("../evil");
    expect(tool.status().state).toBe("failed");
    expect(tool.status().lastFailure?.kind).toBe("invalid_input");
    expect(runner.children).toHaveLength(0);
  });
});

describe("diagnose", () => {
  it("summarizes a passing doctor run", async () => {
    runner.handler = () => ({ code: 0, stdout: '{"ok":true}', stderr: "" });
    expect(await make().diagnose("p1")).toEqual({
      ok: true,
      failedChecks: [],
      kinds: [],
      summary: "The connection tool's checks passed.",
    });
  });

  it("reduces unparseable failing output to kinds without raw text", async () => {
    runner.handler = () => ({
      code: 1,
      stdout: `FAIL harpoon host auto-registration failed: base URL must use https ${KEY}`,
      stderr: "",
    });
    const result = await make().diagnose("p1");
    expect(result.ok).toBe(false);
    expect(result.kinds).toEqual(["plaintext_http_blocked"]);
    expect(result.summary).toBe("The connection tool refused the program's local http sign-in addresses.");
    expect(JSON.stringify(result)).not.toContain(KEY);
    assertNoSecretAnywhere();
  });

  it("reports tool_missing", async () => {
    runner.handler = () => ({ code: null, stdout: "", stderr: "", failure: "not_found" });
    expect((await make().diagnose("p1")).kinds).toEqual(["tool_missing"]);
  });
});

describe("output reduction", () => {
  it("maps known tool messages to kinds", () => {
    expect(classifyLine("control plane API key is required")).toBe("key_missing");
    expect(classifyLine("file /x referenced by --control-plane.api-key is empty")).toBe("key_missing");
    expect(classifyLine("invalid tunnel ID")).toBe("tunnel_id_invalid");
    expect(classifyLine("harpoon host auto-registration failed for oauth-token-endpoint-0")).toBe(
      "plaintext_http_blocked",
    );
    expect(classifyLine("oauth discovery failed")).toBe("oauth_discovery_failed");
    expect(classifyLine("mcp probe failed: dial tcp 127.0.0.1:8787: connect: connection refused")).toBe(
      "mcp_unreachable",
    );
    expect(classifyLine("listen tcp 127.0.0.1:8080: bind: address already in use")).toBe("port_in_use");
    expect(classifyLine('{"level":"ERROR","msg":"something new"}')).toBe("tool_error");
    expect(classifyLine('{"level":"INFO","msg":"polling"}')).toBeNull();
    expect(classifyOutput("invalid tunnel ID\ninvalid tunnel ID\n403 Forbidden")).toEqual([
      "tunnel_id_invalid",
      "permission_denied",
    ]);
  });
});
