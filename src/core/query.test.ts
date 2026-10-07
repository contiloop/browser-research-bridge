import { describe, expect, it } from "vitest";
import { buildSearchRequest, isValidIsoDate, NO_SEARCH_TERMS_MESSAGE, parseQuery } from "./query.js";

describe("parseQuery", () => {
  it("extracts qualifiers anywhere in the string and keeps the rest as text", () => {
    const q = parseQuery("oil site:reuters after:2024-01-01 prices before:2024-12-31 limit:5 page:2");
    expect(q.text).toBe("oil prices");
    expect(q.terms).toEqual(["oil", "prices"]);
    expect(q.sites).toEqual(["reuters"]);
    expect(q.after).toBe("2024-01-01");
    expect(q.before).toBe("2024-12-31");
    expect(q.limit).toBe(5);
    expect(q.page).toBe(2);
    expect(q.hasTerms).toBe(true);
  });

  it("applies defaults when no qualifiers are given", () => {
    const q = parseQuery("semiconductor export controls");
    expect(q).toMatchObject({ sites: null, after: null, before: null, limit: 10, page: 1 });
  });

  it("collects repeated site: qualifiers, lowercased and de-duplicated", () => {
    const q = parseQuery("x site:reuters SITE:Blog.Naver.com site:reuters");
    expect(q.sites).toEqual(["reuters", "blog.naver.com"]);
    expect(q.text).toBe("x");
  });

  it("treats invalid dates as plain text", () => {
    const q = parseQuery("after:2024-13-01 before:2023-02-29 after:yesterday news");
    expect(q.after).toBeNull();
    expect(q.before).toBeNull();
    expect(q.text).toBe("after:2024-13-01 before:2023-02-29 after:yesterday news");
  });

  it("accepts a leap day", () => {
    expect(parseQuery("a after:2024-02-29").after).toBe("2024-02-29");
  });

  it("clamps limit to 1..25", () => {
    expect(parseQuery("a limit:0").limit).toBe(1);
    expect(parseQuery("a limit:-3").limit).toBe(1);
    expect(parseQuery("a limit:100").limit).toBe(25);
    expect(parseQuery("a limit:25").limit).toBe(25);
  });

  it("clamps page to 1..10", () => {
    expect(parseQuery("a page:0").page).toBe(1);
    expect(parseQuery("a page:99").page).toBe(10);
  });

  it("treats non-numeric limit/page and empty site values as text", () => {
    const q = parseQuery("a limit:abc page:x site:");
    expect(q.text).toBe("a limit:abc page:x site:");
    expect(q.limit).toBe(10);
    expect(q.page).toBe(1);
    expect(q.sites).toBeNull();
  });

  it("takes tunable bounds from options", () => {
    const q = parseQuery("a limit:40 page:15", { limitMax: 50, pageMax: 20 });
    expect(q.limit).toBe(40);
    expect(q.page).toBe(15);
    expect(parseQuery("a", { limitDefault: 7 }).limit).toBe(7);
  });

  it("reports no terms when only qualifiers remain", () => {
    const q = parseQuery("  site:reuters limit:5  ");
    expect(q.hasTerms).toBe(false);
    expect(q.text).toBe("");
    expect(NO_SEARCH_TERMS_MESSAGE).toBe("no search terms");
  });

  it("collapses whitespace", () => {
    expect(parseQuery("  oil\t\n price ").text).toBe("oil price");
  });
});

describe("isValidIsoDate", () => {
  it("validates calendar dates", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
    expect(isValidIsoDate("2024-04-31")).toBe(false);
    expect(isValidIsoDate("2024-4-01")).toBe(false);
    expect(isValidIsoDate("20240401")).toBe(false);
  });
});

describe("buildSearchRequest", () => {
  it("builds the core SearchRequest from qualifiers", () => {
    const { request, page, hasTerms } = buildSearchRequest("oil site:reuters limit:3 page:2");
    expect(request).toEqual({
      text: "oil",
      sites: ["reuters"],
      after: null,
      before: null,
      limit: 3,
      cursor: null,
    });
    expect(page).toBe(2);
    expect(hasTerms).toBe(true);
  });

  it("lets structured fields win over qualifiers, clamping the structured limit", () => {
    const { request } = buildSearchRequest("x site:a limit:3 after:2024-01-01 before:2024-03-01", {
      sites: ["B"],
      limit: 50,
      after: "2024-06-01",
      cursor: "abc",
    });
    expect(request).toEqual({
      text: "x",
      sites: ["b"],
      after: "2024-06-01",
      before: "2024-03-01",
      limit: 25,
      cursor: "abc",
    });
  });

  it("ignores invalid structured dates and empty structured site lists", () => {
    const { request, ignoredFields } = buildSearchRequest("x site:a after:2024-01-01", {
      sites: [],
      after: "2024-02-30",
    });
    expect(request.sites).toEqual(["a"]);
    expect(request.after).toBe("2024-01-01");
    expect(ignoredFields).toEqual(["after"]);
  });
});
