/**
 * The Wall Street Journal (www.wsj.com) — agent-written adapter. See NOTES.md for the site details.
 *
 * - search: the site's own search page `/search?query=…&products=wsj&dateRange=…&page=N` is a
 *   Next.js page whose server-rendered `__NEXT_DATA__` carries `props.pageProps.searchResults`.
 *   DataDome rejects requests from outside a page (HTTP 401, captcha-delivery.com interstitial), so
 *   the adapter opens the search page in a bridge tab (one page load per result page) and reads the
 *   embedded JSON. Semantic search: relevance order, at most ~30 hits (page 1: 20, page 2: 10).
 *   The UI offers only relative date ranges (1d/7d/30d/1yr/all); the adapter picks the smallest one
 *   covering `after` and filters locally (capabilities.dateFilter stays false, the core filters too).
 * - read: opens the article, waits for hydration and the header's account control, then extracts
 *   the body blocks (`p[data-type="paragraph"]`, `h3[data-type="hed"]`, list items) from the section
 *   that holds the paragraphs (its `.paywall` child is the subscriber part).
 * - Completeness: WSJ decides on the server. Subscribers get `article.template=full`,
 *   `"isSnippetView":false` and the `.paywall` container; others get the snippet view. DataDome
 *   interstitials are block pages.
 *
 * Page scripts are `pageScript` tagged templates, which use the template's *cooked* strings: a
 * backslash escape such as `\s` inside them loses its backslash (`/\s+/` became `/s+/` and deleted
 * every letter "s" from the article text in version 1). Keep page scripts free of backslashes and
 * do regex work on the adapter side instead.
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
import type { CompletenessResult } from "../../src/adapter-kit/index.js";
import {
  clipText,
  completenessChecker,
  dayWindowInZone,
  decodeOffsetCursor,
  documentOf,
  encodeOffsetCursor,
  findMarker,
  pageScript,
  readFailure,
  readResponse,
  searchFailure,
  searchItem,
  searchResponse,
} from "../../src/adapter-kit/index.js";

const ORIGIN = "https://www.wsj.com";
/** Results per search page (the site's fixed page size). */
const PAGE_SIZE = 20;
/** Semantic search returns ~30 hits; never page past this offset. */
const MAX_OFFSET = 200;
const LOGIN_ACTION = "Log in to wsj.com in Aside (account u0), then retry";
const SUBSCRIPTION_ACTION =
  "Check that the WSJ account in Aside has a subscription that covers this article (WSJ Pro and some products need their own subscription)";
const BLOCK_ACTION = "Open https://www.wsj.com in Aside and complete the bot check if one is shown, then retry";

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

function isWsjHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "www.wsj.com" || h === "wsj.com";
}

/** One URL per article: `https://www.wsj.com/<path>` without query, fragment, or trailing slash. */
function canonicalize(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !isWsjHost(u.hostname)) return url;
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path === "" || path === "/") return url;
  path = path.replace(/\/+$/, "");
  return `${ORIGIN}${path}`;
}

/** Paths that are not standard articles (other page templates, tools, listings). */
const NON_ARTICLE_PREFIXES = [
  "/livecoverage/",
  "/video/",
  "/podcasts/",
  "/audio/",
  "/buyside/",
  "/games",
  "/market-data/",
  "/search",
  "/news/author/",
  "/news/types/",
  "/news/latest-headlines",
  "/client",
  "/digital-print-edition",
  "/print-edition/",
  "/subscriptions",
  "/_next/",
];

/** The canonical article URL a read ref points at; null when it is not a WSJ article URL. */
function articleUrlOf(ref: DocumentRef): string | null {
  // The adapter emits no localIds (ids are URL-based); a localId that is a URL is accepted anyway.
  const raw = typeof ref.url === "string" ? ref.url : typeof ref.localId === "string" ? ref.localId : null;
  if (raw === null) return null;
  const canonical = canonicalize(raw);
  let u: URL;
  try {
    u = new URL(canonical);
  } catch {
    return null;
  }
  if (!isWsjHost(u.hostname)) return null;
  const segments = u.pathname.split("/").filter((s) => s !== "");
  if (segments.length < 2) return null;
  if (NON_ARTICLE_PREFIXES.some((p) => u.pathname.startsWith(p))) return null;
  return canonical;
}

