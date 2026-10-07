/**
 * Decision logic of the validation core with a fake adapter and runner. (Real validation runs the
 * same logic against the live site through the browser port; site behavior is never mocked there.)
 */
import { describe, expect, it } from "vitest";
import type {
  AdapterContext,
  AdapterReadResponse,
  AdapterSearchRequest,
  AdapterSearchResponse,
  CompletenessInput,
  CompletenessVerdict,
  SiteAdapter,
} from "../../ports/adapter.js";
import { siteManifestSchema } from "../../ports/manifest.js";
import type { SiteManifest } from "../../ports/manifest.js";
import { OutcomeError } from "../../core/outcome.js";
import { reportToOutcome } from "./report.js";
import type { StaticCheckResult } from "./static-check.js";
import { runValidation } from "./validate.js";
import type { RunValidationOptions, ValidationRunner } from "./validate.js";

const LONG_TEXT = "Paragraph of article text. ".repeat(20);

function manifest(patch: Record<string, unknown> = {}): SiteManifest {
  return siteManifestSchema.parse({
    key: "demo",
    name: "Demo",
    hostnames: ["demo.example.com"],
    timezone: "UTC",
    capabilities: { search: true, read: true, pagination: false },
    sampleQuery: "oil",
    createdBy: "human",
    ...patch,
  });
}

function item(n: number, host = "demo.example.com") {
  return {
    title: `Story ${n}`,
    url: `https://${host}/story/${n}`,
    publishedAt: null,
    datePrecision: null,
    excerpt: null,
    author: null,
  };
}

interface FakeOptions {
  search?: (req: AdapterSearchRequest) => AdapterSearchResponse;
  read?: (ref: { url?: string; localId?: string }) => AdapterReadResponse;
  smoke?: () => { status: "ok" | "adapter_error"; message?: string };
  checkCompleteness?: ((page: CompletenessInput) => CompletenessVerdict) | null;
}

function fakeAdapter(
  o: FakeOptions = {},
): SiteAdapter & { searches: AdapterSearchRequest[]; reads: unknown[] } {
  const searches: AdapterSearchRequest[] = [];
  const reads: unknown[] = [];
  const adapter: SiteAdapter & { searches: AdapterSearchRequest[]; reads: unknown[] } = {
    searches,
    reads,
    async search(req) {
      searches.push(req);
      if (o.search) return o.search(req);
      const base = req.cursor === null ? 0 : 10;
      return {
        results: [1, 2, 3].slice(0, req.limit).map((n) => item(base + n)),
        nextCursor: "c2",
        status: "ok",
      };
    },
    async read(ref) {
      reads.push(ref);
      if (o.read) return o.read(ref);
      return {
        status: "ok",
        document: {
          title: "Story",
          url: ref.url ?? "https://demo.example.com/story/1",
          publishedAt: null,
          datePrecision: null,
          author: null,
          text: LONG_TEXT,
          accessLevel: "public",
          metadata: {},
        },
      };
    },
    async smokeTest() {
      return o.smoke ? o.smoke() : { status: "ok" };
    },
  };
  if (o.checkCompleteness !== null) {
    adapter.checkCompleteness =
      o.checkCompleteness ??
      ((page) =>
        page.html.includes("Subscribe to continue")
          ? { status: "auth_required", reason: "teaser" }
          : { status: "ok" });
  }
  return adapter;
}

const fakeCtx = {} as AdapterContext;
function fakeRunner(): ValidationRunner & { labels: string[]; budgets: number[] } {
  const labels: string[] = [];
  const budgets: number[] = [];
  return {
    labels,
    budgets,
    async step(label, budgetMs, fn) {
      labels.push(label);
      budgets.push(budgetMs);
      return fn(fakeCtx);
    },
  };
}

const staticOk: StaticCheckResult = { ok: true, files: ["adapter.ts"], violations: [] };

function opts(patch: Partial<RunValidationOptions> & { adapter: SiteAdapter }): RunValidationOptions {
  return {
    form: "full",
    key: "demo",
    target: "staging",
    manifest: manifest(),
    runner: fakeRunner(),
    staticResult: staticOk,
    anonymousFetch: async (url) => ({ url, httpStatus: 200, html: "<p>Subscribe to continue reading</p>" }),
    ...patch,
  };
}

