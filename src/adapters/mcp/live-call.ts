/**
 * One live adapter call: load the site's adapter, run the
 * call under the site lock within the remaining tool-call budget, map anything thrown to a failure
 * outcome, and feed the outcome back into the site lifecycle.
 */
import type { Outcome } from "../../core/models.js";
import { OutcomeError, errorToOutcome, withOutcomeDefaults } from "../../core/outcome.js";
import type { AdapterContext } from "../../ports/adapter.js";
import type { LoadedSiteAdapter } from "../../ports/registry.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteTaskRunner, ToolRegistry } from "./deps.js";
import { errorMessage } from "./deps.js";

export interface LiveCallContext {
  registry: ToolRegistry;
  runSiteTask: SiteTaskRunner;
  logger: Logger;
  clock: Clock;
}

export type LiveCallResult<T> =
  { ok: true; value: T; loaded: LoadedSiteAdapter } | { ok: false; outcome: Outcome };

/** Runs `fn` against the site's loaded adapter; never throws. */
export async function callSiteAdapter<T>(
  deps: LiveCallContext,
  key: string,
  options: { holder: string; deadline: number; signal?: AbortSignal | undefined },
  fn: (loaded: LoadedSiteAdapter, ctx: AdapterContext) => Promise<T>,
): Promise<LiveCallResult<T>> {
  try {
    const loaded = await deps.registry.load(key);
    if (loaded === undefined) {
      throw new OutcomeError("adapter_error", `the ${key} adapter is not loadable`);
    }
    const budgetMs = options.deadline - deps.clock.now().getTime();
    if (budgetMs <= 0) throw new OutcomeError("timeout", "time budget exceeded before the site was called");
    const value = await deps.runSiteTask(
      { key, manifest: loaded.manifest },
      { holder: options.holder, budgetMs, signal: options.signal },
      (ctx) => fn(loaded, ctx),
    );
    return { ok: true, value, loaded };
  } catch (error) {
    return { ok: false, outcome: errorToOutcome(error) };
  }
}

/** Completes an outcome with its default message/action. */
export function finishOutcome(outcome: Outcome, site: string, loginUrl: string | null): Outcome {
  return outcome.status === "ok" ? { status: "ok" } : withOutcomeDefaults(outcome, { site, loginUrl });
}

/** Feeds a live outcome into the lifecycle; `blocked` starts the cool-down. */
export async function recordLiveOutcome(
  deps: Pick<LiveCallContext, "registry" | "logger">,
  key: string,
  outcome: Outcome,
  blocked: boolean,
): Promise<void> {
  try {
    await deps.registry.recordOutcome(key, {
      status: outcome.status,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(blocked ? { blocked: true } : {}),
    });
  } catch (error) {
    deps.logger.warn("recording a live outcome failed", { site: key, error: errorMessage(error) });
  }
}
