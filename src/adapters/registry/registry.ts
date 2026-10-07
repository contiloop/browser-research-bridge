/**
 * Site registry (port: src/ports/registry.ts). `data/sites.json` is the list of
 * registered sites; `sites/<key>/` holds each adapter. The registry:
 *
 * - reconciles both at startup (`init`): a loadable folder with no state entry is registered as
 *   `active` with no last check (checked at the next health run); a state entry whose folder is
 *   missing is dropped; a serving site whose folder is no longer loadable becomes `failed`; an
 *   `onboarding` site whose folder became loadable (crash after the swap) becomes `active`;
 *   half-written folders without state are ignored and never loaded;
 * - enforces hostname ownership (a hostname belongs to at most one site) for Add and promotion;
 * - owns adapter loading and hot reload (`load`, `reload`; version-stamped dynamic import);
 * - applies lifecycle transitions (src/core/lifecycle.ts) for live outcomes and health checks and
 *   carries out their effects (cache clear, scheduler cool-down).
 *
 * All state mutations are serialized; `list`/`get`/`findByHostname` read an in-memory snapshot.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isServingStatus, newSiteState, transitionSite } from "../../core/lifecycle.js";
import type { LifecycleEvent, SiteRuntimeState } from "../../core/lifecycle.js";
import type { Outcome, SiteCapabilities } from "../../core/models.js";
import { OutcomeError } from "../../core/outcome.js";
import { deriveSiteKey, isValidSiteKey, uniqueSiteKey } from "../../core/site-key.js";
import { hostnameKey, parseHttpUrl } from "../../core/url.js";
import type { Cache } from "../../ports/cache.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteManifest, SiteManifestSchemaOptions } from "../../ports/manifest.js";
import type { LiveOutcome, LoadedSiteAdapter, RegisteredSite, SiteRegistry } from "../../ports/registry.js";
import type { Scheduler } from "../../ports/scheduler.js";
import type { SiteStateStore } from "../../ports/site-store.js";
import { SerialQueue } from "../storage/json-file.js";
import { PREVIOUS_DIR, STAGING_DIR, inspectSiteFolder, scanSiteFolders } from "./folders.js";
import type { SiteFolderInfo } from "./folders.js";
import type { AdapterModuleLoader } from "./loader.js";

const NO_CAPABILITIES: SiteCapabilities = {
  search: false,
  read: false,
  dateFilter: false,
  pagination: false,
};
const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A registered site as the registry reports it (a superset of the port's {@link RegisteredSite}). */
export interface RegistrySite extends RegisteredSite {
  lastLoginConfirmedAt: string | null;
  provisionalHostnames: string[];
  consecutiveAdapterErrors: number;
  /** Why the folder is not loadable (null when loadable or not yet written). */
  folderProblem: string | null;
  /** A staged adapter exists (`sites/<key>/.staging/`). */
  hasStaging: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReconcileReport {
  /** Loadable folders without state, registered as `active` (fresh clone). */
  registered: string[];
  /** State entries whose folder is missing. */
  dropped: string[];
  /** Serving sites whose folder is no longer loadable, now `failed`. */
  failed: string[];
  /** `onboarding` sites whose folder is loadable, now `active`. */
  activated: string[];
  /** Folders ignored (half-written, no state, or hostname taken by another site). */
  ignored: { key: string; reason: string }[];
}

export type HostnameCheck =
  { ok: true; hostname: string } | { ok: false; hostname: string; key: string; message: string };

/** Where cool-downs go (the scheduler); `cooldownUntil` prevents extending a running one. */
export type CooldownTarget = Pick<Scheduler, "setCooldown"> & Partial<Pick<Scheduler, "cooldownUntil">>;

export interface SiteRegistryOptions {
  /** Absolute path of `sites/`. */
  sitesDir: string;
  stateStore: SiteStateStore;
  loader: AdapterModuleLoader;
  cache?: Cache | undefined;
  /** Receives cool-downs after `rate_limited` / blocked pages. */
  scheduler?: CooldownTarget | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
  /** `consecutiveAdapterErrorsToDegrade` (default 3). */
  adapterErrorsToDegrade?: number | undefined;
  /** Cool-down length (default 10 minutes). */
  coolDownMs?: number | undefined;
  manifestOptions?: SiteManifestSchemaOptions | undefined;
}

interface Entry {
  state: SiteRuntimeState;
  folder: SiteFolderInfo | null;
  generation: number;
  loading: Promise<LoadedSiteAdapter> | null;
}

export class SiteRegistryService implements SiteRegistry {
  readonly sitesDir: string;
  private readonly store: SiteStateStore;
  private readonly loader: AdapterModuleLoader;
  private readonly cache: Cache | undefined;
  private readonly scheduler: CooldownTarget | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly errorsToDegrade: number | undefined;
  private readonly coolDownMs: number;
  private readonly manifestOptions: SiteManifestSchemaOptions | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new SerialQueue();
  private initialized = false;

