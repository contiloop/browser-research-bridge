import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATUSES } from "./models.js";
import type { OutcomeStatus, SiteLifecycleStatus } from "./models.js";
import { newSiteState, parseSiteRuntimeState, transitionSite } from "./lifecycle.js";
import type { LifecycleEvent, SiteRuntimeState } from "./lifecycle.js";
import { lifecycleToOutcome } from "./targets.js";

const AT = "2026-10-05T10:00:00.000Z";
const LATER = "2026-10-05T11:00:00.000Z";

function site(status: SiteLifecycleStatus, patch: Partial<SiteRuntimeState> = {}): SiteRuntimeState {
  return { ...newSiteState({ key: "reuters", status, at: AT }), ...patch };
}

function live(status: OutcomeStatus, extra: { message?: string; blocked?: boolean } = {}): LifecycleEvent {
  return {
    type: "live_outcome",
    outcome: { status, ...(extra.message !== undefined ? { message: extra.message } : {}) },
    blocked: extra.blocked,
    at: LATER,
  };
}

function health(status: OutcomeStatus, message?: string): LifecycleEvent {
  return {
    type: "health_check",
    outcome: { status, ...(message !== undefined ? { message } : {}) },
    at: LATER,
  };
}

describe("lifecycle status set", () => {
  it("is exactly the five lifecycle statuses", () => {
    expect([...LIFECYCLE_STATUSES]).toEqual(["onboarding", "active", "needs_login", "degraded", "failed"]);
  });
});

describe("live outcomes", () => {
  it("auth_required moves an active site to needs_login at once and clears the cache", () => {
    const t = transitionSite(site("active"), live("auth_required", { message: "session expired" }));
    expect(t.state.status).toBe("needs_login");
    expect(t.state.lastFailure).toBe("session expired");
    expect(t.effects).toEqual({ clearCache: true, coolDown: false });
    expect(t.changed).toBe(true);
    expect(t.state.updatedAt).toBe(LATER);
  });

  it("auth_required also moves a degraded site to needs_login", () => {
    expect(transitionSite(site("degraded"), live("auth_required")).state.status).toBe("needs_login");
  });

  it("three consecutive adapter_errors move an active site to degraded", () => {
    let s = site("active");
    for (let i = 1; i <= 2; i++) {
      const t = transitionSite(s, live("adapter_error", { message: `boom ${i}` }));
      expect(t.state.status).toBe("active");
      expect(t.state.consecutiveAdapterErrors).toBe(i);
      s = t.state;
    }
    const t = transitionSite(s, live("adapter_error", { message: "boom 3" }));
    expect(t.state.status).toBe("degraded");
    expect(t.state.lastFailure).toBe("boom 3");
    expect(t.effects.clearCache).toBe(false);
  });

  it("the degrade threshold is tunable", () => {
    const t = transitionSite(site("active"), live("adapter_error"), { adapterErrorsToDegrade: 1 });
    expect(t.state.status).toBe("degraded");
  });

  it("ok and empty reset the consecutive error count", () => {
    for (const status of ["ok", "empty"] as const) {
      const s = site("active", { consecutiveAdapterErrors: 2 });
      const t = transitionSite(s, live(status));
      expect(t.state.consecutiveAdapterErrors).toBe(0);
      expect(t.state.status).toBe("active");
    }
  });

  it("errors interleaved with a success do not degrade", () => {
    let s = site("active");
    for (const status of [
      "adapter_error",
      "adapter_error",
      "ok",
      "adapter_error",
      "adapter_error",
    ] as const) {
      s = transitionSite(s, live(status)).state;
    }
    expect(s.status).toBe("active");
    expect(s.consecutiveAdapterErrors).toBe(2);
  });

  it.each(["timeout", "browser_unavailable"] as const)(
    "%s never changes the status or the count",
    (status) => {
      for (const from of ["active", "needs_login", "degraded"] as const) {
        const s = site(from, { consecutiveAdapterErrors: 2 });
        const t = transitionSite(s, live(status));
        expect(t.state).toBe(s);
        expect(t.changed).toBe(false);
        expect(t.effects).toEqual({ clearCache: false, coolDown: false });
      }
    },
  );

  it("rate_limited starts the cool-down without a status change", () => {
    const t = transitionSite(site("active"), live("rate_limited"));
    expect(t.state.status).toBe("active");
    expect(t.effects.coolDown).toBe(true);
  });

  it("access_denied starts the cool-down only for a flagged block page (a paywall does not)", () => {
    const paywall = transitionSite(site("active"), live("access_denied"));
    expect(paywall.effects.coolDown).toBe(false);
    expect(paywall.state.status).toBe("active");
    const blocked = transitionSite(site("active"), live("access_denied", { blocked: true }));
    expect(blocked.effects.coolDown).toBe(true);
    expect(blocked.state.status).toBe("active");
  });

  it("never touches onboarding or failed sites", () => {
    for (const from of ["onboarding", "failed"] as const) {
      const s = site(from);
      expect(transitionSite(s, live("auth_required")).changed).toBe(false);
      expect(transitionSite(s, live("adapter_error"), { adapterErrorsToDegrade: 1 }).state.status).toBe(from);
    }
  });
});

