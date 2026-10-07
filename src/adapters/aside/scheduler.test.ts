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

describe("InMemoryScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one task per site at a time (site lock) and reports the holder", async () => {
    const s = new InMemoryScheduler();
    const a = deferredTask();
    const b = deferredTask();
    const pa = s.runForSite(opts("reuters", "search"), a.task);
    const pb = s.runForSite(opts("reuters", "read"), b.task);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.started).toHaveBeenCalledOnce();
    expect(b.started).not.toHaveBeenCalled();
    expect(s.currentHolder("reuters")).toBe("search");
    expect(s.isIdle("reuters")).toBe(false);
    a.finish("A");
    await expect(pa).resolves.toBe("A");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.started).toHaveBeenCalledOnce();
    expect(s.currentHolder("reuters")).toBe("read");
    b.finish("B");
    await expect(pb).resolves.toBe("B");
    expect(s.currentHolder("reuters")).toBeNull();
    expect(s.isIdle("reuters")).toBe(true);
  });

  it("is FIFO within a site", async () => {
    const s = new InMemoryScheduler();
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

  it("caps concurrently active sites globally and admits the next site when one finishes", async () => {
    const s = new InMemoryScheduler({ maxConcurrentSites: 2 });
    const a = deferredTask();
    const b = deferredTask();
    const c = deferredTask();
    const pa = s.runForSite(opts("a", "search"), a.task);
    const pb = s.runForSite(opts("b", "search"), b.task);
    const pc = s.runForSite(opts("c", "search"), c.task);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.started).toHaveBeenCalled();
    expect(b.started).toHaveBeenCalled();
    expect(c.started).not.toHaveBeenCalled();
    b.finish();
    await pb;
    await vi.advanceTimersByTimeAsync(0);
    expect(c.started).toHaveBeenCalled();
    a.finish();
    c.finish();
    await Promise.all([pa, pc]);
  });

  it("defaults the global cap to 4 sites", async () => {
    const s = new InMemoryScheduler();
    const tasks = ["a", "b", "c", "d", "e"].map(() => deferredTask());
    const runs = tasks.map((t, i) => s.runForSite(opts(`site${i}`, "search"), t.task));
    await vi.advanceTimersByTimeAsync(0);
    expect(tasks.filter((t) => t.started.mock.calls.length > 0)).toHaveLength(4);
    tasks.slice(0, 4).forEach((t) => t.finish());
    await vi.advanceTimersByTimeAsync(0);
    expect(tasks[4]!.started).toHaveBeenCalled();
    tasks[4]!.finish();
    await Promise.all(runs);
  });

  it("times out a waiter with a message naming the holder", async () => {
    const s = new InMemoryScheduler();
    const repair = deferredTask();
    const pr = s.runForSite(opts("reuters", "repair running"), repair.task);
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

  it("times out a waiter blocked by the global cap with a browser-busy message", async () => {
    const s = new InMemoryScheduler({ maxConcurrentSites: 1 });
    const a = deferredTask();
    const pa = s.runForSite(opts("a", "health check"), a.task);
    const pb = s.runForSite(opts("b", "search", { acquireTimeoutMs: 1000 }), async () => "x");
    const settled = expect(pb).rejects.toMatchObject({
      status: "timeout",
      message: "browser busy: 1 site active (a: health check)",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
    a.finish();
    await pa;
  });

  it("spaces page loads on one site by the politeness interval", async () => {
    const s = new InMemoryScheduler();
    const loads: number[] = [];
    const run = s.runForSite(opts("hn", "search", { minIntervalMs: 1500 }), async (lease) => {
      await lease.beforePageLoad();
      loads.push(Date.now());
      await lease.beforePageLoad();
      loads.push(Date.now());
    });
    // The interval carries over to the next task on the same site (queued behind the first).
    const next = s.runForSite(opts("hn", "read", { minIntervalMs: 1500 }), async (lease) => {
      await lease.beforePageLoad();
      loads.push(Date.now());
    });
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    await next;
    expect(loads[1]! - loads[0]!).toBe(1500);
    expect(loads[2]! - loads[1]!).toBe(1500);
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

  it("exposes the next allowed load time and records loads made inside page scripts", async () => {
    const s = new InMemoryScheduler();
    await s.runForSite(opts("hn", "search", { minIntervalMs: 2000 }), async (lease) => {
      const now = Date.now();
      expect(lease.minIntervalMs).toBe(2000);
      expect(lease.nextPageLoadAt?.()).toBe(now);
      lease.recordPageLoad?.(now + 100);
      expect(lease.nextPageLoadAt?.()).toBe(now + 2100);
    });
  });

  it("does not space page loads across different sites", async () => {
    const s = new InMemoryScheduler();
    const t0 = Date.now();
    await s.runForSite(opts("a", "search"), (lease) => lease.beforePageLoad());
    await s.runForSite(opts("b", "search"), (lease) => lease.beforePageLoad());
    expect(Date.now() - t0).toBe(0);
  });

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
        throw new OutcomeError("rate_limited", "captcha page");
      }),
    ).rejects.toMatchObject({ status: "rate_limited" });
    expect(s.cooldownUntil("reuters")).toBe(now + 600_000);
  });

  it("enforces the call budget: aborts the lease and rejects with timeout, keeping the lock until the task settles", async () => {
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
    expect(s.currentHolder("hn")).toBe("search");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.currentHolder("hn")).toBeNull();
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

  it("removes a waiter whose caller aborts before it acquires the lock", async () => {
    const s = new InMemoryScheduler();
    const a = deferredTask();
    const pa = s.runForSite(opts("hn", "repair running"), a.task);
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

  it("releases the lock when a task throws", async () => {
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
