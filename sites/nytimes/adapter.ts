/**
 * The New York Times (www.nytimes.com) — agent-written adapter. See NOTES.md for the site details.
 *
 * - search: the site's own GraphQL search (`SearchRootQuery`, persisted query) on
 *   samizdat-graphql.nytimes.com, the call the /search page makes for "Show more". The API answers
 *   HTTP 403 without the page's app headers, so the adapter opens the /search page and issues the same
 *   request from inside it with the headers the page itself uses (read in the page, never returned).
 *   Relevance order, native date window (`beginDate`/`endDate`) plus a client-side day filter,
 *   offset pagination (Relay cursor `arrayconnection:<index>`), articles only.
 * - read: opens the article, waits for hydration (signed-in account control or a gateway), then
 *   extracts the paragraphs of `section[name="articleBody"]`.
 * - Completeness: every NYT article is metered (JSON-LD isAccessibleForFree false). Full text counts
 *   only with the signed-in account control (`user-settings-button`), no gateway, and no optimistic
 *   server truncation. DataDome's interstitial is a block page.
 */
import type { DocumentRef } from "../../src/core/models.js";
import type {
  AdapterContext,
  AdapterReadResponse,
  AdapterSearchItem,
  AdapterSearchRequest,
  AdapterSearchResponse,
  CompletenessInput,
  ParsedDate,
  SiteAdapter,
  SmokeTestResult,
} from "../../src/ports/adapter.js";
import type { JsonValue } from "../../src/ports/json.js";
import type { CompletenessResult } from "../../src/adapter-kit/index.js";
import {
  clipText,
  completenessChecker,
  dayWindowInZone,
  decodeOffsetCursor,
  documentOf,
  encodeOffsetCursor,
  formatInZone,
  pageScript,
  readFailure,
  readResponse,
  searchFailure,
  searchItem,
  searchResponse,
} from "../../src/adapter-kit/index.js";

const ORIGIN = "https://www.nytimes.com";
const SEARCH_PAGE = `${ORIGIN}/search?query=`;
const GQL_URL = "https://samizdat-graphql.nytimes.com/graphql/v2";
const SEARCH_HASH = "e02b0d975b129a6756400f7c7ee3dc3b1818d5cf57a082f8b1368a264dd03d47";
const TYPE_FILTER = '((type: "article"))';
/** Stop paging well before the API's own cap (totalCount is capped at 10000). */
const MAX_OFFSET = 1000;
const LOGIN_ACTION = "Log in to nytimes.com in Aside (account u0), then retry";
const SUBSCRIPTION_ACTION =
  "Check that the New York Times account in Aside has a subscription that covers this article";
const BLOCK_ACTION =
  "Open https://www.nytimes.com in Aside and complete the bot check if one is shown, then retry";

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

function isNytHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "www.nytimes.com" || h === "nytimes.com" || h === "mobile.nytimes.com";
}

/** One URL per article: `https://www.nytimes.com/<path>` without query or fragment. */
function canonicalize(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !isNytHost(u.hostname)) return url;
  const path = u.pathname.replace(/\/{2,}/g, "/");
  if (path === "" || path === "/") return url;
  return `${ORIGIN}${path}`;
}

const NON_ARTICLE_PREFIXES = [
  "/search",
  "/section/",
  "/by/",
  "/topic/",
  "/subscription",
  "/account",
  "/auth",
  "/crosswords",
  "/games",
  "/puzzles",
  "/paidpost",
  "/video/",
  "/slideshow/",
  "/svc/",
  "/vi-assets/",
];

/** The canonical article URL a read ref points at; null when the ref is not an NYT article URL. */
function articleUrlOf(ref: DocumentRef): string | null {
  const raw = typeof ref.url === "string" ? ref.url : typeof ref.localId === "string" ? ref.localId : null;
  if (raw === null) return null;
  const canonical = canonicalize(raw);
  let u: URL;
  try {
    u = new URL(canonical);
  } catch {
    return null;
  }
  if (!isNytHost(u.hostname)) return null;
  if (NON_ARTICLE_PREFIXES.some((p) => u.pathname.startsWith(p))) return null;
  const segments = u.pathname.split("/").filter((s) => s !== "");
  if (segments.length < 2) return null;
  return canonical;
}

