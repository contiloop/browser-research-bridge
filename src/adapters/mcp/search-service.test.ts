import { afterEach, describe, expect, it } from "vitest";
import {
  addOnboarding,
  item,
  makeMcpWorld,
  ok,
  setDegraded,
  setNeedsLogin,
  sleep,
} from "../../../test/support/mcp-fixtures.js";
import type { FakeSiteSpec, McpWorld, WorldOptions } from "../../../test/support/mcp-fixtures.js";
import { FakeSiteAssistant } from "../../../test/support/fake-site-assistant.js";
import { challengeAttempt } from "../../../test/support/site-fixtures.js";
import { DATE_POST_FILTER_NOTE } from "../../core/merge.js";
import { OutcomeError } from "../../core/outcome.js";
import type { AdapterSearchRequest } from "../../ports/adapter.js";
import { ASSISTANT_WORKING_ACTIONS } from "./assistant-tasks.js";
import { captchaLimitedAction, captchaUnsolvedAction } from "./challenge.js";
import { SearchService } from "./search-service.js";

let world: McpWorld | null = null;
afterEach(async () => {
  await world?.cleanup();
  world = null;
});

async function make(sites: FakeSiteSpec[], extra: Omit<WorldOptions, "sites"> = {}): Promise<McpWorld> {
  world = await makeMcpWorld({ sites, ...extra });
  return world;
}

/** alpha: three results on one adapter page; beta: one result per adapter page, two pages. */
const paged: FakeSiteSpec[] = [
  {
    key: "alpha",
    search: async () =>
      ok([item("alpha", 1, "2026-10-05"), item("alpha", 2, "2026-10-03"), item("alpha", 3, "2026-10-01")]),
  },
  {
    key: "beta",
    search: async (req) =>
      req.cursor === null
        ? ok([item("beta", 1, "2026-10-04")], "p2")
        : ok([item("beta", 2, "2026-10-02")], null),
  },
];

describe("SearchService: targets and statuses", () => {
  it("searches every active site, merges by date, and reports every registered site", async () => {
    const w = await make([
      { key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01"), item("alpha", 2, null)]) },
      { key: "beta", search: async () => ok([item("beta", 1, "2026-10-03")]) },
      { key: "gamma", search: async () => ok([item("gamma", 1, "2026-10-04")]) },
      { key: "delta", search: async () => ok([item("delta", 1, "2026-10-04")]) },
    ]);
    await setNeedsLogin(w, "gamma");
    await setDegraded(w, "delta", "selector broke");
    await addOnboarding(w, "epsilon");
    await addOnboarding(w, "zeta", "no usable search surface");

    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["beta:1", "alpha:1", "alpha:2"]);
    expect(out.results[0]).toMatchObject({
      site: "beta",
      title: "beta article 1",
      url: "https://beta.example.com/articles/1",
    });
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "ok" },
      { site: "beta", status: "ok" },
      {
        site: "delta",
        status: "adapter_error",
        message: "selector broke",
        action: "Repair in the dashboard",
      },
      { site: "epsilon", status: "unsupported", message: "onboarding in progress" },
      expect.objectContaining({
        site: "gamma",
        status: "auth_required",
        action: expect.stringContaining("Log in") as string,
      }),
      { site: "zeta", status: "adapter_error", message: "no usable search surface" },
    ]);
    expect(w.count("gamma").search).toBe(0);
    expect(w.count("delta").search).toBe(0);
    expect(out.nextPage).toBeNull();
    expect(w.calls.get("alpha")?.search[0]).toMatchObject({ text: "election", limit: 10, cursor: null });
  });

  it("an unknown site: value is reported unsupported and nothing else is searched", async () => {
    const w = await make([{ key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) }]);
    const out = await w.search.search({ query: "q site:nope", mode: "search" });
    expect(out.results).toEqual([]);
    expect(out.siteStatuses).toEqual([
      { site: "nope", status: "unsupported", message: "unknown site: nope" },
    ]);
    expect(w.count("alpha").search).toBe(0);

    const mixed = await w.search.search({ query: "q site:alpha.example.com site:nope", mode: "search" });
    expect(mixed.siteStatuses.map((s) => [s.site, s.status])).toEqual([
      ["alpha", "ok"],
      ["nope", "unsupported"],
    ]);
  });

  it("a named non-active site is not searched and gets its lifecycle entry", async () => {
    const w = await make([{ key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) }]);
    await setNeedsLogin(w, "alpha");
    const out = await w.search.search({ query: "q site:alpha", mode: "search" });
    expect(out.siteStatuses).toEqual([expect.objectContaining({ site: "alpha", status: "auth_required" })]);
    expect(w.count("alpha").search).toBe(0);
  });

  it("no search terms → empty with 'no search terms', adapters not called", async () => {
    const w = await make([{ key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) }]);
    const out = await w.search.search({ query: "site:alpha after:2026-01-01", mode: "search" });
    expect(out.siteStatuses).toEqual([{ site: "alpha", status: "empty", message: "no search terms" }]);
    expect(w.count("alpha").search).toBe(0);
  });

  it("an adapter's empty result is empty with a message", async () => {
    const w = await make([{ key: "alpha", search: async () => ok([]) }]);
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(out.siteStatuses).toEqual([{ site: "alpha", status: "empty", message: "no results" }]);
  });
});