// ---------------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------------

/** DataDome interstitial (served with HTTP 401/403 instead of the page). */
const BLOCK_MARKERS = [
  /geo\.captcha-delivery\.com/,
  /ct\.captcha-delivery\.com/,
  "Please enable JS and disable any ad blocker",
];

const checkPage = completenessChecker({
  blockPage: BLOCK_MARKERS,
  rateLimit: [/<title>\s*429 Too Many Requests/i],
  loginUrls: [/^https?:\/\/(?:www\.)?wsj\.com\/client\/login/, /^https?:\/\/sso\.accounts\.dowjones\.com\//],
  // Snippet (teaser) view served to readers without the entitlement.
  paywall: [
    '"isSnippetView":true',
    /<meta name="article\.template" content="snippet"/,
    /Continue reading your article with\s+a\s+WSJ/i,
  ],
  // The full-article template; missing on snippets, error pages and non-article pages.
  required: [/<meta name="article\.template" content="full"/],
});

/** True when the page declares the article as paid (subscriber) content. */
function isPaidArticle(html: string): boolean {
  if (/<meta name="article\.access" content="paid"/.test(html)) return true;
  if (/"isFreeArticle":false/.test(html)) return true;
  return /"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html);
}

/**
 * Pure verdict on article-page HTML. A DataDome interstitial is a block page whatever its HTTP
 * status; a paid article counts as full text only with the subscriber markers (the snippet flag set
 * to false or the paywalled body container).
 */
function checkCompleteness(page: CompletenessInput): CompletenessResult {
  const block = findMarker(page.html ?? "", BLOCK_MARKERS);
  if (block !== null) {
    return { status: "access_denied", reason: "WSJ answered with a DataDome bot check", blocked: true };
  }
  const base = checkPage(page);
  if (base.status !== "ok") return base;
  const html = page.html;
  if (isPaidArticle(html) && !html.includes('"isSnippetView":false') && !/class="paywall[\s"]/.test(html)) {
    return {
      status: "access_denied",
      reason: "paid WSJ article without the subscriber body (snippet view)",
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

function strings(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

function dateOf(value: string | null, ctx: AdapterContext): ParsedDate | null {
  if (value === null || value.trim() === "") return null;
  return ctx.helpers.parseDate(value.trim(), { timezone: ctx.manifest.timezone, now: ctx.now() });
}

/** Collapses whitespace runs (adapter side: regex escapes are safe here, unlike in page scripts). */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/**
 * Waits for the search page's `__NEXT_DATA__` and the header's account control (the signed-in
 * user button) or a sign-in link (up to ~8 s), then returns the search results from the embedded
 * JSON. `dd` reports a DataDome interstitial in place of the page. No backslashes in here.
 */
const SEARCH_SCRIPT = pageScript`
  const probe = async () => await page.evaluate(() => {
    const signIn = Array.from(document.querySelectorAll('a, button')).some((e) => {
      const t = (e.textContent || "").trim().toLowerCase();
      const h = e.getAttribute("href") || "";
      return t === "sign in" || t === "log in" || h.indexOf("/client/login") >= 0;
    });
    const next = Boolean(document.getElementById("__NEXT_DATA__"));
    return {
      next: next,
      account: Boolean(document.querySelector('button[class*="NavButton"]')),
      signIn: signIn,
      dd: next ? false : document.documentElement.outerHTML.indexOf("captcha-delivery.com") >= 0
    };
  });
  let state = await probe();
  for (let i = 0; i < 16; i++) {
    if (state.dd) break;
    if (state.next && (state.account || state.signIn)) break;
    if (!state.next && i >= 8) break;
    await sleep(500);
    state = await probe();
  }
  const data = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const httpStatus = nav && typeof nav.responseStatus === "number" ? nav.responseStatus : 0;
    const nd = document.getElementById("__NEXT_DATA__");
    if (!nd) return { httpStatus: httpStatus, parsed: false, page: null, results: null, pageNumber: null };
    let j = null;
    try { j = JSON.parse(nd.textContent || "null"); } catch (e) { j = null; }
    if (!j || !j.props) return { httpStatus: httpStatus, parsed: false, page: null, results: null, pageNumber: null };
    const pp = j.props.pageProps || {};
    const list = Array.isArray(pp.searchResults) ? pp.searchResults : null;
    const results = list === null ? null : list.map((r) => {
      const authors = [];
      if (r && Array.isArray(r.bylineData)) {
        for (const b of r.bylineData) {
          if (b && b.type === "author" && typeof (b.name || b.text) === "string") authors.push(b.name || b.text);
        }
      }
      return {
        url: r && typeof r.articleUrl === "string" ? r.articleUrl : null,
        headline: r && typeof r.headline === "string" ? r.headline : null,
        summary: r && typeof r.summary === "string" ? r.summary : null,
        timestamp: r && typeof r.timestamp === "string" ? r.timestamp : null,
        flashline: r && typeof r.flashline === "string" ? r.flashline : null,
        authors: authors
      };
    });
    return { httpStatus: httpStatus, parsed: true, page: typeof j.page === "string" ? j.page : null, results: results, pageNumber: typeof pp.pageNumber === "number" ? pp.pageNumber : null };
  });
  return { state: state, data: data };
`;

interface SearchHit {
  url: string;
  headline: string;
  summary: string | null;
  timestamp: string | null;
  authors: string[];
}

function parseHits(v: unknown): SearchHit[] | null {
  if (!Array.isArray(v)) return null;
  const out: SearchHit[] = [];
  for (const item of v as unknown[]) {
    const r = rec(item);
    // Keep a placeholder for malformed entries so offsets stay aligned with the site's page.
    const url = str(r?.["url"]);
    const headline = str(r?.["headline"]);
    out.push({
      url: url ?? "",
      headline: headline ?? "",
      summary: str(r?.["summary"]),
      timestamp: str(r?.["timestamp"]),
      authors: strings(r?.["authors"]),
    });
  }
  return out;
}

/** The smallest relative range of the WSJ search UI that covers `after` (relative to now). */
function dateRangeFor(after: string | null, ctx: AdapterContext): string {
  const { from } = dayWindowInZone(after, null, ctx.manifest.timezone);
  if (from === null) return "all";
  const ageMs = ctx.now().getTime() - from.getTime();
  const day = 86_400_000;
  if (ageMs <= day) return "1d";
  if (ageMs <= 7 * day) return "7d";
  if (ageMs <= 30 * day) return "30d";
  if (ageMs <= 365 * day) return "1yr";
  return "all";
}

async function search(req: AdapterSearchRequest, ctx: AdapterContext): Promise<AdapterSearchResponse> {
  const text = req.text.trim();
  if (text === "") return searchResponse([], null);
  const offset = decodeOffsetCursor(req.cursor);
  if (offset === null) return searchFailure("adapter_error", "malformed WSJ search cursor");
  if (offset >= MAX_OFFSET) return searchResponse([], null);
  const limit = Math.max(1, Math.min(req.limit, 25));
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;
  const skip = offset % PAGE_SIZE;

  const params = new URLSearchParams({
    query: text,
    dateRange: dateRangeFor(req.after, ctx),
    products: "wsj",
  });
  if (pageNumber > 1) params.set("page", String(pageNumber));
  const tab = await ctx.browser.openTab(`${ORIGIN}/search?${params.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = rec(await ctx.browser.runScript(SEARCH_SCRIPT, { tab, title: "wsj search" }));
  const state = rec(raw?.["state"]);
  const data = rec(raw?.["data"]);
  if (raw === null || state === null || data === null) {
    return searchFailure("adapter_error", "the WSJ search script returned an unexpected result");
  }
  const httpStatus = num(data["httpStatus"]) ?? 0;
  if (httpStatus === 429) {
    return searchFailure("rate_limited", "WSJ search is throttling requests", { blocked: true });
  }
  if (state["dd"] === true || (data["parsed"] !== true && (httpStatus === 401 || httpStatus === 403))) {
    return searchFailure("access_denied", "WSJ answered with a DataDome bot check", {
      blocked: true,
      action: BLOCK_ACTION,
    });
  }
  if (data["parsed"] !== true) {
    return searchFailure("adapter_error", `WSJ search page has no result data (HTTP ${httpStatus})`);
  }
  // The manifest requires the login: a rendered page with a sign-in link and no account control
  // means the WSJ session in Aside is gone, even though search itself answers.
  if (state["account"] !== true && state["signIn"] === true) {
    return searchFailure("auth_required", "WSJ is not signed in in Aside", { action: LOGIN_ACTION });
  }
  if (data["page"] !== null && data["page"] !== "/search") {
    return searchFailure("adapter_error", "WSJ search answered with an unexpected page");
  }
  const hits = parseHits(data["results"]) ?? [];

  const { from, until } = dayWindowInZone(req.after, req.before, ctx.manifest.timezone);
  const fromMs = from ? from.getTime() : null;
  const untilMs = until ? until.getTime() : null;
  const results: AdapterSearchItem[] = [];
  let consumed = skip;
  for (let i = skip; i < hits.length && results.length < limit; i++) {
    consumed = i + 1;
    const h = hits[i]!;
    if (h.url === "" || h.headline.trim() === "") continue;
    const url = articleUrlOf({ url: h.url });
    if (url === null) continue;
    const t = h.timestamp !== null ? Date.parse(h.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (fromMs !== null && t < fromMs) continue;
      if (untilMs !== null && t >= untilMs) continue;
    }
    results.push(
      searchItem({
        title: h.headline,
        url,
        date: dateOf(h.timestamp, ctx),
        excerpt: h.summary,
        author: h.authors.length > 0 ? h.authors.join(", ") : null,
      }),
    );
  }
  if (results.length < limit) consumed = Math.max(consumed, hits.length);
  let next: number | null = null;
  if (consumed < hits.length) next = (pageNumber - 1) * PAGE_SIZE + consumed;
  else if (hits.length >= PAGE_SIZE) next = pageNumber * PAGE_SIZE;
  if (next !== null && next >= MAX_OFFSET) next = null;
  return searchResponse(results, next !== null ? encodeOffsetCursor(next) : null);
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/**
 * Waits for hydration (article paragraphs plus the header account control or a sign-in link), then
 * returns the page identity, a compact HTML copy for the completeness markers (large inline scripts
 * emptied; `__NEXT_DATA__` replaced by its access flags only), and the article fields.
 *
 * The block texts come back as raw `textContent` (only trimmed); whitespace is collapsed by
 * `blocksToText` on the adapter side. Do not put regex escapes (`\s`, `\d`, …) in this template:
 * `pageScript` drops their backslashes.
 */
const READ_SCRIPT = pageScript`
  const probe = async () => await page.evaluate(() => {
    const signIn = Array.from(document.querySelectorAll('a, button')).some((e) => {
      const t = (e.textContent || "").trim().toLowerCase();
      const h = e.getAttribute("href") || "";
      return t === "sign in" || t === "log in" || h.indexOf("/client/login") >= 0;
    });
    return {
      next: Boolean(document.getElementById("__NEXT_DATA__")),
      paras: document.querySelectorAll('p[data-type="paragraph"]').length,
      account: Boolean(document.querySelector('button[class*="NavButton"]')),
      signIn: signIn
    };
  });
  let state = await probe();
  for (let i = 0; i < 24; i++) {
    if ((state.account || state.signIn) && (state.paras > 0 || state.next)) break;
    if (state.paras > 0 && i >= 8) break;
    if (!state.next && state.paras === 0 && i >= 10) break;
    await sleep(500);
    state = await probe();
  }
  return await page.evaluate((st) => {
    const nav = performance.getEntriesByType("navigation")[0];
    let flags = { isSnippetView: null, isFreeArticle: null, pageAccessType: null, page: null };
    const nd = document.getElementById("__NEXT_DATA__");
    if (nd) {
      try {
        const j = JSON.parse(nd.textContent || "null");
        const pp = (j && j.props && j.props.pageProps) || {};
        const tm = pp.articleData && pp.articleData.articleTrackingMeta;
        flags = {
          isSnippetView: typeof pp.isSnippetView === "boolean" ? pp.isSnippetView : null,
          isFreeArticle: typeof pp.isFreeArticle === "boolean" ? pp.isFreeArticle : null,
          pageAccessType: tm && typeof tm.pageAccessType === "string" ? tm.pageAccessType : null,
          page: j && typeof j.page === "string" ? j.page : null
        };
      } catch (e) {}
    }
    const clone = document.documentElement.cloneNode(true);
    for (const s of Array.from(clone.querySelectorAll("script"))) {
      if (s.getAttribute("id") === "__NEXT_DATA__") { s.textContent = JSON.stringify(flags); continue; }
      if (s.getAttribute("type") !== "application/ld+json" && (s.textContent || "").length > 5000) s.textContent = "";
    }
    for (const s of Array.from(clone.querySelectorAll("style, svg, noscript"))) s.remove();
    const meta = (name) => {
      const m = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
      return m ? m.getAttribute("content") : null;
    };
    let ld = null;
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const j = JSON.parse(s.textContent || "null");
        const arr = Array.isArray(j) ? j : [j];
        for (const x of arr) {
          if (x && (x["@type"] === "NewsArticle" || x["@type"] === "Article" || x["@type"] === "ReportageNewsArticle" || x["@type"] === "OpinionNewsArticle")) { ld = x; break; }
        }
        if (ld) break;
      } catch (e) {}
    }
    const authors = [];
    if (ld && Array.isArray(ld.author)) {
      for (const a of ld.author) { if (a && typeof a.name === "string") authors.push(a.name); }
    } else if (ld && ld.author && typeof ld.author.name === "string") {
      authors.push(ld.author.name);
    }
    if (authors.length === 0) {
      for (const a of Array.from(document.querySelectorAll('[data-testid="author-link"]'))) {
        const t = (a.textContent || "").trim();
        if (t !== "" && authors.indexOf(t) < 0) authors.push(t);
      }
    }
    const firstP = document.querySelector('article p[data-type="paragraph"]') || document.querySelector('p[data-type="paragraph"]');
    const body = firstP ? (firstP.closest("section") || firstP.parentElement) : null;
    const skip = '[data-type="inset"], [data-testid="ad-container"], [data-testid^="Piano"], figure, nav, [role="complementary"]';
    const blocks = [];
    if (body) {
      const nodes = Array.from(body.querySelectorAll('p[data-type="paragraph"], h2[data-type="hed"], h3[data-type="hed"], h4[data-type="hed"], li'));
      for (const n of nodes) {
        if (n.closest(skip)) continue;
        const parent = n.parentElement;
        if (parent && parent.closest('p[data-type="paragraph"], li, h2, h3, h4')) continue;
        const t = (n.textContent || "").trim();
        if (t === "") continue;
        const tag = n.tagName.toLowerCase();
        let kind = "p";
        if (tag === "h2" || tag === "h3" || tag === "h4") kind = "h";
        else if (tag === "li") kind = n.closest("ol") ? "ol" : "ul";
        blocks.push({ kind: kind, text: t });
      }
    }
    const h1 = document.querySelector("h1");
    const dekEl = document.querySelector('h2[class*="Dek"]');
    return {
      url: location.href,
      httpStatus: nav && typeof nav.responseStatus === "number" ? nav.responseStatus : 0,
      html: clone.outerHTML.slice(0, 1500000),
      title: (h1 && h1.textContent) || meta("article.headline") || meta("og:title") || document.title,
      dek: dekEl ? dekEl.textContent : null,
      datePublished: meta("article.published") || (ld && typeof ld.datePublished === "string" ? ld.datePublished : null),
      dateModified: meta("article.updated") || (ld && typeof ld.dateModified === "string" ? ld.dateModified : null),
      section: meta("article.section"),
      articleType: meta("article.type"),
      articleId: meta("article.id"),
      access: meta("article.access"),
      template: meta("article.template"),
      snippet: flags.isSnippetView,
      nextPage: flags.page,
      authors: authors,
      blocks: blocks,
      bodyHtml: body ? body.innerHTML.slice(0, 400000) : "",
      account: Boolean(st.account),
      signIn: Boolean(st.signIn),
      rendered: Boolean(st.next) || st.paras > 0
    };
  }, state);
`;

interface ArticlePage {
  url: string;
  httpStatus: number;
  html: string;
  title: string | null;
  dek: string | null;
  datePublished: string | null;
  dateModified: string | null;
  section: string | null;
  articleType: string | null;
  articleId: string | null;
  access: string | null;
  template: string | null;
  snippet: boolean | null;
  nextPage: string | null;
  authors: string[];
  blocks: { kind: string; text: string }[];
  bodyHtml: string;
  account: boolean;
  signIn: boolean;
  rendered: boolean;
}

function asArticlePage(raw: unknown): ArticlePage | null {
  const r = rec(raw);
  if (r === null) return null;
  const url = str(r["url"]);
  if (url === null) return null;
  const blocks: { kind: string; text: string }[] = [];
  if (Array.isArray(r["blocks"])) {
    for (const b of r["blocks"] as unknown[]) {
      const o = rec(b);
      const kind = str(o?.["kind"]);
      const text = str(o?.["text"]);
      if (kind !== null && text !== null) blocks.push({ kind, text });
    }
  }
  const snippet = r["snippet"];
  return {
    url,
    httpStatus: num(r["httpStatus"]) ?? 0,
    html: str(r["html"]) ?? "",
    title: str(r["title"]),
    dek: str(r["dek"]),
    datePublished: str(r["datePublished"]),
    dateModified: str(r["dateModified"]),
    section: str(r["section"]),
    articleType: str(r["articleType"]),
    articleId: str(r["articleId"]),
    access: str(r["access"]),
    template: str(r["template"]),
    snippet: typeof snippet === "boolean" ? snippet : null,
    nextPage: str(r["nextPage"]),
    authors: strings(r["authors"]),
    blocks,
    bodyHtml: str(r["bodyHtml"]) ?? "",
    account: r["account"] === true,
    signIn: r["signIn"] === true,
    rendered: r["rendered"] === true,
  };
}

function blocksToText(blocks: { kind: string; text: string }[]): string {
  const parts: string[] = [];
  let olIndex = 0;
  for (const b of blocks) {
    const t = squash(b.text);
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
      "only WSJ article URLs (https://www.wsj.com/<section>/<slug>) can be read; live coverage, video, podcasts and Buy Side pages are not supported",
    );
  }
  const tab = await ctx.browser.openTab(url, { waitUntil: "domcontentloaded" });
  const page = asArticlePage(await ctx.browser.runScript(READ_SCRIPT, { tab, title: "wsj read article" }));
  if (page === null) {
    return readFailure("adapter_error", "the WSJ article script returned an unexpected result");
  }

  // Completeness first: never `ok` for a bot check, login redirect, or snippet (paywall) view.
  let verdict = checkCompleteness({ url: page.url, httpStatus: page.httpStatus, html: page.html });
  if (verdict.status !== "ok" && !verdict.blocked && !page.rendered && (page.httpStatus === 401 || page.httpStatus === 403)) {
    // Nothing rendered and the site refused: DataDome held the page.
    verdict = { status: "access_denied", reason: "WSJ answered with a bot check (the page did not render)", blocked: true };
  }
  if (verdict.status === "access_denied" && !verdict.blocked && page.rendered && !page.account && page.signIn) {
    // The snippet view for a signed-out session: the login lapsed, not the subscription.
    verdict = { status: "auth_required", reason: "WSJ shows the snippet view and is not signed in in Aside" };
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
    return readFailure(verdict.status, `WSJ ${url}: ${verdict.reason ?? verdict.status}`, {
      blocked: verdict.blocked,
      action,
    });
  }

  let body = blocksToText(page.blocks);
  if (body === "" && page.bodyHtml !== "") body = ctx.helpers.extractText(page.bodyHtml);
  const title = squash(page.title ?? "").replace(/\s*-\s*WSJ\s*$/, "").trim();
  if (title === "" || body.trim() === "") {
    return readFailure("empty", `WSJ ${url} has no readable article text`);
  }
  const dek = squash(page.dek ?? "");
  const text = dek !== "" ? `${dek}\n\n${body}` : body;
  const paid = isPaidArticle(page.html) || (page.access ?? "").toLowerCase() === "paid";
  const finalUrl = canonicalize(page.url);
  return readResponse(
    documentOf({
      title,
      url: articleUrlOf({ url: finalUrl }) ?? url,
      text,
      date: dateOf(page.datePublished, ctx),
      author: page.authors.length > 0 ? page.authors.join(", ") : null,
      accessLevel: paid ? "subscriber" : "public",
      metadata: {
        section: page.section,
        articleType: page.articleType,
        articleId: page.articleId,
        access: page.access,
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
