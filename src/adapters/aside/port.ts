/**
 * `BrowserPort` over the Aside REPL. One port instance per bridge process shares
 * one `ReplClient` (one `aside mcp` child). Sessions are scoped to a site's hostnames; every
 * operation runs through the page-script shim (src/adapters/aside/shim.ts + repl-runtime.ts).
 *
 * Tabs: the port only ever opens its own tabs and addresses them by the target id Aside returned;
 * it never lists or attaches to the user's tabs. Tabs a session opened are closed on `dispose()`,
 * except the session's first tab, which may be kept warm for `warmTabTtlMs`. Up to
 * `maxWarmTabsPerSite` tabs per site stay warm (keeping one more closes the oldest); a session of the
 * same site and hostnames takes a free warm tab (removing it from the list, so parallel sessions
 * never share one) or opens a new tab. A REPL restart closes all bridge tabs (Aside closes a REPL
 * session's tabs when the session ends), so handles from an older generation are treated as gone.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { OutcomeError, errorToOutcome } from "../../core/outcome.js";
import type {
  BrowserPort,
  BrowserScope,
  BrowserSession,
  BrowserStatus,
  ChallengeAttempt,
  CookieFetchInit,
  CookieFetchResponse,
  OpenTabOptions,
  PageScriptOptions,
  Screenshot,
  SnapshotOptions,
  SolveChallengeOptions,
  TabHandle,
} from "../../ports/browser.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import type {
  ActionKind,
  CaptchaActResult,
  CaptchaDetection,
  CaptchaTimings,
  ChallengeDriver,
} from "./captcha.js";
import {
  CAPTCHA_MESSAGES,
  CAPTCHA_VENDOR_HOSTS,
  DEFAULT_CAPTCHA_TIMINGS,
  isCaptchaVendorHost,
  parseActResult,
  parseDetection,
  runChallengeAttempt,
} from "./captcha.js";
import {
  DEFAULT_MAX_CONCURRENT_PER_SITE,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_WARM_TAB_TTL_MS,
  REPL_CALL_CAP_MS,
} from "./defaults.js";
import type { ExtraHost } from "./hosts.js";
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
  /** How long a session's first tab stays open for reuse after the session ends (default 5 min; 0 = off). */
  warmTabTtlMs?: number | undefined;
  /** Warm tabs kept per site (the per-site pool size, `maxConcurrentPerSite`; default 3). */
  maxWarmTabsPerSite?: number | undefined;
  /** Waits inside a challenge attempt (defaults in captcha.ts; tests shorten them). */
  captchaTimings?: Partial<CaptchaTimings> | undefined;
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
  /** Challenge attempts only: hosts a tab installed or re-guarded in this call may also load from. */
  extraHosts?: readonly ExtraHost[] | undefined;
}

interface RunResult {
  value: unknown;
  lastLoadAt: number | null;
  generation: number;
  /** The last on-site main-frame URL a touched tab showed after the step (unchecked; see `AsideSession.note`). */
  pageUrl: string | null;
}

interface WarmTab {
  site: string;
  /** Site and hostnames the tab was opened for; only a session with the same scope may reuse it. */
  scope: string;
  targetId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Slack on top of the in-REPL deadline so the envelope still comes back. */
const CLIENT_GRACE_MS = 10_000;

/**
 * Violation kinds that only the script's own scoped calls produce (repl-runtime.ts refuses the URL it
 * was given). A vendor host there is the adapter's doing, not the site's bot check.
 */
const SCRIPT_OWN_CALLS: ReadonlySet<string> = new Set(["fetch", "openTab"]);

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
  private readonly maxWarmTabsPerSite: number;
  private readonly instanceId = randomBytes(6).toString("hex");
  private readonly extraGlobals = new Set<string>();
  /** Warm tabs per site key, oldest first. */
  private readonly warm = new Map<string, WarmTab[]>();
  private readonly sessions = new Set<AsideSession>();
  private readonly captchaTimings: CaptchaTimings;
  private stopped = false;

