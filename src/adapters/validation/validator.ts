/**
 * Runs site validation against the real site: reads the folder (live or `.staging/`),
 * checks the manifest and hostname ownership, runs the static check before importing any adapter
 * code, imports the adapter, and drives the validation core through the scheduler and the browser
 * port. The full form writes `validation.json` into the validated folder; the light form (health
 * check) only returns its report, so a failed health check never makes a site unloadable.
 */
import { join } from "node:path";
import { isValidSiteKey } from "../../core/site-key.js";
import type { Clock } from "../../ports/clock.js";
import { systemClock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteManifestSchemaOptions } from "../../ports/manifest.js";
import type { LoadedSiteAdapter } from "../../ports/registry.js";
import { STAGING_DIR, readManifest } from "../registry/folders.js";
import type { AdapterModuleLoader } from "../registry/loader.js";
import { browserHostnames, runAdapterTask } from "../registry/site-task.js";
import type { AdapterRuntime } from "../registry/site-task.js";
import {
  computeAdapterHash,
  readValidationReport,
  summarizeReport,
  writeValidationReport,
} from "./report.js";
import type { ValidationReport } from "./report.js";
import { defaultStaticCheckPaths, describeStaticViolations, staticCheckAdapterDir } from "./static-check.js";
import { preImportFailure, runValidation } from "./validate.js";
import type { AnonymousFetcher, ValidationRunner } from "./validate.js";

export interface SiteValidatorOptions {
  /** Absolute path of `sites/`. */
  sitesDir: string;
  /** Repository root (holds `src/adapter-kit`). */
  repoRoot: string;
  loader: AdapterModuleLoader;
  runtime: AdapterRuntime;
  /** Logged-out fetch for step d; see ./anonymous-fetch.ts. */
  anonymousFetch?: AnonymousFetcher | undefined;
  /** Live adapter lookup for the light form (the registry's `load`); default: import the live folder. */
  loadLive?: ((key: string) => Promise<LoadedSiteAdapter | undefined>) | undefined;
  /** Which registered site owns a hostname (the registry's `hostnameOwner`); null = free. */
  hostnameOwner?: ((hostname: string) => string | null) | undefined;
  manifestOptions?: SiteManifestSchemaOptions | undefined;
  smokeBudgetMs?: number | undefined;
  stepBudgetMs?: number | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
}

export interface FullValidationOptions {
  /** Validate `sites/<key>/.staging/` instead of the live folder. */
  staging?: boolean | undefined;
  /** Write `validation.json` into the validated folder (default true). */
  write?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Run even while the site cools down after a block or throttling (default false: the browser
   * steps fail `rate_limited` until the cool-down ends). Pass it only for runs a person asked for
   * or that gate a promotion: the `site:validate` CLI and the onboarding service's own validation
   * before promoting a staged adapter. The agent's `run_validation` honors the cool-down.
   */
  ignoreCooldown?: boolean | undefined;
}

export interface LightValidationOptions {
  signal?: AbortSignal | undefined;
  /** Run even while the site cools down (user-initiated "Check now"). */
  ignoreCooldown?: boolean | undefined;
}

export class SiteValidator {
  private readonly clock: Clock;

