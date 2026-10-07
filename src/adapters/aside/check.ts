/**
 * Real-environment check of the Aside browser port: `npm run browser:check [-- --account u0]`.
 *
 * Requires the Aside app running and the Aside CLI signed in. Opens https://example.com in a bridge
 * tab, prints the title, proves the page-script shim (fs/aside unreachable, cross-host goto,
 * in-page request, in-page navigation and fetch blocked), then closes the tab. Exit code 0 when
 * every expectation holds.
 */
import { randomUUID } from "node:crypto";
import { OutcomeError, errorToOutcome } from "../../core/outcome.js";
import type { Logger } from "../../ports/logger.js";
import { DEFAULT_ASIDE_ACCOUNT } from "./defaults.js";
import { McpReplClient, stdioTransportFactory } from "./mcp-repl-client.js";
import { AsideBrowserPort } from "./port.js";
import { buildReplCode, parseReplOutput, shadowParams } from "./shim.js";

const SITE = "example.com";
const OTHER = "www.iana.org";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const account = argValue("--account") ?? process.env["ASIDE_ACCOUNT"] ?? DEFAULT_ASIDE_ACCOUNT;
const command = process.env["ASIDE_CLI"];

const logger: Logger = {
  debug() {},
  info(message, fields) {
    console.log(`  [log info] ${message} ${JSON.stringify(fields ?? {})}`);
  },
  warn(message, fields) {
    console.log(`  [log warn] ${message} ${JSON.stringify(fields ?? {})}`);
  },
  error(message, fields) {
    console.log(`  [log error] ${message} ${JSON.stringify(fields ?? {})}`);
  },
};

let failures = 0;
function expectThat(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
  if (!ok) failures += 1;
}

async function outcomeOf(
  p: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; status: string; message: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    const o = errorToOutcome(err);
    return { ok: false, status: o.status, message: o.message };
  }
}

