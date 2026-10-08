/**
 * The persisted helper check and its automatic trigger, with a fake job service (no model call)
 * and the real record file in a temp folder.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { makeTempDir } from "../../test/support/site-fixtures.js";
import type {
  HelperCheckCode,
  HelperCheckResult,
  HelperRuntimeId,
  HelperStatus,
  JobState,
  OnboardingJob,
} from "../adapters/onboarding/index.js";
import { FileHelperCheckStore, helperCheckPath } from "../adapters/storage/index.js";
import { HelperChecks } from "./helper-check.js";

interface FakeJobs {
  wouldUse: HelperRuntimeId | null;
  states: JobState[];
  code: HelperCheckCode;
  /** When set, the check waits for it (in-flight sharing). */
  gate: Promise<void> | null;
  helperCheck: ReturnType<typeof vi.fn<() => Promise<HelperCheckResult>>>;
  helperStatus: ReturnType<typeof vi.fn<(last?: HelperCheckResult | null) => Promise<HelperStatus>>>;
  list: () => OnboardingJob[];
}

function fakeJobs(patch: Partial<Pick<FakeJobs, "wouldUse" | "states" | "code">> = {}): FakeJobs {
  const jobs: FakeJobs = {
    wouldUse: "claude",
    states: [],
    code: "ok",
    gate: null,
    ...patch,
    helperCheck: vi.fn(async (): Promise<HelperCheckResult> => {
      if (jobs.gate) await jobs.gate;
      return {
        at: "2026-10-08T00:00:00.000Z",
        runtime: jobs.wouldUse,
        ok: jobs.code === "ok",
        code: jobs.code,
        message: jobs.code === "ok" ? "round trip passed" : "usage limit reached",
      };
    }),
    helperStatus: vi.fn(async (lastCheck: HelperCheckResult | null = null): Promise<HelperStatus> => ({
      configured: "auto",
      supported: ["claude", "codex"],
      runtimes: {
        claude: { installed: jobs.wouldUse === "claude", signedIn: null },
        codex: { installed: jobs.wouldUse === "codex", signedIn: true },
      },
      wouldUse: jobs.wouldUse,
      lastCheck,
    })),
    list: () => jobs.states.map((state, i) => ({ id: `job-${i}`, state }) as unknown as OnboardingJob),
  };
  return jobs;
}

