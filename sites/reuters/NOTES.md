# Reuters (www.reuters.com) — adapter notes

Site key `reuters`. Arc XP (Fusion) site behind DataDome bot protection. Requires the user's Reuters
login in Aside (account u0) for paid articles.

## Search

- The site-search page `https://www.reuters.com/site-search/?query=<q>` calls the content API
  `GET /pf/api/v3/content/fetch/articles-by-search-v2?query=<json>&_website=reuters`.
- `query` JSON: `{"keyword": "...", "offset": 0, "orderby": "display_date:desc", "size": 20,
"website": "reuters", "start_date": "<ISO>", "end_date": "<ISO>"}`. `start_date`/`end_date`
  are native date filters (verified: total_size dropped from ~72k to 87 for a 2-day window).
  The UI only offers relative ranges, but the API takes explicit instants.
- Response: `result.pagination.total_size`, `result.articles[]` with `id` (Arc id),
  `canonical_url` (path), `title`/`basic_headline`/`web`, `description`, `display_time`,
  `published_time` (ISO Z), `authors[].name`, `content_code` (`free` | `metered` | `premium`),
  `kicker.names`, `word_count`.
- **DataDome:** the same request from the Aside REPL realm (`fetch` outside the page) got HTTP 401
  with a `captcha-delivery.com` interstitial ("Please enable JS and disable any ad blocker"). The
  adapter therefore opens the site-search page and runs `window.fetch` inside it (same origin,
  cookies included). One page load per search page.
- Pagination: offset cursor (`encodeOffsetCursor`), capped at offset 1000. Order newest first.
- Login check: the search API answers logged-out sessions too (HTTP 200), so before the API call the
  search script waits for the header's `AccountButton` (up to ~10 s; ~4 s once a sign-in link shows), and search
  returns `auth_required` ("Reuters is not signed in in Aside") when `AccountButton` is absent
  (`requiresLogin` is true). HTTP 401 is still `auth_required`.

## Read

- Article URL form: `https://www.reuters.com/<section>/<...>/<slug>-YYYY-MM-DD/` (trailing slash).
  `canonicalize` forces `https://www.reuters.com`, drops the query and fragment, and adds the slash.
- Body: `[data-testid="ArticleBody"]`; paragraphs `[data-testid="paragraph-N"]`; also
  `[data-testid="Advisory"]` (opinion disclaimer) and `[data-testid="SignOff"]` (editing credits).
  Skipped: `ContextWidget` (Summary/Companies tabs), `promo-box`, `primary-image`, figures/graphics,
  `Tags`, `ArticleToolbar`, `AuthorBio`, `Disclaimer`.
- Summary bullets (`[data-testid="Summary"] li`) are put first as a "Summary:" list.
- Title: `[data-testid="Article"] h1` (fallback og:title). Date/author: JSON-LD `NewsArticle`
  (`datePublished` ISO Z, `author[].name`). The visible dateline is in the _browser's_ zone (e.g.
  "GMT+9"), so it is not used. Manifest timezone is `UTC`.
- Metadata: `article:section`, `article:content_tier`, `sophi-content-id` (Arc id), dateModified.
- Page-script pitfall: the shim's static scan rejects the word `aside` anywhere in a script (even in a
  CSS selector string). Use `[role="complementary"]` instead.

## Paywall / completeness

- Content tiers: `free`, `metered` (the normal Reuters.com paid tier, covered by a Reuters.com
  subscription), `premium` (only Breakingviews columns, which need a **separate Breakingviews
  subscription**). JSON-LD marks paid articles `isAccessibleForFree: false` with
  `hasPart.cssSelector: ".paywall-B064F03B"`.
- **The server HTML carries the full paragraphs for everyone.** The wall comes from the client-side
  Arc paywall (`/arc/subs/p.min.js` + the `article/article-wall` feature). When it applies:
  - the layout container gets `regular-article-layout-module__restricted__…` (or
    `single-column-article-layout-module__restricted__…`);
  - registration wall: `data-testid="RegModal"` (`reg-modal-module__container…`);
  - subscription wall: `data-testid="PaywallModal"` (`paywall-modal-module__paywall-modal-container…`);
  - Breakingviews gate: `data-testid="rcom-bv-wall"` with `article-wall-module__paywall…`
    ("This is exclusive to Breakingviews subscribers … a separate subscription from Reuters.com").
    It appears **several seconds after load** (after an entitlement check). A 5 s look during
    onboarding missed it, so `read` keeps polling for walls for 6 s after hydration.