describe("health check", () => {
  it("auth_required → needs_login with a login action in the outcome mapping", () => {
    const t = transitionSite(site("active"), health("auth_required", "login wall"));
    expect(t.state.status).toBe("needs_login");
    expect(t.state.lastCheckedAt).toBe(LATER);
    const entry = lifecycleToOutcome({
      key: "reuters",
      status: t.state.status,
      hostnames: ["reuters.com"],
      loginUrl: "https://www.reuters.com/account/sign-in/",
      lastFailure: t.state.lastFailure,
      capabilities: { search: true, read: true, dateFilter: false, pagination: true },
    });
    expect(entry?.status).toBe("auth_required");
    expect(entry?.action).toContain("Check now");
  });

  it("any other failure → degraded with the message", () => {
    for (const status of ["adapter_error", "access_denied", "timeout", "rate_limited"] as const) {
      const t = transitionSite(site("active"), health(status, `failed: ${status}`));
      expect(t.state.status).toBe("degraded");
      expect(t.state.lastFailure).toBe(`failed: ${status}`);
    }
  });

  it("pass → active; recovering from needs_login clears the cache and confirms the login", () => {
    const fromLogin = transitionSite(site("needs_login", { lastFailure: "x" }), health("ok"));
    expect(fromLogin.state.status).toBe("active");
    expect(fromLogin.state.lastFailure).toBeNull();
    expect(fromLogin.state.lastLoginConfirmedAt).toBe(LATER);
    expect(fromLogin.effects.clearCache).toBe(true);

    const fromDegraded = transitionSite(site("degraded", { consecutiveAdapterErrors: 3 }), health("ok"));
    expect(fromDegraded.state.status).toBe("active");
    expect(fromDegraded.state.consecutiveAdapterErrors).toBe(0);
    expect(fromDegraded.effects.clearCache).toBe(false);
  });

  it("browser_unavailable leaves the site alone (the check did not reach it)", () => {
    const s = site("active");
    const t = transitionSite(s, health("browser_unavailable"));
    expect(t.changed).toBe(false);
    expect(t.state.lastCheckedAt).toBeNull();
  });

  it("does not apply to onboarding or failed sites", () => {
    expect(transitionSite(site("onboarding"), health("ok")).state.status).toBe("onboarding");
    expect(transitionSite(site("failed"), health("ok")).state.status).toBe("failed");
  });
});

describe("onboarding and swap events", () => {
  it("onboarding_started, onboarding_failed, promoted, folder_incomplete", () => {
    const failed = transitionSite(site("onboarding"), {
      type: "onboarding_failed",
      reason: "no article text",
      at: LATER,
    });
    expect(failed.state.status).toBe("failed");
    expect(failed.state.lastFailure).toBe("no article text");

    const retry = transitionSite(failed.state, { type: "onboarding_started", at: LATER });
    expect(retry.state.status).toBe("onboarding");
    expect(retry.state.lastFailure).toBeNull();

    const promoted = transitionSite(site("degraded", { lastFailure: "x", consecutiveAdapterErrors: 3 }), {
      type: "promoted",
      at: LATER,
    });
    expect(promoted.state).toMatchObject({
      status: "active",
      lastFailure: null,
      consecutiveAdapterErrors: 0,
      lastCheckedAt: LATER,
    });

    const broken = transitionSite(site("active"), {
      type: "folder_incomplete",
      reason: "validation.json missing",
      at: LATER,
    });
    expect(broken.state.status).toBe("failed");
  });

  it("a failed repair sends no event; onboarding_failed does not touch a serving site", () => {
    const t = transitionSite(site("degraded"), { type: "onboarding_failed", reason: "x", at: LATER });
    expect(t.changed).toBe(false);
    expect(t.state.status).toBe("degraded");
  });
});

describe("parseSiteRuntimeState", () => {
  it("accepts a persisted entry and rejects unknown statuses", () => {
    const s = site("needs_login", { provisionalHostnames: ["reuters.com"] });
    expect(parseSiteRuntimeState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseSiteRuntimeState({ ...s, status: "paused" })).toBeNull();
    expect(parseSiteRuntimeState({ status: "active" })).toBeNull();
  });
});
