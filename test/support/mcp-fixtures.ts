/**
 * In-memory world for the MCP tool tests: real registry (temp `sites/` folders, real lifecycle,
 * real file cache), real scheduler and `runAdapterTask`, a fake browser port (sessions only), and
 * in-memory adapters supplied through a fake module loader. No site behavior is real.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createAdapterHelpers } from "../../src/adapter-kit/helpers.js";
import type { AdapterModuleLoader, ImportAdapterInput } from "../../src/adapters/registry/loader.js";
import { SiteRegistryService } from "../../src/adapters/registry/registry.js";
import { runAdapterTask } from "../../src/adapters/registry/site-task.js";
import { InMemoryScheduler } from "../../src/adapters/aside/scheduler.js";
import { FileCache } from "../../src/adapters/storage/cache-store.js";
import { ResultCache } from "../../src/adapters/storage/result-cache.js";
import { FileSiteStateStore } from "../../src/adapters/storage/site-state-store.js";
import { ReadService } from "../../src/adapters/mcp/read-service.js";
import { SearchService } from "../../src/adapters/mcp/search-service.js";
import type { SiteTaskRunner, ToolServiceDeps, ToolTunables } from "../../src/adapters/mcp/deps.js";
import type {
  AdapterContext,
  AdapterDocument,
  AdapterHelpers,
  AdapterReadResponse,
  AdapterSearchItem,
  AdapterSearchRequest,
  AdapterSearchResponse,
  SiteAdapter,
} from "../../src/ports/adapter.js";
import type { DocumentRef } from "../../src/core/models.js";
import { MemoryLogger } from "./oauth-harness.js";
import { fakeBrowser, makeTempDir, manifestFor, writeAdapterFolder } from "./site-fixtures.js";
import type { FakeBrowser } from "./site-fixtures.js";

/** The real helpers with date parsing and text extraction stubbed out (test adapters do not need them). */
export const stubHelpers: AdapterHelpers = {
  ...createAdapterHelpers(),
  parseDate: () => null,
  extractText: (html) => html,
};

export interface AdapterCalls {
  search: AdapterSearchRequest[];
  read: DocumentRef[];
}

export interface FakeSiteSpec {
  key: string;
  /** Manifest fields to override (see `manifestFor`). */
  manifest?: Record<string, unknown>;
  search?: ((req: AdapterSearchRequest, ctx: AdapterContext) => Promise<unknown>) | undefined;
  read?: ((ref: DocumentRef, ctx: AdapterContext) => Promise<unknown>) | undefined;
  canonicalize?: ((url: string) => string) | undefined;
}

export class FakeLoader implements AdapterModuleLoader {
  readonly adapters = new Map<string, SiteAdapter>();
  async importAdapter(input: ImportAdapterInput): Promise<SiteAdapter> {
    const adapter = this.adapters.get(input.key);
    if (!adapter) throw new Error(`no fake adapter for ${input.key}`);
    return adapter;
  }
}

export interface McpWorld {
  dir: string;
  sitesDir: string;
  registry: SiteRegistryService;
  scheduler: InMemoryScheduler;
  browser: FakeBrowser;
  fileCache: FileCache;
  cache: ResultCache;
  logger: MemoryLogger;
  calls: Map<string, AdapterCalls>;
  deps: ToolServiceDeps;
  search: SearchService;
  read: ReadService;
  /** Adapter call counts for a site. */
  count(key: string): { search: number; read: number };
  cleanup(): Promise<void>;
}

export interface WorldOptions {
  sites: FakeSiteSpec[];
  tunables?: Partial<ToolTunables>;
  /** Disable the result cache (default: enabled). */
  noCache?: boolean;
}

