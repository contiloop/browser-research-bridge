/**
 * Helper runtimes: the products the onboarding helper can run on, the local probe that
 * tells whether each is usable without a model call, the selection rule, and the helper check.
 *
 * A runtime is one {@link HelperRuntime} entry: its id, a local probe, the {@link AgentRunner} that
 * runs jobs on it, and a check that makes one real round trip. {@link HelperRuntimes} is the registry
 * the job service selects from; a build ships exactly the runtimes registered in it (Claude and
 * Codex, registered in src/app/jobs.ts without changing the service).
 *
 * Selection: `auto` takes the first available runtime in {@link AUTO_ORDER} (Claude first: it is the
 * proven path); `claude` / `codex` force one. A retry keeps the runtime the job last ran on while it
 * is still available, else falls back to the configured one. "Available" means installed and sign-in
 * not known to be missing (`signedIn: null` counts as available).
 *
 * The last check result is not kept here: {@link HelperRuntimes.check} returns it and the caller
 * (the settings-page layer) stores it, so it survives a restart of the core.
 */
import type { HelperRuntimeSetting } from "../../core/settings.js";
import type { AgentEvent, AgentRunResult, AgentRunner, AgentTool, HelperRuntimeId } from "./types.js";
import { HELPER_RUNTIME_IDS } from "./types.js";

/** `auto` tries these in order. */
export const AUTO_ORDER: readonly HelperRuntimeId[] = ["claude", "codex"];

/** Result of a local probe (no model call). */
export interface RuntimeProbe {
  installed: boolean;
  /** `null` when the sign-in state cannot be told without a model call. */
  signedIn: boolean | null;
}

export const HELPER_CHECK_CODES = [
  "ok",
  "not_installed",
  "not_signed_in",
  "limit_reached",
  "failed",
] as const;
export type HelperCheckCode = (typeof HELPER_CHECK_CODES)[number];

/** The answer of `POST helper/check`. */
export interface HelperCheckResult {
  at: string;
  /** The runtime tried (`wouldUse`), or null when none was available. */
  runtime: HelperRuntimeId | null;
  ok: boolean;
  code: HelperCheckCode;
  /** The runtime's own text, for "Details". */
  message: string | null;
}

/** The answer of `GET helper`. */
export interface HelperStatus {
  configured: HelperRuntimeSetting;
  supported: HelperRuntimeId[];
  runtimes: Record<HelperRuntimeId, RuntimeProbe | null>;
  wouldUse: HelperRuntimeId | null;
  lastCheck: HelperCheckResult | null;
}

export interface HelperCheckInput {
  /** An empty folder the check's helper process runs in. */
  workDir: string;
  signal: AbortSignal;
}

/** One product the helper can run on. */
export interface HelperRuntime {
  readonly id: HelperRuntimeId;
  /** Product name in messages ("Claude", "Codex"). */
  readonly label: string;
  /** What the user does to sign in, in a sentence fragment ("sign in to Claude Code on this Mac"). */
  readonly signInHint: string;
  /** Local probe only: no model call. Never throws (a failed probe reports not installed). */
  probe(): Promise<RuntimeProbe>;
  /** Runs onboarding jobs on this runtime. */
  readonly runner: AgentRunner;
  /** One real round trip (authentication and a tool call). */
  check(input: HelperCheckInput): Promise<{ code: HelperCheckCode; message: string | null }>;
}

/** The runtime a job runs on, or why none can. */
export type RuntimeSelection =
  | { ok: true; runtime: HelperRuntime }
  | { ok: false; code: "not_installed" | "not_signed_in"; message: string };

export function isAvailable(probe: RuntimeProbe | null): boolean {
  return probe !== null && probe.installed && probe.signedIn !== false;
}

export interface HelperRuntimesOptions {
  /** `config.onboarding.runtime`. */
  configured: HelperRuntimeSetting;
  /** The runtimes this build ships. */
  runtimes: readonly HelperRuntime[];
  now?: (() => Date) | undefined;
}

export class HelperRuntimes {
  readonly configured: HelperRuntimeSetting;
  private readonly byId = new Map<HelperRuntimeId, HelperRuntime>();
  private readonly now: () => Date;

  constructor(options: HelperRuntimesOptions) {
    this.configured = options.configured;
    for (const r of options.runtimes) {
      if (this.byId.has(r.id)) throw new Error(`helper runtime registered twice: ${r.id}`);
      this.byId.set(r.id, r);
    }
    this.now = options.now ?? (() => new Date());
  }

  /** The runtimes this build ships, in canonical order. */
  supported(): HelperRuntimeId[] {
    return HELPER_RUNTIME_IDS.filter((id) => this.byId.has(id));
  }

  get(id: HelperRuntimeId): HelperRuntime | undefined {
    return this.byId.get(id);
  }

  /** Local probe of every runtime id; null for a runtime this build does not ship. */
  async probeAll(): Promise<Record<HelperRuntimeId, RuntimeProbe | null>> {
    const out = {} as Record<HelperRuntimeId, RuntimeProbe | null>;
    for (const id of HELPER_RUNTIME_IDS) out[id] = await this.probe(id);
    return out;
  }

