/**
 * `ConnectionTool` implementation for OpenAI's `tunnel-client` (Secure MCP Tunnel). See AGENTS.md for
 * the confirmed invocations of version 0.0.14.
 *
 * Secrets: the runtime key exists in memory only inside `prepare`, where it is written to an
 * owner-only file. The tool receives it as `--control-plane-api-key-ref file:<path>` (a file
 * reference) and the child environment is an allowlist that never carries a key. Tool output is
 * reduced to error kinds (`output.ts`) before anything is logged or stored.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { systemClock, type Clock } from "../../ports/clock.js";
import type {
  ConnectionDiagnostics,
  ConnectionPaths,
  ConnectionTool,
  ConnectionToolErrorKind,
  ConnectionToolFailure,
  ConnectionToolInfo,
  ConnectionToolRunState,
  ConnectionToolStatus,
  PrepareConnectionInput,
  PrepareConnectionResult,
} from "../../ports/connection-tool.js";
import type { Logger } from "../../ports/logger.js";
import { classifyLine, classifyOutput, KIND_MESSAGES } from "./output.js";
import {
  fetchProbe,
  nodeProcessRunner,
  type ChildProcessHandle,
  type HttpProbe,
  type ProcessRunner,
} from "./process.js";

export const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
export const PROFILE_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
/** The sample `init` materializes; it fits an HTTP MCP server with OAuth/DCR metadata. */
export const PROFILE_SAMPLE = "sample_mcp_with_dcr";
/** The tool's own status listener: loopback, port chosen by the OS, so it never collides with 8080. */
export const HEALTH_LISTEN_ADDR = "127.0.0.1:0";
const HARPOON_BLOCK = "harpoon:\n  allow_plaintext_http: true\n";

/** Environment variables the child may inherit. Everything else (keys, BRIDGE_*, tool overrides) is dropped. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export interface TunnelClientOptions {
  /** Executable; default `tunnel-client` on PATH. The composition fills it from `TUNNEL_CLIENT_BIN`. */
  binary?: string | undefined;
  /** Owner-only folder for key files; default `~/.config/browser-research-bridge`. */
  keyDir?: string | undefined;
  /** The tool's profile folder; default `$XDG_CONFIG_HOME/tunnel-client` or `~/.config/tunnel-client`. */
  profileDir?: string | undefined;
  /** Owner-only folder for the health URL file; default `keyDir`. */
  stateDir?: string | undefined;
  runner?: ProcessRunner | undefined;
  probe?: HttpProbe | undefined;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  /** Environment the child allowlist is taken from; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Delay before restart attempt n (the last value repeats). Default 1 s, 2 s, 5 s, 10 s, 30 s. */
  restartDelaysMs?: readonly number[] | undefined;
  /** Consecutive failed attempts that switch the state to `failed`. Default 5. */
  maxFailures?: number | undefined;
  /** How long one attempt may take to report ready. Default 60 s. */
  readyTimeoutMs?: number | undefined;
  /** Readiness poll interval. Default 500 ms. */
  readyPollMs?: number | undefined;
  /** Wait after SIGTERM before SIGKILL. Default 10 s. */
  stopTimeoutMs?: number | undefined;
  /** Timeout of `--version` and `init`. Default 15 s. */
  commandTimeoutMs?: number | undefined;
  /** Timeout of `doctor`. Default 60 s. */
  doctorTimeoutMs?: number | undefined;
}

type PrepareError = Extract<PrepareConnectionResult, { ok: false }>["error"];

class PrepareFailure extends Error {
  constructor(
    readonly kind: PrepareError,
    message: string,
  ) {
    super(message);
  }
}

