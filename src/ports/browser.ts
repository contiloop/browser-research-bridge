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

export interface BrowserPort {
  status(): Promise<BrowserStatus>;
  openSession(scope: BrowserScope): Promise<BrowserSession>;
  /** Closes bridge-owned tabs and stops the child process. */
  shutdown(): Promise<void>;
}
