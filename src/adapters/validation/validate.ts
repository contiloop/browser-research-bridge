/**
 * Validation core: the registration gate run against the real site. This module holds
 * the decision logic; the browser work goes through an injected {@link ValidationRunner} (in the
 * bridge: the scheduler + Aside browser port, see ./validator.ts), so the logic is testable with a
 * fake adapter while real validation never mocks the site.
 *
 * Full form (onboarding/repair): (a) manifest + static check; (b) search(sampleQuery) returns ≥1
 * result, every result with a title and an http(s) URL on the site's hostnames, ids that round-trip,
 * and a second, different page when `pagination` is declared; (c) read of `sampleReadUrl` (or the
 * first result through its result id) returns `ok`, a title, `text.length ≥ minReadChars`, and
 * `accessLevel: "subscriber"` for `requiresLogin` sites; (d) `gatedSampleUrl` reads `ok` +
 * subscriber while logged in and the adapter's completeness detector classifies the page's
 * logged-out form as non-`ok` (`gatedCheck: "not_applicable"` without a gated URL); and the
 * adapter's own `smokeTest` passes within the 60 s smoke budget.
 *
 * Light form (health check): (b) with limit 3 and (c), all within the 60 s smoke budget.
 */
import { makeResultId, parseRef, toAdapterRef } from "../../core/ids.js";
import type { DocumentRef, OutcomeStatus } from "../../core/models.js";
import {
  DEFAULT_STATUS_MESSAGES,
  coerceAdapterStatus,
  errorToOutcome,
  isFailureStatus,
} from "../../core/outcome.js";
import { hostnameKey, normalizeUrl, parseHttpUrl } from "../../core/url.js";
import type {
  AdapterContext,
  AdapterReadResponse,
  AdapterSearchItem,
  AdapterSearchResponse,
  CompletenessInput,
  SiteAdapter,
} from "../../ports/adapter.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type {
  GatedCheck,
  StepDetails,
  ValidationFailure,
  ValidationForm,
  ValidationReport,
  ValidationStep,
  ValidationStepName,
} from "./report.js";
import type { StaticCheckResult } from "./static-check.js";
import { describeStaticViolations } from "./static-check.js";

/** The smoke test (and the light form) must complete within 60 seconds. */
export const DEFAULT_SMOKE_BUDGET_MS = 60_000;
/** Budget of one full-form step (search page, read), like a tool call. */
export const DEFAULT_VALIDATION_STEP_BUDGET_MS = 90_000;
/** Results asked for by the light form. */
export const LIGHT_SEARCH_LIMIT = 3;
/** Results asked for by the full form. */
export const FULL_SEARCH_LIMIT = 10;

/** Runs one adapter step in the browser under the site lock with a budget. Throws on failure. */
export interface ValidationRunner {
  step<T>(label: string, budgetMs: number, fn: (ctx: AdapterContext) => Promise<T>): Promise<T>;
}

/** A page fetched without the user's cookies (the logged-out form of a gated page). */
export type AnonymousFetcher = (
  url: string,
  allowedHosts: readonly string[],
  signal?: AbortSignal,
) => Promise<CompletenessInput>;

export interface RunValidationOptions {
  form: ValidationForm;
  key: string;
  target: "live" | "staging";
  manifest: SiteManifest;
  adapter: SiteAdapter;
  runner: ValidationRunner;
  /** Result of the static check (full form, step a); it must have run before the adapter was imported. */
  staticResult?: StaticCheckResult | undefined;
  /** Needed by step d when the manifest sets `gatedSampleUrl`. */
  anonymousFetch?: AnonymousFetcher | undefined;
  adapterHash?: string | null | undefined;
  clock?: Clock | undefined;
  smokeBudgetMs?: number | undefined;
  stepBudgetMs?: number | undefined;
  /** Hosts the browser session may use (hostnames ∪ extraAllowedHosts); defaults to the hostnames. */
  browserHosts?: readonly string[] | undefined;
}