- Signed-in marker: the header renders `data-testid="AccountButton"` when logged in, and a
  `TextButton` link to `/account/sign-in/?website=reuters&redirect=…` ("Sign In") when logged out.
  The header "Subscribe" button (`header-subscribe-button`) shows even for the logged-in subscriber,
  so it is not a logged-out marker.
- Rule (`checkCompleteness`, also used by `read` on the hydrated DOM): DataDome markers →
  `access_denied` + blocked; RegModal → `auth_required`; PaywallModal / rcom-bv-wall / article-wall /
  restricted layout → `access_denied`; no `ArticleBody` → `access_denied`; a paid article
  (isAccessibleForFree false or tier ≠ free) without `AccountButton` → `auth_required`. Free articles
  are `ok` without a login.
- `read` waits up to ~15 s for the AccountButton, sign-in link, or a wall to appear, then 6 s more for
  a late wall. It then passes the hydrated HTML (inline scripts over 5000 chars emptied, JSON-LD kept)
  to the checker.
- accessLevel: `subscriber` for paid (metered) articles read with the session, else `public`.
- With the current account, Breakingviews (`premium`) reads return `access_denied` (correct: no BV
  subscription). They would read once the account has Breakingviews.
- Logged-out form (validation step d, 2026-10-05): the bridge's cookieless fetch got HTTP 200 with the
  full server HTML (paragraphs included, no AccountButton). It was classified `auth_required` by the
  paid-without-session rule. Other cookieless requests may instead get the DataDome 401
  interstitial, which is classified `access_denied` + blocked; either way it is not `ok`.

## Hosts

- `dd.reuters.com`: DataDome's first-party endpoint, which the pages call.
- `arcpublishing.com`: Arc image CDN (`cloudfront-us-east-2.images.arcpublishing.com`) referenced by
  search thumbnails and author images.
- Not needed: cdn.cookielaw.org (consent banner), tru.am, googletagmanager.

## Samples

- sampleQuery `inflation` (tens of thousands of hits).
- sampleReadUrl / gatedSampleUrl: paid (`metered`, isAccessibleForFree false) analysis pieces from
  2026-09-18 (France bond risk premium; global rate-hike cycle). Validation: 4679 / 5031 chars,
  `subscriber`.

## Pitfalls

- Never treat the header "Subscribe" button as a logged-out signal.
- After an Aside restart the Reuters session lapsed once; the AccountButton disappears then, and the
  rule reports `auth_required`.
- minIntervalMs 3000 to stay well clear of DataDome.

## Long queries (added after live use)

- The search API answers a long natural-language keyword (observed at 78 characters) with HTTP 200 and a `result`
  that has `pagination` but **no `articles` array**. Treat that as an empty page, never as an error.
- The search needs every term to match. For the 12-word live query: 8 words → no `articles`, 6 words → 2 hits,
  5 → 2, 4 → 16, 3 → 224. The adapter does NOT shorten queries itself (the user wants the research client to own
  the query, as with ordinary web search); a long query simply returns `empty`.
- Four API calls within a few seconds tripped DataDome (HTTP 401 with a `geo.captcha-delivery.com` interstitial), so
  never probe the API in quick succession; the retry above is spaced on purpose.

## 2026-10-09 — video embeds

Articles with an embedded video load their player from `cd.elements.video`. Without that host in `extraAllowedHosts` the tab filter blocked the request and, because it fired while the adapter's page script ran, the read ended `adapter_error`. `elements.video` (subdomains included) is now allowed; the adapter does not read the video.

## 2026-10-09 — a bot check is not a lapsed login

While the DataDome check holds the page (or its scripts are blocked), the search page and article pages render without the site header, so the signed-in account control is missing too. The adapter used to report that as `auth_required`, which turned the site `needs_login` although the login was fine (acceptance run 4). Now: no `SiteHeader` → `access_denied` with `blocked: true` ("answered with a bot check (the page did not render)"); `auth_required` only when the header rendered without the account control. Reuters is sensitive to parallel loads: the owner's install runs with `maxConcurrentPerSite: 2` and `concurrentStaggerMs: 1500`.
