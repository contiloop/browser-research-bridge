/**
 * A scripted `SiteAssistant` (the Aside AI port) for coordinator, service, health, and app tests. The real
 * Aside CLI is never run in tests; this fake records each task and answers with the verdict the test
 * scripts, at once or when the test releases it.
 *
 * - `next(result)` queues the result of a later task (default: `done`);
 * - `hold()` makes every later task wait until `release(result)` (or its signal fires, which answers
 *   `failed`/`timed_out` like the real adapter); `unhold()` ends that for later tasks;
 * - `availableValue` is what `available()` answers; `probes` counts the calls (and `reprobes` those
 *   with `{ reprobe: true }`).
 */
import type {
  AssistantAvailabilityOptions,
  AssistantResult,
  AssistantTask,
  SiteAssistant,
} from "../../src/ports/assistant.js";

export interface HeldTask {
  task: AssistantTask;
  release(result?: Partial<AssistantResult>): void;
}

export class FakeSiteAssistant implements SiteAssistant {
  /** Every task given to `run`, in order. */
  readonly tasks: AssistantTask[] = [];
  /** What `available()` answers. */
  availableValue = true;
  probes = 0;
  reprobes = 0;
  /** Tasks waiting for `release` while `hold()` is on. */
  readonly held: HeldTask[] = [];
  private readonly queued: Partial<AssistantResult>[] = [];
  private holding = false;
  private readonly settledWaiters: (() => void)[] = [];
  private active = 0;

  /** Queues the result of the next task that is not held (default `done`). */
  next(result: Partial<AssistantResult>): this {
    this.queued.push(result);
    return this;
  }

  /** Every later task waits for `release` (or its signal). */
  hold(): this {
    this.holding = true;
    return this;
  }

  /** Later tasks answer at once again (tasks already held keep waiting for `release`). */
  unhold(): this {
    this.holding = false;
    return this;
  }

  /** Releases the oldest held task with `result` (default `done`). */
  release(result: Partial<AssistantResult> = {}): void {
    const task = this.held.shift();
    if (task === undefined) throw new Error("fake assistant: no held task");
    task.release(result);
  }

  /** Resolves when no task is running. */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  available(options: AssistantAvailabilityOptions = {}): Promise<boolean> {
    this.probes += 1;
    if (options.reprobe === true) this.reprobes += 1;
    return Promise.resolve(this.availableValue);
  }

  async run(task: AssistantTask): Promise<AssistantResult> {
    this.tasks.push(task);
    this.active += 1;
    try {
      const partial = this.holding ? await this.wait(task) : (this.queued.shift() ?? {});
      return complete(partial);
    } finally {
      this.active -= 1;
      if (this.active === 0) for (const w of this.settledWaiters.splice(0)) w();
    }
  }

  private wait(task: AssistantTask): Promise<Partial<AssistantResult>> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: Partial<AssistantResult>): void => {
        if (done) return;
        done = true;
        task.signal?.removeEventListener("abort", onAbort);
        const index = this.held.findIndex((h) => h.task === task);
        if (index !== -1) this.held.splice(index, 1);
        resolve(result);
      };
      const onAbort = (): void => finish({ verdict: "failed", reason: "timed_out" });
      if (task.signal?.aborted) return onAbort();
      task.signal?.addEventListener("abort", onAbort, { once: true });
      this.held.push({ task, release: (result = {}) => finish(result) });
    });
  }
}

function complete(partial: Partial<AssistantResult>): AssistantResult {
  const verdict = partial.verdict ?? "done";
  return {
    verdict,
    reason: partial.reason !== undefined ? partial.reason : verdict === "done" ? null : "other",
    sessionId: partial.sessionId !== undefined ? partial.sessionId : "sess-1",
    durationMs: partial.durationMs ?? 5,
  };
}
