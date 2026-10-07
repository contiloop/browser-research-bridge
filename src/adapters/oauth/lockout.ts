/**
 * Consent-page lockout. With a trusted proxy header, failures are counted per client IP; without
 * one (or when a request lacks the configured header) every request looks like the tunnel's
 * loopback address, so one global counter with the global threshold applies.
 * Failures older than the window are forgotten; reaching the threshold locks the key for the lockout period.
 * State is in memory: a restart clears it.
 */
import type { Clock } from "../../ports/clock.js";

export interface LockoutPolicy {
  /** Failures within `windowMs` that trigger a lockout. */
  threshold: number;
  windowMs: number;
  lockoutMs: number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class LockoutTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly policy: LockoutPolicy,
    private readonly clock: Clock,
  ) {}

  /** Epoch ms until which the key is locked, or null when it may attempt. */
  lockedUntil(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = this.clock.now().getTime();
    return entry.lockedUntil > now ? entry.lockedUntil : null;
  }

  /** Records a failure; returns true when this failure starts a lockout. */
  recordFailure(key: string): boolean {
    const now = this.clock.now().getTime();
    const entry = this.entries.get(key) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => now - t < this.policy.windowMs);
    entry.failures.push(now);
    let locked = false;
    if (entry.failures.length >= this.policy.threshold) {
      entry.lockedUntil = now + this.policy.lockoutMs;
      entry.failures = [];
      locked = true;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict(now);
    return locked;
  }

  recordSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.failures = [];
  }

  private evict(now: number): void {
    if (this.entries.size <= MAX_TRACKED_KEYS) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_TRACKED_KEYS) break;
      if (entry.lockedUntil <= now) this.entries.delete(key);
    }
  }
}
