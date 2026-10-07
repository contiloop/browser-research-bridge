import { describe, expect, it } from "vitest";
import { finalizeDocument, toSearchResult } from "./assemble.js";
import { parseRef, toAdapterRef } from "./ids.js";

const item = {
  title: "T",
  url: "https://www.e.com/a/?utm_source=x",
  publishedAt: "2024-05-01T00:00:00Z",
  datePrecision: "minute" as const,
  excerpt: null,
  author: null,
};

describe("toSearchResult", () => {
  it("builds the id from localId or the canonicalized original URL and keeps fields", () => {
    expect(toSearchResult("ex", { ...item, localId: "42" })).toEqual({ ...item, id: "ex:42", site: "ex" });
    const fallback = toSearchResult("ex", item);
    const parsed = parseRef(fallback.id);
    if (parsed.kind === "invalid") throw new Error(parsed.reason);
    expect(toAdapterRef(parsed)).toEqual({ url: item.url });
    expect(fallback).not.toHaveProperty("localId");
  });
});

describe("finalizeDocument", () => {
  const doc = {
    title: "T",
    url: "https://e.com/a",
    publishedAt: null,
    datePrecision: null,
    author: null,
    text: "first paragraph\n\nsecond paragraph",
    accessLevel: "subscriber" as const,
    metadata: {},
  };

  it("adds id, site, fetchedAt and truncates at a paragraph boundary", () => {
    const out = finalizeDocument("ex", doc, { fetchedAt: "2024-05-01T00:00:00Z", maxChars: 20 });
    expect(out).toMatchObject({
      site: "ex",
      text: "first paragraph",
      truncated: true,
      fetchedAt: "2024-05-01T00:00:00Z",
      accessLevel: "subscriber",
    });
    const parsed = parseRef(out.id);
    if (parsed.kind === "invalid") throw new Error(parsed.reason);
    expect(toAdapterRef(parsed)).toEqual({ url: "https://e.com/a" });
  });

  it("uses the native local id and the default 100k cap", () => {
    const out = finalizeDocument("ex", { ...doc, localId: "a1" }, { fetchedAt: "2024-05-01T00:00:00Z" });
    expect(out.id).toBe("ex:a1");
    expect(out.truncated).toBe(false);
    expect(out).not.toHaveProperty("localId");
  });
});