  constructor(options: AsideBrowserPortOptions) {
    this.repl = options.repl;
    this.logger = options.logger ?? silentLogger;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.warmTabTtlMs = options.warmTabTtlMs ?? DEFAULT_WARM_TAB_TTL_MS;
    const max = options.maxWarmTabsPerSite ?? DEFAULT_MAX_CONCURRENT_PER_SITE;
    this.maxWarmTabsPerSite = Number.isFinite(max)
      ? Math.max(1, Math.floor(max))
      : DEFAULT_MAX_CONCURRENT_PER_SITE;
    this.captchaTimings = { ...DEFAULT_CAPTCHA_TIMINGS, ...options.captchaTimings };
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

  /**
   * One challenge attempt (captcha.ts): on the given tab when it is an open tab of a live session with
   * exactly this scope in the current REPL generation, else in a fresh session tab opened at `url`.
   * Logs one `captcha attempt` line (site, kind, rounds, result, duration, the solver's fixed message;
   * never page content).
   */
  async solveChallenge(options: SolveChallengeOptions): Promise<ChallengeAttempt> {
    const site = options.scope.siteKey;
    const started = Date.now();
    let attempt: ChallengeAttempt | undefined;
    let error: string | undefined;
    try {
      attempt = await this.attemptChallenge(options);
      return attempt;
    } catch (err) {
      error = errorToOutcome(err).status;
      throw err;
    } finally {
      const result = !attempt
        ? "unsolved"
        : !attempt.available
          ? "unavailable"
          : attempt.solved
            ? "solved"
            : "unsolved";
      const fields: LogFields = {
        site,
        kind: attempt?.kind ?? "unknown",
        rounds: attempt?.rounds ?? 0,
        result,
        durationMs: Date.now() - started,
      };
      // The solver's message is one of its fixed texts (captcha.ts), never page content.
      if (attempt !== undefined) fields["message"] = attempt.message;
      if (error !== undefined) fields["error"] = error;
      this.logger.info("captcha attempt", fields);
    }
  }

  private async attemptChallenge(options: SolveChallengeOptions): Promise<ChallengeAttempt> {
    if (this.stopped) throw new OutcomeError("browser_unavailable", "the browser port is shut down");
    const site = options.scope.siteKey;
    let hostnames: string[];
    try {
      hostnames = normalizeHostnames(options.scope.hostnames);
    } catch (err) {
      throw new OutcomeError("adapter_error", err instanceof Error ? err.message : String(err));
    }
    const check = checkUrlInScope(options.url, hostnames);
    if (!check.ok) throw this.violation(site, "captcha", check);
    const run = new ChallengeRun(
      this,
      { ...options.scope, hostnames },
      hostnames,
      check.url,
      options,
      this.captchaTimings,
    );
    try {
      return await runChallengeAttempt(run, this.captchaTimings);
    } finally {
      run.close();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const s of [...this.sessions]) await s.dispose().catch(() => undefined);
    for (const tabs of [...this.warm.values()]) {
      for (const w of [...tabs]) await this.closeWarm(w);
    }
    await this.repl.close();
  }

  /** @internal */
  forgetSession(session: AsideSession): void {
    this.sessions.delete(session);
  }

  /** @internal A session for a challenge attempt's own tab (disposed by the attempt). */
  challengeSession(scope: BrowserScope, hostnames: readonly string[]): AsideSession {
    if (this.stopped) throw new OutcomeError("browser_unavailable", "the browser port is shut down");
    const session = new AsideSession(this, scope, hostnames);
    this.sessions.add(session);
    return session;
  }

  /** @internal An open tab of a live session with exactly this scope, in the current REPL generation. */
  challengeTab(tabId: string, site: string, hostnames: readonly string[]): ChallengeTarget | undefined {
    const key = scopeKey(site, hostnames);
    for (const s of this.sessions) {
      if (s.key() !== key) continue;
      const generation = s.generationOf(tabId);
      if (generation !== undefined && generation === this.repl.generation())
        return { id: tabId, generation, owner: s };
    }
    return undefined;
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
    if (op.kind === "script" && options.extraHosts !== undefined && options.extraHosts.length > 0)
      throw new OutcomeError("adapter_error", "page scripts never run with widened hosts");
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
        extraHosts: options.extraHosts,
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
        return {
          value: envelope.value,
          lastLoadAt: envelope.lastLoadAt,
          generation: res.generation,
          pageUrl: typeof envelope.pageUrl === "string" ? envelope.pageUrl : null,
        };
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
      throw this.envelopeError(envelope, op.kind, options.site, deadlineMs);
    }
    throw new OutcomeError(
      "browser_unavailable",
      "the Aside REPL keeps exposing new globals; refusing to run page scripts",
    );
  }

