/**
 * Adapter folders on disk: `sites/<key>/` with `manifest.json`, `adapter.ts`,
 * `validation.json`, `NOTES.md`, plus the git-ignored `.staging/` and `.previous/`. A folder is
 * loadable only when its manifest parses (with `key` equal to the folder name), `adapter.ts` exists,
 * and `validation.json` records a passed full validation. Half-written folders are never loaded.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isValidSiteKey } from "../../core/site-key.js";
import { parseSiteManifest } from "../../ports/manifest.js";
import type { SiteManifest, SiteManifestSchemaOptions } from "../../ports/manifest.js";
import { readJsonFile } from "../storage/json-file.js";
import { ADAPTER_FILE, MANIFEST_FILE, readValidationReport } from "../validation/report.js";
import type { ValidationReport } from "../validation/report.js";

export const STAGING_DIR = ".staging";
export const PREVIOUS_DIR = ".previous";

export interface SiteFolderInfo {
  key: string;
  dir: string;
  manifest: SiteManifest | null;
  /** Why the manifest is unusable (missing, invalid, key mismatch). */
  manifestError: string | null;
  validation: ValidationReport | null;
  hasAdapter: boolean;
  hasStaging: boolean;
  loadable: boolean;
  /** Why the folder is not loadable; null when loadable. */
  reason: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads and parses a folder's manifest; `{ manifest: null, error }` when missing or invalid. */
export async function readManifest(
  dir: string,
  options?: SiteManifestSchemaOptions,
): Promise<{ manifest: SiteManifest | null; error: string | null }> {
  let raw: unknown;
  try {
    raw = await readJsonFile(join(dir, MANIFEST_FILE));
  } catch (error) {
    return { manifest: null, error: (error as Error).message };
  }
  if (raw === undefined) return { manifest: null, error: "manifest.json is missing" };
  const parsed = parseSiteManifest(raw, options);
  return parsed.ok
    ? { manifest: parsed.manifest, error: null }
    : { manifest: null, error: `invalid manifest.json: ${parsed.error}` };
}

export async function inspectSiteFolder(
  sitesDir: string,
  key: string,
  options?: SiteManifestSchemaOptions,
): Promise<SiteFolderInfo | null> {
  const dir = join(sitesDir, key);
  try {
    if (!(await stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const { manifest: parsed, error } = await readManifest(dir, options);
  let manifest = parsed;
  let manifestError = error;
  if (manifest !== null && manifest.key !== key) {
    manifestError = `manifest key "${manifest.key}" does not match the folder name "${key}"`;
    manifest = null;
  }
  const validation = await readValidationReport(dir);
  const hasAdapter = await exists(join(dir, ADAPTER_FILE));
  const hasStaging = await exists(join(dir, STAGING_DIR));
  let reason: string | null = null;
  if (manifest === null) reason = manifestError ?? "manifest.json is missing";
  else if (!hasAdapter) reason = "adapter.ts is missing";
  else if (validation === null) reason = "validation.json is missing";
  else if (!validation.passed || validation.form !== "full") reason = "validation has not passed";
  return {
    key,
    dir,
    manifest,
    manifestError,
    validation,
    hasAdapter,
    hasStaging,
    loadable: reason === null,
    reason,
  };
}

/** Every `sites/<key>/` folder whose name is a valid site key, alphabetical. */
export async function scanSiteFolders(
  sitesDir: string,
  options?: SiteManifestSchemaOptions,
): Promise<SiteFolderInfo[]> {
  let entries;
  try {
    entries = await readdir(sitesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const keys = entries
    .filter((e) => e.isDirectory() && isValidSiteKey(e.name))
    .map((e) => e.name)
    .sort();
  const out: SiteFolderInfo[] = [];
  for (const key of keys) {
    const info = await inspectSiteFolder(sitesDir, key, options);
    if (info) out.push(info);
  }
  return out;
}