// ---------------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------------

const checkPage = completenessChecker({
  // DataDome interstitial (also matched by COMMON_BLOCK_MARKERS through captcha-delivery.com).
  blockPage: ["Please enable JS and disable any ad blocker", /captcha-delivery\.com/],
  rateLimit: [/<title>\s*429 Too Many Requests/i],
  loginUrls: [/^https?:\/\/myaccount\.nytimes\.com\/auth\//],
  // Registration wall (log in / create a free account to continue).
  loginWall: [/data-testid="(?:regiwall|regi-wall|registration-wall)[^"]*"/i],
  // Subscription gateway rendered over or in place of the body.
  paywall: ['id="gateway-content"', 'data-testid="gateway-content"', /data-testid="paywall-[^"]*"/],
  // The article body container; missing on teasers, error pages and non-article pages.
  required: ['name="articleBody"'],
});

/** True when the page declares the article as not free (every metered NYT article). */
function isPaidArticle(html: string): boolean {
  return /"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html);
}

/** The signed-in account control of the masthead (rendered only for a logged-in session). */
const SIGNED_IN_MARKER = 'data-testid="user-settings-button"';
/** The site masthead; absent when the page never rendered (bot check). */
const MASTHEAD_MARKER = 'data-testid="masthead-container"';
/** The server's paywall-preview flag in the page config (`window.__preloadedData.config`). */
const TRUNCATED_FLAG = /"isOptimisticallyTruncated"\s*:\s*true/;

/**
 * Pure verdict on article-page HTML. A paid article counts as full text only together with the
 * signed-in account control and without the server's optimistic truncation flag.
 */
function checkCompleteness(page: CompletenessInput): CompletenessResult {
  const base = checkPage(page);
  if (base.status !== "ok") return base;
  if (TRUNCATED_FLAG.test(page.html)) {
    return { status: "access_denied", reason: "the server sent a truncated article (paywall preview)" };
  }
  if (isPaidArticle(page.html) && !page.html.includes(SIGNED_IN_MARKER)) {
    return {
      status: "auth_required",
      reason: "metered NYT article without a signed-in session",
    };
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function dateOf(value: string | null, ctx: AdapterContext): ParsedDate | null {
  if (value === null || value.trim() === "") return null;
  return ctx.helpers.parseDate(value.trim(), { timezone: ctx.manifest.timezone, now: ctx.now() });
}

function isDataDome(text: string): boolean {
  return /captcha-delivery\.com|Please enable JS and disable any ad blocker/.test(text);
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/**
 * Waits for the masthead's signed-in control (up to ~4 s), then runs the site's GraphQL search from
 * inside the search page with the page's own GraphQL request headers. Returns the HTTP status, the
 * body, and whether the signed-in control and the masthead were seen.
 */
function searchScript(variables: { [key: string]: JsonValue }, offset: number): string {
  return pageScript`
    const probe = async () => await page.evaluate(() => ({
      header: Boolean(document.querySelector('[data-testid="masthead-container"]')),
      account: Boolean(document.querySelector('[data-testid="user-settings-button"]')),
      dd: document.title === "nytimes.com" || Boolean(document.querySelector('iframe[src*="captcha-delivery"]'))
    }));
    let state = await probe();
    for (let i = 0; i < 8; i++) {
      if (state.account || state.dd) break;
      await sleep(500);
      state = await probe();
    }
    if (state.dd) return { status: 0, text: "captcha-delivery.com", signedIn: false, header: false };
    const result = await page.evaluate(async () => {
      try {
        const data = window.__preloadedData;
        const cfg = data && data.config ? data.config : {};
        const headers = Object.assign({ accept: "application/json" }, cfg.gqlRequestHeaders || {});
        const vars = ${variables};
        const offset = ${offset};
        if (offset > 0) vars.cursor = btoa("arrayconnection:" + (offset - 1));
        const ext = { persistedQuery: { version: 1, sha256Hash: ${SEARCH_HASH} } };
        const url = ${GQL_URL} + "?operationName=SearchRootQuery&variables=" + encodeURIComponent(JSON.stringify(vars)) + "&extensions=" + encodeURIComponent(JSON.stringify(ext));
        const r = await window.fetch(url, { credentials: "include", headers: headers });
        const t = await r.text();
        return { status: r.status, text: t.slice(0, 800000) };
      } catch (e) {
        return { status: 0, text: String(e && e.message ? e.message : e) };
      }
    });
    return { status: result.status, text: result.text, signedIn: state.account, header: state.header };
  `;
}

interface SearchHit {
  url: string;
  title: string;
  summary: string | null;
  firstPublished: string | null;
  byline: string | null;
}

function parseSearchBody(text: string): { hits: SearchHit[]; rawCount: number; hasNext: boolean } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const hits = rec(rec(rec(rec(body)?.["data"])?.["search"])?.["hits"]);
  if (hits === null) return null;
  const edges = Array.isArray(hits["edges"]) ? (hits["edges"] as unknown[]) : null;
  if (edges === null) return null;
  const pageInfo = rec(hits["pageInfo"]);
  const out: SearchHit[] = [];
  for (const e of edges) {
    const node = rec(rec(e)?.["node"]);
    if (node === null) continue;
    const url = str(node["url"]);
    const title =
      str(rec(node["creativeWorkHeadline"])?.["default"]) ??
      str(rec(node["headline"])?.["default"]) ??
      str(node["promotionalHeadline"]);
    if (url === null || title === null || title.trim() === "") continue;
    const bylines: string[] = [];
    if (Array.isArray(node["bylines"])) {
      for (const b of node["bylines"] as unknown[]) {
        const t = str(rec(b)?.["renderedRepresentation"]);
        if (t !== null && t.trim() !== "") bylines.push(t.replace(/^By\s+/i, "").trim());
      }
    }
    out.push({
      url,
      title,
      summary: str(node["creativeWorkSummary"]) ?? str(node["summary"]),
      firstPublished: str(node["firstPublished"]),
      byline: bylines.length > 0 ? bylines.join("; ") : null,
    });
  }
  return { hits: out, rawCount: edges.length, hasNext: pageInfo?.["hasNextPage"] === true };
}

async function search(req: AdapterSearchRequest, ctx: AdapterContext): Promise<AdapterSearchResponse> {
  const text = req.text.trim();
  if (text === "") return searchResponse([], null);
  const offset = decodeOffsetCursor(req.cursor);
  if (offset === null) return searchFailure("adapter_error", "malformed New York Times search cursor");
  if (offset >= MAX_OFFSET) return searchResponse([], null);
  const size = Math.max(1, Math.min(req.limit, 25));
  const tz = ctx.manifest.timezone;

  const variables: { [key: string]: JsonValue } = {
    first: size,
    sort: "best",
    text,
    filterQuery: TYPE_FILTER,
    sectionFacetFilterQuery: TYPE_FILTER,
    sectionFacetActive: false,
    typeFacetActive: false,
  };
  // Native date window in the site zone, in the form the search page sends. The site's window leaks
  // into the following day, so the results are also filtered on firstPublished below.
  const days = dayWindowInZone(req.after, req.before, tz);
  if (days.from) variables["beginDate"] = formatInZone(days.from, tz);
  if (days.until) variables["endDate"] = formatInZone(new Date(days.until.getTime() - 1000), tz);

  const tab = await ctx.browser.openTab(`${SEARCH_PAGE}${encodeURIComponent(text)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = rec(await ctx.browser.runScript(searchScript(variables, offset), { tab, title: "nytimes search" }));
  if (raw === null) {
    return searchFailure("adapter_error", "the New York Times search script returned an unexpected result");
  }
  const status = num(raw["status"]) ?? 0;
  const body = str(raw["text"]) ?? "";

  if (status === 429) {
    return searchFailure("rate_limited", "New York Times search is throttling requests", { blocked: true });
  }
  if (isDataDome(body) || raw["header"] !== true) {
    return searchFailure(
      "access_denied",
      "The New York Times answered with a bot check (the page did not render)",
      { blocked: true, action: BLOCK_ACTION },
    );
  }
  if (raw["signedIn"] !== true) {
    return searchFailure("auth_required", "The New York Times is not signed in in Aside", {
      action: LOGIN_ACTION,
    });
  }
  if (status === 401) {
    return searchFailure("auth_required", "New York Times search answered HTTP 401", { action: LOGIN_ACTION });
  }
  if (status !== 200) {
    return searchFailure("adapter_error", `New York Times search answered HTTP ${status}`);
  }
  const parsed = parseSearchBody(body);
  if (parsed === null) return searchFailure("adapter_error", "unexpected New York Times search API response");
  const fromMs = days.from ? days.from.getTime() : null;
  const untilMs = days.until ? days.until.getTime() : null;
  const results: AdapterSearchItem[] = [];
  for (const h of parsed.hits) {
    let u: URL;
    try {
      u = new URL(h.url);
    } catch {
      continue;
    }
    if (!isNytHost(u.hostname)) continue;
    const t = h.firstPublished !== null ? Date.parse(h.firstPublished) : NaN;
    if (!Number.isNaN(t)) {
      if (fromMs !== null && t < fromMs) continue;
      if (untilMs !== null && t >= untilMs) continue;
    }
    results.push(
      searchItem({
        title: h.title,
        url: canonicalize(h.url),
        date: dateOf(h.firstPublished, ctx),
        excerpt: h.summary,
        author: h.byline,
      }),
    );
  }
  const consumed = offset + parsed.rawCount;
  const more = parsed.hasNext && parsed.rawCount > 0 && consumed < MAX_OFFSET;
  return searchResponse(results.slice(0, req.limit), more ? encodeOffsetCursor(consumed) : null);
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/**
 * Waits for hydration (signed-in control with the article body, or a gateway), watches 3 s more for
 * a late gateway, then returns the page identity, a compact HTML copy for the completeness markers
 * (built from the outerHTML string, never a DOM clone: cloned images would start loading off-site;
 * large inline scripts emptied, JSON-LD kept; the config's truncation flag re-appended), and the
 * article fields. Selectors are documented in NOTES.md.
 */
const READ_SCRIPT = pageScript`
  const probe = async () => await page.evaluate(() => ({
    header: Boolean(document.querySelector('[data-testid="masthead-container"]')),
    account: Boolean(document.querySelector('[data-testid="user-settings-button"]')),
    body: Boolean(document.querySelector('section[name="articleBody"]')),
    wall: Boolean(document.querySelector('#gateway-content, [data-testid="gateway-content"]')),
    dd: document.title === "nytimes.com" || Boolean(document.querySelector('iframe[src*="captcha-delivery"]'))
  }));
  let state = await probe();
  for (let i = 0; i < 24; i++) {
    if (state.dd || state.wall || (state.account && state.body)) break;
    if (!state.header && i >= 10) break;
    await sleep(500);
    state = await probe();
  }
  if (!state.wall && !state.dd && state.header) {
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      state = await probe();
      if (state.wall) break;
    }
  }
  return await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    let html = document.documentElement.outerHTML;
    html = html.replace(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi, (m, attrs, inner) =>
      (attrs.indexOf("ld+json") >= 0 || inner.length <= 5000) ? m : "<script" + attrs + "></script>");
    html = html.replace(/<style\\b[\\s\\S]*?<\\/style>/gi, "").replace(/<svg\\b[\\s\\S]*?<\\/svg>/gi, "");
    const data = window.__preloadedData;
    const cfg = data && data.config ? data.config : null;
    const truncated = Boolean(cfg && cfg.isOptimisticallyTruncated === true);
    const meta = (name) => {
      const m = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
      return m ? m.getAttribute("content") : null;
    };
    let ld = null;
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const j = JSON.parse(s.textContent || "null");
        const t = j ? String(j["@type"] || "") : "";
        if (t.indexOf("Article") >= 0) { ld = j; break; }
      } catch (e) {}
    }
    const authors = [];
    if (ld && Array.isArray(ld.author)) {
      for (const a of ld.author) { if (a && typeof a.name === "string") authors.push(a.name); }
    } else if (ld && ld.author && typeof ld.author.name === "string") {
      authors.push(ld.author.name);
    }
    const body = document.querySelector('section[name="articleBody"]');
    const skip = 'figure, figcaption, [data-testid="inline-interactive"], [data-testid^="InteractiveBlock"], [data-testid^="Dropzone"], [id^="story-ad"], [class*="ad-wrapper"], nav, [role="complementary"], [data-testid="recirculation-placeholder"]';
    const blocks = [];
    if (body) {
      const nodes = Array.from(body.querySelectorAll("p, h2, h3, h4, li, blockquote"));
      for (const n of nodes) {
        if (n.closest(skip)) continue;
        const parent = n.parentElement;
        if (parent && parent.closest("p, li, h2, h3, h4, blockquote")) continue;
        const t = (n.textContent || "").replace(/\\s+/g, " ").trim();
        if (t === "") continue;
        const tag = n.tagName.toLowerCase();
        let kind = "p";
        if (tag === "h2" || tag === "h3" || tag === "h4") kind = "h";
        else if (tag === "li") kind = n.closest("ol") ? "ol" : "ul";
        blocks.push({ kind: kind, text: t });
      }
    }
    const h1 = document.querySelector('h1[data-testid="headline"]') || document.querySelector("h1");
    return {
      url: location.href,
      httpStatus: nav && typeof nav.responseStatus === "number" ? nav.responseStatus : 0,
      html: html.slice(0, 1500000) + (truncated ? '<i hidden>"isOptimisticallyTruncated":true</i>' : ""),
      title: (h1 && h1.textContent) || meta("og:title") || document.title,
      datePublished: ld && typeof ld.datePublished === "string" ? ld.datePublished : meta("article:published_time"),
      dateModified: ld && typeof ld.dateModified === "string" ? ld.dateModified : meta("article:modified_time"),
      section: meta("article:section"),
      byline: meta("byl"),
      pageType: meta("PT"),
      uri: meta("nyt_uri"),
      authors: authors,
      blocks: blocks,
      summary: meta("description"),
      bodyHtml: ""
    };
  });
