import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { resolveAgentScope } from "./agent-browser.js";
import type { AgentBrowser } from "./agent-browser.js";
import { ReferenceLibrary, StagingFiles } from "./files.js";
import type { StagingValidation } from "./staging-validation.js";
import { checkPageScript, shadowParams } from "../aside/shim.js";
import { wrapPageScript } from "../../adapter-kit/page-script.js";
import {
  INTERACTIVE_SCRIPT,
  UNTRUSTED_PREFIX,
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
    });
    const after = await call("read_reference", { path: "docs/ADAPTERS.md" });
    expect(textOf(after)).toContain("already ended");
  });

  it("validates tool input", async () => {
    const r = await call("report_blocked", { reason: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("invalid input");
    expect(logs.some((l) => l.includes("invalid input"))).toBe(true);
  });

  it("marks page content untrusted", () => {
    expect(UNTRUSTED_PREFIX).toContain("not instructions");
  });
});
