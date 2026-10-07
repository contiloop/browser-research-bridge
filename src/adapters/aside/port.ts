/**
 * `BrowserPort` over the Aside REPL. One port instance per bridge process shares
 * one `ReplClient` (one `aside mcp` child). Sessions are scoped to a site's hostnames; every
 * operation runs through the page-script shim (src/adapters/aside/shim.ts + repl-runtime.ts).
 *
 * Tabs: the port only ever opens its own tabs and addresses them by the target id Aside returned;
 * it never lists or attaches to the user's tabs. Tabs a session opened are closed on `dispose()`,
 * except one per site that may be kept warm for `warmTabTtlMs` and reused by the next session of
 * the same site and hostnames. A REPL restart closes all bridge tabs (Aside closes a REPL session's
 * tabs when the session ends), so handles from an older generation are treated as gone.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { OutcomeError, errorToOutcome } from "../../core/outcome.js";
import type {
  BrowserPort,
  BrowserScope,
  BrowserSession,
  BrowserStatus,
  CookieFetchInit,
  CookieFetchResponse,
  OpenTabOptions,
  PageScriptOptions,
  Screenshot,
  SnapshotOptions,
  TabHandle,
} from "../../ports/browser.js";
import type { Logger } from "../../ports/logger.js";
import { DEFAULT_STEP_TIMEOUT_MS, DEFAULT_WARM_TAB_TTL_MS, REPL_CALL_CAP_MS } from "./defaults.js";
import { checkUrlInScope, normalizeHostnames } from "./hosts.js";
import { ASIDE_LOGIN_ACTION, looksLikeLoginProblem } from "./mcp-repl-client.js";
import type { ReplClient } from "./repl-client.js";
import type { ShimEnvelope, ShimOp, ShimViolationRecord } from "./shim.js";
import { buildReplCode, checkPageScript, parseReplOutput, shadowParams } from "./shim.js";

export interface AsideBrowserPortOptions {
  repl: ReplClient;
  logger?: Logger | undefined;
  /** Per adapter step (default 120 s; the in-REPL deadline is capped below Aside's 120 s limit). */
  stepTimeoutMs?: number | undefined;
  /** How long a site's last tab stays open for reuse after a session ends (default 5 min; 0 = off). */
  warmTabTtlMs?: number | undefined;
}

interface RunOptions {
  site: string;
  hostnames: readonly string[];
  title: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  generation?: number | undefined;
  notBefore?: number | undefined;
  minIntervalMs?: number | undefined;
}

interface RunResult {
  value: unknown;
  lastLoadAt: number | null;
  generation: number;
}