describe("HelperChecks: persisted last check and the automatic check", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let logger: MemoryLogger;
  beforeEach(async () => {
    tmp = await makeTempDir("brb-helper-check-");
    logger = new MemoryLogger();
  });
  afterEach(async () => tmp.cleanup());

  const path = () => helperCheckPath(join(tmp.dir, "data"));
  const keeper = (delayMs = 0) =>
    new HelperChecks({ store: new FileHelperCheckStore(path()), logger, delayMs });

  it("a check is recorded in data/helper-check.json as { at, runtime, result } and read back by a new process", async () => {
    const checks = keeper();
    expect(await checks.last()).toBeNull();
    const jobs = fakeJobs();
    const result = await checks.run(jobs);
    expect(result).toMatchObject({ runtime: "claude", ok: true, code: "ok" });
    expect(await checks.last()).toEqual(result);
    const raw = JSON.parse(await readFile(path(), "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({
      version: 1,
      at: result.at,
      runtime: "claude",
      result: "ok",
      message: "round trip passed",
    });
    // A new process (a new keeper over the same file) sees the same last check.
    expect(await keeper().last()).toEqual(result);
    expect(
      logger.lines.some((l) => l.startsWith("info helper check ") && l.includes('"trigger":"manual"')),
    ).toBe(true);
  });

  it("an unreadable or foreign record counts as no check", async () => {
    await new FileHelperCheckStore(path()).save({ at: "x", runtime: "gpt", result: "ok", message: null });
    expect(await keeper().last()).toBeNull();
    await writeFile(path(), "{ broken");
    expect(await keeper().last()).toBeNull();
  });

  it("runs once after a core start and records the result", async () => {
    const checks = keeper();
    const jobs = fakeJobs();
    checks.scheduleAutomatic(jobs);
    await checks.settled();
    expect(jobs.helperCheck).toHaveBeenCalledTimes(1);
    expect(await checks.last()).toMatchObject({ runtime: "claude", code: "ok" });
    expect(
      logger.lines.some((l) => l.startsWith("info helper check ") && l.includes('"trigger":"automatic"')),
    ).toBe(true);
  });

  it("does not run when an ok check is recorded for the runtime a job would use now", async () => {
    await keeper().run(fakeJobs());
    const checks = keeper();
    const jobs = fakeJobs();
    expect(await checks.automatic(jobs)).toEqual({ ran: false, reason: "already_ok" });
    expect(jobs.helperCheck).not.toHaveBeenCalled();
  });

  it("runs again after the runtime changed (an ok on Claude does not cover Codex)", async () => {
    await keeper().run(fakeJobs({ wouldUse: "claude" }));
    const checks = keeper();
    const codex = fakeJobs({ wouldUse: "codex" });
    expect(await checks.automatic(codex)).toMatchObject({
      ran: true,
      result: { runtime: "codex", code: "ok" },
    });
    expect(codex.helperCheck).toHaveBeenCalledTimes(1);
    // Back to Claude: the record now names Codex, so Claude is checked again.
    const claude = fakeJobs({ wouldUse: "claude" });
    expect(await checks.automatic(claude)).toMatchObject({ ran: true, result: { runtime: "claude" } });
  });

  it("never runs while a job is running or queued", async () => {
    const checks = keeper();
    for (const state of ["running", "queued"] as const) {
      const jobs = fakeJobs({ states: ["succeeded", state] });
      expect(await checks.automatic(jobs)).toEqual({ ran: false, reason: "job_active" });
      expect(jobs.helperCheck).not.toHaveBeenCalled();
    }
    // A paused or finished job does not block it.
    const idle = fakeJobs({ states: ["awaiting_user", "failed", "succeeded", "cancelled"] });
    expect((await checks.automatic(idle)).ran).toBe(true);
  });

  it("never runs when the probe says the runtime is not installed or not signed in", async () => {
    const checks = keeper();
    const jobs = fakeJobs({ wouldUse: null });
    expect(await checks.automatic(jobs)).toEqual({ ran: false, reason: "unavailable" });
    expect(jobs.helperCheck).not.toHaveBeenCalled();
    expect(await checks.last()).toBeNull();
  });

  it("a failed or limit_reached result is recorded and not retried until the next core start", async () => {
    for (const code of ["failed", "limit_reached"] as const) {
      const checks = keeper();
      const first = fakeJobs({ code });
      expect(await checks.automatic(first)).toMatchObject({ ran: true, result: { code } });
      expect(await checks.last()).toMatchObject({ ok: false, code });
      // Same core: not again.
      expect(await checks.automatic(first)).toEqual({ ran: false, reason: "already_checked" });
      expect(first.helperCheck).toHaveBeenCalledTimes(1);
      // The next core start (a new job service) tries again, since no ok is recorded.
      const next = fakeJobs({ code });
      expect((await checks.automatic(next)).ran).toBe(true);
      expect(next.helperCheck).toHaveBeenCalledTimes(1);
    }
  });

  it("a manual check during this core start stands in for the automatic one", async () => {
    const checks = keeper();
    const jobs = fakeJobs({ code: "failed" });
    await checks.run(jobs);
    expect(await checks.automatic(jobs)).toEqual({ ran: false, reason: "already_checked" });
    expect(jobs.helperCheck).toHaveBeenCalledTimes(1);
  });

  it("a manual check while the automatic one runs shares its single request", async () => {
    const checks = keeper();
    const jobs = fakeJobs();
    let release!: () => void;
    jobs.gate = new Promise<void>((resolve) => (release = resolve));
    const auto = checks.automatic(jobs);
    await vi.waitFor(() => expect(jobs.helperCheck).toHaveBeenCalledTimes(1));
    const manual = checks.run(jobs);
    release();
    const [a, m] = await Promise.all([auto, manual]);
    expect(a).toMatchObject({ ran: true });
    expect(m).toEqual((a as { result: HelperCheckResult }).result);
    expect(jobs.helperCheck).toHaveBeenCalledTimes(1);
    // A check on another core (after a restart) is a request of its own.
    const other = fakeJobs();
    await checks.run(other);
    expect(other.helperCheck).toHaveBeenCalledTimes(1);
  });

  it("is delayed after the core start and cancelled when the core stops first", async () => {
    vi.useFakeTimers();
    try {
      const checks = keeper(5_000);
      const jobs = fakeJobs();
      checks.scheduleAutomatic(jobs);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(jobs.helperStatus).not.toHaveBeenCalled();
      checks.cancelAutomatic();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(jobs.helperStatus).not.toHaveBeenCalled();
      expect(jobs.helperCheck).not.toHaveBeenCalled();

      const next = fakeJobs();
      checks.scheduleAutomatic(next);
      await vi.advanceTimersByTimeAsync(5_000);
      await checks.settled();
      expect(next.helperCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a core that stopped while its automatic check was deciding does not start a check", async () => {
    const checks = keeper();
    const jobs = fakeJobs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const status = jobs.helperStatus.getMockImplementation()!;
    jobs.helperStatus.mockImplementation(async (last) => {
      await gate;
      return status(last);
    });
    checks.scheduleAutomatic(jobs);
    await vi.waitFor(() => expect(jobs.helperStatus).toHaveBeenCalled());
    checks.cancelAutomatic();
    release();
    await checks.settled();
    expect(jobs.helperCheck).not.toHaveBeenCalled();
  });

  it("logs metadata only", async () => {
    const checks = keeper();
    await checks.automatic(fakeJobs({ wouldUse: null }));
    await checks.automatic(fakeJobs({ code: "limit_reached" }));
    const all = logger.lines.join("\n");
    expect(all).not.toContain("usage limit reached");
    expect(all).toContain("automatic helper check skipped");
    expect(all).toContain('"code":"limit_reached"');
  });
});
