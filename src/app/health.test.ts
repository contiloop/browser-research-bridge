import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  challengeAttempt,
  fakeBrowser,
  makeTempDir,
  silentLogger,
  writeAdapterFolder,
} from "../../test/support/site-fixtures.js";
import type { FakeBrowser } from "../../test/support/site-fixtures.js";
import { createAdapterHelpers } from "../adapter-kit/helpers.js";
import { InMemoryScheduler } from "../adapters/aside/scheduler.js";
import {
  ChallengeCoordinator,
  DEFAULT_CHALLENGE_SETTINGS,
  captchaLimitedAction,
} from "../adapters/mcp/challenge.js";
import { lightCheck } from "../adapters/validation/index.js";
import { SiteValidator } from "../adapters/validation/validator.js";
import { ModuleAdapterLoader } from "../adapters/registry/loader.js";
import { SiteRegistryService } from "../adapters/registry/registry.js";
import { FileCache } from "../adapters/storage/cache-store.js";
import { FileSiteStateStore } from "../adapters/storage/site-state-store.js";
import type { Outcome } from "../core/models.js";
import { OutcomeError } from "../core/outcome.js";
import { FakeSiteAssistant } from "../../test/support/fake-site-assistant.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import {
  ASSISTANT_WORKING_ACTIONS,
  AssistantTaskCoordinator,
  DEFAULT_ASSISTANT_TASK_SETTINGS,
} from "../adapters/mcp/assistant-tasks.js";
import { HealthChecker } from "./health.js";
import type { HealthAssistant, HealthChallenges, HealthCheckOutcome } from "./health.js";

