import { describe, expect, it } from "vitest";
import { createSiteManifestSchema, parseSiteManifest, siteManifestSchema } from "./manifest.js";

const minimal = {
  key: "reuters",
  name: "Reuters",
  hostnames: ["WWW.Reuters.com"],
  timezone: "America/New_York",
  capabilities: { search: true, read: true },
  sampleQuery: "oil prices",
  createdBy: "agent",
};

describe("site manifest schema", () => {
  it("applies the built-in defaults", () => {
    const m = siteManifestSchema.parse(minimal);
    expect(m).toEqual({
      ...minimal,
      hostnames: ["www.reuters.com"],
      extraAllowedHosts: [],
      loginUrl: null,
      requiresLogin: false,
      capabilities: { search: true, read: true, dateFilter: false, pagination: false },
      sampleReadUrl: null,
      gatedSampleUrl: null,
      minReadChars: 200,
      minIntervalMs: 1500,
      version: 1,
    });
  });

  it("accepts extraAllowedHosts (navigation allowlist, not ownership)", () => {
    const m = siteManifestSchema.parse({ ...minimal, extraAllowedHosts: ["NID.naver.com"] });
    expect(m.extraAllowedHosts).toEqual(["nid.naver.com"]);
    expect(m.hostnames).toEqual(["www.reuters.com"]);
  });

  it("takes tunable defaults as options", () => {
    const m = createSiteManifestSchema({ defaultMinIntervalMs: 3000, defaultMinReadChars: 500 }).parse(
      minimal,
    );
    expect(m.minIntervalMs).toBe(3000);
    expect(m.minReadChars).toBe(500);
  });

  it.each([
    ["invalid key", { key: "Bad_Key" }],
    ["no hostnames", { hostnames: [] }],
    ["bad hostname", { hostnames: ["not a host"] }],
    ["bad extra allowed host", { extraAllowedHosts: ["https://nid.naver.com"] }],
    ["duplicate hostnames", { hostnames: ["a.com", "A.com"] }],
    ["unknown timezone", { timezone: "Mars/Olympus" }],
    ["search without sample query", { sampleQuery: "" }],
    ["bad createdBy", { createdBy: "robot" }],
    ["non-http loginUrl", { loginUrl: "javascript:alert(1)" }],
    ["negative interval", { minIntervalMs: -1 }],
  ])("rejects %s", (_name, patch) => {
    expect(siteManifestSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });

  it("allows a read-only adapter without a sample query", () => {
    expect(
      siteManifestSchema.safeParse({
        ...minimal,
        capabilities: { search: false, read: true },
        sampleQuery: "",
      }).success,
    ).toBe(true);
  });

  it("parseSiteManifest returns a result object with readable issues", () => {
    const bad = parseSiteManifest({ ...minimal, key: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("key");
    const good = parseSiteManifest(minimal);
    expect(good.ok).toBe(true);
  });
});
