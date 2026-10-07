/**
 * Process seam of the connection-tool adapter. Short commands (`--version`, `init`, `doctor`) go
 * through `exec`; the long-lived `run` goes through `spawn`. Both use `execFile`/`spawn` without a
 * shell. Tests replace the whole `ProcessRunner` with a fake, so no real tool runs in unit tests.
 */
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CommandResult {
  /** Exit code, or null when the process did not exit normally (signal, timeout, launch failure). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not be run to completion. */
  failure?: "not_found" | "timeout" | "spawn_failed" | undefined;
}

export interface ExecOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ChildProcessHandle {
  readonly pid: number | undefined;
  /** Every stdout/stderr line, as text; the adapter reduces lines to error kinds and drops them. */
  onLine(listener: (line: string) => void): void;
  /** Fires exactly once, also when the launch itself failed (`spawnError` set). */
  onExit(
    listener: (code: number | null, signal: string | null, spawnError?: "not_found" | "spawn_failed") => void,
  ): void;
  kill(signal: NodeJS.Signals): void;
}

export interface ProcessRunner {
  exec(file: string, args: readonly string[], options: ExecOptions): Promise<CommandResult>;
  spawn(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): ChildProcessHandle;
}

const MAX_LINE = 8192;

export const nodeProcessRunner: ProcessRunner = {
  exec(file, args, options) {
    return new Promise((resolvePromise) => {
      execFile(
        file,
        [...args],
        { env: options.env, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGTERM" },
        (error, stdout, stderr) => {
          if (error === null) {
            resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          const err = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: unknown };
          const failure =
            err.code === "ENOENT" || err.code === "EACCES"
              ? "not_found"
              : err.killed === true && err.signal !== null
                ? "timeout"
                : typeof err.code === "number"
                  ? undefined
                  : "spawn_failed";
          resolvePromise({
            code: typeof err.code === "number" ? err.code : null,
            stdout: String(stdout),
            stderr: String(stderr),
            failure,
          });
        },
      );
    });
  },

  spawn(file, args, options) {
    const child = spawn(file, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<Parameters<ChildProcessHandle["onExit"]>[0]> = [];
    let exited = false;
    let exitArgs: [number | null, string | null, ("not_found" | "spawn_failed")?] | null = null;
    const finish = (
      code: number | null,
      signal: string | null,
      spawnError?: "not_found" | "spawn_failed",
    ) => {
      if (exited) return;
      exited = true;
      exitArgs = spawnError === undefined ? [code, signal] : [code, signal, spawnError];
      for (const listener of exitListeners) listener(...exitArgs);
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on("line", (line: string) => {
        const clipped = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
        for (const listener of lineListeners) listener(clipped);
      });
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) finish(null, null, error.code === "ENOENT" ? "not_found" : "spawn_failed");
    });
    child.on("exit", (code, signal) => finish(code, signal));
    return {
      get pid() {
        return child.pid;
      },
      onLine(listener) {
        lineListeners.push(listener);
      },
      onExit(listener) {
        if (exitArgs !== null) listener(...exitArgs);
        else exitListeners.push(listener);
      },
      kill(signal) {
        if (!exited) child.kill(signal);
      },
    };
  },
};

/** GET a loopback URL and return its HTTP status, or null when it could not be reached. */
export type HttpProbe = (url: string) => Promise<number | null>;

export const fetchProbe: HttpProbe = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
};
