/**
 * The onboarding agent's browser: one browser session through the shimmed port, scoped to the
 * job's hostnames, used one step at a time under the scheduler's site lock (a job holds the lock
 * per browser step, never for its whole duration, so live reads interleave).
 *
 * Scope = provisional hostnames ∪ the live manifest's hostnames/extraAllowedHosts (repair) ∪ the
 * staged manifest's hostnames/extraAllowedHosts that the agent may use, re-read before every step.
 * A staged host is usable without asking only when it shares a registrable domain with a
 * provisional hostname (`dd.reuters.com` for `www.reuters.com`); any other staged host needs the
 * user's approval for this job, because a page could talk the agent into declaring a host that
 * receives logged-in page data. Until approved such hosts stay out of the scope and the step
 * pauses the job instead. Hosts that belong to another registered site (equal, parent, or
 * subdomain), IP literals, `localhost`, and single-label names are never in scope (site
 * isolation). When the scope changes the session is replaced and its tabs are closed. Tabs are
 * named `t1`, `t2`, … for the agent; only bridge-opened tabs exist.
 */
import { OutcomeError } from "../../core/outcome.js";
import type { BrowserPort, BrowserSession, TabHandle } from "../../ports/browser.js";
import type { Scheduler, SiteLease } from "../../ports/scheduler.js";
import { registrableDomain } from "../../core/site-key.js";
import { normalizeHostname } from "../aside/hosts.js";