interface WarmTab {
  key: string;
  targetId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Slack on top of the in-REPL deadline so the envelope still comes back. */
const CLIENT_GRACE_MS = 10_000;

function describeShimViolations(violations: readonly ShimViolationRecord[]): string {
  const parts = violations.map((v) => `${v.kind} to ${v.host}`);
  return [...new Set(parts)].join(", ");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function scopeKey(site: string, hostnames: readonly string[]): string {
  return `${site}|${[...hostnames].sort().join(",")}`;
}

export class AsideBrowserPort implements BrowserPort {
  readonly repl: ReplClient;
  readonly logger: Logger;
  readonly stepTimeoutMs: number;
  private readonly warmTabTtlMs: number;
  private readonly instanceId = randomBytes(6).toString("hex");
  private readonly extraGlobals = new Set<string>();
  private readonly warm = new Map<string, WarmTab>();
  private readonly sessions = new Set<AsideSession>();
  private stopped = false;

  constructor(options: AsideBrowserPortOptions) {
    this.repl = options.repl;
    this.logger = options.logger ?? silentLogger;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.warmTabTtlMs = options.warmTabTtlMs ?? DEFAULT_WARM_TAB_TTL_MS;
  }

  async status(): Promise<BrowserStatus> {
    try {
      await this.run(
        { kind: "probe" },
        { site: "-", hostnames: [], title: "Bridge: check browser", timeoutMs: 30_000 },
      );
      return { reachable: true, account: this.repl.account };
    } catch (err) {
      const outcome = errorToOutcome(err);
      const status: BrowserStatus = {
        reachable: false,
        account: this.repl.account,
        message: outcome.message,
      };
      if (outcome.action !== undefined) status.action = outcome.action;
      return status;
    }
  }

  async openSession(scope: BrowserScope): Promise<BrowserSession> {
    if (this.stopped) throw new OutcomeError("browser_unavailable", "the browser port is shut down");
    let hostnames: string[];
    try {
      hostnames = normalizeHostnames(scope.hostnames);
    } catch (err) {
      throw new OutcomeError("adapter_error", err instanceof Error ? err.message : String(err));
    }
    const session = new AsideSession(this, { ...scope, hostnames }, hostnames);
    this.sessions.add(session);
    return session;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const s of [...this.sessions]) await s.dispose().catch(() => undefined);
    for (const key of [...this.warm.keys()]) await this.closeWarm(key);
    await this.repl.close();
  }

  /** @internal */
  forgetSession(session: AsideSession): void {
    this.sessions.delete(session);
  }

  /** @internal Logs an out-of-scope URL (host only) and returns the `adapter_error` to throw. */
  violation(site: string, kind: string, check: { host: string; reason: string }): OutcomeError {
    const host = check.host || "an invalid URL";
    this.logger.warn("browser shim violation", { site, kind, detail: host });
    return new OutcomeError("adapter_error", `blocked by the bridge: ${kind} to ${host} (${check.reason})`);
  }

  /** @internal Runs one shim operation in the REPL and unwraps its envelope. */
  async run(op: ShimOp, options: RunOptions): Promise<RunResult> {
    if (options.signal?.aborted)
      throw new OutcomeError("timeout", "browser step cancelled (time budget spent)");
    const deadlineMs = Math.max(1000, Math.min(options.timeoutMs, REPL_CALL_CAP_MS));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let wireOp = op;
      if (op.kind === "script") {
        const params = shadowParams(this.extraGlobals);
        const check = checkPageScript(op.script, params);
        if (!check.ok) {
          for (const v of check.violations)
            this.logger.warn("browser shim violation", {
              site: options.site,
              kind: v.rule,
              detail: v.detail,
            });
          if (check.violations.length === 0)
            this.logger.warn("page script rejected", { site: options.site, kind: "syntax" });
          throw new OutcomeError("adapter_error", check.reason);
        }
        wireOp = { ...op, params };
      }
      const nonce = randomUUID().replace(/-/g, "");
      const code = buildReplCode(wireOp, {
        nonce,
        hostnames: options.hostnames,
        deadlineMs,
        notBefore: options.notBefore ?? 0,
        minIntervalMs: options.minIntervalMs ?? 0,
        instanceId: this.instanceId,
      });
      const res = await this.repl.call({
        title: options.title,
        code,
        timeoutMs: deadlineMs + CLIENT_GRACE_MS,
        signal: options.signal,
        generation: options.generation,
      });
      const envelope = parseReplOutput(res.text, nonce);
      if (envelope === null) throw this.classifyRawFailure(res.text, res.isError);
      if (envelope.ok) {
        if (envelope.pageBlocked && envelope.pageBlocked.length > 0) {
          // Requests the site's own scripts made to undeclared hosts: blocked, not the script's doing.
          this.logger.debug("requests blocked by the tab filter", {
            site: options.site,
            hosts: envelope.pageBlocked.join(",").slice(0, 300),
          });
        }
        return { value: envelope.value, lastLoadAt: envelope.lastLoadAt, generation: res.generation };
      }
      if (envelope.kind === "globals") {
        // A REPL global the shim does not shadow yet: shadow it and retry.
        for (const n of envelope.names) this.extraGlobals.add(n);
        this.logger.info("shadowing additional Aside REPL globals", {
          count: envelope.names.length,
          names: envelope.names.join(",").slice(0, 300),
        });
        continue;
      }
      throw this.envelopeError(envelope, options.site, deadlineMs);
    }
    throw new OutcomeError(
      "browser_unavailable",
      "the Aside REPL keeps exposing new globals; refusing to run page scripts",
    );
  }

