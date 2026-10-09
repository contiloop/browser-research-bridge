/**
 * One live adapter call: load the site's adapter, run the call in the site's shared pool within the
 * remaining tool-call budget, map anything thrown to a failure outcome, and feed the outcome back
 * into the site lifecycle. After a blocked outcome (a block or captcha page), `callWithChallenge`
 * runs one quick challenge attempt and, unless the check is captcha-limited, re-runs the call once
 * (see ./challenge.ts). Each call also reports the page the adapter's browser session last showed
 * (`pageUrl`), where an attempt after a blocked search is aimed. With the Aside AI on
 * (./assistant-tasks.ts), a blocked failure the bridge's own attempt could not act on and an
 * `auth_required` outcome start a task in the background; the call answers at once with its sentence.
 */
import type { Outcome } from "../../core/models.js";
import {
  OutcomeError,
  errorToOutcome,
  isBlockedError,
  isFailureStatus,
  withOutcomeDefaults,
} from "../../core/outcome.js";
import type { AdapterContext } from "../../ports/adapter.js";
import type { LoadedSiteAdapter } from "../../ports/registry.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { AssistantGate, AssistantRequest } from "./assistant-tasks.js";
import { canRerun, captchaUnsolvedAction, planChallenge } from "./challenge.js";
import type { ChallengeGate } from "./challenge.js";
import type { SiteTaskRunner, ToolRegistry } from "./deps.js";
import { errorMessage } from "./deps.js";

export interface LiveCallContext {
  registry: ToolRegistry;
  runSiteTask: SiteTaskRunner;
  logger: Logger;
  clock: Clock;
  /** Captcha attempts after a blocked outcome; absent → none. */
  challenges?: ChallengeGate | undefined;
  /** Aside AI tasks after a blocked or `auth_required` outcome; absent → none. */
  assistant?: AssistantGate | undefined;
}

/**
 * One adapter call's result. `pageUrl`: the on-site page the adapter's browser session last showed
 * (`BrowserSession.lastUrl()`, read before the session is disposed), null when it loaded none. A
 * failure's `blocked` comes from the thrown error (`isBlockedError`, e.g. a page script that ran into
 * a bot check) and is read like an adapter's returned `blocked`.
 */
export type LiveCallResult<T> =
  | { ok: true; value: T; loaded: LoadedSiteAdapter; pageUrl: string | null }
  | { ok: false; outcome: Outcome; blocked: boolean; pageUrl: string | null };

function sessionPage(ctx: AdapterContext): string | null {
  try {
    return ctx.browser.lastUrl();
  } catch {
    return null;
  }
}

/** Runs `fn` against the site's loaded adapter; never throws. */
export async function callSiteAdapter<T>(
  deps: LiveCallContext,
  key: string,
  options: { holder: string; deadline: number; signal?: AbortSignal | undefined },
  fn: (loaded: LoadedSiteAdapter, ctx: AdapterContext) => Promise<T>,
): Promise<LiveCallResult<T>> {
  let pageUrl: string | null = null;
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
      async (ctx) => {
        try {
          return await fn(loaded, ctx);
        } finally {
          pageUrl = sessionPage(ctx);
        }
      },
    );
    return { ok: true, value, loaded, pageUrl };
  } catch (error) {
    return { ok: false, outcome: errorToOutcome(error), blocked: isBlockedError(error), pageUrl };
  }
}

/** Completes an outcome with its default message/action. */
export function finishOutcome(outcome: Outcome, site: string, loginUrl: string | null): Outcome {
  return outcome.status === "ok" ? { status: "ok" } : withOutcomeDefaults(outcome, { site, loginUrl });
}

/**
 * Feeds a live outcome into the lifecycle. Only a `rate_limited` outcome starts the cool-down;
 * `blocked` (a block or captcha page) is passed along as information and does not.
 */
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

/**
 * One finished adapter call: its outcome (defaults applied), the adapter's `blocked` flag, data, and
 * the page its browser session last showed (`LiveCallResult.pageUrl`).
 */
export interface SettledCall<R> {
  outcome: Outcome;
  blocked: boolean;
  value: R;
  pageUrl: string | null;
  /**
   * Set by `callWithChallenge` on a captcha-limited answer, whose message names the page URL: logs
   * must not carry that message.
   */
  captchaLimited?: true | undefined;
}