async function main(): Promise<void> {
  console.log(`browser:check — Aside account ${account}`);
  const repl = new McpReplClient({
    account,
    transportFactory: stdioTransportFactory(command ? { command } : {}),
    logger,
  });
  const port = new AsideBrowserPort({ repl, logger, warmTabTtlMs: 0 });

  /** Runs code in the raw REPL (no shim) — only for baselines and the final tab check. */
  const rawRepl = async (title: string, code: string): Promise<string> => {
    const r = await repl.call({ title, code, timeoutMs: 60_000 });
    return r.text;
  };
  /** Runs a script through the REPL-side shim only, skipping the static scan, to test that layer alone. */
  const runtimeOnly = async (script: string): Promise<unknown> => {
    const nonce = randomUUID().replace(/-/g, "");
    const code = buildReplCode(
      { kind: "script", targetId: null, script, args: null, params: shadowParams() },
      {
        nonce,
        hostnames: [SITE],
        deadlineMs: 30_000,
        notBefore: 0,
        minIntervalMs: 0,
        instanceId: "check",
      },
    );
    const r = await repl.call({ title: "Bridge check: runtime shim only", code, timeoutMs: 60_000 });
    return parseReplOutput(r.text, nonce);
  };

  try {
    const status = await port.status();
    expectThat(status.reachable, "status", JSON.stringify(status));
    if (!status.reachable) return;

    const session = await port.openSession({ siteKey: "browser-check", hostnames: [SITE] });
    const tab = await session.openTab(`https://${SITE}/`);
    expectThat(new URL(tab.url).hostname === SITE, "openTab", `bridge tab ${tab.id} at ${tab.url}`);

    const title = await session.runScript("return await page.title();", { tab, title: "read title" });
    console.log(`TITLE ${JSON.stringify(title)}`);
    expectThat(title === "Example Domain", "page title", String(title));

    const tree = await session.snapshot(tab);
    expectThat(
      tree.includes(`url=https://${SITE}/`),
      "snapshot",
      `${tree.length} chars (content not printed)`,
    );
    const shot = await session.screenshot(tab);
    expectThat(
      shot.base64.length > 1000,
      "screenshot",
      `${shot.mimeType}, ${Math.round((shot.base64.length * 3) / 4)} bytes`,
    );

    // Layer 2a: static scan rejects the names before anything is sent.
    for (const name of ["fs", "aside"]) {
      const r = await outcomeOf(session.runScript(`return typeof ${name};`, { tab }));
      expectThat(
        !r.ok && r.status === "adapter_error",
        `static scan rejects ${name}`,
        r.ok ? "ran!" : `${r.status}: ${r.message}`,
      );
    }

    // Layer 2b: the REPL-side shim on its own shadows them (baseline: the raw REPL has them).
    const baseline = await rawRepl(
      "Bridge check: raw REPL baseline",
      'console.log("RAW " + typeof fs + " " + typeof aside);',
    );
    console.log(`baseline (raw REPL, no shim): ${baseline.trim()}`);
    const shadowed = await runtimeOnly(
      "return { fs: typeof fs, aside: typeof aside, require: typeof require, process: typeof process, exec: typeof exec, memory_search: typeof memory_search, gmail: typeof gmail, applePasswords: typeof applePasswords, globalThis: typeof globalThis, listBrowserTabs: typeof listBrowserTabs };",
    );
    const values = (shadowed as { ok?: boolean; value?: Record<string, string> } | null)?.value ?? {};
    expectThat(
      (shadowed as { ok?: boolean } | null)?.ok === true &&
        Object.values(values).every((v) => v === "undefined"),
      "runtime shim shadows fs/aside/...",
      JSON.stringify(values),
    );

    // A scan-passing escape attempt: reach the Function constructor through a key built at runtime.
    const escape = await outcomeOf(
      session.runScript(
        'const k = ["con", "struc", "tor"].join(""); const F = (async () => {})[k] || (() => {})[k]; return { ctor: typeof F, gmail: typeof gmail };',
        { tab },
      ),
    );
    expectThat(
      escape.ok && JSON.stringify(escape.value) === JSON.stringify({ ctor: "undefined", gmail: "undefined" }),
      "runtime-built constructor key",
      escape.ok ? JSON.stringify(escape.value) : `${escape.status}: ${escape.message}`,
    );

    // Cross-host page.goto is blocked; the tab stays on the site.
    const gotoCross = await outcomeOf(
      session.runScript(`await page.goto("https://${OTHER}/help/example-domains"); return page.url();`, {
        tab,
      }),
    );
    expectThat(
      !gotoCross.ok && gotoCross.status === "adapter_error",
      "cross-host page.goto",
      gotoCross.ok ? `navigated: ${String(gotoCross.value)}` : `${gotoCross.status}: ${gotoCross.message}`,
    );
    const after = await session.runScript("return page.url();", { tab });
    expectThat(new URL(String(after)).hostname === SITE, "tab still on site", String(after));

    // In-page cross-host request: blocked by the tab's request filter (control: an unfiltered tab gets an opaque response).
    const control = await rawRepl(
      "Bridge check: unfiltered control tab",
      `await (async () => { const t = await openTab("https://${SITE}/"); try { const r = await t.evaluate(async () => { try { const x = await fetch("https://${OTHER}/favicon.ico", { mode: "no-cors" }); return "reached (" + x.type + ")"; } catch (e) { return "blocked: " + e; } }); console.log("CONTROL " + r); } finally { await closeTab(t); } })();`,
    );
    console.log(
      `control (bridge tab without filter): ${control.split("\n").find((l) => l.startsWith("CONTROL")) ?? control.trim()}`,
    );
    /** A step that must fail with adapter_error naming the other host; then read back what happened. */
    const blockedStep = async (
      label: string,
      script: string,
      readBack: string,
      accept: (v: unknown) => boolean,
    ) => {
      const r = await outcomeOf(session.runScript(script, { tab, title: label }));
      expectThat(
        !r.ok && r.status === "adapter_error" && r.message.includes(OTHER),
        `${label} fails the step`,
        r.ok ? `succeeded: ${JSON.stringify(r.value)}` : `${r.status}: ${r.message}`,
      );
      const after = await session.runScript(readBack, { tab, title: `${label} (read back)` });
      expectThat(accept(after), `${label} was blocked`, JSON.stringify(after));
    };

    await blockedStep(
      "in-page cross-host request",
      `await page.evaluate(async () => {
         const out = {};
         try { out.sameHost = (await fetch("/")).status; } catch (e) { out.sameHost = "blocked: " + e; }
         try { const x = await fetch("https://${OTHER}/favicon.ico", { mode: "no-cors" }); out.crossHost = "reached (" + x.type + ")"; } catch (e) { out.crossHost = "blocked: " + e; }
         window.__chk = out;
       });
       return 1;`,
      "return await page.evaluate(() => window.__chk);",
      (v) => {
        const o = v as { sameHost?: unknown; crossHost?: unknown } | null;
        return o?.sameHost === 200 && String(o.crossHost).startsWith("blocked");
      },
    );
    await blockedStep(
      "in-page cross-host navigation",
      `await page.evaluate(() => { location.href = "https://${OTHER}/"; }); await sleep(2000); return page.url();`,
      "return page.url();",
      (v) => new URL(String(v)).hostname === SITE,
    );
    await blockedStep(
      "iframe src to another host",
      `await page.evaluate(() => { const f = document.createElement("iframe"); f.id = "chkframe"; f.src = "https://${OTHER}/"; document.body.appendChild(f); });
       await sleep(2000); return 1;`,
      "return page.frames().map((f) => f.url());",
      (v) => Array.isArray(v) && !v.some((u) => String(u).includes(OTHER)),
    );
    await blockedStep(
      "new WebSocket to another host",
      `await page.evaluate(async () => {
         window.__ws = "pending";
         try {
           const ws = new WebSocket("wss://${OTHER}/socket");
           await new Promise((r) => { ws.onopen = () => { window.__ws = "open"; r(); }; ws.onerror = () => { window.__ws = "error"; r(); }; setTimeout(r, 2000); });
         } catch (e) { window.__ws = "threw: " + e; }
       });
       return 1;`,
      "return await page.evaluate(() => window.__ws);",
      (v) => v !== "open",
    );
    await blockedStep(
      "image and EventSource to another host",
      `await page.evaluate(async () => {
         window.__img = "pending";
         const i = new Image();
         i.onload = () => { window.__img = "loaded"; };
         i.onerror = () => { window.__img = "error"; };
         i.src = "https://${OTHER}/favicon.ico?img=1";
         try { new EventSource("https://${OTHER}/events"); } catch (e) {}
         await new Promise((r) => setTimeout(r, 1500));
       });
       return 1;`,
      "return await page.evaluate(() => window.__img);",
      (v) => v !== "loaded",
    );
    await blockedStep(
      "frames[0].open popup (with a user gesture)",
      `await page.evaluate(() => {
         const b = document.createElement("button"); b.id = "chkpop"; b.textContent = "popup";
         b.onclick = () => {
           const f = document.createElement("iframe"); document.body.appendChild(f);
           window.__op = String(frames[frames.length - 1].open("https://${OTHER}/?popup=chk1"));
         };
         document.body.appendChild(b);
       });
       await page.locator("#chkpop").click();
       await sleep(1500);
       return 1;`,
      "return await page.evaluate(() => window.__op);",
      (v) => v === "null",
    );
    await blockedStep(
      "target=_blank link to another host",
      `await page.evaluate(() => {
         const a = document.createElement("a"); a.id = "chklink"; a.textContent = "link"; a.target = "_blank";
         a.href = "https://${OTHER}/?popup=chk2"; document.body.appendChild(a);
       });
       await page.locator("#chklink").click();
       await sleep(1500);
       return 1;`,
      "return page.url();",
      (v) => new URL(String(v)).hostname === SITE,
    );
    // A same-site popup is allowed to load but the bridge closes it (tab hygiene; never left open).
    const sameSitePopup = await outcomeOf(
      session.runScript(
        `await page.evaluate(() => {
           const a = document.createElement("a"); a.id = "chklink2"; a.textContent = "same"; a.target = "_blank";
           a.href = "https://${SITE}/?popup=chk3"; document.body.appendChild(a);
         });
         await page.locator("#chklink2").click();
         await sleep(2000);
         return 1;`,
        { tab, title: "same-site popup" },
      ),
    );
    expectThat(
      sameSitePopup.ok,
      "same-site popup step",
      sameSitePopup.ok ? "ok" : `${sameSitePopup.status}: ${sameSitePopup.message}`,
    );
    await session.runScript("await sleep(1000); return 1;", { tab, title: "sweep" });
    const leftovers = await rawRepl(
      "Bridge check: leftover popups?",
      `await (async () => { const p = await getTabByTargetId(${JSON.stringify(tab.id)}); const tg = await p._sendToTarget("Target.getTargets", {}); console.log("LEFT " + tg.targetInfos.filter((x) => x.url.includes("popup=chk")).length); })();`,
    );
    const leftLine = leftovers.split("\n").find((l) => l.startsWith("LEFT ")) ?? leftovers.trim();
    expectThat(leftLine === "LEFT 0", "no popup left open", leftLine);

    // Script fetch (cookie-bearing REPL fetch) to another host: blocked even if the script catches it.
    const scriptFetch = await outcomeOf(
      session.runScript(`try { await fetch("https://${OTHER}/"); } catch (e) {} return "sent";`, { tab }),
    );
    expectThat(
      !scriptFetch.ok && scriptFetch.status === "adapter_error",
      "script fetch cross-host",
      scriptFetch.ok ? "sent!" : `${scriptFetch.status}: ${scriptFetch.message}`,
    );
    const sameFetch = await session.fetch(`https://${SITE}/`);
    expectThat(
      sameFetch.status === 200 && !("set-cookie" in sameFetch.headers),
      "cookie fetch same host",
      `status ${sameFetch.status}, ${sameFetch.text.length} chars`,
    );
    const crossFetch = await outcomeOf(session.fetch(`https://${OTHER}/`));
    expectThat(
      !crossFetch.ok && crossFetch.status === "adapter_error",
      "cookie fetch cross host",
      crossFetch.ok ? "sent!" : `${crossFetch.status}: ${crossFetch.message}`,
    );

    // Two sites in parallel over the one `aside mcp` child (concurrent repl calls, no shared globals).
    const other = await port.openSession({ siteKey: "browser-check-2", hostnames: [OTHER] });
    const [titleA, titleB] = await Promise.all([
      session.runScript("await sleep(500); return await page.title();", { tab }),
      (async () => {
        const t2 = await other.openTab(`https://${OTHER}/help/example-domains`);
        return other.runScript("return await page.title();", { tab: t2 });
      })(),
    ]);
    expectThat(
      titleA === "Example Domain" && typeof titleB === "string" && titleB !== "",
      "two sites concurrently",
      `${JSON.stringify(titleA)} | ${JSON.stringify(titleB)}`,
    );
    await other.dispose();

    await session.dispose();
    const gone = await rawRepl(
      "Bridge check: tab closed?",
      `console.log("TAB " + String(await getTabByTargetId(${JSON.stringify(tab.id)})));`,
    );
    const goneLine = gone.split("\n").find((l) => l.startsWith("TAB ")) ?? gone.trim();
    expectThat(goneLine === "TAB undefined", "tab closed on dispose", goneLine);
  } catch (err) {
    const o =
      err instanceof OutcomeError
        ? { status: err.status, message: err.message, action: err.action }
        : errorToOutcome(err);
    console.log(`FAIL  unexpected error: ${JSON.stringify(o)}`);
    failures += 1;
  } finally {
    await port.shutdown();
  }
}

await main();
console.log(failures === 0 ? "browser:check OK" : `browser:check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
