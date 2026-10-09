# Business rules

## Terms

- **Site**: a registered website with a key, owned hostnames, a login requirement, a time zone, and capabilities (`search`, `read`, `dateFilter`, `pagination`).
- **Site key**: `[a-z0-9-]{2,32}`, unique, visible to research clients through `site:`. Default derivation: the hostname without `www.` and without its public suffix, dots turned into hyphens (`reuters.com` → `reuters`, `blog.naver.com` → `blog-naver`). The key the Add started with stays the key; `manifest.key` must equal the folder name.
- **Owned hostname vs allowed host**: `hostnames` in the manifest are owned; a URL maps to a site only through an owned hostname (exact match, case- and `www.`-insensitive), and a hostname is owned by at most one site. `extraAllowedHosts` (login/SSO hosts, data APIs, CDNs) only widen where the site's browser session may load and request; they own nothing, so a URL on `nid.naver.com` maps to no site. For browsing, every entry also covers its subdomains; for ownership it does not.
- **Status** means two different things:
  - **outcome status**: the result of one search or read for one site (nine values, below);
  - **lifecycle status**: the standing state of a registered site (five values, below). `list_sites` reports lifecycle statuses; `siteStatuses` and read errors report outcome statuses.
- **Registered / loadable / serving**: registered = listed in `data/sites.json`; loadable = its folder has a manifest whose key matches the folder, an `adapter.ts`, and a `validation.json` recording a passed full validation; serving = loadable and in lifecycle status `active`, `needs_login`, or `degraded`.
- **Result id**: `<siteKey>:<localId>`. `localId` is the site's own stable article id when the adapter supplies one (no whitespace, never starting with `u_`), otherwise `u_` + base64url of the article URL after the adapter's `canonicalize`. Ids never use the dedup-normalized URL, because normalization may change which page opens.
- **Ref**: what read accepts: a result id, or any string starting with `http://`/`https://`.
- **Document**: one article's text plus metadata (`id, site, title, url, publishedAt, datePrecision, author, text, truncated, accessLevel, fetchedAt, metadata`). `accessLevel` is `subscriber` when the full text appeared only because the user is logged in or subscribed, else `public`.

## Run modes

One process has two parts: the settings page, up for the life of the process, and the core (public side, registry, search and read, OAuth, jobs, health checks, browser port), which is started, stopped, and restarted (`src/app/run-mode.ts`).

| `mode`       | Meaning                                                             | Public side         | Program-managed connection tool        |
| ------------ | ------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| `setup`      | the core is off; `problem` says why                                 | not listening       | not started (ChatGPT state `stopped`)  |
| `running`    | normal                                                              | listening           | started after the core when configured |
| `restarting` | the core is being stopped and started (also before the first start) | closed for a moment | stopped for a moment                   |

| `problem.code`         | Condition                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `passphrase_missing`   | `BRIDGE_PASSPHRASE` unset or blank                                                                 |
| `passphrase_too_short` | fewer than 12 characters                                                                           |
| `config_invalid`       | any other configuration error (malformed file, invalid value); the message names the file or value |
| `start_failed`         | the configuration is valid but the core failed to start (for example the public port is in use)    |

- The rules are the same however the process is started (launchd agent, `npm start`). A configuration problem never ends the process; only a settings-page port that cannot be bound does (exit code 1).
- The settings page's port and the data folder come from a valid environment override, else a valid value in a readable `config/bridge.json`, else 8788 and `data`, so a malformed file still leaves the page up.
- Every core start reads the files again and builds a new core. One start or restart runs at a time; a save, restart, or ChatGPT setup during one is refused (`busy`).
- Saving a setting on the page: validate → no change means no restart → refuse with `job_running` while a helper job is `running` unless confirmed → write → (optionally disconnect all apps) → restart. If the start fails, the mode is `setup` with the reason; saved values are not rolled back. A job interrupted by the restart fails "interrupted by shutdown; click Retry".
- In `setup`, a corrected save starts the core; on success the mode is `running`.
- The settings page's one-time link and cookie are created once per process start and survive core restarts.

## Shipped sites

- The repository ships three sites: `sites/reuters/` (also the helper's reference adapter: the helper's instructions, its reference allowlist, and `docs/ADAPTERS.md` point to it, and a unit test checks that its `validation.json` matches its files), `sites/wsj/`, and `sites/nytimes/` (added by the helper through the settings page on 2026-10-09; WSJ repaired once the same day for a text-extraction bug).
- Other sites are added on the settings page. A site folder can be kept out of git on purpose (excluded locally in `.git/info/exclude`); it works on that Mac and is not in a fresh clone.
- On an existing install, a registered site whose folder is gone is dropped from the registry at the next start.