describe("full validation", () => {
  it("passes a well-behaved adapter and records not_applicable without a gated URL", async () => {
    const adapter = fakeAdapter();
    const report = await runValidation(opts({ adapter }));
    expect(report.passed).toBe(true);
    expect(report.failure).toBeNull();
    expect(report.gatedCheck).toBe("not_applicable");
    expect(report.steps.map((s) => s.name)).toEqual([
      "manifest",
      "static",
      "search",
      "read",
      "gated",
      "smoke",
    ]);
    expect(adapter.searches[0]).toMatchObject({ text: "oil", limit: 10, cursor: null });
    // No sampleReadUrl: the first result is read through its result id (URL fallback id → url ref).
    expect(adapter.reads[0]).toEqual({ url: "https://demo.example.com/story/1" });
  });

  it("fails when the sample search is empty (adapter_error, never empty)", async () => {
    const adapter = fakeAdapter({ search: () => ({ results: [], nextCursor: null, status: "ok" }) });
    const report = await runValidation(opts({ adapter }));
    expect(report.passed).toBe(false);
    expect(report.failure).toMatchObject({ step: "search", status: "adapter_error" });
    expect(report.failure?.message).toContain("no results");
    expect(reportToOutcome(report).status).toBe("adapter_error");
  });

  it("passes a search auth_required through as the failure status", async () => {
    const adapter = fakeAdapter({
      search: () => ({ results: [], nextCursor: null, status: "auth_required", message: "login wall" }),
    });
    const report = await runValidation(opts({ adapter }));
    expect(report.failure).toMatchObject({ step: "search", status: "auth_required" });
    expect(reportToOutcome(report).status).toBe("auth_required");
  });

  it("fails results off the site's hostnames or without a title", async () => {
    const off = fakeAdapter({
      search: () => ({ results: [item(1, "evil.example.org")], nextCursor: null, status: "ok" }),
    });
    expect((await runValidation(opts({ adapter: off }))).failure?.message).toContain(
      "not on the site's hostnames",
    );
    const untitled = fakeAdapter({
      search: () => ({ results: [{ ...item(1), title: " " }], nextCursor: null, status: "ok" }),
    });
    expect((await runValidation(opts({ adapter: untitled }))).failure?.message).toContain("no title");
  });

  it("accepts results on a subdomain of a declared hostname", async () => {
    const adapter = fakeAdapter({
      search: () => ({ results: [item(1, "m.demo.example.com")], nextCursor: null, status: "ok" }),
    });
    expect((await runValidation(opts({ adapter }))).passed).toBe(true);
  });

  it("requires a second, different page when pagination is declared", async () => {
    const m = manifest({ capabilities: { search: true, read: true, pagination: true } });
    expect((await runValidation(opts({ adapter: fakeAdapter(), manifest: m }))).passed).toBe(true);

    const repeating = fakeAdapter({
      search: () => ({ results: [item(1), item(2)], nextCursor: "again", status: "ok" }),
    });
    const r1 = await runValidation(opts({ adapter: repeating, manifest: m }));
    expect(r1.failure).toMatchObject({ step: "second_page" });
    expect(r1.failure?.message).toContain("repeats");

    const noCursor = fakeAdapter({ search: () => ({ results: [item(1)], nextCursor: null, status: "ok" }) });
    expect((await runValidation(opts({ adapter: noCursor, manifest: m }))).failure?.message).toContain(
      "no nextCursor",
    );
  });

  it("fails a read shorter than minReadChars", async () => {
    const adapter = fakeAdapter({
      read: () => ({
        status: "ok",
        document: {
          title: "T",
          url: "https://demo.example.com/a",
          publishedAt: null,
          datePrecision: null,
          author: null,
          text: "short teaser",
          accessLevel: "public",
          metadata: {},
        },
      }),
    });
    const report = await runValidation(opts({ adapter }));
    expect(report.failure).toMatchObject({ step: "read", status: "adapter_error" });
    expect(report.failure?.message).toContain("minReadChars");
  });

  it("fails a requiresLogin site whose sample is not read as subscriber", async () => {
    const m = manifest({ requiresLogin: true, sampleReadUrl: "https://demo.example.com/premium/1" });
    const report = await runValidation(opts({ adapter: fakeAdapter(), manifest: m }));
    expect(report.failure).toMatchObject({ step: "read" });
    expect(report.failure?.message).toContain("subscriber");
  });

  it("passes a requiresLogin site whose sample reads as subscriber", async () => {
    const m = manifest({ requiresLogin: true, sampleReadUrl: "https://demo.example.com/premium/1" });
    const adapter = fakeAdapter({
      read: (ref) => ({
        status: "ok",
        document: {
          title: "T",
          url: ref.url ?? "",
          publishedAt: null,
          datePrecision: null,
          author: null,
          text: LONG_TEXT,
          accessLevel: "subscriber",
          metadata: {},
        },
      }),
    });
    const report = await runValidation(opts({ adapter, manifest: m }));
    expect(report.passed).toBe(true);
    expect(adapter.reads[0]).toEqual({ url: "https://demo.example.com/premium/1" });
  });

  describe("gated sample (step d)", () => {
    const m = manifest({ gatedSampleUrl: "https://demo.example.com/premium/9" });
    const subscriberRead = (ref: { url?: string }): AdapterReadResponse => ({
      status: "ok",
      document: {
        title: "T",
        url: ref.url ?? "",
        publishedAt: null,
        datePrecision: null,
        author: null,
        text: LONG_TEXT,
        accessLevel: ref.url?.includes("premium") ? "subscriber" : "public",
        metadata: {},
      },
    });

    it("passes when logged-in read is subscriber and the detector rejects the logged-out form", async () => {
      const fetched: string[] = [];
      const report = await runValidation(
        opts({
          adapter: fakeAdapter({ read: subscriberRead }),
          manifest: m,
          anonymousFetch: async (url, hosts) => {
            fetched.push(`${url} ${hosts.join(",")}`);
            return { url, httpStatus: 200, html: "<p>Subscribe to continue reading</p>" };
          },
        }),
      );
      expect(report.passed).toBe(true);
      expect(report.gatedCheck).toBe("passed");
      expect(fetched).toEqual(["https://demo.example.com/premium/9 demo.example.com"]);
    });

    it("fails when the detector calls the logged-out teaser ok (incomplete text would be served)", async () => {
      const report = await runValidation(
        opts({
          adapter: fakeAdapter({ read: subscriberRead, checkCompleteness: () => ({ status: "ok" }) }),
          manifest: m,
        }),
      );
      expect(report.passed).toBe(false);
      expect(report.gatedCheck).toBe("failed");
      expect(report.failure?.message).toContain("classified the logged-out form");
    });

    it("fails without a completeness detector", async () => {
      const report = await runValidation(
        opts({ adapter: fakeAdapter({ read: subscriberRead, checkCompleteness: null }), manifest: m }),
      );
      expect(report.gatedCheck).toBe("failed");
      expect(report.failure?.message).toContain("checkCompleteness");
    });

    it("fails when the gated page does not read as subscriber while logged in", async () => {
      const report = await runValidation(opts({ adapter: fakeAdapter(), manifest: m }));
      expect(report.gatedCheck).toBe("failed");
      expect(report.failure?.message).toContain("subscriber");
    });
  });

  it("fails on a static-check violation before any browser step", async () => {
    const runner = fakeRunner();
    const report = await runValidation(
      opts({
        adapter: fakeAdapter(),
        runner,
        staticResult: {
          ok: false,
          files: ["adapter.ts"],
          violations: [{ file: "adapter.ts", line: 1, rule: "process-env", detail: "reads process.env" }],
        },
      }),
    );
    expect(report.failure).toMatchObject({ step: "static" });
    expect(runner.labels).toEqual([]);
  });

  it("maps a thrown step error (e.g. browser timeout) to its status", async () => {
    const adapter = fakeAdapter({
      search: () => {
        throw new OutcomeError("timeout", "site busy: repair running");
      },
    });
    const report = await runValidation(opts({ adapter }));
    expect(report.failure).toMatchObject({ step: "search", status: "timeout" });
  });

  it("requires the adapter's smokeTest to pass within the smoke budget", async () => {
    const runner = fakeRunner();
    const report = await runValidation(
      opts({
        adapter: fakeAdapter({ smoke: () => ({ status: "adapter_error", message: "selector gone" }) }),
        runner,
      }),
    );
    expect(report.failure).toMatchObject({ step: "smoke", status: "adapter_error" });
    expect(runner.budgets.at(-1)).toBe(60_000);
  });
});