  /**
   * The runtime for a run. `recorded` is the runtime the job last ran on (null for a new job): it is
   * kept while available; otherwise the configured choice applies.
   */
  async select(recorded: HelperRuntimeId | null = null): Promise<RuntimeSelection> {
    if (recorded !== null) {
      const r = this.byId.get(recorded);
      if (r !== undefined && isAvailable(await this.probe(recorded))) return { ok: true, runtime: r };
    }
    const tried: { id: HelperRuntimeId; probe: RuntimeProbe | null }[] = [];
    for (const id of this.candidates()) {
      const probe = await this.probe(id);
      const r = this.byId.get(id);
      if (r !== undefined && isAvailable(probe)) return { ok: true, runtime: r };
      tried.push({ id, probe });
    }
    return this.unavailable(tried);
  }

  /** `GET helper`: no model call. */
  async status(lastCheck: HelperCheckResult | null = null): Promise<HelperStatus> {
    const runtimes = await this.probeAll();
    let wouldUse: HelperRuntimeId | null = null;
    for (const id of this.candidates()) {
      if (this.byId.has(id) && isAvailable(runtimes[id])) {
        wouldUse = id;
        break;
      }
    }
    return { configured: this.configured, supported: this.supported(), runtimes, wouldUse, lastCheck };
  }

  /** `POST helper/check`: one real round trip on the runtime a job started now would use. */
  async check(input: HelperCheckInput): Promise<HelperCheckResult> {
    const at = (): string => this.now().toISOString();
    const selection = await this.select(null);
    if (!selection.ok) {
      return { at: at(), runtime: null, ok: false, code: selection.code, message: selection.message };
    }
    const runtime = selection.runtime;
    let outcome: { code: HelperCheckCode; message: string | null };
    try {
      outcome = await runtime.check(input);
    } catch (error) {
      outcome = { code: "failed", message: (error as Error).message };
    }
    return { at: at(), runtime: runtime.id, ok: outcome.code === "ok", ...outcome };
  }

  private candidates(): readonly HelperRuntimeId[] {
    return this.configured === "auto" ? AUTO_ORDER : [this.configured];
  }

  private async probe(id: HelperRuntimeId): Promise<RuntimeProbe | null> {
    const r = this.byId.get(id);
    if (r === undefined) return null;
    try {
      return await r.probe();
    } catch {
      return { installed: false, signedIn: null };
    }
  }

  private unavailable(tried: { id: HelperRuntimeId; probe: RuntimeProbe | null }[]): RuntimeSelection {
    const parts = tried.map(({ id, probe }) => {
      const r = this.byId.get(id);
      if (r === undefined) return `the ${id} helper is not supported by this build`;
      if (probe === null || !probe.installed) return `${r.label} is not installed`;
      return `${r.label} is not signed in (${r.signInHint})`;
    });
    // `not_signed_in` when something is installed but signed out; otherwise nothing usable is installed.
    const signedOut = tried.some(({ id, probe }) => this.byId.has(id) && probe !== null && probe.installed);
    return {
      ok: false,
      code: signedOut ? "not_signed_in" : "not_installed",
      message: `no helper is available: ${parts.join("; ")}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The round trip shared by the checks of every runtime and the CLI's --sdk-check
// ---------------------------------------------------------------------------------------------

export const ROUND_TRIP_SYSTEM_PROMPT =
  'You are a connectivity check. Call the finish tool exactly once with summary "sdk check ok", then reply with the single word: done.';

export interface RoundTripResult {
  result: AgentRunResult;
  /** The `finish` tool's summary, or null when the tool was not called. */
  finished: string | null;
}

/** Authentication and one tool round trip through `runner`, in a few turns. */
export async function helperRoundTrip(
  runner: AgentRunner,
  input: HelperCheckInput & { onEvent?: ((event: AgentEvent) => void) | undefined },
): Promise<RoundTripResult> {
  const { z } = await import("zod");
  let finished: string | null = null;
  const finish: AgentTool = {
    name: "finish",
    description: "Reports that the check is complete.",
    inputShape: { summary: z.string() },
    async call(args) {
      const parsed = z.object({ summary: z.string() }).safeParse(args);
      finished = parsed.success ? parsed.data.summary : "(invalid input)";
      return { content: [{ type: "text", text: "Recorded. End your turn." }] };
    },
  };
  const result = await runner.run({
    runId: "helper-check",
    systemPrompt: ROUND_TRIP_SYSTEM_PROMPT,
    prompt: "Run the check now.",
    tools: [finish],
    resumeSessionId: null,
    workDir: input.workDir,
    signal: input.signal,
    onEvent: input.onEvent ?? (() => undefined),
  });
  return { result, finished };
}

const LIMIT_TEXT = /usage limit|session limit|rate limit|limit reached|limit · resets|resets \d|quota/i;
const SIGN_IN_TEXT =
  /not logged in|log ?in required|please (run )?\/?login|sign in|invalid api key|authenticat|unauthori[sz]ed|\b401\b|oauth token/i;
const NOT_INSTALLED_TEXT = /ENOENT|executable not found|command not found|not installed/i;

/** Maps a round trip to one of the five check codes; `message` is the runtime's own text. */
export function classifyRoundTrip(trip: RoundTripResult): { code: HelperCheckCode; message: string | null } {
  const { result, finished } = trip;
  if (finished !== null && result.outcome === "completed") return { code: "ok", message: result.message };
  const message = result.message ?? (finished === null ? "the finish tool was not called" : null);
  const text = message ?? "";
  if (LIMIT_TEXT.test(text)) return { code: "limit_reached", message };
  if (SIGN_IN_TEXT.test(text)) return { code: "not_signed_in", message };
  if (NOT_INSTALLED_TEXT.test(text)) return { code: "not_installed", message };
  return { code: "failed", message };
}
