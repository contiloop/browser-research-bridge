/**
 * In-memory implementation of the browser work scheduler (port: src/ports/scheduler.ts).
 *
 * - Per-site pool: up to `maxConcurrentPerSite` tasks of one site run at once. An exclusive task
 *   (helper/repair step, real-site validation, health check) waits until the site's running tasks
 *   finish and then holds the site alone; from the moment it queues, later tasks of the site wait
 *   behind it (FIFO within a site), so it cannot be starved and never overlaps a task of its site.
 * - Global cap: at most `maxConcurrentTasks` tasks run across all sites; across sites, waiters are
 *   admitted in arrival order.
 * - A waiter that cannot start within `acquireTimeoutMs` (or the call budget) fails with `timeout`
 *   and a message naming the holders ("site busy: repair running", "site busy: 3 tasks running
 *   (search, search, fetch)", or "browser busy: …" when the global cap is the blocker).
 * - Politeness is per task: each task spaces its own page loads by the lease's `minIntervalMs`; tasks
 *   on one site do not wait for each other's loads, only for a stagger of `concurrentStaggerMs`
 *   between task starts, which delays a task's first page load.
 * - Cool-down: a site is refused (`rate_limited`) until its cool-down ends; only a task failing with
 *   `rate_limited` starts one here. A block or captcha page (`blocked: true`) does not.
 * - Call budget: optional `budgetMs` aborts the lease and rejects with `timeout`; the task keeps its
 *   place on the site until it actually settles, so the pool and exclusivity hold for real work.
 */
import { OutcomeError } from "../../core/outcome.js";
import type { Scheduler, SiteLease, SiteTaskOptions } from "../../ports/scheduler.js";
import {
  DEFAULT_CONCURRENT_STAGGER_MS,
  DEFAULT_COOL_DOWN_MS,
  DEFAULT_MAX_CONCURRENT_PER_SITE,
  DEFAULT_MAX_CONCURRENT_TASKS,
} from "./defaults.js";

export interface InMemorySchedulerOptions {
  /** Tasks of one site that may run at once (default 3). */
  maxConcurrentPerSite?: number | undefined;
  /** Tasks that may run at once across all sites (default 8). */
  maxConcurrentTasks?: number | undefined;
  /** Minimum gap between the starts of two tasks on one site, applied to the first page load (default 500 ms). */
  concurrentStaggerMs?: number | undefined;
  /** Cool-down started automatically after a `rate_limited` task (default 10 minutes). */
  coolDownMs?: number | undefined;
  /** Epoch-ms clock; defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

/** A task that holds a place on its site. */
interface RunningTask {
  site: string;
  holder: string;
  exclusive: boolean;
  /** Epoch ms from which this task's next page load may start. */
  nextLoadAt: number;
}

interface Waiter {
  site: string;
  holder: string;
  exclusive: boolean;
  grant: (task: RunningTask) => void;
}

interface SiteState {
  /** Running tasks of the site in start order. */
  running: RunningTask[];
  /** Start slot of the site's latest task (epoch ms), for the stagger; null before the first. */
  lastStartAt: number | null;
  cooldownUntil: number | null;
}

function abortReason(message: string): OutcomeError {
  return new OutcomeError("timeout", message);
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

function countLimit(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
}

function tasksRunning(n: number): string {
  return `${n} task${n === 1 ? "" : "s"} running`;
}

export class InMemoryScheduler implements Scheduler {
  private readonly maxConcurrentPerSite: number;
  private readonly maxConcurrentTasks: number;
  private readonly staggerMs: number;
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private readonly sites = new Map<string, SiteState>();
  /** Waiters in arrival order. */
  private readonly pending: Waiter[] = [];
  /** Running tasks of every site in start order. */
  private readonly running: RunningTask[] = [];

  constructor(options: InMemorySchedulerOptions = {}) {
    this.maxConcurrentPerSite = countLimit(options.maxConcurrentPerSite, DEFAULT_MAX_CONCURRENT_PER_SITE);
    this.maxConcurrentTasks = countLimit(options.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
    this.staggerMs = Math.max(0, options.concurrentStaggerMs ?? DEFAULT_CONCURRENT_STAGGER_MS);
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
        `${site} is cooling down after throttling; retry after ${new Date(until).toISOString()}`,
      );
    }

    const startedAt = this.now();
    const budgetMs = options.budgetMs;
    const acquireMs =
      budgetMs === undefined ? options.acquireTimeoutMs : Math.min(options.acquireTimeoutMs, budgetMs);
    const slot = await this.acquire(
      { site, holder, exclusive: options.exclusive === true },
      acquireMs,
      options.signal,
    );

    const revoke = new AbortController();
    const signals = options.signal ? [options.signal, revoke.signal] : [revoke.signal];
    const leaseSignal = AbortSignal.any(signals);
    const minIntervalMs = Math.max(0, options.minIntervalMs);
    const lease: SiteLease = {
      site,
      signal: leaseSignal,
      minIntervalMs,
      beforePageLoad: () => this.waitForPageLoadSlot(slot, minIntervalMs, leaseSignal),
      nextPageLoadAt: () => Math.max(this.now(), slot.nextLoadAt),
      recordPageLoad: (atMs: number) => {
        slot.nextLoadAt = Math.max(slot.nextLoadAt, atMs + minIntervalMs);
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
    void settled.finally(() => this.release(slot));

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

  holders(site: string): string[] {
    return (this.sites.get(site)?.running ?? []).map((t) => t.holder);
  }

  isIdle(site: string): boolean {
    return this.holders(site).length === 0 && !this.pending.some((w) => w.site === site);
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
      s = { running: [], lastStartAt: null, cooldownUntil: null };
      this.sites.set(site, s);
    }
    return s;
  }

  private acquire(
    request: Omit<Waiter, "grant">,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<RunningTask> {
    return new Promise<RunningTask>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        ...request,
        grant: (task) => {
          cleanup();
          resolve(task);
        },
      };
      const drop = (err: OutcomeError) => {
        const i = this.pending.indexOf(waiter);
        if (i < 0) return; // already granted
        this.pending.splice(i, 1);
        cleanup();
        reject(err);
        // A dropped waiter may have held back later waiters of its site (FIFO, exclusive drain).
        this.pump();
      };
      const onAbort = () => drop(abortReason("cancelled while waiting for the browser"));
      this.pending.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => drop(abortReason(this.busyMessage(request.site))), Math.max(0, timeoutMs));
      this.pump();
    });
  }

