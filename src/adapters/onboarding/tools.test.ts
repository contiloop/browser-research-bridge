import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { AgentBrowser, CHALLENGE_NOT_RUN, CURRENT_URL_SCRIPT, resolveAgentScope } from "./agent-browser.js";
import type { AgentBrowserOptions } from "./agent-browser.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import type { ChallengeAttempt, SolveChallengeOptions } from "../../ports/browser.js";
import { recordingBrowser } from "./test-fixtures.js";
import type { RecordingBrowserOptions } from "./test-fixtures.js";
import { ReferenceLibrary, StagingFiles } from "./files.js";
import type { StagingValidation } from "./staging-validation.js";
import { checkPageScript, shadowParams } from "../aside/shim.js";
import { wrapPageScript } from "../../adapter-kit/page-script.js";
import { OutcomeError } from "../../core/outcome.js";
import {
  INTERACTIVE_SCRIPT,
  UNTRUSTED_PREFIX,
  challengeResult,
  checkAgentScript,
  createOnboardingTools,
  logUrl,
  selectorScript,
} from "./tools.js";
import type { TerminalCall, ToolHost } from "./tools.js";
import type { AgentTool } from "./types.js";

describe("resolveAgentScope (site isolation)", () => {
  const others = new Map<string, string[]>([
    ["blog-naver", ["blog.naver.com"]],
    ["example-news", ["news.example.org"]],
  ]);

  it("unions provisional and declared hosts, normalized and de-duplicated", () => {
    const s = resolveAgentScope({
      provisional: ["www.reuters.com"],
      declared: ["reuters.com", "WWW.REUTERS.COM", "arcpublishing.com"],
      otherSites: others,
    });
    expect(s.hosts).toEqual(["www.reuters.com", "reuters.com", "arcpublishing.com"]);
    expect(s.excluded).toEqual([]);
  });

  it("accepts staged hosts on the provisional hostnames' registrable domain; others need the user's approval", () => {
    const s = resolveAgentScope({
      provisional: ["www.reuters.com"],
      declared: [],
      staged: [
        "www.reuters.com",
        "dd.reuters.com",
        "arcpublishing.com",
        "cdn.pstatic.net",
        "ARCPUBLISHING.com",
      ],
      approved: [],
      otherSites: others,
    });
    expect(s.hosts).toEqual(["www.reuters.com", "dd.reuters.com"]);
    expect(s.needsApproval).toEqual(["arcpublishing.com", "cdn.pstatic.net"]);
    const approved = resolveAgentScope({
      provisional: ["www.reuters.com"],
      declared: [],
      staged: ["dd.reuters.com", "arcpublishing.com", "cdn.pstatic.net"],
      approved: ["arcpublishing.com"],
      otherSites: others,
    });
    expect(approved.hosts).toEqual(["www.reuters.com", "dd.reuters.com", "arcpublishing.com"]);
    expect(approved.needsApproval).toEqual(["cdn.pstatic.net"]);
  });

  it("never asks approval for hosts that are kept out anyway (other sites, IPs)", () => {
    const s = resolveAgentScope({
      provisional: ["cafe.naver.com"],
      declared: [],
      staged: ["blog.naver.com", "10.0.0.1", "nid.naver.com"],
      approved: [],
      otherSites: others,
    });
    expect(s.hosts).toEqual(["cafe.naver.com", "nid.naver.com"]);
    expect(s.needsApproval).toEqual([]);
    expect(s.excluded.map((e) => e.host)).toEqual(["blog.naver.com", "10.0.0.1"]);
  });

  it("keeps out other sites' hosts, their parents and subdomains, IPs, local and invalid names", () => {
    const s = resolveAgentScope({
      provisional: ["cafe.naver.com"],
      declared: [
        "naver.com",
        "blog.naver.com",
        "m.blog.naver.com",
        "127.0.0.1",
        "localhost",
        "intranet",
        "bad host",
        "nid.naver.com",
      ],
      otherSites: others,
    });
    expect(s.hosts).toEqual(["cafe.naver.com", "nid.naver.com"]);
    expect(s.excluded.map((e) => e.host)).toEqual([
      "naver.com",
      "blog.naver.com",
      "m.blog.naver.com",
      "127.0.0.1",
      "localhost",
      "intranet",
      "bad host",
    ]);
  });
});

