# The Wall Street Journal (www.wsj.com) — adapter notes

Site key `wsj`. Next.js site (Dow Jones) behind DataDome bot protection. Subscriber articles need
the user's WSJ login in Aside (account u0). Onboarded 2026-10-09.

## Changelog

- v2 (2026-10-09, repair): read dropped every letter "s" from the article text ("is as much" →
  "i a much", "investors" → "inve tor"). Cause: `READ_SCRIPT` is a `pageScript` tagged template,
  and `pageScript` joins the template's **cooked** strings, so the backslash of `/\s+/g` in the
  page script was lost and the page ran `/s+/g`, which replaced every run of "s" with a space
  (`blocksToText` then collapsed the doubled spaces). Fix: the page script now only `trim()`s the
  block `textContent`; whitespace is collapsed on the adapter side (`squash`, plain TypeScript,
  where `\s` is safe). Title and dek are squashed there too. Checked on the sample article: the
  buggy form gave "Four year  ago, … price  were ri ing", the fixed form "Four years ago, … prices
  were rising".
- v1: initial onboarding.

## Search

- The search page `https://www.wsj.com/search?query=<q>` is server-rendered; its `__NEXT_DATA__`
  holds `props.pageProps.searchResults[]` with `articleUrl` (absolute), `headline`, `summary`,
  `timestamp` (ISO Z; for print pieces sometimes the print date at 00:00Z), `flashline`,
  `bylineData[]` (`type: "author"`, `name`), `printHeadline`, `imageUrl`. `pageNumber`,
  `resultsCountMeta` (string), `advancedSearchFields` `{dateRange, sortBy, products}`.
- URL parameters (taken from the UI): `sort` (`relevance` default | `desc` | `asc`), `dateRange`
  (`1d`, `7d`, `30d`, `1yr` = UI default, `all`), `products` (comma list of `wsj`, `video`, `audio`,
  `livecoverage`, `buyside`, `games`), `page` (2, 3, …). `startDate`/`endDate` are ignored.
- It is a semantic search (`isUsingSemanticSearch: true`): ~30 hits at most per query, 20 on page 1
  and the rest on page 2. Sorting by date only reorders those hits.
- The adapter uses `products=wsj` (articles only), relevance order, and `dateRange` = the smallest
  relative range that covers `after` (else `all`); it filters `after`/`before` itself as well, and
  `capabilities.dateFilter` is false (the core filters too).
- Live coverage cards (`/livecoverage/...`), video, podcasts and Buy Side are dropped from results
  and `read` answers `unsupported` for them (live coverage uses another template with encrypted card
  data).
- **DataDome:** a request from outside a page (REPL `fetch`) got HTTP 401 with the
  `geo.captcha-delivery.com` interstitial ("Please enable JS and disable any ad blocker"). The
  adapter therefore opens the search page in a tab (one load per result page) and reads the JSON
  from the DOM. A same-origin `window.fetch` from inside a WSJ page also works.
- Pagination: offset cursor (`encodeOffsetCursor`) mapped to `page = floor(offset/20)+1` plus a skip
  within the page; capped at offset 200.
- Login check: search returns `auth_required` when the page shows a sign-in link and no account
  control.

## Read

- Article URLs: `https://www.wsj.com/<section>/<sub>/<slug>-<8 hex>` (new) or
  `/articles/<slug>-<11 digits>` (old). `?mod=…` tracking parameters are dropped by `canonicalize`
  (no query, no fragment, no trailing slash). `link rel=canonical` agrees with this form.
- Meta tags (server HTML, `<meta name="…" content="…"/>` in this attribute order):
  `article.template` (`full` for the subscriber view), `article.access` (`paid` | free),
  `article.published` / `article.updated` (ISO Z), `article.section`, `article.type`,
  `article.id` (`WP-WSJ-…`), `article.headline`, `author`.
- `__NEXT_DATA__` page `/_articles/standard/[...articlePath]`; `pageProps.isSnippetView`,
  `isFreeArticle`, `paywallIndex`, `articleData.articleTrackingMeta.pageAccessType` (`PAID`).
- Body: the `<section>` that holds `p[data-type="paragraph"]`; the first `paywallIndex` paragraphs
  sit directly in it, the rest inside `div.paywall` (`PaywalledContentContainer`). Subheads are
  `h3[data-type="hed"]`. Insets (`[data-type="inset"]`, charts, datawrapper embeds) and ad containers
  are skipped. Title from `h1` (outside `<article>`), dek from `h2[class*="Dek"]` (prepended).
- The page script returns each block's raw `textContent` (trimmed only); `blocksToText` collapses
  whitespace in adapter.ts.
- Authors: JSON-LD `NewsArticle.author[].name` (the LD block is an array: WebPage, NewsArticle,
  BreadcrumbList), fallback `[data-testid="author-link"]`.
- Dates: the visible `timestamp-text` is "Oct. 7, 2026 8:00 pm ET"; the adapter uses
  `article.published` (ISO Z) with timezone `America/New_York`.
- Signed-in marker (client-rendered only, not in server HTML): the header button
  `button[class*="NavButton"]` with the user's name (headlessui popover). Logged-out: a "Sign In"
  link to `/client/login`. The read script waits up to ~12 s for one of them.

## Completeness

- DataDome markers (`captcha-delivery.com`, "Please enable JS and disable any ad blocker") →
  `access_denied` + blocked, checked before the HTTP status (the interstitial comes with 401).
- Login redirect `/client/login` or `sso.accounts.dowjones.com` → `auth_required`.
- Snippet view: `"isSnippetView":true`, `article.template=snippet`, "Continue reading your article
  with a WSJ …" → `access_denied`; `read` turns that into `auth_required` when the hydrated page
  shows a sign-in link and no account control.
- Required: `<meta name="article.template" content="full"`. A paid article also needs
  `"isSnippetView":false` or the `class="paywall …"` container.
- `read` replaces `__NEXT_DATA__` in its compact HTML copy with just the flags JSON, so the same
  checker runs on the hydrated DOM and on raw server HTML.
- The logged-out markers other than DataDome were not observed directly (the account is logged in and
  outside fetches hit DataDome); the snippet markers are from the `__NEXT_DATA__` flags. If a
  logged-out page ever passes, look at its `article.template` value first.
- accessLevel `subscriber` for `article.access=paid` / `isFreeArticle:false`.

## Hosts

- Only `www.wsj.com`. Images come from `images.wsj.net` and charts from `datawrapper.dwcdn.net`;
  they are blocked by the tab filter and not needed for text. Login goes through
  `sso.accounts.dowjones.com` (not declared: the adapter never navigates to the login).

## Samples

- sampleQuery `inflation`.
- sampleReadUrl: paid explainer "What Six Years of Inflation Mean for the Midterms" (2026-10-08).
- gatedSampleUrl: paid 2022 CPI article (`…-11644452274`).

## Pitfalls

- **No backslash escapes inside `pageScript` templates** (`\s`, `\d`, `\.`, `\n` …): the kit
  builds the script from the cooked template strings, so `\s` arrives in the page as `s`. Do regex
  work in adapter.ts, or write `\\s` if a page-side regex is unavoidable.
- minIntervalMs 3000 to stay clear of DataDome; never probe search in quick bursts.
- Words the shim rejects even in strings (`aside`, `constructor`, …) must not appear in page scripts.