  /**
   * @internal Takes a free warm tab of the site opened for the same hostnames (the newest one), or
   * undefined. A taken tab leaves the list, so two sessions never share it. Tabs of an older REPL
   * generation are dropped on the way (the restart already closed them).
   */
  takeWarm(site: string, hostnames: readonly string[]): WarmTab | undefined {
    const generation = this.repl.generation();
    for (const stale of (this.warm.get(site) ?? []).filter((w) => w.generation !== generation)) {
      this.forgetWarm(stale);
    }
    const scope = scopeKey(site, hostnames);
    const match = (this.warm.get(site) ?? []).findLast((w) => w.scope === scope);
    if (match === undefined) return undefined;
    this.forgetWarm(match);
    return match;
  }

  /**
   * @internal Keeps a tab warm for the site, or returns false when warm tabs are off (the caller
   * closes it). Keeping more than `maxWarmTabsPerSite` closes the site's oldest warm tabs.
   */
  async keepWarm(
    site: string,
    hostnames: readonly string[],
    targetId: string,
    generation: number,
  ): Promise<boolean> {
    if (this.stopped || this.warmTabTtlMs <= 0 || generation !== this.repl.generation()) return false;
    const entry: WarmTab = {
      site,
      scope: scopeKey(site, hostnames),
      targetId,
      generation,
      timer: setTimeout(() => {
        void this.closeWarm(entry);
      }, this.warmTabTtlMs),
    };
    entry.timer.unref?.();
    const tabs = [...(this.warm.get(site) ?? []), entry];
    this.warm.set(site, tabs);
    const evict = tabs.slice(0, Math.max(0, tabs.length - this.maxWarmTabsPerSite));
    for (const w of evict) await this.closeWarm(w);
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

  /** Removes a warm tab from its site's list and stops its timer; false when it was not listed. */
  private forgetWarm(w: WarmTab): boolean {
    const tabs = this.warm.get(w.site);
    const i = tabs?.indexOf(w) ?? -1;
    if (tabs === undefined || i < 0) return false;
    clearTimeout(w.timer);
    tabs.splice(i, 1);
    if (tabs.length === 0) this.warm.delete(w.site);
    return true;
  }

  private async closeWarm(w: WarmTab): Promise<void> {
    if (!this.forgetWarm(w)) return;
    await this.closeTabById(w.site, w.targetId, w.generation);
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

  /**
   * A failed envelope as an `OutcomeError`. A violation fails the step with `adapter_error`, except in
   * a page-script step whose tab was blocked from a captcha vendor host (the site started a bot check
   * while the script ran): that step fails as a blocked `access_denied`, so the challenge path runs.
   * The script's own refused `fetch`/`openTab` calls are not the site's answer and keep
   * `adapter_error`. The request stayed blocked and every violation is logged either way.
   */
  private envelopeError(
    envelope: Exclude<ShimEnvelope, { ok: true }>,
    opKind: ShimOp["kind"],
    site: string,
    deadlineMs: number,
  ): OutcomeError {
    switch (envelope.kind) {
      case "violation": {
        for (const v of envelope.violations)
          this.logger.warn("browser shim violation", { site, kind: v.kind, detail: v.host });
        const vendor =
          opKind === "script"
            ? envelope.violations.find((v) => !SCRIPT_OWN_CALLS.has(v.kind) && isCaptchaVendorHost(v.host))
            : undefined;
        if (vendor !== undefined) {
          return new OutcomeError(
            "access_denied",
            `${site} answered with a bot check (${vendor.host})`,
            undefined,
            { blocked: true },
          );
        }
        return new OutcomeError(
          "adapter_error",
          `page script blocked by the bridge: ${describeShimViolations(envelope.violations)} is outside the site's hostnames`,
        );
      }
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
  /** The last on-site main-frame URL a step of this session reported (`lastUrl()`). */
  private lastPage: string | null = null;

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
        this.note(r);
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
    this.note(r);
    return this.register(r.value, r.generation);
  }

  lastUrl(): string | null {
    return this.lastPage;
  }

  /** Remembers the step's page URL when it is on the session's hostnames (checked again here). */
  private note(r: RunResult): void {
    if (r.pageUrl === null) return;
    const check = checkUrlInScope(r.pageUrl, this.hostnames);
    if (check.ok) this.lastPage = check.url;
  }

  /** @internal Scope identity (site and hostnames), as for warm tabs. */
  key(): string {
    return scopeKey(this.site, this.hostnames);
  }

  /** @internal Generation of an open tab of this session; undefined when it is not one. */
  generationOf(tabId: string): number | undefined {
    return this.disposed ? undefined : this.tabs.get(tabId)?.generation;
  }

  /** @internal Drops a tab the port closed on the session's behalf. */
  forgetTab(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId);
    if (this.defaultTab === t) this.defaultTab = null;
  }

  /** @internal Registers a tab the port opened for this session (a challenge attempt's widened tab). */
  adopt(value: unknown, generation: number): TabHandle {
    this.assertOpen();
    return this.register(value, generation);
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
    this.note(r);
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
    this.note(r);
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
    this.note(r);
    const base64 = typeof r.value === "string" ? r.value : "";
    return { mimeType: base64.startsWith("/9j/") ? "image/jpeg" : "image/png", base64 };
  }

  async dispose(): Promise<void> {
    await this.end(true);
  }

  /** @internal Disposes the session and closes all its tabs, keeping none warm (an abandoned attempt). */
  async discard(): Promise<void> {
    await this.end(false);
  }

  private async end(keepWarm: boolean): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.port.forgetSession(this);
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    let kept: OwnedTab | null = null;
    if (keepWarm && this.defaultTab && tabs.includes(this.defaultTab)) {
      const d = this.defaultTab;
      if (await this.port.keepWarm(this.site, this.hostnames, d.handle.id, d.generation)) kept = d;
    }
    for (const t of tabs) {
      if (t !== kept) await this.port.closeTabById(this.site, t.handle.id, t.generation);
    }
    this.defaultTab = null;
  }
}

interface ChallengeTarget {
  id: string;
  generation: number;
  /** The session that owns the tab (the caller's, or the attempt's own). */
  owner: AsideSession;
}

/**
 * The browser work of one challenge attempt (`ChallengeDriver` of captcha.ts). Every REPL call runs
 * under the attempt's budget and the scope's signal. Until the first detection has finished, the
 * detection budget (`detectBudgetMs`, clipped to the attempt's budget, counted from the attempt's
 * start) bounds the steps too: probe, open, widen, the politeness waits through the lease, the widened
 * reload, and the detection with its interstitial wait; a step it cuts short ends the attempt
 * `unknown` with no round. Action rounds use the rest of the attempt's budget.
 *
 * A tab may reach `CAPTCHA_VENDOR_HOSTS` only while it is the attempt's target: it becomes the target
 * before the widening call goes out, so `restore` owns every tab that may carry the widened filter and
 * guard. `restore` puts back the normal ones, or closes the tab when it cannot be sure: the widening
 * call did not come back (it may still be running in the REPL), the restore failed, or the attempt was
 * abandoned (the scope's signal aborted: site removed, core stopped). A closed tab is forgotten by its
 * session and never kept warm.
 */
class ChallengeRun implements ChallengeDriver {
  private readonly deadline: number;
  private readonly budget = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  /** End of the detection phase (epoch ms), never after `deadline`. */
  private readonly detectDeadline: number;
  private readonly detectBudget = new AbortController();
  private readonly detectTimer: ReturnType<typeof setTimeout>;
  /** Aborts when the attempt's budget or the detection budget ends: the signal of the detection phase. */
  private readonly detectSignal: AbortSignal;
  /** True until the first detection has finished. */
  private detecting = true;
  private readonly unlink: () => void;
  /** The scope's own signal (the caller's or the lease's); its abort abandons the attempt. */
  private readonly outer: AbortSignal | undefined;
  private target: ChallengeTarget | null = null;
  /** False while a widening call is out or after it failed: its effect on the target is unknown. */
  private widenSettled = true;
  private ownSession: AsideSession | null = null;

