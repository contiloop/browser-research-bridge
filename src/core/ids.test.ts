import { describe, expect, it } from "vitest";
import {
  encodeUrlLocalId,
  makeResultId,
  parseRef,
  resolveSiteByHostname,
  resolveSiteQualifier,
  toAdapterRef,
} from "./ids.js";
import { normalizeUrl } from "./url.js";

const sites = [
  { key: "reuters", hostnames: ["reuters.com"] },
  { key: "blog-naver", hostnames: ["blog.naver.com", "m.blog.naver.com"] },
];

describe("makeResultId", () => {
  it("uses the adapter's stable local id when present", () => {
    expect(makeResultId("reuters", { localId: "abc123", url: "https://www.reuters.com/x" })).toBe(
      "reuters:abc123",
    );
  });

  it("falls back to u_ + base64url of the canonicalized original URL, never the dedup key", () => {
    const url = "https://news.example.com/item?id=1&utm_source=x";
    const id = makeResultId("news", { localId: null, url });
    expect(id).toBe(`news:u_${Buffer.from(url, "utf8").toString("base64url")}`);
    expect(id).not.toBe(`news:${encodeUrlLocalId(normalizeUrl(url))}`);
  });

  it("applies the adapter canonicalizer to the fallback URL", () => {
    const canonicalize = (u: string): string => u.replace("://m.blog.naver.com/", "://blog.naver.com/");
    const id = makeResultId("blog-naver", { url: "https://m.blog.naver.com/u/1" }, canonicalize);
    const parsed = parseRef(id);
    expect(parsed).toMatchObject({ kind: "id", siteKey: "blog-naver", url: "https://blog.naver.com/u/1" });
  });

  it("falls back to the URL form for local ids that could not round-trip", () => {
    const url = "https://e.com/a";
    expect(makeResultId("ex", { localId: "u_reserved", url })).toBe(`ex:${encodeUrlLocalId(url)}`);
    expect(makeResultId("ex", { localId: "has space", url })).toBe(`ex:${encodeUrlLocalId(url)}`);
    expect(makeResultId("ex", { localId: "", url })).toBe(`ex:${encodeUrlLocalId(url)}`);
  });

  it("rejects an invalid site key", () => {
    expect(() => makeResultId("Bad_Key", { localId: "1", url: "https://e.com" })).toThrow();
  });
});

describe("parseRef", () => {
  it("parses http(s) refs as URLs", () => {
    expect(parseRef("https://www.reuters.com/a")).toEqual({
      kind: "url",
      url: "https://www.reuters.com/a",
      hostname: "www.reuters.com",
    });
    expect(parseRef(" HTTP://Example.com/x ")).toMatchObject({ kind: "url", hostname: "example.com" });
  });

  it("parses siteKey:localId, splitting at the first colon", () => {
    expect(parseRef("reuters:abc:def")).toEqual({
      kind: "id",
      siteKey: "reuters",
      localId: "abc:def",
      url: null,
    });
  });

  it("decodes fallback ids to their URL", () => {
    const url = "https://news.example.com/item?id=42";
    expect(parseRef(`news:${encodeUrlLocalId(url)}`)).toEqual({
      kind: "id",
      siteKey: "news",
      localId: encodeUrlLocalId(url),
      url,
    });
  });

  it.each([
    "nocolon",
    "Bad_Key:1",
    "reuters:",
    ":abc",
    "hn:u_!!!",
    `news:u_${Buffer.from("javascript:alert(1)").toString("base64url")}`,
    "https://",
    "",
  ])("rejects malformed ref %j", (ref) => {
    expect(parseRef(ref).kind).toBe("invalid");
  });

  it("round-trips every id produced by makeResultId", () => {
    const cases = [
      { localId: "12345", url: "https://reuters.com/a" },
      { localId: null, url: "https://reuters.com/world/x?id=1&utm_source=t#frag" },
      { localId: "u_x", url: "https://reuters.com/한글?q=1" },
    ];
    for (const c of cases) {
      const id = makeResultId("reuters", c);
      const parsed = parseRef(id);
      expect(parsed.kind).toBe("id");
      if (parsed.kind !== "id") continue;
      const ref = toAdapterRef(parsed);
      if (c.localId === "12345") expect(ref).toEqual({ localId: "12345" });
      else expect(ref).toEqual({ url: c.url });
    }
  });

  it("maps URL refs to adapter refs", () => {
    const parsed = parseRef("https://reuters.com/a");
    if (parsed.kind === "invalid") throw new Error("unexpected");
    expect(toAdapterRef(parsed)).toEqual({ url: "https://reuters.com/a" });
  });
});

describe("hostname -> site resolution", () => {
  it("resolves declared hostnames, ignoring case and www.", () => {
    expect(resolveSiteByHostname("www.Reuters.com", sites)).toBe("reuters");
    expect(resolveSiteByHostname("m.blog.naver.com", sites)).toBe("blog-naver");
    expect(resolveSiteByHostname("naver.com", sites)).toBeNull();
    expect(resolveSiteByHostname("example.com", sites)).toBeNull();
  });

  it("resolves site: qualifier values given as key, hostname, or URL", () => {
    expect(resolveSiteQualifier("reuters", sites)).toBe("reuters");
    expect(resolveSiteQualifier("reuters.com", sites)).toBe("reuters");
    expect(resolveSiteQualifier("https://www.reuters.com/x", sites)).toBe("reuters");
    expect(resolveSiteQualifier("blog.naver.com", sites)).toBe("blog-naver");
    expect(resolveSiteQualifier("unknown", sites)).toBeNull();
  });
});
