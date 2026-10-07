/**
 * The Claude entry of the helper runtime registry: jobs run on {@link ClaudeAgentRunner} (or an
 * injected runner), the check is one real round trip on a short-turn runner.
 *
 * Probe (no model call): installed when the Claude Agent SDK package resolves (it bundles the Claude
 * Code executable); signed in is `true` with a configured API key, otherwise `null` — the local
 * Claude Code login cannot be confirmed without a call, and reading its stored credentials is not
 * something the bridge does.
 */
import type { HelperCheckInput, HelperRuntime, RuntimeProbe } from "./helper-runtime.js";
import { classifyRoundTrip, helperRoundTrip } from "./helper-runtime.js";
import type { AgentRunner } from "./types.js";

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeHelperRuntimeOptions {
  /** Runs onboarding jobs. */
  runner: AgentRunner;
  /** Runs the check (a few turns); default `runner`. */
  checkRunner?: AgentRunner | undefined;
  /** `config.secrets.anthropicApiKey`. */
  apiKey: string | null;
  /** Replaces the local probe (tests). */
  probe?: (() => Promise<RuntimeProbe>) | undefined;
}

/** True when the Claude Agent SDK package can be resolved from this module. */
export function claudeSdkResolvable(): boolean {
  try {
    import.meta.resolve(CLAUDE_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

export function createClaudeHelperRuntime(options: ClaudeHelperRuntimeOptions): HelperRuntime {
  const checkRunner = options.checkRunner ?? options.runner;
  const hasKey = options.apiKey !== null && options.apiKey.trim() !== "";
  return {
    id: "claude",
    label: "Claude",
    signInHint: "sign in to Claude Code on this Mac",
    runner: options.runner,
    probe:
      options.probe ??
      (async () => ({ installed: claudeSdkResolvable(), signedIn: hasKey ? true : null })),
    async check(input: HelperCheckInput) {
      return classifyRoundTrip(await helperRoundTrip(checkRunner, input));
    },
  };
}