describe("SearchService: live outcomes feed the lifecycle", () => {
  it("auth_required → status entry with action (never empty), site becomes needs_login", async () => {
    const w = await make([
      { key: "alpha", search: async () => ({ results: [], nextCursor: null, status: "auth_required" }) },
      { key: "beta", search: async () => ok([item("beta", 1, "2026-10-01")]) },
    ]);
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(out.siteStatuses[0]).toEqual({
      site: "alpha",
      status: "auth_required",
      message: "login required or session expired",
      action: expect.stringContaining("Log in to alpha") as string,
    });
    expect(out.results.map((r) => r.site)).toEqual(["beta"]);
    expect(w.registry.get("alpha")?.status).toBe("needs_login");

    const again = await w.search.search({ query: "q2", mode: "search" });
    expect(again.siteStatuses[0]).toMatchObject({ site: "alpha", status: "auth_required" });
    expect(w.count("alpha").search).toBe(1);
  });

  it("blocked: true does not start a cool-down; the next call reaches the site again", async () => {
    const w = await make([
      {
        key: "alpha",
        search: async () => ({
          results: [],
          nextCursor: null,
          status: "access_denied",
          message: "captcha",
          blocked: true,
        }),
      },
    ]);
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(out.siteStatuses).toEqual([
      expect.objectContaining({
        site: "alpha",
        status: "access_denied",
        message: "captcha",
        action: expect.any(String) as string,
      }),
    ]);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect(w.registry.get("alpha")?.status).toBe("active");

    const next = await w.search.search({ query: "q other", mode: "search" });
    expect(next.siteStatuses[0]).toMatchObject({ site: "alpha", status: "access_denied" });
    expect(w.count("alpha").search).toBe(2);
  });

  it("rate_limited starts the cool-down; the next call is refused with rate_limited", async () => {
    const w = await make([
      {
        key: "alpha",
        search: async () => ({
          results: [],
          nextCursor: null,
          status: "rate_limited",
          message: "too many requests",
          blocked: true,
        }),
      },
    ]);
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(out.siteStatuses[0]).toMatchObject({ site: "alpha", status: "rate_limited" });
    expect(w.scheduler.cooldownUntil("alpha")).not.toBeNull();
    expect(w.registry.get("alpha")?.status).toBe("active");

    const next = await w.search.search({ query: "q other", mode: "search" });
    expect(next.siteStatuses[0]).toMatchObject({ site: "alpha", status: "rate_limited" });
    expect(w.count("alpha").search).toBe(1);
  });

  it("three consecutive adapter errors degrade the site; malformed data is an adapter_error", async () => {
    const w = await make([{ key: "alpha", search: async () => ({ results: [{ title: 5 }], status: "ok" }) }]);
    for (const q of ["a", "b", "c"]) {
      const out = await w.search.search({ query: q, mode: "search" });
      expect(out.siteStatuses[0]).toMatchObject({ site: "alpha", status: "adapter_error" });
      expect(out.siteStatuses[0]?.message).toMatch(/malformed search results/);
    }
    expect(w.registry.get("alpha")?.status).toBe("degraded");
  });

  it("a throwing adapter contributes zero results and adapter_error; the search itself never throws", async () => {
    const w = await make([
      {
        key: "alpha",
        search: async () => {
          throw new Error("selector .headline not found");
        },
      },
      { key: "beta", search: async () => ok([item("beta", 1, "2026-10-01")]) },
    ]);
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(out.siteStatuses[0]).toEqual({
      site: "alpha",
      status: "adapter_error",
      message: "selector .headline not found",
    });
    expect(out.results).toHaveLength(1);
  });

  it("the tool-call budget turns a slow site into timeout while the others answer", async () => {
    const w = await make(
      [
        {
          key: "alpha",
          search: async (_req, ctx) => {
            await sleep(2000, ctx.signal);
            return ok([]);
          },
        },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-01")]) },
      ],
      { tunables: { toolCallBudgetMs: 150 } },
    );
    const started = Date.now();
    const out = await w.search.search({ query: "q", mode: "search" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out.siteStatuses).toEqual([
      expect.objectContaining({ site: "alpha", status: "timeout" }),
      { site: "beta", status: "ok" },
    ]);
    expect(w.registry.get("alpha")?.status).toBe("active");
  });

  it("an unexpected internal failure still returns a response", async () => {
    const w = await make([{ key: "alpha" }]);
    const broken = new SearchService({
      ...w.deps,
      registry: {
        ...w.registry,
        list: () => {
          throw new Error("boom");
        },
        get: () => undefined,
        load: async () => undefined,
        recordOutcome: async () => undefined,
      },
    });
    const out = await broken.search({ query: "q", mode: "search" });
    expect(out).toMatchObject({ results: [], nextCursor: null, nextPage: null, siteStatuses: [] });
  });
});

describe("SearchService: date filters", () => {
  it("post-filters sites without dateFilter (with a note) and passes the window to native filters", async () => {
    const w = await make([
      {
        key: "alpha",
        search: async () =>
          ok([item("alpha", 1, "2026-10-01"), item("alpha", 2, "2026-09-01"), item("alpha", 3, null)]),
      },
      {
        key: "beta",
        manifest: { capabilities: { search: true, read: true, dateFilter: true } },
        search: async () => ok([item("beta", 1, "2026-09-20")]),
      },
    ]);
    const out = await w.search.search({ query: "q after:2026-09-15", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["alpha:1", "beta:1"]);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "ok", note: DATE_POST_FILTER_NOTE },
      { site: "beta", status: "ok" },
    ]);
    expect(w.calls.get("alpha")?.search[0]).toMatchObject({ after: null, before: null });
    expect(w.calls.get("beta")?.search[0]).toMatchObject({ after: "2026-09-15", before: null });
  });

  it("an ok site whose results all fall outside the window reports empty", async () => {
    const w = await make([{ key: "alpha", search: async () => ok([item("alpha", 1, "2026-01-01")]) }]);
    const out = await w.search.search({ query: "q after:2026-09-15", mode: "search" });
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "empty",
        message: "no results in the date window",
        note: DATE_POST_FILTER_NOTE,
      },
    ]);
  });
});