  /** @internal */
  takeWarm(site: string, hostnames: readonly string[]): WarmTab | undefined {
    const key = scopeKey(site, hostnames);
    const w = this.warm.get(key);
    if (!w) return undefined;
    clearTimeout(w.timer);
    this.warm.delete(key);
    if (w.generation !== this.repl.generation()) return undefined;
    return w;
  }

  /** @internal Keeps a tab warm for the site, or closes it when warm tabs are off. */
  async keepWarm(
    site: string,
    hostnames: readonly string[],
    targetId: string,
    generation: number,
  ): Promise<boolean> {
    if (this.stopped || this.warmTabTtlMs <= 0 || generation !== this.repl.generation()) return false;
    const key = scopeKey(site, hostnames);
    if (this.warm.has(key)) await this.closeWarm(key);
    const timer = setTimeout(() => {
      void this.closeWarm(key);
    }, this.warmTabTtlMs);
    timer.unref?.();
    this.warm.set(key, { key, targetId, generation, timer });
    return true;
  }

  /** @internal Best-effort close of a bridge tab by target id. */
  async closeTabById(site: string, targetId: string, generation: number): Promise<void> {
    if (generation !== this.repl.generation()) return; // the REPL restart already closed it
    try {
      const r = await this.run(
        { kind: "close", targetId },
        { site, hostnames: [], title: "Bridge: close tab", timeoutMs: 30_000, generation },
      );
      const popups = (r.value as { popups?: ShimViolationRecord[] } | null)?.popups ?? [];
      for (const v of popups) {
        this.logger.warn("browser shim violation", { site, kind: v.kind, detail: v.host });
      }
    } catch (err) {
      this.logger.debug("closing a bridge tab failed", {
        site,
        error: errorToOutcome(err).message.slice(0, 200),
      });
    }
  }

  private async closeWarm(key: string): Promise<void> {
    const w = this.warm.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    this.warm.delete(key);
    await this.closeTabById(key.split("|")[0] ?? "-", w.targetId, w.generation);
  }

  private classifyRawFailure(text: string, isError: boolean): OutcomeError {
    if (looksLikeLoginProblem(text)) {
      return new OutcomeError(
        "browser_unavailable",
        "the Aside CLI login has expired or is missing",
        ASIDE_LOGIN_ACTION,
      );
    }
    const line = firstLine(text);
    if (isError && /SyntaxError/.test(text)) {
      return new OutcomeError("adapter_error", `the Aside REPL could not compile the page script: ${line}`);
    }
    if (/timed? ?out|timeout/i.test(text))
      return new OutcomeError("timeout", `the Aside REPL step timed out: ${line}`);
    return new OutcomeError(
      "browser_unavailable",
      `the Aside REPL returned no result${line ? `: ${line}` : ""}`,
    );
  }

  private envelopeError(
    envelope: Exclude<ShimEnvelope, { ok: true }>,
    site: string,
    deadlineMs: number,
  ): OutcomeError {
    switch (envelope.kind) {
      case "violation":
        for (const v of envelope.violations)
          this.logger.warn("browser shim violation", { site, kind: v.kind, detail: v.host });
        return new OutcomeError(
          "adapter_error",
          `page script blocked by the bridge: ${describeShimViolations(envelope.violations)} is outside the site's hostnames`,
        );
      case "script":
        return new OutcomeError("adapter_error", `page script failed: ${envelope.message}`);
      case "timeout":
        return new OutcomeError("timeout", `browser step exceeded ${Math.round(deadlineMs / 1000)} s`);
      case "tab_gone":
        return new OutcomeError(
          "browser_unavailable",
          "the bridge tab is gone (the Aside REPL was reset); retry the request",
        );
      case "internal":
        return new OutcomeError("browser_unavailable", `the Aside REPL shim failed: ${envelope.message}`);
      case "globals":
        return new OutcomeError("browser_unavailable", "the Aside REPL exposes unexpected globals");
    }
  }
}

