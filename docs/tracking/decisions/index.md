# Decisions

| #    | Decision                                                                                                                      | Status                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0001 | [ChatGPT-compatible `search`/`fetch` plus typed tools for Claude](0001-chatgpt-compatible-and-typed-tools.md)                 | accepted                                            |
| 0002 | [Inline query qualifiers instead of JSON in the query string](0002-inline-query-qualifiers.md)                                | accepted                                            |
| 0003 | [Reject URLs of unregistered sites instead of a generic reader](0003-reject-unregistered-site-urls.md)                        | accepted                                            |
| 0004 | [Built-in OAuth 2.1 behind tunnels instead of an unauthenticated secret URL](0004-built-in-oauth-behind-tunnels.md)           | accepted                                            |
| 0005 | [Site adapters as validated code modules instead of declarative configs](0005-code-module-adapters.md)                        | accepted                                            |
| 0006 | [One long-lived `aside mcp` child with IIFE-wrapped scripts](0006-single-aside-child-with-iife-scripts.md)                    | accepted                                            |
| 0007 | [Run from source under tsx instead of a compiled build](0007-run-from-source-under-tsx.md)                                    | accepted                                            |
| 0008 | [Adapters committed to git, with bridge auto-commit](0008-adapters-in-git-with-auto-commit.md)                                | accepted                                            |
| 0009 | [Onboarding agent on the local Claude Code login by default](0009-onboarding-agent-on-claude-code-login.md)                   | accepted; extended by 0012                          |
| 0010 | [`requiresLogin` marks reads, and only flagged blocks start a cool-down](0010-login-flags-and-cooldown-policy.md)             | accepted; superseded in part by 0015 (cool-down)    |
| 0011 | [Setup-only mode and in-process core restart instead of refusing to start](0011-setup-only-mode-and-in-process-restart.md)    | accepted                                            |
| 0012 | [Site-add helper on Claude or Codex, on the user's subscription](0012-helper-on-claude-or-codex-subscriptions.md)             | accepted                                            |
| 0013 | [Reuters as the reference adapter; Hacker News removed; the Naver adapter kept private](0013-reuters-as-reference-adapter.md) | accepted                                            |
| 0014 | [Automatic captcha attempts with a fixed vendor-host list](0014-captcha-attempts-and-vendor-hosts.md)                         | accepted; superseded in part by 0016 (budget)       |
| 0015 | [A per-site browser pool, and no cool-down after a block page](0015-per-site-pool-and-no-block-cooldown.md)                   | accepted; supersedes 0010 in part                   |
| 0016 | [One quick captcha attempt per blocked call; "captcha-limited"](0016-quick-captcha-attempt-and-captcha-limited.md)            | accepted; supersedes 0014 in part; extended by 0017 |
| 0017 | [The Aside AI passes bot checks and logs in again, on by default](0017-aside-ai-passes-checks-and-logs-in.md)                 | accepted; extends 0014 and 0016                     |