## Outcome statuses (exact set)

| Status                | Means                                                                                                | Must not be used for                         |
| --------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `ok`                  | results or a complete document came back                                                             | partial text, teaser, login wall             |
| `empty`               | the site answered and has nothing (no hits, missing article)                                         | any login, access, block, or error condition |
| `auth_required`       | login wall or expired session                                                                        | —                                            |
| `unsupported`         | site not registered, capability absent, unknown `site:` value, invalid ref or cursor, site not ready | site failures                                |
| `access_denied`       | paywall without entitlement, 403, block page, captcha, a bot check met during a page script          | an expired login (that is `auth_required`)   |
| `rate_limited`        | the site is throttling                                                                               | —                                            |
| `timeout`             | the call budget ran out or the call could not get a place on the site in time                        | —                                            |
| `adapter_error`       | the adapter threw, returned malformed data, or a page script violated the shim                       | a bot check met during a page script         |
| `browser_unavailable` | Aside unreachable, CLI signed out, or the REPL restarted under a running task                        | —                                            |

- Every non-`ok` entry carries a human `message`; `auth_required` and `access_denied` always carry an `action`. Defaults when the adapter gives none: `auth_required` → "Log in to <loginUrl or site> in Aside, then click Check now in the dashboard"; `access_denied` → "Open <site> in Aside and check the subscription, captcha, or block page, then retry"; an expired Aside CLI login → `browser_unavailable` with "run `aside login`". A block page that an automatic challenge attempt did not clear carries "The captcha could not be solved automatically. Open <url> in Aside, solve it, then retry"; a captcha-limited one (the solver could not act on the check) carries "<site> is captcha-limited: its bot check cannot be solved automatically. Open <url> in Aside, solve it, then retry" as both message and action (see Challenge attempts). With the Aside AI on, a failure it has taken over carries its sentence as the action instead: "The Aside AI is passing the check now; retry in a minute" (blocked, the failure keeping its status: `access_denied` for a block page), "The Aside AI is logging in now; retry in a minute" (`auth_required`, blocked or not), or, while the site's tasks are held after the AI needed the user, the reason's sentence (see Assistant tasks).
- An adapter status outside the set becomes `adapter_error`. `ok` with zero results becomes `empty`, `empty` with results becomes `ok`; failure statuses pass through unchanged, so an error can never surface as `ok` or `empty`. Anything thrown maps to its typed status, to `timeout` for abort/timeout errors, else to `adapter_error`.

## Query language (shared by `search` and `search_sites`)

The query is split on whitespace. A token of the form `name:value` with `name` in `site`, `after`, `before`, `limit`, `page` (name case-insensitive) is a qualifier; every other token is search text.

| Qualifier                               | Rule                                                                                           | Invalid value                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `site:<key, hostname, or URL>`          | repeatable; lowercased and de-duplicated; resolved by key first, then by owned hostname        | unresolved → status entry `unsupported` "unknown site: <value>", ignored |
| `after:YYYY-MM-DD`, `before:YYYY-MM-DD` | inclusive published-date window                                                                | not a real calendar date → the token stays search text                   |
| `limit:N`                               | results per page, clamped to 1–25, default 10                                                  | non-integer → search text                                                |
| `page:N`                                | page number, clamped to 1–10, default 1; `search` only, consumed and ignored by `search_sites` | non-integer → search text                                                |

- No search words left after stripping qualifiers → no site is called; every target gets `empty` "no search terms".
- `search_sites` structured fields win over the matching qualifiers. `sites: []` counts as not given. An invalid structured `after`/`before` or a non-finite `limit` is ignored (the qualifier value, if any, applies) and named in the response's `ignoredFields`.

## Search

**Targets.** With `site:` values, the targets are the named sites; without, every `active` site. A site is searched only when it is `active` and declares `search`. Named sites that are not searchable get one status entry each:

| Site state                | Entry                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| `needs_login`             | `auth_required`, "login required or session expired", login action |
| `degraded`                | `adapter_error`, last failure, action "Repair in the dashboard"    |
| `failed`                  | `adapter_error`, failure reason (no action)                        |
| `onboarding`              | `unsupported`, "onboarding in progress"                            |
| `active` without `search` | `unsupported`, "search is not supported by this site"              |

Without `site:`, `siteStatuses` holds one entry for every registered site; with `site:`, one entry per named site, then one per unknown value in input order. When the caller named sites and none resolved, nothing is searched.

