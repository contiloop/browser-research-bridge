/**
 * Reuters (www.reuters.com) — agent-written adapter. See NOTES.md for the site details.
 *
 * - search: the site's own Arc XP content API `/pf/api/v3/content/fetch/articles-by-search-v2`, the
 *   call the /site-search/ page makes. DataDome rejects that call from outside a page (HTTP 401 with a
 *   captcha-delivery.com challenge), so the adapter opens the site-search page in a bridge tab and
 *   issues the same request from inside it. Newest-first order, native date filter
 *   (`start_date`/`end_date`), offset pagination. The search page must show the signed-in account
 *   control (as for `read`); without it search reports `auth_required`.
 * - read: opens the article, waits for hydration and for the client-side paywall decision (the Arc
 *   paywall and the Breakingviews gate are applied in the browser, a few seconds after load), then
 *   extracts the body paragraphs from `[data-testid="ArticleBody"]`.
 * - Completeness: the server HTML always carries the paragraphs; the wall is added in the browser.
 *   So a non-free article (isAccessibleForFree false / content tier metered or premium) is accepted as
 *   full text only when the signed-in account control is rendered and none of the wall markers
 *   (RegModal, PaywallModal, Breakingviews wall, article-wall paywall, restricted layout) is present.
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
  pageScript,
  readFailure,
  readResponse,
  searchFailure,
  searchItem,
  searchResponse,
} from "../../src/adapter-kit/index.js";

const ORIGIN = "https://www.reuters.com";
const SEARCH_PAGE = `${ORIGIN}/site-search/?query=`;
const SEARCH_API_PATH = "/pf/api/v3/content/fetch/articles-by-search-v2";
/** Stop paging well before deep offsets (the API is meant for the first pages of a query). */
const MAX_OFFSET = 1000;
const LOGIN_ACTION = "Log in to reuters.com in Aside (account u0), then retry";
const SUBSCRIPTION_ACTION =
  "Check that the Reuters account in Aside has a subscription that covers this article (Breakingviews needs its own subscription)";
const BLOCK_ACTION =
  "Open https://www.reuters.com in Aside and complete the bot check if one is shown, then retry";

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

function isReutersHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "www.reuters.com" || h === "reuters.com";
}

/**
 * One URL per article: `https://www.reuters.com/<path>/` without query or fragment and with the
 * trailing slash Reuters article paths carry. Other URLs are returned unchanged.
 */
function canonicalize(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !isReutersHost(u.hostname)) return url;
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path === "" || path === "/") return url;
  const last = path.split("/").filter((s) => s !== "").pop() ?? "";
  if (!path.endsWith("/") && !last.includes(".")) path = `${path}/`;
  return `${ORIGIN}${path}`;
}

const NON_ARTICLE_PREFIXES = [
  "/site-search",
  "/account",
  "/authors",
  "/tags",
  "/markets/quote",
  "/markets/companies",
  "/info-pages",
  "/pf/",
  "/site-api",
  "/arc/",
  "/resizer",
];

/** The canonical article URL a read ref points at; null when the ref is not a Reuters article URL. */
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
  if (!isReutersHost(u.hostname)) return null;
  const segments = u.pathname.split("/").filter((s) => s !== "");
  if (segments.length < 2) return null;
  if (NON_ARTICLE_PREFIXES.some((p) => u.pathname.startsWith(p))) return null;
  return canonical;
}

// ---------------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------------