`;

interface ArticlePage {
  url: string;
  httpStatus: number;
  html: string;
  title: string | null;
  datePublished: string | null;
  dateModified: string | null;
  section: string | null;
  byline: string | null;
  pageType: string | null;
  uri: string | null;
  authors: string[];
  blocks: { kind: string; text: string }[];
  summary: string | null;
}

function asArticlePage(raw: unknown): ArticlePage | null {
  const r = rec(raw);
  if (r === null) return null;
  const url = str(r["url"]);
  if (url === null) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const blocks: { kind: string; text: string }[] = [];
  if (Array.isArray(r["blocks"])) {
    for (const b of r["blocks"] as unknown[]) {
      const o = rec(b);
      const kind = str(o?.["kind"]);
      const text = str(o?.["text"]);
      if (kind !== null && text !== null) blocks.push({ kind, text });
    }
  }
  return {
    url,
    httpStatus: num(r["httpStatus"]) ?? 0,
    html: str(r["html"]) ?? "",
    title: str(r["title"]),
    datePublished: str(r["datePublished"]),
    dateModified: str(r["dateModified"]),
    section: str(r["section"]),
    byline: str(r["byline"]),
    pageType: str(r["pageType"]),
    uri: str(r["uri"]),
    authors: strings(r["authors"]),
    blocks,
    summary: str(r["summary"]),
  };
}

function blocksToText(blocks: { kind: string; text: string }[]): string {
  const parts: string[] = [];
  let olIndex = 0;
  for (const b of blocks) {
    const t = b.text.replace(/\s+/g, " ").trim();
    if (t === "") continue;
    if (b.kind === "h") {
      parts.push(`## ${t}`);
      olIndex = 0;
    } else if (b.kind === "ul") {
      parts.push(`- ${t}`);
    } else if (b.kind === "ol") {
      olIndex += 1;
      parts.push(`${olIndex}. ${t}`);
    } else {
      parts.push(t);
      olIndex = 0;
    }
  }
  return parts.join("\n\n");
}

