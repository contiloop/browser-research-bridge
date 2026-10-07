/**
 * Adapter module loader: dynamic `import()` of `sites/<key>/adapter.ts` with a version
 * query so a reload after a swap evaluates the new code without a restart (Repair).
 *
 * - Layer 1 first: the static check runs on the folder before any of its code is imported.
 * - Entry resolution: when the bridge runs compiled (`dist/…`) and `dist/sites/<key>/adapter.js`
 *   exists and is at least as new as `adapter.ts`, the compiled file is imported; otherwise the
 *   TypeScript source (under tsx, or Node's built-in type stripping; adapters have no runtime imports
 *   other than `src/adapter-kit`).
 * - A staged adapter (`sites/<key>/.staging/`) is evaluated as it will run once promoted: its
 *   relative imports that leave the folder (into `src/adapter-kit`) are resolved from the live
 *   location, through a temporary rewritten copy inside `.staging/` that is removed after import.
 * - The default export must provide `search`, `read`, and `smokeTest` functions.
 */
import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SiteAdapter } from "../../ports/adapter.js";
import { ADAPTER_FILE } from "../validation/report.js";
import {
  defaultStaticCheckPaths,
  describeStaticViolations,
  rewriteImportsForLiveLocation,
  staticCheckAdapterDir,
} from "../validation/static-check.js";
import type { StaticCheckResult } from "../validation/static-check.js";

export interface ImportAdapterInput {
  key: string;
  /** Folder holding the files now (live folder or its `.staging/`). */
  dir: string;
  /** The live folder `sites/<key>/`. */
  liveDir: string;
  /** Version stamp appended as a query; a new value forces re-evaluation. */
  version: string;
}

export interface AdapterModuleLoader {
  /** Static-checks the folder, then imports and shape-checks its adapter. Throws on any failure. */
  importAdapter(input: ImportAdapterInput): Promise<SiteAdapter>;
}

export class AdapterLoadError extends Error {
  override name = "AdapterLoadError";
  constructor(
    message: string,
    readonly staticResult?: StaticCheckResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Checks the module's default export against the adapter contract. */
export function assertSiteAdapter(mod: unknown): SiteAdapter {
  const candidate = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : undefined;
  if (typeof candidate !== "object" || candidate === null) {
    throw new AdapterLoadError("adapter.ts must default-export an object");
  }
  const a = candidate as Record<string, unknown>;
  for (const fn of ["search", "read", "smokeTest"] as const) {
    if (typeof a[fn] !== "function")
      throw new AdapterLoadError(`the adapter's default export has no ${fn}() function`);
  }
  for (const fn of ["canonicalize", "checkCompleteness"] as const) {
    if (a[fn] !== undefined && typeof a[fn] !== "function") {
      throw new AdapterLoadError(`the adapter's ${fn} must be a function when present`);
    }
  }
  return candidate as SiteAdapter;
}

export interface ModuleAdapterLoaderOptions {
  /** Repository root (holds `src/adapter-kit`). */
  repoRoot: string;
  /** Compiled output root (default `<repoRoot>/dist`). */
  distDir?: string | undefined;
  /** Prefer compiled adapters; default: true when this module itself runs from `dist/`. */
  preferCompiled?: boolean | undefined;
}

function runningCompiled(): boolean {
  return fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export class ModuleAdapterLoader implements AdapterModuleLoader {
  private readonly repoRoot: string;
  private readonly distDir: string;
  private readonly preferCompiled: boolean;

  constructor(options: ModuleAdapterLoaderOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.distDir = resolve(options.distDir ?? join(this.repoRoot, "dist"));
    this.preferCompiled = options.preferCompiled ?? runningCompiled();
  }

  async importAdapter(input: ImportAdapterInput): Promise<SiteAdapter> {
    const dir = resolve(input.dir);
    const liveDir = resolve(input.liveDir);
    const staticResult = await staticCheckAdapterDir(defaultStaticCheckPaths(this.repoRoot, dir, liveDir));
    if (!staticResult.ok) {
      throw new AdapterLoadError(
        `static check failed: ${describeStaticViolations(staticResult.violations)}`,
        staticResult,
      );
    }
    const query = `?v=${encodeURIComponent(input.version)}`;
    let mod: unknown;
    try {
      if (dir === liveDir) {
        mod = await import(/* @vite-ignore */ `${await this.entryUrl(liveDir)}${query}`);
      } else {
        mod = await this.importStaged(dir, liveDir, query);
      }
    } catch (error) {
      throw new AdapterLoadError(
        `cannot import the adapter of ${input.key}: ${(error as Error).message}`,
        staticResult,
        {
          cause: error,
        },
      );
    }
    return assertSiteAdapter(mod);
  }

  private async entryUrl(liveDir: string): Promise<string> {
    const source = join(liveDir, ADAPTER_FILE);
    if (this.preferCompiled) {
      const compiled = join(this.distDir, relative(this.repoRoot, liveDir), "adapter.js");
      const [jsTime, tsTime] = await Promise.all([mtimeMs(compiled), mtimeMs(source)]);
      if (jsTime !== null && (tsTime === null || jsTime >= tsTime)) return pathToFileURL(compiled).href;
    }
    return pathToFileURL(source).href;
  }

  private async importStaged(dir: string, liveDir: string, query: string): Promise<unknown> {
    const source = await readFile(join(dir, ADAPTER_FILE), "utf8");
    const rewritten = await rewriteImportsForLiveLocation(source, ADAPTER_FILE, dir, liveDir);
    if (rewritten === source) {
      return import(/* @vite-ignore */ `${pathToFileURL(join(dir, ADAPTER_FILE)).href}${query}`);
    }
    const shadow = join(dir, `.load-${randomBytes(6).toString("hex")}.ts`);
    await writeFile(shadow, rewritten, { mode: 0o600 });
    try {
      return await import(/* @vite-ignore */ `${pathToFileURL(shadow).href}${query}`);
    } finally {
      await rm(shadow, { force: true });
    }
  }
}
