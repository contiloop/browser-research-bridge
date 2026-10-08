import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutcomeError } from "../../core/outcome.js";
import type { SiteLease, SiteTaskOptions } from "../../ports/scheduler.js";
import { InMemoryScheduler } from "./scheduler.js";

function opts(site: string, holder: string, extra: Partial<SiteTaskOptions> = {}): SiteTaskOptions {
  return { site, holder, acquireTimeoutMs: 10_000, minIntervalMs: 1500, ...extra };
}

/** A task the test finishes by hand. */
function deferredTask() {
  let finish!: (value: string) => void;
  let lease: SiteLease | undefined;
  const started = vi.fn();
  const task = (l: SiteLease) =>
    new Promise<string>((resolve) => {
      lease = l;
      started();
      finish = resolve;
    });
  return {
    task,
    started,
    finish: (v = "done") => finish(v),
    get lease() {
      return lease;
    },
  };
}

type Deferred = ReturnType<typeof deferredTask>;

const startedCount = (tasks: readonly Deferred[]) =>
  tasks.filter((t) => t.started.mock.calls.length > 0).length;
const startCounts = (tasks: readonly Deferred[]) => tasks.map((t) => t.started.mock.calls.length);

describe("InMemoryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("per-site pool", () => {
    it("runs up to 3 tasks of one site at once by default and reports their holders", async () => {
      const s = new InMemoryScheduler();
      const tasks = [deferredTask(), deferredTask(), deferredTask(), deferredTask()];
      const names = ["search", "search", "fetch", "read"];
      const runs = tasks.map((t, i) => s.runForSite(opts("reuters", names[i]!), t.task));
      await vi.advanceTimersByTimeAsync(0);
      expect(startedCount(tasks)).toBe(3);
      expect(tasks[3]!.started).not.toHaveBeenCalled();
      expect(s.holders("reuters")).toEqual(["search", "search", "fetch"]);
      expect(s.isIdle("reuters")).toBe(false);

      tasks[1]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(tasks[3]!.started).toHaveBeenCalledOnce();
      expect(s.holders("reuters")).toEqual(["search", "fetch", "read"]);

      for (const t of [tasks[0]!, tasks[2]!, tasks[3]!]) t.finish();
      await Promise.all(runs);
      expect(s.holders("reuters")).toEqual([]);
      expect(s.isIdle("reuters")).toBe(true);
    });

    it("takes the per-site pool size from maxConcurrentPerSite", async () => {
      const s = new InMemoryScheduler({ maxConcurrentPerSite: 1 });
      const a = deferredTask();
      const b = deferredTask();
      const pa = s.runForSite(opts("hn", "search"), a.task);
      const pb = s.runForSite(opts("hn", "read"), b.task);
      await vi.advanceTimersByTimeAsync(0);
      expect(a.started).toHaveBeenCalledOnce();
      expect(b.started).not.toHaveBeenCalled();
      a.finish("A");
      await expect(pa).resolves.toBe("A");
      await vi.advanceTimersByTimeAsync(0);
      expect(b.started).toHaveBeenCalledOnce();
      b.finish("B");
      await expect(pb).resolves.toBe("B");
    });

    it("never runs more tasks of one site than the pool, however many arrive", async () => {
      const s = new InMemoryScheduler({ maxConcurrentPerSite: 3, maxConcurrentTasks: 50 });
      let inFlight = 0;
      let peak = 0;
      const runs = Array.from({ length: 12 }, (_, i) =>
        s.runForSite(opts("hn", `t${i}`), async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 100 + (i % 4) * 30));
          inFlight -= 1;
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all(runs);
      expect(peak).toBe(3);
    });

    it("is FIFO within a site", async () => {
      const s = new InMemoryScheduler({ maxConcurrentPerSite: 1 });
      const order: string[] = [];
      const gate = deferredTask();
      const first = s.runForSite(opts("hn", "first"), gate.task);
      const rest = ["second", "third", "fourth"].map((name) =>
        s.runForSite(opts("hn", name), async () => {
          order.push(name);
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      gate.finish();
      await first;
      await Promise.all(rest);
      expect(order).toEqual(["second", "third", "fourth"]);
    });

    it("serves a full site's waiters in arrival order as slots free up", async () => {
      const s = new InMemoryScheduler({ maxConcurrentPerSite: 2 });
      const running = [deferredTask(), deferredTask()];
      const waiting = [deferredTask(), deferredTask(), deferredTask()];
      const runs = [...running, ...waiting].map((t, i) => s.runForSite(opts("hn", `t${i}`), t.task));
      await vi.advanceTimersByTimeAsync(0);
      expect(startedCount(waiting)).toBe(0);
      running[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(startCounts(waiting)).toEqual([1, 0, 0]);
      running[1]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(startCounts(waiting)).toEqual([1, 1, 0]);
      waiting[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(startCounts(waiting)).toEqual([1, 1, 1]);
      waiting[1]!.finish();
      waiting[2]!.finish();
      await Promise.all(runs);
    });
  });

  describe("global cap", () => {
    it("caps running tasks across all sites at maxConcurrentTasks (default 8)", async () => {
      const s = new InMemoryScheduler();
      const tasks = Array.from({ length: 9 }, () => deferredTask());
      // Three sites with three tasks each: the pools allow 9, the global cap 8.
      const runs = tasks.map((t, i) => s.runForSite(opts(`site${Math.floor(i / 3)}`, "search"), t.task));
      await vi.advanceTimersByTimeAsync(0);
      expect(startedCount(tasks)).toBe(8);
      expect(tasks[8]!.started).not.toHaveBeenCalled();
      tasks[0]!.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(tasks[8]!.started).toHaveBeenCalledOnce();
      tasks.slice(1).forEach((t) => t.finish());
      await Promise.all(runs);
    });

    it("admits waiters across sites in arrival order when the global cap frees a slot", async () => {
      const s = new InMemoryScheduler({ maxConcurrentTasks: 2 });
      const a = deferredTask();
      const b = deferredTask();
      const c = deferredTask();
      const d = deferredTask();
      const pa = s.runForSite(opts("a", "search"), a.task);
      const pb = s.runForSite(opts("b", "search"), b.task);
      const pc = s.runForSite(opts("c", "search"), c.task);
      const pd = s.runForSite(opts("a", "read"), d.task);
      await vi.advanceTimersByTimeAsync(0);
      expect(startCounts([a, b, c, d])).toEqual([1, 1, 0, 0]);
      b.finish();
      await pb;
      await vi.advanceTimersByTimeAsync(0);
      expect(c.started).toHaveBeenCalledOnce();
      expect(d.started).not.toHaveBeenCalled();
      a.finish();
      await pa;
      await vi.advanceTimersByTimeAsync(0);
      expect(d.started).toHaveBeenCalledOnce();
      c.finish();
      d.finish();
      await Promise.all([pc, pd]);
    });

    it("times out a waiter blocked by the global cap with a browser-busy message naming the tasks", async () => {
      const s = new InMemoryScheduler({ maxConcurrentTasks: 2 });
      const a = deferredTask();
      const b = deferredTask();
      const pa = s.runForSite(opts("a", "health check", { exclusive: true }), a.task);
      const pb = s.runForSite(opts("b", "search"), b.task);
      const pc = s.runForSite(opts("c", "search", { acquireTimeoutMs: 1000 }), async () => "x");
      const settled = expect(pc).rejects.toMatchObject({
        status: "timeout",
        message: "browser busy: 2 tasks running (a: health check, b: search)",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
      a.finish();
      b.finish();
      await Promise.all([pa, pb]);
    });
  });

  describe("exclusive tasks", () => {
    it("waits for the site's in-flight tasks, blocks new ones while waiting and running, then frees the site", async () => {
      const s = new InMemoryScheduler();
      const a = deferredTask();
      const b = deferredTask();
      const repair = deferredTask();
      const later = deferredTask();
      const pa = s.runForSite(opts("hn", "search"), a.task);
      const pb = s.runForSite(opts("hn", "fetch"), b.task);
      const pr = s.runForSite(opts("hn", "repair running", { exclusive: true }), repair.task);
      const pl = s.runForSite(opts("hn", "read"), later.task);
      await vi.advanceTimersByTimeAsync(0);
      // The pool has room for `later`, but it arrived after the exclusive waiter.
      expect(startCounts([a, b, repair, later])).toEqual([1, 1, 0, 0]);

      a.finish();
      await pa;
      await vi.advanceTimersByTimeAsync(0);
      expect(repair.started).not.toHaveBeenCalled();
      expect(later.started).not.toHaveBeenCalled();

      b.finish();
      await pb;
      await vi.advanceTimersByTimeAsync(0);
      expect(repair.started).toHaveBeenCalledOnce();
      expect(later.started).not.toHaveBeenCalled();
      expect(s.holders("hn")).toEqual(["repair running"]);

      repair.finish();
      await pr;
      await vi.advanceTimersByTimeAsync(0);
      expect(later.started).toHaveBeenCalledOnce();
      later.finish();
      await pl;
      expect(s.isIdle("hn")).toBe(true);
    });

    it("holds the site alone: tasks arriving while it runs wait; other sites are unaffected", async () => {
      const s = new InMemoryScheduler();
      const check = deferredTask();
      const search = deferredTask();
      const other = deferredTask();
      const pc = s.runForSite(opts("hn", "health check", { exclusive: true }), check.task);
      const ps = s.runForSite(opts("hn", "search"), search.task);
      const po = s.runForSite(opts("other", "search"), other.task);
      await vi.advanceTimersByTimeAsync(0);
      expect(check.started).toHaveBeenCalledOnce();
      expect(search.started).not.toHaveBeenCalled();
      expect(other.started).toHaveBeenCalledOnce();
      check.finish();
      await pc;
      await vi.advanceTimersByTimeAsync(0);
      expect(search.started).toHaveBeenCalledOnce();
      search.finish();
      other.finish();
      await Promise.all([ps, po]);
    });

    it("never overlaps any task of its site", async () => {
      const s = new InMemoryScheduler({ maxConcurrentTasks: 50 });
      const live = new Set<string>();
      const overlaps: string[] = [];
      const runs = Array.from({ length: 15 }, (_, i) => {
        const exclusive = i % 4 === 1;
        const name = `${exclusive ? "x" : "t"}${i}`;
        return s.runForSite(opts("hn", name, { exclusive }), async () => {
          if (exclusive && live.size > 0) overlaps.push(`${name} with ${[...live].join(",")}`);
          if (!exclusive && [...live].some((n) => n.startsWith("x")))
            overlaps.push(`${name} during exclusive`);
          live.add(name);
          await new Promise((r) => setTimeout(r, 50 + (i % 3) * 20));
          live.delete(name);
        });
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(runs);
      expect(overlaps).toEqual([]);
    });

    it("times out an exclusive waiter like any waiter, naming the running tasks", async () => {
      const s = new InMemoryScheduler();
      const tasks = [deferredTask(), deferredTask(), deferredTask()];
      const runs = ["search", "search", "fetch"].map((name, i) =>
        s.runForSite(opts("hn", name), tasks[i]!.task),
      );
      const waiter = vi.fn(async () => "never");
      const pw = s.runForSite(
        opts("hn", "health check", { exclusive: true, acquireTimeoutMs: 5000 }),
        waiter,
      );
      const settled = expect(pw).rejects.toMatchObject({
        status: "timeout",
        message: "site busy: 3 tasks running (search, search, fetch)",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
      expect(waiter).not.toHaveBeenCalled();
      tasks.forEach((t) => t.finish());
      await Promise.all(runs);
      expect(s.isIdle("hn")).toBe(true);
    });
  });

  describe("busy messages", () => {
    it("names the exclusive holder when one holds the site", async () => {
      const s = new InMemoryScheduler();
      const repair = deferredTask();
      const pr = s.runForSite(opts("reuters", "repair running", { exclusive: true }), repair.task);
      const waiter = vi.fn(async () => "never");
      const pw = s.runForSite(opts("reuters", "search", { acquireTimeoutMs: 5000 }), waiter);
      const settled = expect(pw).rejects.toMatchObject({
        status: "timeout",
        message: "site busy: repair running",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await settled;
      await expect(pw).rejects.toBeInstanceOf(OutcomeError);
      expect(waiter).not.toHaveBeenCalled();
      repair.finish();
      await pr;
      expect(s.isIdle("reuters")).toBe(true);
    });

    it("names every running task when the pool is full", async () => {
      const s = new InMemoryScheduler();
      const tasks = [deferredTask(), deferredTask(), deferredTask()];
      const runs = ["search", "search", "fetch"].map((name, i) =>
        s.runForSite(opts("reuters", name), tasks[i]!.task),
      );
      const pw = s.runForSite(opts("reuters", "read", { acquireTimeoutMs: 2000 }), async () => "x");
      const settled = expect(pw).rejects.toMatchObject({
        status: "timeout",
        message: "site busy: 3 tasks running (search, search, fetch)",
      });
      await vi.advanceTimersByTimeAsync(2000);
      await settled;
      tasks.forEach((t) => t.finish());
      await Promise.all(runs);
    });

    it("uses the singular for one running task", async () => {
      const s = new InMemoryScheduler({ maxConcurrentPerSite: 1 });
      const a = deferredTask();
      const pa = s.runForSite(opts("hn", "search"), a.task);
      const pw = s.runForSite(opts("hn", "read", { acquireTimeoutMs: 1000 }), async () => "x");
      const settled = expect(pw).rejects.toMatchObject({ message: "site busy: 1 task running (search)" });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
      a.finish();
      await pa;
    });
  });

  describe("politeness", () => {
    it("spaces one task's own page loads by the politeness interval", async () => {
      const s = new InMemoryScheduler();
      const loads: number[] = [];
      const run = s.runForSite(opts("hn", "search", { minIntervalMs: 1500 }), async (lease) => {
        await lease.beforePageLoad();
        loads.push(Date.now());
        await lease.beforePageLoad();
        loads.push(Date.now());
      });
      await vi.advanceTimersByTimeAsync(5000);
      await run;
      expect(loads[1]! - loads[0]!).toBe(1500);
    });

    it("spaces parallel tasks of one site only by the start stagger, not by each other's loads", async () => {
      const s = new InMemoryScheduler({ concurrentStaggerMs: 500 });
      const t0 = Date.now();
      const loads: Record<string, number[]> = { a: [], b: [], c: [] };
      const task = (name: string) => async (lease: SiteLease) => {
        for (let i = 0; i < 2; i += 1) {
          await lease.beforePageLoad();
          loads[name]!.push(Date.now() - t0);
        }
      };
      const runs = ["a", "b", "c"].map((name) =>
        s.runForSite(opts("hn", "search", { minIntervalMs: 1500 }), task(name)),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(runs);
      expect(loads).toEqual({ a: [0, 1500], b: [500, 2000], c: [1000, 2500] });
    });

    it("applies no stagger to a task that starts while the site is idle", async () => {
      const s = new InMemoryScheduler();
      const t0 = Date.now();
      const loads: number[] = [];
      await s.runForSite(opts("hn", "search", { minIntervalMs: 3000 }), async (lease) => {
        await lease.beforePageLoad();
        loads.push(Date.now() - t0);
      });
      await vi.advanceTimersByTimeAsync(100);
      const next = s.runForSite(opts("hn", "read", { minIntervalMs: 3000 }), async (lease) => {
        await lease.beforePageLoad();
        loads.push(Date.now() - t0);
      });
      await vi.advanceTimersByTimeAsync(5000);
      await next;
      // The first task is over, so the second starts at once: the stagger only separates tasks that
      // overlap, and the site-wide 3 s interval no longer applies across tasks.
      expect(loads).toEqual([0, 100]);
    });

    it("reserves politeness slots for concurrent page loads within one lease", async () => {
      const s = new InMemoryScheduler();
      const loads: number[] = [];
      const run = s.runForSite(opts("hn", "search", { minIntervalMs: 1000 }), async (lease) => {
        await Promise.all(
          [0, 1, 2].map(async () => {
            await lease.beforePageLoad();
            loads.push(Date.now());
          }),
        );
      });
      await vi.advanceTimersByTimeAsync(5000);
      await run;
      const t0 = loads[0]!;
      expect(loads.map((t) => t - t0)).toEqual([0, 1000, 2000]);
    });

    it("exposes the next allowed load time and records loads made inside page scripts, per task", async () => {
      const s = new InMemoryScheduler({ concurrentStaggerMs: 1 });
      const a = deferredTask();
      const b = deferredTask();
      const pa = s.runForSite(opts("hn", "search", { minIntervalMs: 2000 }), a.task);
      const pb = s.runForSite(opts("hn", "read", { minIntervalMs: 2000 }), b.task);
      await vi.advanceTimersByTimeAsync(0);
      const now = Date.now();
      expect(a.lease?.minIntervalMs).toBe(2000);
      expect(a.lease?.nextPageLoadAt?.()).toBe(now);
      a.lease?.recordPageLoad?.(now + 100);
      expect(a.lease?.nextPageLoadAt?.()).toBe(now + 2100);
      // The other task's spacing is its own: only the start stagger applies.
      expect(b.lease?.nextPageLoadAt?.()).toBe(now + 1);
      a.finish();
      b.finish();
      await Promise.all([pa, pb]);
    });

    it("does not space page loads across different sites", async () => {
      const s = new InMemoryScheduler();
      const t0 = Date.now();
      await s.runForSite(opts("a", "search"), (lease) => lease.beforePageLoad());
      await s.runForSite(opts("b", "search"), (lease) => lease.beforePageLoad());
      expect(Date.now() - t0).toBe(0);
    });
  });

  describe("cool-down", () => {
    it("refuses work during a cool-down unless told to ignore it", async () => {
      const s = new InMemoryScheduler();
      const until = Date.now() + 600_000;
      s.setCooldown("reuters", until);
      expect(s.cooldownUntil("reuters")).toBe(until);
      const task = vi.fn(async () => "ran");
      await expect(s.runForSite(opts("reuters", "search"), task)).rejects.toMatchObject({
        status: "rate_limited",
      });
      expect(task).not.toHaveBeenCalled();
      await expect(s.runForSite(opts("reuters", "check now", { ignoreCooldown: true }), task)).resolves.toBe(
        "ran",
      );
      vi.setSystemTime(until + 1);
      expect(s.cooldownUntil("reuters")).toBeNull();
      await expect(s.runForSite(opts("reuters", "search"), task)).resolves.toBe("ran");
    });

    it("clearCooldown ends a cool-down at once", async () => {
      const s = new InMemoryScheduler();
      s.setCooldown("reuters", Date.now() + 600_000);
      s.clearCooldown("reuters");
      expect(s.cooldownUntil("reuters")).toBeNull();
      s.clearCooldown("never-seen");
      expect(s.cooldownUntil("never-seen")).toBeNull();
    });

    it("starts the cool-down automatically when a task reports rate_limited", async () => {
      const s = new InMemoryScheduler({ coolDownMs: 600_000 });
      const now = Date.now();
      await expect(
        s.runForSite(opts("reuters", "search"), async () => {
          throw new OutcomeError("rate_limited", "throttled");
        }),
      ).rejects.toMatchObject({ status: "rate_limited" });
      expect(s.cooldownUntil("reuters")).toBe(now + 600_000);
    });

    it("does not start a cool-down for a block page (access_denied)", async () => {
      const s = new InMemoryScheduler({ coolDownMs: 600_000 });
      await expect(
        s.runForSite(opts("reuters", "search"), async () => {
          throw new OutcomeError("access_denied", "captcha page");
        }),
      ).rejects.toMatchObject({ status: "access_denied" });
      expect(s.cooldownUntil("reuters")).toBeNull();
    });
  });

  describe("budgets and cancellation", () => {
    it("enforces the call budget: aborts the lease and rejects with timeout, keeping the slot until the task settles", async () => {
      const s = new InMemoryScheduler();
      let leaseSignal: AbortSignal | undefined;
      let release!: () => void;
      const p = s.runForSite(opts("hn", "search", { budgetMs: 90_000 }), (lease) => {
        leaseSignal = lease.signal;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const settled = expect(p).rejects.toMatchObject({
        status: "timeout",
        message: "time budget exceeded (90 s)",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await settled;
      expect(leaseSignal?.aborted).toBe(true);
      expect(s.holders("hn")).toEqual(["search"]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.holders("hn")).toEqual([]);
    });

    it("aborts the lease when the caller's signal aborts", async () => {
      const s = new InMemoryScheduler();
      const ac = new AbortController();
      let leaseSignal: AbortSignal | undefined;
      const p = s.runForSite(opts("hn", "search", { signal: ac.signal }), async (lease) => {
        leaseSignal = lease.signal;
        await new Promise((r) => setTimeout(r, 10_000));
        return "late";
      });
      await vi.advanceTimersByTimeAsync(0);
      ac.abort();
      expect(leaseSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toBe("late");
    });

    it("removes a waiter whose caller aborts before it starts", async () => {
      const s = new InMemoryScheduler();
      const a = deferredTask();
      const pa = s.runForSite(opts("hn", "repair running", { exclusive: true }), a.task);
      const ac = new AbortController();
      const waiter = vi.fn(async () => "x");
      const pw = s.runForSite(opts("hn", "search", { signal: ac.signal }), waiter);
      ac.abort();
      await expect(pw).rejects.toMatchObject({ status: "timeout" });
      a.finish();
      await pa;
      await vi.advanceTimersByTimeAsync(0);
      expect(waiter).not.toHaveBeenCalled();
      expect(s.isIdle("hn")).toBe(true);
    });

    it("a dropped exclusive waiter no longer blocks the tasks queued behind it", async () => {
      const s = new InMemoryScheduler();
      const a = deferredTask();
      const later = deferredTask();
      const pa = s.runForSite(opts("hn", "search"), a.task);
      const px = s.runForSite(
        opts("hn", "health check", { exclusive: true, acquireTimeoutMs: 1000 }),
        async () => "x",
      );
      const pl = s.runForSite(opts("hn", "read"), later.task);
      await vi.advanceTimersByTimeAsync(0);
      expect(later.started).not.toHaveBeenCalled();
      const settled = expect(px).rejects.toMatchObject({ status: "timeout" });
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
      expect(later.started).toHaveBeenCalledOnce();
      a.finish();
      later.finish();
      await Promise.all([pa, pl]);
    });

    it("releases the slot when a task throws", async () => {
      const s = new InMemoryScheduler();
      await expect(
        s.runForSite(opts("hn", "search"), async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(s.isIdle("hn")).toBe(true);
      await expect(s.runForSite(opts("hn", "search"), async () => 1)).resolves.toBe(1);
    });
  });

  describe("isIdle", () => {
    it("is false while a task of the site runs or waits, true when it has neither", async () => {
      const s = new InMemoryScheduler({ maxConcurrentTasks: 1 });
      const a = deferredTask();
      const b = deferredTask();
      expect(s.isIdle("b")).toBe(true);
      const pa = s.runForSite(opts("a", "search"), a.task);
      const pb = s.runForSite(opts("b", "search"), b.task);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.isIdle("a")).toBe(false);
      // b only waits (global cap), which still counts as busy.
      expect(s.holders("b")).toEqual([]);
      expect(s.isIdle("b")).toBe(false);
      a.finish();
      await pa;
      await vi.advanceTimersByTimeAsync(0);
      b.finish();
      await pb;
      expect(s.isIdle("a")).toBe(true);
      expect(s.isIdle("b")).toBe(true);
    });
  });
});
