/**
 * The challenge coordinator with the real scheduler, a fake browser port (scripted solver, no page),
 * and a minimal site lookup. No site behavior is real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLogger } from "../../../test/support/oauth-harness.js";
import { challengeAttempt, fakeBrowser, manifestFor } from "../../../test/support/site-fixtures.js";
import type { FakeBrowser, FakeSolver } from "../../../test/support/site-fixtures.js";
import { OutcomeError } from "../../core/outcome.js";
import type { ChallengeAttempt } from "../../ports/browser.js";
import { parseSiteManifest } from "../../ports/manifest.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { SiteTaskOptions } from "../../ports/scheduler.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import {
  CAPTCHA_HOLDER,
  ChallengeCoordinator,
  DEFAULT_CHALLENGE_SETTINGS,
  NO_SOLVER_MESSAGE,
  canRerun,
  captchaUnsolvedAction,
  planChallenge,
} from "./challenge.js";
import type { ChallengeSettings } from "./challenge.js";

function manifest(key: string, patch: Record<string, unknown> = {}): SiteManifest {
  const parsed = parseSiteManifest(manifestFor(key, patch));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.manifest;
}

function sites(manifests: SiteManifest[]) {
  const byKey = new Map(manifests.map((m) => [m.key, m]));
  return {
    get: (key: string) => {
      const m = byKey.get(key);
      return m === undefined ? undefined : { hostnames: m.hostnames };
    },
    load: async (key: string) => {
      const m = byKey.get(key);
      return m === undefined ? undefined : { manifest: m };
    },
    remove: (key: string) => byKey.delete(key),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A solver that waits until the attempt's scope signal aborts, then reports an unsolved attempt. */
const untilAborted: FakeSolver = (options) =>
  new Promise<ChallengeAttempt>((resolve) => {
    const signal = options.scope.signal;
    const done = () => resolve(challengeAttempt({ solved: false, rounds: 0, message: "aborted" }));
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });

interface Setup {
  coordinator: ChallengeCoordinator;
  browser: FakeBrowser;
  scheduler: InMemoryScheduler;
  logger: MemoryLogger;
  registry: ReturnType<typeof sites>;
  tasks: SiteTaskOptions[];
}

let current: ChallengeCoordinator | null = null;
afterEach(async () => {
  current?.dispose();
  await current?.settled();
  current = null;
});

function setup(
  options: {
    solve?: FakeSolver | null;
    settings?: Partial<ChallengeSettings>;
    manifests?: SiteManifest[];
    removalPollMs?: number;
  } = {},
): Setup {
  const browser = fakeBrowser(
    options.solve === null ? {} : { solveChallenge: options.solve ?? (async () => challengeAttempt()) },
  );
  const scheduler = new InMemoryScheduler();
  const tasks: SiteTaskOptions[] = [];
  const run = scheduler.runForSite.bind(scheduler);
  scheduler.runForSite = (taskOptions, task) => {
    tasks.push(taskOptions);
    return run(taskOptions, task);
  };
  const logger = new MemoryLogger();
  const registry = sites(
    options.manifests ?? [manifest("alpha", { extraAllowedHosts: ["sso.example.net"], minIntervalMs: 2500 })],
  );
  const coordinator = new ChallengeCoordinator({
    settings: { ...DEFAULT_CHALLENGE_SETTINGS, ...options.settings },
    browser,
    scheduler,
    registry,
    logger,
    ...(options.removalPollMs !== undefined ? { removalPollMs: options.removalPollMs } : {}),
  });
  current = coordinator;
  return { coordinator, browser, scheduler, logger, registry, tasks };
}

const URL1 = "https://alpha.example.com/articles/5?x=1";

