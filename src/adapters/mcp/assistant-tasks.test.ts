/**
 * The assistant task coordinator with the real scheduler, a scripted Aside AI (`FakeSiteAssistant`), a
 * minimal site lookup, and a fake clock. Nothing runs the real Aside CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSiteAssistant } from "../../../test/support/fake-site-assistant.js";
import { MemoryLogger } from "../../../test/support/oauth-harness.js";
import type { SiteLifecycleStatus } from "../../core/models.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import {
  ASSISTANT_HOLDER,
  ASSISTANT_WORKING_ACTIONS,
  AssistantTaskCoordinator,
  assistantAction,
} from "./assistant-tasks.js";
import type { AssistantTaskSettings, LoginConfirmation } from "./assistant-tasks.js";

const LOGIN = ASSISTANT_WORKING_ACTIONS.login;
const CAPTCHA = ASSISTANT_WORKING_ACTIONS.captcha;
const WINDOW = 600_000;
const PAUSE = 600_000;

interface SiteRow {
  key: string;
  status: SiteLifecycleStatus;
  loadable: boolean;
  hostnames: string[];
  loginUrl: string | null;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets queued promise callbacks (and the scheduler's grant) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe("AssistantTaskCoordinator", () => {
  let nowMs: number;
  let scheduler: InMemoryScheduler;
  let assistant: FakeSiteAssistant;
  let logger: MemoryLogger;
  let rows: Map<string, SiteRow>;
  let confirmations: string[];
  let confirmResult: LoginConfirmation | (() => Promise<LoginConfirmation>);
  let coordinators: AssistantTaskCoordinator[];

  const row = (key: string, patch: Partial<SiteRow> = {}): SiteRow => ({
    key,
    status: "active",
    loadable: true,
    hostnames: [`${key}.example.com`],
    loginUrl: `https://${key}.example.com/login?next=%2F`,
    ...patch,
  });

  const make = async (
    settings: Partial<AssistantTaskSettings> = {},
    options: { probe?: boolean } = {},
  ): Promise<AssistantTaskCoordinator> => {
    const coordinator = new AssistantTaskCoordinator({
      settings: {
        auto: true,
        account: "u0",
        taskBudgetMs: 120_000,
        failureWindowMs: WINDOW,
        pauseMs: PAUSE,
        ...settings,
      },
      assistant,
      scheduler,
      registry: {
        get: (key) => rows.get(key),
        load: async (key) =>
          rows.has(key)
            ? { manifest: { extraAllowedHosts: ["sso.example.net"], minIntervalMs: 0 } }
            : undefined,
      },
      logger,
      clock: { now: () => new Date(nowMs) },
      confirmLogin: async (key) => {
        confirmations.push(key);
        return typeof confirmResult === "function" ? confirmResult() : confirmResult;
      },
    });
    coordinators.push(coordinator);
    if (options.probe !== false) await coordinator.probe();
    return coordinator;
  };

  beforeEach(() => {
    nowMs = Date.parse("2026-10-09T10:00:00Z");
    scheduler = new InMemoryScheduler({ now: () => nowMs, concurrentStaggerMs: 0 });
    assistant = new FakeSiteAssistant();
    logger = new MemoryLogger();
    rows = new Map([
      ["alpha", row("alpha")],
      ["beta", row("beta")],
    ]);
    confirmations = [];
    confirmResult = { outcome: { status: "ok" } };
    coordinators = [];
  });

  afterEach(async () => {
    for (const c of coordinators) await c.dispose();
  });

  describe("sentences", () => {
    it("names the account in the fixed sentence of each reason", () => {
      expect(assistantAction("verification_code", "u3")).toBe(
        "The site asked for a verification code — log in in the Aside window of account u3, then press Logged in? Check now",
      );
      expect(assistantAction("no_saved_password", "u0")).toBe(
        "No password for this site is saved in Aside — log in in the Aside window of account u0, then press Logged in? Check now",
      );
      expect(assistantAction("question", "u0")).toContain("the Aside window of account u0");
      expect(assistantAction("question", "u0")).toContain("Logged in? Check now");
      for (const reason of ["check_not_passed", "timed_out", "other"] as const) {
        expect(assistantAction(reason, "u0")).toContain("the Aside window of account u0");
        expect(assistantAction(reason, "u0")).toMatch(/Check now$/);
      }
      expect(LOGIN).toBe("The Aside AI is logging in now; retry in a minute");
      expect(CAPTCHA).toBe("The Aside AI is passing the check now; retry in a minute");
    });
  });

  describe("starting a task", () => {
    it("a login trigger starts one background task (a pool task, holder assistant) and answers at once", async () => {
      assistant.hold();
      const c = await make();
      const action = await c.login("alpha", { url: "https://alpha.example.com/a/1", trigger: "fetch" });
      expect(action).toBe(LOGIN);
      await flush();
      expect(assistant.tasks).toHaveLength(1);
      const task = assistant.tasks[0]!;
      expect(task).toMatchObject({
        site: "alpha",
        purpose: "login",
        url: "https://alpha.example.com/a/1",
        hostnames: ["alpha.example.com"],
        extraAllowedHosts: ["sso.example.net"],
        loginUrl: "https://alpha.example.com/login?next=%2F",
        account: "u0",
        budgetMs: 120_000,
      });
      expect(task.signal).toBeInstanceOf(AbortSignal);
      expect(scheduler.holders("alpha")).toEqual([ASSISTANT_HOLDER]);
      // A pool task: other tool calls of the site still get a place.
      const other = await scheduler.runForSite(
        { site: "alpha", holder: "search", acquireTimeoutMs: 50, minIntervalMs: 0 },
        async () => "ran",
      );
      expect(other).toBe("ran");
      expect(c.view("alpha")).toEqual({
        purpose: "login",
        verdict: null,
        reason: null,
        at: new Date(nowMs).toISOString(),
        running: true,
      });
      assistant.release();
      await c.settled();
      expect(c.view("alpha")).toMatchObject({
        purpose: "login",
        verdict: "done",
        reason: null,
        running: false,
      });
      expect(scheduler.holders("alpha")).toEqual([]);
    });

    it("the budget is always assistantTaskBudgetMs; a page off the site falls back to the homepage", async () => {
      const c = await make({ taskBudgetMs: 7_000 });
      await c.captcha("alpha", { url: "https://evil.example.org/x", trigger: "search" });
      await c.settled();
      expect(assistant.tasks[0]).toMatchObject({
        purpose: "captcha",
        url: "https://alpha.example.com/",
        budgetMs: 7_000,
      });
      await c.login("beta", { url: null, trigger: "health check" });
      await c.settled();
      expect(assistant.tasks[1]).toMatchObject({ purpose: "login", url: "https://beta.example.com/" });
      // An SSO host from extraAllowedHosts is on the site's scope.
      await c.login("beta", { url: "https://sso.example.net/auth", trigger: "fetch" });
      await c.settled();
      expect(assistant.tasks[2]?.url).toBe("https://sso.example.net/auth");
    });

    it("one task per site: a second trigger while one runs returns the working sentence; other sites run at once", async () => {
      assistant.hold();
      const c = await make();
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(LOGIN);
      expect(await c.login("alpha", { url: null, trigger: "read" })).toBe(LOGIN);
      // A captcha trigger meanwhile names what the AI is doing on the site.
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(LOGIN);
      expect(c.workingAction("alpha")).toBe(LOGIN);
      expect(await c.captcha("beta", { url: null, trigger: "search" })).toBe(CAPTCHA);
      await flush();
      expect(assistant.tasks.map((t) => [t.site, t.purpose])).toEqual([
        ["alpha", "login"],
        ["beta", "captcha"],
      ]);
      assistant.release();
      assistant.release();
      await c.settled();
      expect(c.workingAction("alpha")).toBeNull();
    });

    it("the setting off, an unavailable assistant, or no probe yet: no task (today's actions)", async () => {
      const off = await make({ auto: false });
      expect(off.enabled).toBe(false);
      expect(await off.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      expect(await off.captcha("alpha", { url: null, trigger: "fetch" })).toBeNull();

      const unprobed = await make({}, { probe: false });
      expect(unprobed.available()).toBeNull();
      expect(await unprobed.login("alpha", { url: null, trigger: "fetch" })).toBeNull();

      assistant.availableValue = false;
      const unavailable = await make();
      expect(unavailable.available()).toBe(false);
      expect(await unavailable.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      expect(assistant.tasks).toEqual([]);
    });

    it("a probe still running at the first trigger is waited for", async () => {
      const c = await make({}, { probe: false });
      void c.probe();
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(LOGIN);
      await c.settled();
      expect(assistant.tasks).toHaveLength(1);
    });

    it("a site cooling down (rate_limited), a site that is not serving, or an unknown site gets no task and nothing is counted", async () => {
      const c = await make();
      scheduler.setCooldown("alpha", nowMs + 60_000);
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      rows.set("beta", row("beta", { status: "failed", loadable: false }));
      expect(await c.login("beta", { url: null, trigger: "fetch" })).toBeNull();
      expect(await c.login("gamma", { url: null, trigger: "fetch" })).toBeNull();
      expect(assistant.tasks).toEqual([]);
      scheduler.clearCooldown("alpha");
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(LOGIN);
      await c.settled();
      expect(assistant.tasks).toHaveLength(1);
    });

    it("a refusal by the scheduler (the site started cooling down before the task got its place) is not counted", async () => {
      const c = await make();
      const report = deferred<{ ran: boolean; limited: boolean } | null>();
      expect(await c.captcha("alpha", { url: null, trigger: "search", after: report.promise })).toBe(CAPTCHA);
      scheduler.setCooldown("alpha", nowMs + 60_000);
      report.resolve(null);
      await c.settled();
      expect(assistant.tasks).toEqual([]);
      scheduler.clearCooldown("alpha");
      // Twice more refused would pause the site if refusals counted; they do not.
      for (let i = 0; i < 2; i++) {
        const r = deferred<{ ran: boolean; limited: boolean } | null>();
        await c.captcha("alpha", { url: null, trigger: "search", after: r.promise });
        scheduler.setCooldown("alpha", nowMs + 60_000);
        r.resolve(null);
        await c.settled();
        scheduler.clearCooldown("alpha");
      }
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(CAPTCHA);
    });
  });

  describe("after the bridge's own captcha attempt", () => {
    it("waits for the attempt's report: captcha-limited or none → the task starts; the attempt acted → no task", async () => {
      const c = await make();
      const limited = deferred<{ ran: boolean; limited: boolean } | null>();
      expect(await c.captcha("alpha", { url: null, trigger: "search", after: limited.promise })).toBe(
        CAPTCHA,
      );
      await flush();
      expect(assistant.tasks).toEqual([]);
      // While the report is pending, the site counts as worked on.
      expect(await c.captcha("alpha", { url: null, trigger: "read" })).toBe(CAPTCHA);
      limited.resolve({ ran: false, limited: true });
      await c.settled();
      expect(assistant.tasks.map((t) => t.purpose)).toEqual(["captcha"]);

      const none = deferred<{ ran: boolean; limited: boolean } | null>();
      await c.captcha("beta", { url: null, trigger: "search", after: none.promise });
      none.resolve(null);
      await c.settled();
      expect(assistant.tasks.map((t) => t.site)).toEqual(["alpha", "beta"]);

      const acted = deferred<{ ran: boolean; limited: boolean } | null>();
      await c.captcha("alpha", { url: null, trigger: "search", after: acted.promise });
      acted.resolve({ ran: true, limited: false });
      await c.settled();
      expect(assistant.tasks).toHaveLength(2);
      expect(c.workingAction("alpha")).toBeNull();
    });

    it("an attempt that did not run (failed otherwise) also lets the task start", async () => {
      const c = await make();
      const report = deferred<{ ran: boolean; limited: boolean } | null>();
      await c.captcha("alpha", { url: null, trigger: "search", after: report.promise });
      report.resolve({ ran: false, limited: false });
      await c.settled();
      expect(assistant.tasks).toHaveLength(1);
    });
  });

  describe("guard rails", () => {
    it("two failed tasks within the window pause the site for assistantPauseMs; then tasks start again", async () => {
      const c = await make();
      assistant.next({ verdict: "failed", reason: "check_not_passed" });
      await c.captcha("alpha", { url: null, trigger: "search" });
      await c.settled();
      nowMs += WINDOW - 1;
      assistant.next({ verdict: "failed", reason: "check_not_passed" });
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(CAPTCHA);
      await c.settled();
      // Paused: today's action (null), no task — for both purposes.
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBeNull();
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      expect(assistant.tasks).toHaveLength(2);
      // Other sites are not affected.
      expect(await c.captcha("beta", { url: null, trigger: "search" })).toBe(CAPTCHA);
      nowMs += PAUSE;
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(CAPTCHA);
      await c.settled();
      expect(assistant.tasks).toHaveLength(4);
    });

    it("failures further apart than the window do not pause", async () => {
      const c = await make();
      assistant.next({ verdict: "failed", reason: "other" });
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      nowMs += WINDOW + 1;
      assistant.next({ verdict: "failed", reason: "other" });
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(LOGIN);
    });

    it("needs_user holds the site's tasks with the reason's sentence until Check now clears it", async () => {
      const c = await make({ account: "u3" });
      assistant.next({ verdict: "needs_user", reason: "verification_code" });
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      const sentence = assistantAction("verification_code", "u3");
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(sentence);
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(sentence);
      expect(c.currentAction("alpha")).toBe(sentence);
      expect(c.view("alpha")).toMatchObject({ verdict: "needs_user", reason: "verification_code" });
      nowMs += PAUSE * 10;
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(sentence);
      expect(assistant.tasks).toHaveLength(1);
      c.clearHold("alpha");
      expect(c.currentAction("alpha")).toBeNull();
      expect(await c.login("alpha", { url: null, trigger: "check now" })).toBe(LOGIN);
      await c.settled();
      expect(assistant.tasks).toHaveLength(2);
    });

    it("Check now also clears a pause", async () => {
      const c = await make();
      for (let i = 0; i < 2; i++) {
        assistant.next({ verdict: "failed", reason: "other" });
        await c.login("alpha", { url: null, trigger: "fetch" });
        await c.settled();
      }
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      c.clearHold("alpha");
      expect(await c.login("alpha", { url: null, trigger: "check now" })).toBe(LOGIN);
    });

    it("a captcha done followed by another blocked call within the window counts as a failed task", async () => {
      const c = await make();
      await c.captcha("alpha", { url: null, trigger: "search" });
      await c.settled();
      nowMs += 1_000;
      c.noteBlocked("alpha");
      await c.captcha("alpha", { url: null, trigger: "search" });
      await c.settled();
      nowMs += 1_000;
      c.noteBlocked("alpha");
      // Two counted failures: paused.
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBeNull();
      expect(assistant.tasks).toHaveLength(2);
    });

    it("a blocked call after the window, or a second blocked call after the same done, is not counted again", async () => {
      const c = await make();
      await c.captcha("alpha", { url: null, trigger: "search" });
      await c.settled();
      nowMs += WINDOW + 1;
      c.noteBlocked("alpha");
      await c.captcha("alpha", { url: null, trigger: "search" });
      await c.settled();
      c.noteBlocked("alpha");
      c.noteBlocked("alpha");
      expect(await c.captcha("alpha", { url: null, trigger: "search" })).toBe(CAPTCHA);
    });

    it("a failed task for a CLI reason (no session, reason other) probes the CLI again", async () => {
      const c = await make();
      expect(assistant.reprobes).toBe(1);
      assistant.next({ verdict: "failed", reason: "other", sessionId: null });
      assistant.availableValue = false;
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      expect(assistant.reprobes).toBe(2);
      expect(c.available()).toBe(false);
      expect(await c.login("beta", { url: null, trigger: "fetch" })).toBeNull();
      // An AI's own failure (a session ran) does not re-probe.
      assistant.availableValue = true;
      await c.probe();
      assistant.next({ verdict: "failed", reason: "other", sessionId: "s-9" });
      await c.login("beta", { url: null, trigger: "fetch" });
      await c.settled();
      expect(assistant.reprobes).toBe(3);
    });
  });

  describe("login confirmation", () => {
    it("done → confirmLogin; a pass is not counted", async () => {
      const c = await make();
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      expect(confirmations).toEqual(["alpha"]);
      // A captcha done is never confirmed this way.
      await c.captcha("beta", { url: null, trigger: "search" });
      await c.settled();
      expect(confirmations).toEqual(["alpha"]);
    });

    it("the confirmation still finding auth_required counts as a failed task (two pause the site)", async () => {
      confirmResult = { outcome: { status: "auth_required" } };
      const c = await make();
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      await c.login("alpha", { url: null, trigger: "fetch" });
      await c.settled();
      expect(confirmations).toEqual(["alpha", "alpha"]);
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
    });

    it("a busy or unreachable confirmation counts as neither", async () => {
      const c = await make();
      for (const result of [
        { skipped: "site busy: search" },
        { outcome: { status: "browser_unavailable" as const } },
        { outcome: { status: "browser_unavailable" as const } },
      ]) {
        confirmResult = result;
        await c.login("alpha", { url: null, trigger: "fetch" });
        await c.settled();
      }
      expect(confirmations).toHaveLength(3);
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBe(LOGIN);
    });

    it("the site stays worked on while the confirmation runs", async () => {
      const gate = deferred<LoginConfirmation>();
      confirmResult = () => gate.promise;
      const c = await make();
      await c.login("alpha", { url: null, trigger: "fetch" });
      await flush();
      expect(confirmations).toEqual(["alpha"]);
      expect(await c.login("alpha", { url: null, trigger: "read" })).toBe(LOGIN);
      expect(assistant.tasks).toHaveLength(1);
      gate.resolve({ outcome: { status: "ok" } });
      await c.settled();
      expect(c.workingAction("alpha")).toBeNull();
    });
  });

  describe("dispose", () => {
    it("stops running tasks through their signal, does not count them, and refuses new ones", async () => {
      assistant.hold();
      const c = await make();
      await c.login("alpha", { url: null, trigger: "fetch" });
      const report = deferred<{ ran: boolean; limited: boolean } | null>();
      await c.captcha("beta", { url: null, trigger: "search", after: report.promise });
      await flush();
      expect(assistant.held).toHaveLength(1);
      const signal = assistant.tasks[0]!.signal!;
      await c.dispose();
      expect(signal.aborted).toBe(true);
      report.resolve(null);
      await flush();
      expect(assistant.tasks).toHaveLength(1);
      expect(confirmations).toEqual([]);
      expect(c.enabled).toBe(false);
      expect(await c.login("alpha", { url: null, trigger: "fetch" })).toBeNull();
      // The stopped task is logged as timed out; the waiting one never started.
      const lines = logger.lines.filter((l) => l.startsWith("info assistant task "));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"site":"alpha"');
      expect(lines[0]).toContain('"reason":"timed_out"');
      expect(logger.lines.some((l) => l.includes("assistant tasks paused"))).toBe(false);
    });
  });

  describe("logs", () => {
    it("one `assistant task` line per finished task with metadata only", async () => {
      const c = await make();
      assistant.next({
        verdict: "needs_user",
        reason: "no_saved_password",
        sessionId: "s-1",
        durationMs: 42,
      });
      await c.login("alpha", { url: "https://alpha.example.com/secret?token=abc", trigger: "fetch" });
      await c.settled();
      const lines = logger.lines.filter((l) => l.startsWith("info assistant task "));
      expect(lines).toHaveLength(1);
      const fields = JSON.parse(lines[0]!.slice("info assistant task ".length)) as Record<string, unknown>;
      expect(fields).toEqual({
        site: "alpha",
        purpose: "login",
        verdict: "needs_user",
        reason: "no_saved_password",
        sessionId: "s-1",
        durationMs: 42,
        trigger: "fetch",
      });
      const all = logger.lines.join("\n");
      expect(all).not.toContain("token=abc");
      expect(all).not.toContain("secret");
      expect(all).not.toContain("RESULT:");
    });
  });
});
