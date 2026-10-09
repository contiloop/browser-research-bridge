/**
 * A fake `aside` executable for the assistant adapter's tests (the real Aside CLI is never run in tests).
 *
 * `FakeAsideCli.install(dir)` writes a small Node program into `dir` with an absolute-node shebang and
 * mode 0755, so the adapter spawns it exactly as it would spawn `aside`: the program's argv, working
 * directory, environment, and standard input are what the adapter gave it (no wrapper adds anything).
 * Every invocation appends one JSON line to a record file (argv, cwd, env, stdin, pid) before it acts.
 *
 * What it does per command is read from a behavior file the test sets with `setBehavior`:
 * - `exec …`: writes its output chunks a few milliseconds apart — the ordered `output` list (each chunk
 *   to stdout or stderr, for interleaving), else the `stderr` chunks and then the `stdout` chunks, as the
 *   real CLI prints its session line on stderr before the reply on stdout — then exits with `exitCode`,
 *   or hangs (`then: "hang"`), optionally ignoring SIGTERM (`ignoreTerm`);
 * - `account status`: exits with `exitCode` (default 0), or hangs (`hang`);
 * - `session stop …`: exits with `exitCode` (default 0).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One raw output chunk and the stream it is written to. */
export interface FakeOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface FakeExecBehavior {
  /** Raw stdout chunks, written in order a few milliseconds apart (after the `stderr` chunks). */
  stdout?: string[];
  /** Raw stderr chunks, written in order a few milliseconds apart (before the `stdout` chunks). */
  stderr?: string[];
  /** Raw chunks in this exact order across both streams; when set, `stdout` and `stderr` are ignored. */
  output?: FakeOutputChunk[];
  /** Exit code after the output (default 0); ignored when the program hangs. */
  exitCode?: number;
  /** `hang` keeps the process alive after the output until it is killed. */
  then?: "exit" | "hang";
  /** Ignore SIGTERM while hanging (only SIGKILL ends it). */
  ignoreTerm?: boolean;
}

export interface FakeAsideBehavior {
  exec?: FakeExecBehavior;
  status?: { exitCode?: number; hang?: boolean };
  stop?: { exitCode?: number };
}

export interface FakeAsideInvocation {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Everything the program could read from its standard input (empty when it is closed or /dev/null). */
  stdin: string;
  pid: number;
}

const PROGRAM = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
const behavior = JSON.parse(readFileSync(BEHAVIOR_FILE, "utf8"));
const argv = process.argv.slice(2);
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch (error) {
  stdin = "<unreadable: " + String(error && error.code) + ">";
}
appendFileSync(
  RECORD_FILE,
  JSON.stringify({ argv, cwd: process.cwd(), env: { ...process.env }, stdin, pid: process.pid }) + "\n",
);
const hang = () => setInterval(() => undefined, 60_000);
if (argv[0] === "account" && argv[1] === "status") {
  const status = behavior.status ?? {};
  if (status.hang) hang();
  else process.exitCode = status.exitCode ?? 0;
} else if (argv[0] === "session" && argv[1] === "stop") {
  process.exitCode = (behavior.stop ?? {}).exitCode ?? 0;
} else if (argv[0] === "exec") {
  const exec = behavior.exec ?? {};
  if (exec.ignoreTerm) process.on("SIGTERM", () => undefined);
  const chunks =
    exec.output ??
    [
      ...(exec.stderr ?? []).map((text) => ({ stream: "stderr", text })),
      ...(exec.stdout ?? []).map((text) => ({ stream: "stdout", text })),
    ];
  const next = (i) => {
    if (i < chunks.length) {
      (chunks[i].stream === "stderr" ? process.stderr : process.stdout).write(chunks[i].text);
      setTimeout(() => next(i + 1), 5);
      return;
    }
    if (exec.then === "hang") hang();
    else process.exitCode = exec.exitCode ?? 0;
  };
  next(0);
} else {
  process.stderr.write("fake aside: unknown command\n");
  process.exitCode = 64;
}
`;

export class FakeAsideCli {
  /** Absolute path of the fake executable (pass it as the adapter's `command`). */
  readonly command: string;
  private readonly recordFile: string;
  private readonly behaviorFile: string;

  private constructor(dir: string) {
    this.command = join(dir, "aside");
    this.recordFile = join(dir, "invocations.jsonl");
    this.behaviorFile = join(dir, "behavior.json");
  }

  static install(dir: string, behavior: FakeAsideBehavior = {}): FakeAsideCli {
    const cli = new FakeAsideCli(dir);
    cli.setBehavior(behavior);
    const source =
      `#!${process.execPath}\n` +
      `const BEHAVIOR_FILE = ${JSON.stringify(cli.behaviorFile)};\n` +
      `const RECORD_FILE = ${JSON.stringify(cli.recordFile)};\n` +
      PROGRAM;
    // Extensionless like the real CLI; Node's module syntax detection loads it as an ES module.
    writeFileSync(cli.command, source);
    chmodSync(cli.command, 0o755);
    return cli;
  }

  setBehavior(behavior: FakeAsideBehavior): void {
    writeFileSync(this.behaviorFile, JSON.stringify(behavior));
  }

  invocations(): FakeAsideInvocation[] {
    if (!existsSync(this.recordFile)) return [];
    return readFileSync(this.recordFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as FakeAsideInvocation);
  }

  /** Invocations whose argv starts with `prefix`. */
  calls(...prefix: string[]): FakeAsideInvocation[] {
    return this.invocations().filter((call) => prefix.every((part, i) => call.argv[i] === part));
  }
}

/** True while a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
