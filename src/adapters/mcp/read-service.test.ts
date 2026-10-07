import { afterEach, describe, expect, it } from "vitest";
import {
  addOnboarding,
  documentFor,
  longText,
  makeMcpWorld,
  setDegraded,
  setNeedsLogin,
} from "../../../test/support/mcp-fixtures.js";
import type { FakeSiteSpec, McpWorld, WorldOptions } from "../../../test/support/mcp-fixtures.js";
import { encodeUrlLocalId } from "../../core/ids.js";
import type { DocumentRef } from "../../core/models.js";
import { perItemBudget } from "./read-service.js";

let world: McpWorld | null = null;
afterEach(async () => {
  await world?.cleanup();
  world = null;
});

async function make(sites: FakeSiteSpec[], extra: Omit<WorldOptions, "sites"> = {}): Promise<McpWorld> {
  world = await makeMcpWorld({ sites, ...extra });
  return world;
}

/** Reads by native id or by URL; returns a document whose text is `size` characters. */
function reader(key: string, size = 2000): FakeSiteSpec["read"] {
  return async (ref: DocumentRef) => {
    const localId = ref.localId ?? new URL(ref.url!).pathname.split("/").pop()!;
    return { status: "ok", document: documentFor(key, localId, longText(size, `${key}-${localId}`)) };
  };
}

describe("ReadService.fetch", () => {
  it("reads a result id, keeps the id, and serves the second read from the cache", async () => {
    const w = await make([{ key: "alpha", read: reader("alpha") }]);
    const first = await w.read.fetch("alpha:42");
    expect(first.status).toBe("ok");
    expect(first.document).toMatchObject({
      id: "alpha:42",
      site: "alpha",
      title: "alpha document 42",
      url: "https://alpha.example.com/articles/42",
      accessLevel: "subscriber",
      truncated: false,
      metadata: { section: "world" },
    });
    expect(w.calls.get("alpha")?.read).toEqual([{ localId: "42" }]);
    const second = await w.read.fetch("alpha:42");
    expect(second.document?.text).toBe(first.document?.text);
    expect(w.count("alpha").read).toBe(1);
  });

  it("resolves URLs and URL ids to the site by hostname (www-insensitive)", async () => {
    const w = await make([{ key: "alpha", read: reader("alpha") }]);
    const byUrl = await w.read.fetch("https://www.alpha.example.com/articles/7");
    expect(byUrl.status).toBe("ok");
    expect(w.calls.get("alpha")?.read[0]).toEqual({ url: "https://www.alpha.example.com/articles/7" });

    const urlId = `alpha:${encodeUrlLocalId("https://alpha.example.com/articles/8")}`;
    const byUrlId = await w.read.fetch(urlId);
    expect(byUrlId.document?.id).toBe(urlId);
    expect(w.calls.get("alpha")?.read[1]).toEqual({ url: "https://alpha.example.com/articles/8" });
  });

  it("a URL id whose URL is on another site's (or no site's) host is unsupported without calling the adapter", async () => {
    const w = await make([
      { key: "alpha", read: reader("alpha") },
      { key: "beta", read: reader("beta") },
    ]);
    const foreign = `alpha:${encodeUrlLocalId("https://beta.example.com/articles/9")}`;
    const r1 = await w.read.fetch(foreign);
    expect(r1).toMatchObject({
      status: "unsupported",
      error: {
        code: "unsupported",
        message: "the URL in this id is on beta.example.com, which is not a hostname of alpha",
        site: "alpha",
      },
    });
    const elsewhere = `alpha:${encodeUrlLocalId("https://attacker.example.net/x")}`;
    const r2 = await w.read.fetch(elsewhere);
    expect(r2.error).toMatchObject({
      code: "unsupported",
      message: "the URL in this id is on attacker.example.net, which is not a hostname of alpha",
    });
    expect(w.count("alpha").read).toBe(0);
    expect(w.count("beta").read).toBe(0);
    // The site's own host (www-insensitive) is still read.
    const own = await w.read.fetch(`alpha:${encodeUrlLocalId("https://www.alpha.example.com/articles/3")}`);
    expect(own.status).toBe("ok");
  });

  it("unknown hostnames, unknown site keys, and malformed refs → unsupported with availableSites", async () => {
    const w = await make([
      { key: "alpha", read: reader("alpha") },
      { key: "beta", read: reader("beta") },
    ]);
    await addOnboarding(w, "gamma");
    const url = await w.read.fetch("https://unknown.example.net/a");
    expect(url).toEqual({
      ref: "https://unknown.example.net/a",
      status: "unsupported",
      error: {
        code: "unsupported",
        message: "no registered site owns unknown.example.net",
        site: "unknown.example.net",
        availableSites: ["alpha", "beta"],
      },
    });
    const id = await w.read.fetch("nope:123");
    expect(id.error).toMatchObject({ code: "unsupported", site: "nope", availableSites: ["alpha", "beta"] });
    const bad = await w.read.fetch("not a ref");
    expect(bad.error).toMatchObject({ code: "unsupported", availableSites: ["alpha", "beta"] });
  });

  it("sites that are not loadable are 'site not ready'; needs_login and degraded sites are still read", async () => {
    const w = await make([
      { key: "alpha", read: reader("alpha") },
      { key: "beta", read: reader("beta") },
    ]);
    await addOnboarding(w, "gamma");
    await addOnboarding(w, "zeta", "no article structure");
    expect((await w.read.fetch("gamma:1")).error).toEqual({
      code: "unsupported",
      message: "site not ready: onboarding",
      site: "gamma",
    });
    expect((await w.read.fetch("https://zeta.example.org/x")).error?.message).toBe("site not ready: failed");

    await setNeedsLogin(w, "alpha");
    await setDegraded(w, "beta");
    expect((await w.read.fetch("alpha:1")).status).toBe("ok");
    expect((await w.read.fetch("beta:1")).status).toBe("ok");
  });

  it("passes auth_required through with an action, moves the site to needs_login, caches nothing", async () => {
    const w = await make([
      { key: "alpha", read: async () => ({ status: "auth_required", message: "subscriber wall" }) },
    ]);
    const out = await w.read.fetch("alpha:1");
    expect(out).toEqual({
      ref: "alpha:1",
      status: "auth_required",
      error: {
        code: "auth_required",
        message: "subscriber wall",
        site: "alpha",
        action: expect.stringContaining("Log in to alpha") as string,
      },
    });
    expect(w.registry.get("alpha")?.status).toBe("needs_login");
    await w.read.fetch("alpha:1");
    expect(w.count("alpha").read).toBe(2);
  });

  it("never reports ok without a document; a teaser verdict is passed through unchanged", async () => {
    const w = await make([
      { key: "alpha", read: async () => ({ status: "ok" }) },
      {
        key: "beta",
        read: async () => ({
          status: "access_denied",
          message: "paywall teaser",
          document: documentFor("beta", "1", "teaser"),
        }),
      },
    ]);
    const a = await w.read.fetch("alpha:1");
    expect(a.status).toBe("adapter_error");
    expect(a.error?.message).toMatch(/without a document/);
    const b = await w.read.fetch("beta:1");
    expect(b).toMatchObject({
      status: "access_denied",
      error: { code: "access_denied", message: "paywall teaser" },
    });
    expect(b.document).toBeUndefined();
  });

  it("a blocked page starts the cool-down", async () => {
    const w = await make([
      { key: "alpha", read: async () => ({ status: "access_denied", message: "captcha", blocked: true }) },
    ]);
    await w.read.fetch("alpha:1");
    expect(w.scheduler.cooldownUntil("alpha")).not.toBeNull();
    expect((await w.read.fetch("alpha:2")).status).toBe("rate_limited");
  });

  it("cuts fetch text to the 60k budget at a paragraph boundary with truncated: true", async () => {
    const w = await make([{ key: "alpha", read: reader("alpha", 80_000) }]);
    const out = await w.read.fetch("alpha:1");
    expect(out.document?.truncated).toBe(true);
    expect(out.document!.text.length).toBeLessThanOrEqual(60_000);
    expect(out.document!.text.length).toBeGreaterThan(59_000);
    expect(out.document!.text.endsWith(".")).toBe(true);
  });

  it("caps documents at documentMaxChars before caching", async () => {
    const w = await make([{ key: "alpha", read: reader("alpha", 150_000) }], {
      tunables: { fetchTextMaxChars: 500_000 },
    });
    const out = await w.read.fetch("alpha:1");
    expect(out.document!.text.length).toBeLessThanOrEqual(100_000);
    expect(out.document?.truncated).toBe(true);
  });
});