export interface ChallengeFlowOptions {
  key: string;
  /** The tool's holder name, for logs. */
  holder: string;
  /** End of the tool call's budget (epoch ms). */
  deadline: number;
  signal?: AbortSignal | undefined;
  /**
   * The page the failure was met on (the read's URL); null when the call has none (a search, a native
   * id). The attempt then targets the page the adapter's session last showed (`SettledCall.pageUrl`,
   * the site's search page for a search), else the site's homepage.
   */
  url: string | null;
  /**
   * Sites that already had an attempt in this tool call (search pages, `read_documents` refs): one
   * attempt per site and call. A later blocked call of a listed site only joins an attempt still in
   * flight (and re-runs after it); it starts none.
   */
  attempted?: Set<string> | undefined;
}

/**
 * A blocked failure the solver may help with. A throttle page (`rate_limited`) keeps today's rule: its
 * cool-down starts and the site is left alone.
 */
export function wantsChallenge(call: Pick<SettledCall<unknown>, "outcome" | "blocked">): boolean {
  return call.blocked && isFailureStatus(call.outcome.status) && call.outcome.status !== "rate_limited";
}

function withAction<R>(call: SettledCall<R>, action: string): SettledCall<R> {
  return { ...call, outcome: { ...call.outcome, action } };
}

/**
 * A captcha-limited answer: the original failure as `access_denied` (never `ok` or `empty`), still
 * `blocked`, with the captcha-limited sentence as both message and action.
 */
function captchaLimited<R>(call: SettledCall<R>, sentence: string): SettledCall<R> {
  return {
    ...call,
    blocked: true,
    captchaLimited: true,
    outcome: { status: "access_denied", message: sentence, action: sentence },
  };
}

/**
 * A blocked failure the Aside AI is working on (or will be): still `blocked`, with the AI's sentence as
 * the action. Status and message stay (a blocked `auth_required` stays `auth_required`, so the login path
 * still applies; a captcha-limited answer keeps its `access_denied` and sentence).
 */
function assistantBlocked<R>(call: SettledCall<R>, action: string): SettledCall<R> {
  return { ...call, blocked: true, outcome: { ...call.outcome, action } };
}

/**
 * Starts the Aside AI task for a blocked failure, by the original failure's status: a blocked
 * `auth_required` (a login wall shown with a block page) is a login task, anything else a captcha task
 * (`after` applies to a captcha task only). The sentence for the call, or null (today's action).
 */
function assistantForBlocked(
  assistant: AssistantGate,
  first: Pick<SettledCall<unknown>, "outcome">,
  key: string,
  request: AssistantRequest,
): Promise<string | null> {
  return first.outcome.status === "auth_required"
    ? assistant.login(key, { url: request.url, trigger: request.trigger })
    : assistant.captcha(key, request);
}

/**
 * Runs the adapter call with the captcha flow (`challengeFlow`), then, when the answer is
 * `auth_required` (the site turned `needs_login`, or already was), lets the Aside AI log in again in
 * the background: the action becomes its sentence ("logging in now", or why the user must act). Never
 * throws unless `run` does.
 */
export async function callWithChallenge<R>(
  deps: LiveCallContext,
  options: ChallengeFlowOptions,
  run: () => Promise<SettledCall<R>>,
): Promise<SettledCall<R>> {
  const settled = await challengeFlow(deps, options, run);
  const assistant = deps.assistant;
  if (settled.outcome.status !== "auth_required" || assistant === undefined || !assistant.enabled) {
    return settled;
  }
  const action = await assistant.login(options.key, {
    url: options.url ?? settled.pageUrl,
    trigger: options.holder,
  });
  return action === null ? settled : withAction(settled, action);
}

/**
 * Runs the adapter call (`run`) and records its outcome. When it is blocked and attempts are on:
 * with at least `captchaDetectBudgetMs + captchaRerunReserveMs` of the call left, one quick attempt
 * (joining the site's running one) within `min(captchaAttemptBudgetMs, remaining −
 * captchaRerunReserveMs)`; otherwise the failure at once with the captcha action and an attempt in the
 * background.
 *
 * After the attempt: captcha-limited (nothing acted on: `unknown` with no round, detection not done
 * within the detection budget, no solver) → the failure at once as `access_denied` with the
 * captcha-limited sentence, no re-run. Otherwise one re-run while the reserve is left; the re-run is
 * returned when it is `ok`/`empty` (the only confirmation of a solved challenge) or another truthful
 * non-blocked verdict; a re-run that is still blocked, or an attempt that could not run, returns the
 * original failure with the captcha action. A challenge met in the re-run is not attempted again.
 * Nothing is remembered per site between calls.
 *
 * The Aside AI (`deps.assistant`, on): every blocked failure is noted (a recent captcha `done` then
 * counts as failed). While a task works on the site, the call skips the own attempt and answers at once
 * with its failure status, blocked, and the working sentence. A captcha task starts in the background
 * (the call answering likewise with its sentence) when `captcha.auto` is off, when the own attempt is
 * captcha-limited or did not run (refused, browser unavailable, timed out), or when the own attempt
 * went to the background (then the task waits for that attempt's report and starts only if it did not
 * act). When the own attempt acted, nothing starts: the next blocked call decides. A blocked
 * `auth_required` starts a login task instead of a captcha task and keeps its status. Without a task
 * (setting off, unavailable, paused, cooling down) the answers are today's.
 */