describe("SearchService: pagination", () => {
  it("search_sites: the cursor resumes each site at its first unemitted result, without duplicates", async () => {
    const w = await make(paged);
    const p1 = await w.search.search({ query: "q", mode: "search_sites", fields: { limit: 2 } });
    expect(p1.results.map((r) => r.id)).toEqual(["alpha:1", "beta:1"]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    expect(p1.nextPage).toBeNull();

    const p2 = await w.search.search({
      query: "q",
      mode: "search_sites",
      fields: { limit: 2, cursor: p1.nextCursor! },
    });
    expect(p2.results.map((r) => r.id)).toEqual(["alpha:2", "beta:2"]);
    expect(w.calls.get("beta")?.search.map((r: AdapterSearchRequest) => r.cursor)).toEqual([null, "p2"]);

    const p3 = await w.search.search({
      query: "q",
      mode: "search_sites",
      fields: { limit: 2, cursor: p2.nextCursor! },
    });
    expect(p3.results.map((r) => r.id)).toEqual(["alpha:3"]);
    expect(p3.nextCursor).toBeNull();
    expect(p3.siteStatuses).toEqual([
      { site: "alpha", status: "ok" },
      { site: "beta", status: "empty", message: "no more results for this query" },
    ]);
  });

  it("an invalid cursor is reported per target site, not thrown", async () => {
    const w = await make(paged);
    const out = await w.search.search({
      query: "q",
      mode: "search_sites",
      fields: { cursor: "!!not-a-cursor" },
    });
    expect(out.results).toEqual([]);
    expect(out.siteStatuses.map((s) => [s.site, s.status])).toEqual([
      ["alpha", "unsupported"],
      ["beta", "unsupported"],
    ]);
    expect(out.siteStatuses[0]?.message).toMatch(/invalid cursor/);
  });

  it("search page:N walks pages 1..N-1 when the chain is missing, then uses the page chain", async () => {
    const w = await make(paged);
    const p2 = await w.search.search({ query: "q limit:2 page:2", mode: "search" });
    expect(p2.results.map((r) => r.id)).toEqual(["alpha:2", "beta:2"]);
    expect(p2.nextPage).toBe(3);
    expect(p2.page).toBe(2);
    expect(w.count("alpha").search).toBe(2);
    expect(w.count("beta").search).toBe(2);

    const again = await w.search.search({ query: "q limit:2 page:2", mode: "search" });
    expect(again.cached).toBe(true);
    expect(again.results.map((r) => r.id)).toEqual(["alpha:2", "beta:2"]);
    expect(w.count("alpha").search).toBe(2);

    const p3 = await w.search.search({ query: "q  limit:2 page:3", mode: "search" });
    expect(p3.results.map((r) => r.id)).toEqual(["alpha:3"]);
    expect(p3.nextPage).toBeNull();
    expect(w.count("alpha").search).toBe(3);
    expect(w.count("beta").search).toBe(2);

    const beyond = await w.search.search({ query: "q limit:2 page:5", mode: "search" });
    expect(beyond.results).toEqual([]);
    expect(beyond.nextPage).toBeNull();
    expect(beyond.siteStatuses.map((s) => [s.site, s.status, s.message])).toEqual([
      ["alpha", "empty", "no more results for this query"],
      ["beta", "empty", "no more results for this query"],
    ]);
  });

  it("page:N without a cache walks every time and still returns the same page", async () => {
    const w = await make(paged, { noCache: true });
    const p2 = await w.search.search({ query: "q limit:2 page:2", mode: "search" });
    expect(p2.results.map((r) => r.id)).toEqual(["alpha:2", "beta:2"]);
    const p2b = await w.search.search({ query: "q limit:2 page:2", mode: "search" });
    expect(p2b.results.map((r) => r.id)).toEqual(["alpha:2", "beta:2"]);
    expect(w.count("alpha").search).toBe(4);
  });
});

describe("SearchService: caching", () => {
  it("serves a repeated page from the cache when every searched site was ok/empty", async () => {
    const w = await make([
      { key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) },
      { key: "beta", search: async () => ok([]) },
    ]);
    await setNeedsLogin(w, "beta");
    const first = await w.search.search({ query: "Q   one", mode: "search" });
    const second = await w.search.search({ query: "q one", mode: "search" });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(second.siteStatuses).toEqual(first.siteStatuses);
    expect(w.count("alpha").search).toBe(1);
  });

  it("does not cache a page in which a searched site failed", async () => {
    const w = await make([
      { key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) },
      { key: "beta", search: async () => ({ results: [], nextCursor: null, status: "timeout" }) },
    ]);
    await w.search.search({ query: "q", mode: "search" });
    const second = await w.search.search({ query: "q", mode: "search" });
    expect(second.cached).toBe(false);
    expect(w.count("alpha").search).toBe(2);
  });
});

