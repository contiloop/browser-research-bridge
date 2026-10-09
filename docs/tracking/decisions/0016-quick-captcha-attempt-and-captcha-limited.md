# 0016 — One quick captcha attempt per blocked call, and "captcha-limited" when the solver cannot act

Supersedes in part [0014](0014-captcha-attempts-and-vendor-hosts.md) (when an attempt runs inline and what follows it).

> **Extended by [0017](0017-aside-ai-passes-checks-and-logs-in.md) (2026-10-09):** with the Aside AI on (`assistant.auto`, default), a captcha-limited call, and a background attempt that did not act, also start an Aside AI captcha task in the background; the call then answers with "The Aside AI is passing the check now; retry in a minute" as its action, and the captcha-limited message stays. Everything below still holds for the bridge's own attempt.

## Context

On the first day of the live program (2026-10-08) Reuters answered three parallel ChatGPT searches with the DataDome bot check. Two things went wrong. The check interrupted the adapter's in-page API call, whose request to `geo.captcha-delivery.com` the tab filter blocked and the shim counted as the script's own, so those calls ended `adapter_error` with no captcha attempt and no "solve it in Aside" action. The calls that did get an attempt waited 57–60 s: the inline attempt ran out of its 45 s budget with `kind: "unknown", rounds: 0` (the widened reload never reached detection), and all of them re-ran into the same check. DataDome's slider lives in the vendor's cross-origin frame, which the solver cannot act on, so every such wait was spent for nothing. Decision 0014 had made an attempt inline whenever `captchaInlineMinRemainingMs` (40 s) of the call remained and re-ran the call after every attempt, including `none` and `unknown`.

## Decision

- **A bot check during a page script is a blocked page.** In a page-script step, a request blocked on a captcha vendor host (`isCaptchaVendorHost`: a `CAPTCHA_VENDOR_HOSTS` host or a subdomain, path limits ignored because the violation record carries only the host) that is not the script's own refused `fetch`/`openTab` fails the step with `OutcomeError("access_denied", "<site> answered with a bot check (<host>)", { blocked: true })`. A vendor host wins over other hosts in the same step; other step kinds keep `adapter_error`. `OutcomeError` carries `blocked` (`isBlockedError`); the search and read services, the light validation (`onBlocked`), and the health checker read it like a returned `blocked: true`. The request stays blocked and logged; nothing is widened.
- **Every attempt is quick.** The port's attempt gets a detection budget, `captchaDetectBudgetMs` (20 s, tunable), counted from its start after the scheduler slot and clipped to its budget. It bounds the probe, the tab open, the widening, the politeness waits, the widened reload, the interstitial wait, and the detection. When it ends first, the attempt is `kind: "unknown"`, `rounds: 0`, "detection did not finish in time". Action rounds use the rest of `captchaAttemptBudgetMs` (45 s). `SolveChallengeOptions.detectBudgetMs` is optional; absent, it equals `budgetMs`, so the helper's `browser_solve_captcha` and `browser:captcha-check` are unchanged.
- **Inline threshold.** A tool call attempts inline only with at least `captchaDetectBudgetMs + captchaRerunReserveMs` left; otherwise it answers at once with the could-not-be-solved action and starts a background attempt. `captchaInlineMinRemainingMs` is retired; an old value is warned about as an unknown key and ignored.
- **Captcha-limited.** An attempt that did not act on the check (`kind: "unknown"` with no round, `available: false`, or no solver) is captcha-limited: the call answers at once with `access_denied`, still blocked, with message and action "<site> is captcha-limited: its bot check cannot be solved automatically. Open <url> in Aside, solve it, then retry". No re-run, no background attempt. The log line is `captcha-limited`; the search outcome log carries that word, never the sentence, which names a URL.
- **Otherwise unchanged.** `none` → re-run; a kind the solver can act on → actions, then re-run; acted and then `unknown` → re-run, then the could-not-be-solved action if still blocked; any other attempt failure → the could-not-be-solved action (with the solver's detail when it has one).
- **Check now**: light check → quick attempt → a second light check only when the attempt acted, met a kind it can act on, or found `none`; captcha-limited → the first result stands with the sentence as the site's last failure. Scheduled checks still never attempt.
- **Nothing is remembered per site.** Each blocked call makes its own quick attempt.

## Alternatives

- **Remember a captcha-limited site and make its later attempts background-only for a period** (the candidate in the 2026-10-08 finding): the quick attempt already costs at most the detection budget, a remembered state could hide a check that has become solvable, and it would add per-site state with its own expiry and reset rules.
- **Skip attempts for known vendors such as DataDome**: the vendor alone does not say whether the check is a slider in the vendor's frame or something the solver can act on.
- **Keep re-running after `unknown`**: the re-run meets the same check; it only doubled the cost for the user.
- **Add the vendor hosts to the site's `extraAllowedHosts` so the in-page request goes through**: every page of the site could then talk to those hosts, and the check would still not be solved.

## Consequences

- A DataDome check now answers within the detection budget plus the slot wait (a few seconds when detection finishes early) instead of about a minute, and tells the user to solve it in Aside. This has not been observed live yet.
- A check that needs more than 20 s to show its widget is reported captcha-limited; `captchaDetectBudgetMs` can be raised.
- A site whose bot check interrupts an in-page API call now gets the challenge path (attempt, captcha action) instead of counting toward `degraded` through `adapter_error`.
- The helper sees "<site> answered with a bot check (<host>)" for such a page script and can call `browser_solve_captcha`; it no longer sees a host outside the site's hostnames that it might be tempted to declare.
