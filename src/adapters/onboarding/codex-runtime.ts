/**
 * The Codex entry of the helper runtime registry: jobs run on {@link CodexAgentRunner}, the check is
 * one real round trip on a short-turn runner.
 *
 * Probe (no model call): installed when `CODEX_BIN --version` exits 0; signed in from
 * `codex login status` against the user's Codex home (exit 0 → true, "Not logged in" → false,
 * anything else → null). Only exit codes and that one phrase are used; the output is not logged.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { codexEnv, runCodexCommand } from "./codex-runner.js";
import type { HelperCheckInput, HelperRuntime, RuntimeProbe } from "./helper-runtime.js";
import { classifyRoundTrip, helperRoundTrip } from "./helper-runtime.js";
import type { AgentRunner } from "./types.js";

/** Where the user's own Codex sign-in lives: `$CODEX_HOME`, else `~/.codex`. */
export function userCodexHome(env: NodeJS.ProcessEnv): string {
  const configured = env["CODEX_HOME"];
  return configured !== undefined && configured.trim() !== "" ? configured : join(homedir(), ".codex");
}

export interface CodexProbeInput {
  codexBin: string;
  userCodexHome: string;
  baseEnv: NodeJS.ProcessEnv;
  timeoutMs?: number | undefined;
}

export async function probeCodex(input: CodexProbeInput): Promise<RuntimeProbe> {
  const env = codexEnv(input.baseEnv, input.userCodexHome, dirname(process.execPath));
  const timeoutMs = input.timeoutMs ?? 15_000;
  const version = await runCodexCommand(input.codexBin, ["--version"], { env, timeoutMs });
  if (version.spawnError !== null || version.code !== 0) return { installed: false, signedIn: null };
  const status = await runCodexCommand(input.codexBin, ["login", "status"], { env, timeoutMs });
  if (status.spawnError !== null || status.code === null) return { installed: true, signedIn: null };
  if (status.code === 0) return { installed: true, signedIn: true };
  if (/not logged in/i.test(`${status.stdout}\n${status.stderr}`))
    return { installed: true, signedIn: false };
  return { installed: true, signedIn: null };
}

export interface CodexHelperRuntimeOptions {
  /** Runs onboarding jobs. */
  runner: AgentRunner;
  /** Runs the check (a few turns); default `runner`. */
  checkRunner?: AgentRunner | undefined;
  codexBin: string;
  userCodexHome: string;
  baseEnv: NodeJS.ProcessEnv;
  /** Replaces the local probe (tests). */
  probe?: (() => Promise<RuntimeProbe>) | undefined;
}

export function createCodexHelperRuntime(options: CodexHelperRuntimeOptions): HelperRuntime {
  const checkRunner = options.checkRunner ?? options.runner;
  return {
    id: "codex",
    label: "Codex",
    signInHint: "sign in to Codex on this Mac with `codex login`",
    runner: options.runner,
    probe:
      options.probe ??
      (() =>
        probeCodex({
          codexBin: options.codexBin,
          userCodexHome: options.userCodexHome,
          baseEnv: options.baseEnv,
        })),
    async check(input: HelperCheckInput) {
      return classifyRoundTrip(await helperRoundTrip(checkRunner, input));
    },
  };
}
