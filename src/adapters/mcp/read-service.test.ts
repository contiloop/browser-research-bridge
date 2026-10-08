import { afterEach, describe, expect, it } from "vitest";
import {
  addOnboarding,
  documentFor,
  longText,
  makeMcpWorld,
  setDegraded,
  setNeedsLogin,
  sleep,
} from "../../../test/support/mcp-fixtures.js";
import type { FakeSiteSpec, McpWorld, WorldOptions } from "../../../test/support/mcp-fixtures.js";
import { challengeAttempt } from "../../../test/support/site-fixtures.js";
import { encodeUrlLocalId } from "../../core/ids.js";
import type { DocumentRef } from "../../core/models.js";
import { NO_SOLVER_MESSAGE, captchaUnsolvedAction } from "./challenge.js";
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

  it("a blocked page does not start a cool-down; the next read reaches the site again", async () => {
    const w = await make([
      { key: "alpha", read: async () => ({ status: "access_denied", message: "captcha", blocked: true }) },
    ]);
    await w.read.fetch("alpha:1");
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect((await w.read.fetch("alpha:2")).status).toBe("access_denied");
    expect(w.count("alpha").read).toBe(2);
  });

  it("a rate_limited read starts the cool-down; the next read is refused with rate_limited", async () => {
    const w = await make([{ key: "alpha", read: async () => ({ status: "rate_limited", message: "429" }) }]);
    await w.read.fetch("alpha:1");
    expect(w.scheduler.cooldownUntil("alpha")).not.toBeNull();
    expect((await w.read.fetch("alpha:2")).status).toBe("rate_limited");
    expect(w.count("alpha").read).toBe(1);
  });

  it("read_documents reads one site's refs in parallel up to the site's pool size", async () => {
    let inFlight = 0;
    let peak = 0;
    const w = await make([
      {
        key: "alpha",
        read: async (ref: DocumentRef) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(40);
          inFlight -= 1;
          const localId = ref.localId ?? "x";
          return {
            status: "ok",
            document: documentFor("alpha", localId, longText(2000, `alpha-${localId}`)),
          };
        },
      },
    ]);
    const out = await w.read.readDocuments(["alpha:1", "alpha:2", "alpha:3", "alpha:4", "alpha:5"]);
    expect(out.items.map((i) => i.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(peak).toBe(3);
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

describe("captcha attempts in live reads", () => {
  const ARTICLE = "https://alpha.example.com/articles/5";
  const blockedRead = { status: "access_denied", message: "captcha page", blocked: true } as const;

  /** A site that shows a captcha until `state.cleared`; then reads normally. */
  function captchaSite(state: { cleared: boolean }): FakeSiteSpec {
    const ok = reader("alpha")!;
    return {
      key: "alpha",
      read: async (ref, ctx) => (state.cleared ? ok(ref, ctx) : blockedRead),
    };
  }

  it("solved: the attempt runs on the read's URL, the re-run confirms, the document is returned", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    const out = await w.read.fetch(ARTICLE);
    expect(out.status).toBe("ok");
    expect(out.document?.url).toBe(ARTICLE);
    expect(w.count("alpha").read).toBe(2);
    expect(w.browser.challenges.map((c) => c.url)).toEqual([ARTICLE]);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect(w.logger.lines.some((l) => l.includes("captcha re-run") && l.includes('"status":"ok"'))).toBe(
      true,
    );
  });

  it("a native id has no URL: the attempt targets the page the adapter last showed, else the homepage", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    w.browser.lastUrls.set("alpha", "https://alpha.example.com/articles/5?view=full");
    expect((await w.read.fetch("alpha:5")).status).toBe("ok");
    expect(w.browser.challenges[0]?.url).toBe("https://alpha.example.com/articles/5?view=full");
  });

  it("a read URL wins over the page the adapter last showed", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    w.browser.lastUrls.set("alpha", "https://alpha.example.com/elsewhere");
    expect((await w.read.fetch(ARTICLE)).status).toBe("ok");
    expect(w.browser.challenges.map((c) => c.url)).toEqual([ARTICLE]);
  });

  it("an Aside without the captcha capability: the action names the solver's message", async () => {
    const w = await make([{ key: "alpha", read: async () => blockedRead }], {
      challenge: {
        solve: async () =>
          challengeAttempt({
            solved: false,
            kind: "unknown",
            rounds: 0,
            available: false,
            message: "captcha solving is not available in this Aside version",
          }),
      },
    });
    const out = await w.read.fetch(ARTICLE);
    expect(out.error?.action).toBe(
      captchaUnsolvedAction(ARTICLE, "captcha solving is not available in this Aside version"),
    );
    expect(out.error?.action).toContain("(captcha solving is not available in this Aside version)");
    expect(w.count("alpha").read).toBe(1);
  });

  it("a native id with no page shown: the attempt targets the site's homepage", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    expect((await w.read.fetch("alpha:5")).status).toBe("ok");
    expect(w.browser.challenges[0]?.url).toBe("https://alpha.example.com/");
  });

  it("unsolved: the re-run is still blocked → the original failure with the captcha action, no cool-down", async () => {
    const why = "the slider captcha is still shown after 2 rounds";
    const w = await make([{ key: "alpha", read: async () => blockedRead }], {
      challenge: {
        solve: async () => challengeAttempt({ solved: false, kind: "slider", rounds: 2, message: why }),
      },
    });
    const out = await w.read.fetch(ARTICLE);
    expect(out).toEqual({
      ref: ARTICLE,
      status: "access_denied",
      error: {
        code: "access_denied",
        message: "captcha page",
        site: "alpha",
        action: captchaUnsolvedAction(ARTICLE, why),
      },
    });
    // One attempt per call: the challenge met again in the re-run is not solved again.
    expect(w.browser.challenges).toHaveLength(1);
    expect(w.count("alpha").read).toBe(2);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect(w.registry.get("alpha")?.status).toBe("active");
    // Logs are metadata only: no URL, no page text.
    expect(w.logger.lines.some((l) => l.includes("captcha re-run"))).toBe(true);
    expect(w.logger.lines.some((l) => l.includes("https://") || l.includes("answered"))).toBe(false);
  });

  it("kind none (no widget found, nothing done) still re-runs the read once", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          state.cleared = true; // the widened reload alone cleared the interstitial
          return challengeAttempt({ solved: false, kind: "none", rounds: 0 });
        },
      },
    });
    expect((await w.read.fetch(ARTICLE)).status).toBe("ok");
    expect(w.count("alpha").read).toBe(2);
  });

  it("the re-run's own non-blocked verdict is returned as it is (e.g. a login wall behind the captcha)", async () => {
    let calls = 0;
    const w = await make(
      [
        {
          key: "alpha",
          read: async () =>
            ++calls === 1 ? blockedRead : { status: "auth_required", message: "login wall" },
        },
      ],
      { challenge: {} },
    );
    const out = await w.read.fetch(ARTICLE);
    expect(out.status).toBe("auth_required");
    expect(out.error?.message).toBe("login wall");
    expect(w.registry.get("alpha")?.status).toBe("needs_login");
  });

  it("setting off: no attempt, one adapter call, today's failure and action, no cool-down", async () => {
    const w = await make([{ key: "alpha", read: async () => blockedRead }], {
      challenge: { settings: { auto: false } },
    });
    const out = await w.read.fetch(ARTICLE);
    expect(out.status).toBe("access_denied");
    expect(out.error?.action).not.toBe(captchaUnsolvedAction(ARTICLE));
    expect(out.error?.action).toContain("Open alpha in Aside");
    expect(w.browser.challenges).toEqual([]);
    expect(w.count("alpha").read).toBe(1);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
  });

  it("a browser without solveChallenge: no re-run, the failure carries the captcha action, logged unavailable", async () => {
    const w = await make([{ key: "alpha", read: async () => blockedRead }], { challenge: { solve: null } });
    const out = await w.read.fetch(ARTICLE);
    expect(out.status).toBe("access_denied");
    expect(out.error?.action).toBe(captchaUnsolvedAction(ARTICLE, NO_SOLVER_MESSAGE));
    expect(w.count("alpha").read).toBe(1);
    expect(
      w.logger.lines.some((l) => l.includes("captcha attempt") && l.includes('"result":"unavailable"')),
    ).toBe(true);
  });

  it("too little budget left: the failure is returned at once and the attempt runs in the background", async () => {
    const state = { cleared: false };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await make([captchaSite(state)], {
      // Every call has less than the inline minimum left.
      challenge: {
        settings: { inlineMinRemainingMs: 200_000 },
        solve: async () => {
          await gate;
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    const first = await w.read.fetch(ARTICLE);
    expect(first.status).toBe("access_denied");
    expect(w.count("alpha").read).toBe(1);
    expect(w.challenges?.inFlight("alpha")).toBe(true);
    release();
    await w.challenges?.settled();
    expect(w.browser.challenges).toHaveLength(1);
    // The next call finds the site unblocked.
    expect((await w.read.fetch(ARTICLE)).status).toBe("ok");
    expect(w.browser.challenges).toHaveLength(1);
  });

  it("an attempt that leaves less than the re-run reserve returns the original failure without a re-run", async () => {
    let nowMs = Date.parse("2026-10-08T10:00:00Z");
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      clock: { now: () => new Date(nowMs) },
      challenge: {
        solve: async (o) => {
          expect(o.budgetMs).toBeLessThanOrEqual(45_000);
          nowMs += 80_000; // the attempt ran long: 10 s of the 90 s call budget remain (reserve 15 s)
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    const out = await w.read.fetch(ARTICLE);
    expect(out.status).toBe("access_denied");
    expect(out.error?.message).toBe("captcha page");
    expect(w.count("alpha").read).toBe(1);
    // The solved state is kept: the next call benefits.
    expect((await w.read.fetch(ARTICLE)).status).toBe("ok");
  });

  it("read_documents: a ref that meets the captcha after the site's attempt ended starts no second one", async () => {
    let attempts = 0;
    const w = await make(
      [
        {
          key: "alpha",
          read: async (ref) => {
            // The second ref meets the block page only after the first ref's attempt is over.
            if (ref.localId === "2") await sleep(80);
            return blockedRead;
          },
        },
      ],
      {
        challenge: {
          solve: async () => {
            attempts += 1;
            return challengeAttempt({ solved: false, kind: "unknown", rounds: 0, message: "x" });
          },
        },
      },
    );
    const out = await w.read.readDocuments(["alpha:1", "alpha:2"]);
    expect(out.items.map((i) => i.status)).toEqual(["access_denied", "access_denied"]);
    expect(attempts).toBe(1);
    expect(w.browser.challenges).toHaveLength(1);
    // The first ref re-ran after its attempt; the second did not attempt (nor re-run) again.
    expect(w.count("alpha").read).toBe(3);
    // A new tool call gets its own attempt.
    await w.read.readDocuments(["alpha:3"]);
    expect(attempts).toBe(2);
  });

  it("read_documents: two reads that meet the captcha at once share one attempt and each re-runs", async () => {
    const state = { cleared: false };
    const w = await make([captchaSite(state)], {
      challenge: {
        solve: async () => {
          await sleep(30);
          state.cleared = true;
          return challengeAttempt();
        },
      },
    });
    const out = await w.read.readDocuments(["alpha:1", "alpha:2"]);
    expect(out.items.map((i) => i.status)).toEqual(["ok", "ok"]);
    expect(w.browser.challenges).toHaveLength(1);
    expect(w.count("alpha").read).toBe(4);
  });
});
