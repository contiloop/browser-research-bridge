/**
 * Test double for the Aside REPL: runs the code the port generates in a `node:vm` context whose
 * globals mimic the REPL (openTab/closeTab/getTabByTargetId/fetch/snapshot/sleep plus capability
 * globals such as fs/aside/gmail that must stay unreachable). Pages are fakes that record CDP calls,
 * navigations and requests; `page.evaluate` runs the function in a separate "page world" whose
 * `fetch` honors the tab's `Network.setBlockedURLs` patterns, like Chrome does.
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

export class FakePage {
  blockPatterns: BlockPattern[] = [];
  readonly initScripts: Array<{ source: string; worldName: string | undefined }> = [];
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
    this.currentUrl = this.repl.redirects.get(url) ?? url;
    return null;
  }

  async reload(): Promise<null> {
    this.navigations.push(this.currentUrl);
    return null;
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
      case "Page.addScriptToEvaluateOnNewDocument":
        this.initScripts.push({
          source: String(params["source"]),
          worldName: typeof params["worldName"] === "string" ? params["worldName"] : undefined,
        });
        return { identifier: String(this.initScripts.length) };
      case "Page.getFrameTree": {
        const children = this.childFrameStore ? [{ frame: { id: `${this.targetId}-child` } }] : [];
        return { frameTree: { frame: { id: this.targetId }, childFrames: children } };
      }
      case "Page.createIsolatedWorld":
        return { executionContextId: params["frameId"] === this.targetId ? 7 : 8 };
      case "Runtime.evaluate": {
        const expr = String(params["expression"]);
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
  closed = false;
  private nextId = 1;
  private output: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.userTab = new FakePage(this, "USER-TAB", "https://mail.example.org/inbox");
    this.targets.push({ targetId: "USER-TAB", type: "page", url: "https://mail.example.org/inbox" });
    const sentinel = { secret: SECRET, readFile: async () => SECRET };
    this.context = vm.createContext({
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