describe("SearchService: captcha attempts", () => {
  const blockedSearch = {
    results: [],
    nextCursor: null,
    status: "access_denied",
    message: "captcha page",
    blocked: true,
  } as const;
  const HOME = "https://alpha.example.com/";

  it("solved: the attempt runs on the site's homepage, the re-run's results are returned", async () => {
    const state = { cleared: false };
    const w = await make(
      [
        {
          key: "alpha",
          search: async () => (state.cleared ? ok([item("alpha", 1, "2026-10-05")]) : blockedSearch),
        },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
      ],
      {
        challenge: {
          solve: async () => {
            state.cleared = true;
            return challengeAttempt();
          },
        },
      },
    );
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["alpha:1", "beta:1"]);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "ok" },
      { site: "beta", status: "ok" },
    ]);
    expect(w.browser.challenges.map((c) => c.url)).toEqual([HOME]);
    expect(w.count("alpha").search).toBe(2);
    expect(w.count("beta").search).toBe(1);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
  });

  it("unsolved: the original failure with the captcha action naming the solver's message; other sites are unaffected; nothing raises", async () => {
    const why = "the checkbox captcha is still shown after 2 rounds";
    const w = await make(
      [
        { key: "alpha", search: async () => blockedSearch },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
      ],
      {
        challenge: {
          solve: async () => challengeAttempt({ solved: false, kind: "checkbox", rounds: 2, message: why }),
        },
      },
    );
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["beta:1"]);
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "access_denied",
        message: "captcha page",
        action: captchaUnsolvedAction(HOME, why),
      },
      { site: "beta", status: "ok" },
    ]);
    expect(w.count("alpha").search).toBe(2);
    expect(w.browser.challenges).toHaveLength(1);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
  });

  it("captcha-limited: the site's entry is access_denied with the captcha-limited sentence at once; no re-run, no background; other sites unaffected", async () => {
    const w = await make(
      [
        { key: "alpha", search: async () => blockedSearch },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
      ],
      {
        challenge: {
          solve: async () =>
            challengeAttempt({ solved: false, kind: "unknown", rounds: 0, message: "block-title" }),
        },
      },
    );
    const out = await w.search.search({ query: "election", mode: "search" });
    const sentence = captchaLimitedAction("alpha", HOME);
    expect(out.results.map((r) => r.id)).toEqual(["beta:1"]);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "access_denied", message: sentence, action: sentence },
      { site: "beta", status: "ok" },
    ]);
    expect(w.count("alpha").search).toBe(1);
    expect(w.browser.challenges).toHaveLength(1);
    expect(w.challenges?.inFlight("alpha")).toBe(false);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect(w.registry.get("alpha")?.status).toBe("active");
  });

  it("an unavailable solver is captcha-limited too", async () => {
    const w = await make([{ key: "alpha", search: async () => blockedSearch }], {
      challenge: { solve: null },
    });
    const out = await w.search.search({ query: "election", mode: "search_sites" });
    const sentence = captchaLimitedAction("alpha", HOME);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "access_denied", message: sentence, action: sentence },
    ]);
    expect(w.count("alpha").search).toBe(1);
  });

  it("a solver that throws does not make search raise; the failure carries the captcha action", async () => {
    const w = await make([{ key: "alpha", search: async () => blockedSearch }], {
      challenge: {
        solve: async () => {
          throw new Error("boom");
        },
      },
    });
    const out = await w.search.search({ query: "election", mode: "search_sites" });
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "access_denied",
        message: "captcha page",
        action: captchaUnsolvedAction(HOME),
      },
    ]);
    expect(w.count("alpha").search).toBe(1);
  });

  it("setting off: no attempt, today's failure", async () => {
    const w = await make([{ key: "alpha", search: async () => blockedSearch }], {
      challenge: { settings: { auto: false } },
    });
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses[0]).toMatchObject({
      site: "alpha",
      status: "access_denied",
      message: "captcha page",
    });
    expect(out.siteStatuses[0]?.action).not.toBe(captchaUnsolvedAction(HOME));
    expect(w.browser.challenges).toEqual([]);
    expect(w.count("alpha").search).toBe(1);
  });

  it("a rate_limited throttle page keeps today's cool-down and gets no attempt", async () => {
    const w = await make(
      [
        {
          key: "alpha",
          search: async () => ({ ...blockedSearch, status: "rate_limited", message: "429" }),
        },
      ],
      { challenge: {} },
    );
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses[0]).toMatchObject({ site: "alpha", status: "rate_limited" });
    expect(w.browser.challenges).toEqual([]);
    expect(w.scheduler.cooldownUntil("alpha")).not.toBeNull();
  });

  it("aims the attempt at the page the adapter's session last showed (the site's search page)", async () => {
    const SEARCH_PAGE = "https://alpha.example.com/search?q=election";
    const state = { cleared: false };
    const w = await make(
      [
        {
          key: "alpha",
          search: async () => (state.cleared ? ok([item("alpha", 1, "2026-10-05")]) : blockedSearch),
        },
      ],
      {
        challenge: {
          solve: async () => {
            state.cleared = true;
            return challengeAttempt();
          },
        },
      },
    );
    w.browser.lastUrls.set("alpha", SEARCH_PAGE);
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["alpha:1"]);
    expect(w.browser.challenges.map((c) => c.url)).toEqual([SEARCH_PAGE]);

    await w.cleanup();
    // Unsolved: the action points the user at that page too.
    const w2 = await make([{ key: "alpha", search: async () => blockedSearch }], {
      challenge: {
        solve: async () => challengeAttempt({ solved: false, kind: "none", rounds: 0, message: "" }),
      },
    });
    w2.browser.lastUrls.set("alpha", SEARCH_PAGE);
    const out2 = await w2.search.search({ query: "election", mode: "search" });
    expect(out2.siteStatuses[0]?.action).toBe(captchaUnsolvedAction(SEARCH_PAGE));
    // The search query in that URL never reaches the logs.
    expect(w2.logger.lines.some((l) => l.includes("q=election"))).toBe(false);
  });

  it("one attempt per site per call: a page walked later in the same call is not attempted again", async () => {
    const page1 = [1, 2].map((n) => item("alpha", n, `2026-10-0${n}`));
    let firstCalls = 0;
    const w = await make(
      [
        {
          key: "alpha",
          search: async (req) => {
            if (req.cursor === null) return ++firstCalls === 1 ? blockedSearch : ok(page1, "p2");
            return blockedSearch;
          },
        },
      ],
      { challenge: {} },
    );
    const out = await w.search.search({ query: "q limit:2 page:2", mode: "search" });
    expect(w.browser.challenges).toHaveLength(1);
    expect(out.siteStatuses).toEqual([
      expect.objectContaining({ site: "alpha", status: "access_denied", message: "captcha page" }),
    ]);
    expect(out.siteStatuses[0]?.action).not.toBe(captchaUnsolvedAction(HOME));
  });
});