  constructor(options: SiteRegistryOptions) {
    this.sitesDir = resolve(options.sitesDir);
    this.store = options.stateStore;
    this.loader = options.loader;
    this.cache = options.cache;
    this.scheduler = options.scheduler;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.errorsToDegrade = options.adapterErrorsToDegrade;
    this.coolDownMs = options.coolDownMs ?? 600_000;
    this.manifestOptions = options.manifestOptions;
  }

  siteDir(key: string): string {
    return join(this.sitesDir, key);
  }

  stagingDir(key: string): string {
    return join(this.sitesDir, key, STAGING_DIR);
  }

  previousDir(key: string): string {
    return join(this.sitesDir, key, PREVIOUS_DIR);
  }

  /** Startup reconciliation of `data/sites.json` with `sites/`. Idempotent. */
  init(): Promise<ReconcileReport> {
    return this.queue.run(async () => {
      const report: ReconcileReport = { registered: [], dropped: [], failed: [], activated: [], ignored: [] };
      const at = this.nowIso();
      const states = await this.store.load();
      const folders = new Map(
        (await scanSiteFolders(this.sitesDir, this.manifestOptions)).map((f) => [f.key, f]),
      );
      this.entries.clear();

      for (const state of states) {
        const folder = folders.get(state.key) ?? null;
        if (folder === null) {
          report.dropped.push(state.key);
          this.logger.warn("site state dropped: adapter folder is missing", { site: state.key });
          continue;
        }
        let next = state;
        if (folder.loadable && state.status === "onboarding") {
          next = transitionSite(state, { type: "promoted", at }).state;
          next = { ...next, lastCheckedAt: null };
          report.activated.push(state.key);
        } else if (!folder.loadable && isServingStatus(state.status)) {
          next = this.apply(state, {
            type: "folder_incomplete",
            reason: `adapter folder is incomplete: ${folder.reason ?? "not loadable"}`,
            at,
          });
          report.failed.push(state.key);
        }
        this.entries.set(state.key, { state: next, folder, generation: 0, loading: null });
      }

      for (const folder of folders.values()) {
        if (this.entries.has(folder.key)) continue;
        if (!folder.loadable || folder.manifest === null) {
          report.ignored.push({ key: folder.key, reason: folder.reason ?? "not loadable" });
          this.logger.info("adapter folder ignored (not loadable, not registered)", {
            site: folder.key,
            reason: folder.reason,
          });
          continue;
        }
        const clash = folder.manifest.hostnames
          .map((h) => this.ownerOf(h))
          .find((owner): owner is string => owner !== null && owner !== folder.key);
        if (clash !== undefined) {
          const reason = `a hostname of ${folder.key} is already registered as ${clash}`;
          report.ignored.push({ key: folder.key, reason });
          this.logger.warn("adapter folder ignored", { site: folder.key, reason });
          continue;
        }
        const state = newSiteState({ key: folder.key, status: "active", at });
        this.entries.set(folder.key, { state, folder, generation: 0, loading: null });
        report.registered.push(folder.key);
      }

      await this.persist();
      this.initialized = true;
      return report;
    });
  }