describe("HealthChecker", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let sitesDir: string;
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
    sitesDir = join(tmp.dir, "sites");
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
    const LIMITED = captchaLimitedAction("alpha", "https://alpha.example.com/");
    let attempts: { key: string; url: string | null }[];
    let checks: HealthCheckOutcome[];
    let ran: boolean;
    let limited: boolean;
    let result: string | undefined;
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
              limited,
              result: result ?? "unsolved",
              url: url ?? "https://alpha.example.com/",
              action: limited ? LIMITED : ACTION,
              ...(solverMessage !== undefined ? { message: solverMessage } : {}),
            };
          },
        },
      });

    beforeEach(() => {
      attempts = [];
      checks = [];
      ran = true;
      limited = false;
      result = undefined;
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
      result = "unsolved";
      solverMessage = "the captcha attempt ran out of time";
      checks = [{ ...BLOCKED }];
      const r2 = await withChallenges().runNow("alpha");
      expect(r2.outcome?.message).toBe("captcha page (captcha attempt: the captcha attempt ran out of time)");
    });

    it("an attempt that could not run (refused, browser unavailable) keeps the first result, with the captcha action", async () => {
      ran = false;
      checks = [{ ...BLOCKED }];
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt"]);
      expect(r.outcome).toEqual({ status: "access_denied", message: "captcha page", action: ACTION });
    });

    it("captcha-limited (nothing to act on, or no capability): the second check is skipped; the first result stands with the captcha-limited message", async () => {
      ran = false;
      limited = true;
      solverMessage = "the page shows a challenge the solver cannot handle (datadome-challenge)";
      checks = [{ ...BLOCKED }, { status: "ok" }];
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt"]);
      expect(r.outcome).toEqual({ status: "access_denied", message: LIMITED, action: LIMITED });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: LIMITED });
      expect(scheduler.cooldownUntil("alpha")).toBeNull();

      // The same for an unavailable solver.
      order = [];
      result = "unavailable";
      solverMessage = "captcha solving is not available in this Aside version";
      checks = [{ ...BLOCKED, message: "first" }, { status: "ok" }];
      const r2 = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt"]);
      expect(r2.outcome).toEqual({ status: "access_denied", message: LIMITED, action: LIMITED });
    });

    it("a limited report never re-checks, even if it also says ran", async () => {
      ran = true;
      limited = true;
      checks = [{ ...BLOCKED }, { status: "ok" }];
      const r = await withChallenges().runNow("alpha");
      expect(order).toEqual(["check", "attempt"]);
      expect(r.outcome).toEqual({ status: "access_denied", message: LIMITED, action: LIMITED });
    });

    it("with the real coordinator: light check → quick attempt → light check again only when the attempt acted or found none", async () => {
      const run = async (attempt: ReturnType<typeof challengeAttempt>) => {
        const browser = fakeBrowser({ solveChallenge: async () => attempt });
        const coordinator = new ChallengeCoordinator({
          settings: DEFAULT_CHALLENGE_SETTINGS,
          browser,
          scheduler,
          registry,
          logger: silentLogger,
        });
        order = [];
        checks = [{ ...BLOCKED }, { status: "ok" }];
        const h = new HealthChecker({
          registry,
          scheduler,
          intervalMs: 86_400_000,
          clock: { now: () => new Date(nowMs) },
          logger: silentLogger,
          check: async () => {
            order.push("check");
            return checks.shift() ?? { status: "ok" };
          },
          challenges: coordinator,
        });
        const r = await h.runNow("alpha");
        await coordinator.settled();
        return { r, browser };
      };
      // Captcha-limited: no second check; the first result stands with the sentence.
      const limitedRun = await run(challengeAttempt({ solved: false, kind: "unknown", rounds: 0 }));
      expect(order).toEqual(["check"]);
      expect(limitedRun.browser.challenges).toHaveLength(1);
      expect(limitedRun.browser.challenges[0]?.detectBudgetMs).toBe(
        DEFAULT_CHALLENGE_SETTINGS.detectBudgetMs,
      );
      expect(limitedRun.r.outcome).toEqual({ status: "access_denied", message: LIMITED, action: LIMITED });
      // The reload alone cleared it (none), or the solver acted: the light check runs again.
      for (const attempt of [
        challengeAttempt({ solved: false, kind: "none", rounds: 0 }),
        challengeAttempt(),
        challengeAttempt({ solved: false, kind: "unknown", rounds: 1 }),
      ]) {
        const again = await run(attempt);
        expect(order).toEqual(["check", "check"]);
        expect(again.r).toMatchObject({ outcome: { status: "ok" }, status: "active" });
      }
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

    it("a check that throws a blocked failure counts as a block page with no known URL", async () => {
      const h = new HealthChecker({
        registry,
        scheduler,
        intervalMs: 86_400_000,
        logger: silentLogger,
        check: async () => {
          throw new OutcomeError("access_denied", "bot check", undefined, { blocked: true });
        },
        challenges: {
          enabled: true,
          attempt: async (key, url) => {
            attempts.push({ key, url });
            return { ran: false, action: ACTION };
          },
        },
      });
      const r = await h.runNow("alpha");
      expect(attempts).toEqual([{ key: "alpha", url: null }]);
      expect(r.outcome).toEqual({ status: "access_denied", message: "bot check", action: ACTION });
    });
  });

  describe("a bot check met by a page script (light check through the validator)", () => {
    const BOT = "alpha answered with a bot check (geo.captcha-delivery.com)";
    const SEARCH_PAGE = "https://alpha.example.com/search?q=sample";
    const ACTION = `The captcha could not be solved automatically. Open ${SEARCH_PAGE} in Aside, solve it, then retry`;
    let browser: FakeBrowser;
    let attempts: { key: string; url: string | null }[];

    /** alpha's search runs a page script and lets the port's failure through, as a real adapter does. */
    const scriptingAdapter = `export default {
  async search(_req: unknown, ctx: { browser: { runScript(s: string): Promise<unknown> } }) {
    await ctx.browser.runScript("return 1;");
    return { results: [{ title: "Story 1", url: "https://alpha.example.com/s/1", publishedAt: null, datePrecision: null, excerpt: null, author: null }], nextCursor: null, status: "ok" };
  },
  async read(ref: { url?: string }) {
    return { status: "ok", document: { title: "Story", url: ref.url ?? "", publishedAt: null, datePrecision: null, author: null, text: "A full paragraph of article text. ".repeat(20), accessLevel: "public", metadata: {} } };
  },
  async smokeTest() { return { status: "ok" }; },
};
`;

    /** "Check now" attempts: recorded; `clears` makes the attempt remove the bot check. */
    const attempting = (clears: boolean): HealthChallenges => ({
      enabled: true,
      attempt: async (key, url) => {
        attempts.push({ key, url });
        if (clears) browser.scriptErrors.delete("alpha");
        return { ran: true, result: clears ? "solved" : "unsolved", action: ACTION };
      },
    });

    const botChecker = (challenges: HealthChallenges) =>
      new HealthChecker({
        registry,
        scheduler,
        intervalMs: 86_400_000,
        clock: { now: () => new Date(nowMs) },
        logger: silentLogger,
        check: lightCheck(
          new SiteValidator({
            sitesDir,
            repoRoot: process.cwd(),
            loader: new ModuleAdapterLoader({ repoRoot: process.cwd(), preferCompiled: false }),
            runtime: { browser, scheduler, helpers: createAdapterHelpers(), logger: silentLogger },
            logger: silentLogger,
          }),
        ),
        challenges,
      });

    beforeEach(async () => {
      await writeFile(join(sitesDir, "alpha", "adapter.ts"), scriptingAdapter);
      browser = fakeBrowser();
      browser.scriptErrors.set("alpha", new OutcomeError("access_denied", BOT, undefined, { blocked: true }));
      browser.lastUrls.set("alpha", SEARCH_PAGE);
      attempts = [];
    });

    it("Check now: the bot check gets one attempt on the page last shown, then the check once more", async () => {
      const r = await botChecker(attempting(true)).runNow("alpha");
      expect(attempts).toEqual([{ key: "alpha", url: SEARCH_PAGE }]);
      expect(r).toEqual({ site: "alpha", ran: true, outcome: { status: "ok" }, status: "active" });
    });

    it("Check now still blocked: the bot-check failure with the captcha action; no cool-down", async () => {
      const r = await botChecker(attempting(false)).runNow("alpha");
      expect(attempts).toEqual([{ key: "alpha", url: SEARCH_PAGE }]);
      expect(r.outcome).toEqual({ status: "access_denied", message: `search: ${BOT}`, action: ACTION });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: `search: ${BOT}` });
      expect(scheduler.cooldownUntil("alpha")).toBeNull();
    });

    it("scheduled check: reports the bot-check message like any blocked page, with no attempt", async () => {
      const pass = await botChecker(attempting(true)).runDue();
      expect(attempts).toEqual([]);
      expect(pass.find((x) => x.site === "alpha")?.outcome).toEqual({
        status: "access_denied",
        message: `search: ${BOT}`,
      });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: `search: ${BOT}` });
    });
  });

  describe("the Aside AI: login tasks and the login confirmation", () => {
    const LOGIN = ASSISTANT_WORKING_ACTIONS.login;
    let assistantCalls: string[];
    let loginAnswer: string | null;

    const stubAssistant = (): HealthAssistant => ({
      clearHold: (key) => assistantCalls.push(`clear ${key}`),
      login: async (key, request) => {
        assistantCalls.push(`login ${key} ${request.trigger} ${String(request.url)}`);
        return loginAnswer;
      },
    });

    const withAssistant = (assistant: HealthAssistant, challenges?: HealthChallenges) =>
      new HealthChecker({
        registry,
        scheduler,
        intervalMs: 86_400_000,
        clock: { now: () => new Date(nowMs) },
        logger: silentLogger,
        check: async (key, opts) => {
          calls.push({ key, ignoreCooldown: opts.ignoreCooldown });
          const o = outcomes.get(key) ?? { status: "ok" };
          if (o instanceof Error) throw o;
          return o;
        },
        assistant,
        ...(challenges ? { challenges } : {}),
      });

    beforeEach(() => {
      assistantCalls = [];
      loginAnswer = LOGIN;
    });

    it("a scheduled check that finds auth_required starts a login task and leaves the re-check to it", async () => {
      outcomes.set("alpha", { status: "auth_required", message: "login wall" });
      const pass = await withAssistant(stubAssistant()).runDue();
      expect(assistantCalls).toEqual(["login alpha health check null"]);
      expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });
      expect(pass.find((r) => r.site === "alpha")?.outcome).toEqual({
        status: "auth_required",
        message: "login wall",
        action: LOGIN,
      });
      expect(calls.map((c) => c.key)).toEqual(["alpha", "beta"]);
    });

    it("Check now clears the pause and hold first, then starts a login task on auth_required", async () => {
      outcomes.set("alpha", { status: "auth_required", message: "login wall" });
      const r = await withAssistant(stubAssistant()).runNow("alpha");
      expect(assistantCalls).toEqual(["clear alpha", "login alpha check now null"]);
      expect(r.outcome).toEqual({ status: "auth_required", message: "login wall", action: LOGIN });
      // A passing check or another failure starts nothing.
      assistantCalls = [];
      outcomes.set("alpha", { status: "ok" });
      expect((await withAssistant(stubAssistant()).runNow("alpha")).status).toBe("active");
      expect(assistantCalls).toEqual(["clear alpha"]);
      // No task (setting off, paused, unavailable): today's action stands.
      loginAnswer = null;
      outcomes.set("alpha", { status: "auth_required", message: "login wall", action: "today" });
      expect((await withAssistant(stubAssistant()).runNow("alpha")).outcome?.action).toBe("today");
    });

    it("Check now on a busy site still clears the hold (the user says they logged in)", async () => {
      let release!: () => void;
      const busy = scheduler.runForSite(
        { site: "alpha", holder: "assistant", acquireTimeoutMs: 1000, minIntervalMs: 0 },
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await Promise.resolve();
      const r = await withAssistant(stubAssistant()).runNow("alpha");
      expect(r).toMatchObject({ ran: false, skipped: "site busy: assistant" });
      expect(assistantCalls).toEqual(["clear alpha"]);
      release();
      await busy;
    });

    describe("confirmLogin", () => {
      beforeEach(async () => {
        outcomes.set("alpha", { status: "auth_required", message: "login wall" });
        await checker().runNow("alpha");
        calls = [];
      });

      it("a pass returns the site to active (cache cleared, login confirmed) and starts nothing", async () => {
        await cache.set("read", "alpha:1", "doc", { ttlMs: 60_000, sites: ["alpha"] });
        outcomes.set("alpha", { status: "ok" });
        const h = withAssistant(stubAssistant());
        const r = await h.confirmLogin("alpha");
        expect(r).toEqual({ site: "alpha", ran: true, outcome: { status: "ok" }, status: "active" });
        expect(registry.get("alpha")?.lastLoginConfirmedAt).toBe(new Date(nowMs).toISOString());
        expect(await cache.get("read", "alpha:1")).toBeUndefined();
        expect(calls).toEqual([{ key: "alpha", ignoreCooldown: false }]);
        expect(assistantCalls).toEqual([]);
      });

      it("auth_required keeps needs_login and starts no task; a blocked page gets no captcha attempt", async () => {
        const attempts: string[] = [];
        const challenges: HealthChallenges = {
          enabled: true,
          attempt: async (key) => {
            attempts.push(key);
            return { ran: true, action: "x" };
          },
        };
        const h = withAssistant(stubAssistant(), challenges);
        const r = await h.confirmLogin("alpha");
        expect(r).toMatchObject({ ran: true, outcome: { status: "auth_required" }, status: "needs_login" });
        outcomes.set("alpha", {
          status: "access_denied",
          message: "captcha",
          blocked: { url: null },
        } as HealthCheckOutcome);
        const blocked = await h.confirmLogin("alpha");
        expect(blocked.outcome).toEqual({ status: "access_denied", message: "captcha" });
        expect(attempts).toEqual([]);
        expect(assistantCalls).toEqual([]);
      });

      it("runs while other tasks hold the site (no idle precondition)", async () => {
        let release!: () => void;
        const busy = scheduler.runForSite(
          { site: "alpha", holder: "search", acquireTimeoutMs: 1000, minIntervalMs: 0 },
          () => new Promise<void>((resolve) => (release = resolve)),
        );
        await Promise.resolve();
        outcomes.set("alpha", { status: "ok" });
        const r = await withAssistant(stubAssistant()).confirmLogin("alpha");
        expect(r).toMatchObject({ ran: true, status: "active" });
        release();
        await busy;
      });

      it("busy (no place in time), cooling down, or browser unavailable: nothing recorded", async () => {
        const h = withAssistant(stubAssistant());
        outcomes.set("alpha", { status: "timeout", message: "search: site busy: repair running" });
        const busy = await h.confirmLogin("alpha");
        expect(busy).toMatchObject({ ran: false, skipped: "site busy: repair running" });
        expect(busy.outcome).toBeUndefined();
        expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });

        outcomes.set("alpha", { status: "browser_unavailable", message: "Aside is not running" });
        const down = await h.confirmLogin("alpha");
        expect(down.outcome?.status).toBe("browser_unavailable");
        expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });

        scheduler.setCooldown("alpha", nowMs + 60_000);
        expect(await h.confirmLogin("alpha")).toMatchObject({ ran: false, skipped: "site is cooling down" });
        scheduler.clearCooldown("alpha");

        expect(await h.confirmLogin("nope")).toMatchObject({ ran: false, skipped: "site not registered" });
      });

      it("a confirmation stopped at core stop (its signal) records nothing", async () => {
        const controller = new AbortController();
        const h = new HealthChecker({
          registry,
          scheduler,
          intervalMs: 86_400_000,
          logger: silentLogger,
          check: async (_key, opts) => {
            expect(opts.signal).toBe(controller.signal);
            controller.abort();
            return { status: "timeout", message: "the check was stopped" };
          },
        });
        expect(await h.confirmLogin("alpha", controller.signal)).toMatchObject({
          ran: false,
          skipped: "stopped",
        });
        expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });
      });
    });

    it("end to end with the coordinator: a login task's done is confirmed by the light check (active), or counted", async () => {
      const fake = new FakeSiteAssistant().hold();
      const logger = new MemoryLogger();
      const late: { health: HealthChecker | null } = { health: null };
      const tasks = new AssistantTaskCoordinator({
        settings: { ...DEFAULT_ASSISTANT_TASK_SETTINGS },
        assistant: fake,
        scheduler,
        registry,
        logger,
        clock: { now: () => new Date(nowMs) },
        confirmLogin: (key) => late.health!.confirmLogin(key),
      });
      await tasks.probe();
      const health = withAssistant(tasks);
      late.health = health;
      outcomes.set("alpha", { status: "auth_required", message: "login wall" });
      const first = await health.runDue();
      expect(first.find((r) => r.site === "alpha")?.outcome?.action).toBe(LOGIN);
      // The user's password was saved: the AI logs in, and the light check confirms it.
      outcomes.set("alpha", { status: "ok" });
      await new Promise((r) => setTimeout(r, 20));
      fake.release();
      await tasks.settled();
      expect(fake.tasks.map((t) => [t.site, t.purpose])).toEqual([["alpha", "login"]]);
      expect(registry.get("alpha")?.status).toBe("active");

      // Still auth_required after two done tasks: both counted, the site pauses (no third task).
      outcomes.set("alpha", { status: "auth_required", message: "login wall" });
      await registry.recordHealthCheck("alpha", { status: "auth_required", message: "login wall" });
      fake.unhold();
      for (let i = 0; i < 2; i++) {
        await tasks.login("alpha", { url: null, trigger: "fetch" });
        await tasks.settled();
      }
      expect(registry.get("alpha")?.status).toBe("needs_login");
      expect(await tasks.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      expect(fake.tasks).toHaveLength(3);
      // Check now clears the pause: a new task starts.
      await health.runNow("alpha");
      await tasks.settled();
      expect(fake.tasks).toHaveLength(4);
      await tasks.dispose();
    });
  });
});