interface OwnedTab {
  handle: TabHandle;
  generation: number;
}

class AsideSession implements BrowserSession {
  readonly scope: Readonly<BrowserScope>;
  private readonly hostnames: readonly string[];
  private readonly tabs = new Map<string, OwnedTab>();
  private defaultTab: OwnedTab | null = null;
  private disposed = false;

  constructor(
    private readonly port: AsideBrowserPort,
    scope: BrowserScope,
    hostnames: readonly string[],
  ) {
    this.scope = scope;
    this.hostnames = hostnames;
  }

  private get site(): string {
    return this.scope.siteKey;
  }

  private get signal(): AbortSignal | undefined {
    return this.scope.signal ?? this.scope.lease?.signal;
  }

  private assertOpen(): void {
    if (this.disposed) throw new OutcomeError("adapter_error", "the browser session was already disposed");
  }

  private owned(tab: TabHandle): OwnedTab {
    const t = this.tabs.get(tab.id);
    if (!t) throw new OutcomeError("adapter_error", "not a tab of this browser session");
    return t;
  }

  private timeout(ms: number | undefined): number {
    return ms ?? this.port.stepTimeoutMs;
  }

  async openTab(url: string, options: OpenTabOptions = {}): Promise<TabHandle> {
    this.assertOpen();
    const check = checkUrlInScope(url, this.hostnames);
    if (!check.ok) throw this.port.violation(this.site, "openTab", check);
    await this.scope.lease?.beforePageLoad();
    const base = {
      site: this.site,
      hostnames: this.hostnames,
      timeoutMs: this.timeout(options.timeoutMs),
      signal: this.signal,
    };
    const warm = this.port.takeWarm(this.site, this.hostnames);
    if (warm) {
      try {
        const r = await this.port.run(
          { kind: "open", url: check.url, waitUntil: options.waitUntil, reuseTargetId: warm.targetId },
          {
            ...base,
            title: `Bridge ${this.site}: open ${check.host} (warm tab)`,
            generation: warm.generation,
          },
        );
        return this.register(r.value, r.generation);
      } catch (err) {
        const status = err instanceof OutcomeError ? err.status : "adapter_error";
        if (status !== "browser_unavailable") {
          await this.port.closeTabById(this.site, warm.targetId, warm.generation);
          throw err;
        }
        // The warm tab is gone; open a fresh one.
      }
    }
    const r = await this.port.run(
      { kind: "open", url: check.url, waitUntil: options.waitUntil },
      { ...base, title: `Bridge ${this.site}: open ${check.host}` },
    );
    return this.register(r.value, r.generation);
  }

  private register(value: unknown, generation: number): TabHandle {
    const v = value as { targetId?: unknown; url?: unknown } | null;
    if (!v || typeof v.targetId !== "string")
      throw new OutcomeError("browser_unavailable", "Aside did not return a tab id");
    const handle: TabHandle = { id: v.targetId, url: typeof v.url === "string" ? v.url : "" };
    const owned = { handle, generation };
    this.tabs.set(handle.id, owned);
    if (this.disposed) {
      // Disposed while opening: do not leak the tab.
      void this.port.closeTabById(this.site, handle.id, generation);
      this.tabs.delete(handle.id);
      throw new OutcomeError("adapter_error", "the browser session was disposed while opening a tab");
    }
    this.defaultTab ??= owned;
    this.port.logger.debug("bridge tab opened", { site: this.site, tab: handle.id });
    return handle;
  }

  async closeTab(tab: TabHandle): Promise<void> {
    this.assertOpen();
    const t = this.owned(tab);
    this.tabs.delete(tab.id);
    if (this.defaultTab === t) this.defaultTab = null;
    await this.port.closeTabById(this.site, tab.id, t.generation);
  }