class StepFailure extends Error {
  constructor(
    readonly status: Exclude<OutcomeStatus, "ok" | "empty">,
    message: string,
    readonly details: StepDetails = {},
    readonly action?: string,
  ) {
    super(message);
  }
}

/** True when `url` is http(s) on one of the hostnames (or a subdomain of one). */
export function urlOnSite(url: string, hostnames: readonly string[]): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const host = hostnameKey(u.hostname);
  return hostnames.some((h) => {
    const k = hostnameKey(h);
    return host === k || host.endsWith(`.${k}`);
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Failure status for an adapter-reported non-ok status (never `ok`/`empty`). */
function failureStatusOf(status: OutcomeStatus): Exclude<OutcomeStatus, "ok" | "empty"> {
  return isFailureStatus(status) ? status : "adapter_error";
}

/** Checks one search page; returns the ids built from it. */
function checkSearchPage(
  key: string,
  manifest: SiteManifest,
  adapter: SiteAdapter,
  response: AdapterSearchResponse,
  limit: number,
  label: string,
): { items: AdapterSearchItem[]; ids: string[] } {
  if (typeof response !== "object" || response === null || !Array.isArray(response.results)) {
    throw new StepFailure("adapter_error", `${label}: the adapter returned a malformed search response`);
  }
  const status = coerceAdapterStatus(response.status, response.results.length);
  if (status === "empty") {
    throw new StepFailure("adapter_error", `${label}: the sample query returned no results`, { results: 0 });
  }
  if (status !== "ok") {
    throw new StepFailure(
      failureStatusOf(status),
      `${label}: search returned ${status}: ${response.message ?? DEFAULT_STATUS_MESSAGES[status]}`,
      { results: response.results.length },
      response.action,
    );
  }
  if (response.results.length > limit) {
    throw new StepFailure(
      "adapter_error",
      `${label}: returned ${response.results.length} results for limit ${limit}`,
    );
  }
  const ids: string[] = [];
  response.results.forEach((item, i) => {
    if (!nonEmpty(item?.title))
      throw new StepFailure("adapter_error", `${label}: result ${i + 1} has no title`);
    if (!nonEmpty(item.url) || !urlOnSite(item.url, manifest.hostnames)) {
      throw new StepFailure(
        "adapter_error",
        `${label}: result ${i + 1} URL is not on the site's hostnames (${String(item.url)})`,
      );
    }
    let id: string;
    try {
      id = makeResultId(key, { localId: item.localId, url: item.url }, adapter.canonicalize?.bind(adapter));
    } catch (error) {
      throw new StepFailure(
        "adapter_error",
        `${label}: result ${i + 1} has no usable id: ${(error as Error).message}`,
      );
    }
    if (parseRef(id).kind !== "id") {
      throw new StepFailure("adapter_error", `${label}: result ${i + 1} id does not round-trip (${id})`);
    }
    ids.push(id);
  });
  return { items: response.results, ids };
}

function checkReadResponse(
  manifest: SiteManifest,
  response: AdapterReadResponse,
  label: string,
  requireSubscriber: boolean,
): StepDetails {
  if (typeof response !== "object" || response === null) {
    throw new StepFailure("adapter_error", `${label}: the adapter returned a malformed read response`);
  }
  const status: OutcomeStatus = coerceAdapterStatus(response.status, response.document ? 1 : 0);
  if (status !== "ok") {
    throw new StepFailure(
      failureStatusOf(status),
      `${label}: read returned ${status}: ${response.message ?? DEFAULT_STATUS_MESSAGES[status]}`,
      {},
      response.action,
    );
  }
  const doc = response.document;
  if (!doc) throw new StepFailure("adapter_error", `${label}: read returned ok without a document`);
  const textLength = typeof doc.text === "string" ? doc.text.length : 0;
  const details: StepDetails = {
    textLength,
    accessLevel: doc.accessLevel ?? null,
    hasTitle: nonEmpty(doc.title),
  };
  if (!nonEmpty(doc.title))
    throw new StepFailure("adapter_error", `${label}: the document has no title`, details);
  if (textLength < manifest.minReadChars) {
    throw new StepFailure(
      "adapter_error",
      `${label}: text has ${textLength} characters, fewer than minReadChars ${manifest.minReadChars}`,
      details,
    );
  }
  if (doc.accessLevel !== "public" && doc.accessLevel !== "subscriber") {
    throw new StepFailure("adapter_error", `${label}: accessLevel must be "public" or "subscriber"`, details);
  }
  if (requireSubscriber && doc.accessLevel !== "subscriber") {
    throw new StepFailure(
      "adapter_error",
      `${label}: expected accessLevel "subscriber" (the sample must be a page that needs the login), got "${doc.accessLevel}"`,
      details,
    );
  }
  return details;
}

export async function runValidation(options: RunValidationOptions): Promise<ValidationReport> {
  const clock = options.clock ?? systemClock;
  const { key, manifest, adapter, runner, form } = options;
  const smokeBudgetMs = options.smokeBudgetMs ?? DEFAULT_SMOKE_BUDGET_MS;
  const stepBudgetMs = options.stepBudgetMs ?? DEFAULT_VALIDATION_STEP_BUDGET_MS;
  const browserHosts = options.browserHosts ?? manifest.hostnames;
  const started = clock.now();
  const startedMs = started.getTime();
  const steps: ValidationStep[] = [];
  let failure: ValidationFailure | null = null;
  let gatedCheck: GatedCheck = "not_run";

  /** Light form: every step shares the 60 s smoke budget. */
  const budgetFor = (base: number): number => {
    if (form === "full") return base;
    const left = smokeBudgetMs - (clock.now().getTime() - startedMs);
    return Math.max(1, Math.min(base, left));
  };

  const record = async (
    name: ValidationStepName,
    fn: () => Promise<{ message: string; status?: OutcomeStatus | null; details?: StepDetails }>,
  ): Promise<boolean> => {
    if (failure !== null) return false;
    const t0 = clock.now().getTime();
    try {
      const r = await fn();
      steps.push({
        name,
        passed: true,
        status: r.status ?? null,
        message: r.message,
        durationMs: clock.now().getTime() - t0,
        details: r.details ?? {},
      });
      return true;
    } catch (error) {
      const sf =
        error instanceof StepFailure
          ? error
          : (() => {
              const o = errorToOutcome(error);
              return new StepFailure(o.status, `${name}: ${o.message}`, {}, o.action);
            })();
      steps.push({
        name,
        passed: false,
        status: sf.status,
        message: sf.message,
        durationMs: clock.now().getTime() - t0,
        details: sf.details,
      });
      failure = { step: name, status: sf.status, message: sf.message };
      if (sf.action !== undefined) failure.action = sf.action;
      return false;
    }
  };

  // (a) manifest + static check (full form).
  if (form === "full") {
    await record("manifest", async () => {
      if (manifest.key !== key)
        throw new StepFailure(
          "adapter_error",
          `manifest key "${manifest.key}" does not match the folder "${key}"`,
        );
      if (!manifest.capabilities.search && !manifest.capabilities.read) {
        throw new StepFailure("adapter_error", "the manifest declares neither search nor read");
      }
      if (!manifest.capabilities.search && manifest.sampleReadUrl === null && manifest.capabilities.read) {
        throw new StepFailure("adapter_error", "a read-only adapter needs sampleReadUrl");
      }
      return { message: "manifest is valid" };
    });
    await record("static", async () => {
      const s = options.staticResult;
      if (!s) throw new StepFailure("adapter_error", "static check did not run");
      if (!s.ok)
        throw new StepFailure(
          "adapter_error",
          `static check failed: ${describeStaticViolations(s.violations)}`,
          { violations: s.violations.length },
        );
      return { message: `static check passed (${s.files.length} files)`, details: { files: s.files.length } };
    });
  }

  // (b) search.
  let firstResultRef: DocumentRef | null = null;
  if (manifest.capabilities.search) {
    const limit = form === "light" ? LIGHT_SEARCH_LIMIT : FULL_SEARCH_LIMIT;
    let firstPage: { items: AdapterSearchItem[]; ids: string[] } | null = null;
    let nextCursor: string | null = null;
    await record("search", async () => {
      const response = await runner.step("validation: sample search", budgetFor(stepBudgetMs), (ctx) =>
        adapter.search({ text: manifest.sampleQuery, after: null, before: null, limit, cursor: null }, ctx),
      );
      firstPage = checkSearchPage(key, manifest, adapter, response, limit, "sample search");
      nextCursor =
        typeof response.nextCursor === "string" && response.nextCursor !== "" ? response.nextCursor : null;
      const firstId = firstPage.ids[0];
      if (firstId !== undefined) {
        const parsed = parseRef(firstId);
        if (parsed.kind !== "invalid") firstResultRef = toAdapterRef(parsed);
      }
      return {
        message: `sample search returned ${firstPage.items.length} results`,
        status: "ok",
        details: { results: firstPage.items.length, nextCursor: nextCursor !== null },
      };
    });

    if (form === "full" && manifest.capabilities.pagination) {
      await record("second_page", async () => {
        if (nextCursor === null)
          throw new StepFailure(
            "adapter_error",
            "pagination is declared but the first page has no nextCursor",
          );
        const cursor: string = nextCursor;
        const response = await runner.step("validation: second page", budgetFor(stepBudgetMs), (ctx) =>
          adapter.search({ text: manifest.sampleQuery, after: null, before: null, limit, cursor }, ctx),
        );
        const page = checkSearchPage(key, manifest, adapter, response, limit, "second page");
        const canonicalize = adapter.canonicalize?.bind(adapter);
        const seen = new Set((firstPage?.items ?? []).map((i) => normalizeUrl(i.url, { canonicalize })));
        const fresh = page.items.filter((i) => !seen.has(normalizeUrl(i.url, { canonicalize }))).length;
        if (fresh === 0)
          throw new StepFailure("adapter_error", "the second page repeats the first page", {
            results: page.items.length,
          });
        return {
          message: `second page returned ${page.items.length} results (${fresh} new)`,
          status: "ok",
          details: { results: page.items.length, fresh },
        };
      });
    }
  }

  // (c) read of the sample.
  if (manifest.capabilities.read) {
    await record("read", async () => {
      const ref: DocumentRef | null =
        manifest.sampleReadUrl !== null ? { url: manifest.sampleReadUrl } : firstResultRef;
      if (ref === null)
        throw new StepFailure("adapter_error", "no sample to read: set sampleReadUrl or enable search");
      const response = await runner.step("validation: sample read", budgetFor(stepBudgetMs), (ctx) =>
        adapter.read(ref, ctx),
      );
      const details = checkReadResponse(manifest, response, "sample read", manifest.requiresLogin);
      return {
        message: `sample read ok (${String(details["textLength"])} characters, ${String(details["accessLevel"])})`,
        status: "ok",
        details: { ...details, source: manifest.sampleReadUrl !== null ? "sampleReadUrl" : "first result" },
      };
    });
  }

  // (d) gated sample (full form).
  if (form === "full" && failure === null) {
    const gatedUrl = manifest.gatedSampleUrl;
    if (gatedUrl === null) {
      gatedCheck = "not_applicable";
      steps.push({
        name: "gated",
        passed: true,
        status: null,
        message: "no identifiable gated page (gatedCheck: not_applicable)",
        durationMs: 0,
        details: {},
      });
    } else {
      const passed = await record("gated", async () => {
        if (typeof adapter.checkCompleteness !== "function") {
          throw new StepFailure(
            "adapter_error",
            "gatedSampleUrl is set but the adapter declares no completeness detector (checkCompleteness)",
          );
        }
        const response = await runner.step("validation: gated read", budgetFor(stepBudgetMs), (ctx) =>
          adapter.read({ url: gatedUrl }, ctx),
        );
        const details = checkReadResponse(manifest, response, "gated read (logged in)", true);
        if (!options.anonymousFetch)
          throw new StepFailure("adapter_error", "cannot fetch the logged-out form (no anonymous fetcher)");
        let page: CompletenessInput;
        try {
          page = await options.anonymousFetch(gatedUrl, browserHosts);
        } catch (error) {
          throw new StepFailure(
            "adapter_error",
            `cannot fetch the logged-out form of the gated page: ${(error as Error).message}`,
            details,
          );
        }
        let verdict;
        try {
          verdict = adapter.checkCompleteness(page);
        } catch (error) {
          throw new StepFailure(
            "adapter_error",
            `the completeness detector threw: ${(error as Error).message}`,
            details,
          );
        }
        const verdictStatus: OutcomeStatus = coerceAdapterStatus(verdict?.status, 0);
        const loggedOut: StepDetails = {
          ...details,
          loggedOutHttpStatus: page.httpStatus,
          loggedOutVerdict: String(verdict?.status),
        };
        if (verdict?.status === "ok" || !isFailureStatus(verdictStatus)) {
          throw new StepFailure(
            "adapter_error",
            "the completeness detector classified the logged-out form of the gated page as ok (a teaser or login wall would be served as full text)",
            loggedOut,
          );
        }
        return {
          message: `gated page reads as subscriber; logged-out form classified ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ""}`,
          status: "ok",
          details: loggedOut,
        };
      });
      gatedCheck = passed ? "passed" : "failed";
    }
  }

  // The adapter's own smoke test (full form) within the smoke budget.
  if (form === "full") {
    await record("smoke", async () => {
      const result = await runner.step("validation: smoke test", smokeBudgetMs, (ctx) =>
        adapter.smokeTest(ctx),
      );
      const status = coerceAdapterStatus(result?.status, 1);
      if (status !== "ok") {
        throw new StepFailure(
          failureStatusOf(status),
          `smokeTest returned ${String(result?.status)}: ${result?.message ?? ""}`.trim(),
        );
      }
      return { message: "smokeTest passed", status: "ok" };
    });
  }

  const finished = clock.now();
  return {
    version: 1,
    key,
    form,
    target: options.target,
    passed: failure === null,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - startedMs,
    adapterHash: options.adapterHash ?? null,
    manifestVersion: manifest.version,
    gatedCheck,
    failure,
    steps,
  };
}

/** A failed report for problems found before the adapter could be imported (manifest, static check, import). */
export function preImportFailure(input: {
  key: string;
  form: ValidationForm;
  target: "live" | "staging";
  step: ValidationStepName;
  message: string;
  at: Date;
  adapterHash?: string | null | undefined;
  manifestVersion?: number | null | undefined;
  details?: StepDetails | undefined;
}): ValidationReport {
  const iso = input.at.toISOString();
  return {
    version: 1,
    key: input.key,
    form: input.form,
    target: input.target,
    passed: false,
    startedAt: iso,
    finishedAt: iso,
    durationMs: 0,
    adapterHash: input.adapterHash ?? null,
    manifestVersion: input.manifestVersion ?? null,
    gatedCheck: "not_run",
    failure: { step: input.step, status: "adapter_error", message: input.message },
    steps: [
      {
        name: input.step,
        passed: false,
        status: "adapter_error",
        message: input.message,
        durationMs: 0,
        details: input.details ?? {},
      },
    ],
  };
}