  list(): readonly RegistrySite[] {
    return [...this.entries.values()]
      .map((e) => this.view(e))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  get(key: string): RegistrySite | undefined {
    const e = this.entries.get(key);
    return e ? this.view(e) : undefined;
  }

  findByHostname(hostname: string): RegistrySite | undefined {
    const key = this.ownerOf(hostname, false);
    return key === null ? undefined : this.get(key);
  }

  /** The key of the site that owns `hostname` (manifest hostnames, and provisional ones during Add). */
  hostnameOwner(hostname: string): string | null {
    return this.ownerOf(hostname);
  }

  /** The manifest of a site's live folder, if any. */
  manifestOf(key: string): SiteManifest | null {
    return this.entries.get(key)?.folder?.manifest ?? null;
  }

  /**
   * Add rule: a URL/hostname whose hostname already belongs to a registered site is
   * rejected with "already registered as <key>; use Repair or Remove".
   */
  checkAddHostname(urlOrHostname: string): HostnameCheck {
    const hostname = toHostname(urlOrHostname);
    const owner = this.ownerOf(hostname);
    if (owner !== null) {
      return {
        ok: false,
        hostname,
        key: owner,
        message: `already registered as ${owner}; use Repair or Remove`,
      };
    }
    return { ok: true, hostname };
  }

  /**
   * Registers a new site as `onboarding` (Add): checks hostname ownership, derives the provisional
   * key unless one is given, records the provisional hostnames, and creates `sites/<key>/`.
   * Throws `OutcomeError("unsupported", …)` on a duplicate hostname or key.
   */
  registerOnboarding(input: {
    hostnames: readonly string[];
    key?: string | undefined;
  }): Promise<RegistrySite> {
    return this.queue.run(async () => {
      const hostnames = [...new Set(input.hostnames.map(toHostname))].filter((h) => h !== "");
      if (hostnames.length === 0) throw new OutcomeError("unsupported", "a hostname is required");
      for (const h of hostnames) {
        const owner = this.ownerOf(h);
        if (owner !== null)
          throw new OutcomeError("unsupported", `already registered as ${owner}; use Repair or Remove`);
      }
      const taken = (k: string): boolean => this.entries.has(k);
      let key: string;
      if (input.key !== undefined) {
        if (!isValidSiteKey(input.key))
          throw new OutcomeError("unsupported", `invalid site key: ${input.key}`);
        if (taken(input.key))
          throw new OutcomeError("unsupported", `site key already registered: ${input.key}`);
        key = input.key;
      } else {
        // A derived key also skips unregistered folders that already hold files (e.g. a
        // hand-written adapter in progress), so an Add never adopts someone else's folder.
        const occupied = await this.occupiedFolders();
        key = uniqueSiteKey(deriveSiteKey(hostnames[0] ?? ""), (k) => taken(k) || occupied.has(k));
      }
      await mkdir(this.siteDir(key), { recursive: true });
      const state = newSiteState({
        key,
        status: "onboarding",
        at: this.nowIso(),
        provisionalHostnames: hostnames,
      });
      const folder = await inspectSiteFolder(this.sitesDir, key, this.manifestOptions);
      this.entries.set(key, { state, folder, generation: 0, loading: null });
      await this.persist();
      return this.view(this.entries.get(key) as Entry);
    });
  }

  /** Retry of a `failed` site: back to `onboarding` (a Repair keeps the status and needs no call). */
  markOnboarding(key: string): Promise<RegistrySite> {
    return this.event(key, { type: "onboarding_started", at: this.nowIso() });
  }

  /** The onboarding job failed for good: `failed` with the reason (no-op unless `onboarding`). */
  markOnboardingFailed(key: string, reason: string): Promise<RegistrySite> {
    return this.event(key, { type: "onboarding_failed", reason, at: this.nowIso() });
  }

  /**
   * After a swap: re-reads the folder, re-imports the adapter (hot reload), and marks the
   * site `active`. Throws when the new folder is not loadable or the import fails; the state is then
   * left unchanged so the caller can roll back.
   */
  markPromoted(key: string): Promise<RegistrySite> {
    return this.queue.run(async () => {
      const entry = this.require(key);
      const folder = await inspectSiteFolder(this.sitesDir, key, this.manifestOptions);
      if (folder === null || !folder.loadable || folder.manifest === null) {
        throw new OutcomeError(
          "adapter_error",
          `promoted folder is not loadable: ${folder?.reason ?? "missing"}`,
        );
      }
      const generation = entry.generation + 1;
      const loaded = await this.importLoaded(key, folder, generation);
      entry.folder = folder;
      entry.generation = generation;
      entry.loading = Promise.resolve(loaded);
      entry.state = transitionSite(
        entry.state,
        { type: "promoted", at: this.nowIso() },
        this.lifecycleOptions(),
      ).state;
      await this.persist();
      return this.view(entry);
    });
  }

  /** Re-reads the site's folder after an external change (e.g. a rollback) and drops the loaded module. */
  refreshFolder(key: string): Promise<RegistrySite | undefined> {
    return this.queue.run(async () => {
      const entry = this.entries.get(key);
      if (!entry) return undefined;
      entry.folder = await inspectSiteFolder(this.sitesDir, key, this.manifestOptions);
      entry.generation += 1;
      entry.loading = null;
      return this.view(entry);
    });
  }

  /** Removes the site's runtime state, its loaded adapter, and its cache entries (Remove). */
  unregister(key: string): Promise<boolean> {
    return this.queue.run(async () => {
      const existed = this.entries.delete(key);
      if (existed) await this.persist();
      await this.cache?.clearSite(key);
      return existed;
    });
  }

  async load(key: string): Promise<LoadedSiteAdapter | undefined> {
    const entry = this.entries.get(key);
    if (!entry || !this.isLoadable(entry) || entry.folder === null) return undefined;
    if (entry.loading === null) {
      const folder = entry.folder;
      const generation = entry.generation;
      const loading = this.importLoaded(key, folder, generation);
      entry.loading = loading;
      loading.catch(() => {
        if (entry.loading === loading) entry.loading = null;
      });
    }
    return entry.loading;
  }

  /** Re-imports the site's adapter from its live folder (the only hot-reload path). */
  reload(key: string): Promise<void> {
    return this.queue.run(async () => {
      const entry = this.entries.get(key);
      if (!entry) return;
      entry.folder = await inspectSiteFolder(this.sitesDir, key, this.manifestOptions);
      entry.generation += 1;
      entry.loading = null;
      if (entry.folder?.loadable && this.isLoadable(entry)) {
        const loaded = this.importLoaded(key, entry.folder, entry.generation);
        entry.loading = loaded;
        await loaded.catch((error: unknown) => {
          entry.loading = null;
          throw error;
        });
      }
    });
  }

  async recordOutcome(key: string, outcome: LiveOutcome): Promise<void> {
    if (!this.entries.has(key)) return;
    await this.event(key, {
      type: "live_outcome",
      outcome: {
        status: outcome.status,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      },
      blocked: outcome.blocked,
      at: this.nowIso(),
    });
  }

  /** Applies a health-check result. */
  recordHealthCheck(key: string, outcome: Outcome): Promise<RegistrySite> {
    return this.event(key, { type: "health_check", outcome, at: this.nowIso() });
  }

  private lifecycleOptions(): { adapterErrorsToDegrade?: number } {
    return this.errorsToDegrade === undefined ? {} : { adapterErrorsToDegrade: this.errorsToDegrade };
  }

  private apply(state: SiteRuntimeState, event: LifecycleEvent): SiteRuntimeState {
    return transitionSite(state, event, this.lifecycleOptions()).state;
  }

  private event(key: string, event: LifecycleEvent): Promise<RegistrySite> {
    return this.queue.run(async () => {
      const entry = this.require(key);
      const t = transitionSite(entry.state, event, this.lifecycleOptions());
      if (t.changed) {
        if (t.state.status !== entry.state.status) {
          this.logger.info("site status changed", {
            site: key,
            from: entry.state.status,
            to: t.state.status,
            cause: event.type,
          });
        }
        entry.state = t.state;
        await this.persist();
      }
      if (t.effects.clearCache) await this.cache?.clearSite(key);
      // A call refused because the site is already cooling down reports rate_limited too; it must
      // not extend the running cool-down, or a busy site would never leave it.
      if (t.effects.coolDown && this.scheduler && (this.scheduler.cooldownUntil?.(key) ?? null) === null) {
        this.scheduler.setCooldown(key, this.clock.now().getTime() + this.coolDownMs);
      }
      return this.view(entry);
    });
  }

  private async importLoaded(
    key: string,
    folder: SiteFolderInfo,
    generation: number,
  ): Promise<LoadedSiteAdapter> {
    const manifest = folder.manifest;
    if (manifest === null) throw new OutcomeError("adapter_error", `site ${key} has no manifest`);
    const version = `${(folder.validation?.adapterHash ?? "nohash").slice(0, 12)}-${generation}`;
    try {
      const adapter = await this.loader.importAdapter({ key, dir: folder.dir, liveDir: folder.dir, version });
      this.logger.info("adapter loaded", { site: key, version });
      return { key, manifest, adapter, version };
    } catch (error) {
      this.logger.error("adapter failed to load", { site: key, error: (error as Error).message });
      throw new OutcomeError(
        "adapter_error",
        `cannot load the ${key} adapter: ${(error as Error).message}`,
        undefined,
        {
          cause: error,
        },
      );
    }
  }

  private isLoadable(entry: Entry): boolean {
    return entry.folder !== null && entry.folder.loadable && isServingStatus(entry.state.status);
  }

  private require(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry) throw new OutcomeError("unsupported", `site not registered: ${key}`);
    return entry;
  }

