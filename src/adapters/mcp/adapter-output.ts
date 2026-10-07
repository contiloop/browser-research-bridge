/**
 * Validation of what an adapter returns (`adapter_error` means the adapter threw or returned
 * malformed data). Failure verdicts are passed through unchanged even when the rest of the response
 * is sloppy, so a login wall or paywall is never turned into `ok`, `empty`, or a generic error.
 */
import { z } from "zod";
import type { Outcome, OutcomeStatus } from "../../core/models.js";
import { OutcomeError, coerceAdapterStatus, isFailureStatus, isOutcomeStatus } from "../../core/outcome.js";
import { isHttpUrl } from "../../core/url.js";
import type { DocumentInput, SearchItemInput } from "../../core/assemble.js";

const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const datePrecision = z
  .enum(["minute", "day"])
  .nullish()
  .transform((v) => v ?? null);

const httpUrl = z.string().refine((v) => isHttpUrl(v), "must be an absolute http(s) URL");

const searchItemSchema = z.object({
  localId: z.string().nullish(),
  title: z.string(),
  url: httpUrl,
  publishedAt: nullableString,
  datePrecision,
  excerpt: nullableString,
  author: nullableString,
});

const metadataSchema = z
  .record(z.string(), z.unknown())
  .nullish()
  .transform((record) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(record ?? {})) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  });

const documentSchema = z.object({
  localId: z.string().nullish(),
  title: z.string(),
  url: httpUrl,
  publishedAt: nullableString,
  datePrecision,
  author: nullableString,
  text: z.string(),
  accessLevel: z.enum(["public", "subscriber"]).default("public"),
  metadata: metadataSchema,
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

function field(raw: Record<string, unknown>, name: string): string | undefined {
  const v = raw[name];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OutcomeError("adapter_error", `malformed ${what} response: not an object`);
  }
  return raw as Record<string, unknown>;
}

export interface NormalizedSearchResponse {
  status: OutcomeStatus;
  items: SearchItemInput[];
  nextCursor: string | null;
  message?: string | undefined;
  action?: string | undefined;
  blocked: boolean;
}

/** Throws `OutcomeError("adapter_error")` for a malformed successful response. */
export function normalizeSearchResponse(raw: unknown): NormalizedSearchResponse {
  const obj = asObject(raw, "search");
  const blocked = obj["blocked"] === true;
  const message = field(obj, "message");
  const action = field(obj, "action");
  if (!isOutcomeStatus(obj["status"])) {
    throw new OutcomeError(
      "adapter_error",
      `malformed search response: unknown status ${String(obj["status"])}`,
    );
  }
  if (isFailureStatus(obj["status"])) {
    return { status: obj["status"], items: [], nextCursor: null, message, action, blocked };
  }
  const results = obj["results"] ?? [];
  const parsed = z.array(searchItemSchema).safeParse(results);
  if (!parsed.success) {
    throw new OutcomeError("adapter_error", `malformed search results: ${describeIssues(parsed.error)}`);
  }
  const nextCursor = obj["nextCursor"];
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    throw new OutcomeError("adapter_error", "malformed search response: nextCursor must be a string or null");
  }
  return {
    status: coerceAdapterStatus(obj["status"], parsed.data.length),
    items: parsed.data,
    nextCursor: nextCursor ?? null,
    message,
    action,
    blocked,
  };
}

export interface NormalizedReadResponse {
  status: OutcomeStatus;
  document: DocumentInput | null;
  message?: string | undefined;
  action?: string | undefined;
  blocked: boolean;
}

/**
 * The adapter's verdict is kept as given: completeness checking is the adapter's job. `ok` without a valid document is malformed (`adapter_error`); a document attached to a
 * non-`ok` verdict is discarded.
 */
export function normalizeReadResponse(raw: unknown): NormalizedReadResponse {
  const obj = asObject(raw, "read");
  const blocked = obj["blocked"] === true;
  const message = field(obj, "message");
  const action = field(obj, "action");
  const status = obj["status"];
  if (!isOutcomeStatus(status)) {
    throw new OutcomeError("adapter_error", `malformed read response: unknown status ${String(status)}`);
  }
  if (status !== "ok") return { status, document: null, message, action, blocked };
  if (obj["document"] === undefined || obj["document"] === null) {
    throw new OutcomeError("adapter_error", "malformed read response: status ok without a document");
  }
  const parsed = documentSchema.safeParse(obj["document"]);
  if (!parsed.success) {
    throw new OutcomeError("adapter_error", `malformed document: ${describeIssues(parsed.error)}`);
  }
  return { status, document: parsed.data, message, action, blocked };
}

/** The adapter's verdict as an {@link Outcome} (message/action only when present). */
export function adapterOutcome(response: {
  status: OutcomeStatus;
  message?: string | undefined;
  action?: string | undefined;
}): Outcome {
  const outcome: Outcome = { status: response.status };
  if (response.message !== undefined) outcome.message = response.message;
  if (response.action !== undefined) outcome.action = response.action;
  return outcome;
}
