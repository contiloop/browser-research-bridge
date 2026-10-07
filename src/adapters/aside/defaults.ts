/**
 * Browser execution tunables. Names follow `config/bridge.example.json` → `tunables`;
 * the app layer passes configured values in, these are the built-in fallbacks.
 */
export const DEFAULT_ASIDE_ACCOUNT = "u0";

/** At most this many sites run browser work at the same time (`maxConcurrentSites`). */
export const DEFAULT_MAX_CONCURRENT_SITES = 4;

/** Per-tool-call budget (`toolCallBudgetMs`), under Claude's 240 s tool limit. */
export const DEFAULT_TOOL_CALL_BUDGET_MS = 90_000;

/** Per adapter step (`adapterStepTimeoutMs`); the Aside REPL caps one call at 120 s. */
export const DEFAULT_STEP_TIMEOUT_MS = 120_000;

/** The REPL aborts a call at 120 s; the in-REPL deadline stays a little below that. */
export const REPL_CALL_CAP_MS = 115_000;

/** Site left alone after a detected block/captcha/throttle (`coolDownSeconds` = 600). */
export const DEFAULT_COOL_DOWN_MS = 600_000;

/** A per-site tab may be kept warm this long after a task ends (`warmTabTtlSeconds` = 300). */
export const DEFAULT_WARM_TAB_TTL_MS = 300_000;

/** Aside resets the REPL context after 30 minutes idle (`replIdleTimeoutMs` in its startup event). */
export const DEFAULT_REPL_IDLE_RESET_MS = 1_800_000;

/** Re-handshake this long before the idle reset would hit, so a call never races the reset. */
export const DEFAULT_REPL_IDLE_MARGIN_MS = 60_000;

/** MCP handshake timeout when (re)starting `aside mcp`. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