describe("SearchService: a bot check thrown by a page-script step", () => {
  const HOME = "https://alpha.example.com/";
  const BOT = "alpha answered with a bot check (geo.captcha-delivery.com)";
  const botCheck = () => new OutcomeError("access_denied", BOT, undefined, { blocked: true });

  /**
   * alpha's search runs a page script and lets its failure through. While the fake port has a failure
   * scripted for alpha's page scripts (as the real port throws on a bot check), the script throws.
   */
  const scriptedSite: FakeSiteSpec = {
    key: "alpha",
    search: async (_req, ctx) => {
      await ctx.browser.runScript("return 1;");
      return ok([item("alpha", 1, "2026-10-05")]);
    },
  };

  it("solved: the thrown blocked failure gets the attempt; the re-run's results are returned", async () => {
    const w: McpWorld = await make(
      [scriptedSite, { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) }],
      {
        challenge: {
          solve: async () => {
            w.browser.scriptErrors.delete("alpha");
            return challengeAttempt();
          },
        },
      },
    );
    w.browser.scriptErrors.set("alpha", botCheck());
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.results.map((r) => r.id)).toEqual(["alpha:1", "beta:1"]);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "ok" },
      { site: "beta", status: "ok" },
    ]);
    expect(w.browser.challenges.map((c) => c.url)).toEqual([HOME]);
    expect(w.count("alpha").search).toBe(2);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
  });

  it("unsolved: the bot-check failure carries the captcha action (aimed at the page last shown); no cool-down", async () => {
    const SEARCH_PAGE = "https://alpha.example.com/search?q=election";
    const why =
      "after the checkbox action the page shows a challenge the solver cannot handle (for example an image grid)";
    const w: McpWorld = await make([scriptedSite], {
      challenge: {
        solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 1, message: why }),
      },
    });
    w.browser.scriptErrors.set("alpha", botCheck());
    w.browser.lastUrls.set("alpha", SEARCH_PAGE);
    const out = await w.search.search({ query: "election", mode: "search_sites" });
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "access_denied",
        message: BOT,
        action: captchaUnsolvedAction(SEARCH_PAGE, why),
      },
    ]);
    expect(w.browser.challenges.map((c) => c.url)).toEqual([SEARCH_PAGE]);
    expect(w.count("alpha").search).toBe(2);
    expect(w.scheduler.cooldownUntil("alpha")).toBeNull();
    expect(w.registry.get("alpha")?.status).toBe("active");
    expect(
      w.logger.lines.some((l) => l.includes("site search outcome") && l.includes('"blocked":true')),
    ).toBe(true);
  });

  it("captcha-limited: a bot check the solver cannot act on is answered at once, aimed at the page last shown", async () => {
    const SEARCH_PAGE = "https://alpha.example.com/search?q=election";
    const w: McpWorld = await make([scriptedSite], {
      challenge: { solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 0 }) },
    });
    w.browser.scriptErrors.set("alpha", botCheck());
    w.browser.lastUrls.set("alpha", SEARCH_PAGE);
    const out = await w.search.search({ query: "election", mode: "search_sites" });
    const sentence = captchaLimitedAction("alpha", SEARCH_PAGE);
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "access_denied", message: sentence, action: sentence },
    ]);
    expect(w.count("alpha").search).toBe(1);
    // The search query in the page URL reaches the answer, never the logs.
    expect(w.logger.lines.some((l) => l.includes("q=election"))).toBe(false);
  });

  it("setting off: the bot check is a plain access_denied with the default action, no attempt", async () => {
    const w: McpWorld = await make([scriptedSite], { challenge: { settings: { auto: false } } });
    w.browser.scriptErrors.set("alpha", botCheck());
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "access_denied",
        message: BOT,
        action: "Open alpha in Aside and check the subscription, captcha, or block page, then retry",
      },
    ]);
    expect(w.browser.challenges).toEqual([]);
    expect(w.count("alpha").search).toBe(1);
  });

  it("a thrown failure that is not blocked (a violation on another host) gets no attempt", async () => {
    const w: McpWorld = await make([scriptedSite], { challenge: {} });
    const message = "page script blocked by the bridge: request to evil.test is outside the site's hostnames";
    w.browser.scriptErrors.set("alpha", new OutcomeError("adapter_error", message));
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses).toEqual([{ site: "alpha", status: "adapter_error", message }]);
    expect(w.browser.challenges).toEqual([]);
    expect(w.count("alpha").search).toBe(1);
  });

  it("the adapter's own verdict stands when it catches the bot check and returns one", async () => {
    const w = await make(
      [
        {
          key: "alpha",
          search: async (_req, ctx) => {
            try {
              await ctx.browser.runScript("return 1;");
            } catch {
              return { results: [], nextCursor: null, status: "auth_required", message: "login wall" };
            }
            return ok([]);
          },
        },
      ],
      { challenge: {} },
    );
    w.browser.scriptErrors.set("alpha", botCheck());
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses[0]).toMatchObject({
      site: "alpha",
      status: "auth_required",
      message: "login wall",
    });
    expect(w.browser.challenges).toEqual([]);
  });
});

