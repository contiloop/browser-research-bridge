import { describe, expect, it } from "vitest";
import { checkPageScript, shadowParams } from "../adapters/aside/shim.js";
import type { AdapterHelpers } from "../ports/adapter.js";
import { checkPageCompleteness, completenessChecker } from "./completeness.js";
import { decodeOffsetCursor, decodeSiteCursor, encodeOffsetCursor, encodeSiteCursor } from "./cursor.js";
import { createAdapterHelpers } from "./helpers.js";
import * as kit from "./index.js";
import { jsLiteral, pageScript, wrapPageScript } from "./page-script.js";
import { documentOf, readFailure, searchFailure, searchItem, searchResponse } from "./results.js";
import { absoluteUrl, canonicalizeUrl, queryParam, urlOnHosts } from "./url.js";

describe("url helpers", () => {
  it("resolves hrefs to absolute http(s) URLs only", () => {
    expect(absoluteUrl("/a?b=1", "https://site.example/x/y")).toBe("https://site.example/a?b=1");
    expect(absoluteUrl("javascript:void(0)", "https://site.example/")).toBeNull();
    expect(absoluteUrl("mailto:a@b.c")).toBeNull();
    expect(absoluteUrl("relative")).toBeNull();
  });

  it("checks hosts with subdomains and www", () => {
    expect(urlOnHosts("https://www.reuters.com/a", ["reuters.com"])).toBe(true);
    expect(urlOnHosts("https://m.blog.naver.com/a", ["blog.naver.com"])).toBe(true);
    expect(urlOnHosts("https://naver.com/a", ["blog.naver.com"])).toBe(false);
    expect(urlOnHosts("https://evilreuters.com/", ["reuters.com"])).toBe(false);
    expect(urlOnHosts("ftp://reuters.com/", ["reuters.com"])).toBe(false);
  });

  it("reads query parameters", () => {
    expect(queryParam("https://news.example.com/item?id=42&p=2", "id")).toBe("42");
    expect(queryParam("not a url", "id")).toBeNull();
  });

  it("canonicalizes with host mapping, parameter filters and fragment removal", () => {
    const url = "http://M.Blog.Naver.com/user/123/?utm_source=x&logNo=5&fromRss=true#comments";
    expect(
      canonicalizeUrl(url, {
        https: true,
        host: "blog.naver.com",
        dropParams: ["utm_*", "fromRss"],
        stripTrailingSlash: true,
      }),
    ).toBe("https://blog.naver.com/user/123?logNo=5");
    expect(
      canonicalizeUrl("https://www.site.example/a?id=1&x=2", { stripWww: true, keepParams: ["id"] }),
    ).toBe("https://site.example/a?id=1");
    expect(canonicalizeUrl("https://site.example/a#top", { keepFragment: true })).toBe(
      "https://site.example/a#top",
    );
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("site cursors", () => {
  it("round-trips JSON state, including non-ASCII text", () => {
    const state = { page: 3, token: "다음 페이지/+=", nested: [1, null, true] };
    const cursor = encodeSiteCursor(state);
    expect(cursor).toMatch(/^c1\.[A-Za-z0-9_-]+$/);
    expect(decodeSiteCursor(cursor)).toEqual(state);
  });

  it("rejects malformed, foreign, and oversized cursors", () => {
    expect(decodeSiteCursor(null)).toBeNull();
    expect(decodeSiteCursor("")).toBeNull();
    expect(decodeSiteCursor("c1.!!!")).toBeNull();
    expect(decodeSiteCursor("c2.e30")).toBeNull();
    expect(decodeSiteCursor("c1.bm90IGpzb24")).toBeNull(); // "not json"
    expect(decodeSiteCursor(`c1.${"A".repeat(5000)}`)).toBeNull();
  });

  it("offset cursors: null cursor is the first page, malformed is null", () => {
    expect(decodeOffsetCursor(null)).toBe(0);
    expect(decodeOffsetCursor(encodeOffsetCursor(20))).toBe(20);
    expect(decodeOffsetCursor(encodeSiteCursor({ o: -1 }))).toBeNull();
    expect(decodeOffsetCursor(encodeSiteCursor([1]))).toBeNull();
    expect(decodeOffsetCursor("garbage")).toBeNull();
  });
});

describe("pageScript", () => {
  it("wraps the body in an async IIFE so nothing is declared at the top level", () => {
    const script = pageScript`const x = 1; return x;`;
    expect(script).toBe("return await (async () => {\nconst x = 1; return x;\n})();");
    expect(wrapPageScript("  return 1;  ")).toBe("return await (async () => {\nreturn 1;\n})();");
  });

  it("embeds interpolated values as JSON literals", () => {
    const selector = 'a[href*="x"]';
    const evil = '"; while(true){} "`${x}`';
    const script = pageScript`return [${selector}, ${evil}, ${42}, ${null}, ${{ a: [1] }}];`;
    expect(script).toContain(`[${JSON.stringify(selector)}, ${JSON.stringify(evil)}, 42, null, {"a":[1]}]`);
    expect(jsLiteral("a\u2028b")).toBe('"a\\u2028b"');
  });

  it("produces scripts the browser port accepts and that run as a function body", async () => {
    const script = pageScript`
      const items = await page.evaluate(() => Array.from(document.querySelectorAll(${"li"})).map((li) => li.textContent));
      return { items, n: args.n };`;
    expect(checkPageScript(script, shadowParams())).toEqual({ ok: true });
    const proto = Object.getPrototypeOf(async () => undefined) as {
      constructor: new (...params: string[]) => (...values: unknown[]) => Promise<unknown>;
    };
    const fn = new proto.constructor("page", "args", script);
    const page = { evaluate: async (f: () => unknown) => (f.length === 0 ? ["a"] : null) };
    await expect(fn(page, { n: 2 })).resolves.toEqual({ items: ["a"], n: 2 });
  });
});

describe("completeness checks", () => {
  const page = (html: string, httpStatus = 200, url = "https://site.example/a") => ({
    url,
    httpStatus,
    html,
  });
  const rules = {
    loginWall: ["Sign in to continue reading"],
    loginUrls: [/\/login\b/],
    paywall: [/class="paywall"/],
    blockPage: ["Are you a robot?"],
    rateLimit: ["Too many requests"],
    required: ['data-testid="article-body"'],
  };

  it("passes only a page with the full-text marker and no wall", () => {
    expect(checkPageCompleteness(page('<div data-testid="article-body">text</div>'), rules)).toEqual({
      status: "ok",
    });
    expect(checkPageCompleteness(page("<div>teaser</div>"), rules).status).toBe("access_denied");
  });

  it("classifies walls, blocks and throttling", () => {
    expect(checkPageCompleteness(page("Sign in to continue reading"), rules).status).toBe("auth_required");
    expect(checkPageCompleteness(page("x", 200, "https://site.example/login?next=/a"), rules).status).toBe(
      "auth_required",
    );
    expect(checkPageCompleteness(page('<div class="paywall">'), rules).status).toBe("access_denied");
    expect(checkPageCompleteness(page("Are you a robot?"), rules)).toMatchObject({
      status: "access_denied",
      blocked: true,
    });
    expect(checkPageCompleteness(page("Too many requests"), rules)).toMatchObject({
      status: "rate_limited",
      blocked: true,
    });
    expect(checkPageCompleteness(page("<title>Just a moment...</title>"), rules)).toMatchObject({
      blocked: true,
    });
    expect(
      checkPageCompleteness(page("<title>Just a moment...</title>"), { commonBlockMarkers: false }),
    ).toEqual({
      status: "ok",
    });
  });

  it("maps HTTP statuses", () => {
    expect(checkPageCompleteness(page("", 429), {})).toMatchObject({ status: "rate_limited", blocked: true });
    expect(checkPageCompleteness(page("", 401), {}).status).toBe("auth_required");
    expect(checkPageCompleteness(page("", 403), {}).status).toBe("access_denied");
    expect(checkPageCompleteness(page("", 404), {}).status).toBe("empty");
    expect(checkPageCompleteness(page("", 502), {}).status).toBe("adapter_error");
    // A login wall served with 403 is still a login wall.
    expect(checkPageCompleteness(page("Sign in to continue reading", 403), rules).status).toBe(
      "auth_required",
    );
  });

  it("binds rules into a reusable checker", () => {
    const check = completenessChecker({ required: [/<article/] });
    expect(check(page("<article>x</article>")).status).toBe("ok");
    expect(check(page("<div>")).reason).toContain("full-text marker");
  });
});

describe("result builders", () => {
  it("cleans search items and clips excerpts", () => {
    const item = searchItem(
      {
        title: "  A\n title ",
        url: " https://site.example/a ",
        localId: 42,
        date: { publishedAt: "2024-01-02T00:00:00+00:00", datePrecision: "day" },
        excerpt: "word ".repeat(100),
        author: "",
      },
      { excerptChars: 20 },
    );
    expect(item).toEqual({
      localId: "42",
      title: "A title",
      url: "https://site.example/a",
      publishedAt: "2024-01-02T00:00:00+00:00",
      datePrecision: "day",
      excerpt: "word word word word…",
      author: null,
    });
  });

  it("builds documents with string metadata and a public default", () => {
    const doc = documentOf({
      title: "T",
      url: "https://site.example/a",
      text: "  body  ",
      metadata: { points: 3, flag: true, none: null, missing: undefined, empty: "" },
    });
    expect(doc).toEqual({
      localId: null,
      title: "T",
      url: "https://site.example/a",
      publishedAt: null,
      datePrecision: null,
      author: null,
      text: "body",
      accessLevel: "public",
      metadata: { points: "3", flag: "true" },
    });
  });

  it("derives ok/empty from the result count and builds failures", () => {
    expect(searchResponse([], "c")).toEqual({ results: [], nextCursor: null, status: "empty" });
    const one = searchItem({ title: "t", url: "https://site.example/a" });
    expect(searchResponse([one], "c").status).toBe("ok");
    expect(searchFailure("access_denied", "captcha", { blocked: true, action: "solve it" })).toEqual({
      results: [],
      nextCursor: null,
      status: "access_denied",
      message: "captcha",
      action: "solve it",
      blocked: true,
    });
    expect(readFailure("auth_required", "login wall")).toEqual({
      status: "auth_required",
      message: "login wall",
    });
  });
});

describe("createAdapterHelpers and the barrel", () => {
  it("implements the injected AdapterHelpers port, including the optional members", () => {
    const helpers: AdapterHelpers = createAdapterHelpers();
    expect(helpers.parseDate("2024-01-02", { timezone: "Asia/Seoul" })?.publishedAt).toBe(
      "2024-01-02T00:00:00+09:00",
    );
    expect(helpers.extractText("<p>a</p><p>b</p>")).toBe("a\n\nb");
    expect(helpers.snapshotToText('- paragraph: "x"')).toBe("x");
    const cursor = helpers.encodeCursor({ p: 2 });
    expect(helpers.decodeCursor(cursor)).toEqual({ p: 2 });
  });

  it("exports the adapter-facing API from index.ts", () => {
    for (const name of [
      "createAdapterHelpers",
      "parseDate",
      "extractText",
      "snapshotToText",
      "pageScript",
      "encodeSiteCursor",
      "decodeSiteCursor",
      "canonicalizeUrl",
      "completenessChecker",
      "searchItem",
      "documentOf",
    ]) {
      expect(typeof (kit as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