  /** Ownership hostnames: the live manifest's, else the provisional ones. */
  private owned(entry: Entry): readonly string[] {
    return entry.folder?.manifest?.hostnames ?? entry.state.provisionalHostnames;
  }

  private ownerOf(hostname: string, includeProvisional = true): string | null {
    const wanted = hostnameKey(hostname);
    if (wanted === "") return null;
    for (const [key, entry] of [...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const hosts = includeProvisional
        ? [...this.owned(entry), ...entry.state.provisionalHostnames]
        : this.owned(entry);
      if (hosts.some((h) => hostnameKey(h) === wanted)) return key;
    }
    return null;
  }

  private view(entry: Entry): RegistrySite {
    const { state, folder } = entry;
    const manifest = folder?.manifest ?? null;
    return {
      key: state.key,
      status: state.status,
      hostnames: [...this.owned(entry)],
      loginUrl: manifest?.loginUrl ?? null,
      lastFailure: state.lastFailure,
      capabilities: manifest ? { ...manifest.capabilities } : { ...NO_CAPABILITIES },
      name: manifest?.name ?? state.key,
      requiresLogin: manifest?.requiresLogin ?? false,
      lastCheckedAt: state.lastCheckedAt,
      loadable: this.isLoadable(entry),
      lastLoginConfirmedAt: state.lastLoginConfirmedAt,
      provisionalHostnames: [...state.provisionalHostnames],
      consecutiveAdapterErrors: state.consecutiveAdapterErrors,
      folderProblem: folder === null ? "adapter folder is missing" : folder.reason,
      hasStaging: folder?.hasStaging ?? false,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  /** Unregistered `sites/<key>/` folders with any entry in them. */
  private async occupiedFolders(): Promise<Set<string>> {
    const out = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.sitesDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!isValidSiteKey(name) || this.entries.has(name)) continue;
      try {
        if ((await readdir(join(this.sitesDir, name))).length > 0) out.add(name);
      } catch {
        // not a directory
      }
    }
    return out;
  }

  private async persist(): Promise<void> {
    await this.store.save([...this.entries.values()].map((e) => e.state));
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  /** True once `init` has run. */
  get ready(): boolean {
    return this.initialized;
  }
}

/** Hostname of a URL or bare hostname, lowercased (no network). */
export function toHostname(urlOrHostname: string): string {
  const s = urlOrHostname.trim();
  const u = parseHttpUrl(s) ?? parseHttpUrl(`https://${s}`);
  return (u?.hostname ?? s).toLowerCase().replace(/\.$/, "");
}
