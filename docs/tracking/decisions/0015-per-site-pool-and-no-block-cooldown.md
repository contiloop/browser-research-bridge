# 0015 — A per-site browser pool, and no cool-down after a block page

Supersedes in part [0010](0010-login-flags-and-cooldown-policy.md) (the cool-down rule).

## Context

The scheduler allowed one task per site at a time (a site lock) and at most 4 busy sites. ChatGPT and Claude issue several tool calls at once, and `read_documents` reads up to 5 articles, so calls on one site queued behind each other and often ran out of the 90-second budget (status list item 4, "parallel search", 2026-10-07). Separately, decision 0010 made a `blocked: true` page start a 10-minute cool-down. With automatic captcha attempts (0014) that cool-down would refuse the very re-run that confirms a solved captcha, and it paused a whole site for every client because of one challenge page.

## Decision

- Each site has a pool: up to `maxConcurrentPerSite` (3) tasks run at once, and at most `maxConcurrentTasks` (8) across all sites; FIFO within a site, arrival order across sites. Tool calls and challenge attempts share the pool. Helper and repair browser steps, every validation, and health checks are `exclusive`: they wait for the site's running tasks, hold back later ones, and run alone. `maxConcurrentSites` is removed (an unknown key now warns and is ignored).
- Politeness is per task: each task spaces its own page loads by `minIntervalMs`; overlapping tasks of one site are separated by `concurrentStaggerMs` (500 ms) between their starts. Up to `maxConcurrentPerSite` warm tabs per site are kept, and parallel calls never share a tab.
- Only `rate_limited` starts the 10-minute cool-down, everywhere (scheduler, lifecycle, live calls, registry). A `blocked: true` page starts none; it gets a challenge attempt instead (0014).
- Busy messages name the holders ("site busy: 3 tasks running (search, search, fetch)", "site busy: repair running"); `holders(site)` replaces `currentHolder`.

## Alternatives

- **Keep the site lock and raise the budget**: Claude caps a call at about 240 seconds, and queued calls would still wait for each other.
- **Unlimited parallelism per site**: sites behind bot protection (Reuters) throttle bursts; a small pool bounds the load.
- **Keep spacing loads across tasks of a site**: three parallel calls would then wait for each other's loads and lose most of the gain; the stagger between starts and a small pool bound the burst instead.
- **Keep the cool-down for block pages next to captcha attempts**: the re-run after an attempt would be refused, and one captcha would still pause the site for every client.

## Consequences

- A site can see up to 3 page loads within about a second in a burst; a site that throttles must be reported `rate_limited` by its adapter, and `maxConcurrentPerSite: 1` restores one task per site for every site.
- `concurrentStaggerMs` may be set to 0 to turn the stagger off (the one tunable allowed to be zero).
- A site that keeps showing a block page is no longer paused; it gets at most one attempt per tool call, and the user is asked to solve the captcha in Aside.
- Doc comments in `src/adapter-kit/completeness.ts` and `results.ts` still mention the old cool-down. Any change to `src/adapter-kit` requires a live `site:validate` of every site (`docs/standards.md`), so they are corrected with the next kit change that is validated live (`docs/tracking/findings.md`).
