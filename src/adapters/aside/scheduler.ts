/**
 * In-memory implementation of the browser work scheduler (port: src/ports/scheduler.ts).
 *
 * - Site lock: one in-flight task per site; waiters for a site are served FIFO.
 * - Global cap: at most `maxConcurrentSites` sites active at once; across sites, waiters are admitted
 *   in arrival order.
 * - A waiter that cannot start within `acquireTimeoutMs` (or the call budget) fails with
 *   `timeout` and a message naming the holder ("site busy: repair running").
 * - Politeness: page loads on one site are spaced by the lease's `minIntervalMs`; the spacing carries
 *   over between tasks on the same site.
 * - Cool-down: a site is refused (`rate_limited`) until its cool-down ends; a task failing with
 *   `rate_limited` starts one automatically. Callers set it for detected block/captcha pages that
 *   they report as `access_denied` (a paywall is `access_denied` too, so that is not automatic).
 * - Call budget: optional `budgetMs` aborts the lease and rejects with `timeout`; the site lock stays
 *   held until the task actually settles, so two tasks never overlap on one site.
 */
import { OutcomeError } from "../../core/outcome.js";
import type { Scheduler, SiteLease, SiteTaskOptions } from "../../ports/scheduler.js";
import { DEFAULT_COOL_DOWN_MS, DEFAULT_MAX_CONCURRENT_SITES } from "./defaults.js";

export interface InMemorySchedulerOptions {
  /** Global cap on concurrently active sites (default 4). */
  maxConcurrentSites?: number | undefined;
  /** Cool-down started automatically after a `rate_limited` task (default 10 minutes). */
  coolDownMs?: number | undefined;
  /** Epoch-ms clock; defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

interface Waiter {
  site: string;
  holder: string;
  grant: () => void;
}

interface SiteState {
  holder: string | null;
  /** Epoch ms from which the next page load may start. */
  nextLoadAt: number;
  cooldownUntil: number | null;
}

function abortReason(message: string): OutcomeError {
  return new OutcomeError("timeout", message);
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

export class InMemoryScheduler implements Scheduler {
  private readonly maxConcurrentSites: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly sites = new Map<string, SiteState>();
  /** Waiters in arrival order. */
  private readonly pending: Waiter[] = [];
  private activeCount = 0;

  constructor(options: InMemorySchedulerOptions = {}) {
    this.maxConcurrentSites = Math.max(1, options.maxConcurrentSites ?? DEFAULT_MAX_CONCURRENT_SITES);
    this.coolDownMs = options.coolDownMs ?? DEFAULT_COOL_DOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async runForSite<T>(options: SiteTaskOptions, task: (lease: SiteLease) => Promise<T>): Promise<T> {
    const { site, holder } = options;
    if (options.signal?.aborted) throw abortReason("cancelled before the browser task started");
    const until = this.cooldownUntil(site);
    if (until !== null && options.ignoreCooldown !== true) {
      throw new OutcomeError(
        "rate_limited",
        `${site} is cooling down after a block or throttling; retry after ${new Date(until).toISOString()}`,
      );
    }

    const startedAt = this.now();
    const budgetMs = options.budgetMs;
    const acquireMs =
      budgetMs === undefined ? options.acquireTimeoutMs : Math.min(options.acquireTimeoutMs, budgetMs);
    await this.acquire(site, holder, acquireMs, options.signal);

    const revoke = new AbortController();
    const signals = options.signal ? [options.signal, revoke.signal] : [revoke.signal];
    const leaseSignal = AbortSignal.any(signals);
    const state = this.state(site);
    const minIntervalMs = Math.max(0, options.minIntervalMs);
    const lease: SiteLease = {
      site,
      signal: leaseSignal,
      minIntervalMs,
      beforePageLoad: () => this.waitForPageLoadSlot(state, minIntervalMs, leaseSignal),
      nextPageLoadAt: () => Math.max(this.now(), state.nextLoadAt),
      recordPageLoad: (atMs: number) => {
        state.nextLoadAt = Math.max(state.nextLoadAt, atMs + minIntervalMs);
      },
    };

    const running = Promise.resolve().then(() => task(lease));
    const settled = running.then(
      () => undefined,
      (err: unknown) => {
        if (err instanceof OutcomeError && err.status === "rate_limited") {
          this.setCooldown(site, this.now() + this.coolDownMs);
        }
      },
    );
    void settled.finally(() => this.release(site));

    if (budgetMs === undefined) return running;
    const remaining = Math.max(0, budgetMs - (this.now() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = abortReason(`time budget exceeded (${formatSeconds(budgetMs)} s)`);
        revoke.abort(err);
        reject(err);
      }, remaining);
    });
    try {
      return await Promise.race([running, budget]);
    } finally {
      clearTimeout(timer);
    }
  }

  currentHolder(site: string): string | null {
    return this.sites.get(site)?.holder ?? null;
  }

  isIdle(site: string): boolean {
    return this.currentHolder(site) === null && !this.pending.some((w) => w.site === site);
  }

  setCooldown(site: string, untilMs: number): void {
    this.state(site).cooldownUntil = untilMs;
  }

  clearCooldown(site: string): void {
    const state = this.sites.get(site);
    if (state) state.cooldownUntil = null;
  }

  cooldownUntil(site: string): number | null {
    const state = this.sites.get(site);
    if (!state || state.cooldownUntil === null) return null;
    if (state.cooldownUntil <= this.now()) {
      state.cooldownUntil = null;
      return null;
    }
    return state.cooldownUntil;
  }

  private state(site: string): SiteState {
    let s = this.sites.get(site);
    if (!s) {
      s = { holder: null, nextLoadAt: 0, cooldownUntil: null };
      this.sites.set(site, s);
    }
    return s;
  }

  private acquire(
    site: string,
    holder: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        site,
        holder,
        grant: () => {
          cleanup();
          resolve();
        },
      };
      const drop = (err: OutcomeError) => {
        const i = this.pending.indexOf(waiter);
        if (i < 0) return; // already granted
        this.pending.splice(i, 1);
        cleanup();
        reject(err);
        this.pump();
      };
      const onAbort = () => drop(abortReason("cancelled while waiting for the browser"));
      this.pending.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => drop(abortReason(this.busyMessage(site))), Math.max(0, timeoutMs));
      this.pump();
    });
  }

  private busyMessage(site: string): string {
    const holder = this.currentHolder(site);
    if (holder !== null) return `site busy: ${holder}`;
    const active = [...this.sites.entries()].filter(([, s]) => s.holder !== null);
    const list = active.map(([key, s]) => `${key}: ${s.holder ?? ""}`).join(", ");
    return `browser busy: ${active.length} site${active.length === 1 ? "" : "s"} active (${list})`;
  }

  private pump(): void {
    for (let i = 0; i < this.pending.length && this.activeCount < this.maxConcurrentSites;) {
      const w = this.pending[i]!;
      const state = this.state(w.site);
      if (state.holder !== null) {
        i += 1;
        continue;
      }
      this.pending.splice(i, 1);
      state.holder = w.holder;
      this.activeCount += 1;
      w.grant();
    }
  }

  private release(site: string): void {
    const state = this.state(site);
    if (state.holder === null) return;
    state.holder = null;
    this.activeCount -= 1;
    this.pump();
  }

  private waitForPageLoadSlot(state: SiteState, minIntervalMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason("cancelled before a page load"));
    const now = this.now();
    const slot = Math.max(now, state.nextLoadAt);
    state.nextLoadAt = slot + minIntervalMs;
    const wait = slot - now;
    if (wait <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason("cancelled while waiting for the site's politeness interval"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