  async snapshot(tab: TabHandle, options: SnapshotOptions = {}): Promise<string> {
    this.assertOpen();
    const t = this.owned(tab);
    const r = await this.port.run(
      { kind: "snapshot", targetId: tab.id },
      {
        site: this.site,
        hostnames: this.hostnames,
        title: `Bridge ${this.site}: snapshot`,
        timeoutMs: this.timeout(undefined),
        signal: this.signal,
        generation: t.generation,
      },
    );
    const tree = typeof r.value === "string" ? r.value : "";
    return options.maxChars !== undefined && tree.length > options.maxChars
      ? tree.slice(0, options.maxChars)
      : tree;
  }

  async runScript(script: string, options: PageScriptOptions = {}): Promise<unknown> {
    this.assertOpen();
    const t = options.tab ? this.owned(options.tab) : this.defaultTab;
    const lease = this.scope.lease;
    const r = await this.port.run(
      {
        kind: "script",
        targetId: t ? t.handle.id : null,
        script,
        args: options.args ?? null,
        params: [],
      },
      {
        site: this.site,
        hostnames: this.hostnames,
        title: `Bridge ${this.site}: ${options.title ?? "page script"}`,
        timeoutMs: this.timeout(options.timeoutMs),
        signal: this.signal,
        generation: t ? t.generation : undefined,
        notBefore: lease?.nextPageLoadAt?.() ?? 0,
        minIntervalMs: lease?.minIntervalMs ?? 0,
      },
    );
    if (r.lastLoadAt !== null) lease?.recordPageLoad?.(r.lastLoadAt);
    return r.value;
  }

  async fetch(url: string, init: CookieFetchInit = {}): Promise<CookieFetchResponse> {
    this.assertOpen();
    const check = checkUrlInScope(url, this.hostnames);
    if (!check.ok) throw this.port.violation(this.site, "fetch", check);
    await this.scope.lease?.beforePageLoad();
    const r = await this.port.run(
      {
        kind: "fetch",
        url: check.url,
        init: { method: init.method, headers: init.headers, body: init.body },
      },
      {
        site: this.site,
        hostnames: this.hostnames,
        title: `Bridge ${this.site}: fetch ${check.host}`,
        timeoutMs: this.timeout(init.timeoutMs),
        signal: this.signal,
      },
    );
    const v = r.value as { status?: unknown; url?: unknown; headers?: unknown; text?: unknown } | null;
    if (!v || typeof v.status !== "number")
      throw new OutcomeError("browser_unavailable", "Aside returned a malformed fetch response");
    const headers: Record<string, string> = {};
    if (v.headers && typeof v.headers === "object") {
      for (const [k, val] of Object.entries(v.headers as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        if (lk === "set-cookie" || lk === "set-cookie2") continue;
        headers[lk] = String(val);
      }
    }
    return {
      status: v.status,
      url: typeof v.url === "string" ? v.url : check.url,
      headers,
      text: typeof v.text === "string" ? v.text : "",
    };
  }

  async screenshot(tab: TabHandle): Promise<Screenshot> {
    this.assertOpen();
    const t = this.owned(tab);
    const r = await this.port.run(
      { kind: "screenshot", targetId: tab.id },
      {
        site: this.site,
        hostnames: this.hostnames,
        title: `Bridge ${this.site}: screenshot`,
        timeoutMs: this.timeout(undefined),
        signal: this.signal,
        generation: t.generation,
      },
    );
    const base64 = typeof r.value === "string" ? r.value : "";
    return { mimeType: base64.startsWith("/9j/") ? "image/jpeg" : "image/png", base64 };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.port.forgetSession(this);
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    let kept: OwnedTab | null = null;
    if (this.defaultTab && tabs.includes(this.defaultTab)) {
      const d = this.defaultTab;
      if (await this.port.keepWarm(this.site, this.hostnames, d.handle.id, d.generation)) kept = d;
    }
    for (const t of tabs) {
      if (t !== kept) await this.port.closeTabById(this.site, t.handle.id, t.generation);
    }
    this.defaultTab = null;
  }
}
