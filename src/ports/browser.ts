/**
 * Browser port. The only implementation today is the Aside REPL adapter.
 *
 * Every session is scoped to one site's declared hostnames (or the onboarding agent's provisional
 * set). The implementation enforces the page-script shim: scripts are statically scanned,
 * run with `fs`/`aside`/`require`/`process`/`exec`/`memory_search` shadowed, and `fetch`/`openTab`/
 * navigations/requests outside the scope's hostnames are blocked.
 *
 * Failures are thrown as `OutcomeError` (src/core/outcome.ts): `browser_unavailable` when Aside is not
 * reachable (action "run `aside login`" when the CLI login expired), `timeout` when a step exceeds its
 * budget, `adapter_error` for a shim violation (the violation is logged).
 *
 * `solveChallenge` is the only port operation that is not reachable from adapters (they get a
 * `BrowserSession`); it is called by bridge code after an adapter reported a block page.
 */
import type { JsonValue } from "./json.js";
import type { SiteLease } from "./scheduler.js";

export interface BrowserScope {
  siteKey: string;
  /** Hostnames the session may open, fetch, navigate to, or request. */
  hostnames: readonly string[];
  /** Aborts in-flight steps when the tool-call budget is spent or the job is cancelled. */
  signal?: AbortSignal | undefined;
  /**
   * The scheduler lease the session runs under. When given, every page load (opening a tab,
   * `page.goto`/`reload`/`goBack`/`goForward` inside a page script, cookie fetch) honors the site's
   * politeness interval through it.
   */
  lease?: SiteLease | undefined;
}

export interface TabHandle {
  readonly id: string;
  /** URL at the time the tab was opened. */
  readonly url: string;
}

export interface OpenTabOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | undefined;
  timeoutMs?: number | undefined;
}

export interface PageScriptOptions {
  /** Tab whose page the script drives; omitted → the session's default tab. */
  tab?: TabHandle | undefined;
  /** JSON arguments available to the script. */
  args?: JsonValue | undefined;
  /** Human-readable title shown in the Aside REPL log. */
  title?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface SnapshotOptions {
  maxChars?: number | undefined;
}

export interface CookieFetchInit {
  method?: "GET" | "POST" | "HEAD" | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface CookieFetchResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  headers: Record<string, string>;
  text: string;
}

export interface Screenshot {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
}

/** What an adapter (via `ctx.browser`) or the onboarding agent can do in the browser. */
export interface BrowserSession {
  readonly scope: Readonly<BrowserScope>;
  /** Opens a bridge-owned tab (never attaches to the user's tabs); waits for the site's politeness interval. */
  openTab(url: string, options?: OpenTabOptions): Promise<TabHandle>;
  closeTab(tab: TabHandle): Promise<void>;
  /** Text/accessibility snapshot of the tab's current page. */
  snapshot(tab: TabHandle, options?: SnapshotOptions): Promise<string>;
  /** Runs a page script through the shim; resolves with the script's JSON result (validate it). */
  runScript(script: string, options?: PageScriptOptions): Promise<unknown>;
  /** Cookie-bearing fetch from the browser context, restricted to the scope's hostnames. */
  fetch(url: string, init?: CookieFetchInit): Promise<CookieFetchResponse>;
  screenshot(tab: TabHandle): Promise<Screenshot>;
  /**
   * The main-frame URL, on the scope's hostnames, that this session's tabs last showed after a step
   * (opening a tab, a page script, a snapshot); null before any. A cookie fetch does not change it.
   * The bridge aims a challenge attempt after a blocked search at it (the site's search page).
   */
  lastUrl(): string | null;
  /** Closes the tabs this session opened (a warm tab may be retained by the port). */
  dispose(): Promise<void>;
}

export interface BrowserStatus {
  reachable: boolean;
  /** Aside account in use (default `u0`). */
  account: string;
  message?: string | undefined;
  action?: string | undefined;
}

/** `none`: no challenge is visible; `unknown`: a challenge or block page the solver cannot act on. */
export type ChallengeKind = "checkbox" | "slider" | "text" | "none" | "unknown";

/** Result of one challenge attempt. */
export interface ChallengeAttempt {
  /**
   * An action was performed and the page then no longer showed a recognized widget or block marker.
   * It is not proof: the caller confirms by re-running the adapter call.
   */
  solved: boolean;
  kind: ChallengeKind;
  /** Action rounds performed (at most 2). */
  rounds: number;
  /**
   * Human-readable summary from a fixed set of texts (e.g. "text captcha: no vision model is
   * configured in Aside"), never page content; callers may show and log it.
   */
  message: string;
  /** False when the browser has no captcha capability (older Aside). */
  available: boolean;
}

export interface SolveChallengeOptions {
  /** The site's scope; the attempt holds its lease's politeness like any step. */
  scope: BrowserScope;
  /** The tab the adapter met the challenge in; used when it is still open, on-site, and in this scope. */
  tab?: TabHandle | undefined;
  /**
   * The challenge URL (on the scope's hostnames); opened in a session tab when `tab` is not usable.
   * Live calls pass the failed read's URL, else the adapter session's last page (`lastUrl()`), else
   * the site's homepage.
   */
  url: string;
  /** Time budget for detection plus at most two action rounds. */
  budgetMs: number;
  /**
   * Detection budget, clipped to `budgetMs`; absent → `budgetMs`. It starts when the attempt starts
   * and covers the politeness wait, the widened reload, the interstitial wait, and the first
   * detection. When it expires before that detection finished, the attempt ends with `kind:
   * "unknown"`, `rounds: 0`, message "detection did not finish in time". Action rounds after a
   * detection use the rest of `budgetMs`.
   */
  detectBudgetMs?: number | undefined;
}

export interface BrowserPort {
  status(): Promise<BrowserStatus>;
  openSession(scope: BrowserScope): Promise<BrowserSession>;
  /**
   * One bounded challenge attempt with the bridge's own solver (privileged bridge code, not an adapter
   * script). While it runs, the tab may also reach the fixed captcha vendor hosts; afterwards its filter
   * and guard are restored. Throws `OutcomeError` only for setup failures (`adapter_error` for a URL
   * outside the scope, `browser_unavailable`); a spent budget is an unsolved result.
   * Optional so in-memory test ports need not implement it; a port without it cannot solve challenges.
   */
  solveChallenge?(options: SolveChallengeOptions): Promise<ChallengeAttempt>;
  /** Closes bridge-owned tabs and stops the child process. */
  shutdown(): Promise<void>;
}