  constructor(
    private readonly port: AsideBrowserPort,
    private readonly scope: BrowserScope,
    private readonly hostnames: readonly string[],
    private readonly url: string,
    private readonly options: SolveChallengeOptions,
    private readonly timings: CaptchaTimings,
  ) {
    const budgetMs = Number.isFinite(options.budgetMs) ? Math.max(0, options.budgetMs) : 0;
    const detectMs =
      options.detectBudgetMs !== undefined && Number.isFinite(options.detectBudgetMs)
        ? Math.min(budgetMs, Math.max(0, options.detectBudgetMs))
        : budgetMs;
    const startedAt = Date.now();
    this.deadline = startedAt + budgetMs;
    this.detectDeadline = startedAt + detectMs;
    const outer = scope.signal ?? scope.lease?.signal;
    this.outer = outer;
    const abort = () => this.budget.abort();
    if (outer?.aborted) abort();
    else outer?.addEventListener("abort", abort, { once: true });
    this.unlink = () => outer?.removeEventListener("abort", abort);
    this.timer = setTimeout(abort, budgetMs);
    this.timer.unref?.();
    this.detectTimer = setTimeout(() => this.detectBudget.abort(), detectMs);
    this.detectTimer.unref?.();
    this.detectSignal = AbortSignal.any([this.budget.signal, this.detectBudget.signal]);
  }