export async function makeMcpWorld(options: WorldOptions): Promise<McpWorld> {
  const tmp = await makeTempDir("brb-mcp-");
  const sitesDir = join(tmp.dir, "sites");
  await mkdir(sitesDir, { recursive: true });
  const loader = new FakeLoader();
  const calls = new Map<string, AdapterCalls>();
  for (const spec of options.sites) {
    await writeAdapterFolder(join(sitesDir, spec.key), spec.key, {
      manifest: manifestFor(spec.key, spec.manifest ?? {}),
    });
    const record: AdapterCalls = { search: [], read: [] };
    calls.set(spec.key, record);
    const adapter: SiteAdapter = {
      search: async (req, ctx) => {
        record.search.push(req);
        if (!spec.search) return { results: [], nextCursor: null, status: "empty" };
        return (await spec.search(req, ctx)) as AdapterSearchResponse;
      },
      read: async (ref, ctx) => {
        record.read.push(ref);
        if (!spec.read) return { status: "unsupported", message: "no read in this fake" };
        return (await spec.read(ref, ctx)) as AdapterReadResponse;
      },
      smokeTest: async () => ({ status: "ok" }),
      ...(spec.canonicalize ? { canonicalize: spec.canonicalize } : {}),
    };
    loader.adapters.set(spec.key, adapter);
  }

  const logger = new MemoryLogger();
  const scheduler = new InMemoryScheduler({ maxConcurrentSites: 4 });
  const fileCache = new FileCache(join(tmp.dir, "data", "cache"));
  const cache = new ResultCache(fileCache);
  const registry = new SiteRegistryService({
    sitesDir,
    stateStore: new FileSiteStateStore(join(tmp.dir, "data", "sites.json")),
    loader,
    cache: fileCache,
    scheduler,
    logger,
  });
  await registry.init();
  const browser = fakeBrowser();
  const runtime = { browser, scheduler, helpers: stubHelpers, logger };
  const runSiteTask: SiteTaskRunner = (site, taskOptions, task) =>
    runAdapterTask(runtime, site, taskOptions, task);
  const deps: ToolServiceDeps = {
    registry,
    runSiteTask,
    cache: options.noCache ? null : cache,
    tunables: options.tunables,
    logger,
  };
  return {
    dir: tmp.dir,
    sitesDir,
    registry,
    scheduler,
    browser,
    fileCache,
    cache,
    logger,
    calls,
    deps,
    search: new SearchService(deps),
    read: new ReadService(deps),
    count: (key) => ({ search: calls.get(key)?.search.length ?? 0, read: calls.get(key)?.read.length ?? 0 }),
    cleanup: tmp.cleanup,
  };
}

/** A search item on `<key>.example.com` published on `day` (YYYY-MM-DD) or undated. */
export function item(
  key: string,
  n: number | string,
  day: string | null,
  extra: Partial<AdapterSearchItem> = {},
): AdapterSearchItem {
  return {
    localId: `${n}`,
    title: `${key} article ${n}`,
    url: `https://${key}.example.com/articles/${n}`,
    publishedAt: day === null ? null : `${day}T09:00:00+00:00`,
    datePrecision: day === null ? null : "minute",
    excerpt: `excerpt ${n}`,
    author: null,
    ...extra,
  };
}

export function ok(results: AdapterSearchItem[], nextCursor: string | null = null): AdapterSearchResponse {
  return { results, nextCursor, status: results.length > 0 ? "ok" : "empty" };
}

/** Paragraph text of at least `chars` characters, each paragraph tagged with `marker`. */
export function longText(chars: number, marker = "Paragraph"): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const p = `${marker} ${i}: ${"lorem ipsum dolor sit amet ".repeat(8).trim()}.`;
    parts.push(p);
    length += p.length + 2;
  }
  return parts.join("\n\n");
}

export function documentFor(
  key: string,
  localId: string,
  text: string,
  extra: Partial<AdapterDocument> = {},
): AdapterDocument {
  return {
    localId,
    title: `${key} document ${localId}`,
    url: `https://${key}.example.com/articles/${localId}`,
    publishedAt: "2026-10-01T09:00:00+00:00",
    datePrecision: "minute",
    author: "A. Writer",
    text,
    accessLevel: "subscriber",
    metadata: { section: "world" },
    ...extra,
  };
}

/** Moves a site to `needs_login` / `degraded` through the health-check path. */
export async function setNeedsLogin(world: McpWorld, key: string): Promise<void> {
  await world.registry.recordHealthCheck(key, { status: "auth_required", message: "login wall" });
}

export async function setDegraded(world: McpWorld, key: string, message = "selector broke"): Promise<void> {
  await world.registry.recordHealthCheck(key, { status: "adapter_error", message });
}

/** Registers an `onboarding` site (and optionally fails it). */
export async function addOnboarding(world: McpWorld, key: string, failReason?: string): Promise<void> {
  await world.registry.registerOnboarding({ hostnames: [`${key}.example.org`], key });
  if (failReason !== undefined) await world.registry.markOnboardingFailed(key, failReason);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}
