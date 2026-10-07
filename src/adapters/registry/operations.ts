/**
 * Swap and removal of adapter folders (onboarding, Repair, Remove, commits). The onboarding job
 * runner calls these; nothing outside `sites/<key>/` and `data/` is touched.
 *
 * `promoteStaging(key)`: requires a passed full validation of `.staging/` whose recorded hash still
 * matches the staged files, a valid manifest for this key whose hostnames no other site owns, and a
 * clean static check. Then: the current live files move to `.previous/` (one generation; the older
 * generation is discarded only after success), the staged files move live, and the registry
 * re-imports the adapter (hot reload) and marks the site `active`. Any failure restores the live
 * folder, `.previous/`, and `.staging/` as they were. On success `sites/<key>/` is committed as
 * `site: add <key>` (no live adapter before) or `site: repair <key>`.
 *
 * `removeSite(key)`: cancels a running job through the caller's hook, deletes `sites/<key>/`
 * (including `.staging/` and `.previous/`), the runtime state, the cache entries, and the
 * scheduler cool-down, then commits `site: remove <key>`.
 */
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isValidSiteKey } from "../../core/site-key.js";
import type { Logger } from "../../ports/logger.js";
import type { Scheduler } from "../../ports/scheduler.js";
import type { SiteCommitAction, SiteCommitResult, SiteCommitter } from "../../ports/site-store.js";
import {
  ADAPTER_FILE,
  MANIFEST_FILE,
  computeAdapterHash,
  readValidationReport,
} from "../validation/report.js";
import {
  defaultStaticCheckPaths,
  describeStaticViolations,
  staticCheckAdapterDir,
} from "../validation/static-check.js";
import { PREVIOUS_DIR, STAGING_DIR, readManifest } from "./folders.js";
import type { SiteRegistryService } from "./registry.js";

/** Holds the generation that `.previous/` had before a swap, inside the git-ignored staging dir. */
const OLD_PREVIOUS = ".bridge-previous-old";
const RESERVED = new Set([STAGING_DIR, PREVIOUS_DIR]);

export interface SiteOperationsDeps {
  registry: SiteRegistryService;
  /** Repository root (holds `src/adapter-kit`), for the static check. */
  repoRoot: string;
  committer?: SiteCommitter | undefined;
  /** Remove ends the site's cool-down, so a site re-added under the same key starts fresh. */
  scheduler?: Pick<Scheduler, "clearCooldown"> | undefined;
  logger?: Logger | undefined;
}

export type PromoteResult =
  | { ok: true; key: string; action: "add" | "repair"; commit: SiteCommitResult }
  | { ok: false; key: string; reason: string };

export interface RemoveOptions {
  /** Cancels any running onboarding/repair job of the site (supplied by the job runner). */
  cancelJob?: ((key: string) => Promise<void> | void) | undefined;
}

export type RemoveResult =
  { ok: true; key: string; commit: SiteCommitResult } | { ok: false; key: string; reason: string };

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function moveAll(from: string, to: string, names: readonly string[], moved: string[]): Promise<void> {
  for (const name of names) {
    await rename(join(from, name), join(to, name));
    moved.push(name);
  }
}

/** Checks that `.staging/` holds a validated, unchanged, well-formed adapter for `key`. */
async function checkStaging(deps: SiteOperationsDeps, key: string): Promise<string | null> {
  const { registry } = deps;
  const staging = registry.stagingDir(key);
  if (!(await isDir(staging))) return "nothing staged";
  const report = await readValidationReport(staging);
  if (report === null) return "the staged adapter has no validation.json";
  if (!report.passed || report.form !== "full") return "the staged adapter has not passed full validation";
  if (report.key !== key) return `validation.json is for "${report.key}", not "${key}"`;
  const hash = await computeAdapterHash(staging);
  if (hash === null || report.adapterHash !== hash) {
    return "the staged files changed after validation; validate again";
  }
  const { manifest, error } = await readManifest(staging);
  if (manifest === null) return error ?? "invalid manifest.json";
  if (manifest.key !== key) return `manifest key "${manifest.key}" does not match the site "${key}"`;
  for (const h of manifest.hostnames) {
    const owner = registry.hostnameOwner(h);
    if (owner !== null && owner !== key) return `hostname ${h} is already registered as ${owner}`;
  }
  const names = await listEntries(staging);
  if (!names.includes(ADAPTER_FILE) || !names.includes(MANIFEST_FILE))
    return "adapter.ts or manifest.json missing";
  const reserved = names.find((n) => RESERVED.has(n) || n === OLD_PREVIOUS);
  if (reserved !== undefined) return `the staging folder must not contain ${reserved}`;
  const check = await staticCheckAdapterDir(
    defaultStaticCheckPaths(deps.repoRoot, staging, registry.siteDir(key)),
  );
  if (!check.ok) return `static check failed: ${describeStaticViolations(check.violations)}`;
  return null;
}