describe("light validation (health check)", () => {
  it("runs search with limit 3 and the read only, within the 60 s budget", async () => {
    const adapter = fakeAdapter();
    const runner = fakeRunner();
    const report = await runValidation({
      form: "light",
      key: "demo",
      target: "live",
      manifest: manifest({
        capabilities: { search: true, read: true, pagination: true },
        gatedSampleUrl: "https://demo.example.com/p",
      }),
      adapter,
      runner,
    });
    expect(report.passed).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["search", "read"]);
    expect(report.gatedCheck).toBe("not_run");
    expect(adapter.searches).toHaveLength(1);
    expect(adapter.searches[0]?.limit).toBe(3);
    expect(runner.budgets.every((b) => b <= 60_000)).toBe(true);
  });

  it("a read-only site is checked by its sample read", async () => {
    const m = manifest({
      capabilities: { search: false, read: true },
      sampleQuery: "",
      sampleReadUrl: "https://demo.example.com/a",
    });
    const adapter = fakeAdapter();
    const report = await runValidation({
      form: "light",
      key: "demo",
      target: "live",
      manifest: m,
      adapter,
      runner: fakeRunner(),
    });
    expect(report.passed).toBe(true);
    expect(adapter.searches).toHaveLength(0);
  });

  it("reports auth_required from the read so the health check can move the site to needs_login", async () => {
    const adapter = fakeAdapter({ read: () => ({ status: "auth_required", message: "login wall" }) });
    const report = await runValidation({
      form: "light",
      key: "demo",
      target: "live",
      manifest: manifest(),
      adapter,
      runner: fakeRunner(),
    });
    expect(reportToOutcome(report)).toEqual({
      status: "auth_required",
      message: "sample read: read returned auth_required: login wall",
    });
  });
});