  private busyMessage(site: string): string {
    const mine = this.sites.get(site)?.running ?? [];
    if (mine.length > 0) {
      const exclusive = mine.find((t) => t.exclusive);
      if (exclusive) return `site busy: ${exclusive.holder}`;
      return `site busy: ${tasksRunning(mine.length)} (${mine.map((t) => t.holder).join(", ")})`;
    }
    const list = this.running.map((t) => `${t.site}: ${t.holder}`).join(", ");
    return `browser busy: ${tasksRunning(this.running.length)} (${list})`;
  }

  /** Whether the site has room for the waiter right now (ignoring the global cap and the queue). */
  private hasRoom(state: SiteState, exclusive: boolean): boolean {
    if (state.running.some((t) => t.exclusive)) return false;
    return exclusive ? state.running.length === 0 : state.running.length < this.maxConcurrentPerSite;
  }

  /**
   * Starts every waiter that can start, in arrival order. A waiter that cannot start holds back the
   * later waiters of its site, which keeps FIFO within a site and lets an exclusive waiter drain it.
   */
  private pump(): void {
    const held = new Set<string>();
    for (let i = 0; i < this.pending.length && this.running.length < this.maxConcurrentTasks;) {
      const w = this.pending[i]!;
      const state = this.state(w.site);
      if (held.has(w.site) || !this.hasRoom(state, w.exclusive)) {
        held.add(w.site);
        i += 1;
        continue;
      }
      this.pending.splice(i, 1);
      w.grant(this.start(w, state));
    }
  }

  private start(w: Waiter, state: SiteState): RunningTask {
    const now = this.now();
    // The stagger only separates tasks that really overlap: an idle site starts at once, so a burst of
    // short tasks that never load a page does not push the next real task's first load back.
    const startAt =
      state.lastStartAt === null || state.running.length === 0
        ? now
        : Math.max(now, state.lastStartAt + this.staggerMs);
    state.lastStartAt = startAt;
    const task: RunningTask = { site: w.site, holder: w.holder, exclusive: w.exclusive, nextLoadAt: startAt };
    state.running.push(task);
    this.running.push(task);
    return task;
  }

  private release(task: RunningTask): void {
    const state = this.state(task.site);
    const i = state.running.indexOf(task);
    if (i < 0) return;
    state.running.splice(i, 1);
    const g = this.running.indexOf(task);
    if (g >= 0) this.running.splice(g, 1);
    this.pump();
  }

  private waitForPageLoadSlot(task: RunningTask, minIntervalMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason("cancelled before a page load"));
    const now = this.now();
    const slot = Math.max(now, task.nextLoadAt);
    task.nextLoadAt = slot + minIntervalMs;
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
