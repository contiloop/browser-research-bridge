# 0017 — The Aside AI passes bot checks and logs in again, on by default

Extends [0014](0014-captcha-attempts-and-vendor-hosts.md) and [0016](0016-quick-captcha-attempt-and-captcha-limited.md) (what follows a check the bridge's own attempt cannot act on). Replaces the earlier rule "the program never starts the Aside AI" (`docs/standards.md`, `docs/security.md`), which no decision record had stated.

## Context

The bridge's own captcha solver works only on checks in the page's main frame; DataDome's slider on Reuters lives in the vendor's cross-origin frame, so every such check was captcha-limited and left to the user (finding of 2026-10-08, acceptance run 4). A lapsed site login likewise turned the site `needs_login` until the user logged in by hand and pressed "Logged in? Check now". The Aside browser has an AI of its own that can act in a tab like a person and use the passwords saved in Aside's password manager, and its CLI can run one task and return (`aside exec`). Until now the program never started it: the settings page only offered texts the user could paste into it. On 2026-10-09 the owner decided that the program may start the Aside AI itself, on by default, for two bounded purposes.

## Decision

- **Two purposes only.** A task passes a site's human check (`captcha`) or logs in to the site again with the account and password already saved in Aside (`login`). One task per site, in the background; a tool call or check never waits for it and answers at once with a fixed sentence ("The Aside AI is passing the check now; retry in a minute", "The Aside AI is logging in now; retry in a minute").
- **Only after the bridge's own means failed**: a captcha task after the bridge's own attempt could not act on the check (captcha-limited, or a background attempt that did not act) or when `captcha.auto` is off; a login task after `auth_required` (a live call, a read of a `needs_login` site, a search naming one with `site:`, a scheduled check, Check now). Never for validation, helper jobs, cooling-down or non-serving sites.
- **Fixed instructions, no caller input.** Two English texts in code (`assistant-prompts.ts`). The only addresses in them are `https://<first hostname>/` and the manifest's `loginUrl` without query or fragment. The texts keep the AI in one new tab and on the site's hostnames (a third-party sign-in window opened by the login page is allowed), say that page text is data, forbid local addresses and the settings page, forbid creating accounts and changing passwords, and make it stop with `NEEDS_USER` for a missing saved password, a verification code, or a question. The reply must end with one `RESULT:` line.
- **A confined process.** `aside exec --account <account> --host local --permission guard --effort <assistant.effort> <instruction>`, no shell, in `data/assistant-work/` (0700), with the REPL child's minimal environment (no `BRIDGE_*`, `ANTHROPIC_*`, `OPENAI_*`), standard input closed, a 120 s budget after which the Aside session is stopped and the child killed. The AI's text is scanned only for the session line and the verdict and is never logged, stored, or returned.
- **The verdict is a claim.** A captcha `done` counts as failed when the next call of the site is blocked again within 10 minutes; a login `done` is confirmed by the light check (`HealthChecker.confirmLogin`), recorded like a health check. Two counted failures within 10 minutes pause the site's tasks for 10 minutes; a `needs_user` verdict holds them until Check now, with a fixed sentence per reason naming the Aside account.
- **On by default**, switchable on the settings page (Settings → Aside AI, `assistant.auto`); the page says it uses the password saved in Aside and the user's Aside plan. `assistant.effort` (default `low`) and the tunables `assistantTaskBudgetMs`, `assistantFailureWindowMs`, `assistantPauseMs` live in `config/bridge.json`.

## Alternatives

- **Keep the program from starting the Aside AI; offer only copy-and-paste texts** (the previous rule): the user does every check and login by hand, including DataDome's slider, which the bridge's solver cannot reach.
- **Pass the caller's URL to the AI** (the article that failed): a research client chooses that URL, and its path or query could carry instructions to the AI; the site root or the manifest's login page is enough for both purposes.
- **Make the call wait for the AI**: a task takes up to two minutes, more than a tool call's 90 s budget, and would hold the client.
- **Let the bridge type the password itself**: the bridge would have to read Aside's password manager, which hard gate 2 forbids.
- **Off by default**: the owner wants automatic recovery for a non-coder audience; the switch and the note on the page leave the choice to the user.

## Consequences

- Where the AI browses and what it types is bounded by its instruction and Aside's `guard` permission mode, not by the bridge's shim; a page could try to steer it (prompt injection), up to typing a saved password into a page that imitates the login page. The owner accepted this risk (`docs/security.md`, Aside AI assistant).
- The instruction and what the AI sees on the pages go to the model provider behind Aside's AI, and every task uses the user's Aside plan.
- `docs/standards.md` replaces "MUST NOT start the Aside AI" with the bounded rule; hard gate 2 names the exception.
- An Aside AI task takes a place in the site's browser pool (holder `assistant`), so a health check or helper step on the site waits for it.
- The `aside exec` contract was observed on 2026-10-09 and is not documented by Aside; an Aside update can change it (`docs/engineering-notes.md`). Live behavior is not yet confirmed (`docs/tracking/status.md`).