function defaultProfileDir(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_CONFIG_HOME"];
  return join(xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config"), "tunnel-client");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** One non-empty line; surrounding spaces and one trailing line break are tolerated. */
export function normalizeRuntimeKey(raw: string): string | null {
  const key = raw.replace(/\r?\n$/, "").trim();
  if (key === "" || /[\r\n\0]/.test(key)) return null;
  return key;
}

function validTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function sanitizeCheckName(value: string): string {
  return value.replace(/[^\w .:/()-]/g, "").slice(0, 80);
}

/** Collects names of failed checks from the tool's `doctor --json` output, whatever its nesting. */
function failedChecksFromJson(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length >= 10 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) failedChecksFromJson(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const name = [record["name"], record["id"], record["check"], record["title"]].find(
    (v) => typeof v === "string",
  );
  const status = [record["status"], record["result"], record["state"], record["level"]].find(
    (v) => typeof v === "string",
  );
  const failed =
    (typeof status === "string" && /^(fail|failed|failure|error)$/i.test(status)) ||
    record["ok"] === false ||
    record["passed"] === false;
  if (typeof name === "string" && failed) {
    const clean = sanitizeCheckName(name);
    if (clean !== "" && !out.includes(clean)) out.push(clean);
  }
  for (const child of Object.values(record)) failedChecksFromJson(child, out, depth + 1);
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export class TunnelClientConnectionTool implements ConnectionTool {
  private readonly binary: string;
  private readonly keyDir: string;
  private readonly profileDir: string;
  private readonly stateDir: string;
  private readonly runner: ProcessRunner;
  private readonly probe: HttpProbe;
  private readonly logger: Logger | undefined;
  private readonly clock: Clock;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly restartDelaysMs: readonly number[];
  private readonly maxFailures: number;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly stopTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly doctorTimeoutMs: number;

  private state: ConnectionToolRunState = "stopped";
  private profileName: string | null = null;
  private lastFailure: ConnectionToolFailure | null = null;
  private failures = 0;
  private generation = 0;
  private child: ChildProcessHandle | null = null;
  private attemptKind: ConnectionToolErrorKind | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: ConnectionToolStatus) => void>();

  constructor(options: TunnelClientOptions = {}) {
    const baseEnv = options.baseEnv ?? process.env;
    this.binary = options.binary !== undefined && options.binary !== "" ? options.binary : "tunnel-client";
    this.keyDir = resolve(options.keyDir ?? join(homedir(), ".config", "browser-research-bridge"));
    this.profileDir = resolve(options.profileDir ?? defaultProfileDir(baseEnv));
    this.stateDir = resolve(options.stateDir ?? this.keyDir);
    this.runner = options.runner ?? nodeProcessRunner;
    this.probe = options.probe ?? fetchProbe;
    this.logger = options.logger;
    this.clock = options.clock ?? systemClock;
    this.childEnv = {};
    for (const name of ENV_ALLOWLIST) {
      const value = baseEnv[name];
      if (value !== undefined) this.childEnv[name] = value;
    }
    const delays = options.restartDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];
    this.restartDelaysMs = delays.length > 0 ? delays : [1000];
    this.maxFailures = Math.max(1, options.maxFailures ?? 5);
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.readyPollMs = options.readyPollMs ?? 500;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.doctorTimeoutMs = options.doctorTimeoutMs ?? 60_000;
  }

  // ------------------------------------------------------------------ detect

  async detect(): Promise<ConnectionToolInfo> {
    const result = await this.runner.exec(this.binary, ["--version"], {
      env: this.env(),
      timeoutMs: this.commandTimeoutMs,
    });
    if (result.failure === "not_found") return { installed: false, version: null };
    if (result.failure === "spawn_failed" && result.code === null) return { installed: false, version: null };
    const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
    return { installed: true, version: result.code === 0 && match?.[1] !== undefined ? match[1] : null };
  }

  // ------------------------------------------------------------------ files

  paths(profileName: string): ConnectionPaths {
    return {
      profileFile: join(this.profileDir, `${profileName}.yaml`),
      keyFile: join(this.keyDir, `${profileName}-runtime-key`),
    };
  }

  private healthUrlFile(profileName: string): string {
    return join(this.stateDir, `${profileName}-health.url`);
  }

  async removeKey(profileName: string): Promise<void> {
    if (!PROFILE_NAME_PATTERN.test(profileName)) return;
    await rm(this.paths(profileName).keyFile, { force: true });
    await rm(this.healthUrlFile(profileName), { force: true });
    this.logger?.info("connection key file removed", { profile: profileName });
  }

  // ------------------------------------------------------------------ prepare

  async prepare(input: PrepareConnectionInput): Promise<PrepareConnectionResult> {
    const key = normalizeRuntimeKey(input.runtimeKey);
    if (
      !TUNNEL_ID_PATTERN.test(input.tunnelId) ||
      key === null ||
      !PROFILE_NAME_PATTERN.test(input.profileName) ||
      !validTarget(input.targetMcpUrl)
    ) {
      return { ok: false, error: "invalid_input", message: KIND_MESSAGES.invalid_input };
    }
    const profile = input.profileName;
    const { profileFile, keyFile } = this.paths(profile);
    const replace = input.replace === true;

    const info = await this.detect();
    if (!info.installed) return { ok: false, error: "tool_missing", message: KIND_MESSAGES.tool_missing };

    const [profileExists, keyExists] = await Promise.all([pathExists(profileFile), pathExists(keyFile)]);
    if ((profileExists || keyExists) && !replace) {
      return { ok: false, error: "exists", message: KIND_MESSAGES.exists };
    }

    const undo: Array<() => Promise<void>> = [];
    const backups: string[] = [];
    let step = "key";
    try {
      // 1. Owner-only key folder and file.
      const keyDirExisted = await pathExists(this.keyDir);
      try {
        await mkdir(this.keyDir, { recursive: true, mode: 0o700 });
        await chmod(this.keyDir, 0o700);
      } catch {
        throw new PrepareFailure("key_write_failed", KIND_MESSAGES.key_write_failed);
      }
      if (!keyDirExisted) undo.push(() => rmdir(this.keyDir).catch(() => undefined));
      if (keyExists) await this.setAside(keyFile, undo, backups, "key_write_failed");
      await this.writeKeyFile(keyFile, key, undo);

      // 2. Profile through the tool, holding only the key file's location.
      step = "profile";
      const profileDirExisted = await pathExists(this.profileDir);
      try {
        await mkdir(this.profileDir, { recursive: true });
      } catch {
        throw new PrepareFailure("profile_failed", KIND_MESSAGES.profile_failed);
      }
      if (!profileDirExisted) undo.push(() => rmdir(this.profileDir).catch(() => undefined));
      if (profileExists) await this.setAside(profileFile, undo, backups, "profile_failed");
      undo.push(() => rm(profileFile, { force: true }));
      const result = await this.runner.exec(
        this.binary,
        [
          "init",
          "--sample",
          PROFILE_SAMPLE,
          "--profile",
          profile,
          "--profile-dir",
          this.profileDir,
          "--tunnel-id",
          input.tunnelId,
          "--mcp-server-url",
          input.targetMcpUrl,
          "--control-plane-api-key-ref",
          `file:${keyFile}`,
          "--health-listen-addr",
          HEALTH_LISTEN_ADDR,
        ],
        { env: this.env(), timeoutMs: this.commandTimeoutMs },
      );
      if (result.failure === "not_found")
        throw new PrepareFailure("tool_missing", KIND_MESSAGES.tool_missing);
      if (result.code !== 0) {
        const kinds = classifyOutput(`${result.stdout}\n${result.stderr}`);
        this.logger?.warn("connection profile init failed", {
          profile,
          code: result.code,
          failure: result.failure ?? null,
          kind: kinds[0] ?? null,
        });
        throw new PrepareFailure("profile_failed", KIND_MESSAGES.profile_failed);
      }

      // 3. Allow the program's loopback plain-http OAuth endpoints.
      let content: string;
      try {
        content = await readFile(profileFile, "utf8");
      } catch {
        throw new PrepareFailure("profile_failed", KIND_MESSAGES.profile_failed);
      }
      if (content.includes(key) || !content.includes(keyFile)) {
        // The profile must reference the key file and never hold the key itself.
        throw new PrepareFailure("profile_failed", KIND_MESSAGES.profile_failed);
      }
      if (/^harpoon\s*:/m.test(content)) {
        if (!/^\s+allow_plaintext_http\s*:\s*true\s*$/m.test(content)) {
          throw new PrepareFailure("profile_failed", KIND_MESSAGES.profile_failed);
        }
      } else {
        await appendFile(
          profileFile,
          `${content.endsWith("\n") || content === "" ? "" : "\n"}${HARPOON_BLOCK}`,
        );
      }

      for (const backup of backups) await rm(backup, { force: true });
      this.logger?.info("connection profile prepared", { profile, replaced: profileExists || keyExists });
      return { ok: true, profileFile, keyFile };
    } catch (error) {
      for (const action of undo.reverse()) {
        try {
          await action();
        } catch {
          // best effort; continue undoing the rest
        }
      }
      const failure =
        error instanceof PrepareFailure
          ? error
          : new PrepareFailure(
              step === "key" ? "key_write_failed" : "profile_failed",
              step === "key" ? KIND_MESSAGES.key_write_failed : KIND_MESSAGES.profile_failed,
            );
      this.logger?.warn("connection setup failed", { profile, kind: failure.kind, step });
      return { ok: false, error: failure.kind, message: failure.message };
    }
  }

  private async setAside(
    file: string,
    undo: Array<() => Promise<void>>,
    backups: string[],
    kind: PrepareError,
  ): Promise<void> {
    const backup = `${file}.replaced-${randomUUID().slice(0, 8)}`;
    try {
      await rename(file, backup);
    } catch {
      throw new PrepareFailure(kind, KIND_MESSAGES[kind]);
    }
    backups.push(backup);
    undo.push(async () => {
      await rm(file, { force: true });
      await rename(backup, file);
    });
  }

  private async writeKeyFile(keyFile: string, key: string, undo: Array<() => Promise<void>>): Promise<void> {
    const tmp = `${keyFile}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(key, "utf8");
      } finally {
        await handle.close();
      }
      await chmod(tmp, 0o600);
      undo.push(() => rm(keyFile, { force: true }));
      await rename(tmp, keyFile);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new PrepareFailure("key_write_failed", KIND_MESSAGES.key_write_failed);
    }
  }

  // ------------------------------------------------------------------ diagnostics

  async diagnose(profileName: string): Promise<ConnectionDiagnostics> {
    if (!PROFILE_NAME_PATTERN.test(profileName)) {
      return { ok: false, failedChecks: [], kinds: ["invalid_input"], summary: KIND_MESSAGES.invalid_input };
    }
    const result = await this.runner.exec(
      this.binary,
      ["doctor", "--profile", profileName, "--profile-dir", this.profileDir, "--json"],
      { env: this.env(), timeoutMs: this.doctorTimeoutMs },
    );
    if (result.failure === "not_found") {
      return { ok: false, failedChecks: [], kinds: ["tool_missing"], summary: KIND_MESSAGES.tool_missing };
    }
    const ok = result.code === 0 && result.failure === undefined;
    const failedChecks: string[] = [];
    failedChecksFromJson(parseJsonLoose(result.stdout), failedChecks);
    const kinds = ok ? [] : classifyOutput(`${result.stdout}\n${result.stderr}`);
    let summary: string;
    if (ok) summary = "The connection tool's checks passed.";
    else if (result.failure === "timeout") summary = "The connection tool's checks did not finish in time.";
    else {
      const parts: string[] = [];
      if (failedChecks.length > 0) parts.push(`Failed checks: ${failedChecks.join(", ")}.`);
      const firstKind = kinds.find((k) => k !== "tool_error");
      if (firstKind !== undefined) parts.push(KIND_MESSAGES[firstKind]);
      summary = parts.length > 0 ? parts.join(" ") : "The connection tool's checks did not pass.";
    }
    this.logger?.info("connection tool diagnostics", {
      profile: profileName,
      ok,
      failedChecks: failedChecks.length,
      kind: kinds[0] ?? null,
    });
    return { ok, failedChecks, kinds, summary };
  }

  // ------------------------------------------------------------------ run

  status(): ConnectionToolStatus {
    return {
      state: this.state,
      profileName: this.profileName,
      lastFailure: this.lastFailure === null ? null : { ...this.lastFailure },
      consecutiveFailures: this.failures,
    };
  }

  onStatusChange(listener: (status: ConnectionToolStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(profileName: string): void {
    if (!PROFILE_NAME_PATTERN.test(profileName)) {
      this.profileName = profileName.slice(0, 64);
      this.failures = 0;
      this.recordFailure("invalid_input");
      this.setState("failed");
      return;
    }
    if ((this.state === "starting" || this.state === "ready") && this.profileName === profileName) return;
    this.halt();
    this.profileName = profileName;
    this.failures = 0;
    this.launch();
  }

  async stop(): Promise<void> {
    const child = this.halt();
    if (child !== null) await this.terminate(child);
    if (this.profileName !== null) rmSync(this.healthUrlFile(this.profileName), { force: true });
    if (this.state !== "stopped") {
      this.logger?.info("connection tool stopped", { profile: this.profileName });
      this.setState("stopped");
    }
  }

  /** Invalidates the current attempt and returns its child (if any) without waiting for it. */
  private halt(): ChildProcessHandle | null {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    return child;
  }

  private terminate(child: ChildProcessHandle): Promise<void> {
    return new Promise((resolvePromise) => {
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (killTimer !== null) clearTimeout(killTimer);
        if (giveUpTimer !== null) clearTimeout(giveUpTimer);
        resolvePromise();
      };
      child.onExit(finish);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (done) return;
        this.logger?.warn("connection tool did not exit; killing it", { profile: this.profileName });
        child.kill("SIGKILL");
        giveUpTimer = setTimeout(finish, this.stopTimeoutMs);
      }, this.stopTimeoutMs);
    });
  }

  private launch(): void {
    const profile = this.profileName;
    if (profile === null) return;
    this.generation += 1;
    const gen = this.generation;
    this.timer = null;
    this.attemptKind = null;
    this.setState("starting");
    const urlFile = this.healthUrlFile(profile);
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      rmSync(urlFile, { force: true });
    } catch {
      // the attempt will fail readiness and be reported
    }
    const child = this.runner.spawn(
      this.binary,
      [
        "run",
        "--profile",
        profile,
        "--profile-dir",
        this.profileDir,
        "--health.listen-addr",
        HEALTH_LISTEN_ADDR,
        "--health.url-file",
        urlFile,
      ],
      { env: this.env() },
    );
    this.child = child;
    child.onLine((line) => {
      if (gen !== this.generation) return;
      const kind = classifyLine(line);
      if (kind !== null && kind !== this.attemptKind) {
        this.attemptKind = kind;
        this.logger?.warn("connection tool reported a problem", { profile, kind });
      }
    });
    child.onExit((code, signal, spawnError) => {
      if (gen !== this.generation) return;
      this.child = null;
      const kind: ConnectionToolErrorKind =
        spawnError === "not_found"
          ? "tool_missing"
          : spawnError === "spawn_failed"
            ? "spawn_failed"
            : (this.attemptKind ?? "exited");
      this.logger?.warn("connection tool exited", { profile, code, signal, kind });
      this.attemptFailed(kind);
    });
    this.logger?.info("connection tool started", { profile, pid: child.pid ?? null });
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      if (gen !== this.generation || this.state !== "starting") return;
      const base = this.readHealthBase(urlFile);
      if (base !== null) {
        const status = await this.probe(`${base}/readyz`);
        if (gen !== this.generation || this.state !== "starting") return;
        if (status === 200) {
          this.failures = 0;
          this.logger?.info("connection tool ready", { profile });
          this.setState("ready");
          return;
        }
      }
      if (Date.now() - startedAt >= this.readyTimeoutMs) {
        const stuck = this.halt();
        if (stuck !== null) void this.terminate(stuck);
        this.logger?.warn("connection tool not ready in time", { profile, kind: this.attemptKind });
        this.attemptFailed(this.attemptKind ?? "not_ready", true);
        return;
      }
      this.timer = setTimeout(() => void poll(), this.readyPollMs);
    };
    this.timer = setTimeout(() => void poll(), Math.min(this.readyPollMs, 100));
  }

  private readHealthBase(urlFile: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(urlFile, "utf8").trim();
    } catch {
      return null;
    }
    try {
      const url = new URL(raw);
      const host = url.hostname;
      if (url.protocol !== "http:" || !(host === "127.0.0.1" || host === "localhost" || host === "[::1]"))
        return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  private attemptFailed(kind: ConnectionToolErrorKind, notReady = false): void {
    this.halt();
    this.failures += 1;
    this.recordFailure(kind);
    const profile = this.profileName;
    if (kind === "tool_missing" || this.failures >= this.maxFailures) {
      this.logger?.error("connection tool failed", { profile, kind, failures: this.failures });
      this.setState("failed");
      if (notReady && profile !== null) void this.attachDiagnostics(profile, this.generation);
      return;
    }
    const delays = this.restartDelaysMs;
    const delay = delays[Math.min(this.failures - 1, delays.length - 1)] ?? 1000;
    this.setState("starting");
    const gen = this.generation;
    this.timer = setTimeout(() => {
      if (gen === this.generation) this.launch();
    }, delay);
  }

  /** On a final not-ready failure, replaces the message with the tool's diagnostics summary. */
  private async attachDiagnostics(profile: string, gen: number): Promise<void> {
    const diagnostics = await this.diagnose(profile);
    if (gen !== this.generation || this.state !== "failed" || this.lastFailure === null) return;
    this.lastFailure = {
      ...this.lastFailure,
      message: `${KIND_MESSAGES[this.lastFailure.kind]} ${diagnostics.summary}`,
    };
    this.notify();
  }

  private recordFailure(kind: ConnectionToolErrorKind): void {
    this.lastFailure = { kind, message: KIND_MESSAGES[kind], at: this.clock.now().toISOString() };
  }

  private setState(state: ConnectionToolRunState): void {
    this.state = state;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // a listener must not break the manager
      }
    }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...this.childEnv };
  }
}
