import { describe, expect, it } from "vitest";
import { hashUrlKey, hostnameKey, isHttpUrl, normalizeUrl } from "./url.js";

describe("normalizeUrl", () => {
  it("lowercases scheme and host, strips www., fragment, tracking params, trailing slash; sorts params", () => {
    expect(normalizeUrl("HTTPS://WWW.Reuters.com/World/Article/?utm_source=x&b=2&a=1#frag")).toBe(
      "https://reuters.com/World/Article?a=1&b=2",
    );
  });

  it("maps common variants of one article to the same key", () => {
    const variants = [
      "https://www.example.com/news/1",
      "https://example.com/news/1/",
      "https://example.com/news/1#comments",
      "https://example.com/news/1?utm_medium=social&utm_campaign=x",
      "https://EXAMPLE.com/news/1?fbclid=abc",
      "https://example.com/news/1?gclid=1&ref=home&src=rss",
      "https://example.com:443/news/1",
    ];
    const keys = new Set(variants.map((v) => normalizeUrl(v)));
    expect([...keys]).toEqual(["https://example.com/news/1"]);
  });

  it("sorts remaining params so order does not matter", () => {
    expect(normalizeUrl("https://e.com/s?z=1&a=2&m=3")).toBe(normalizeUrl("https://e.com/s?m=3&a=2&z=1"));
  });

  it("strips tracking params case-insensitively but keeps look-alikes", () => {
    expect(normalizeUrl("https://e.com/p?UTM_Campaign=1&reference=2&source=3&Ref=4")).toBe(
      "https://e.com/p?reference=2&source=3",
    );
  });

  it("keeps the root slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("https://www.example.com")).toBe("https://example.com/");
  });

  it("runs the site canonicalizer first", () => {
    const canonicalize = (u: string): string => u.replace("://m.blog.naver.com/", "://blog.naver.com/");
    expect(normalizeUrl("https://m.blog.naver.com/user/123", { canonicalize })).toBe(
      normalizeUrl("https://blog.naver.com/user/123"),
    );
  });

  it("accepts a custom tracking-param list", () => {
    expect(
      normalizeUrl("https://e.com/p?sid=1&a=1", { trackingParams: ["sid"], trackingParamPrefixes: [] }),
    ).toBe("https://e.com/p?a=1");
  });

  it("returns the trimmed input when it is not a parseable URL", () => {
    expect(normalizeUrl("  not a url ")).toBe("not a url");
  });
});

describe("hashUrlKey", () => {
  it("is deterministic, short, base64url, and distinguishes keys", () => {
    const a = hashUrlKey("https://e.com/a");
    expect(a).toBe(hashUrlKey("https://e.com/a"));
    expect(a).not.toBe(hashUrlKey("https://e.com/b"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });
});

describe("isHttpUrl / hostnameKey", () => {
  it("detects http(s) URLs only", () => {
    expect(isHttpUrl("https://e.com/x")).toBe(true);
    expect(isHttpUrl("HTTP://e.com")).toBe(true);
    expect(isHttpUrl("ftp://e.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("reuters:abc")).toBe(false);
  });

  it("normalizes hostnames for ownership comparison", () => {
    expect(hostnameKey("WWW.Reuters.com.")).toBe("reuters.com");
    expect(hostnameKey("blog.naver.com")).toBe("blog.naver.com");
  });
});
