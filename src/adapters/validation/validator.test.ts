/**
 * SiteValidator wiring with real temp folders, the real scheduler, and a fake browser port whose
 * sessions only record their scope (the test adapters never touch the browser).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  challengeAttempt,
  fakeBrowser,
  makeTempDir,
  manifestFor,
  silentLogger,
  writeAdapterFolder,
} from "../../../test/support/site-fixtures.js";
import type { FakeBrowser } from "../../../test/support/site-fixtures.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import { ModuleAdapterLoader } from "../registry/loader.js";
import type { AdapterHelpers } from "../../ports/adapter.js";
import { createAdapterHelpers } from "../../adapter-kit/helpers.js";
import { readValidationReport } from "./report.js";
import { lightCheck } from "./index.js";
import { SiteValidator } from "./validator.js";

const helpers: AdapterHelpers = {
  ...createAdapterHelpers(),
  parseDate: () => null,
  extractText: (html) => html,
};

function goodAdapter(tag: string): string {
  return `const tag: string = ${JSON.stringify(tag)};
const text = "A full paragraph of article text. ".repeat(20);
export default {
  tag,
  async search(req: { limit: number; cursor: string | null }) {
    const base = req.cursor === null ? 0 : 100;
    const results = [1, 2, 3].slice(0, req.limit).map((n) => ({
      title: "Story " + (base + n), url: "https://demo.example.com/s/" + (base + n),
      publishedAt: null, datePrecision: null, excerpt: null, author: null,
    }));
    return { results, nextCursor: "next", status: "ok" };
  },
  async read(ref: { url?: string }) {
    return { status: "ok", document: { title: "Story", url: ref.url ?? "", publishedAt: null, datePrecision: null, author: null, text, accessLevel: "public", metadata: {} } };
  },
  async smokeTest() { return { status: "ok" }; },
};
`;
}

/** An adapter whose read (or search) meets a captcha page. */
function blockedAdapter(where: "read" | "search"): string {
  const blocked = '{ status: "access_denied", message: "captcha page", blocked: true }';
  return `export default {
  async search() {
    ${where === "search" ? `return { results: [], nextCursor: null, ...${blocked} };` : 'return { results: [{ title: "Story 1", url: "https://demo.example.com/s/1", publishedAt: null, datePrecision: null, excerpt: null, author: null }], nextCursor: null, status: "ok" };'}
  },
  async read() { return ${blocked}; },
  async smokeTest() { return { status: "ok" }; },
};
`;
}

