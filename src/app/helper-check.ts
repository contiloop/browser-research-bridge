/**
 * The helper check outside the core: the last result, persisted (`data/helper-check.json` through
 * an injected record store, so it survives core and process restarts), and the automatic check.
 *
 * Automatic check (spec 4.2): after each core start, a little later so startup is not slowed, one
 * check runs by itself when all of these hold at that moment:
 * - no job is queued or running (the runtime would be busy);
 * - the runtime a job would use now is installed and its sign-in is not known to be missing (the
 *   local probe through `helperStatus`, no model call);
 * - no `ok` is recorded for that runtime (an `ok` on Claude does not cover Codex);
 * - no check (automatic or the Check button) ran on this core yet, so a `limit_reached` or `failed`
 *   result is not retried before the next core start.
 * A change of the helper runtime setting restarts the core, so "after a core start" plus "no ok for
 * the runtime now in use" also covers "again after the runtime changes". A working install therefore
 * spends at most one request per runtime change, not one per start.
 *
 * The Check button (`run`) always makes its request and replaces the record. A check already in
 * progress on the same core is shared rather than repeated. Logs carry metadata only (runtime, code,
 * trigger, skip reason), never the runtime's message.
 */
import type {
  HelperCheckResult,
  HelperRuntimeId,
  OnboardingJobService,
} from "../adapters/onboarding/index.js";
import { HELPER_CHECK_CODES, isHelperRuntimeId } from "../adapters/onboarding/index.js";
import type { HelperCheckLog } from "../adapters/dashboard/index.js";
import type { HelperCheckRecord } from "../adapters/storage/index.js";
import type { Logger } from "../ports/logger.js";

/** How long after a core start the automatic check waits. */
export const HELPER_AUTO_CHECK_DELAY_MS = 30_000;

/** Where the last check is kept (production: `FileHelperCheckStore` over `data/helper-check.json`). */
export interface HelperCheckRecordStore {
  load(): Promise<HelperCheckRecord | null>;
  save(record: HelperCheckRecord): Promise<void>;
}

/** What the automatic check needs from the running core's job service. */
export type HelperCheckJobs = Pick<OnboardingJobService, "helperCheck" | "helperStatus" | "list">;

export type AutomaticCheckSkip =
  "job_active" | "unavailable" | "already_ok" | "already_checked" | "superseded";

export type AutomaticCheckOutcome =
  { ran: true; result: HelperCheckResult } | { ran: false; reason: AutomaticCheckSkip };

export interface HelperChecksOptions {
  store: HelperCheckRecordStore;
  logger: Logger;
  /** Delay of the automatic check after a core start (default {@link HELPER_AUTO_CHECK_DELAY_MS}). */
  delayMs?: number | undefined;
}

type Trigger = "manual" | "automatic";

export class HelperChecks implements HelperCheckLog {
  private readonly store: HelperCheckRecordStore;
  private readonly logger: Logger;
  private readonly delayMs: number;
  /** undefined until loaded from the store. */
  private cached: HelperCheckResult | null | undefined = undefined;
  private inFlight: { jobs: object; promise: Promise<HelperCheckResult> } | null = null;
  /** Job services (one per core) that already had a check. */
  private readonly checkedCores = new WeakSet<object>();
  /** Bumped by every schedule and cancel; a pending automatic check of an older one gives up. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private finishPending: (() => void) | null = null;

  constructor(options: HelperChecksOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.delayMs = options.delayMs ?? HELPER_AUTO_CHECK_DELAY_MS;
  }

  async last(): Promise<HelperCheckResult | null> {
    if (this.cached !== undefined) return this.cached;
    let loaded: HelperCheckResult | null = null;
    try {
      loaded = fromRecord(await this.store.load());
    } catch (error) {
      this.logger.warn("helper check record unreadable", { error: (error as Error).message });
    }
    // A check recorded while the file was being read wins.
    if (this.cached === undefined) this.cached = loaded;
    return this.cached;
  }

  /** The Check button: one request on this core (shared with one in progress), recorded. */
  run(jobs: Pick<HelperCheckJobs, "helperCheck">): Promise<HelperCheckResult> {
    return this.check(jobs, "manual");
  }

