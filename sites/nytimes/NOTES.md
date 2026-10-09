# The New York Times (www.nytimes.com) — adapter notes

Site key `nytimes`. React ("vi") site behind DataDome bot protection. Requires the user's NYT
subscriber login in Aside (account u0); every article is metered (`isAccessibleForFree: false`).

## Search

- The search page `https://www.nytimes.com/search?query=<q>&sort=newest` server-renders the first 10
  hits and loads more ("Show more") through GraphQL:
  `GET https://samizdat-graphql.nytimes.com/graphql/v2?operationName=SearchRootQuery&variables=<json>&extensions={"persistedQuery":{"version":1,"sha256Hash":"e02b0d975b129a6756400f7c7ee3dc3b1818d5cf57a082f8b1368a264dd03d47"}}`.
  If the site rotates the persisted-query hash, the API stops answering with `data.search`; find the
  new hash by clicking "Show more" on /search and reading the `SearchRootQuery` request URL
  (`performance.getEntriesByType("resource")`, clear the 250-entry buffer first).
- Variables: `first` (page size), `sort` (`best` | `newest` | `oldest`), `text`, `cursor` (Relay
  cursor = base64 of `arrayconnection:<index of the last item already seen>`, so offset N →
  `arrayconnection:<N-1>`), `beginDate`/`endDate` (ISO with offset, e.g.
  `2026-09-01T00:00:00-04:00` / `2026-09-30T23:59:59-04:00`), `filterQuery` +
  `sectionFacetFilterQuery` (`((type: "article"))` for the "Article" type filter),
  `sectionFacetActive`/`typeFacetActive`.
- Response: `data.search.hits` with `totalCount` (capped at 10000), `pageInfo.hasNextPage`/`endCursor`,
  `edges[].node` (`__typename` Article/Video/PaidPost/…, `url`, `uri` nyt://article/<uuid>,
  `firstPublished` ISO Z, `creativeWorkHeadline.default`, `creativeWorkSummary`,
  `bylines[].renderedRepresentation` "By …", `section.displayName`).
- The API answers **HTTP 403** to the REPL realm fetch: it needs the page's app headers
  (`window.__preloadedData.config.gqlRequestHeaders`: nyt-app-type, nyt-app-version, nyt-token, a
  public app key). The adapter therefore opens /search and runs `window.fetch` inside the page, taking
  the headers from the page config inside `page.evaluate` (never returned or stored).
- Date filter leak: the API's `endDate` lets through items published up to a day later (ET), so the
  adapter also filters on `firstPublished` against the site-zone day window.
- Order: `best` (relevance). Pagination: offset cursor, capped at offset 1000.
- Login check: the search page masthead shows `data-testid="user-settings-button"` when signed in;
  without it search returns `auth_required`.

## Read

- Article URL form: `https://www.nytimes.com/YYYY/MM/DD/<section>/<slug>.html`. `canonicalize`
  forces `https://www.nytimes.com`, drops query (`smid`, `unlocked_article_code`, …) and fragment.
- Body: `section[name="articleBody"]` (class `meteredContent`, JSON-LD `hasPart.cssSelector`
  `.meteredContent`). Paragraphs are `p` inside `.StoryBodyCompanionColumn`. Skipped: figures,
  `[data-testid="inline-interactive"]` (Datawrapper charts carry script text), `InteractiveBlock-*`,
  `Dropzone-*` (ads), recirculation.
- Title: `h1[data-testid="headline"]`. Date/author: JSON-LD `NewsArticle` (`datePublished` ISO Z,
  `author[].name`); fallback meta `byl`. Metadata: `article:section`, `PT`, `nyt_uri`, description.
- Manifest timezone `America/New_York`.
- Live blogs (`/live/…`), interactives and videos have other layouts; search only returns
  `type: article` hits, and such pages read as `access_denied` (no `articleBody`).

## Paywall / completeness

- Signed-in marker: `data-testid="user-settings-button"` in the masthead
  (`data-testid="masthead-container"`). `window.__preloadedData.config.targetingDimensionsConfig.newsTenure`
  starts with `sub` for subscribers (not used in the rule).
- `config.isOptimisticallyTruncated` is `false` for the subscriber; when `true` the server sent a
  preview. The read script re-appends the flag to the compacted HTML (the big config script is emptied).
- Wall markers: `id="gateway-content"` / `data-testid="gateway-content"` (subscription gateway),
  regi-wall test ids. `data-testid="vi-gateway-container"` is present for subscribers too, so it is
  NOT a wall marker; neither is `data-paywall-inert` on the body.
- Rule: DataDome → `access_denied` + blocked; gateway → `access_denied` (→ `auth_required` when
  the signed-in control is missing); no `articleBody` → `access_denied`; truncation flag →
  `access_denied`; metered article without `user-settings-button` → `auth_required`.
- Logged-out form (validation step d, 2026-10-09): the bridge's cookieless fetch got HTTP 403 with
  DataDome's interstitial (`<title>nytimes.com</title>`, "Please enable JS and disable any ad
  blocker", captcha-delivery.com), classified `access_denied` + blocked. A logged-out HTML page
  that does render is caught by the metered-without-signed-in-control rule.

## DataDome

- The first tab load of an article during onboarding showed DataDome's "Please enable JS and disable
  any ad blocker" page (its captcha frame on captcha-delivery.com is blocked by the tab filter). The
  bridge solver's reload passed it ("kind none"). The adapter reports such a page as
  `access_denied` + blocked so the bridge retries once.
- Do not add captcha vendor hosts. minIntervalMs 2500.

## Page-script pitfalls

- Never `cloneNode` the document to compact it: cloned `<img>`/`<link>` elements start loading at
  once, and those requests (static.nytimes.com, static01.nyt.com) come from injected code, so the
  shim fails the step ("request to static.nytimes.com is outside the site's hostnames"). The read
  script compacts the `outerHTML` string with regexes instead.

## Hosts

- `samizdat-graphql.nytimes.com`: GraphQL API (search).
- `myaccount.nytimes.com`: login page (`/auth/login`).
- Not needed: static01.nyt.com / g1.nyt.com / static.nytimes.com (images and assets), ad and
  analytics hosts.

## Samples

- sampleQuery `inflation`.
- sampleReadUrl: 2026-10-08 mortgage-rates article (metered, 4764 chars, `subscriber`).
- gatedSampleUrl: 2026-10-01 bond-yields article (metered, 4619 chars, `subscriber`).