describe("ChallengeCoordinator.attempt", () => {
  it("runs one attempt as a shared pool task named captcha, scoped to hostnames ∪ extraAllowedHosts", async () => {
    const s = setup();
    const report = await s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    expect(report).toMatchObject({
      ran: true,
      result: "solved",
      kind: "checkbox",
      rounds: 1,
      url: URL1,
      action: captchaUnsolvedAction(URL1),
    });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ site: "alpha", holder: CAPTCHA_HOLDER, minIntervalMs: 2500 });
    expect(s.tasks[0]?.exclusive).not.toBe(true);
    expect(s.tasks[0]?.budgetMs).toBeLessThanOrEqual(30_000);
    const call = s.browser.challenges[0];
    expect(call?.url).toBe(URL1);
    expect(call?.scope.siteKey).toBe("alpha");
    expect(call?.scope.hostnames).toEqual(["alpha.example.com", "sso.example.net"]);
    expect(call?.scope.lease).toBeDefined();
    expect(call?.budgetMs).toBeGreaterThan(0);
    expect(call?.budgetMs).toBeLessThanOrEqual(30_000);
  });

  it("a failure without a page URL (a search) targets the site's homepage", async () => {
    const s = setup();
    expect(s.coordinator.challengeUrl("alpha", null)).toBe("https://alpha.example.com/");
    const report = await s.coordinator.attempt("alpha", null);
    expect(report.url).toBe("https://alpha.example.com/");
    expect(s.browser.challenges[0]?.url).toBe("https://alpha.example.com/");
    // Without a budget the attempt gets the configured attempt budget.
    expect(s.tasks[0]?.budgetMs).toBe(DEFAULT_CHALLENGE_SETTINGS.attemptBudgetMs);
  });

  it("the solver's word is not success: kind none and unsolved attempts still count as ran (re-run)", async () => {
    const s = setup({ solve: async () => challengeAttempt({ solved: false, kind: "none", rounds: 0 }) });
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({
      ran: true,
      result: "unsolved",
      kind: "none",
      rounds: 0,
    });
  });

  it("a port without solveChallenge is unavailable: nothing runs, one metadata-only log line", async () => {
    const s = setup({ solve: null });
    const report = await s.coordinator.attempt("alpha", URL1);
    expect(report).toMatchObject({ ran: false, result: "unavailable", url: URL1 });
    expect(report.action).toBe(captchaUnsolvedAction(URL1, NO_SOLVER_MESSAGE));
    expect(s.tasks).toEqual([]);
    const lines = s.logger.lines.filter((l) => l.includes("captcha attempt"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"result":"unavailable"');
    expect(lines[0]).toContain(`"message":"${NO_SOLVER_MESSAGE}"`);
    expect(lines[0]).toContain('"site":"alpha"');
    expect(lines[0]).toContain('"durationMs"');
  });

  it("an older browser (available: false) is unavailable and not re-run", async () => {
    const s = setup({
      solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 0, available: false }),
    });
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: false, result: "unavailable" });
  });

  it("carries the solver's fixed message and names it in the action unless the solver said solved", async () => {
    const why = "text captcha: no vision model is configured in Aside";
    const s = setup({
      solve: async () => challengeAttempt({ solved: false, kind: "text", rounds: 0, message: why }),
    });
    const report = await s.coordinator.attempt("alpha", URL1);
    expect(report).toMatchObject({ ran: true, result: "unsolved", kind: "text", message: why });
    expect(report.action).toBe(captchaUnsolvedAction(URL1, why));
    expect(report.action).toBe(
      `The captcha could not be solved automatically (${why}). Open ${URL1} in Aside, solve it, then retry`,
    );
    const unavailable = setup({
      solve: async () =>
        challengeAttempt({
          solved: false,
          kind: "unknown",
          rounds: 0,
          available: false,
          message: "captcha solving is not available in this Aside version",
        }),
    });
    expect(await unavailable.coordinator.attempt("alpha", URL1)).toMatchObject({
      result: "unavailable",
      message: "captcha solving is not available in this Aside version",
      action: captchaUnsolvedAction(URL1, "captcha solving is not available in this Aside version"),
    });
    // A reported `solved` that the re-run did not confirm: the plain action (only the re-run judges).
    const solved = setup({
      solve: async () => challengeAttempt({ message: "the checkbox captcha was answered" }),
    });
    expect((await solved.coordinator.attempt("alpha", URL1)).action).toBe(captchaUnsolvedAction(URL1));
  });

  it("join: joins the attempt in flight, or returns null and starts none", async () => {
    const gate = deferred<ChallengeAttempt>();
    const s = setup({ solve: () => gate.promise });
    expect(s.coordinator.join("alpha", URL1)).toBeNull();
    expect(s.tasks).toEqual([]);
    const first = s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    const other = "https://alpha.example.com/articles/6";
    const joined = s.coordinator.join("alpha", other, { budgetMs: 30_000 });
    expect(joined).not.toBeNull();
    gate.resolve(challengeAttempt());
    expect(await first).toMatchObject({ ran: true, url: URL1 });
    expect(await joined).toMatchObject({ ran: true, url: other, action: captchaUnsolvedAction(other) });
    expect(s.browser.challenges).toHaveLength(1);
    await s.coordinator.settled();
    expect(s.coordinator.join("alpha", URL1)).toBeNull();
    expect(s.browser.challenges).toHaveLength(1);
  });

  it("a thrown port failure or a refused task is reported, never raised", async () => {
    const s = setup({
      solve: async () => {
        throw new OutcomeError("browser_unavailable", "Aside is not running");
      },
    });
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({
      ran: false,
      result: "unsolved",
      error: "browser_unavailable",
    });
    s.scheduler.setCooldown("alpha", Date.now() + 60_000);
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: false, error: "rate_limited" });
    expect(s.browser.challenges).toHaveLength(1);
    const refused = s.logger.lines.filter((l) => l.includes("captcha attempt") && l.includes("rate_limited"));
    expect(refused).toHaveLength(1);
  });

  it("coalesces: a second caller joins the in-flight attempt; attempts never run in parallel on a site", async () => {
    const gate = deferred<ChallengeAttempt>();
    let inFlight = 0;
    let peak = 0;
    const s = setup({
      solve: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const r = await gate.promise;
        inFlight -= 1;
        return r;
      },
    });
    const first = s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    const second = s.coordinator.attempt("alpha", "https://alpha.example.com/articles/6", {
      budgetMs: 30_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.coordinator.inFlight("alpha")).toBe(true);
    gate.resolve(challengeAttempt());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ran: true, result: "solved" });
    expect(b).toMatchObject({ ran: true, result: "solved" });
    expect(s.browser.challenges).toHaveLength(1);
    expect(peak).toBe(1);
    expect(s.coordinator.inFlight("alpha")).toBe(false);
  });

  it("a joining caller waits at most its budget", async () => {
    const gate = deferred<ChallengeAttempt>();
    const s = setup({ solve: () => gate.promise });
    const first = s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    const joined = await s.coordinator.attempt("alpha", URL1, { budgetMs: 40 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(joined).toMatchObject({ ran: false, result: "unsolved", error: "timeout" });
    gate.resolve(challengeAttempt());
    expect((await first).ran).toBe(true);
  });

  it("is off when the setting is off: nothing runs", async () => {
    const s = setup({ settings: { auto: false } });
    expect(s.coordinator.enabled).toBe(false);
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: false });
    expect(s.coordinator.background("alpha", URL1)).toBe(false);
    expect(s.browser.challenges).toEqual([]);
  });
});