export async function promoteStaging(
  deps: SiteOperationsDeps,
  key: string,
  options: { action?: "add" | "repair" | undefined } = {},
): Promise<PromoteResult> {
  const { registry, logger } = deps;
  if (!isValidSiteKey(key) || registry.get(key) === undefined) {
    return { ok: false, key, reason: `site not registered: ${key}` };
  }
  const problem = await checkStaging(deps, key);
  if (problem !== null) {
    logger?.warn("promotion refused", { site: key, reason: problem });
    return { ok: false, key, reason: problem };
  }

  const live = registry.siteDir(key);
  const staging = registry.stagingDir(key);
  const previous = registry.previousDir(key);
  const oldPrevious = join(staging, OLD_PREVIOUS);
  const liveNames = (await listEntries(live)).filter((n) => !RESERVED.has(n));
  const stagedNames = await listEntries(staging);
  const hadLive = liveNames.includes(ADAPTER_FILE) || liveNames.includes(MANIFEST_FILE);
  const action = options.action ?? (hadLive ? "repair" : "add");

  const movedToPrevious: string[] = [];
  const movedLive: string[] = [];
  let previousParked = false;
  let previousCreated = false;
  try {
    if (await isDir(previous)) {
      await rename(previous, oldPrevious);
      previousParked = true;
    }
    if (liveNames.length > 0) {
      await mkdir(previous);
      previousCreated = true;
      await moveAll(live, previous, liveNames, movedToPrevious);
    }
    await moveAll(staging, live, stagedNames, movedLive);
    await registry.markPromoted(key);
  } catch (error) {
    const reason = (error as Error).message;
    logger?.error("promotion failed; restoring the live adapter", { site: key, reason });
    try {
      await mkdir(staging, { recursive: true });
      for (const name of movedLive.reverse()) await rename(join(live, name), join(staging, name));
      for (const name of movedToPrevious.reverse()) await rename(join(previous, name), join(live, name));
      if (previousCreated) await rm(previous, { recursive: true, force: true });
      if (previousParked) await rename(oldPrevious, previous);
    } catch (restoreError) {
      logger?.error("restoring after a failed promotion failed", {
        site: key,
        error: (restoreError as Error).message,
      });
    }
    await registry.refreshFolder(key);
    return { ok: false, key, reason };
  }

  await rm(staging, { recursive: true, force: true });
  logger?.info("staged adapter promoted", { site: key, action });
  const commit = await commitOrSkip(deps, key, action);
  return { ok: true, key, action, commit };
}

export async function removeSite(
  deps: SiteOperationsDeps,
  key: string,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  const { registry, logger } = deps;
  if (!isValidSiteKey(key)) return { ok: false, key, reason: `invalid site key: ${key}` };
  const dir = registry.siteDir(key);
  if (registry.get(key) === undefined && !(await isDir(dir))) {
    return { ok: false, key, reason: `site not registered: ${key}` };
  }
  if (options.cancelJob) await options.cancelJob(key);
  // Folder first: if the process stops halfway, the orphaned state entry is dropped at startup.
  await rm(dir, { recursive: true, force: true });
  await registry.unregister(key);
  deps.scheduler?.clearCooldown(key);
  logger?.info("site removed", { site: key });
  const commit = await commitOrSkip(deps, key, "remove");
  return { ok: true, key, commit };
}

async function commitOrSkip(
  deps: SiteOperationsDeps,
  key: string,
  action: SiteCommitAction,
): Promise<SiteCommitResult> {
  if (!deps.committer) return { committed: false, reason: "disabled" };
  return deps.committer.commitSite(key, action);
}