describe("checkAgentScript (no credentials to the agent)", () => {
  it.each([
    "return document.cookie",
    "return page.evaluate(() => localStorage.getItem('t'))",
    "return page.evaluate(() => document.querySelector('input[type=password]').value)",
    "return sessionStorage.length",
  ])("rejects %j", (code) => {
    expect(checkAgentScript(code)).not.toBeNull();
  });

  it("allows ordinary DOM scripts, including login-wall detection", () => {
    expect(checkAgentScript("return await page.evaluate(() => document.title)")).toBeNull();
    expect(
      checkAgentScript("return await page.evaluate(() => !!document.querySelector('input[type=password]'))"),
    ).toBeNull();
  });

  it("the bridge's own snapshot scripts pass the port's page-script check", () => {
    const params = shadowParams();
    expect(checkPageScript(INTERACTIVE_SCRIPT, params)).toMatchObject({ ok: true });
    expect(checkPageScript(selectorScript("article h1, .x[data-y='z']", 15_000), params)).toMatchObject({
      ok: true,
    });
    expect(
      checkPageScript(wrapPageScript("return await page.evaluate(() => document.title);"), params),
    ).toMatchObject({
      ok: true,
    });
    expect(checkPageScript(CURRENT_URL_SCRIPT, params)).toMatchObject({ ok: true });
  });

  it("logs URLs without query or fragment", () => {
    expect(logUrl("https://www.reuters.com/search?q=secret#x")).toBe("https://www.reuters.com/search");
  });
});

