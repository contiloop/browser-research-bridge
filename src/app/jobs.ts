/**
 * Composition of the onboarding job service: binds the job service to the bridge's
 * registry, validator, browser port, scheduler, swap/remove operations, git committer, and the
 * Claude Agent SDK runner configured from `config.onboarding` (model, effort) and
 * `config.secrets.anthropicApiKey` (else the local Claude Code login), registered in the helper
 * runtime registry with `config.onboarding.runtime` as the configured choice, next to
 * the Codex CLI runner (`config.executables.codex`, `config.onboarding.codexModel`, the bridge's own
 * Codex home under the data folder, the user's Codex sign-in). Runtimes are added here, not in the
 * job service.
 *
 * `BRIDGE_ONBOARDING_MAX_TURNS` overrides the agent's turn limit (default 80).
 */
import { join } from "node:path";
import {
  ClaudeAgentRunner,
  CodexAgentRunner,
  DEFAULT_MAX_TURNS,
  FileJobStore,
  HelperRuntimes,
  OnboardingJobService,
  SiteStagingValidation,
  createClaudeHelperRuntime,
  createCodexHelperRuntime,
  jobsDir,
  userCodexHome,
} from "../adapters/onboarding/index.js";
import type { AgentRunner, HelperRuntimeId, RuntimeProbe } from "../adapters/onboarding/index.js";
import { promoteStaging, removeSite } from "../adapters/registry/index.js";
import type { SiteOperationsDeps } from "../adapters/registry/index.js";
import type { BridgeServices } from "./app.js";

export type OnboardingDeps = Pick<
  BridgeServices,
  | "config"
  | "logger"
  | "clock"
  | "repoRoot"
  | "browser"
  | "scheduler"
  | "registry"
  | "validator"
  | "committer"
  | "manifestOptions"
>;

export interface CreateOnboardingJobsOptions {
  /** Replaces the Claude Agent SDK runner of jobs and of the helper check (tests). */
  runner?: AgentRunner | undefined;
  /** Replaces the Codex runner of jobs and of the helper check (tests). */
  codexRunner?: AgentRunner | undefined;
  /** Replaces the local Codex probe (tests). */
  codexProbe?: (() => Promise<RuntimeProbe>) | undefined;
  /** Replaces the whole helper runtime registry (tests); `runner` is then ignored. */
  runtimes?: HelperRuntimes | undefined;
  /** Agent turn limit (default: `BRIDGE_ONBOARDING_MAX_TURNS`, else 80). */
  maxTurns?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export function onboardingMaxTurns(env: NodeJS.ProcessEnv): number {
  const raw = env["BRIDGE_ONBOARDING_MAX_TURNS"];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : DEFAULT_MAX_TURNS;
}

export function createOnboardingJobs(
  deps: OnboardingDeps,
  options: CreateOnboardingJobsOptions = {},
): OnboardingJobService {
  const { config, logger, registry } = deps;
  const env = options.env ?? process.env;
  const opsDeps: SiteOperationsDeps = {
    registry,
    repoRoot: deps.repoRoot,
    committer: deps.committer,
    scheduler: deps.scheduler,
    logger,
  };
  const runtimes = options.runtimes ?? createHelperRuntimes(deps, options, env);
  return new OnboardingJobService({
    registry,
    store: new FileJobStore(jobsDir(config.dataDir)),
    runtimes,
    validation: new SiteStagingValidation({
      validator: deps.validator,
      sitesDir: config.sitesDir,
      repoRoot: deps.repoRoot,
      manifestOptions: deps.manifestOptions,
      hostnameOwner: (h) => registry.hostnameOwner(h),
    }),
    operations: {
      promote: (key, action) => promoteStaging(opsDeps, key, { action }),
      remove: (key, removeOptions) => removeSite(opsDeps, key, removeOptions),
    },
    browser: deps.browser,
    scheduler: deps.scheduler,
    repoRoot: deps.repoRoot,
    sitesDir: config.sitesDir,
    workRoot: join(jobsDir(config.dataDir), "work"),
    asideAccount: config.asideAccount,
    defaultMinIntervalMs: config.tunables.defaultMinIntervalMs,
    stepBudgetMs: config.tunables.adapterStepTimeoutMs + 30_000,
    captchaAttemptBudgetMs: config.tunables.captchaAttemptBudgetMs,
    captchaAuto: config.captcha.auto,
    clock: deps.clock,
    logger,
  });
}

/** Where the bridge keeps its own Codex home (sessions, the restricted model list, the sign-in link). */
export function bridgeCodexHome(dataDir: string): string {
  return join(dataDir, "codex-home");
}

/**
 * The runtimes this build ships, in canonical order: what {@link createHelperRuntimes} registers.
 * The settings page reads it while the core is off (`GET settings` → `helperRuntime.supported`).
 */
export const SHIPPED_HELPER_RUNTIMES: readonly HelperRuntimeId[] = ["claude", "codex"];

/** The runtimes this build ships (Claude and Codex) and the configured choice. */
export function createHelperRuntimes(
  deps: Pick<OnboardingDeps, "config" | "logger" | "clock">,
  options: Pick<CreateOnboardingJobsOptions, "runner" | "codexRunner" | "codexProbe" | "maxTurns"> = {},
  env: NodeJS.ProcessEnv = process.env,
): HelperRuntimes {
  const { config, logger } = deps;
  const claude = (maxTurns: number): AgentRunner =>
    new ClaudeAgentRunner({
      model: config.onboarding.model,
      effort: config.onboarding.effort,
      maxTurns,
      apiKey: config.secrets.anthropicApiKey,
      baseEnv: env,
      logger,
    });
  const codexUserHome = userCodexHome(env);
  const codex = (maxTurns: number): AgentRunner =>
    new CodexAgentRunner({
      codexBin: config.executables.codex,
      model: config.onboarding.codexModel,
      codexHome: bridgeCodexHome(config.dataDir),
      userCodexHome: codexUserHome,
      maxTurns,
      baseEnv: env,
      logger,
    });
  return new HelperRuntimes({
    configured: config.onboarding.runtime,
    runtimes: [
      createClaudeHelperRuntime({
        runner: options.runner ?? claude(options.maxTurns ?? onboardingMaxTurns(env)),
        // The check is a few turns: authentication and one tool call.
        checkRunner: options.runner ?? claude(4),
        apiKey: config.secrets.anthropicApiKey,
      }),
      createCodexHelperRuntime({
        runner: options.codexRunner ?? codex(options.maxTurns ?? onboardingMaxTurns(env)),
        checkRunner: options.codexRunner ?? codex(4),
        codexBin: config.executables.codex,
        userCodexHome: codexUserHome,
        baseEnv: env,
        probe: options.codexProbe,
      }),
    ],
    now: () => deps.clock.now(),
  });
}