describe("ChallengeCoordinator.background", () => {
  it("runs one background attempt per site; an inline caller joins it", async () => {
    const gate = deferred<ChallengeAttempt>();
    const s = setup({ solve: () => gate.promise });
    expect(s.coordinator.background("alpha", URL1)).toBe(true);
    expect(s.coordinator.background("alpha", URL1)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    const joined = s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    gate.resolve(challengeAttempt());
    expect(await joined).toMatchObject({ ran: true, result: "solved" });
    await s.coordinator.settled();
    expect(s.browser.challenges).toHaveLength(1);
    expect(s.tasks[0]?.budgetMs).toBe(DEFAULT_CHALLENGE_SETTINGS.attemptBudgetMs);
    expect(s.coordinator.background("alpha", URL1)).toBe(true);
    await s.coordinator.settled();
    expect(s.browser.challenges).toHaveLength(2);
    expect(s.logger.lines.some((l) => l.includes("captcha attempt started in the background"))).toBe(true);
  });

  it("dispose (core stop) abandons running attempts and refuses new ones", async () => {
    const s = setup({ solve: untilAborted });
    expect(s.coordinator.background("alpha", URL1)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    s.coordinator.dispose();
    await s.coordinator.settled();
    expect(s.browser.challenges[0]?.scope.signal?.aborted).toBe(true);
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: false });
    expect(s.coordinator.background("alpha", URL1)).toBe(false);
    expect(s.browser.challenges).toHaveLength(1);
  });

  it("a background attempt whose site is removed is abandoned", async () => {
    const s = setup({ solve: untilAborted, removalPollMs: 10 });
    expect(s.coordinator.background("alpha", URL1)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    s.registry.remove("alpha");
    await s.coordinator.settled();
    expect(s.browser.challenges[0]?.scope.signal?.aborted).toBe(true);
    expect(s.coordinator.inFlight("alpha")).toBe(false);
  });

  it("never starts for a site that is not registered or not loadable", async () => {
    const s = setup();
    expect(s.coordinator.background("nope", null)).toBe(false);
    expect(await s.coordinator.attempt("nope", null)).toMatchObject({ ran: false });
    expect(s.browser.challenges).toEqual([]);
  });

  it("logs carry metadata only: no URL, no solver message", async () => {
    const s = setup({
      solve: async () => challengeAttempt({ solved: false, kind: "slider", rounds: 2, message: "PAGE TEXT" }),
    });
    s.coordinator.background("alpha", URL1);
    await s.coordinator.settled();
    await s.coordinator.attempt("alpha", URL1);
    expect(s.logger.lines.length).toBeGreaterThan(0);
    for (const line of s.logger.lines) {
      expect(line).not.toContain("https://");
      expect(line).not.toContain("PAGE TEXT");
    }
  });
});

describe("budget arithmetic", () => {
  const s = DEFAULT_CHALLENGE_SETTINGS;

  it("attempts inline only with at least captchaInlineMinRemainingMs left, within min(budget, remaining − reserve)", () => {
    expect(planChallenge(s, 90_000)).toEqual({ mode: "inline", budgetMs: 45_000 });
    expect(planChallenge(s, 50_000)).toEqual({ mode: "inline", budgetMs: 35_000 });
    expect(planChallenge(s, 40_000)).toEqual({ mode: "inline", budgetMs: 25_000 });
    expect(planChallenge(s, 39_999)).toEqual({ mode: "background" });
    // A configuration whose reserve leaves nothing for the attempt runs it in the background.
    expect(planChallenge({ ...s, inlineMinRemainingMs: 10_000 }, 12_000)).toEqual({ mode: "background" });
  });

  it("re-runs only when the reserve is still there", () => {
    expect(canRerun(s, 15_000)).toBe(true);
    expect(canRerun(s, 14_999)).toBe(false);
  });

  it("the action names the page to open in Aside", () => {
    expect(captchaUnsolvedAction("https://alpha.example.com/")).toBe(
      "The captcha could not be solved automatically. Open https://alpha.example.com/ in Aside, solve it, then retry",
    );
  });
});