async function challengeFlow<R>(
  deps: LiveCallContext,
  options: ChallengeFlowOptions,
  run: () => Promise<SettledCall<R>>,
): Promise<SettledCall<R>> {
  const { key, holder } = options;
  const first = await run();
  await recordLiveOutcome(deps, key, first.outcome, first.blocked);
  if (!wantsChallenge(first)) return first;
  const assistant = deps.assistant?.enabled === true ? deps.assistant : undefined;
  const target = options.url ?? first.pageUrl;
  if (assistant !== undefined) {
    assistant.noteBlocked(key);
    const working = assistant.workingAction(key);
    if (working !== null) {
      // The Aside AI is on the site: no own attempt to get in its way.
      deps.logger.info("captcha left to the Aside AI", { site: key, tool: holder });
      return assistantBlocked(first, working);
    }
  }
  const gate = deps.challenges;
  if (gate === undefined || !gate.enabled) {
    const action =
      assistant === undefined
        ? null
        : await assistantForBlocked(assistant, first, key, { url: target, trigger: holder });
    return action === null ? first : assistantBlocked(first, action);
  }
  // One attempt per site and tool call: a site that already had one may only join one in flight.
  const hadAttempt = options.attempted?.has(key) === true;
  options.attempted?.add(key);

  const plan = planChallenge(gate.settings, options.deadline - deps.clock.now().getTime());
  if (plan.mode === "background") {
    if (hadAttempt) return first;
    const started = gate.background(key, target);
    deps.logger.info("captcha deferred to the background", { site: key, tool: holder, started });
    const action =
      assistant === undefined
        ? null
        : await assistantForBlocked(assistant, first, key, {
            url: target,
            trigger: holder,
            after: gate.whenSettled(key),
          });
    return action === null
      ? withAction(first, captchaUnsolvedAction(gate.challengeUrl(key, target)))
      : assistantBlocked(first, action);
  }
  const attemptOptions = { budgetMs: plan.budgetMs, signal: options.signal };
  const pending = hadAttempt
    ? gate.join(key, target, attemptOptions)
    : gate.attempt(key, target, attemptOptions);
  if (pending === null) return first;
  const report = await pending;
  if (report.limited) {
    // Nothing the solver can do here: answer now, no re-run, no background attempt.
    deps.logger.info("captcha-limited", {
      site: key,
      tool: holder,
      attempt: report.result,
      kind: report.kind,
    });
    const limited = captchaLimited(first, report.action);
    const action =
      assistant === undefined
        ? null
        : await assistantForBlocked(assistant, first, key, { url: target, trigger: holder });
    return action === null ? limited : withAction(limited, action);
  }
  const unsolved = withAction(first, report.action);
  if (!report.ran) {
    // The attempt did not run (refused, browser unavailable, timed out, site gone): like a
    // captcha-limited one, it leaves the check to the Aside AI. A joiner that timed out may leave the
    // site's attempt running; the task then waits for its report and starts only if it did not act.
    const action =
      assistant === undefined
        ? null
        : await assistantForBlocked(assistant, first, key, {
            url: target,
            trigger: holder,
            after: gate.whenSettled(key),
          });
    return action === null ? unsolved : assistantBlocked(first, action);
  }
  if (!canRerun(gate.settings, options.deadline - deps.clock.now().getTime())) {
    // The attempt's effect (if any) stays for the next call.
    deps.logger.info("captcha re-run skipped", { site: key, tool: holder, reason: "reserve spent" });
    return first;
  }
  const second = await run();
  await recordLiveOutcome(deps, key, second.outcome, second.blocked);
  deps.logger.info("captcha re-run", {
    site: key,
    tool: holder,
    attempt: report.result,
    status: second.outcome.status,
    blocked: second.blocked,
  });
  if (second.outcome.status === "ok" || second.outcome.status === "empty") return second;
  return wantsChallenge(second) ? unsolved : second;
}
