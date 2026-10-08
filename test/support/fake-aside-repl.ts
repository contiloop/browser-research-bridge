/**
 * Test double for the Aside REPL: runs the code the port generates in a `node:vm` context whose
 * globals mimic the REPL (openTab/closeTab/getTabByTargetId/fetch/snapshot/sleep plus capability
 * globals such as fs/aside/gmail that must stay unreachable). Pages are fakes that record CDP calls,
 * navigations and requests; `page.evaluate` runs the function in a separate "page world" whose
 * `fetch` honors the tab's `Network.setBlockedURLs` patterns, like Chrome does.
 *
 * Captcha support: the REPL's `captcha` global (a `CaptchaSolver` with non-enumerable `click`,
 * `drag`, `readText`) records every call and runs configurable handlers; `new FakeAsideRepl({ captcha:
 * false })` mimics an older Aside without it, and the default `readText` throws "No visual model
 * configured" like Aside without a vision model. Pages can carry a small DOM (`repl.documents`, keyed by
 * URL, loaded on navigation): subresources whose `src` the tab's request filter or guard CSP blocks are
 * dropped at load time, as in Chrome, and `Runtime.evaluate` in a non-guard isolated world runs against it.
 *
 * Only the REPL is faked; the shim code under test is the real generated code.
 */
import vm from "node:vm";
import { OutcomeError } from "../../src/core/outcome.js";
import type { ReplCallRequest, ReplCallResult, ReplClient } from "../../src/adapters/aside/repl-client.js";

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface BlockPattern {
  urlPattern: string;
  block: boolean;
}

export const SECRET = "SECRET-CAPABILITY";

export interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One element of a fake page's DOM fixture. */
export interface FakeNodeSpec {
  tag: string;
  attrs?: Record<string, string>;
  /** Viewport rectangle; zero when omitted. */
  rect?: FakeRect;
  style?: { display?: string; visibility?: string; opacity?: string };
  value?: string;
  text?: string;
  children?: FakeNodeSpec[];
}

export interface FakeDocumentSpec {
  title?: string;
  body: FakeNodeSpec[];
  viewport?: { width: number; height: number };
}

const ATTR_SELECTOR = /^\s*([A-Za-z_][\w-]*)\s*(?:([*^$~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]]+)))?\s*$/;

interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: Array<{ name: string; op: string | null; value: string }>;
}

