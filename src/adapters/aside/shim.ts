/**
 * Node-side half of the page-script shim: validates page scripts, builds the code
 * sent to the Aside `repl` tool, and parses the envelope it prints.
 *
 * Every REPL call is one awaited async IIFE with no top-level declarations, because concurrent
 * calls share one persistent top-level scope (docs/BROWSER.md). A user script becomes the body of an
 * async strict-mode function whose parameters shadow every non-standard REPL global (fs, aside,
 * require, process, exec, memory_search, page, tabs, the Aside skill globals such as gmail/slack,
 * ...) with `undefined`, except the scoped replacements the shim provides: `page`, `args`,
 * `openTab`, `closeTab`, `fetch`, `snapshot`, `sleep`, and a silent `console`.
 */
import type { JsonValue } from "../../ports/json.js";
import type { BlockPattern } from "./hosts.js";
import { blockedUrlPatterns } from "./hosts.js";
import { REPL_RUNTIME_SOURCE } from "./repl-runtime.js";
import type { ScanViolation } from "./script-scan.js";
import { INTERNAL_PREFIX, describeViolations, scanPageScript } from "./script-scan.js";

/** Standard ECMAScript/web globals a page script keeps. Everything else on the REPL global is shadowed. */
export const STANDARD_GLOBALS: readonly string[] = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "InternalError",
  "AggregateError",
  "Array",
  "Object",
  "Iterator",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "Infinity",
  "NaN",
  "undefined",
  "Number",
  "Boolean",
  "String",
  "Math",
  "Symbol",
  "BigInt",
  "Date",
  "RegExp",
  "JSON",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint8Array",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "DataView",
  "Promise",
  "TextEncoder",
  "TextDecoder",
  "btoa",
  "atob",
  "queueMicrotask",
  "URL",
  "URLSearchParams",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "Intl",
];

/** Names that cannot be strict-mode parameters; the static scan rejects them instead. */
export const UNSHADOWABLE = ["eval", "arguments"] as const;

/**
 * Known non-standard REPL globals (observed in Aside CLI 1.26) plus the names the bridge always bans. The REPL-side
 * runtime refuses to run a script when a global outside STANDARD_GLOBALS is not shadowed, and the
 * port then adds it and retries, so a new Aside global can never leak into scripts.
 */
export const KNOWN_REPL_GLOBALS: readonly string[] = [
  "fs",
  "aside",
  "require",
  "process",
  "exec",
  "memory_search",
  "globalThis",
  "global",
  "window",
  "self",
  "Function",
  "Reflect",
  "Proxy",
  "SharedArrayBuffer",
  "WeakRef",
  "FinalizationRegistry",
  "structuredClone",
  "performance",
  "Buffer",
  "__asideBufferModule",
  "__aside",
  "path",
  "pwd",
  "sleep",
  "console",
  "display",
  "tabs",
  "page",
  "getTabByTargetId",
  "fetch",
  "openTab",
  "closeTab",
  "snapshot",
  "annotatedScreenshot",
  "installPageScript",
  "listBrowserTabs",
  "attachBrowserTab",
  "attachActiveBrowserTab",
  "cua",
  "gmail",
  "googleAccounts",
  "googleDocs",
  "googlePeople",
  "googleSearch",
  "googleSheets",
  "imageSearch",
  "imagegen",
  "youtube",
  "linkedin",
  "twitter",
  "notion",
  "slack",
  "blockToMarkdown",
  "markdownToBlockSpecs",
  "applePasswords",
  "captcha",
  "chrome",
];

/** Parameters the shim fills with scoped helpers instead of `undefined`. */
export const PROVIDED_NAMES = [
  "page",
  "args",
  "openTab",
  "closeTab",
  "fetch",
  "snapshot",
  "sleep",
  "console",
] as const;

