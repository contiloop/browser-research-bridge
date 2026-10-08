/**
 * The job service's page language (`lang`), helper runtime (`runtime`), and block kind (`blockKind`)
 * handling, the captcha tool's wiring, and the prompt, with scripted runners.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelperRuntimes } from "./helper-runtime.js";
import type { HelperRuntime, RuntimeProbe } from "./helper-runtime.js";
import { parseJobRecord } from "./job-store.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import { CHALLENGE_NOT_RUN } from "./agent-browser.js";
import { CAPTCHA_RULE, buildRetryPrompt, buildSystemPrompt } from "./prompt.js";
import { HOST_APPROVAL_ACTIONS, hostApprovalRequest } from "./service.js";
import type { OnboardingJobService } from "./service.js";
import { ScriptedRunner, makeHarness, recordingBrowser, writeAndValidate } from "./test-fixtures.js";
import type { Harness } from "./test-fixtures.js";
import type { HelperRuntimeId, OnboardingJob } from "./types.js";

const KEY = "demo-example";
const HOST = "demo.example.com";

function runtime(id: HelperRuntimeId, runner: ScriptedRunner, state: { probe: RuntimeProbe }): HelperRuntime {
  return {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    signInHint: `sign in to ${id}`,
    runner,
    async probe() {
      return state.probe;
    },
    async check() {
      return { code: "ok", message: "done" };
    },
  };
}

const blocked =
  (requestedAction = "Log in, then click Retry") =>
  async (ctx: { call: (n: string, a: Record<string, unknown>) => Promise<unknown> }) => {
    await ctx.call("report_blocked", { reason: "login wall", requestedAction });
  };

describe("job lang", () => {
  let h: Harness;
  let svc: OnboardingJobService;
  beforeEach(async () => {
    h = await makeHarness();
    svc = h.makeService();
  });
  afterEach(async () => {
    await svc.stop();
    await h.cleanup();
  });

  it("Add stores lang (default en) and the helper is told to write requestedAction in it", async () => {
    h.runner.push(blocked("Aside에서 demo.example.com에 로그인한 뒤 다시 시도하세요"));
    const job = await svc.add({ input: HOST, lang: "ko" });
    expect(job.lang).toBe("ko");
    expect(job.runtime).toBeNull();
    await svc.start();
    await svc.whenIdle();
    expect(h.runner.requests[0]?.systemPrompt).toContain("Write requestedAction in Korean");
    const paused = svc.get(KEY) as OnboardingJob;
    expect(paused.requestedAction).toBe("Aside에서 demo.example.com에 로그인한 뒤 다시 시도하세요");
    expect(h.store.jobs.get(paused.id)?.lang).toBe("ko");
    expect(h.store.jobs.get(paused.id)?.runtime).toBe("claude");
  });

  it("a Retry replaces lang with the newly given value and keeps it when none is given", async () => {
    h.runner.push(blocked(), blocked(), blocked());
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(svc.get(KEY)?.lang).toBe("en");
    expect(h.runner.requests[0]?.systemPrompt).toContain("Write requestedAction in English");

    await svc.retry(KEY, { lang: "ko" });
    await svc.whenIdle();
    expect(svc.get(KEY)?.lang).toBe("ko");
    expect(h.runner.requests[1]?.systemPrompt).toContain("Write requestedAction in Korean");
    expect(h.runner.requests[1]?.prompt).toContain("Write requestedAction in Korean");

    const id = (svc.get(KEY) as OnboardingJob).id;
    await svc.retryJob(id);
    await svc.whenIdle();
    expect(svc.get(KEY)?.lang).toBe("ko");
    await svc.retryJob(id, { lang: "en" });
    expect(svc.getJob(id)?.lang).toBe("en");
  });

  it("an unknown lang value is English", async () => {
    const job = await svc.add({ input: HOST, lang: "fr" as never });
    expect(job.lang).toBe("en");
  });

  it("Repair stores lang", async () => {
    h.runner.push(async (ctx) => {
      await writeAndValidate(ctx, KEY, HOST);
      await ctx.call("finish", { summary: "done" });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    h.runner.push(blocked());
    const job = await svc.repair(KEY, null, { lang: "ko" });
    expect(job.lang).toBe("ko");
    await svc.whenIdle();
    expect(h.runner.requests[1]?.systemPrompt).toContain("Write requestedAction in Korean");
  });

  it("the host-approval action the service writes follows the job's lang", async () => {
    h.runner.push(async (ctx) => {
      await ctx.call("write_staging_file", {
        path: "manifest.json",
        content: JSON.stringify({ key: KEY, hostnames: [HOST], extraAllowedHosts: ["api.foreign.net"] }),
      });
      await ctx.call("browser_open", { url: `https://${HOST}/` });
    });
    await svc.add({ input: HOST, lang: "ko" });
    await svc.start();
    await svc.whenIdle();
    const paused = svc.get(KEY) as OnboardingJob;
    expect(paused.state).toBe("awaiting_user");
    expect(paused.requestedAction).toBe(HOST_APPROVAL_ACTIONS.ko);
    // The reason is technical text and stays English.
    expect(paused.reason).toBe("the adapter needs access to hosts outside example.com: api.foreign.net");
    // A pause the service writes itself is of kind "other".
    expect(paused.blockKind).toBe("other");
  });
});

describe("host approval text and prompts", () => {
  it("exists in both languages", () => {
    expect(hostApprovalRequest(["www.example.com"], ["cdn.other.net"]).requestedAction).toBe(
      "Approve these hosts by clicking Retry (or remove them from the manifest and Retry)",
    );
    const ko = hostApprovalRequest(["www.example.com"], ["cdn.other.net"], "ko").requestedAction;
    expect(ko).toBe(HOST_APPROVAL_ACTIONS.ko);
    expect(ko).toMatch(/[가-힣]/);
  });

  it("the language rule is the only prompt change; the cited documents stay", () => {
    const base = {
      kind: "add" as const,
      key: KEY,
      input: HOST,
      hostnames: [HOST],
      note: null,
      asideAccount: "u0",
      lastFailure: null,
    };
    const en = buildSystemPrompt({ ...base, lang: "en" });
    const ko = buildSystemPrompt({ ...base, lang: "ko" });
    expect(buildSystemPrompt(base)).toBe(en);
    expect(en.replace("in English", "in Korean")).toBe(ko);
    expect(ko).toContain("docs/ADAPTERS.md §12");
    expect(ko).toContain("sites/reuters/adapter.ts");
    expect(buildRetryPrompt({ reason: null, requestedAction: null })).toContain("in English");
  });

  it("old job records without lang or runtime read as en and null", () => {
    const old = parseJobRecord({
      version: 1,
      id: "job-20260101000000-abcdef",
      kind: "add",
      key: KEY,
      input: HOST,
      state: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(old?.lang).toBe("en");
    expect(old?.runtime).toBeNull();
    const fresh = parseJobRecord({ ...old, lang: "ko", runtime: "codex" });
    expect([fresh?.lang, fresh?.runtime]).toEqual(["ko", "codex"]);
    expect(parseJobRecord({ ...old, lang: "de", runtime: "gpt" })).toMatchObject({
      lang: "en",
      runtime: null,
    });
  });

  it("old job records without blockKind (or with an unknown one) read as other", () => {
    const old = parseJobRecord({
      version: 1,
      id: "job-20260101000000-abcdef",
      kind: "add",
      key: KEY,
      input: HOST,
      state: "awaiting_user",
      reason: "login wall",
      requestedAction: "Log in, then click Retry",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(old?.blockKind).toBe("other");
    expect(parseJobRecord({ ...old, blockKind: "login" })?.blockKind).toBe("login");
    expect(parseJobRecord({ ...old, blockKind: "paywall" })?.blockKind).toBe("other");
    expect(parseJobRecord({ ...old, blockKind: 3 })?.blockKind).toBe("other");
  });

  it("the prompt sends captchas to browser_solve_captcha first, keeps the credential rule, and asks for the block kind", () => {
    for (const kind of ["add", "repair"] as const) {
      const prompt = buildSystemPrompt({
        kind,
        key: KEY,
        input: HOST,
        hostnames: [HOST],
        note: null,
        asideAccount: "u0",
        lastFailure: null,
      });
      expect(prompt).toContain("Never type credentials, never log in");
      expect(prompt).not.toMatch(/never solve captchas/i);
      expect(prompt).toContain(`- ${CAPTCHA_RULE}`);
      expect(CAPTCHA_RULE).toContain("call browser_solve_captcha once with that tab");
      expect(CAPTCHA_RULE).toContain(
        'Call report_blocked with kind "captcha" only when browser_solve_captcha returns solved: false',
      );
      expect(prompt).toContain("report_blocked({ reason, requestedAction, kind })");
      expect(prompt).toContain(
        '- not logged in / login wall, kind "login": "Log in to <site> in Aside (account u0), then click Retry"',
      );
      expect(prompt).toContain(
        'browser_solve_captcha did not solve, kind "captcha": "Open <url> in Aside, solve the captcha, then click Retry"',
      );
      expect(prompt).toContain('- consent interstitial, kind "consent":');
      expect(prompt).toContain('- subscription missing, kind "subscription":');
      expect(prompt).toContain('kind "other"');
    }
  });
});

describe("job block kind", () => {
  let h: Harness;
  let svc: OnboardingJobService;
  beforeEach(async () => {
    h = await makeHarness();
    svc = h.makeService();
  });
  afterEach(async () => {
    await svc.stop();
    await h.cleanup();
  });

  it("report_blocked's kind is stored as blockKind, defaults to other, and is cleared while the job runs again", async () => {
    let runningKind: string | undefined;
    h.runner.push(
      async (ctx) => {
        await ctx.call("report_blocked", {
          reason: "captcha page",
          requestedAction: "Open https://demo.example.com/ in Aside, solve the captcha, then click Retry",
          kind: "captcha",
        });
      },
      async (ctx) => {
        runningKind = svc.get(KEY)?.blockKind;
        await ctx.call("report_blocked", {
          reason: "login wall",
          requestedAction: "Log in, then click Retry",
        });
      },
      async (ctx) => {
        await ctx.call("report_blocked", {
          reason: "login wall",
          requestedAction: "Log in, then click Retry",
          kind: "login",
        });
      },
    );
    const added = await svc.add({ input: HOST });
    expect(added.blockKind).toBe("other");
    await svc.start();
    await svc.whenIdle();
    const paused = svc.get(KEY) as OnboardingJob;
    expect(paused).toMatchObject({ state: "awaiting_user", blockKind: "captcha" });
    expect(h.store.jobs.get(paused.id)?.blockKind).toBe("captcha");
    const log = (await svc.log(paused.id)).map((l) => l.message);
    expect(log).toContain(
      "Waiting for the user (captcha): captcha page — Open https://demo.example.com/ in Aside, solve the captcha, then click Retry",
    );

    await svc.retry(KEY);
    await svc.whenIdle();
    expect(runningKind).toBe("other");
    expect(svc.get(KEY)).toMatchObject({ state: "awaiting_user", blockKind: "other" });

    await svc.retry(KEY);
    await svc.whenIdle();
    expect(svc.get(KEY)).toMatchObject({ state: "awaiting_user", blockKind: "login" });
    expect(h.store.jobs.get(paused.id)?.blockKind).toBe("login");

    // Ending a paused job leaves no block behind.
    await svc.cancel(KEY);
    expect(svc.get(KEY)).toMatchObject({ state: "cancelled", blockKind: "other" });
  });

  it("a paused job read back from the store after a restart keeps its block kind", async () => {
    h.runner.push(async (ctx) => {
      await ctx.call("report_blocked", {
        reason: "consent dialog",
        requestedAction:
          "Open https://demo.example.com/ in Aside and accept the consent dialog, then click Retry",
        kind: "consent",
      });
    });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    await svc.stop();
    svc = h.makeService();
    await svc.start();
    expect(svc.get(KEY)).toMatchObject({ state: "awaiting_user", blockKind: "consent" });
  });
});

describe("browser_solve_captcha in a job", () => {
  let h: Harness;
  let svc: OnboardingJobService | null = null;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await svc?.stop();
    svc = null;
    await h.cleanup();
  });

  const solveOnFirstTab =
    (results: string[]) =>
    async (ctx: {
      call: (
        n: string,
        a: Record<string, unknown>,
      ) => Promise<{ content: { type: string; text?: string }[] }>;
    }) => {
      await ctx.call("browser_open", { url: `https://${HOST}/` });
      const r = await ctx.call("browser_solve_captcha", { tabId: "t1" });
      results.push(r.content.map((c) => c.text ?? "").join(""));
      await ctx.call("report_blocked", {
        reason: "captcha not solved",
        requestedAction: "Open the page in Aside, solve the captcha, then click Retry",
        kind: "captcha",
      });
    };

  it("runs on the job's tab with the job's scope, the configured budget, and the step's holder", async () => {
    const browser = recordingBrowser({
      challenge: async () => ({
        solved: false,
        kind: "slider",
        rounds: 2,
        message: "still shown",
        available: true,
      }),
    });
    const holders: string[][] = [];
    const scheduler = new InMemoryScheduler({ concurrentStaggerMs: 0 });
    const answer = browser.solveChallenge?.bind(browser);
    browser.solveChallenge = async (o) => {
      holders.push(scheduler.holders(KEY));
      return (answer as NonNullable<typeof answer>)(o);
    };
    const results: string[] = [];
    h.runner.push(solveOnFirstTab(results));
    svc = h.makeService({ browser, scheduler, captchaAttemptBudgetMs: 30_000 });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(browser.challenges).toHaveLength(1);
    const options = browser.challenges[0];
    expect(options?.scope).toMatchObject({ siteKey: KEY, hostnames: [HOST] });
    expect(options?.tab).toEqual({ id: "target-1", url: `https://${HOST}/` });
    expect(options?.budgetMs).toBe(30_000);
    expect(holders).toEqual([["onboarding running"]]);
    expect(results[0]?.split("\n")[1]).toBe('{"solved":false,"kind":"slider","message":"still shown"}');
    const job = svc.get(KEY) as OnboardingJob;
    expect(job).toMatchObject({ state: "awaiting_user", blockKind: "captcha" });
    const log = (await svc.log(job.id)).map((l) => l.message).join("\n");
    expect(log).toContain("← browser_solve_captcha ok: captcha attempt: unsolved (kind slider)");
    expect(log).not.toContain("still shown");
  });

  it("captchaAuto false answers turned off without asking the browser", async () => {
    const browser = recordingBrowser({
      challenge: async () => ({
        solved: true,
        kind: "checkbox",
        rounds: 1,
        message: "done",
        available: true,
      }),
    });
    const results: string[] = [];
    h.runner.push(solveOnFirstTab(results));
    svc = h.makeService({ browser, captchaAuto: false });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(browser.challenges).toEqual([]);
    expect(results[0]).toContain("captcha attempt: unavailable (kind unknown)");
    expect(results[0]).toContain(CHALLENGE_NOT_RUN.turnedOff);
  });
});

describe("job runtime", () => {
  let h: Harness;
  let svc: OnboardingJobService | null = null;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await svc?.stop();
    svc = null;
    await h.cleanup();
  });

  it("records the runtime; a retry stays on it while available", async () => {
    const claudeRunner = new ScriptedRunner();
    const codexRunner = new ScriptedRunner([blocked(), blocked()]);
    const claude = { probe: { installed: true, signedIn: false } as RuntimeProbe };
    const codex = { probe: { installed: true, signedIn: null } as RuntimeProbe };
    const runtimes = new HelperRuntimes({
      configured: "auto",
      runtimes: [runtime("claude", claudeRunner, claude), runtime("codex", codexRunner, codex)],
    });
    svc = h.makeService({ runtimes });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(svc.get(KEY)?.runtime).toBe("codex");
    // Claude signs in meanwhile; the job keeps its runtime and session.
    claude.probe = { installed: true, signedIn: true };
    await svc.retry(KEY);
    await svc.whenIdle();
    expect(svc.get(KEY)?.runtime).toBe("codex");
    expect(claudeRunner.requests).toHaveLength(0);
    expect(codexRunner.requests[1]?.resumeSessionId).toBe("session-1");
  });

  it("a retry whose runtime is gone runs on the configured one in a new session with a summary", async () => {
    const claudeRunner = new ScriptedRunner([blocked()]);
    const codexRunner = new ScriptedRunner([
      async (ctx) => {
        expect(ctx.req.resumeSessionId).toBeNull();
        expect(ctx.req.prompt).toContain("earlier session could not be continued");
        await writeAndValidate(ctx, KEY, HOST);
        await ctx.call("finish", { summary: "done on codex" });
      },
    ]);
    const claude = { probe: { installed: true, signedIn: null } as RuntimeProbe };
    const codex = { probe: { installed: true, signedIn: true } as RuntimeProbe };
    const runtimes = new HelperRuntimes({
      configured: "auto",
      runtimes: [runtime("claude", claudeRunner, claude), runtime("codex", codexRunner, codex)],
    });
    svc = h.makeService({ runtimes });
    await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    expect(svc.get(KEY)?.runtime).toBe("claude");
    claude.probe = { installed: false, signedIn: null };
    await svc.retry(KEY);
    await svc.whenIdle();
    const done = svc.get(KEY) as OnboardingJob;
    expect(done.state).toBe("succeeded");
    expect(done.runtime).toBe("codex");
    expect(codexRunner.requests).toHaveLength(1);
    const log = (await svc.log(done.id)).map((l) => l.message).join("\n");
    expect(log).toContain("The earlier helper (claude) is not available; running on Codex");
  });

  it("with no runtime available the job fails with a message naming the sign-in", async () => {
    const claude = { probe: { installed: true, signedIn: false } as RuntimeProbe };
    const runtimes = new HelperRuntimes({
      configured: "auto",
      runtimes: [runtime("claude", new ScriptedRunner(), claude)],
    });
    svc = h.makeService({ runtimes });
    const job = await svc.add({ input: HOST });
    await svc.start();
    await svc.whenIdle();
    const failed = svc.getJob(job.id) as OnboardingJob;
    expect(failed.state).toBe("failed");
    expect(failed.reason).toContain("Claude is not signed in (sign in to claude)");
    expect(failed.runtime).toBeNull();
    expect(h.registry.get(KEY)?.status).toBe("failed");
  });

  it("helperStatus and helperCheck answer through the service's registry", async () => {
    const runner = new ScriptedRunner([
      async (ctx) => {
        await ctx.call("finish", { summary: "sdk check ok" });
      },
    ]);
    svc = h.makeService({ runner });
    const status = await svc.helperStatus();
    expect(status).toEqual({
      configured: "auto",
      supported: ["claude"],
      runtimes: { claude: { installed: true, signedIn: null }, codex: null },
      wouldUse: "claude",
      lastCheck: null,
    });
    const check = await svc.helperCheck();
    expect(check).toMatchObject({ runtime: "claude", ok: true, code: "ok" });
    expect(typeof check.at).toBe("string");
    expect(runner.requests[0]?.workDir).toContain("helper-check");
    expect((await svc.helperStatus(check)).lastCheck).toEqual(check);
  });
});
