import { describe, expect, it } from "vitest";
import {
  coerceAdapterStatus,
  errorToOutcome,
  isBlockedError,
  isOutcomeStatus,
  OutcomeError,
  withOutcomeDefaults,
} from "./outcome.js";
import { OUTCOME_STATUSES } from "./models.js";

describe("status set", () => {
  it("is exact", () => {
    expect([...OUTCOME_STATUSES]).toEqual([
      "ok",
      "empty",
      "auth_required",
      "unsupported",
      "access_denied",
      "rate_limited",
      "timeout",
      "adapter_error",
      "browser_unavailable",
    ]);
    expect(isOutcomeStatus("ok")).toBe(true);
    expect(isOutcomeStatus("error")).toBe(false);
  });
});

describe("errorToOutcome", () => {
  it("keeps a typed OutcomeError's status, message and action", () => {
    expect(errorToOutcome(new OutcomeError("auth_required", "login wall", "Log in"))).toEqual({
      status: "auth_required",
      message: "login wall",
      action: "Log in",
    });
  });

  it("maps timeouts and aborts to timeout", () => {
    expect(errorToOutcome(new DOMException("t", "TimeoutError")).status).toBe("timeout");
    expect(errorToOutcome(new DOMException("a", "AbortError")).status).toBe("timeout");
  });

  it("maps anything else to adapter_error with a message", () => {
    expect(errorToOutcome(new Error("boom"))).toEqual({ status: "adapter_error", message: "boom" });
    expect(errorToOutcome("weird").status).toBe("adapter_error");
    expect(errorToOutcome(undefined).message).toBeTruthy();
  });

  it("keeps the outcome's shape for a blocked error (blocked travels on the error, not the outcome)", () => {
    const message = "alpha answered with a bot check (geo.captcha-delivery.com)";
    const err = new OutcomeError("access_denied", message, undefined, { blocked: true });
    expect(errorToOutcome(err)).toEqual({ status: "access_denied", message });
  });

  it("never yields ok or empty, even if misused at runtime", () => {
    const bogus = new OutcomeError("empty" as never, "x");
    expect(errorToOutcome(bogus).status).toBe("adapter_error");
    for (const s of OUTCOME_STATUSES) {
      if (s === "ok" || s === "empty") continue;
      expect(errorToOutcome(new OutcomeError(s, "m")).status).toBe(s);
    }
  });
});

describe("blocked failures thrown as errors", () => {
  it("OutcomeError carries blocked (false unless given) next to its cause", () => {
    const cause = new Error("inner");
    const blocked = new OutcomeError("access_denied", "bot check", "solve it", { blocked: true, cause });
    expect(blocked).toMatchObject({ status: "access_denied", message: "bot check", action: "solve it" });
    expect(blocked.blocked).toBe(true);
    expect(blocked.cause).toBe(cause);
    expect(new OutcomeError("adapter_error", "m").blocked).toBe(false);
    expect(new OutcomeError("adapter_error", "m", undefined, { cause }).blocked).toBe(false);
  });

  it("isBlockedError: only a failure status flagged blocked counts", () => {
    expect(isBlockedError(new OutcomeError("access_denied", "m", undefined, { blocked: true }))).toBe(true);
    expect(isBlockedError(new OutcomeError("access_denied", "m"))).toBe(false);
    expect(isBlockedError({ status: "access_denied", message: "m", blocked: true })).toBe(true);
    expect(isBlockedError({ status: "ok", blocked: true })).toBe(false);
    expect(isBlockedError({ status: "empty", blocked: true })).toBe(false);
    expect(isBlockedError({ status: "access_denied", blocked: "yes" })).toBe(false);
    expect(isBlockedError(Object.assign(new Error("m"), { blocked: true }))).toBe(false);
    expect(isBlockedError(null)).toBe(false);
    expect(isBlockedError("blocked")).toBe(false);
  });
});

describe("withOutcomeDefaults", () => {
  it("adds a message to non-ok outcomes and an action to auth_required/access_denied", () => {
    const auth = withOutcomeDefaults(
      { status: "auth_required" },
      { site: "reuters", loginUrl: "https://reuters.com/login" },
    );
    expect(auth.message).toBeTruthy();
    expect(auth.action).toContain("https://reuters.com/login");
    const denied = withOutcomeDefaults({ status: "access_denied", message: "paywall" }, { site: "reuters" });
    expect(denied).toMatchObject({ message: "paywall" });
    expect(denied.action).toBeTruthy();
    expect(withOutcomeDefaults({ status: "timeout" }, {}).message).toBeTruthy();
    expect(withOutcomeDefaults({ status: "ok" }, {})).toEqual({ status: "ok" });
  });

  it("keeps explicit actions", () => {
    expect(withOutcomeDefaults({ status: "auth_required", message: "m", action: "do x" }, {}).action).toBe(
      "do x",
    );
  });
});

describe("coerceAdapterStatus", () => {
  it("maps unknown statuses to adapter_error and reconciles ok/empty with the result count", () => {
    expect(coerceAdapterStatus("bogus", 0)).toBe("adapter_error");
    expect(coerceAdapterStatus(undefined, 3)).toBe("adapter_error");
    expect(coerceAdapterStatus("ok", 0)).toBe("empty");
    expect(coerceAdapterStatus("ok", 2)).toBe("ok");
    expect(coerceAdapterStatus("empty", 2)).toBe("ok");
  });

  it("never turns a login or access failure into empty", () => {
    expect(coerceAdapterStatus("auth_required", 0)).toBe("auth_required");
    expect(coerceAdapterStatus("access_denied", 0)).toBe("access_denied");
  });
});
