# 0013 — Reuters as the reference adapter; Hacker News removed; the Naver adapter kept private

## Context

The repository shipped a public Hacker News adapter as the helper's worked example, plus Reuters and the owner's Naver Blog neighbors adapter. The owner wanted Hacker News gone from the product entirely and decided that the published repository ships Reuters only. The helper still needs one worked example to learn from. The Naver adapter is personal (the owner's neighbor list) and should not be published, but must keep working on the owner's Mac.

## Decision

- `sites/reuters/` is the only shipped site and the helper's reference adapter: the helper's reference allowlist, its instructions and tool descriptions, and `docs/ADAPTERS.md` point to it. The paths of `docs/ADAPTERS.md` and `docs/BROWSER.md` and their sections 10 and 12 are unchanged. The unit test that a shipped adapter's `validation.json` matches its files guards Reuters.
- `sites/hacker-news/`, its tests, and every reference to it in code, tests, and the helper's documents are removed.
- `sites/blog-naver/` is removed from version control but left on the owner's Mac, excluded in the clone's `.git/info/exclude`, so neither the bridge's auto-commit nor an ordinary commit adds it back.

## Alternatives

- **Keep Hacker News as a public example**: against the owner's decision.
- **Ship no adapter at all**: the helper would have no worked example and the first-run checklist no site to log in to.
- **Delete the Naver adapter**: the owner uses it daily.

## Consequences

- Reuters needs a subscription login, so its validation and the helper's example depend on a paid site; if this lowers the helper's success on new sites, that is reported rather than a public example quietly brought back.
- A fresh clone does not restore the Naver adapter; the owner keeps it only on that Mac. Checking out or merging the removal commit deletes the folder from that working tree, so it is copied aside first and restored afterwards.
- Git history still contains the Hacker News and Naver adapters (a publishing note for the owner).