const checkPage = completenessChecker({
  // DataDome interstitial served instead of the page (also matched by COMMON_BLOCK_MARKERS).
  blockPage: ["Please enable JS and disable any ad blocker", /geo\.captcha-delivery\.com/],
  rateLimit: [/<title>\s*429 Too Many Requests/i],
  loginUrls: [/^https?:\/\/(?:www\.)?reuters\.com\/account\/sign-in/],
  // Registration wall (Arc "article-wall" feature, REGISTRATION paywall type).
  loginWall: ['data-testid="RegModal"', /class="[^"]*reg-modal-module__container/],
  // Subscription wall / meter exhausted / Breakingviews gate: modal, wall block, locked layout.
  paywall: [
    'data-testid="PaywallModal"',
    'data-testid="rcom-bv-wall"',
    /class="[^"]*paywall-modal-module__paywall-modal-container/,
    /class="[^"]*article-wall-module__(?:paywall|simple-paywall|bv)__/,
    /class="[^"]*article-layout-module__restricted__/,
  ],
  // The article body container; missing on teasers, error pages and non-article pages.
  required: ['data-testid="ArticleBody"'],
});

/** True when the page declares the article as not free (metered or premium tier). */
function isPaidArticle(html: string): boolean {
  if (/"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html)) return true;
  const tier =
    /<meta[^>]+name="article:content_tier"[^>]+content="([a-z]+)"/i.exec(html)?.[1] ??
    /<meta[^>]+content="([a-z]+)"[^>]+name="article:content_tier"/i.exec(html)?.[1] ??
    null;
  return tier !== null && tier.toLowerCase() !== "free";
}

/** The signed-in account control of the site header (rendered only for a logged-in session). */
const SIGNED_IN_MARKER = 'data-testid="AccountButton"';

/**
 * Pure verdict on article-page HTML. Reuters ships the paragraphs in the server HTML and applies its
 * wall in the browser, so for a paid article the full text counts as verified only together with the
 * signed-in account control; without it the page is the logged-out (walled) form.
 */
function checkCompleteness(page: CompletenessInput): CompletenessResult {
  const base = checkPage(page);
  if (base.status !== "ok") return base;
  if (isPaidArticle(page.html) && !page.html.includes(SIGNED_IN_MARKER)) {
    return {
      status: "auth_required",
      reason: "paid Reuters article without a signed-in session (the paywall is applied client-side)",
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

function isDataDome(html: string): boolean {
  return /captcha-delivery\.com|Please enable JS and disable any ad blocker/.test(html);
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/**
 * Runs the site's search API call from inside the (same-origin) site-search page, after waiting
 * for the header's signed-in account control (up to ~10 s; a sign-in link or a missing header ends
 * the wait after ~4 s, since a lapsed session can show the sign-in link briefly before the account
 * control). `signedIn` reports the account control, the same marker `read` relies on.
 */
function searchScript(apiUrl: string): string {
  return pageScript`
    const probe = async () => await page.evaluate(() => ({
      header: Boolean(document.querySelector('[data-testid="SiteHeader"]')),
      account: Boolean(document.querySelector('[data-testid="AccountButton"]')),
      signIn: Boolean(document.querySelector('[data-testid="SiteHeader"] a[href*="/account/sign-in"]'))
    }));
    let state = await probe();
    for (let i = 0; i < 20; i++) {
      if (state.account) break;
      if (state.signIn && i >= 8) break;
      if (!state.header && i >= 8) break;
      await sleep(500);
      state = await probe();
    }
    const result = await page.evaluate(async () => {
      try {
        const r = await window.fetch(${apiUrl}, { credentials: "include", headers: { accept: "application/json" } });
        const t = await r.text();
        return { status: r.status, text: t.slice(0, 600000) };
      } catch (e) {
        return { status: 0, text: String(e && e.message ? e.message : e) };
      }
    });
    return { status: result.status, text: result.text, signedIn: state.account };
  `;
}

interface SearchArticle {
  path: string;
  title: string;
  description: string | null;
  displayTime: string | null;
  authors: string[];
}

function parseSearchBody(text: string): { articles: SearchArticle[]; rawCount: number; total: number } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const result = rec(rec(body)?.["result"]);
  if (result === null) return null;
  const pagination = rec(result["pagination"]);
  // A query with no hits comes back as a `result` that carries `pagination` but no `articles`
  // array at all (seen with long natural-language keywords); that is an empty page, not a defect.
  const list = Array.isArray(result["articles"]) ? result["articles"] : pagination !== null ? [] : null;
  if (list === null) return null;
  const out: SearchArticle[] = [];
  for (const item of list as unknown[]) {
    const a = rec(item);
    if (a === null) continue;
    const path = str(a["canonical_url"]);
    const title = str(a["title"]) ?? str(a["basic_headline"]) ?? str(a["web"]);
    if (path === null || !path.startsWith("/") || path.startsWith("//") || title === null || title.trim() === "") {
      continue;
    }
    const authors: string[] = [];
    if (Array.isArray(a["authors"])) {
      for (const au of a["authors"] as unknown[]) {
        const name = str(rec(au)?.["name"]);
        if (name !== null && name.trim() !== "") authors.push(name.trim());
      }
    }
    out.push({
      path,
      title,
      description: str(a["description"]),
      displayTime: str(a["display_time"]) ?? str(a["published_time"]),
      authors,
    });
  }
  return { articles: out, rawCount: list.length, total: num(pagination?.["total_size"]) ?? out.length };
}

async function search(req: AdapterSearchRequest, ctx: AdapterContext): Promise<AdapterSearchResponse> {
  const text = req.text.trim();
  if (text === "") return searchResponse([], null);
  const offset = decodeOffsetCursor(req.cursor);
  if (offset === null) return searchFailure("adapter_error", "malformed Reuters search cursor");
  if (offset >= MAX_OFFSET) return searchResponse([], null);
  const size = Math.max(1, Math.min(req.limit, 25));

  const query: Record<string, string | number> = {
    keyword: text,
    offset,
    orderby: "display_date:desc",
    size,
    website: "reuters",
  };
  // Native date filter: inclusive YYYY-MM-DD days in the site zone (UTC) → ISO instants.
  const days = dayWindowInZone(req.after, req.before, ctx.manifest.timezone);
  if (days.from) query["start_date"] = days.from.toISOString();
  if (days.until) query["end_date"] = days.until.toISOString();
  const apiUrl = `${SEARCH_API_PATH}?query=${encodeURIComponent(JSON.stringify(query))}&_website=reuters`;

  const tab = await ctx.browser.openTab(`${SEARCH_PAGE}${encodeURIComponent(text)}`, {
    waitUntil: "domcontentloaded",
  });
  const raw = rec(await ctx.browser.runScript(searchScript(apiUrl), { tab, title: "reuters search" }));
  if (raw === null) {
    return searchFailure("adapter_error", "the Reuters search script returned an unexpected result");
  }
  const status = num(raw["status"]) ?? 0;
  const body = str(raw["text"]) ?? "";

  if (status === 429) {
    return searchFailure("rate_limited", "Reuters search is throttling requests", { blocked: true });
  }
  if (isDataDome(body)) {
    return searchFailure("access_denied", "Reuters answered with a DataDome bot check", {
      blocked: true,
      action: BLOCK_ACTION,
    });
  }
  // The manifest requires the login: a search page without the signed-in account control means
  // the Reuters session in Aside is gone, even when the API still answers.
  if (raw["signedIn"] !== true) {
    return searchFailure("auth_required", "Reuters is not signed in in Aside", { action: LOGIN_ACTION });
  }
  if (status === 401) {
    return searchFailure("auth_required", "Reuters search answered HTTP 401", { action: LOGIN_ACTION });
  }
  if (status !== 200) {
    return searchFailure("adapter_error", `Reuters search answered HTTP ${status}`);
  }
  const parsed = parseSearchBody(body);
  if (parsed === null) return searchFailure("adapter_error", "unexpected Reuters search API response");
  const fromMs = days.from ? days.from.getTime() : null;
  const untilMs = days.until ? days.until.getTime() : null;
  const results: AdapterSearchItem[] = [];
  for (const a of parsed.articles) {
    const t = a.displayTime !== null ? Date.parse(a.displayTime) : NaN;
    if (!Number.isNaN(t)) {
      if (fromMs !== null && t < fromMs) continue;
      if (untilMs !== null && t >= untilMs) continue;
    }
    results.push(
      searchItem({
        title: a.title,
        url: canonicalize(`${ORIGIN}${a.path}`),
        date: dateOf(a.displayTime, ctx),
        excerpt: a.description,
        author: a.authors.length > 0 ? a.authors.join(", ") : null,
      }),
    );
  }
  const consumed = offset + parsed.rawCount;
  const more = parsed.rawCount === size && consumed < Math.min(parsed.total, MAX_OFFSET);
  return searchResponse(results.slice(0, req.limit), more ? encodeOffsetCursor(consumed) : null);
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/**
 * Waits for hydration (signed-in account control, the header sign-in link, or a wall), then keeps
 * watching up to 6 s for a late wall (the Breakingviews gate appears only after the entitlement check),
 * then returns the page identity, a compact HTML copy for the completeness markers (large inline
 * scripts emptied, JSON-LD kept), and the article fields. Selectors are documented in NOTES.md. (The
 * shim's static scan rejects some words even inside strings, so the skip selector uses the
 * complementary role instead of the tag name of side regions.)
 */
const READ_SCRIPT = pageScript`
  const probe = async () => await page.evaluate(() => ({
    header: Boolean(document.querySelector('[data-testid="SiteHeader"]')),
    account: Boolean(document.querySelector('[data-testid="AccountButton"]')),
    signIn: Boolean(document.querySelector('[data-testid="SiteHeader"] a[href*="/account/sign-in"]')),
    wall: Boolean(document.querySelector('[data-testid="RegModal"], [data-testid="PaywallModal"], [data-testid="rcom-bv-wall"], [class*="article-wall-module__paywall"], [class*="article-wall-module__simple-paywall"], [class*="article-layout-module__restricted__"]'))
  }));
  let state = await probe();
  for (let i = 0; i < 30; i++) {
    if (state.wall || state.account || state.signIn) break;
    if (!state.header && i >= 8) break;
    await sleep(500);
    state = await probe();
  }
  if (!state.wall && state.header) {
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      state = await probe();
      if (state.wall) break;
    }
  }
  return await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const clone = document.documentElement.cloneNode(true);
    for (const s of Array.from(clone.querySelectorAll("script"))) {
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
        if (j && (j["@type"] === "NewsArticle" || j["@type"] === "Article" || j["@type"] === "ReportageNewsArticle")) { ld = j; break; }
      } catch (e) {}
    }
    const authors = [];
    if (ld && Array.isArray(ld.author)) {
      for (const a of ld.author) { if (a && typeof a.name === "string") authors.push(a.name); }
    } else if (ld && ld.author && typeof ld.author.name === "string") {
      authors.push(ld.author.name);
    }
    const body = document.querySelector('[data-testid="ArticleBody"]');
    const skip = '[data-testid="ContextWidget"], [data-testid="Tags"], [data-testid="ArticleToolbar"], [data-testid="AuthorBio"], [data-testid="Disclaimer"], [data-testid="promo-box"], [data-testid="primary-image"], figure, nav, [role="complementary"]';
    const blocks = [];
    if (body) {
      const nodes = Array.from(body.querySelectorAll('[data-testid^="paragraph-"], [data-testid^="heading-"], h2, h3, h4, li, [data-testid="Advisory"], [data-testid="SignOff"]'));
      for (const n of nodes) {
        if (n.closest(skip)) continue;
        const parent = n.parentElement;
        if (parent && parent.closest('[data-testid^="paragraph-"], [data-testid^="heading-"], li, h2, h3, h4')) continue;
        const t = (n.textContent || "").replace(/ +/g, " ").trim();
        if (t === "") continue;
        const tid = n.getAttribute("data-testid") || "";
        const tag = n.tagName.toLowerCase();
        let kind = "p";
        if (tid.indexOf("heading-") === 0 || tag === "h2" || tag === "h3" || tag === "h4") kind = "h";
        else if (tag === "li") kind = n.closest("ol") ? "ol" : "ul";
        blocks.push({ kind: kind, text: t });
      }
    }
    const summary = Array.from(document.querySelectorAll('[data-testid="Summary"] li')).map((li) => (li.textContent || "").trim()).filter((t) => t !== "");
    const h1 = document.querySelector('[data-testid="Article"] h1') || document.querySelector("h1");
    return {
      url: location.href,
      httpStatus: nav && typeof nav.responseStatus === "number" ? nav.responseStatus : 0,
      html: clone.outerHTML.slice(0, 1500000),
      title: (h1 && h1.textContent) || meta("og:title") || document.title,
      datePublished: ld && typeof ld.datePublished === "string" ? ld.datePublished : meta("article:published_time"),
      dateModified: ld && typeof ld.dateModified === "string" ? ld.dateModified : meta("og:updated_time"),
      section: meta("article:section"),
      tier: meta("article:content_tier"),
      arcId: meta("sophi-content-id"),
      authors: authors,
      blocks: blocks,
      summary: summary,
      bodyHtml: body ? body.innerHTML.slice(0, 400000) : ""
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
  tier: string | null;
  arcId: string | null;
  authors: string[];
  blocks: { kind: string; text: string }[];
  summary: string[];
  bodyHtml: string;
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
    tier: str(r["tier"]),
    arcId: str(r["arcId"]),
    authors: strings(r["authors"]),
    blocks,
    summary: strings(r["summary"]),
    bodyHtml: str(r["bodyHtml"]) ?? "",
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
      "only Reuters article URLs (https://www.reuters.com/<section>/<slug>/) can be read",
    );
  }
  const tab = await ctx.browser.openTab(url, { waitUntil: "domcontentloaded" });
  const page = asArticlePage(await ctx.browser.runScript(READ_SCRIPT, { tab, title: "reuters read article" }));
  if (page === null) {
    return readFailure("adapter_error", "the Reuters article script returned an unexpected result");
  }

  // Completeness first: never `ok` for a bot check, login/registration wall, or paywall.
  const verdict = checkCompleteness({ url: page.url, httpStatus: page.httpStatus, html: page.html });
  if (verdict.status !== "ok") {
    const action =
      verdict.status === "auth_required"
        ? LOGIN_ACTION
        : verdict.status === "access_denied"
          ? verdict.blocked
            ? BLOCK_ACTION
            : SUBSCRIPTION_ACTION
          : undefined;
    return readFailure(verdict.status, `Reuters ${url}: ${verdict.reason ?? verdict.status}`, {
      blocked: verdict.blocked,
      action,
    });
  }

  let body = blocksToText(page.blocks);
  if (body === "" && page.bodyHtml !== "") body = ctx.helpers.extractText(page.bodyHtml);
  const summary =
    page.summary.length > 0 ? `Summary:\n\n${page.summary.map((s) => `- ${s.trim()}`).join("\n")}` : "";
  const text = [summary, body].filter((t) => t.trim() !== "").join("\n\n");
  const title = (page.title ?? "").replace(/\s*\|\s*Reuters\s*$/, "").trim();
  if (title === "" || body.trim() === "") {
    return readFailure("empty", `Reuters ${url} has no readable article text`);
  }
  const paid = isPaidArticle(page.html);
  return readResponse(
    documentOf({
      title,
      url: canonicalize(page.url.startsWith(ORIGIN) ? page.url : url),
      text,
      date: dateOf(page.datePublished, ctx),
      author: page.authors.length > 0 ? page.authors.join(", ") : null,
      accessLevel: paid ? "subscriber" : "public",
      metadata: {
        section: page.section,
        contentTier: page.tier,
        arcId: page.arcId,
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