describe("tool handlers", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let terminal: TerminalCall | null;
  let calls: string[];
  let logs: string[];
  let pendingHosts: string[];
  let active: boolean;
  let tools: AgentTool[];

  const validation: StagingValidation = {
    async full(key) {
      calls.push(`full ${key}`);
      return {
        version: 1,
        key,
        form: "full",
        target: "staging",
        passed: false,
        startedAt: "",
        finishedAt: "",
        durationMs: 0,
        adapterHash: null,
        manifestVersion: 1,
        gatedCheck: "not_run",
        failure: { step: "search", status: "empty", message: "no results" },
        steps: [
          {
            name: "search",
            passed: false,
            status: "empty",
            message: "no results",
            durationMs: 1,
            details: { query: "x" },
          },
        ],
      } as never;
    },
    async quick(key) {
      calls.push(`quick ${key}`);
      return { ok: false, problems: ["manifest.json is missing"] };
    },
    async stagedPassed() {
      return { ok: false, reason: "the staged adapter has not been validated yet" };
    },
    async typecheck() {
      return [];
    },
  };

  beforeEach(async () => {
    tmp = await makeTempDir("brb-tools-");
    await mkdir(join(tmp.dir, "docs"), { recursive: true });
    await mkdir(join(tmp.dir, "sites", "demo"), { recursive: true });
    await writeFile(join(tmp.dir, "docs", "ADAPTERS.md"), "# Writing a site adapter");
    terminal = null;
    calls = [];
    logs = [];
    pendingHosts = [];
    active = true;
    const host: ToolHost = {
      kind: "add",
      signal: new AbortController().signal,
      key: () => "demo",
      browser: () => ({}) as AgentBrowser,
      staging: () =>
        new StagingFiles({
          siteDir: join(tmp.dir, "sites", "demo"),
          stagingDir: join(tmp.dir, "sites", "demo", ".staging"),
          key: "demo",
        }),
      references: new ReferenceLibrary({ repoRoot: tmp.dir, sitesDir: join(tmp.dir, "sites") }),
      validation,
      resolveSite: async () => ({ ok: false, message: "not used" }),
      terminal: () => terminal,
      setTerminal: (c) => {
        terminal ??= c;
      },
      log: (_s, _l, m) => logs.push(m),
      jobActive: () => active,
      requireApprovedHosts: async () => {
        if (pendingHosts.length > 0) throw new Error(`paused for ${pendingHosts.join(", ")}`);
      },
    };
    tools = createOnboardingTools(host);
  });
  afterEach(async () => tmp.cleanup());

  const call = (name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(name);
    return t.call(args);
  };
  const textOf = (r: Awaited<ReturnType<typeof call>>) =>
    r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

  it("exposes exactly the onboarding tools (no resolve_site once the key is known)", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "browser_open",
      "browser_snapshot",
      "browser_run_script",
      "browser_screenshot",
      "browser_close",
      "browser_solve_captcha",
      "read_reference",
      "read_staging_file",
      "write_staging_file",
      "run_validation",
      "report_blocked",
      "report_failure",
      "finish",
    ]);
  });

  it("read_reference serves allowlisted docs and refuses anything else", async () => {
    expect(textOf(await call("read_reference", { path: "docs/ADAPTERS.md" }))).toContain(
      "# Writing a site adapter",
    );
    const denied = await call("read_reference", { path: "../../etc/passwd" });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("not an allowed reference");
  });

  it("run_validation runs the full validation of the staged key, or the quick check with light", async () => {
    const full = await call("run_validation", {});
    expect(full.isError).toBe(true);
    expect(textOf(full)).toContain("FAIL search [empty] no results");
    const light = await call("run_validation", { light: true });
    expect(textOf(light)).toContain("manifest.json is missing");
    expect(calls).toEqual(["full demo", "quick demo"]);
  });

  it("full run_validation and finish do not run while staged hosts wait for the user's approval", async () => {
    pendingHosts = ["arcpublishing.com"];
    const full = await call("run_validation", {});
    expect(full.isError).toBe(true);
    expect(textOf(full)).toContain("paused for arcpublishing.com");
    const done = await call("finish", { summary: "done" });
    expect(done.isError).toBe(true);
    expect(textOf(done)).toContain("paused for arcpublishing.com");
    expect(calls).toEqual([]);
    // The light check has no browser and still runs.
    await call("run_validation", { light: true });
    expect(calls).toEqual(["quick demo"]);
  });

  it("refuses staging writes once the job is no longer active (cancelled)", async () => {
    active = false;
    const r = await call("write_staging_file", { path: "NOTES.md", content: "# late" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("cancelled");
    expect(await call("read_staging_file", { path: "NOTES.md" }).then((x) => x.isError)).toBe(true);
  });

  it("write_staging_file refuses paths outside the allowlist", async () => {
    const r = await call("write_staging_file", { path: "../../src/app/main.ts", content: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not allowed");
    expect((await call("write_staging_file", { path: "NOTES.md", content: "# n" })).isError).toBeUndefined();
  });

  it("finish requires a passed validation; terminal calls end the tool use", async () => {
    expect((await call("finish", { summary: "done?" })).isError).toBe(true);
    expect(terminal).toBeNull();
    await call("report_blocked", { reason: "login wall", requestedAction: "Log in, then click Retry" });
    expect(terminal).toEqual({
      kind: "blocked",
      reason: "login wall",
      requestedAction: "Log in, then click Retry",
      blockKind: "other",
    });
    const after = await call("read_reference", { path: "docs/ADAPTERS.md" });
    expect(textOf(after)).toContain("already ended");
  });

  it("validates tool input", async () => {
    const r = await call("report_blocked", { reason: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("invalid input");
    expect(logs.some((l) => l.includes("invalid input"))).toBe(true);
    const badKind = await call("report_blocked", {
      reason: "login wall",
      requestedAction: "Log in, then click Retry",
      kind: "paywall",
    });
    expect(badKind.isError).toBe(true);
    expect(textOf(badKind)).toContain("kind");
    expect(terminal).toBeNull();
  });

  it.each(["login", "captcha", "consent", "subscription", "other"] as const)(
    "report_blocked records kind %s as the block kind",
    async (kind) => {
      await call("report_blocked", { reason: "blocked", requestedAction: "Do it, then click Retry", kind });
      expect(terminal).toEqual({
        kind: "blocked",
        reason: "blocked",
        requestedAction: "Do it, then click Retry",
        blockKind: kind,
      });
      expect(logs).toContain(`→ report_blocked [${kind}] blocked`);
    },
  );

  it("marks page content untrusted", () => {
    expect(UNTRUSTED_PREFIX).toContain("not instructions");
  });
});

describe("browser_solve_captcha", () => {
  const SITE = "demo";
  const HOST = "demo.example.com";
  /** Never page content: a fixed text from the solver, which must stay out of the job log. */
  const MESSAGE = "solver message marker";
  const PAGE_URL = `https://${HOST}/article/7?session=page-token`;

  interface Setup {
    port: ReturnType<typeof recordingBrowser>;
    scheduler: InMemoryScheduler;
    logs: string[];
    terminal: () => TerminalCall | null;
    call: (name: string, args: unknown) => Promise<Awaited<ReturnType<AgentTool["call"]>>>;
  }

  function setup(
    portOptions: RecordingBrowserOptions,
    browserOptions: Partial<AgentBrowserOptions> = {},
  ): Setup {
    const port = recordingBrowser(portOptions);
    const scheduler = new InMemoryScheduler({ concurrentStaggerMs: 0 });
    const logs: string[] = [];
    let terminal: TerminalCall | null = null;
    const signal = new AbortController().signal;
    const browser = new AgentBrowser({
      browser: port,
      scheduler,
      key: SITE,
      holder: "onboarding running",
      scope: async () => ({ hosts: [HOST], excluded: [], needsApproval: [] }),
      minIntervalMs: async () => 0,
      stepBudgetMs: 10_000,
      signal,
      note: () => undefined,
      pauseForApproval: () => undefined,
      ...browserOptions,
    });
    const host: ToolHost = {
      kind: "add",
      signal,
      key: () => SITE,
      browser: () => browser,
      staging: () => {
        throw new Error("not used");
      },
      references: {} as ToolHost["references"],
      validation: {} as StagingValidation,
      resolveSite: async () => ({ ok: false, message: "not used" }),
      terminal: () => terminal,
      setTerminal: (c) => {
        terminal ??= c;
      },
      log: (_s, _l, m) => logs.push(m),
      jobActive: () => true,
      requireApprovedHosts: async () => undefined,
    };
    const tools = createOnboardingTools(host);
    const call = (name: string, args: unknown) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(name);
      return t.call(args);
    };
    return { port, scheduler, logs, terminal: () => terminal, call };
  }

  const textOf = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
  /** The `{ solved, kind, message }` line of the result. */
  const shapeOf = (r: { content: { type: string; text?: string }[] }) =>
    JSON.parse(textOf(r).split("\n")[1] ?? "null") as unknown;

  const attempt = (patch: Partial<ChallengeAttempt>): ChallengeAttempt => ({
    solved: false,
    kind: "unknown",
    rounds: 0,
    message: MESSAGE,
    available: true,
    ...patch,
  });

  it("runs one attempt on the job's tab as an exclusive step of the job, with the session's scope and the page's address", async () => {
    let seen: { holders: string[]; poolTask: string } | null = null;
    const s = setup({
      scriptResult: (script) => (script === CURRENT_URL_SCRIPT ? PAGE_URL : { ran: true }),
      challenge: async () => {
        // While the attempt runs, the site is held by the job alone: a pool task cannot start.
        const poolTask = await s.scheduler
          .runForSite(
            { site: SITE, holder: "search", acquireTimeoutMs: 50, minIntervalMs: 0 },
            async () => "ran",
          )
          .catch((e: unknown) => (e as Error).message);
        seen = { holders: s.scheduler.holders(SITE), poolTask };
        return attempt({ solved: true, kind: "checkbox", rounds: 1 });
      },
    });
    const opened = await s.call("browser_open", { url: `https://${HOST}/start` });
    expect(textOf(opened)).toContain("opened tab t1");
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(r.isError).toBeUndefined();
    expect(shapeOf(r)).toEqual({ solved: true, kind: "checkbox", message: MESSAGE });
    expect(textOf(r)).toContain("look at the page again");
    expect(seen).toEqual({ holders: ["onboarding running"], poolTask: "site busy: onboarding running" });
    const [options] = s.port.challenges as [SolveChallengeOptions];
    expect(s.port.challenges).toHaveLength(1);
    expect(options.scope.siteKey).toBe(SITE);
    expect(options.scope.hostnames).toEqual([HOST]);
    expect(options.scope).toBe(s.port.scopes[0]); // the agent's own session scope (and its lease)
    expect(options.tab).toEqual({ id: "target-1", url: `https://${HOST}/start` });
    expect(options.url).toBe(PAGE_URL);
    expect(options.budgetMs).toBe(45_000);
    expect(s.scheduler.isIdle(SITE)).toBe(true);
  });

  it("the job log keeps tool, result, and kind only: never the solver's message or the page's address", async () => {
    const s = setup({
      scriptResult: (script) => (script === CURRENT_URL_SCRIPT ? PAGE_URL : { ran: true }),
      challenge: async () => attempt({ kind: "slider", rounds: 2 }),
    });
    await s.call("browser_open", { url: `https://${HOST}/start` });
    await s.call("browser_solve_captcha", { tabId: "t1" });
    const toolLines = s.logs.filter((l) => l.includes("browser_solve_captcha"));
    expect(toolLines).toEqual([
      "→ browser_solve_captcha t1",
      "← browser_solve_captcha ok: captcha attempt: unsolved (kind slider)",
    ]);
    const all = s.logs.join("\n");
    for (const hidden of [MESSAGE, "page-token", "/article/7"]) expect(all).not.toContain(hidden);
  });

  it.each([
    ["solved", attempt({ solved: true, kind: "text", rounds: 1 }), { solved: true, kind: "text" }],
    ["unsolved", attempt({ kind: "slider", rounds: 2 }), { solved: false, kind: "slider" }],
    ["unsolved", attempt({ kind: "unknown" }), { solved: false, kind: "unknown" }],
    ["unsolved", attempt({ kind: "none" }), { solved: false, kind: "none" }],
    ["unavailable", attempt({ available: false }), { solved: false, kind: "unknown" }],
  ] as const)("result %s: %j", async (result, answer, shape) => {
    const s = setup({ challenge: async () => answer });
    await s.call("browser_open", { url: `https://${HOST}/` });
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(r.isError).toBeUndefined();
    expect(shapeOf(r)).toEqual({ ...shape, message: MESSAGE });
    expect(textOf(r).split("\n")[0]).toBe(`captcha attempt: ${result} (kind ${shape.kind})`);
    expect(challengeResult(answer)).toBe(result);
    const next = textOf(r).split("\n")[2] ?? "";
    if (shape.solved) expect(next).toContain("look at the page again");
    else if (shape.kind === "none") expect(next).toContain("No captcha or block page is shown");
    else expect(next).toContain('Not solved. Call report_blocked with kind "captcha"');
    // The tool never ends the job by itself: the helper decides with report_blocked.
    expect(s.terminal()).toBeNull();
  });

  it("a tab with no challenge answers solved false, kind none, and the solver's message", async () => {
    const s = setup({
      challenge: async () =>
        attempt({ kind: "none", message: "no captcha or block page is shown after reloading the page" }),
    });
    await s.call("browser_open", { url: `https://${HOST}/` });
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(shapeOf(r)).toEqual({
      solved: false,
      kind: "none",
      message: "no captcha or block page is shown after reloading the page",
    });
    expect(textOf(r)).toContain("No captcha or block page is shown");
  });

  it("a browser without the capability answers unavailable without a browser step", async () => {
    const s = setup({});
    expect("solveChallenge" in s.port).toBe(false);
    await s.call("browser_open", { url: `https://${HOST}/` });
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(r.isError).toBeUndefined();
    expect(shapeOf(r)).toEqual({ solved: false, kind: "unknown", message: CHALLENGE_NOT_RUN.noCapability });
    expect(s.logs).toContain("← browser_solve_captcha ok: captcha attempt: unavailable (kind unknown)");
    expect(s.port.scripts).toEqual([]);
  });

  it("with automatic solving turned off it answers unavailable and the port is not asked", async () => {
    const s = setup(
      { challenge: async () => attempt({ solved: true, kind: "checkbox" }) },
      { challengesEnabled: false },
    );
    await s.call("browser_open", { url: `https://${HOST}/` });
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(shapeOf(r)).toEqual({ solved: false, kind: "unknown", message: CHALLENGE_NOT_RUN.turnedOff });
    expect(textOf(r)).toContain('Call report_blocked with kind "captcha"');
    expect(s.port.challenges).toEqual([]);
  });

  it("refuses a tab id that is not one of the job's tabs with the same error as the other tab tools", async () => {
    const s = setup({ challenge: async () => attempt({ solved: true, kind: "checkbox" }) });
    const none = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toBe(textOf(await s.call("browser_screenshot", { tabId: "t1" })));
    expect(textOf(none)).toContain('unknown tab "t1"');
    await s.call("browser_open", { url: `https://${HOST}/` });
    const wrong = await s.call("browser_solve_captcha", { tabId: "t9" });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toBe(textOf(await s.call("browser_close", { tabId: "t9" })));
    expect(textOf(wrong)).toContain("open tabs: t1");
    expect(s.port.challenges).toEqual([]);
    const invalid = await s.call("browser_solve_captcha", {});
    expect(textOf(invalid)).toContain("invalid input");
  });

  it("falls back to the tab's opening address when the page address cannot be read; the budget is configurable", async () => {
    const s = setup(
      {
        scriptResult: (script) => {
          if (script === CURRENT_URL_SCRIPT) throw new Error("the page did not answer");
          return { ran: true };
        },
        challenge: async () => attempt({ kind: "slider" }),
      },
      { challengeBudgetMs: 1234 },
    );
    await s.call("browser_open", { url: `https://${HOST}/start` });
    await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(s.port.challenges[0]?.url).toBe(`https://${HOST}/start`);
    expect(s.port.challenges[0]?.budgetMs).toBe(1234);
    const odd = setup({
      scriptResult: (script) => (script === CURRENT_URL_SCRIPT ? "javascript:alert(1)" : { ran: true }),
      challenge: async () => attempt({ kind: "slider" }),
    });
    await odd.call("browser_open", { url: `https://${HOST}/home` });
    await odd.call("browser_solve_captcha", { tabId: "t1" });
    expect(odd.port.challenges[0]?.url).toBe(`https://${HOST}/home`);
  });

  it("a setup failure of the port is a tool error with the port's message", async () => {
    const s = setup({
      challenge: async () => {
        throw new OutcomeError("browser_unavailable", "Aside is not reachable");
      },
    });
    await s.call("browser_open", { url: `https://${HOST}/` });
    const r = await s.call("browser_solve_captcha", { tabId: "t1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Aside is not reachable");
  });
});