/** Parses a selector list of compound selectors (tag, #id, .class, [attr op value]); no combinators. */
function parseSelector(selector: string): Compound[] {
  return selector.split(",").map((part) => {
    const s = part.trim();
    const m = /^(\*|[A-Za-z][A-Za-z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/.exec(s);
    if (!m || s === "") throw new Error(`fake DOM: unsupported selector ${JSON.stringify(selector)}`);
    const out: Compound = {
      tag: m[1] && m[1] !== "*" ? m[1].toUpperCase() : null,
      ids: [],
      classes: [],
      attrs: [],
    };
    for (const t of (m[2] ?? "").matchAll(/#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g)) {
      if (t[1] !== undefined) out.ids.push(t[1]);
      else if (t[2] !== undefined) out.classes.push(t[2]);
      else {
        const a = ATTR_SELECTOR.exec(t[3] ?? "");
        if (!a) throw new Error(`fake DOM: unsupported attribute selector in ${JSON.stringify(selector)}`);
        out.attrs.push({ name: a[1]!.toLowerCase(), op: a[2] ?? null, value: a[3] ?? a[4] ?? a[5] ?? "" });
      }
    }
    return out;
  });
}

export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly events: string[] = [];
  clicks = 0;
  private val: string;
  private readonly ownText: string;
  private readonly box: FakeRect;
  private readonly style: { display?: string; visibility?: string; opacity?: string };

  constructor(
    readonly dom: FakeDom,
    spec: FakeNodeSpec,
  ) {
    this.tagName = spec.tag.toUpperCase();
    for (const [k, v] of Object.entries(spec.attrs ?? {})) this.attributes.set(k.toLowerCase(), v);
    this.box = spec.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    this.style = spec.style ?? {};
    this.val = spec.value ?? "";
    this.ownText = spec.text ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(String(name).toLowerCase());
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  get type(): string {
    const t = (this.getAttribute("type") ?? "").toLowerCase();
    if (this.tagName === "BUTTON") return t === "" ? "submit" : t;
    if (this.tagName === "INPUT") return t === "" ? "text" : t;
    return t;
  }
  get name(): string {
    return this.getAttribute("name") ?? "";
  }
  get src(): string {
    const s = this.getAttribute("src");
    if (s === null) return "";
    try {
      return new URL(s, this.dom.url).href;
    } catch {
      return s;
    }
  }
  get value(): string {
    return this.val;
  }
  set value(v: string) {
    this.val = String(v);
  }
  get form(): FakeElement | null {
    return this.closest("form");
  }
  get textContent(): string {
    return [this.ownText, ...this.children.map((c) => c.textContent)].filter((t) => t !== "").join(" ");
  }
  get innerText(): string {
    return this.textContent;
  }

  /** Inherited `visibility`, `display: none` from any ancestor, own `opacity`. */
  computedStyle(): { display: string; visibility: string; opacity: string } {
    const chain = this.selfAndAncestors();
    const display = chain.some((e) => e.style.display === "none") ? "none" : (this.style.display ?? "block");
    const visibility = chain.find((e) => e.style.visibility !== undefined)?.style.visibility ?? "visible";
    return { display, visibility, opacity: this.style.opacity ?? "1" };
  }

  private selfAndAncestors(): FakeElement[] {
    const out: FakeElement[] = [this];
    for (let e = this.parentElement; e; e = e.parentElement) out.push(e);
    return out;
  }

  getBoundingClientRect() {
    const hidden = this.computedStyle().display === "none";
    const r = hidden ? { x: 0, y: 0, width: 0, height: 0 } : this.box;
    return {
      x: r.x,
      y: r.y,
      left: r.x,
      top: r.y,
      width: r.width,
      height: r.height,
      right: r.x + r.width,
      bottom: r.y + r.height,
    };
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some((c) => this.matchesCompound(c));
  }

  private matchesCompound(c: Compound): boolean {
    if (c.tag !== null && c.tag !== this.tagName) return false;
    if (c.ids.some((i) => i !== this.id)) return false;
    const classes = this.className.split(/\s+/).filter((x) => x !== "");
    if (c.classes.some((k) => !classes.includes(k))) return false;
    return c.attrs.every((a) => {
      const v = this.getAttribute(a.name);
      if (v === null) return false;
      switch (a.op) {
        case null:
          return true;
        case "=":
          return v === a.value;
        case "*=":
          return v.includes(a.value);
        case "^=":
          return v.startsWith(a.value);
        case "$=":
          return v.endsWith(a.value);
        case "~=":
          return v.split(/\s+/).includes(a.value);
        default:
          return false;
      }
    });
  }

  closest(selector: string): FakeElement | null {
    return this.selfAndAncestors().find((e) => e.matches(selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement) => {
      for (const c of e.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  scrollIntoView(): void {
    this.events.push("scrollIntoView");
  }
  focus(): void {
    this.events.push("focus");
  }
  dispatchEvent(e: { type: string }): boolean {
    this.events.push(e.type);
    return true;
  }

  private isSubmitControl(): boolean {
    return (this.tagName === "BUTTON" || this.tagName === "INPUT") && ["submit", "image"].includes(this.type);
  }

  click(): void {
    this.clicks += 1;
    const form = this.form;
    if (form && this.isSubmitControl()) this.dom.submit(form);
  }

  requestSubmit(): void {
    if (this.tagName === "FORM") this.dom.submit(this);
  }
}

/** A tiny DOM built from a fixture; `canLoad` decides whether an element with a `src` survives the load. */
export class FakeDom {
  readonly title: string;
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly viewport: { width: number; height: number };
  readonly submissions: Array<Record<string, string>> = [];
  onSubmit: (() => void) | undefined;

  constructor(
    spec: FakeDocumentSpec,
    readonly url: string,
    canLoad: (src: string, tag: string) => boolean = () => true,
  ) {
    this.title = spec.title ?? "";
    this.viewport = spec.viewport ?? { width: 1280, height: 800 };
    this.documentElement = new FakeElement(this, { tag: "html" });
    this.body = new FakeElement(this, { tag: "body", rect: { x: 0, y: 0, ...this.viewport } });
    this.body.parentElement = this.documentElement;
    this.documentElement.children.push(this.body);
    const build = (parent: FakeElement, specs: readonly FakeNodeSpec[]) => {
      for (const s of specs) {
        const src = s.attrs?.["src"];
        if (
          src !== undefined &&
          /^https?:/i.test(new URL(src, url).protocol) &&
          !canLoad(new URL(src, url).href, s.tag)
        )
          continue; // blocked by the request filter or the guard CSP: never loaded
        const el = new FakeElement(this, s);
        el.parentElement = parent;
        parent.children.push(el);
        build(el, s.children ?? []);
      }
    };
    build(this.body, spec.body);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  submit(form: FakeElement): void {
    const values: Record<string, string> = {};
    for (const i of form.querySelectorAll("input")) if (i.name !== "") values[i.name] = i.value;
    this.submissions.push(values);
    this.onSubmit?.();
  }

  /** Runs `expression` in an isolated-world-like context over this DOM. */
  evaluate(expression: string): unknown {
    const document = {
      title: this.title,
      body: this.body,
      documentElement: this.documentElement,
      querySelectorAll: (s: string) => this.querySelectorAll(s),
      querySelector: (s: string) => this.querySelector(s),
    };
    const window: Record<string, unknown> = {
      innerWidth: this.viewport.width,
      innerHeight: this.viewport.height,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: (el: FakeElement) => el.computedStyle(),
    };
    class Event {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    }
    const world = vm.createContext({
      document,
      window,
      getComputedStyle: window["getComputedStyle"],
      innerWidth: this.viewport.width,
      innerHeight: this.viewport.height,
      scrollX: 0,
      scrollY: 0,
      Event,
      URL,
      location: { href: this.url },
    });
    window["window"] = window;
    window["document"] = document;
    return vm.runInContext(expression, world);
  }
}

/** Extracts the guard CSP an isolated-world init script would install (`m.content = "...";`). */
function cspOf(source: string): string | null {
  const m = /m\.content = ("(?:[^"\\]|\\.)*");/.exec(source);
  return m ? (JSON.parse(m[1]!) as string) : null;
}

/** Whether `url` matches a host source list such as `example.com *.example.com www.google.com/recaptcha/`. */
function cspSourceAllows(sources: string[], url: URL): boolean {
  return sources.some((s) => {
    const slash = s.indexOf("/");
    const hostPart = slash < 0 ? s : s.slice(0, slash);
    const path = slash < 0 ? "" : s.slice(slash);
    if (hostPart.includes(":")) return false; // blob:, data:, 'self' etc. are not host sources here
    const host = url.hostname.toLowerCase();
    const hostOk = hostPart.startsWith("*.") ? host.endsWith(hostPart.slice(1)) : host === hostPart;
    return hostOk && url.pathname.startsWith(path);
  });
}

export interface FakeCaptchaCall {
  method: "click" | "drag" | "readText";
  targetId: string;
  args: unknown[];
  /** The tab's request filter and guard CSP at the time of the call. */
  blockPatterns: BlockPattern[];
  guardCsp: string | null;
}

export interface FakeCaptchaHandlers {
  click?: (page: FakePage, bounds: FakeRect) => void | Promise<void>;
  drag?: (
    page: FakePage,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => void | Promise<void>;
  /** Default: throws like Aside without a configured vision model. */
  readText?: (page: FakePage, bounds: FakeRect | undefined) => string | null | Promise<string | null>;
}

export const NO_VISION_MODEL_ERROR =
  'No visual model configured. Choose a model for "visual" in Aside settings to read captcha text.';

/** Isolated worlds whose name starts with this run against the page's fake DOM (the solver's world). */
const SOLVER_WORLD_CONTEXT = 9;

export class FakePage {
  blockPatterns: BlockPattern[] = [];
  readonly initScripts: Array<{ source: string; worldName: string | undefined; identifier: string }> = [];
  readonly removedScripts: string[] = [];
  /** Makes `Page.removeScriptToEvaluateOnNewDocument` fail (an Aside/Chrome that cannot remove it). */
  failScriptRemoval = false;
  /** The loaded document of a URL with a fixture in `repl.documents` (null: an empty document). */
  dom: FakeDom | null = null;
  readonly navigations: string[] = [];
  /**
   * Emulates the isolated-world guard store: blocked in-page attempts the real guard records
   * (CSP violation from injected code → attributed; from the page's own scripts → not attributed).
   */
  readonly guardStore: Array<{ kind: string; host: string; attributed: boolean }> = [];
  /** Store of a same-origin child frame (e.g. an about:blank iframe a script appended). */
  childFrameStore: Array<{ kind: string; host: string; attributed: boolean }> | null = null;
  bypassServiceWorker = false;
  // Internals a real Aside page exposes and the membrane must hide.
  readonly cdp = { secret: SECRET };
  readonly browser = { secret: SECRET };
  readonly frameManager = { secret: SECRET };
  readonly events = { secret: SECRET };
  private currentUrl: string;

  constructor(
    private readonly repl: FakeAsideRepl,
    readonly targetId: string,
    url: string,
  ) {
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.repl.titles.get(this.currentUrl) ?? "Untitled";
  }

  async goto(url: string): Promise<null> {
    this.navigations.push(url);
    this.repl.loads.push({ targetId: this.targetId, url, at: Date.now() });
    this.currentUrl = this.repl.redirects.get(url) ?? url;
    this.load();
    return null;
  }

  async reload(): Promise<null> {
    this.navigations.push(this.currentUrl);
    this.load();
    return null;
  }

  /** Replaces the current document (e.g. what the page shows after a captcha action). */
  show(spec: FakeDocumentSpec | null): void {
    this.dom = spec ? new FakeDom(spec, this.currentUrl, (src, tag) => this.canLoad(src, tag)) : null;
    if (this.dom) this.dom.onSubmit = () => this.repl.onFormSubmit?.(this);
  }

  private load(): void {
    this.show(this.repl.documents.get(this.currentUrl) ?? null);
  }

  /** The guard CSP of the active isolated-world init script, if any. */
  guardCsp(): string | null {
    const guard = [...this.initScripts].reverse().find((s) => s.worldName !== undefined);
    return guard ? cspOf(guard.source) : null;
  }

  /** Chrome would load `src` only when the request filter and the guard's CSP both allow it. */
  canLoad(src: string, tag: string): boolean {
    if (this.isBlocked(src)) return false;
    const csp = this.guardCsp();
    if (csp === null) return true;
    const directive =
      tag.toLowerCase() === "iframe"
        ? "frame-src"
        : tag.toLowerCase() === "script"
          ? "script-src"
          : "img-src";
    const d = csp
      .split(";")
      .map((x) => x.trim().split(/\s+/))
      .find((parts) => parts[0] === directive);
    return d ? cspSourceAllows(d.slice(1), new URL(src)) : true;
  }

  async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
    const guarded = this.initScripts.length > 0;
    const blocked = (kind: string, abs: string) => {
      if (guarded) this.guardStore.push({ kind, host: new URL(abs).hostname, attributed: true });
    };
    const getUrl = () => this.currentUrl;
    const navigate = (u: string) => {
      const abs = new URL(u, this.currentUrl).href;
      if (this.isBlocked(abs)) blocked("navigation", abs);
      else this.currentUrl = abs;
    };
    const location = Object.defineProperty({}, "href", { get: getUrl, set: navigate, enumerable: true });
    const isBlocked = (u: string) => this.isBlocked(u);
    const pageRequest = (u: string) => this.repl.pageRequests.push(u);
    const world = vm.createContext({
      URL,
      location,
      document: { title: this.repl.titles.get(this.currentUrl) ?? "Untitled" },
      fetch: async (u: string) => {
        const abs = new URL(u, this.currentUrl).href;
        if (this.isBlocked(abs)) {
          blocked("request", abs);
          throw new TypeError("Failed to fetch");
        }
        pageRequest(abs);
        return { status: 200, ok: true };
      },
      WebSocket: function (u: string) {
        const abs = new URL(u).href;
        if (isBlocked(abs.replace(/^ws/, "http"))) blocked("request", abs);
        else pageRequest(abs);
      },
      open: (u: string) => {
        // The main-world guard disables window.open and reports off-site attempts.
        const abs = new URL(u, this.currentUrl).href;
        if (guarded && this.isBlocked(abs))
          this.guardStore.push({ kind: "popup", host: new URL(abs).hostname, attributed: true });
        return null;
      },
    });
    const source = typeof fn === "function" ? `(${String(fn)})` : `(() => (${String(fn)}))`;
    const f = vm.runInContext(source, world) as (a: unknown) => unknown;
    const out = await f(arg);
    return out === undefined ? undefined : (JSON.parse(JSON.stringify(out)) as unknown);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  async _sendToTarget(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.repl.cdpLog.push({ targetId: this.targetId, method });
    switch (method) {
      case "Network.setBlockedURLs":
        this.blockPatterns = params["urlPatterns"] as BlockPattern[];
        return {};
      case "Network.setBypassServiceWorker":
        this.bypassServiceWorker = params["bypass"] === true;
        return {};
      case "Page.addScriptToEvaluateOnNewDocument": {
        const identifier = String(this.repl.nextScriptId++);
        this.initScripts.push({
          source: String(params["source"]),
          worldName: typeof params["worldName"] === "string" ? params["worldName"] : undefined,
          identifier,
        });
        return { identifier };
      }
      case "Page.removeScriptToEvaluateOnNewDocument": {
        if (this.failScriptRemoval) throw new Error("Script not found");
        const id = String(params["identifier"]);
        const i = this.initScripts.findIndex((s) => s.identifier === id);
        if (i >= 0) this.initScripts.splice(i, 1);
        this.removedScripts.push(id);
        return {};
      }
      case "Page.getFrameTree": {
        const children = this.childFrameStore ? [{ frame: { id: `${this.targetId}-child` } }] : [];
        return { frameTree: { frame: { id: this.targetId }, childFrames: children } };
      }
      case "Page.createIsolatedWorld":
        if (String(params["worldName"]).startsWith("solver_")) {
          if (params["frameId"] !== this.targetId)
            throw new Error("test failure: solver world in a child frame");
          return { executionContextId: SOLVER_WORLD_CONTEXT };
        }
        return { executionContextId: params["frameId"] === this.targetId ? 7 : 8 };
      case "Runtime.evaluate": {
        const expr = String(params["expression"]);
        if (params["contextId"] === SOLVER_WORLD_CONTEXT) {
          const dom = this.dom ?? new FakeDom({ body: [] }, this.currentUrl);
          try {
            const value = await Promise.resolve(dom.evaluate(expr));
            return {
              result: {
                type: typeof value,
                value: value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown),
              },
            };
          } catch (err) {
            return { exceptionDetails: { text: err instanceof Error ? err.message : String(err) } };
          }
        }
        const guarded = this.initScripts.some((i) => i.worldName !== undefined);
        if (!guarded || !expr.includes("__bridgeDrain")) return { result: { type: "undefined" } };
        if (params["contextId"] === 7)
          return { result: { type: "object", value: this.guardStore.splice(0) } };
        if (params["contextId"] === 8 && this.childFrameStore) {
          return { result: { type: "object", value: this.childFrameStore.splice(0) } };
        }
        return { result: { type: "undefined" } };
      }
      case "Target.getTargets":
        return { targetInfos: this.repl.targets.map((t) => ({ ...t })) };
      case "Target.closeTarget": {
        const id = String(params["targetId"]);
        if (id === "USER-TAB") throw new Error("test failure: closed the user's tab");
        this.repl.pages.delete(id);
        const i = this.repl.targets.findIndex((t) => t.targetId === id);
        if (i >= 0) this.repl.targets.splice(i, 1);
        this.repl.closedTargets.push(id);
        return { success: i >= 0 };
      }
      default:
        return {};
    }
  }

  context(): unknown {
    return { secret: SECRET };
  }

  isBlocked(url: string): boolean {
    for (const p of this.blockPatterns) {
      if (new URLPattern(p.urlPattern).test(url)) return p.block;
    }
    return false;
  }
}

export class FakeAsideRepl implements ReplClient {
  readonly account = "u0";
  gen = 1;
  readonly pages = new Map<string, FakePage>();
  readonly closedTabs: string[] = [];
  readonly fetchLog: Array<{ url: string; method: string; redirect: string | undefined }> = [];
  readonly pageRequests: string[] = [];
  readonly cdpLog: Array<{ targetId: string; method: string }> = [];
  readonly calls: ReplCallRequest[] = [];
  /** Every page load (`goto`) of any tab, with its time (politeness tests). */
  readonly loads: Array<{ targetId: string; url: string; at: number }> = [];
  readonly responses = new Map<string, FakeResponse>();
  readonly redirects = new Map<string, string>();
  readonly titles = new Map<string, string>();
  /** Browser targets as `Target.getTargets` reports them (the user's tabs included). */
  readonly targets: Array<{ targetId: string; type: string; url: string; openerId?: string }> = [];
  readonly closedTargets: string[] = [];
  /** The REPL session's `tabs` global (Aside also attaches popups of session tabs here). */
  readonly replTabs: FakePage[] = [];
  /** A tab the user has open; the bridge must never touch it. */
  readonly userTab: FakePage;
  readonly context: vm.Context;
  /** DOM fixtures by URL, loaded into a tab when it navigates there. */
  readonly documents = new Map<string, FakeDocumentSpec>();
  /** Called after a form of a fake DOM was submitted (e.g. to show the next page). */
  onFormSubmit: ((page: FakePage) => void) | undefined;
  /** Every call of the REPL's `captcha` global. */
  readonly captchaCalls: FakeCaptchaCall[] = [];
  readonly captchaHandlers: FakeCaptchaHandlers = {};
  nextScriptId = 1;
  closed = false;
  private nextId = 1;
  private output: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  /** `captcha: false` mimics an Aside version without the `captcha` capability. */
  constructor(options: { captcha?: boolean } = {}) {
    this.userTab = new FakePage(this, "USER-TAB", "https://mail.example.org/inbox");
    this.targets.push({ targetId: "USER-TAB", type: "page", url: "https://mail.example.org/inbox" });
    const sentinel = { secret: SECRET, readFile: async () => SECRET };
    const capability: Record<string, unknown> = {};
    if (options.captcha !== false) {
      // Like Aside's CaptchaSolver: methods exist but are not enumerable.
      Object.defineProperties(capability, {
        click: { value: this.captchaMethod("click"), enumerable: false },
        drag: { value: this.captchaMethod("drag"), enumerable: false },
        readText: { value: this.captchaMethod("readText"), enumerable: false },
      });
    }
    this.context = vm.createContext({
      ...(options.captcha !== false ? { captcha: capability } : {}),
      console: { log: (...a: unknown[]) => this.output.push(a.map(String).join(" ")) },
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      atob,
      btoa,
      Buffer,
      structuredClone,
      performance: { now: () => 0 },
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      fs: sentinel,
      aside: sentinel,
      gmail: sentinel,
      applePasswords: sentinel,
      tabs: this.replTabs,
      page: this.userTab,
      listBrowserTabs: async () => [{ targetId: "USER-TAB" }],
      attachBrowserTab: async () => this.userTab,
      attachActiveBrowserTab: async () => this.userTab,
      openTab: async (url: string) => {
        const p = new FakePage(this, `T${this.nextId++}`, url);
        this.pages.set(p.targetId, p);
        this.replTabs.push(p);
        return p;
      },
      closeTab: async (p: FakePage) => {
        if (p === this.userTab) throw new Error("test failure: closed the user's tab");
        this.pages.delete(p.targetId);
        this.closedTabs.push(p.targetId);
        const i = this.replTabs.indexOf(p);
        if (i >= 0) this.replTabs.splice(i, 1);
        const j = this.targets.findIndex((t) => t.targetId === p.targetId);
        if (j >= 0) this.targets.splice(j, 1);
      },
      getTabByTargetId: async (id: string) => this.pages.get(id),
      fetch: async (url: string, init: { method?: string; redirect?: string } = {}) => {
        this.fetchLog.push({ url, method: init.method ?? "GET", redirect: init.redirect });
        const r = this.responses.get(url) ?? { status: 404, body: "not found" };
        const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        return {
          status: r.status,
          url,
          headers: {
            get: (n: string) => headers.get(n.toLowerCase()) ?? null,
            forEach: (cb: (v: string, k: string) => void) => headers.forEach((v, k) => cb(v, k)),
          },
          text: async () => r.body ?? "",
        };
      },
      snapshot: async (p: FakePage) => ({
        tree: `- title: "${await p.title()}" [url=${p.url()}]`,
        diff: "",
        refs: {},
      }),
      annotatedScreenshot: async () => SECRET,
    });
  }

  private captchaMethod(method: FakeCaptchaCall["method"]) {
    return async (page: unknown, ...args: unknown[]): Promise<unknown> => {
      if (!(page instanceof FakePage))
        throw new TypeError("captcha: the first argument must be an Aside tab");
      this.captchaCalls.push({
        method,
        targetId: page.targetId,
        args: JSON.parse(JSON.stringify(args)) as unknown[],
        blockPatterns: page.blockPatterns.map((p) => ({ ...p })),
        guardCsp: page.guardCsp(),
      });
      const tree = `- document [url=${page.url()}]`;
      if (method === "click") {
        const bounds = args[0] as FakeRect | undefined;
        if (!bounds) return "";
        await this.captchaHandlers.click?.(page, bounds);
        return tree;
      }
      if (method === "drag") {
        await this.captchaHandlers.drag?.(
          page,
          args[0] as { x: number; y: number },
          args[1] as { x: number; y: number },
        );
        return tree;
      }
      if (!this.captchaHandlers.readText) throw new Error(NO_VISION_MODEL_ERROR);
      return this.captchaHandlers.readText(page, args[0] as FakeRect | undefined);
    };
  }

  /** Simulates an Aside REPL reset/restart: all tabs are gone. */
  restart(): void {
    this.gen += 1;
    this.pages.clear();
    this.replTabs.splice(0);
  }

  /**
   * Simulates a popup opened from a bridge tab. `attach` puts it into the REPL's `tabs` (Aside does
   * this, asynchronously); `opener` links it in `Target.getTargets` (window.open popups).
   */
  spawnPopup(url: string, options: { opener?: string; attach?: boolean } = {}): FakePage {
    const p = new FakePage(this, `P${this.nextId++}`, url);
    this.pages.set(p.targetId, p);
    if (options.attach) this.replTabs.push(p);
    const info: { targetId: string; type: string; url: string; openerId?: string } = {
      targetId: p.targetId,
      type: "page",
      url,
    };
    if (options.opener !== undefined) info.openerId = options.opener;
    this.targets.push(info);
    return p;
  }

  generation(): number {
    return this.gen;
  }

  async ensureReady(): Promise<number> {
    return this.gen;
  }

  async call(request: ReplCallRequest): Promise<ReplCallResult> {
    this.calls.push(request);
    if (this.closed) throw new OutcomeError("browser_unavailable", "fake repl closed");
    if (request.generation !== undefined && request.generation !== this.gen) {
      throw new OutcomeError(
        "browser_unavailable",
        "the Aside REPL was restarted during the task and its tabs were closed",
      );
    }
    // Calls are serialized here only to keep console capture per call simple.
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async run(request: ReplCallRequest): Promise<ReplCallResult> {
    this.output = [];
    try {
      const script = new vm.Script(`(async () => {\n${request.code}\n})()`);
      await (script.runInContext(this.context) as Promise<unknown>);
      return { text: this.output.join("\n"), isError: false, generation: this.gen };
    } catch (err) {
      return {
        text: `Error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        isError: true,
        generation: this.gen,
      };
    }
  }
}
