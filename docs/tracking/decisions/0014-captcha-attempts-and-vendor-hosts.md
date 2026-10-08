# 0014 — Automatic captcha attempts with a fixed vendor-host list

## Context

Reuters sits behind DataDome, and other login sites show reCAPTCHA, hCaptcha, Turnstile, or GeeTest checks. Until now a captcha paused the helper with "Open <url> in Aside, solve the captcha, then click Retry" and made a live search or read fail with `access_denied`, plus a 10-minute cool-down of the site. The owner asked for automatic captcha handling (status list item 1, 2026-10-07). Aside exposes a `captcha` global in its REPL realm (`click`, `drag`, `readText`; `readText` sends a cropped screenshot to the "visual" model configured in Aside). It detects nothing. A bridge tab blocks every host outside the site's scope, so a vendor's widget frame cannot even load in it.

## Decision

- The browser port gets one optional operation, `solveChallenge({ scope, tab?, url, budgetMs })`: one bounded attempt by privileged bridge code, never reachable from adapters or page scripts (`captcha` stays shadowed for them). Detection is the bridge's own fixed table, run in the main frame from an isolated world; actions are `captcha.click` (checkbox), `captcha.drag` (main-frame slider), and `captcha.readText` plus typing and submitting (text captcha); at most 2 rounds within the budget.
- While the attempt runs, and only on its tab, the request filter and guard CSP also allow `CAPTCHA_VENDOR_HOSTS`, a list fixed in code (`captcha-delivery.com`, reCAPTCHA's paths on `google.com`/`gstatic.com`, `hcaptcha.com`, `challenges.cloudflare.com`, `geetest.com`). The guard init scripts are replaced by their identifiers (`__brbInit`) and the page is reloaded, then everything is restored; a tab that cannot be restored is closed.
- `solved` is never proof. The caller re-runs the adapter call once, and only an `ok` or `empty` re-run counts.
- Attempts happen in live tool calls (inline when enough of the 90-second budget remains, else in the background; one attempt per site at a time, shared by callers), in "Check now" (light check → attempt → light check again), and through the helper's new tool `browser_solve_captcha`. Scheduled health checks and validation never attempt. `rate_limited` pages get no attempt.
- A setting `captcha.auto` (default on, Settings → Captchas) turns all of it off. When an attempt fails, the user gets "The captcha could not be solved automatically. Open <url> in Aside, solve it, then retry".

## Alternatives

- **Let adapters or the helper's page scripts solve captchas**: that would hand the `captcha` capability and vendor hosts to agent-written code and break the shim's guarantees.
- **Allow the vendor hosts on every tab, or declare them per site in `extraAllowedHosts`**: every page of every site could then talk to those hosts at all times, and a manifest would gain hosts it does not need for its content.
- **Trust the solver's own success signal**: the page can look clear while the site still refuses; only the adapter's own completeness check is reliable.
- **Keep asking the user every time**: the status quo the owner asked to change.

## Consequences

- During an attempt the tab, including the site's own scripts on it, can reach the vendor hosts; this is a deliberate, time-boxed widening listed in `docs/security.md`.
- For text captchas the cropped captcha picture goes to the vision model configured in Aside; the settings page says so next to the switch.
- A slider inside a cross-origin frame (DataDome on Reuters) cannot be seen and is reported `unknown`; the user still solves it by hand. This needs live confirmation.
- The helper's tool list grew by one, so the Codex evidence of the model-visible tool list must be captured again.
- The vendor list changes only in code, with tests; never from a manifest, page, tool argument, or setting.