export interface ScopeSources {
  /** Provisional hostnames of the job. */
  provisional: readonly string[];
  /** Hostnames and extra hosts of the live manifest (already validated and promoted). */
  declared: readonly string[];
  /** Hostnames and extra hosts of the staged manifest (written by the agent; unvalidated input). */
  staged?: readonly string[] | undefined;
  /** Hosts outside the site's domain that the user approved for this job. */
  approved?: readonly string[] | undefined;
  /** Ownership hostnames of every other registered site (provisional ones included). */
  otherSites: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedScope {
  hosts: string[];
  excluded: { host: string; reason: string }[];
  /** Staged hosts outside the site's registrable domain that the user has not approved yet. */
  needsApproval: string[];
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostProblem(host: string): string | null {
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return "IP addresses are not allowed";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    return "local hosts are not allowed";
  if (!host.includes(".")) return "single-label hostnames are not allowed";
  return null;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Computes the agent's browser scope (pure). */
export function resolveAgentScope(sources: ScopeSources): ResolvedScope {
  const hosts: string[] = [];
  const excluded: { host: string; reason: string }[] = [];
  const needsApproval: string[] = [];
  const siteDomains = new Set<string>();
  for (const p of sources.provisional) {
    const h = normalizeHostname(p);
    if (h !== null) siteDomains.add(registrableDomain(h));
  }
  const approved = new Set<string>();
  for (const a of sources.approved ?? []) {
    const h = normalizeHostname(a);
    if (h !== null) approved.add(h);
  }

  /** The usable form of `raw`, or null when it is a duplicate or was kept out (recorded). */
  const admit = (raw: string): string | null => {
    const host = normalizeHostname(raw);
    if (host === null) {
      excluded.push({ host: raw, reason: "invalid hostname" });
      return null;
    }
    if (hosts.includes(host) || needsApproval.includes(host) || excluded.some((e) => e.host === host)) {
      return null;
    }
    const problem = hostProblem(host);
    if (problem !== null) {
      excluded.push({ host, reason: problem });
      return null;
    }
    for (const [key, owned] of sources.otherSites) {
      if (owned.some((o) => overlaps(host, o.toLowerCase()))) {
        excluded.push({ host, reason: `overlaps the hostnames of the registered site "${key}"` });
        return null;
      }
    }
    return host;
  };

  for (const raw of [...sources.provisional, ...sources.declared]) {
    const host = admit(raw);
    if (host !== null) hosts.push(host);
  }
  for (const raw of sources.staged ?? []) {
    const host = admit(raw);
    if (host === null) continue;
    if (siteDomains.has(registrableDomain(host)) || approved.has(host)) hosts.push(host);
    else needsApproval.push(host);
  }
  return { hosts, excluded, needsApproval };
}

/** What the agent is told when a step finds staged hosts that wait for the user's approval. */
export function approvalPauseMessage(hosts: readonly string[]): string {
  return `The job is paused: the user must approve browser access to ${hosts.join(", ")} (outside the site's own domain). End your turn now without further tool calls.`;
}

/** A lease that forwards to the lease of the step in progress (the session outlives one step). */
class StepLease implements SiteLease {
  current: SiteLease | null = null;

  constructor(
    readonly site: string,
    private readonly fallbackSignal: AbortSignal,
  ) {}

  get signal(): AbortSignal {
    return this.current?.signal ?? this.fallbackSignal;
  }

  get minIntervalMs(): number | undefined {
    return this.current?.minIntervalMs;
  }

  beforePageLoad(): Promise<void> {
    return this.current ? this.current.beforePageLoad() : Promise.resolve();
  }

  nextPageLoadAt(): number {
    return this.current?.nextPageLoadAt?.() ?? 0;
  }

  recordPageLoad(atMs: number): void {
    this.current?.recordPageLoad?.(atMs);
  }
}

export interface AgentBrowserOptions {
  browser: BrowserPort;
  scheduler: Scheduler;
  key: string;
  /** Lock holder name shown to live calls that wait ("onboarding running", "repair running"). */
  holder: string;
  /** Re-read before every step. */
  scope: () => Promise<ResolvedScope>;
  /** The site's politeness interval (staged manifest, else live, else the default). */
  minIntervalMs: () => Promise<number>;
  /** Budget of one step, lock wait included. */
  stepBudgetMs: number;
  /** The job's cancellation signal. */
  signal: AbortSignal;
  /** Called with a human line when the scope changes or hosts are excluded. */
  note: (message: string) => void;
  /** Pauses the job for the user's approval of these hosts (the step then fails). */
  pauseForApproval: (hosts: readonly string[]) => void;
}

export class AgentBrowser {
  private session: BrowserSession | null = null;
  private sessionHosts: string[] = [];
  private readonly tabs = new Map<string, TabHandle>();
  private tabCounter = 0;
  private readonly lease: StepLease;
  private lastExcluded = "";

  constructor(private readonly options: AgentBrowserOptions) {
    this.lease = new StepLease(options.key, options.signal);
  }

  /** Current tab ids (for tool results). */
  tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  tab(id: string): TabHandle {
    const t = this.tabs.get(id);
    if (!t) {
      const known = this.tabIds();
      throw new OutcomeError(
        "adapter_error",
        `unknown tab "${id}"${known.length > 0 ? ` (open tabs: ${known.join(", ")})` : " (no tabs open; use browser_open)"}`,
      );
    }
    return t;
  }

  addTab(handle: TabHandle): string {
    this.tabCounter += 1;
    const id = `t${this.tabCounter}`;
    this.tabs.set(id, handle);
    return id;
  }

  forgetTab(id: string): void {
    this.tabs.delete(id);
  }

  /** Runs `fn` as one browser step under the site lock with a fresh look at the scope. */
  async step<T>(fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    if (this.options.signal.aborted) throw new OutcomeError("timeout", "the job was cancelled");
    const scope = await this.options.scope();
    const excludedLine = scope.excluded.map((e) => `${e.host} (${e.reason})`).join(", ");
    if (excludedLine !== "" && excludedLine !== this.lastExcluded) {
      this.options.note(`hosts kept out of the browser scope: ${excludedLine}`);
    }
    this.lastExcluded = excludedLine;
    if (scope.needsApproval.length > 0) {
      this.options.pauseForApproval(scope.needsApproval);
      throw new OutcomeError("adapter_error", approvalPauseMessage(scope.needsApproval));
    }
    if (scope.hosts.length === 0) {
      throw new OutcomeError("adapter_error", "the browser scope is empty: no usable hostname for this site");
    }
    if (this.session === null || !sameSet(this.sessionHosts, scope.hosts)) {
      const hadTabs = this.tabs.size > 0;
      await this.reset();
      this.session = await this.options.browser.openSession({
        siteKey: this.options.key,
        hostnames: scope.hosts,
        lease: this.lease,
      });
      this.sessionHosts = [...scope.hosts];
      this.options.note(
        `browser scope: ${scope.hosts.join(", ")}${hadTabs ? " (scope changed; earlier tabs were closed)" : ""}`,
      );
    }
    const session = this.session;
    const minIntervalMs = await this.options.minIntervalMs();
    return this.options.scheduler.runForSite(
      {
        site: this.options.key,
        holder: this.options.holder,
        acquireTimeoutMs: this.options.stepBudgetMs,
        budgetMs: this.options.stepBudgetMs,
        minIntervalMs,
        signal: this.options.signal,
      },
      async (lease) => {
        this.lease.current = lease;
        try {
          return await fn(session);
        } finally {
          this.lease.current = null;
        }
      },
    );
  }

  /** Closes the session and its tabs. */
  async reset(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.sessionHosts = [];
    this.tabs.clear();
    if (s) await s.dispose().catch(() => undefined);
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
