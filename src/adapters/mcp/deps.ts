/**
 * What the MCP tool layer needs from the rest of the bridge, expressed as narrow ports so the
 * services can be wired to the real registry/scheduler/browser (composition root) or to in-memory
 * fakes (tests) without change.
 */
import type { OutcomeStatus } from "../../core/models.js";
import type { AdapterContext } from "../../ports/adapter.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteManifest } from "../../ports/manifest.js";
import type { SiteRegistry } from "../../ports/registry.js";

/** Registry surface used by the tools (implemented by `SiteRegistryService`). */
export type ToolRegistry = Pick<SiteRegistry, "list" | "get" | "load" | "recordOutcome">;

export interface SiteTaskOptions {
  /** Lock holder name for "site busy: <holder>" messages. */
  holder: string;
  /** Remaining tool-call budget (lock wait + task). */
  budgetMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Runs one adapter call under the site lock with a browser session scoped to the site
 * (`runAdapterTask` bound to the adapter runtime in the composition root).
 */
export type SiteTaskRunner = <T>(
  site: { key: string; manifest: SiteManifest },
  options: SiteTaskOptions,
  task: (ctx: AdapterContext) => Promise<T>,
) => Promise<T>;

/** The caching rules for search pages and documents (implemented by `ResultCache`). */
export interface ToolResultCache {
  getSearchPage<T>(key: string): Promise<T | undefined>;
  putSearchPage<T>(
    key: string,
    page: T,
    searched: readonly { site: string; status: OutcomeStatus }[],
    extraSites?: readonly string[],
  ): Promise<boolean>;
  getDocument<T>(key: string): Promise<T | undefined>;
  putDocument<T>(key: string, site: string, status: OutcomeStatus, document: T): Promise<boolean>;
  getPageChain(normalizedQuery: string, page: number): Promise<string | undefined>;
  putPageChain(
    normalizedQuery: string,
    page: number,
    cursor: string,
    sites: readonly string[],
  ): Promise<void>;
}

/** Tunables the tools use (names match `config/bridge.json` → `tunables`). */
export interface ToolTunables {
  searchDefaultLimit: number;
  searchMaxLimit: number;
  searchMaxPage: number;
  /** Per-tool-call budget (default 90 s). */
  toolCallBudgetMs: number;
  /** Document text cap before caching (default 100,000). */
  documentMaxChars: number;
  /** `fetch` text budget (default 60,000). */
  fetchTextMaxChars: number;
  /** `read_documents` total text budget (default 120,000). */
  readDocumentsTotalMaxChars: number;
  /** `read_documents` per-item floor (default 10,000). */
  readDocumentsMinCharsPerItem: number;
}

export const DEFAULT_TOOL_TUNABLES: Readonly<ToolTunables> = Object.freeze({
  searchDefaultLimit: 10,
  searchMaxLimit: 25,
  searchMaxPage: 10,
  toolCallBudgetMs: 90_000,
  documentMaxChars: 100_000,
  fetchTextMaxChars: 60_000,
  readDocumentsTotalMaxChars: 120_000,
  readDocumentsMinCharsPerItem: 10_000,
});

export interface ToolServiceDeps {
  registry: ToolRegistry;
  runSiteTask: SiteTaskRunner;
  /** Null disables caching. */
  cache: ToolResultCache | null;
  tunables?: Partial<ToolTunables> | undefined;
  logger: Logger;
  clock?: Clock | undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
