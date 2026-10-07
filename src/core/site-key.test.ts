import { describe, expect, it } from "vitest";
import { deriveSiteKey, isValidSiteKey, registrableDomain, uniqueSiteKey } from "./site-key.js";

describe("deriveSiteKey", () => {
  it.each([
    ["reuters.com", "reuters"],
    ["www.reuters.com", "reuters"],
    ["blog.naver.com", "blog-naver"],
    ["news.example.com", "news-example"],
    ["www.chosun.co.kr", "chosun"],
    ["news.chosun.co.kr", "news-chosun"],
    ["www.smh.com.au", "smh"],
    ["www.bbc.co.uk", "bbc"],
    ["Example.ORG", "example"],
    ["https://www.reuters.com/world/some-article", "reuters"],
  ])("%s -> %s", (input, expected) => {
    expect(deriveSiteKey(input)).toBe(expected);
  });

  it("falls back to the full hostname when the stripped key would be too short", () => {
    expect(deriveSiteKey("x.com")).toBe("x-com");
  });

  it("always yields a valid key, truncating long hostnames", () => {
    const key = deriveSiteKey("a-very-long-subdomain-name.another-long-label.example.com");
    expect(isValidSiteKey(key)).toBe(true);
    expect(key.length).toBeLessThanOrEqual(32);
    expect(key.endsWith("-")).toBe(false);
  });

  it("handles internationalized hostnames via punycode", () => {
    expect(isValidSiteKey(deriveSiteKey("bücher.de"))).toBe(true);
  });
});

describe("isValidSiteKey", () => {
  it("enforces [a-z0-9-]{2,32}", () => {
    expect(isValidSiteKey("ab")).toBe(true);
    expect(isValidSiteKey("blog-naver")).toBe(true);
    expect(isValidSiteKey("a".repeat(32))).toBe(true);
    expect(isValidSiteKey("a")).toBe(false);
    expect(isValidSiteKey("a".repeat(33))).toBe(false);
    expect(isValidSiteKey("Ab")).toBe(false);
    expect(isValidSiteKey("a_b")).toBe(false);
    expect(isValidSiteKey("a.b")).toBe(false);
  });
});

describe("uniqueSiteKey", () => {
  it("returns the base when free, else appends a numeric suffix within 32 chars", () => {
    expect(uniqueSiteKey("reuters", new Set<string>())).toBe("reuters");
    expect(uniqueSiteKey("reuters", new Set(["reuters", "reuters-2"]))).toBe("reuters-3");
    const long = "a".repeat(32);
    const next = uniqueSiteKey(long, new Set([long]));
    expect(next).toBe(`${"a".repeat(30)}-2`);
    expect(isValidSiteKey(next)).toBe(true);
  });
});

describe("registrableDomain", () => {
  it.each([
    ["www.reuters.com", "reuters.com"],
    ["dd.reuters.com", "reuters.com"],
    ["reuters.com", "reuters.com"],
    ["blog.naver.com", "naver.com"],
    ["phinf.pstatic.net", "pstatic.net"],
    ["news.chosun.co.kr", "chosun.co.kr"],
    ["WWW.BBC.CO.UK.", "bbc.co.uk"],
    ["co.uk", "co.uk"],
    ["localhost", "localhost"],
  ])("%s -> %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });
});