async function read(ref: DocumentRef, ctx: AdapterContext): Promise<AdapterReadResponse> {
  const url = articleUrlOf(ref);
  if (url === null) {
    return readFailure(
      "unsupported",
      "only New York Times article URLs (https://www.nytimes.com/YYYY/MM/DD/<section>/<slug>.html) can be read",
    );
  }
  const tab = await ctx.browser.openTab(url, { waitUntil: "domcontentloaded" });
  const page = asArticlePage(await ctx.browser.runScript(READ_SCRIPT, { tab, title: "nytimes read article" }));
  if (page === null) {
    return readFailure("adapter_error", "the New York Times article script returned an unexpected result");
  }

  // Completeness first: never `ok` for a bot check, login wall, gateway, or truncated preview.
  let verdict = checkCompleteness({ url: page.url, httpStatus: page.httpStatus, html: page.html });
  if (verdict.status === "auth_required" && !page.html.includes(MASTHEAD_MARKER)) {
    // No masthead at all: the page never rendered (bot check), so the missing account control says
    // nothing about the login.
    verdict = {
      status: "access_denied",
      reason: "The New York Times answered with a bot check (the page did not render)",
      blocked: true,
    };
  }
  if (
    verdict.status === "access_denied" &&
    !verdict.blocked &&
    !page.html.includes(SIGNED_IN_MARKER) &&
    page.html.includes(MASTHEAD_MARKER) &&
    isPaidArticle(page.html)
  ) {
    // A gateway or preview shown to a session without the signed-in control: the login is missing.
    verdict = { status: "auth_required", reason: `${verdict.reason ?? "gateway"} (not signed in)` };
  }
  if (verdict.status !== "ok") {
    const action =
      verdict.status === "auth_required"
        ? LOGIN_ACTION
        : verdict.status === "access_denied"
          ? verdict.blocked
            ? BLOCK_ACTION
            : SUBSCRIPTION_ACTION
          : undefined;
    return readFailure(verdict.status, `The New York Times ${url}: ${verdict.reason ?? verdict.status}`, {
      blocked: verdict.blocked,
      action,
    });
  }

  const body = blocksToText(page.blocks);
  const title = (page.title ?? "").replace(/\s*-\s*The New York Times\s*$/, "").trim();
  if (title === "" || body.trim() === "") {
    return readFailure("empty", `The New York Times ${url} has no readable article text`);
  }
  const paid = isPaidArticle(page.html);
  const author =
    page.authors.length > 0
      ? page.authors.join(", ")
      : page.byline !== null
        ? page.byline.replace(/^By\s+/i, "")
        : null;
  return readResponse(
    documentOf({
      title,
      url: canonicalize(page.url.startsWith(ORIGIN) ? page.url : url),
      text: body,
      date: dateOf(page.datePublished, ctx),
      author,
      accessLevel: paid ? "subscriber" : "public",
      metadata: {
        section: page.section,
        pageType: page.pageType,
        uri: page.uri,
        summary: page.summary !== null && page.summary !== "" ? clipText(page.summary, 300) : null,
        updatedAt: page.dateModified,
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------------------------

async function smokeTest(ctx: AdapterContext): Promise<SmokeTestResult> {
  const page = await search(
    { text: ctx.manifest.sampleQuery, after: null, before: null, limit: 3, cursor: null },
    ctx,
  );
  if (page.status !== "ok" || page.results.length === 0) {
    return {
      status: page.status === "ok" ? "adapter_error" : page.status,
      message: page.message ?? "the sample search returned nothing",
    };
  }
  const first = page.results[0]!;
  const ref: DocumentRef =
    ctx.manifest.sampleReadUrl !== null ? { url: ctx.manifest.sampleReadUrl } : { url: first.url };
  const doc = await read(ref, ctx);
  if (doc.status !== "ok" || !doc.document) {
    return {
      status: doc.status === "ok" ? "adapter_error" : doc.status,
      message: doc.message ?? "the sample read failed",
    };
  }
  if (doc.document.text.length < ctx.manifest.minReadChars) {
    return {
      status: "adapter_error",
      message: `the sample read has only ${doc.document.text.length} characters`,
    };
  }
  return {
    status: "ok",
    message: `search: ${page.results.length} results; read: ${clipText(doc.document.title, 60)} (${doc.document.accessLevel})`,
  };
}

const adapter: SiteAdapter = { search, read, smokeTest, canonicalize, checkCompleteness };

export default adapter;
