/**
 * Onboarding jobs (Add, blocked onboarding, Repair, Remove): the job
 * model, its log, and the ports the job service depends on. The agent runtime (Claude Agent SDK) is
 * one implementation of {@link AgentRunner}; tests drive the service with a scripted fake.
 */
import type { z } from "zod";

export const JOB_STATES = ["queued", "running", "awaiting_user", "succeeded", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobKind = "add" | "repair";

/** Language of the settings page that started or last retried a job; the helper writes its requested action in it. */
export const HELPER_LANGS = ["en", "ko"] as const;
export type HelperLang = (typeof HELPER_LANGS)[number];

/** `"ko"` stays `"ko"`; anything else (missing, unknown) is English. */
export function parseHelperLang(value: unknown): HelperLang {
  return value === "ko" ? "ko" : "en";
}

/** The products the helper can run on; which ones a build ships is decided by its runtime registry. */
export const HELPER_RUNTIME_IDS = ["claude", "codex"] as const;
export type HelperRuntimeId = (typeof HELPER_RUNTIME_IDS)[number];

export function isHelperRuntimeId(value: unknown): value is HelperRuntimeId {
  return typeof value === "string" && (HELPER_RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * What blocks a paused job, as the helper reported it with `report_blocked({ kind })`; the settings page
 * offers the Aside-AI login text only for `login`. Pauses the service writes itself are `other`.
 */
export const BLOCK_KINDS = ["login", "captcha", "consent", "subscription", "other"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** A known block kind stays; anything else (missing, unknown) is `other`. */
export function parseBlockKind(value: unknown): BlockKind {
  return typeof value === "string" && (BLOCK_KINDS as readonly string[]).includes(value)
    ? (value as BlockKind)
    : "other";
}

/** A job that may still run (Remove cancels it; a second Add/Repair for the site is refused). */
export function isActiveJobState(state: JobState): boolean {
  return state === "queued" || state === "running" || state === "awaiting_user";
}

export interface OnboardingJob {
  version: 1;
  id: string;
  kind: JobKind;
  /** The site key; null while a bare-name Add has not resolved the site's homepage yet. */
  key: string | null;
  /** What the user typed (URL or site name); for a repair, the site key. */
  input: string;
  /** The user's free-text note for the agent (Add), or null. */
  note: string | null;
  /** Provisional hostnames of an Add (empty until a bare name is resolved); live hostnames for a repair. */
  hostnames: string[];
  state: JobState;
  /** Why the job failed, is paused, or was cancelled. */
  reason: string | null;
  /** The smallest action the user must take (state `awaiting_user`). */
  requestedAction: string | null;
  /** The agent's own summary when it called `finish`. */
  summary: string | null;
  /** One-line summary of the last validation the service ran itself. */
  validation: string | null;
  /** Repair input: the site's last failure when the repair was started. */
  lastFailure: string | null;
  /** Agent SDK session id, used to resume the same conversation on Retry. */
  sessionId: string | null;
  /** Agent runs started for this job (Retry increases it). */
  attempts: number;
  /** Hosts outside the site's domain the user approved for this job's browser (by clicking Retry). */
  approvedHosts: string[];
  /** Hosts outside the site's domain the paused job waits to have approved; Retry approves them. */
  pendingHosts: string[];
  /**
   * Page language of the latest Add/Repair/Retry request. Always written by the service and filled
   * (`"en"`) by the store for old records; optional only so hand-built records stay valid. Read it
   * with {@link jobLang}.
   */
  lang?: HelperLang | undefined;
  /** Runtime the job last ran on; null before its first run. Read it with {@link jobRuntime}. */
  runtime?: HelperRuntimeId | null | undefined;
  /**
   * What blocks the job while it is `awaiting_user` (`other` in every other state). Written by the
   * service and filled (`"other"`) by the store for old records; read it with {@link jobBlockKind}.
   */
  blockKind?: BlockKind | undefined;
  /** Commit of the promoted folder (`site: add|repair <key>`), when one was made. */
  commit: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function jobLang(job: Pick<OnboardingJob, "lang">): HelperLang {
  return job.lang ?? "en";
}

export function jobRuntime(job: Pick<OnboardingJob, "runtime">): HelperRuntimeId | null {
  return job.runtime ?? null;
}

export function jobBlockKind(job: Pick<OnboardingJob, "blockKind">): BlockKind {
  return job.blockKind ?? "other";
}

export type JobLogLevel = "info" | "warn" | "error";
/** `job`: the service; `agent`: the agent's own text; `tool`: a tool call and its result summary. */
export type JobLogSource = "job" | "agent" | "tool";

export interface JobLogLine {
  /** 1-based, increasing per job; the dashboard resumes a stream with `after`. */
  seq: number;
  at: string;
  level: JobLogLevel;
  source: JobLogSource;
  message: string;
}

export type JobEvent = { type: "log"; jobId: string; line: JobLogLine } | { type: "job"; job: OnboardingJob };

/** Persistence of job records and their append-only logs (`data/jobs/`). */
export interface JobStore {
  loadAll(): Promise<OnboardingJob[]>;
  save(job: OnboardingJob): Promise<void>;
  appendLog(jobId: string, line: JobLogLine): Promise<void>;
  readLog(jobId: string): Promise<JobLogLine[]>;
}

// ---------------------------------------------------------------------------------------------
// Agent runtime port
// ---------------------------------------------------------------------------------------------

export type AgentToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

export interface AgentToolResult {
  content: AgentToolContent[];
  isError?: boolean | undefined;
}

/** A tool the agent may call. The runtime exposes exactly these and nothing else. */
export interface AgentTool {
  name: string;
  description: string;
  /** Zod raw shape of the input object (converted to JSON Schema by the runtime). */
  inputShape: z.ZodRawShape;
  /** Validates `args` against the shape and runs the tool; never throws. */
  call(args: unknown): Promise<AgentToolResult>;
}

export type AgentEvent =
  | { type: "session"; sessionId: string; model: string; authSource: string; tools: string[] }
  | { type: "text"; text: string }
  | { type: "warning"; message: string };

export interface AgentRunRequest {
  /** Names the run in logs (`<jobId>#<attempt>`). */
  runId: string;
  systemPrompt: string;
  prompt: string;
  tools: readonly AgentTool[];
  /** Continue this earlier session (Retry), or null for a new conversation. */
  resumeSessionId: string | null;
  /** Working directory of the agent process: an empty per-job folder (the agent has no file tools). */
  workDir: string;
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
}

export type AgentRunOutcome = "completed" | "max_turns" | "error" | "aborted";

export interface AgentRunResult {
  sessionId: string | null;
  outcome: AgentRunOutcome;
  /** Error text, or the agent's final text for `completed`. */
  message: string | null;
  turns: number;
  costUsd: number | null;
  /** A resume was requested but the earlier session could not be loaded. */
  resumeFailed?: boolean | undefined;
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

/** Raised for requests the service refuses (duplicate hostname, nothing to retry, …); the dashboard API maps it to a 4xx. */
export class OnboardingRequestError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "conflict" | "not_found" = "invalid",
  ) {
    super(message);
    this.name = "OnboardingRequestError";
  }
}