  close(): void {
    clearTimeout(this.timer);
    clearTimeout(this.detectTimer);
    this.unlink();
  }

  /** What is left of the attempt's budget (action rounds start only with enough of it). */
  remainingMs(): number {
    return this.budget.signal.aborted ? 0 : this.deadline - Date.now();
  }

  /** What is left for the current step: during detection also bounded by the detection budget. */
  private phaseRemainingMs(): number {
    const remaining = this.remainingMs();
    if (!this.detecting) return remaining;
    return this.detectBudget.signal.aborted ? 0 : Math.min(remaining, this.detectDeadline - Date.now());
  }

  private phaseSignal(): AbortSignal {
    return this.detecting ? this.detectSignal : this.budget.signal;
  }

  private spent(): OutcomeError {
    return new OutcomeError(
      "timeout",
      this.detecting ? CAPTCHA_MESSAGES.detectLate : "the captcha attempt's time budget is spent",
    );
  }

  /** The first detection is done: the detection budget no longer applies. */
  private endDetection(): void {
    this.detecting = false;
    clearTimeout(this.detectTimer);
  }

  /**
   * The site's politeness wait before a page load (`lease.beforePageLoad()`), cut short by the current
   * phase's budget: during detection, a wait longer than the detection budget ends the attempt.
   */
  private async pageLoadSlot(): Promise<void> {
    const lease = this.scope.lease;
    if (!lease) return;
    const signal = this.phaseSignal();
    if (signal.aborted || this.phaseRemainingMs() <= 0) throw this.spent();
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        lease.beforePageLoad(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(this.spent());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private get site(): string {
    return this.scope.siteKey;
  }

  /**
   * Options of one REPL call. `load`: the call loads the page and already waited for its slot through
   * `lease.beforePageLoad()`, so the REPL-side gate must not wait the interval a second time; other
   * calls (detection, actions) keep the slot the last load left.
   */
  private step(
    title: string,
    options: { widened?: boolean; generation?: number | undefined; load?: boolean } = {},
  ): RunOptions {
    const remaining = this.phaseRemainingMs();
    if (remaining <= 0) throw this.spent();
    const lease = this.scope.lease;
    return {
      site: this.site,
      hostnames: this.hostnames,
      title: `Bridge ${this.site}: captcha ${title}`,
      timeoutMs: Math.min(remaining, this.port.stepTimeoutMs),
      signal: this.phaseSignal(),
      generation: options.generation,
      notBefore: options.load === true ? 0 : (lease?.nextPageLoadAt?.() ?? 0),
      minIntervalMs: lease?.minIntervalMs ?? 0,
      extraHosts: options.widened === true ? CAPTCHA_VENDOR_HOSTS : undefined,
    };
  }

  /** A wait inside one REPL call, kept a second short of what is left for the step. */
  private waitMs(ms: number): number {
    return Math.max(0, Math.min(ms, this.phaseRemainingMs() - 1000));
  }

  private requireTarget(): ChallengeTarget {
    if (!this.target) throw new OutcomeError("browser_unavailable", "the challenge tab is not open");
    return this.target;
  }

  async probe(): Promise<boolean> {
    const r = await this.port.run(
      { kind: "captcha", targetId: null, step: { action: "probe" } },
      this.step("check capability"),
    );
    return (r.value as { available?: unknown } | null)?.available === true;
  }

  async prepare(): Promise<void> {
    const given = this.options.tab
      ? this.port.challengeTab(this.options.tab.id, this.site, this.hostnames)
      : undefined;
    if (given !== undefined && (await this.widen(given))) {
      // The adapter's tab: reload the challenge URL with the widened filter and guard.
      await this.reload(given);
      return;
    }
    // A fresh tab: opened with the normal filter and guard like any session tab and adopted, so the
    // attempt owns it before anything is widened; then widened and reloaded like the adapter's tab.
    const session = this.port.challengeSession(this.scope, this.hostnames);
    this.ownSession = session;
    await this.pageLoadSlot();
    const r = await this.port.run({ kind: "open", url: this.url }, this.step("open", { load: true }));
    const handle = session.adopt(r.value, r.generation);
    const fresh: ChallengeTarget = { id: handle.id, generation: r.generation, owner: session };
    if (!(await this.widen(fresh))) {
      throw new OutcomeError(
        "browser_unavailable",
        "the challenge tab could not be prepared; retry the request",
      );
    }
    await this.reload(fresh);
  }

  /**
   * Widens the tab's filter and guard to the vendor hosts. The tab becomes the target before the call
   * goes out, so `restore` handles it even when the call is cut short (abort, budget, error). False
   * when the tab was left as it was (gone, off-site, unknown guard) or closed because its guard could
   * not be replaced.
   */
  private async widen(t: ChallengeTarget): Promise<boolean> {
    const options = this.step("widen tab", { widened: true, generation: t.generation });
    this.target = t;
    this.widenSettled = false;
    const r = await this.port.run(
      { kind: "guard", targetId: t.id, onSite: true, closeIfStuck: false },
      options,
    );
    this.widenSettled = true;
    const v = r.value as { replaced?: unknown; closed?: unknown } | null;
    if (v?.replaced === true) return true;
    this.target = null;
    if (v?.closed === true) t.owner.forgetTab(t.id);
    return false;
  }

  /** Loads the challenge URL in the widened tab (one politeness wait, through the lease). */
  private async reload(t: ChallengeTarget): Promise<void> {
    await this.pageLoadSlot();
    await this.port.run(
      { kind: "open", url: this.url, reuseTargetId: t.id },
      this.step("reload", { widened: true, generation: t.generation, load: true }),
    );
  }

  /**
   * The first detection, with the interstitial wait, inside the detection budget. An automatic check
   * still running after a wait the budget cut short means detection did not finish in time.
   */
  async detect(): Promise<CaptchaDetection> {
    const t = this.requireTarget();
    const pendingWaitMs = this.waitMs(this.timings.pendingWaitMs);
    const step = {
      action: "detect" as const,
      noneWaitMs: this.waitMs(this.timings.noneWaitMs),
      pendingWaitMs,
      pollMs: this.timings.pollMs,
    };
    const r = await this.port.run(
      { kind: "captcha", targetId: t.id, step },
      this.step("detect", { generation: t.generation }),
    );
    const detection = parseDetection((r.value as { detection?: unknown } | null)?.detection);
    if (detection.kind === "pending" && pendingWaitMs < this.timings.pendingWaitMs) throw this.spent();
    this.endDetection();
    return detection;
  }

  async act(kind: ActionKind): Promise<CaptchaActResult> {
    const t = this.requireTarget();
    const step = {
      action: "act" as const,
      expect: kind,
      settleMs: this.timings.settleMs,
      textSettleMs: this.timings.textSettleMs,
      pendingWaitMs: this.waitMs(this.timings.pendingWaitMs),
      pollMs: this.timings.pollMs,
    };
    const r = await this.port.run(
      { kind: "captcha", targetId: t.id, step },
      this.step(kind, { generation: t.generation }),
    );
    if (r.lastLoadAt !== null) this.scope.lease?.recordPageLoad?.(r.lastLoadAt);
    return parseActResult(r.value);
  }

  async restore(): Promise<void> {
    const t = this.target;
    this.target = null;
    const abandoned = this.outer?.aborted === true;
    if (t) {
      let restored = false;
      // A widening call that did not come back may still run in the REPL and could land after a
      // restore; an abandoned attempt's tab must not stay warm. Both are closed instead.
      if (this.widenSettled && !abandoned) {
        try {
          // Outside the budget and the scope's signal: the restore must run even after a timeout.
          const r = await this.port.run(
            { kind: "guard", targetId: t.id, onSite: false, closeIfStuck: true },
            {
              site: this.site,
              hostnames: this.hostnames,
              title: `Bridge ${this.site}: captcha restore tab`,
              timeoutMs: this.timings.restoreTimeoutMs,
              generation: t.generation,
            },
          );
          restored = (r.value as { replaced?: unknown } | null)?.replaced === true;
        } catch (err) {
          this.port.logger.debug("restoring a challenge tab failed", {
            site: this.site,
            error: errorToOutcome(err).message.slice(0, 200),
          });
        }
      }
      if (!restored) {
        // Never keep a tab that may still allow the vendor hosts.
        t.owner.forgetTab(t.id);
        await this.port.closeTabById(this.site, t.id, t.generation);
      }
    }
    if (this.ownSession) {
      const s = this.ownSession;
      this.ownSession = null;
      await (abandoned ? s.discard() : s.dispose()).catch(() => undefined);
    }
  }
}