describe("ReadService.readDocuments", () => {
  it("returns per-item outcomes in input order and splits the 120k budget evenly", async () => {
    const w = await make([
      { key: "alpha", read: reader("alpha", 50_000) },
      { key: "beta", read: async () => ({ status: "auth_required" }) },
    ]);
    const refs = ["alpha:1", "https://nowhere.example.net/x", "alpha:2", "beta:9", "alpha:3"];
    const out = await w.read.readDocuments(refs);
    expect(out.items.map((i) => [i.ref, i.status])).toEqual([
      ["alpha:1", "ok"],
      ["https://nowhere.example.net/x", "unsupported"],
      ["alpha:2", "ok"],
      ["beta:9", "auth_required"],
      ["alpha:3", "ok"],
    ]);
    const docs = out.items.flatMap((i) => (i.document ? [i.document] : []));
    expect(docs.map((d) => d.id)).toEqual(["alpha:1", "alpha:2", "alpha:3"]);
    for (const d of docs) {
      expect(d.text.length).toBeLessThanOrEqual(40_000);
      expect(d.truncated).toBe(true);
    }
    expect(docs.reduce((n, d) => n + d.text.length, 0)).toBeLessThanOrEqual(120_000);
    expect(out.items[1]?.error?.availableSites).toEqual(["alpha", "beta"]);
    expect(out.items[3]?.error?.action).toEqual(expect.stringContaining("Log in"));
  });

  it("never goes below the per-item floor", async () => {
    const w = await make([{ key: "alpha", read: reader("alpha", 15_000) }], {
      tunables: { readDocumentsTotalMaxChars: 20_000, readDocumentsMinCharsPerItem: 10_000 },
    });
    const out = await w.read.readDocuments(["alpha:1", "alpha:2", "alpha:3"]);
    for (const i of out.items) {
      expect(i.document!.text.length).toBeLessThanOrEqual(10_000);
      expect(i.document!.text.length).toBeGreaterThan(9_000);
    }
    expect(perItemBudget(120_000, 10_000, 5)).toBe(24_000);
    expect(perItemBudget(20_000, 10_000, 3)).toBe(10_000);
  });
});
