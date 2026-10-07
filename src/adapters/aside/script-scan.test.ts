import { describe, expect, it } from "vitest";
import { scanPageScript } from "./script-scan.js";

function rules(script: string): string[] {
  return scanPageScript(script).map((v) => `${v.rule}:${v.detail}`);
}

describe("scanPageScript", () => {
  it("accepts an ordinary adapter script", () => {
    const script = `
      await page.goto("https://news.example.com/news?p=" + args.page);
      const rows = await page.evaluate(() => [...document.querySelectorAll("tr.athing")].map((tr) => ({
        id: tr.id, title: tr.querySelector(".titleline a")?.textContent ?? "", href: tr.querySelector(".titleline a")?.href,
      })));
      const m = /item\\?id=(\\d+)/.exec(rows[0].href);
      for (const k of ["a", "b"]) rows[rows.length - 1][k] = m?.[1];
      const r = await fetch("https://news.example.com/item?id=1");
      return { rows, status: r.status, text: (await r.text()).length };
    `;
    expect(scanPageScript(script)).toEqual([]);
  });

  it.each([
    ["fs", "await fs.readFile('x')"],
    ["aside", "return aside.settings"],
    ["require", "const x = require('child_process')"],
    ["process", "return process.env"],
    ["exec", "await exec('ls')"],
    ["memory_search", "return memory_search({ queries: ['x'] })"],
  ])("rejects the shadowed REPL global %s", (name, script) => {
    expect(rules(script)).toContain(`forbidden-identifier:${name}`);
  });

  it("allows those names as property names after a dot (e.g. RegExp#exec)", () => {
    expect(scanPageScript("const m = /a/.exec(s); const p = obj?.process; return x.fs")).toEqual([]);
  });

  it.each(["globalThis", "eval", "Function", "constructor", "Reflect", "__proto__", "getPrototypeOf"])(
    "rejects %s in any position, including as a property name or inside a string",
    (name) => {
      expect(rules(`return x.${name}`)).toContain(`forbidden-identifier:${name}`);
      expect(rules(`return x["${name}"]`)).toContain(`forbidden-identifier:${name}`);
    },
  );

  it("rejects dynamic import", () => {
    expect(rules("const m = await import('node:fs')")).toContain("forbidden-identifier:import");
    expect(rules("const m = await import ('x')")).toContain("forbidden-identifier:import");
  });

  it("catches the globalThis['f'+'s'] trick", () => {
    const found = rules("return globalThis['f' + 's'].readFile('/etc/passwd')");
    expect(found).toContain("forbidden-identifier:globalThis");
    expect(found.some((r) => r.startsWith("computed-key:"))).toBe(true);
  });

  it("rejects member access with a key built from strings, templates, or calls", () => {
    expect(rules("return (async () => {})['constr' + 'uctor']")[0]).toMatch(/^computed-key:/);
    expect(rules("return f[`${a}b`]")[0]).toMatch(/^computed-key:/);
    expect(rules("return f[String.fromCharCode(99, 111)]").some((r) => r.startsWith("computed-key:"))).toBe(
      true,
    );
    expect(rules("return f\n  ['a' + b]")[0]).toMatch(/^computed-key:/);
    expect(rules("return f?.['a' + b]")[0]).toMatch(/^computed-key:/);
  });

  it("allows plain computed access and array literals after keywords", () => {
    expect(scanPageScript("return a[i] + a[i + 1] + a['title'] + a[\"x\"] + a[b[c]] + a[0]")).toEqual([]);
    expect(scanPageScript("for (const k of ['a', 'b']) out.push(k); return ['x' + y]")).toEqual([]);
    expect(scanPageScript("const z = ['a' + b, 'c']; return typeof ['q']")).toEqual([]);
  });

  it("does not treat brackets inside strings, regexes, or comments as member access (CSS selectors)", () => {
    const script = `
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const links = [...document.querySelectorAll("a[href*='item?id=']")].map((a) => a.href);
      const t = \`td[class=\${cls}] > a[href]\`;
      const re = /a[b]c/g; const n = x / y[i];
      // x['a' + 'b'] in a comment
      /* y[f()] */
      return { meta, links, t, re: re.source, n };
    `;
    expect(scanPageScript(script)).toEqual([]);
  });

  it("still rejects constructed keys next to strings and templates", () => {
    expect(rules("const s = 'a[b]'; return x['con' + s]")[0]).toMatch(/^computed-key:/);
    expect(rules('return `${x["a" + b]}`')[0]).toMatch(/^computed-key:/);
    expect(rules("const r = /x/; return y[g(1)]")[0]).toMatch(/^computed-key:/);
  });

  it("decodes unicode and hex escapes before scanning", () => {
    expect(rules("return \\u0066s.readFile('x')")).toContain("forbidden-identifier:fs");
    expect(rules("return x['\\x63onstructor']")).toContain("forbidden-identifier:constructor");
    expect(rules("return x['\\u{63}onstructor']")).toContain("forbidden-identifier:constructor");
  });

  it("rejects references to the bridge's internals and Aside tab attachment", () => {
    expect(rules("return __brbRt")).toContain("forbidden-identifier:__brbRt");
    expect(rules("return page._sendToTarget('Network.setBlockedURLs', {})")).toContain(
      "forbidden-identifier:_sendToTarget",
    );
    expect(rules("return attachActiveBrowserTab()")).toContain("forbidden-identifier:attachActiveBrowserTab");
    expect(rules("return listBrowserTabs()")).toContain("forbidden-identifier:listBrowserTabs");
  });

  it("does not match longer identifiers that merely contain a forbidden name", () => {
    expect(
      scanPageScript(
        "const evaluated = await page.$eval('a', (e) => e.href); const isFunction = 1; return processing",
      ),
    ).toEqual([]);
  });

  it("rejects oversized scripts", () => {
    expect(rules("x".repeat(300_000))).toContain("too-large:300000");
  });
});
