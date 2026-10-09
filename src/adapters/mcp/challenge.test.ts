/**
 * The challenge coordinator with the real scheduler, a fake browser port (scripted solver, no page),
 * and a minimal site lookup. No site behavior is real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  RESTORE_MARGIN_MS,
  canRerun,
  captchaLimitedAction,
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
    scheduler?: InMemoryScheduler;
  } = {},
): Setup {
  const browser = fakeBrowser(
    options.solve === null ? {} : { solveChallenge: options.solve ?? (async () => challengeAttempt()) },
  );
  const scheduler = options.scheduler ?? new InMemoryScheduler();
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

  it("a port without solveChallenge is unavailable (captcha-limited): nothing runs, one metadata-only log line", async () => {
    const s = setup({ solve: null });
    const report = await s.coordinator.attempt("alpha", URL1);
    expect(report).toMatchObject({
      ran: false,
      limited: true,
      result: "unavailable",
      url: URL1,
      message: NO_SOLVER_MESSAGE,
    });
    expect(report.action).toBe(captchaLimitedAction("alpha", URL1));
    expect(s.tasks).toEqual([]);
    const lines = s.logger.lines.filter((l) => l.includes("captcha attempt"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"result":"unavailable"');
    expect(lines[0]).toContain(`"message":"${NO_SOLVER_MESSAGE}"`);
    expect(lines[0]).toContain('"site":"alpha"');
    expect(lines[0]).toContain('"durationMs"');
  });

  it("an older browser (available: false) is unavailable, captcha-limited, and not re-run", async () => {
    const s = setup({
      solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 0, available: false }),
    });
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({
      ran: false,
      limited: true,
      result: "unavailable",
      action: captchaLimitedAction("alpha", URL1),
    });
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
      limited: true,
      message: "captcha solving is not available in this Aside version",
      action: captchaLimitedAction("alpha", URL1),
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
      limited: false,
      result: "unsolved",
      error: "browser_unavailable",
      action: captchaUnsolvedAction(URL1),
    });
    s.scheduler.setCooldown("alpha", Date.now() + 60_000);
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({
      ran: false,
      limited: false,
      error: "rate_limited",
    });
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
    expect(joined).toMatchObject({
      ran: false,
      limited: false,
      result: "unsolved",
      error: "timeout",
      action: captchaUnsolvedAction(URL1),
    });
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

describe("ChallengeCoordinator: the quick attempt (detection budget, captcha-limited)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the detection budget (captchaDetectBudgetMs) to the port, clipped to the port's own budget", async () => {
    const s = setup();
    await s.coordinator.attempt("alpha", URL1, { budgetMs: 45_000 });
    expect(s.browser.challenges[0]?.detectBudgetMs).toBe(DEFAULT_CHALLENGE_SETTINGS.detectBudgetMs);
    expect(DEFAULT_CHALLENGE_SETTINGS.detectBudgetMs).toBe(20_000);
    // A port budget below the detection budget clips it.
    await s.coordinator.attempt("alpha", URL1, { budgetMs: 10_000 });
    const clipped = s.browser.challenges[1]!;
    expect(clipped.budgetMs).toBeLessThanOrEqual(10_000);
    expect(clipped.detectBudgetMs).toBe(clipped.budgetMs);
    // The tunable decides it.
    const tuned = setup({ settings: { detectBudgetMs: 5_000 } });
    await tuned.coordinator.attempt("alpha", URL1, { budgetMs: 45_000 });
    expect(tuned.browser.challenges[0]?.detectBudgetMs).toBe(5_000);
  });

  it("the detection budget starts after the scheduler slot was acquired; only the slot wait shortens the port's budget", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-09T10:00:00Z") });
    const scheduler = new InMemoryScheduler({ maxConcurrentPerSite: 1 });
    const s = setup({ scheduler });
    const solvedAt: number[] = [];
    s.browser.solveChallenge = async (o) => {
      s.browser.challenges.push(o);
      solvedAt.push(Date.now());
      return challengeAttempt({ solved: false, kind: "unknown", rounds: 0 });
    };
    // Another task of the site holds the only slot for 12 s.
    const hold = scheduler.runForSite(
      { site: "alpha", holder: "fetch", acquireTimeoutMs: 1000, minIntervalMs: 0 },
      () => new Promise<void>((r) => setTimeout(r, 12_000)),
    );
    const startedAt = Date.now();
    const pending = s.coordinator.attempt("alpha", URL1, { budgetMs: 45_000 });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(s.browser.challenges).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await hold;
    const report = await pending;
    expect(solvedAt[0]! - startedAt).toBe(12_000);
    const call = s.browser.challenges[0]!;
    // The detection budget is whole: it starts when the port's attempt starts.
    expect(call.detectBudgetMs).toBe(20_000);
    // The port's own budget is what the slot wait left (less the restore margin).
    expect(call.budgetMs).toBe(45_000 - 12_000 - RESTORE_MARGIN_MS);
    expect(report).toMatchObject({ ran: false, limited: true });

    // A short attempt budget after the same wait: the detection budget is clipped to the port's.
    const hold2 = scheduler.runForSite(
      { site: "alpha", holder: "fetch", acquireTimeoutMs: 1000, minIntervalMs: 0 },
      () => new Promise<void>((r) => setTimeout(r, 12_000)),
    );
    const pending2 = s.coordinator.attempt("alpha", URL1, { budgetMs: 25_000 });
    await vi.advanceTimersByTimeAsync(12_000);
    await hold2;
    await pending2;
    const call2 = s.browser.challenges[1]!;
    expect(call2.budgetMs).toBe(25_000 - 12_000 - RESTORE_MARGIN_MS);
    expect(call2.detectBudgetMs).toBe(call2.budgetMs);
  });

  it("kind unknown with rounds 0 is captcha-limited: no re-run, the captcha-limited action", async () => {
    const why = "the page shows a challenge the solver cannot handle (datadome-challenge)";
    const s = setup({
      solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 0, message: why }),
    });
    const report = await s.coordinator.attempt("alpha", URL1);
    expect(report).toEqual({
      ran: false,
      limited: true,
      result: "unsolved",
      kind: "unknown",
      rounds: 0,
      url: URL1,
      message: why,
      action: captchaLimitedAction("alpha", URL1),
    });
    expect(report.action).toBe(
      `alpha is captcha-limited: its bot check cannot be solved automatically. Open ${URL1} in Aside, solve it, then retry`,
    );
    // Detection that did not finish in time is the same verdict.
    const late = setup({
      solve: async () =>
        challengeAttempt({
          solved: false,
          kind: "unknown",
          rounds: 0,
          message: "detection did not finish in time",
        }),
    });
    expect(await late.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: false, limited: true });
  });

  it("an attempt that acted and then found something it cannot handle is not limited: re-run", async () => {
    const s = setup({
      solve: async () =>
        challengeAttempt({ solved: false, kind: "unknown", rounds: 1, message: "image grid" }),
    });
    expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({
      ran: true,
      limited: false,
      kind: "unknown",
      rounds: 1,
      action: captchaUnsolvedAction(URL1, "image grid"),
    });
  });

  it("kind none and solvable kinds re-run, even without an action (e.g. a text captcha and no vision model)", async () => {
    for (const attempt of [
      challengeAttempt({ solved: false, kind: "none", rounds: 0 }),
      challengeAttempt({ solved: false, kind: "text", rounds: 0, message: "no vision model" }),
      challengeAttempt({ solved: false, kind: "slider", rounds: 2 }),
      challengeAttempt(),
    ]) {
      const s = setup({ solve: async () => attempt });
      expect(await s.coordinator.attempt("alpha", URL1)).toMatchObject({ ran: true, limited: false });
    }
  });

  it("a caller that joins a captcha-limited attempt gets the captcha-limited action for its own page", async () => {
    const gate = deferred<ChallengeAttempt>();
    const s = setup({ solve: () => gate.promise });
    const first = s.coordinator.attempt("alpha", URL1, { budgetMs: 30_000 });
    const other = "https://alpha.example.com/articles/6";
    const joined = s.coordinator.join("alpha", other, { budgetMs: 30_000 });
    gate.resolve(challengeAttempt({ solved: false, kind: "unknown", rounds: 0 }));
    expect(await first).toMatchObject({ limited: true, action: captchaLimitedAction("alpha", URL1) });
    expect(await joined).toMatchObject({
      ran: false,
      limited: true,
      url: other,
      action: captchaLimitedAction("alpha", other),
    });
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

describe("ChallengeCoordinator.whenSettled", () => {
  it("null at once when no attempt runs for the site (setting off included)", async () => {
    const s = setup();
    expect(await s.coordinator.whenSettled("alpha")).toBeNull();
    const off = setup({ settings: { auto: false } });
    expect(await off.coordinator.whenSettled("alpha")).toBeNull();
  });

  it("the report of the attempt in flight, once the port's work has ended", async () => {
    const gate = deferred<ChallengeAttempt>();
    const s = setup({ solve: () => gate.promise });
    expect(s.coordinator.background("alpha", URL1)).toBe(true);
    let settled: unknown = "pending";
    const waiting = s.coordinator.whenSettled("alpha").then((r) => (settled = r));
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe("pending");
    gate.resolve(challengeAttempt({ solved: false, kind: "unknown", rounds: 0 }));
    await waiting;
    expect(settled).toMatchObject({ ran: false, limited: true, kind: "unknown" });
    expect(s.coordinator.inFlight("alpha")).toBe(false);
  });

  it("an attempt that acted reports ran; one abandoned at core stop reports that it did not act", async () => {
    const s = setup();
    s.coordinator.background("alpha", URL1);
    expect(await s.coordinator.whenSettled("alpha")).toMatchObject({ ran: true, limited: false });
    s.coordinator.dispose();

    const stopped = setup({ solve: untilAborted });
    stopped.coordinator.background("alpha", URL1);
    await new Promise((r) => setTimeout(r, 5));
    const pending = stopped.coordinator.whenSettled("alpha");
    stopped.coordinator.dispose();
    expect(await pending).toMatchObject({ limited: false });
  });
});

describe("budget arithmetic", () => {
  const s = DEFAULT_CHALLENGE_SETTINGS;

  it("attempts inline only with at least detection budget + re-run reserve left, within min(budget, remaining − reserve)", () => {
    expect(s.detectBudgetMs + s.rerunReserveMs).toBe(35_000);
    expect(planChallenge(s, 90_000)).toEqual({ mode: "inline", budgetMs: 45_000 });
    expect(planChallenge(s, 50_000)).toEqual({ mode: "inline", budgetMs: 35_000 });
    expect(planChallenge(s, 35_000)).toEqual({ mode: "inline", budgetMs: 20_000 });
    expect(planChallenge(s, 34_999)).toEqual({ mode: "background" });
    // The detection budget is tunable and moves the threshold with it.
    expect(planChallenge({ ...s, detectBudgetMs: 5_000 }, 20_000)).toEqual({
      mode: "inline",
      budgetMs: 5_000,
    });
    expect(planChallenge({ ...s, detectBudgetMs: 5_000 }, 19_999)).toEqual({ mode: "background" });
    // A short attempt budget caps the inline attempt (the port clips the detection budget to it).
    expect(planChallenge({ ...s, attemptBudgetMs: 10_000 }, 90_000)).toEqual({
      mode: "inline",
      budgetMs: 10_000,
    });
    // A configuration that leaves nothing for the attempt runs it in the background.
    expect(planChallenge({ ...s, detectBudgetMs: 0 }, 15_000)).toEqual({ mode: "background" });
  });

  it("re-runs only when the reserve is still there", () => {
    expect(canRerun(s, 15_000)).toBe(true);
    expect(canRerun(s, 14_999)).toBe(false);
  });

  it("the action names the page to open in Aside", () => {
    expect(captchaUnsolvedAction("https://alpha.example.com/")).toBe(
      "The captcha could not be solved automatically. Open https://alpha.example.com/ in Aside, solve it, then retry",
    );
    expect(captchaLimitedAction("alpha", "https://alpha.example.com/a/1")).toBe(
      "alpha is captcha-limited: its bot check cannot be solved automatically. Open https://alpha.example.com/a/1 in Aside, solve it, then retry",
    );
  });

  it("the old inline minimum is retired from the settings", () => {
    expect(Object.keys(DEFAULT_CHALLENGE_SETTINGS).sort()).toEqual([
      "attemptBudgetMs",
      "auto",
      "detectBudgetMs",
      "rerunReserveMs",
    ]);
  });
});