describe("SearchService: Aside AI tasks (background)", () => {
  const LOGIN = ASSISTANT_WORKING_ACTIONS.login;
  const CAPTCHA = ASSISTANT_WORKING_ACTIONS.captcha;
  const TODAY_LOGIN = "Log in to alpha in Aside, then click Check now in the dashboard";
  const HOME = "https://alpha.example.com/";

  it("a live auth_required search: the site turns needs_login and a login task starts on the page last shown", async () => {
    const fake = new FakeSiteAssistant().hold();
    const w = await make(
      [
        {
          key: "alpha",
          search: async () => ({
            results: [],
            nextCursor: null,
            status: "auth_required",
            message: "signed out",
          }),
        },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
      ],
      { assistant: { fake } },
    );
    w.browser.lastUrls.set("alpha", "https://alpha.example.com/search?q=election");
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses).toEqual([
      { site: "alpha", status: "auth_required", message: "signed out", action: LOGIN },
      { site: "beta", status: "ok" },
    ]);
    expect(w.registry.get("alpha")?.status).toBe("needs_login");
    await sleep(5);
    expect(fake.tasks.map((t) => [t.site, t.purpose, t.url])).toEqual([
      ["alpha", "login", "https://alpha.example.com/search?q=election"],
    ]);
    fake.release();
    await w.assistantTasks?.settled();
  });

  it("site: naming a needs_login site starts a login task (no adapter call); unnamed searches only show a task already running", async () => {
    const fake = new FakeSiteAssistant().hold();
    const w = await make(
      [
        { key: "alpha", search: async () => ok([item("alpha", 1, "2026-10-01")]) },
        { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
      ],
      { assistant: { fake } },
    );
    await setNeedsLogin(w, "alpha");
    // Not named: today's action, nothing starts.
    const unnamed = await w.search.search({ query: "election", mode: "search" });
    expect(unnamed.siteStatuses.find((s) => s.site === "alpha")?.action).toBe(TODAY_LOGIN);
    expect(fake.tasks).toEqual([]);
    // Named: a login task on the homepage.
    const named = await w.search.search({ query: "election site:alpha", mode: "search_sites" });
    expect(named.siteStatuses).toEqual([
      { site: "alpha", status: "auth_required", message: "login required or session expired", action: LOGIN },
    ]);
    expect(w.count("alpha").search).toBe(0);
    await sleep(5);
    expect(fake.tasks.map((t) => [t.purpose, t.url])).toEqual([["login", HOME]]);
    // While it runs, unnamed searches show it too.
    const meanwhile = await w.search.search({ query: "election", mode: "search" });
    expect(meanwhile.siteStatuses.find((s) => s.site === "alpha")?.action).toBe(LOGIN);
    fake.release();
    await w.assistantTasks?.settled();
  });

  it("captcha-limited search: the captcha-limited failure with the working sentence; a captcha task; the log carries no sentence", async () => {
    const blocked = {
      results: [],
      nextCursor: null,
      status: "access_denied",
      message: "captcha",
      blocked: true,
    };
    const w = await make([{ key: "alpha", search: async () => blocked }], {
      challenge: { solve: async () => challengeAttempt({ solved: false, kind: "unknown", rounds: 0 }) },
      assistant: {},
    });
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses).toEqual([
      {
        site: "alpha",
        status: "access_denied",
        message: captchaLimitedAction("alpha", HOME),
        action: CAPTCHA,
      },
    ]);
    await w.assistantTasks?.settled();
    expect(w.assistant?.tasks.map((t) => [t.purpose, t.url])).toEqual([["captcha", HOME]]);
    expect(w.logger.lines.some((l) => l.includes("https://"))).toBe(false);
  });

  it("assistant.auto off: today's entries", async () => {
    const w = await make(
      [
        {
          key: "alpha",
          search: async () => ({
            results: [],
            nextCursor: null,
            status: "auth_required",
            message: "signed out",
          }),
        },
      ],
      { assistant: { settings: { auto: false } } },
    );
    const out = await w.search.search({ query: "election", mode: "search" });
    expect(out.siteStatuses[0]?.action).toBe(TODAY_LOGIN);
    expect(w.assistant?.tasks).toEqual([]);
  });
});