describe("SiteValidator", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let sitesDir: string;
  let browser: FakeBrowser;
  let scheduler: InMemoryScheduler;
  let holders: string[];
  let exclusives: boolean[];

  const validator = (owner: (h: string) => string | null = () => null) =>
    new SiteValidator({
      sitesDir,
      repoRoot: process.cwd(),
      loader: new ModuleAdapterLoader({ repoRoot: process.cwd(), preferCompiled: false }),
      runtime: { browser, scheduler, helpers, logger: silentLogger },
      hostnameOwner: owner,
      logger: silentLogger,
    });

  beforeEach(async () => {
    tmp = await makeTempDir();
    sitesDir = join(tmp.dir, "sites");
    await mkdir(sitesDir, { recursive: true });
    browser = fakeBrowser();
    scheduler = new InMemoryScheduler();
    holders = [];
    exclusives = [];
    const run = scheduler.runForSite.bind(scheduler);
    scheduler.runForSite = (options, task) => {
      holders.push(options.holder);
      exclusives.push(options.exclusive === true);
      return run(options, task);
    };
  });
  afterEach(async () => tmp.cleanup());

  it("validates a staged adapter, scopes the browser to hostnames ∪ extraAllowedHosts, and writes validation.json", async () => {
    const staging = join(sitesDir, "demo", ".staging");
    await writeAdapterFolder(staging, "demo", {
      manifest: manifestFor("demo", {
        hostnames: ["demo.example.com"],
        extraAllowedHosts: ["sso.example.net"],
      }),
      adapter: goodAdapter("v1"),
      validated: false,
    });
    const report = await validator().full("demo", { staging: true });
    expect(report.passed).toBe(true);
    expect(report.target).toBe("staging");
    expect(report.gatedCheck).toBe("not_applicable");
    expect(report.adapterHash).toMatch(/^[0-9a-f]{64}$/);
    const written = await readValidationReport(staging);
    expect(written).toMatchObject({ passed: true, key: "demo", form: "full" });
    expect(browser.scopes[0]?.hostnames).toEqual(["demo.example.com", "sso.example.net"]);
    expect(browser.scopes[0]?.lease).toBeDefined();
    expect(browser.disposed).toBe(browser.scopes.length);
    expect(new Set(holders)).toEqual(new Set(["validation"]));
    // Real-site validation holds the site alone (exclusive).
    expect(exclusives.length).toBeGreaterThan(0);
    expect(exclusives.every((x) => x)).toBe(true);
  });

  it("full validation respects the site's cool-down unless the caller passes ignoreCooldown", async () => {
    const staging = join(sitesDir, "demo", ".staging");
    await writeAdapterFolder(staging, "demo", {
      manifest: manifestFor("demo", { hostnames: ["demo.example.com"] }),
      adapter: goodAdapter("v1"),
      validated: false,
    });
    scheduler.setCooldown("demo", Date.now() + 600_000);
    const cooled = await validator().full("demo", { staging: true });
    expect(cooled.passed).toBe(false);
    expect(cooled.failure).toMatchObject({ status: "rate_limited" });
    expect(browser.scopes).toEqual([]);
    const forced = await validator().full("demo", { staging: true, ignoreCooldown: true });
    expect(forced.passed).toBe(true);
  });

  it("never imports an adapter that fails the static check", async () => {
    const dir = join(sitesDir, "demo");
    const marker = join(tmp.dir, "imported.txt");
    await writeAdapterFolder(dir, "demo", {
      adapter: `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default {};\n`,
      validated: false,
    });
    const report = await validator().full("demo");
    expect(report.failure).toMatchObject({ step: "static" });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect(browser.scopes).toEqual([]);
    expect((await readValidationReport(dir))?.passed).toBe(false);
  });

  it("rejects a manifest whose hostname another site owns, or whose key does not match", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo", {
      adapter: goodAdapter("v1"),
      validated: false,
    });
    const owned = await validator((h) => (h === "demo.example.com" ? "other" : null)).full("demo");
    expect(owned.failure?.message).toContain("already registered as other");
    await writeAdapterFolder(join(sitesDir, "wrong"), "wrong", {
      manifest: manifestFor("right"),
      validated: false,
    });
    expect((await validator().full("wrong")).failure?.message).toContain("does not match");
  });

  it("a failed re-validation of a live adapter keeps its passed record (the site stays loadable)", async () => {
    const dir = join(sitesDir, "demo");
    await writeAdapterFolder(dir, "demo", { adapter: goodAdapter("v1") });
    await writeFile(
      join(dir, "adapter.ts"),
      goodAdapter("v1").replace('status: "ok", document', 'status: "auth_required", document'),
    );
    const report = await validator().full("demo");
    expect(report.passed).toBe(false);
    expect((await readValidationReport(dir))?.passed).toBe(true);
  });

  it("light form: health-check holder, limit 3, no validation.json write, outcome for the lifecycle", async () => {
    const dir = join(sitesDir, "demo");
    await writeAdapterFolder(dir, "demo", { adapter: goodAdapter("v1") });
    const before = await readFile(join(dir, "validation.json"), "utf8");
    const report = await validator().light("demo");
    expect(report.passed).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual(["search", "read"]);
    expect(new Set(holders)).toEqual(new Set(["health check"]));
    // A health check holds the site alone (exclusive), like full validation.
    expect(exclusives.length).toBeGreaterThan(0);
    expect(exclusives.every((x) => x)).toBe(true);
    expect(await readFile(join(dir, "validation.json"), "utf8")).toBe(before);
    expect(await lightCheck(validator())("demo", { ignoreCooldown: true })).toEqual({ status: "ok" });
  });

  it("refuses invalid keys without touching the file system", async () => {
    const report = await validator().full("../escape");
    expect(report.passed).toBe(false);
    expect(report.failure?.message).toContain("invalid site key");
  });

  it("light form reports a blocked search on the page the adapter's session last showed (its search page)", async () => {
    await writeAdapterFolder(join(sitesDir, "other"), "other", {
      manifest: manifestFor("other", { hostnames: ["other.example.com"] }),
      adapter: blockedAdapter("search"),
    });
    browser.lastUrls.set("other", "https://other.example.com/search?q=sample");
    expect(await lightCheck(validator())("other", {})).toMatchObject({
      status: "access_denied",
      blocked: { url: "https://other.example.com/search?q=sample" },
    });
  });

  it("light form reports the block page it met (read: its URL; search: none) for Check now", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo", {
      manifest: manifestFor("demo", { hostnames: ["demo.example.com"] }),
      adapter: blockedAdapter("read"),
    });
    const seen: { url: string | null }[] = [];
    const report = await validator().light("demo", { onBlocked: (b) => seen.push(b) });
    expect(report.passed).toBe(false);
    expect(report.failure).toMatchObject({ step: "read", status: "access_denied" });
    expect(seen).toEqual([{ url: "https://demo.example.com/s/1" }]);
    expect(await lightCheck(validator())("demo", { ignoreCooldown: true })).toEqual({
      status: "access_denied",
      message: expect.stringContaining("captcha page") as string,
      blocked: { url: "https://demo.example.com/s/1" },
    });

    await writeAdapterFolder(join(sitesDir, "other"), "other", {
      manifest: manifestFor("other", { hostnames: ["other.example.com"] }),
      adapter: blockedAdapter("search"),
    });
    expect(await lightCheck(validator())("other", {})).toMatchObject({
      status: "access_denied",
      blocked: { url: null },
    });
  });

  it("validation never attempts a captcha (full form on a blocked adapter)", async () => {
    browser = fakeBrowser({ solveChallenge: async () => challengeAttempt() });
    const staging = join(sitesDir, "demo", ".staging");
    await writeAdapterFolder(staging, "demo", {
      manifest: manifestFor("demo", { hostnames: ["demo.example.com"] }),
      adapter: blockedAdapter("read"),
      validated: false,
    });
    const report = await validator().full("demo", { staging: true });
    expect(report.passed).toBe(false);
    expect(report.failure).toMatchObject({ step: "read", status: "access_denied" });
    expect(browser.challenges).toEqual([]);
    expect(holders.includes("captcha")).toBe(false);
  });
});
