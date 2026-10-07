import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { SearchCursor } from "./cursor.js";

const known =
  (keys: string[]) =>
  (key: string): boolean =>
    keys.includes(key);

const sample: SearchCursor = {
  page: 3,
  sites: {
    reuters: { adapterCursor: "p=2", offset: 4 },
    "blog-naver": { adapterCursor: null, offset: 0 },
  },
  seen: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
};

describe("cursor codec", () => {
  it("round-trips through an opaque base64url token", () => {
    const token = encodeCursor(sample);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeCursor(token, { isKnownSite: known(["reuters", "blog-naver"]) });
    expect(decoded).toEqual({ ok: true, cursor: sample, droppedSites: [] });
  });

  it("carries per-site offsets and adapter cursors", () => {
    const decoded = decodeCursor(encodeCursor(sample), { isKnownSite: known(["reuters", "blog-naver"]) });
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.cursor.sites["reuters"]).toEqual({ adapterCursor: "p=2", offset: 4 });
  });

  it("drops sites that no longer exist", () => {
    const decoded = decodeCursor(encodeCursor(sample), { isKnownSite: known(["reuters"]) });
    if (!decoded.ok) throw new Error(decoded.error);
    expect(Object.keys(decoded.cursor.sites)).toEqual(["reuters"]);
    expect(decoded.droppedSites).toEqual(["blog-naver"]);
  });

  it("bounds the seen-hash list to the most recent N", () => {
    const seen = Array.from({ length: 250 }, (_, i) => `h${String(i).padStart(11, "0")}`);
    const token = encodeCursor({ ...sample, seen });
    const decoded = decodeCursor(token, { isKnownSite: () => true });
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.cursor.seen).toHaveLength(200);
    expect(decoded.cursor.seen[0]).toBe(seen[50]);
    expect(decoded.cursor.seen.at(-1)).toBe(seen[249]);

    const small = decodeCursor(encodeCursor({ ...sample, seen }, { seenLimit: 10 }), {
      isKnownSite: () => true,
      seenLimit: 10,
    });
    if (!small.ok) throw new Error(small.error);
    expect(small.cursor.seen).toEqual(seen.slice(240));
  });

  it.each([
    ["not base64 json", "!!!"],
    ["json but wrong shape", Buffer.from(JSON.stringify({ hello: 1 })).toString("base64url")],
    ["wrong version", Buffer.from(JSON.stringify({ v: 99, p: 1, s: {}, h: [] })).toString("base64url")],
    [
      "negative offset",
      Buffer.from(JSON.stringify({ v: 1, p: 2, s: { reuters: [null, -1] }, h: [] })).toString("base64url"),
    ],
    ["page zero", Buffer.from(JSON.stringify({ v: 1, p: 0, s: {}, h: [] })).toString("base64url")],
    ["empty", ""],
  ])("rejects %s", (_name, token) => {
    const decoded = decodeCursor(token, { isKnownSite: () => true });
    expect(decoded.ok).toBe(false);
  });

  it("rejects oversized tokens", () => {
    const decoded = decodeCursor("a".repeat(100), { isKnownSite: () => true, maxLength: 50 });
    expect(decoded.ok).toBe(false);
  });
});