  constructor(private readonly options: SiteValidatorOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Full form (onboarding/repair, CLI): steps a–d plus the adapter's smoke test. */
  async full(key: string, opts: FullValidationOptions = {}): Promise<ValidationReport> {
    const target = opts.staging === true ? "staging" : "live";
    if (!isValidSiteKey(key)) {
      const message = `invalid site key: ${key}`;
      return preImportFailure({ key, form: "full", target, step: "manifest", message, at: this.clock.now() });
    }
    const liveDir = join(this.options.sitesDir, key);
    const dir = target === "staging" ? join(liveDir, STAGING_DIR) : liveDir;
    const report = await this.fullIn(key, dir, liveDir, target, opts.signal, opts.ignoreCooldown === true);
    if (opts.write !== false) {
      // A failed re-validation of a live adapter does not erase its passed record: the site stays
      // loadable and the lifecycle (health check → degraded/needs_login) reports the failure.
      const existing = target === "live" && !report.passed ? await readValidationReport(dir) : null;
      if (existing?.passed === true) {
        this.options.logger?.warn("live validation failed; keeping the previous passed validation.json", {
          site: key,
        });
      } else {
        await writeValidationReport(dir, report);
      }
    }
    this.options.logger?.info("site validation finished", {
      site: key,
      form: "full",
      target,
      passed: report.passed,
      summary: summarizeReport(report),
    });
    return report;
  }

  /** Light form (health check): sample search with limit 3 and the sample read, within 60 s. */
  async light(key: string, opts: LightValidationOptions = {}): Promise<ValidationReport> {
    const at = this.clock.now();
    if (!isValidSiteKey(key)) {
      return preImportFailure({
        key,
        form: "light",
        target: "live",
        step: "load",
        message: `invalid site key: ${key}`,
        at,
      });
    }
    let loaded: LoadedSiteAdapter | undefined;
    try {
      loaded = this.options.loadLive ? await this.options.loadLive(key) : await this.importLive(key);
    } catch (error) {
      return preImportFailure({
        key,
        form: "light",
        target: "live",
        step: "load",
        message: (error as Error).message,
        at,
      });
    }
    if (!loaded) {
      return preImportFailure({
        key,
        form: "light",
        target: "live",
        step: "load",
        message: "the site is not loadable",
        at,
      });
    }
    const site = { key, manifest: loaded.manifest };
    const runner: ValidationRunner = {
      step: (_label, budgetMs, fn) =>
        runAdapterTask(
          this.options.runtime,
          site,
          { holder: "health check", budgetMs, signal: opts.signal, ignoreCooldown: opts.ignoreCooldown },
          fn,
        ),
    };
    return runValidation({
      form: "light",
      key,
      target: "live",
      manifest: loaded.manifest,
      adapter: loaded.adapter,
      runner,
      clock: this.clock,
      smokeBudgetMs: this.options.smokeBudgetMs,
      stepBudgetMs: this.options.stepBudgetMs,
      browserHosts: browserHostnames(loaded.manifest),
    });
  }

  private async importLive(key: string): Promise<LoadedSiteAdapter | undefined> {
    const dir = join(this.options.sitesDir, key);
    const { manifest, error } = await readManifest(dir, this.options.manifestOptions);
    if (manifest === null) throw new Error(error ?? "manifest.json is missing");
    const adapter = await this.options.loader.importAdapter({
      key,
      dir,
      liveDir: dir,
      version: `light-${this.clock.now().getTime()}`,
    });
    return { key, manifest, adapter, version: "light" };
  }

  private async fullIn(
    key: string,
    dir: string,
    liveDir: string,
    target: "live" | "staging",
    signal: AbortSignal | undefined,
    ignoreCooldown: boolean,
  ): Promise<ValidationReport> {
    const at = this.clock.now();
    const adapterHash = await computeAdapterHash(dir);
    const fail = (step: "manifest" | "static" | "load", message: string, manifestVersion?: number) =>
      preImportFailure({ key, form: "full", target, step, message, at, adapterHash, manifestVersion });

    const { manifest, error } = await readManifest(dir, this.options.manifestOptions);
    if (manifest === null) return fail("manifest", error ?? "manifest.json is missing");
    if (manifest.key !== key)
      return fail(
        "manifest",
        `manifest key "${manifest.key}" does not match the site "${key}"`,
        manifest.version,
      );
    for (const h of manifest.hostnames) {
      const owner = this.options.hostnameOwner?.(h) ?? null;
      if (owner !== null && owner !== key) {
        return fail("manifest", `hostname ${h} is already registered as ${owner}`, manifest.version);
      }
    }

    const staticResult = await staticCheckAdapterDir(
      defaultStaticCheckPaths(this.options.repoRoot, dir, liveDir),
    );
    if (!staticResult.ok) {
      return fail(
        "static",
        `static check failed: ${describeStaticViolations(staticResult.violations)}`,
        manifest.version,
      );
    }

    let adapter;
    try {
      adapter = await this.options.loader.importAdapter({
        key,
        dir,
        liveDir,
        version: `validate-${(adapterHash ?? "x").slice(0, 12)}-${at.getTime()}`,
      });
    } catch (error) {
      return fail("load", (error as Error).message, manifest.version);
    }

    const site = { key, manifest };
    const runner: ValidationRunner = {
      step: (_label, budgetMs, fn) =>
        runAdapterTask(
          this.options.runtime,
          site,
          { holder: "validation", budgetMs, signal, ignoreCooldown },
          fn,
        ),
    };
    return runValidation({
      form: "full",
      key,
      target,
      manifest,
      adapter,
      runner,
      staticResult,
      anonymousFetch: this.options.anonymousFetch,
      adapterHash,
      clock: this.clock,
      smokeBudgetMs: this.options.smokeBudgetMs,
      stepBudgetMs: this.options.stepBudgetMs,
      browserHosts: browserHostnames(manifest),
    });
  }
}
