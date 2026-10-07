import { describe, expect, it } from "vitest";
import { lifecycleToOutcome, planSearchTargets, readTargetOutcome } from "./targets.js";
import type { SiteView } from "./models.js";

function site(key: string, status: SiteView["status"], extra: Partial<SiteView> = {}): SiteView {
  return {
    key,
    status,
    hostnames: [`${key}.com`],
    loginUrl: null,
    lastFailure: null,
    capabilities: { search: true, read: true, dateFilter: false, pagination: true },
    ...extra,
  };
}

const registry: SiteView[] = [
  site("zeta", "active"),
  site("alpha", "active"),
  site("login", "needs_login", { loginUrl: "https://login.com/signin" }),
  site("broken", "degraded", { lastFailure: "selector .article missing" }),
  site("dead", "failed", { lastFailure: "no readable articles" }),
  site("newbie", "onboarding"),
  site("readonly", "active", {
    capabilities: { search: false, read: true, dateFilter: false, pagination: false },
  }),
];

describe("lifecycleToOutcome", () => {
  it("maps each non-active lifecycle status to its outcome", () => {
    expect(lifecycleToOutcome(registry[2]!)).toMatchObject({ site: "login", status: "auth_required" });
    expect(lifecycleToOutcome(registry[2]!)?.action).toContain("https://login.com/signin");
    expect(lifecycleToOutcome(registry[3]!)).toEqual({
      site: "broken",
      status: "adapter_error",
      message: "selector .article missing",
      action: "Repair in the dashboard",
    });
    expect(lifecycleToOutcome(registry[4]!)).toMatchObject({
      site: "dead",
      status: "adapter_error",
      message: "no readable articles",
    });
    expect(lifecycleToOutcome(registry[5]!)).toEqual({
      site: "newbie",
      status: "unsupported",
      message: "onboarding in progress",
    });
    expect(lifecycleToOutcome(registry[0]!)).toBeNull();
  });

  it("never maps a lifecycle state to empty", () => {
    for (const s of registry) expect(lifecycleToOutcome(s)?.status).not.toBe("empty");
  });
});

describe("planSearchTargets", () => {
  it("search-all targets active sites in alphabetical order and reports every other registered site", () => {
    const plan = planSearchTargets(registry, null);
    expect(plan.targets).toEqual(["alpha", "zeta"]);
    expect(plan.statuses.map((s) => [s.site, s.status])).toEqual([
      ["broken", "adapter_error"],
      ["dead", "adapter_error"],
      ["login", "auth_required"],
      ["newbie", "unsupported"],
      ["readonly", "unsupported"],
    ]);
    expect(plan.unknown).toEqual([]);
  });

  it("restricts to named sites (key or hostname) and reports only those", () => {
    const plan = planSearchTargets(registry, ["zeta.com", "login", "nope"]);
    expect(plan.targets).toEqual(["zeta"]);
    expect(plan.statuses).toEqual([
      expect.objectContaining({ site: "login", status: "auth_required" }),
      { site: "nope", status: "unsupported", message: "unknown site: nope" },
    ]);
    expect(plan.unknown).toEqual(["nope"]);
  });

  it("searches nothing when every named site is unknown, reporting each as unsupported", () => {
    const plan = planSearchTargets(registry, ["nope"]);
    expect(plan.targets).toEqual([]);
    expect(plan.statuses).toEqual([{ site: "nope", status: "unsupported", message: "unknown site: nope" }]);
  });
});

describe("readTargetOutcome", () => {
  it("rejects unregistered and not-loadable sites, attempts the rest", () => {
    expect(readTargetOutcome(undefined, "ghost")).toEqual({
      site: "ghost",
      status: "unsupported",
      message: "site not registered: ghost",
    });
    expect(readTargetOutcome(registry[5])).toMatchObject({
      status: "unsupported",
      message: "site not ready: onboarding",
    });
    expect(readTargetOutcome(registry[4])).toMatchObject({
      status: "unsupported",
      message: "site not ready: failed",
    });
    expect(readTargetOutcome(registry[2])).toBeNull();
    expect(readTargetOutcome(registry[3])).toBeNull();
    expect(readTargetOutcome(registry[0])).toBeNull();
  });
});