  /** Core-started hook: the automatic check after the delay (replaces one still pending). */
  scheduleAutomatic(jobs: HelperCheckJobs): void {
    this.cancelAutomatic();
    const generation = this.generation;
    this.pending = new Promise<void>((resolve) => (this.finishPending = resolve));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.automatic(jobs, generation)
        .catch((error: unknown) => {
          this.logger.warn("automatic helper check failed", { error: (error as Error).message });
        })
        .finally(() => {
          if (generation === this.generation) this.resolvePending();
        });
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Core-stopping hook: a pending automatic check does not start. */
  cancelAutomatic(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.resolvePending();
  }

  /** Resolves once the scheduled automatic check has run, been skipped, or been cancelled (tests). */
  settled(): Promise<void> {
    return this.pending;
  }

  /**
   * The automatic check's decision and run, without the delay. `generation` (internal) ties it to
   * the schedule that started it, so a core that stopped meanwhile does not start a request.
   */
  async automatic(jobs: HelperCheckJobs, generation = this.generation): Promise<AutomaticCheckOutcome> {
    const skip = (
      reason: AutomaticCheckSkip,
      runtime: HelperRuntimeId | null = null,
    ): AutomaticCheckOutcome => {
      this.logger.info("automatic helper check skipped", { reason, runtime });
      return { ran: false, reason };
    };
    if (this.checkedCores.has(jobs)) return skip("already_checked");
    if (jobs.list().some((j) => j.state === "running" || j.state === "queued")) return skip("job_active");
    const status = await jobs.helperStatus(null);
    if (generation !== this.generation) return skip("superseded");
    const runtime = status.wouldUse;
    if (runtime === null) return skip("unavailable");
    const last = await this.last();
    if (last !== null && last.ok && last.runtime === runtime) return skip("already_ok", runtime);
    // Checked again right before the request: the state may have changed while probing.
    if (generation !== this.generation) return skip("superseded", runtime);
    if (this.checkedCores.has(jobs)) return skip("already_checked", runtime);
    if (jobs.list().some((j) => j.state === "running" || j.state === "queued"))
      return skip("job_active", runtime);
    return { ran: true, result: await this.check(jobs, "automatic") };
  }

  private check(jobs: Pick<HelperCheckJobs, "helperCheck">, trigger: Trigger): Promise<HelperCheckResult> {
    this.checkedCores.add(jobs);
    if (this.inFlight !== null && this.inFlight.jobs === jobs) return this.inFlight.promise;
    const promise = (async () => {
      const result = await jobs.helperCheck();
      await this.record(result);
      this.logger.info("helper check", { runtime: result.runtime, code: result.code, trigger });
      return result;
    })();
    const entry = { jobs, promise };
    this.inFlight = entry;
    const clear = (): void => {
      if (this.inFlight === entry) this.inFlight = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async record(result: HelperCheckResult): Promise<void> {
    this.cached = result;
    try {
      await this.store.save({
        at: result.at,
        runtime: result.runtime,
        result: result.code,
        message: result.message,
      });
    } catch (error) {
      this.logger.warn("helper check could not be recorded", { error: (error as Error).message });
    }
  }

  private resolvePending(): void {
    const finish = this.finishPending;
    this.finishPending = null;
    finish?.();
  }
}

/** A stored record as a check result; null when it names an unknown runtime or code. */
function fromRecord(record: HelperCheckRecord | null): HelperCheckResult | null {
  if (record === null) return null;
  const code = HELPER_CHECK_CODES.find((c) => c === record.result);
  if (code === undefined) return null;
  if (record.runtime !== null && !isHelperRuntimeId(record.runtime)) return null;
  return { at: record.at, runtime: record.runtime, ok: code === "ok", code, message: record.message };
}
