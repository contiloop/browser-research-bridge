/**
 * Page-script builder (see docs/BROWSER.md). `ctx.browser.runScript(script)` runs the
 * script as the body of an async function in the Aside REPL realm (not in the page): `page`, `args`,
 * `openTab`, `closeTab`, `fetch`, `snapshot`, `sleep` are in scope, and DOM work happens inside
 * `page.evaluate(() => …)`. All REPL calls share one top-level scope, so a script must not leave
 * declarations behind; `pageScript` wraps the body in its own async IIFE so it never does, whatever
 * the port does around it.
 *
 * Interpolated values are embedded as JSON literals, so data (selectors, ids, URLs) cannot change
 * the script's structure:
 *
 *     const script = pageScript`
 *       return await page.evaluate(() => {
 *         const el = document.querySelector(${selector});
 *         return el ? el.textContent : null;
 *       });`;
 *
 * Literals are the way to get data into `page.evaluate` callbacks, which run in the page and cannot
 * see REPL-side variables such as `args`. The port statically scans every script and rejects names
 * such as `globalThis`, `eval`, `Function`, `constructor`, `import` (even inside strings) and
 * computed member keys built at runtime; see docs/BROWSER.md.
 */
import type { JsonValue } from "../ports/json.js";

/** `value` as a JavaScript literal (JSON, with U+2028/U+2029 escaped). */
export function jsLiteral(value: JsonValue): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("pageScript: value is not JSON-serializable");
  return json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Wraps a script body in an async IIFE: no top-level declarations reach the shared REPL scope. */
export function wrapPageScript(body: string): string {
  return `return await (async () => {\n${body.trim()}\n})();`;
}

/** Tagged template: the body with every `${value}` as a JSON literal, wrapped by {@link wrapPageScript}. */
export function pageScript(strings: TemplateStringsArray, ...values: JsonValue[]): string {
  let body = strings[0] ?? "";
  values.forEach((value, i) => {
    body += jsLiteral(value) + (strings[i + 1] ?? "");
  });
  return wrapPageScript(body);
}
