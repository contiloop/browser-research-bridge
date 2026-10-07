/**
 * File-backed job store (`data/jobs/`): one `<id>.json` record per job (atomic replace) and one
 * append-only `<id>.log.jsonl` with the job's log lines, so the dashboard can replay and stream a
 * job's log after a restart. Local files only; logs hold metadata and the agent's narration, never
 * cookies or tokens.
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../storage/json-file.js";
import { JOB_STATES, isHelperRuntimeId, parseHelperLang } from "./types.js";
import type { JobLogLine, JobState, JobStore, OnboardingJob } from "./types.js";

export const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,63}$/;

export function jobsDir(dataDir: string): string {
  return join(dataDir, "jobs");
}

function isState(value: unknown): value is JobState {
  return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A stored record, or null when it is not a job record this version understands. */
export function parseJobRecord(raw: unknown): OnboardingJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r["id"]);
  if (id === null || !JOB_ID_PATTERN.test(id)) return null;
  if (r["kind"] !== "add" && r["kind"] !== "repair") return null;
  if (!isState(r["state"])) return null;
  const createdAt = str(r["createdAt"]);
  if (createdAt === null) return null;
  return {
    version: 1,
    id,
    kind: r["kind"],
    key: str(r["key"]),
    input: str(r["input"]) ?? "",
    note: str(r["note"]),
    hostnames: strings(r["hostnames"]),
    state: r["state"],
    reason: str(r["reason"]),
    requestedAction: str(r["requestedAction"]),
    summary: str(r["summary"]),
    validation: str(r["validation"]),
    lastFailure: str(r["lastFailure"]),
    sessionId: str(r["sessionId"]),
    attempts: typeof r["attempts"] === "number" ? r["attempts"] : 0,
    approvedHosts: strings(r["approvedHosts"]),
    pendingHosts: strings(r["pendingHosts"]),
    // Records written before these fields existed read as English and "not run on a known runtime".
    lang: parseHelperLang(r["lang"]),
    runtime: isHelperRuntimeId(r["runtime"]) ? r["runtime"] : null,
    commit: str(r["commit"]),
    createdAt,
    updatedAt: str(r["updatedAt"]) ?? createdAt,
    startedAt: str(r["startedAt"]),
    finishedAt: str(r["finishedAt"]),
  };
}

export class FileJobStore implements JobStore {
  constructor(readonly dir: string) {}

  private recordPath(id: string): string {
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`invalid job id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  private logPath(id: string): string {
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`invalid job id: ${id}`);
    return join(this.dir, `${id}.log.jsonl`);
  }

  async loadAll(): Promise<OnboardingJob[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const jobs: OnboardingJob[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!JOB_ID_PATTERN.test(id)) continue;
      let raw: unknown;
      try {
        raw = await readJsonFile(join(this.dir, name));
      } catch {
        continue; // a corrupt record is skipped, not fatal
      }
      const job = parseJobRecord(raw);
      if (job !== null && job.id === id) jobs.push(job);
    }
    return jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async save(job: OnboardingJob): Promise<void> {
    await writeJsonAtomic(this.recordPath(job.id), job);
  }

  async appendLog(jobId: string, line: JobLogLine): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.logPath(jobId), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  async readLog(jobId: string): Promise<JobLogLine[]> {
    let text: string;
    try {
      text = await readFile(this.logPath(jobId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: JobLogLine[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const v = JSON.parse(line) as Partial<JobLogLine>;
        if (typeof v.seq === "number" && typeof v.message === "string" && typeof v.at === "string") {
          out.push({
            seq: v.seq,
            at: v.at,
            level: v.level === "warn" || v.level === "error" ? v.level : "info",
            source: v.source === "agent" || v.source === "tool" ? v.source : "job",
            message: v.message,
          });
        }
      } catch {
        // a torn last line after a crash is skipped
      }
    }
    return out;
  }
}

/** In-memory store for tests and dry runs. */
export class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, OnboardingJob>();
  readonly logs = new Map<string, JobLogLine[]>();

  async loadAll(): Promise<OnboardingJob[]> {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }

  async save(job: OnboardingJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async appendLog(jobId: string, line: JobLogLine): Promise<void> {
    const list = this.logs.get(jobId) ?? [];
    list.push({ ...line });
    this.logs.set(jobId, list);
  }

  async readLog(jobId: string): Promise<JobLogLine[]> {
    return (this.logs.get(jobId) ?? []).map((l) => ({ ...l }));
  }
}
