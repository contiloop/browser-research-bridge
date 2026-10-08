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
import type { HealthCheckOutcome } from "./health.js";

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
      { site: "alpha", holder: "repair running", acquireTimeoutMs: 1000, minIntervalMs: 0, exclusive: true },
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

  it("skips a site while pooled tool calls run on it and names them", async () => {
    const releases: (() => void)[] = [];
    const busy = ["search", "fetch"].map((holder) =>
      scheduler.runForSite(
        { site: "alpha", holder, acquireTimeoutMs: 1000, minIntervalMs: 0 },
        () => new Promise<void>((resolve) => releases.push(resolve)),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduler.holders("alpha")).toEqual(["search", "fetch"]);
    const r = await checker().runNow("alpha");
    expect(r).toEqual({ site: "alpha", ran: false, skipped: "site busy: search, fetch", status: "active" });
    releases.forEach((release) => release());
    await Promise.all(busy);
    expect((await checker().runNow("alpha")).ran).toBe(true);
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

  describe("captcha attempts on Check now", () => {
    const BLOCKED = { status: "access_denied", message: "captcha page", blocked: { url: null } } as const;
    const ACTION =
      "The captcha could not be solved automatically. Open https://alpha.example.com/ in Aside, solve it, then retry";
    let attempts: { key: string; url: string | null }[];
    let checks: HealthCheckOutcome[];
    let ran: boolean;
    let solverMessage: string | undefined;
    let order: string[];

    const withChallenges = (enabled = true) =>
      new HealthChecker({
        registry,
        scheduler,
        intervalMs: 86_400_000,
        clock: { now: () => new Date(nowMs) },
        logger: silentLogger,
        check: async () => {
          order.push("check");
          return checks.shift() ?? { status: "ok" };
        },
        challenges: {
          enabled,
          attempt: async (key, url) => {
            order.push("attempt");
            // The light check (an exclusive task) has ended: the site is free for the pool task.
            expect(scheduler.isIdle(key)).toBe(true);
            attempts.push({ key, url });
            return {
              ran,
              result: ran ? "unsolved" : "unavailable",
              url: url ?? "https://alpha.example.com/",
              action: ACTION,
              ...(solverMessage !== undefined ? { message: solverMessage } : {}),
            };
          },
        },
      });

    beforeEach(() => {
      attempts = [];
      checks = [];
      ran = true;
      solverMessage = undefined;
      order = [];
    });

    it("blocked → one attempt → the light check once more; the second result sets the status", async () => {
      checks = [{ ...BLOCKED, blocked: { url: "https://alpha.example.com/a/1" } }, { status: "ok" }];
      await registry.recordHealthCheck("alpha", { status: "adapter_error", message: "old" });
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt", "check"]);
      expect(attempts).toEqual([{ key: "alpha", url: "https://alpha.example.com/a/1" }]);
      expect(r).toEqual({ site: "alpha", ran: true, outcome: { status: "ok" }, status: "active" });
    });

    it("still blocked after the attempt → the second result with the captcha action (degraded, no cool-down)", async () => {
      checks = [{ ...BLOCKED }, { ...BLOCKED, message: "captcha again" }];
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt", "check"]);
      expect(attempts).toEqual([{ key: "alpha", url: null }]);
      expect(r.outcome).toEqual({ status: "access_denied", message: "captcha again", action: ACTION });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: "captcha again" });
      expect(scheduler.cooldownUntil("alpha")).toBeNull();
    });

    it("names the solver's message in the failure the site card shows (e.g. no vision model in Aside)", async () => {
      solverMessage = "text captcha: no vision model is configured in Aside";
      checks = [{ ...BLOCKED }, { ...BLOCKED }];
      const r = await withChallenges().runNow("alpha");
      const message = "captcha page (captcha attempt: text captcha: no vision model is configured in Aside)";
      expect(r.outcome).toEqual({ status: "access_denied", message, action: ACTION });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: message });

      ran = false;
      solverMessage = "captcha solving is not available in this Aside version";
      checks = [{ ...BLOCKED }];
      const r2 = await withChallenges().runNow("alpha");
      expect(r2.outcome?.message).toBe(
        "captcha page (captcha attempt: captcha solving is not available in this Aside version)",
      );
    });

    it("an attempt that could not run (no capability) keeps the first result, with the captcha action", async () => {
      ran = false;
      checks = [{ ...BLOCKED }];
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt"]);
      expect(r.outcome).toEqual({ status: "access_denied", message: "captcha page", action: ACTION });
    });

    it("scheduled checks never attempt", async () => {
      checks = [{ ...BLOCKED }, { status: "ok" }];
      const pass = await withChallenges().runDue();
      expect(attempts).toEqual([]);
      expect(pass.find((x) => x.site === "alpha")?.outcome).toEqual({
        status: "access_denied",
        message: "captcha page",
      });
    });

    it("the setting off: Check now behaves as before", async () => {
      checks = [{ ...BLOCKED }, { status: "ok" }];
      const r = await withChallenges(false).runNow("alpha");
      expect(order).toEqual(["check"]);
      expect(r.outcome).toEqual({ status: "access_denied", message: "captcha page" });
    });

    it("a failure that is not a block page gets no attempt", async () => {
      checks = [{ status: "auth_required", message: "login wall" }];
      await withChallenges().runNow("alpha");
      expect(order).toEqual(["check"]);
    });
  });
});
