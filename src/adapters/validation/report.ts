/**
 * `validation.json`: the result and timestamps of the last full validation of an
 * adapter folder, plus a hash of the validated files so a promotion can prove that what goes live is
 * exactly what passed. A folder is loadable only with a `validation.json` whose `passed` is true.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isFailureStatus, isOutcomeStatus } from "../../core/outcome.js";
import type { Outcome, OutcomeStatus } from "../../core/models.js";
import { readJsonFile, writeJsonAtomic } from "../storage/json-file.js";

export const VALIDATION_FILE = "validation.json";
export const MANIFEST_FILE = "manifest.json";
export const ADAPTER_FILE = "adapter.ts";

export type ValidationForm = "full" | "light";
export type ValidationStepName =
  "manifest" | "static" | "load" | "search" | "second_page" | "read" | "gated" | "smoke";
/** Step d of the full validation (gated page, logged-out form); `not_run` for the light form. */
export type GatedCheck = "passed" | "failed" | "not_applicable" | "not_run";

export type StepDetails = Record<string, string | number | boolean | null>;

export interface ValidationStep {
  name: ValidationStepName;
  passed: boolean;
  /** The adapter's (or derived) outcome status for this step. */
  status: OutcomeStatus | null;
  message: string;
  durationMs: number;
  details: StepDetails;
}

export interface ValidationFailure {
  step: ValidationStepName;
  /** A failure status (never `ok`/`empty`): what a health check feeds into the lifecycle. */
  status: Exclude<OutcomeStatus, "ok" | "empty">;
  message: string;
  action?: string | undefined;
}

export interface ValidationReport {
  version: 1;
  key: string;
  form: ValidationForm;
  /** Which folder was validated. */
  target: "live" | "staging";
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Hash of manifest.json + adapter sources at validation time (null when unreadable). */
  adapterHash: string | null;
  manifestVersion: number | null;
  gatedCheck: GatedCheck;
  failure: ValidationFailure | null;
  steps: ValidationStep[];
}

const SOURCE_FILE = /\.(?:[mc]?ts|[mc]?js|tsx|jsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[mc]?ts|[mc]?js|tsx|jsx)$/;

/**
 * SHA-256 over `manifest.json` and every non-test source file of the folder (top level only;
 * `.staging/` and `.previous/` excluded), in name order. Null when the folder cannot be read.
 */
export async function computeAdapterHash(dir: string): Promise<string | null> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter(
        (e) =>
          e.isFile() &&
          !e.name.startsWith(".") &&
          (e.name === MANIFEST_FILE || (SOURCE_FILE.test(e.name) && !TEST_FILE.test(e.name))),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(`${name}\u0000`);
    hash.update(await readFile(join(dir, name)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export async function writeValidationReport(dir: string, report: ValidationReport): Promise<void> {
  await writeJsonAtomic(join(dir, VALIDATION_FILE), report);
}

/** The folder's `validation.json`, or null when missing or malformed. */
export async function readValidationReport(dir: string): Promise<ValidationReport | null> {
  let raw: unknown;
  try {
    raw = await readJsonFile(join(dir, VALIDATION_FILE));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<ValidationReport>;
  if (typeof r.passed !== "boolean" || typeof r.key !== "string" || typeof r.finishedAt !== "string")
    return null;
  return {
    version: 1,
    key: r.key,
    form: r.form === "light" ? "light" : "full",
    target: r.target === "staging" ? "staging" : "live",
    passed: r.passed,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : r.finishedAt,
    finishedAt: r.finishedAt,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    adapterHash: typeof r.adapterHash === "string" ? r.adapterHash : null,
    manifestVersion: typeof r.manifestVersion === "number" ? r.manifestVersion : null,
    gatedCheck:
      r.gatedCheck === "passed" || r.gatedCheck === "failed" || r.gatedCheck === "not_applicable"
        ? r.gatedCheck
        : "not_run",
    failure: r.failure ?? null,
    steps: Array.isArray(r.steps) ? r.steps : [],
  };
}

/** What a validation run means for the lifecycle: `ok` when passed, else the failure outcome. */
export function reportToOutcome(report: ValidationReport): Outcome {
  if (report.passed) return { status: "ok" };
  const failure = report.failure;
  if (failure === null) return { status: "adapter_error", message: "validation failed" };
  const status: OutcomeStatus =
    isOutcomeStatus(failure.status) && isFailureStatus(failure.status) ? failure.status : "adapter_error";
  const out: Outcome = { status, message: failure.message };
  if (failure.action !== undefined) out.action = failure.action;
  return out;
}

/** One-line human summary for logs and the CLI. */
export function summarizeReport(report: ValidationReport): string {
  if (report.passed) {
    return `${report.key}: ${report.form} validation passed in ${(report.durationMs / 1000).toFixed(1)} s (gated check: ${report.gatedCheck})`;
  }
  const f = report.failure;
  return `${report.key}: ${report.form} validation FAILED at ${f?.step ?? "?"} [${f?.status ?? "?"}] ${f?.message ?? ""}`;
}