**Per-site call.** Each target's adapter is called once per page, concurrently, with `limit` and its own adapter cursor; it returns at most `limit` items. Sites with native `dateFilter` receive the window; for the others the core post-filters and adds `note: "date filter applied after retrieval"` to that site's entry. The post-filter compares the calendar date written in `publishedAt` (in the site's own offset) with the inclusive window; an undated result fails any window.

**Merge.** Results are deduplicated by normalized URL (adapter `canonicalize` first; then lowercase scheme and host, strip `www.`, fragment, `utm_*`, `fbclid`, `gclid`, `ref`, `src`, sort remaining parameters, drop a trailing slash except at the root), against both this page and the hashes carried in the cursor. Each site contributes a prefix of its adapter page; the emitted page is ordered by `publishedAt` descending, undated last, ties by alphabetical site key, and cut to `limit`. Excerpts longer than 1,000 characters are cut.

**Settling `ok`.** A site whose adapter said `ok` but contributed nothing and has nothing left reports `empty`, with "no results in the date window", "no new results (all were returned on earlier pages)", or "no results". A site that has nothing left on a later page reports `empty` "no more results for this query".

**Never raise.** A failing site contributes zero results plus its status entry; an internal error yields statuses only (`adapter_error` "internal error: …" for every target). The tool itself never returns an MCP error.

## Pagination

- The cursor (`nextCursor`, `search_sites`) is self-contained: per site the adapter cursor that produced its current adapter page and the offset of its first unemitted result, the page number, and the hashes of the last 200 normalized URLs returned. The next page resumes each site from its first unemitted result before asking the adapter for a further page, so results cut by `limit` are not lost.
- A cursor keeps working after restarts and cache expiry. A site in the cursor that is no longer registered is dropped. A malformed or oversized cursor (over 32,768 characters) → every target `unsupported` "invalid cursor: …". Exhausted and `empty` sites leave the cursor; failed sites keep their position. When no successfully searched site has anything left, `nextCursor` is null.
- `nextPage` (`search`) is `page + 1` while more results exist, null at page 10 or when exhausted. For `page:N`, the server looks up the page chain `(normalized query + sites + window + limit, N) → cursor` (kept 30 minutes); without an entry it walks forward from the nearest lower chain entry or page 1, page by page, recording chain entries as it goes. Duplicates across pages of one chain are suppressed through the cursor's hash list.
- Adapters must return the same page for the same adapter cursor; the core may re-request a page and skip what it already emitted.

## Read

1. A ref starting with `http(s)://` resolves to the site owning its hostname (no network). Otherwise it must be `<siteKey>:<localId>` with a valid key and no whitespace; a `u_` id must decode to an http(s) URL. Invalid refs → `unsupported` "invalid ref: …" with `availableSites`.
2. No owning site, or an unregistered key → `unsupported` with `availableSites` (loadable, serving, read-capable keys). Registered `onboarding`/`failed` → `unsupported` "site not ready: <status>". No `read` capability → `unsupported`. `needs_login` and `degraded` sites are still read; the outcome is reported as it comes.
3. The adapter receives `{ url }` for URL refs and `u_` ids, `{ localId }` for native ids. Its verdict is passed through: completeness is the adapter's decision, and a document attached to a non-`ok` verdict is discarded. `ok` without a valid document is `adapter_error`.
4. The document's text is capped at 100,000 characters, cut at a paragraph boundary with `truncated: true`. When read by id, the returned `id` is the requested id.
5. Tool budgets: `fetch` text ≤ 60,000 characters. `read_documents` takes 1–5 refs, reads them concurrently (refs of one site run in parallel up to the site's pool, see Browser scheduling), answers in input order, and splits 120,000 characters across the documents that came back `ok`: each gets `max(10000, floor(120000 / okCount))`. A budget cut sets `truncated: true`.
6. `fetch` failure is an error object `{ code, message, site, action?, availableSites? }`; `code` may be `empty` for a missing article. `read_documents` never fails as a whole.

## Completeness

- A read returns `ok` only when the adapter has confirmed the full article body is present (a positive body marker plus the absence of the site's wall markers). Login wall or lapsed session → `auth_required`; paywall teaser, block page, captcha → `access_denied`; throttling page → `rate_limited`; missing article → `empty`.
- A block page or captcha is flagged `blocked: true` by the adapter (a bot check that interrupts a page script is flagged by the browser port); with `captcha.auto` on, the bridge then makes one quick challenge attempt and, unless the check is captcha-limited, re-runs the call (see Challenge attempts). The flag starts no cool-down; only `rate_limited` does. A paywall is also `access_denied` but must not be flagged, because there is no challenge to solve and the user would be told to solve a captcha.
- Example dispositions in production: a Reuters Breakingviews (`premium`) article read with an account that has only a Reuters.com subscription is `access_denied`; a paid Reuters article read without the AccountButton marker is `auth_required`; a Naver neighbor-only post read logged out is expected to be `auth_required` (the marker set comes from Naver's notices and has not yet been observed on a live neighbor-only post).

## Dates

`publishedAt` is ISO 8601 with the site's own offset (from the manifest's `timezone`); `datePrecision` is `minute` with a time of day or a relative amount under a day, `day` for a calendar date, null without a date. Relative dates ("3시간 전", "5 hours ago") resolve against the request time in the site zone at request time and are never cached across calls by the adapter.

## Caching

| Entry                                                             | Lifetime   | Stored only when                                                                              | Removed by               |
| ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- | ------------------------ |
| search page (key: normalized query, sites, window, limit, cursor) | 10 minutes | every searched site returned `ok` or `empty` (entries for non-searched sites do not block it) | expiry, site cache clear |
| document (key: site and adapter ref)                              | 24 hours   | status `ok`                                                                                   | expiry, site cache clear |
| page chain cursor                                                 | 30 minutes | the page has a next cursor and the next page ≤ 10                                             | expiry, site cache clear |

A site's cache is cleared when a live `auth_required` moves it to `needs_login`, when a health check first reports `auth_required`, when a passing health check returns a `needs_login` site to `active`, on Remove, and from the dashboard (one site or all). Every cache lookup failure is a miss, never a tool failure.

## Site lifecycle

Statuses (exact set): `onboarding`, `active`, `needs_login`, `degraded`, `failed`.

| From                                         | Event                                                                                         | To                                          | Side effects                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| —                                            | Add with a URL/hostname                                                                       | `onboarding` (provisional key and hostname) | job queued                                                                                          |
| `onboarding`                                 | job succeeds (promotion)                                                                      | `active`                                    | failures cleared, last check = now                                                                  |
| `onboarding`                                 | job fails, is cancelled, or is interrupted by a restart                                       | `failed` with the reason                    | —                                                                                                   |
| `failed`                                     | Retry                                                                                         | `onboarding`                                | —                                                                                                   |
| `active`                                     | live `auth_required`                                                                          | `needs_login`                               | cache cleared                                                                                       |
| `active`                                     | 3rd consecutive live `adapter_error`                                                          | `degraded` with the last message            | —                                                                                                   |
| `degraded`                                   | live `adapter_error`                                                                          | `degraded`                                  | last failure updated                                                                                |
| any serving                                  | live `ok`/`empty`                                                                             | unchanged                                   | error count reset                                                                                   |
| any serving                                  | live `rate_limited`                                                                           | unchanged                                   | 10-minute cool-down                                                                                 |
| any serving                                  | live `access_denied` (also a `blocked` page), `timeout`, `browser_unavailable`, `unsupported` | unchanged                                   | —                                                                                                   |
| any serving                                  | health check `ok`                                                                             | `active`                                    | from `needs_login`: cache cleared, login confirmation recorded                                      |
| any serving                                  | health check `auth_required`                                                                  | `needs_login`                               | cache cleared unless already `needs_login`                                                          |
| any serving                                  | health check `browser_unavailable`                                                            | unchanged                                   | last check not updated, so it runs again at the next pass                                           |
| any serving                                  | health check with any other non-`ok` status                                                   | `degraded`                                  | message; an `empty` sample search reads "health check: the sample search returned no results"       |
| any serving                                  | login confirmation (after an Aside AI login task reported `done`)                             | as a health check with the same outcome     | as a health check; nothing recorded when it found no place in time, met a cool-down, or was stopped |
| `active`/`degraded`/`failed` with live files | Repair succeeds                                                                               | `active`                                    | previous files kept in `.previous/`                                                                 |
| any                                          | Repair fails or is cancelled                                                                  | unchanged                                   | live adapter untouched                                                                              |
| any                                          | Remove                                                                                        | gone                                        | folder, state, cache deleted; running job cancelled first                                           |

Impossible by rule:

- A live `ok` never returns a `needs_login` or `degraded` site to `active`; only a passing health check (the login confirmation included) or a promotion does.
- An Aside AI verdict never changes a status by itself; a login task's `done` is followed by the login confirmation, and only its result is recorded.
- `onboarding` and `failed` sites never receive live outcomes or health checks, are never searched, and read as `unsupported`.
- A `failed` site becomes `active` only through a promoted job.
- Repair never changes the status while it runs.

Startup reconciliation of `data/sites.json` with `sites/`:

- a loadable folder with no state entry (fresh clone) → registered `active` with no last check, checked at the next health pass;
- a state entry whose folder is missing → dropped;
- a serving site whose folder is no longer loadable → `failed` "adapter folder is incomplete: …";
- an `onboarding` site whose folder is loadable (stopped after the swap) → `active`;
- a folder that is not loadable and has no state → ignored, never loaded;
- a folder whose hostname another site owns → ignored.

## Health checks

- Run for loadable serving sites whose last check is missing or older than the interval (default 24 hours). The first pass runs 60 seconds after start, then the timer looks for due sites at most hourly and checks them one after another.
- A site with a running or waiting browser task (a search, read, challenge attempt, Aside AI task, repair step) or a cool-down is skipped and stays due. "Check now" runs immediately when the site is idle and ignores the cool-down; a busy site answers `skipped` naming the holders ("site busy: search, fetch"); it refuses non-serving sites. Before anything else, "Check now" ends the site's Aside AI pause and hold and resets its failure count (also when the check is then skipped).
- A scheduled check or "Check now" that finds `auth_required` (recorded as usual) starts an Aside AI login task when the rules allow (Assistant tasks); the result's action is then its sentence. After the task reports `done`, the **login confirmation** (`HealthChecker.confirmLogin`) runs the light check once more for a serving, loadable site that is not already being checked and not cooling down. It does not wait for the site to be idle (its exclusive slot is waited for within its own bounded wait), makes no captcha attempt, starts no task, and is recorded like a health check (`health check finished` with `trigger: "login confirmation"`); a check that found no place in time, met a cool-down, or was stopped at core stop records nothing.
- The check is the light validation: sample search with limit 3 plus one read, within 60 seconds, holding the site alone (exclusive); it writes nothing to `validation.json`, so a failed check never makes a site unloadable.
- "Check now" on a block page (`blocked`, not `rate_limited`) with `captcha.auto` on: light check → one quick challenge attempt (a pool task, after the check ended) → the light check once more only when the attempt acted, met a kind it can act on, or found `none`; a captcha-limited attempt leaves the first result standing with the captcha-limited sentence (Challenge attempts). Scheduled checks never attempt.

## Onboarding jobs

States: `queued → running → succeeded | failed | cancelled`, and `running → awaiting_user`, from which Retry returns the same job (same id) to `queued`.

- One job runs at a time across all sites; further jobs wait in FIFO order.
- **Add** with a URL or hostname: rejected when the input is empty, longer than 500 characters, an IP address, `localhost`/`.localhost`/`.local`, or a single-label name; rejected with "already registered as <key>; use Repair or Remove" when any site owns the hostname; otherwise the site is registered `onboarding` and the job queued. **Add with a bare name** queues a job without a key; the agent's first step names the homepage and the ownership check runs then. The optional note is at most 2,000 characters and is passed to the agent as the user's words.
- **Retry**: for the site's latest job in `awaiting_user` or `failed`, requeues that job; for a `failed` site with no folder that can load and no such job, starts a new Add job. A queued or running job → conflict. Retrying an Add job whose site is neither `failed` nor `onboarding` → conflict ("use Repair").
- **Repair**: only for `active`, `degraded`, `failed` sites that have live `manifest.json` and `adapter.ts`, and only when no job is queued, paused, or running for the site. Staging starts as a copy of the live files.
- **finish** is accepted only when the staged files carry a passed full validation whose hash matches them, they type-check, and every staged host is approved; the service then re-runs the full validation itself (ignoring a site cool-down, because the user started the job) and promotes only on a pass. The agent's own `run_validation` respects a cool-down, as does a scheduled health check; `npm run site:validate` and dashboard actions ignore it.
- **Failure** (validation failed, the agent gave up or ended without `finish`, turn limit, error): an Add's site becomes `failed`; a Repair leaves the site and its live adapter untouched.
- **Blocked**: a login wall, captcha, consent interstitial, or missing subscription pauses the job as `awaiting_user` with a reason, the smallest user action, and a block kind (`login`, `captcha`, `consent`, `subscription`, `other`; default `other`). The kind is stored as `blockKind` while the job is paused and reset to `other` when it runs, fails, or is cancelled; host-approval pauses and older records are `other`. A captcha is first given to the bridge's own solver once (`browser_solve_captcha`, only with `captcha.auto` on); the job pauses with kind `captcha` only when it stays unsolved. A site without a usable search surface is onboarded read-only (`capabilities.search = false`); that is not a block. Reading still failing after the user's action fails the job.
- **Remove** cancels the site's job first and waits for the agent to stop.
- **Restart**: a job found `running` fails with "interrupted by restart; click Retry" and its Add site becomes `failed`; queued jobs run again; paused jobs stay paused; an `onboarding` site with no queued or paused job becomes `failed`. A graceful stop fails a running job with "interrupted by shutdown; click Retry".
- **Helper check**: one real round trip on the runtime a job would use now. The last result is kept in `data/helper-check.json` across core and process restarts. 30 seconds after each core start the check runs by itself once, when no job is queued or running, the runtime in use is installed and its sign-in is not known to be missing, no `ok` is recorded for that runtime, and no check ran on this core yet; a failed or limit result is therefore retried only at the next core start. The Check button always runs and replaces the record.

## Browser scheduling

- Per-site pool: up to `maxConcurrentPerSite` (3) tasks of one site run at once, at most `maxConcurrentTasks` (8) across all sites; FIFO within a site, arrival order across sites. Tool calls (search, read, each ref of `read_documents`, parallel calls of one client), challenge attempts, and Aside AI tasks share the pool. Exclusive tasks hold the site alone: each onboarding or repair browser step, every validation (full and light), and health checks. An exclusive task waits for the site's running tasks, holds back later tasks of the site from the moment it queues, and never overlaps any task of its site, so a repair still interleaves with live reads step by step.
- A tool call has 90 seconds in total (waiting included); one browser step has 120 seconds. A call that cannot get a place in time gets `timeout` naming the holders: "site busy: repair running", "site busy: 3 tasks running (search, search, fetch)", or "browser busy: …" when the global cap is the blocker.
- Politeness is per task: each task spaces its own page loads, fetches, and in-script navigations by the manifest's `minIntervalMs` (default 1,500 ms; Reuters uses 3,000). Overlapping tasks of one site are separated only by `concurrentStaggerMs` (500 ms) between their starts, which delays a task's first load; a task that starts on an idle site starts at once.
- A cooling-down site is refused with `rate_limited` for 10 minutes after a `rate_limited` outcome. A `blocked` page starts no cool-down.
- The bridge opens and closes its own tabs and never attaches to the user's tabs; up to `maxConcurrentPerSite` tabs per site may stay open for 5 minutes for reuse, and parallel calls never share a tab.

## Challenge attempts

With `captcha.auto` on (default; Settings → Captchas on the settings page), a failure flagged `blocked: true` (a status other than `rate_limited`) gets one quick automatic attempt by the bridge's own solver; one re-run of the same adapter call follows only when the solver could do something. Each blocked call is handled on its own: nothing about a site is remembered between calls. With the setting off none of this runs.

- **Blocked failures**: an adapter's returned `blocked: true`, or a bot check met during a page script: a page-script step whose tab filter blocked a request to a captcha vendor host (a `CAPTCHA_VENDOR_HOSTS` host or a subdomain; reCAPTCHA's path-limited entries count by host alone) fails with `access_denied` "<site> answered with a bot check (<host>)", flagged blocked, and a vendor host wins over other blocked hosts in the same step. The request stays blocked and the `browser shim violation` line is logged as before; nothing is widened. Only page-script steps are mapped: a tab open, snapshot, cookie fetch, or captcha step, and a script's own refused `fetch`/`openTab` of a vendor URL, keep `adapter_error`. The services and the light validation read the thrown flag like a returned one; a blocked failure thrown out of a health check itself counts as a block page whose URL is unknown.
- **When**: live `search`/`fetch`/`search_sites`/`read_documents` calls (at most one attempt per site and tool call: the refs of one `read_documents` call and the pages one `search` walks share it, a later blocked call of that site only joins an attempt still running, and a challenge met in the re-run is not attempted again), "Check now", and the helper's `browser_solve_captcha`. Scheduled health checks, validation (`site:validate`, the helper's `run_validation`, the promotion gate), and throttle pages (`rate_limited`) never get one.
- **Where**: the failed read's URL; else the page the adapter's browser session last showed (`BrowserSession.lastUrl()`, the last on-site main-frame URL after a tab open, page script, or snapshot; for a search this is the site's search page, for a native id the article page); else `https://<first hostname>/` when the adapter showed no page (for example a site read only through cookie fetches). Check now uses the same rule. On the site's scope (`hostnames ∪ extraAllowedHosts`); a non-exclusive pool task with holder `captcha`, in a fresh tab of the attempt's own session that is opened like any session tab, then widened to the captcha vendor hosts and reloaded. The helper's tool instead runs on the job's own tab as one of its exclusive browser steps.
- **Detection budget**: `captchaDetectBudgetMs` (20 s), counted from the start of the port's attempt (after the scheduler slot) and clipped to the attempt's budget, bounds everything until the first detection is done: the capability probe, the tab open, the widening, the politeness waits, the widened reload, the wait for a self-resolving interstitial, and the detection. When it runs out first, the attempt ends `kind: "unknown"`, `rounds: 0`, "detection did not finish in time". Action rounds after a detection use the rest of the attempt's budget. The helper's `browser_solve_captcha` and `browser:captcha-check` give no detection budget, so theirs equals the whole budget.
- **Inline or background**: inline only when at least `captchaDetectBudgetMs + captchaRerunReserveMs` (20 s + 15 s) of the tool call remain, with a budget of `min(captchaAttemptBudgetMs (45 s), remaining − captchaRerunReserveMs (15 s))` that includes the wait for the slot; otherwise the failure is returned at once with the could-not-be-solved action (below) and an attempt runs in the background. At most one attempt runs per site; a caller that meets a challenge while one runs joins it.
- **Captcha-limited**: an attempt that could not act on the check is captcha-limited: `kind: "unknown"` with no action round (nothing recognized, for example DataDome's slider inside the vendor's frame, or detection not finished in time), or no solver at all (`available: false`, no `solveChallenge`). The call then answers at once with `access_denied`, still blocked, whose message and action are "<site> is captcha-limited: its bot check cannot be solved automatically. Open <url> in Aside, solve it, then retry". No re-run and no background attempt follow. The log line is `captcha-limited` (metadata only), and the site's search outcome line carries "captcha-limited" instead of the sentence, which names the URL.
- **Re-run**: after `kind: "none"`, a kind the solver can act on (checkbox, slider, text), or an attempt that acted and then saw `unknown`, the call re-runs once, but only while the reserve is left; otherwise the original failure is returned and the attempt's effect stays for the next call. The solver never declares success. A re-run that returns `ok` or `empty` is returned; a re-run that is still blocked returns the original failure with the action "The captcha could not be solved automatically. Open <url> in Aside, solve it, then retry" (with the solver's fixed message in parentheses after "automatically" when the solver did not report `solved`, for example "(text captcha: no vision model is configured in Aside)"). Any other re-run verdict is returned as it is. An attempt that failed otherwise (browser unavailable, refused by the scheduler, a joiner that waited out its budget, an error) returns the original failure with the could-not-be-solved action. Both outcomes are fed to the lifecycle; none of it starts a cool-down.
- **Check now**: light check → one quick attempt → a second light check only when the attempt acted, met a kind it can act on, or found `none`; the second result sets the status, with the could-not-be-solved action when it is still blocked, and the solver's message added to the failure message the site card shows. Captcha-limited → no second check; the first result stands with the captcha-limited sentence as its message and action, so the card shows it as the site's last failure. An attempt that failed otherwise → the first result with the could-not-be-solved action.
- **Ends early** when the site is removed or the core stops; the attempt's tab is then closed, never kept warm. Whenever the attempt ends, a tab that may still allow the vendor hosts (its widening call did not come back, or the restore failed) is closed rather than reused.
- **Tunables** (`config/bridge.json` `tunables`, `docs/operations.md`): `captchaAttemptBudgetMs` (45000), `captchaDetectBudgetMs` (20000), `captchaRerunReserveMs` (15000).
- **With the Aside AI on**, a check the bridge's attempt could not act on is handed to an Aside AI captcha task, and while such a task (or a login task) runs on the site, a blocked call skips the bridge's own attempt (Assistant tasks).

## Assistant tasks (the Aside AI)

With `assistant.auto` on (default; Settings → Aside AI on the settings page), the bridge may ask the AI built into the Aside browser (`aside exec`) to do one bounded task for a site after its own means failed: pass the site's human check (`captcha`) or log in again with the password saved in Aside's password manager (`login`). Tasks run in the background only; a tool call or check never waits for the AI and answers at once with a fixed sentence. Code: `src/adapters/mcp/assistant-tasks.ts`; the process and its texts: `docs/security.md` (Aside AI assistant).

- **Captcha triggers** (a blocked failure of a live `search`, `fetch`, `search_sites`, or `read_documents` call, not `rate_limited`):
  - `captcha.auto` off → a task starts;
  - the bridge's own attempt was captcha-limited → a task starts; the call keeps the captcha-limited message and gets the AI's sentence as its action;
  - the own attempt went to the background → the task waits for that attempt's report (`ChallengeGate.whenSettled`) and starts only when the attempt was captcha-limited, could not run, or there was none; the call answers at once with the AI's sentence;
  - the own attempt ran inline but did not run to the end (refused by the scheduler, browser unavailable, site gone, a joiner that waited out its budget, an error) → a task starts; when the site's attempt is still in flight (a joiner that timed out), the task waits for its report like a background one;
  - the own attempt ran inline and acted (it found `none` or a kind it can act on, or acted and then saw `unknown`) → no task; the re-run, or the next blocked call, decides.

  The call then keeps its failure status (`access_denied` for a block or captcha page; captcha-limited answers are always `access_denied`), still blocked, with the action "The Aside AI is passing the check now; retry in a minute". While any task works on the site, every blocked call skips the bridge's own attempt and answers the same way, with the running task's sentence. A blocked `auth_required` (a login wall reported together with a block page) is a login: in each case above it starts a login task instead of a captcha task and keeps `auth_required`.

- **Login triggers**: a live `auth_required` (the site turns `needs_login` as usual), a read of a `needs_login` site that answers `auth_required`, a search that names a `needs_login` site with `site:` (and has search words), and a scheduled check or "Check now" that finds `auth_required`. The answer is `auth_required` with the action "The Aside AI is logging in now; retry in a minute". A search without `site:` starts nothing; its `needs_login` entry only shows a running task's sentence or the hold sentence.
- **When no task starts** (the answer is then the same as without the Aside AI): the setting is off; the Aside CLI did not answer its probe (`aside account status` at core start, and again after a task failed for a CLI reason; a trigger during a probe waits for its answer, and without any answer there is no task); the site is not serving or not loadable, or is cooling down; the site's tasks are paused. Validation, helper jobs, and the helper's `browser_solve_captcha` never start one.
- **One task per site**; sites run in parallel. A task is a pool task of the site (holder `assistant`), waits for its place at most `assistantTaskBudgetMs`, and then has `assistantTaskBudgetMs` (120 s) to finish; when the budget ends, the Aside session is stopped and the task is `failed`/`timed_out`. Its URL is the problem page (the read's URL, else the page the adapter last showed) when it is on the site, else the homepage; it only checks that the task aims at the right site and never reaches the AI's text.
- **Verdicts**: `done`, `failed`, or `needs_user`, with a reason code from `no_saved_password`, `verification_code`, `question`, `check_not_passed`, `timed_out`, `other`. `done` never makes an outcome `ok`:
  - a captcha `done` is confirmed only by the next call; a blocked call of the site within `assistantFailureWindowMs` counts the task as failed;
  - a login `done` runs the login confirmation (Health checks); its `auth_required` counts as a failed task, a busy, cooling-down, or unreachable answer counts as neither, and a pass returns the site to `active`.
- **Pause**: two counted failures (`failed` verdicts, and the two cases above) within `assistantFailureWindowMs` (10 minutes) pause the site's tasks for `assistantPauseMs` (10 minutes). Calls meanwhile answer as without the Aside AI.
- **Hold**: a `needs_user` verdict holds the site's tasks until "Check now". Meanwhile a call that would start a task answers with the reason's sentence (`assistantAction(reason, account)`, naming the Aside account): "The site asked for a verification code — log in in the Aside window of account <account>, then press Logged in? Check now" (likewise "No password for this site is saved in Aside — …" and "The site asked a question only you can answer — …"); "The Aside AI could not pass the site's check — pass it in the Aside window of account <account>, then press Check now"; for `timed_out` and `other`, "The Aside AI needs your help with this site — finish it in the Aside window of account <account>, then press Check now".
- **Never counted**: a task stopped at core stop, a task the scheduler refused or that found no place in time, and a caller's own timeout.
- **State** (last task per site, failure times, pause, hold) is kept in memory for the life of the core; a core restart (a saved setting, Restart) starts it over. Core stop stops running tasks through their signal and waits for them at most 20 s.
- **Tunables**: `assistantTaskBudgetMs` (120000), `assistantFailureWindowMs` (600000), `assistantPauseMs` (600000). `assistant.effort` (default `low`) sets the effort Aside's AI works with.

## Current scope limits

- The bridge currently uses one Aside account at a time (`asideAccount`, default `u0`) and one browser engine (Aside).
- Results are returned only through the five tools; there is currently no export format.
- Every authenticated client currently sees all five tools; there is no per-client scoping.
