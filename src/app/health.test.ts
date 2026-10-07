import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, silentLogger, writeAdapterFolder } from "../../test/support/site-fixtures.js";
import { InMemoryScheduler } from "../adapters/aside/scheduler.js";
import { ModuleAdapterLoader } from "../adapters/registry/loader.js";
import { SiteRegistryService } from "../adapters/registry/registry.js";
import { FileCache } from "../adapters/storage/cache-store.js";
import { FileSiteStateStore } from "../adapters/storage/site-state-store.js";
import type { Outcome } from "../core/models.js";
import { OutcomeError } from "../core/outcome.js";
import { HealthChecker } from "./health.js";

describe("HealthChecker", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let registry: SiteRegistryService;
  let scheduler: InMemoryScheduler;
  let cache: FileCache;
  let nowMs: number;
  let outcomes: Map<string, Outcome | Error>;
  let calls: { key: string; ignoreCooldown: boolean }[];

  const checker = (intervalMs = 86_400_000) =>
    new HealthChecker({
      registry,
      scheduler,
      intervalMs,
      clock: { now: () => new Date(nowMs) },
      logger: silentLogger,
      check: async (key, opts) => {
        calls.push({ key, ignoreCooldown: opts.ignoreCooldown });
        const o = outcomes.get(key) ?? { status: "ok" };
        if (o instanceof Error) throw o;
        return o;
      },
    });

  beforeEach(async () => {
    tmp = await makeTempDir();
    const sitesDir = join(tmp.dir, "sites");
    await mkdir(sitesDir, { recursive: true });
    await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
    await writeAdapterFolder(join(sitesDir, "beta"), "beta");
    nowMs = Date.parse("2026-10-05T10:00:00Z");
    cache = new FileCache(join(tmp.dir, "data", "cache"));
    scheduler = new InMemoryScheduler({ now: () => nowMs });
    registry = new SiteRegistryService({
      sitesDir,
      stateStore: new FileSiteStateStore(join(tmp.dir, "data", "sites.json")),
      loader: new ModuleAdapterLoader({ repoRoot: process.cwd(), preferCompiled: false }),
      cache,
      clock: { now: () => new Date(nowMs) },
      logger: silentLogger,
    });
    await registry.init();
    outcomes = new Map();
    calls = [];
  });
  afterEach(async () => tmp.cleanup());

  it("checks fresh-clone sites (never checked) at the next run and records the check time", async () => {
    const h = checker();
    expect(h.dueSites()).toEqual(["alpha", "beta"]);
    const results = await h.runDue();
    expect(results.map((r) => [r.site, r.ran, r.status])).toEqual([
      ["alpha", true, "active"],
      ["beta", true, "active"],
    ]);
    expect(registry.get("alpha")?.lastCheckedAt).toBe(new Date(nowMs).toISOString());
    expect(h.dueSites()).toEqual([]);
    nowMs += 86_400_000;
    expect(h.dueSites()).toEqual(["alpha", "beta"]);
  });

  it("auth_required → needs_login; any other failure → degraded with the message", async () => {
    outcomes.set("alpha", { status: "auth_required", message: "login wall" });
    outcomes.set("beta", new OutcomeError("adapter_error", "selector not found"));
    await checker().runDue();
    expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });
    expect(registry.get("beta")).toMatchObject({ status: "degraded", lastFailure: "selector not found" });
  });

  it("Check now: a passing check returns needs_login to active and clears the cache", async () => {
    outcomes.set("alpha", { status: "auth_required", message: "login wall" });
    await checker().runNow("alpha");
    await cache.set("read", "alpha:1", "doc", { ttlMs: 60_000, sites: ["alpha"] });
    outcomes.set("alpha", { status: "ok" });
    const r = await checker().runNow("alpha");
    expect(r).toMatchObject({ site: "alpha", ran: true, status: "active" });
    expect(calls.at(-1)).toEqual({ key: "alpha", ignoreCooldown: true });
    expect(await cache.get("read", "alpha:1")).toBeUndefined();
  });

  it("runs only when the site is idle", async () => {
    let release!: () => void;
    const busy = scheduler.runForSite(
      { site: "alpha", holder: "repair running", acquireTimeoutMs: 1000, minIntervalMs: 0 },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await Promise.resolve();
    const r = await checker().runNow("alpha");
    expect(r).toEqual({ site: "alpha", ran: false, skipped: "site busy: repair running", status: "active" });
    const pass = await checker().runDue();
    expect(pass.find((x) => x.site === "alpha")?.ran).toBe(false);
    expect(calls.map((c) => c.key)).toEqual(["beta"]);
    release();
    await busy;
  });

  it("the timer pass skips cooling-down sites; Check now does not", async () => {
    scheduler.setCooldown("alpha", nowMs + 60_000);
    const pass = await checker().runDue();
    expect(pass.find((x) => x.site === "alpha")).toMatchObject({
      ran: false,
      skipped: "site is cooling down",
    });
    expect((await checker().runNow("alpha")).ran).toBe(true);
  });

  it("browser_unavailable leaves the status and the due time alone", async () => {
    outcomes.set("alpha", { status: "browser_unavailable", message: "Aside is not running" });
    const h = checker();
    await h.runNow("alpha");
    expect(registry.get("alpha")).toMatchObject({ status: "active", lastCheckedAt: null });
    expect(h.dueSites()).toContain("alpha");
  });

  it("skips sites that are not serving", async () => {
    await registry.registerOnboarding({ hostnames: ["new.example.org"], key: "newsite" });
    expect(await checker().runNow("newsite")).toMatchObject({
      ran: false,
      skipped: "site not ready: onboarding",
    });
    expect(await checker().runNow("unknown")).toMatchObject({ ran: false, skipped: "site not registered" });
  });

  it("the daily timer runs a pass after the initial delay", async () => {
    const h = new HealthChecker({
      registry,
      scheduler,
      intervalMs: 86_400_000,
      initialDelayMs: 0,
      check: async (key) => {
        calls.push({ key, ignoreCooldown: false });
        return { status: "ok" };
      },
    });
    h.start();
    await new Promise((r) => setTimeout(r, 50));
    h.stop();
    expect(calls.map((c) => c.key)).toEqual(["alpha", "beta"]);
  });
});