const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await eval arguments"
  ).split(" "),
);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Builds the parameter list for a page script: provided names, then every shadowed global. */
export function shadowParams(extraGlobals: Iterable<string> = []): string[] {
  const standard = new Set(STANDARD_GLOBALS);
  const out: string[] = [];
  const add = (n: string) => {
    if (!IDENTIFIER.test(n) || RESERVED.has(n) || standard.has(n) || n.startsWith(INTERNAL_PREFIX)) return;
    if (!out.includes(n)) out.push(n);
  };
  PROVIDED_NAMES.forEach(add);
  KNOWN_REPL_GLOBALS.forEach(add);
  for (const n of extraGlobals) add(n);
  return out;
}

export type ScriptCheck = { ok: true } | { ok: false; reason: string; violations: ScanViolation[] };

type AsyncFunctionCtor = new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
const AsyncFunction = (Object.getPrototypeOf(async function () {}) as { constructor: AsyncFunctionCtor })
  .constructor;

/**
 * Static scan plus a compile-only syntax check of the script as a standalone strict async function
 * body with the shim's parameters. Parsing the body on its own guarantees it cannot close the shim's
 * wrapper function early and run code outside the shadowed scope. Nothing is executed here.
 */
export function checkPageScript(script: string, params: readonly string[]): ScriptCheck {
  const violations = scanPageScript(script);
  if (violations.length > 0) {
    return { ok: false, reason: `page script rejected: ${describeViolations(violations)}`, violations };
  }
  try {
    new AsyncFunction(...params, `"use strict";\n${script}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `page script has a syntax error: ${message}`, violations: [] };
  }
  return { ok: true };
}

/** Isolated world the in-page guard runs in; page scripts (main world) cannot see or reset it. */
export function guardWorldName(instanceId: string): string {
  return `bridge_${instanceId}`;
}

/** DOM event the main-world guard uses to report a blocked `window.open` to the isolated world. */
export function guardEventName(instanceId: string): string {
  return `bridge-guard-${instanceId}`;
}

/**
 * REPL global (non-enumerable, unreachable from scripts) holding the target ids of every tab the
 * bridge opened in this REPL context. Shared by all port instances, so one never mistakes another's
 * tab for a popup.
 */
export const TAB_REGISTRY_KEY = `${INTERNAL_PREFIX}Tabs`;

/**
 * CSP added to every bridge tab as a `<meta>` (in addition to any policy the site sends). It
 * restricts every fetch-like channel, frames, workers and subresources to the site's hostnames, so
 * a blocked attempt fires `securitypolicyviolation` and can be recorded. Inline scripts and eval
 * stay allowed so the site keeps working.
 */
export function buildGuardCsp(hostnames: readonly string[]): string {
  const src = hostnames.map((h) => `${h} *.${h}`).join(" ");
  return [
    `connect-src ${src}`,
    `frame-src ${src} blob: data:`,
    `child-src ${src} blob: data:`,
    `worker-src ${src} blob:`,
    `img-src ${src} data: blob:`,
    `media-src ${src} data: blob:`,
    `font-src ${src} data:`,
    `style-src ${src} 'unsafe-inline'`,
    `script-src ${src} 'unsafe-inline' 'unsafe-eval' blob: data:`,
    `manifest-src ${src}`,
    `form-action ${src}`,
    "object-src 'none'",
  ].join("; ");
}

const IN_SCOPE_FN = `(u) => {
    try {
      const x = new URL(String(u), location.href);
      if (x.protocol === "about:" || x.protocol === "blob:" || x.protocol === "data:" || x.protocol === "javascript:") return true;
      if (!["http:", "https:", "ws:", "wss:"].includes(x.protocol)) return false;
      const h = x.hostname.toLowerCase();
      return H.some((a) => h === a || h.endsWith("." + a));
    } catch (e) { return false; }
  }`;

/**
 * Guard for the isolated world of every frame of a bridge tab (init script, runs before the page's
 * scripts). It cancels off-site navigations (Navigation API, link clicks, form submits), installs
 * the CSP meta once the document has a head, and records every blocked attempt (host only) in a
 * store the shim drains after each step via `__bridgeDrain()`. A blocked request counts as the
 * script's when the violation has no source file (code injected through CDP, e.g. page.evaluate);
 * blocks caused by the site's own scripts are recorded as not attributed.
 */
export function buildIsolatedGuard(hostnames: readonly string[], instanceId: string): string {
  return `(() => {
  const H = ${JSON.stringify(hostnames)};
  if (typeof __bridgeDrain === "function") return;
  const inScope = ${IN_SCOPE_FN};
  const store = [];
  const hostOf = (u) => { try { return new URL(String(u), location.href).hostname.toLowerCase() || "an off-site URL"; } catch (e) { return "an invalid URL"; } };
  const record = (kind, url, attributed) => { if (store.length < 100) store.push({ kind: kind, host: hostOf(url), attributed: attributed }); };
  Object.defineProperty(globalThis, "__bridgeDrain", { value: () => store.splice(0, store.length), writable: false, configurable: false });
  try {
    if (window.navigation) window.navigation.addEventListener("navigate", (e) => {
      try { if (!inScope(e.destination.url)) { if (e.cancelable) e.preventDefault(); record("navigation", e.destination.url, true); } } catch (x) {}
    });
  } catch (e) {}
  window.addEventListener("click", (e) => {
    try {
      const t = e.target; const a = t && t.closest ? t.closest("a[href],area[href]") : null;
      if (a && !inScope(a.href)) { e.preventDefault(); e.stopImmediatePropagation(); record("navigation", a.href, true); }
    } catch (x) {}
  }, true);
  window.addEventListener("submit", (e) => {
    try {
      const f = e.target; const s = e.submitter; const act = (s && s.formAction) || (f && f.action) || location.href;
      if (!inScope(act)) { e.preventDefault(); e.stopImmediatePropagation(); record("form", act, true); }
    } catch (x) {}
  }, true);
  // On window (capture): violations target elements, the document, or the window itself (EventSource).
  window.addEventListener("securitypolicyviolation", (e) => {
    try { if (e.disposition === "enforce") record("request", e.blockedURI, !e.sourceFile); } catch (x) {}
  }, true);
  // Reports from the main-world guard: "<kind>|<1 if from injected code>|<url>".
  window.addEventListener(${JSON.stringify(guardEventName(instanceId))}, (e) => {
    try {
      const parts = String(e.detail).split("|");
      const kind = parts[0] === "popup" ? "popup" : "request";
      record(kind, parts.slice(2).join("|"), parts[1] === "1");
    } catch (x) {}
  }, true);
  // Aside's click on a target=_blank link opens the URL in a new tab itself, without DOM events, so
  // off-site link targets are removed: the click then becomes an ordinary (guarded) click.
  const neutralize = (el) => {
    try {
      if (!el || el.nodeType !== 1 || !el.hasAttribute || !el.hasAttribute("target")) return;
      const t = String(el.getAttribute("target") || "").toLowerCase();
      if (t === "" || t === "_self") return;
      const u = el.tagName === "FORM" ? (el.action || location.href) : el.href;
      if (!inScope(u)) el.removeAttribute("target");
    } catch (e) {}
  };
  const sweep = (root) => { try { if (root && root.querySelectorAll) root.querySelectorAll("a[target],area[target],form[target]").forEach(neutralize); } catch (e) {} };
  try {
    new MutationObserver((records) => {
      for (const m of records) {
        if (m.type === "attributes") neutralize(m.target);
        else (m.addedNodes || []).forEach((n) => { neutralize(n); sweep(n); });
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["target", "href", "action"] });
  } catch (e) {}
  const put = () => {
    sweep(document);
    try {
      const m = document.createElement("meta");
      m.httpEquiv = "Content-Security-Policy";
      m.content = ${JSON.stringify(buildGuardCsp(hostnames))};
      (document.head || document.documentElement).prepend(m);
    } catch (e) {}
  };
  // Inserting the meta before the parser has built <head> stalls Aside's page-readiness wait.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", put, { once: true });
  else put();
})();`;
}

/**
 * Guard for the main world of every frame (including about:blank child frames, so
 * `frames[0].open(...)` is covered): `window.open` returns null and reports off-site attempts to the
 * isolated world; service workers and shared workers are unavailable to the page.
 */
export function buildMainWorldGuard(hostnames: readonly string[], instanceId: string): string {
  return `(() => {
  const H = ${JSON.stringify(hostnames)};
  const inScope = ${IN_SCOPE_FN};
  const fire = EventTarget.prototype.dispatchEvent;
  const CE = CustomEvent;
  // Report to the top window when reachable (same-origin child frames such as an appended
  // about:blank iframe), so the top frame's isolated world records it.
  let w = window;
  try { if (window.top && window.top !== window && window.top.document) w = window.top; } catch (e) { w = window; }
  const EV = ${JSON.stringify(guardEventName(instanceId))};
  // Code injected through CDP (page.evaluate) has no URL in its stack; the site's own scripts do.
  const injected = () => {
    try { return !String(new Error().stack || "").split("\\n").slice(1).some((l) => /https?:\\/\\//.test(l)); } catch (e) { return true; }
  };
  const report = (kind, u, attributed) => {
    try {
      if (u === undefined || u === null || String(u) === "" || inScope(u)) return;
      fire.call(w, new CE(EV, { detail: kind + "|" + (attributed ? "1" : "0") + "|" + String(u) }));
    } catch (e) {}
  };
  const blockedOpen = function (u) {
    report("popup", u, true);
    return null;
  };
  try { Object.defineProperty(window, "open", { value: blockedOpen, writable: false, configurable: false }); } catch (e) {}
  // Subresource loads Chrome's request filter blocks before CSP sees them (no violation event):
  // report off-site ones set from script so a page script that tries them fails its step.
  const hookSetter = (name, prop) => {
    try {
      const C = globalThis[name];
      const P = C && C.prototype;
      const d = P && Object.getOwnPropertyDescriptor(P, prop);
      if (!d || !d.set) return;
      const set = d.set;
      Object.defineProperty(P, prop, {
        configurable: false, enumerable: d.enumerable, get: d.get,
        set: function (v) { report("request", v, injected()); return set.call(this, v); },
      });
    } catch (e) {}
  };
  [["HTMLImageElement", "src"], ["HTMLScriptElement", "src"], ["HTMLLinkElement", "href"], ["HTMLMediaElement", "src"],
   ["HTMLSourceElement", "src"], ["HTMLEmbedElement", "src"], ["HTMLObjectElement", "data"], ["HTMLInputElement", "src"],
   ["HTMLVideoElement", "poster"]].forEach((p) => hookSetter(p[0], p[1]));
  try {
    const EP = globalThis.Element && globalThis.Element.prototype;
    const sa = EP && EP.setAttribute;
    if (sa) Object.defineProperty(EP, "setAttribute", {
      value: function (n, v) {
        try {
          const name = String(n).toLowerCase();
          const tag = String((this && this.tagName) || "").toUpperCase();
          if (name === "src" || name === "poster" || name === "data" || (name === "href" && tag === "LINK")) report("request", v, injected());
        } catch (e) {}
        return sa.apply(this, arguments);
      },
      writable: false, configurable: false,
    });
  } catch (e) {}
  try {
    const ES = globalThis.EventSource;
    if (ES) Object.defineProperty(globalThis, "EventSource", {
      value: new Proxy(ES, { construct: (t, a, nt) => { report("request", a[0], injected()); return Reflect.construct(t, a, nt); } }),
      writable: false, configurable: false,
    });
  } catch (e) {}
  try { delete Navigator.prototype.serviceWorker; } catch (e) {}
  try { Object.defineProperty(window, "SharedWorker", { value: undefined, writable: false, configurable: false }); } catch (e) {}
})();`;
}

export interface FetchInitWire {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export type ShimOp =
  | { kind: "probe" }
  | { kind: "open"; url: string; waitUntil?: string | undefined; reuseTargetId?: string | undefined }
  | { kind: "close"; targetId: string }
  | { kind: "snapshot"; targetId: string }
  | { kind: "screenshot"; targetId: string }
  | { kind: "fetch"; url: string; init: FetchInitWire }
  | { kind: "script"; targetId: string | null; script: string; args: JsonValue; params: readonly string[] };

export interface ShimContext {
  /** Random per call; marks the result line. */
  nonce: string;
  hostnames: readonly string[];
  /** In-REPL deadline for the operation (kept under the REPL's 120 s cap). */
  deadlineMs: number;
  /** Epoch ms before which no navigation inside the call may start (politeness). */
  notBefore: number;
  minIntervalMs: number;
  /** Random per port instance: names the guard's isolated world, event, and tab registry. */
  instanceId: string;
}

export const RESULT_MARK = "@@BRB:";

/** The code sent to the `repl` tool: one awaited async IIFE, no top-level declarations. */
export function buildReplCode(op: ShimOp, ctx: ShimContext): string {
  const blockPatterns: BlockPattern[] = blockedUrlPatterns(ctx.hostnames);
  const { script, params, ...opWire } =
    op.kind === "script" ? op : { ...op, script: undefined, params: undefined };
  const env = {
    nonce: ctx.nonce,
    hostnames: ctx.hostnames,
    deadlineMs: ctx.deadlineMs,
    notBefore: ctx.notBefore,
    minIntervalMs: ctx.minIntervalMs,
    blockPatterns,
    isolatedGuard: buildIsolatedGuard(ctx.hostnames, ctx.instanceId),
    mainGuard: buildMainWorldGuard(ctx.hostnames, ctx.instanceId),
    worldName: guardWorldName(ctx.instanceId),
    registryKey: TAB_REGISTRY_KEY,
    allow: STANDARD_GLOBALS,
    unshadowable: UNSHADOWABLE,
    // The bridge's own REPL globals (tab registries); scripts cannot name them (static scan).
    internalPrefix: INTERNAL_PREFIX,
    params: params ?? [],
    op: opWire,
  };
  const userFn =
    script === undefined
      ? "const __brbUser = undefined;"
      : `const __brbUser = async function (${(params ?? []).join(", ")}) {\n"use strict";\n${script}\n};`;
  return [
    "await (async () => {",
    "const __brbConsole = console;",
    `const __brbEnv = ${JSON.stringify(env)};`,
    userFn,
    `const __brbRt = ${REPL_RUNTIME_SOURCE};`,
    "const __brbOut = await __brbRt(__brbEnv, __brbUser);",
    `__brbConsole.log(${JSON.stringify(RESULT_MARK)} + __brbEnv.nonce + "@@" + JSON.stringify(__brbOut));`,
    "})();",
  ].join("\n");
}

export interface ShimViolationRecord {
  kind: string;
  host: string;
}

export type ShimEnvelope =
  | { ok: true; value: unknown; lastLoadAt: number | null; pageBlocked?: string[] }
  | { ok: false; kind: "violation"; violations: ShimViolationRecord[]; lastLoadAt: number | null }
  | { ok: false; kind: "script" | "internal"; message: string; lastLoadAt?: number | null }
  | { ok: false; kind: "timeout"; lastLoadAt?: number | null }
  | { ok: false; kind: "tab_gone" }
  | { ok: false; kind: "globals"; names: string[] };

/** Finds this call's envelope in the REPL output; null when the REPL did not print one. */
export function parseReplOutput(text: string, nonce: string): ShimEnvelope | null {
  const mark = `${RESULT_MARK}${nonce}@@`;
  const at = text.lastIndexOf(mark);
  if (at < 0) return null;
  const rest = text.slice(at + mark.length);
  const nl = rest.indexOf("\n");
  const line = nl < 0 ? rest : rest.slice(0, nl);
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { ok?: unknown }).ok !== "boolean")
      return null;
    return parsed as ShimEnvelope;
  } catch {
    return null;
  }
}
