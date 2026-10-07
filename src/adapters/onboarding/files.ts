/**
 * The onboarding agent's only file access (agent-written adapters are untrusted until validated):
 *
 * - {@link StagingFiles}: read/write of exactly `manifest.json`, `adapter.ts`, `NOTES.md` inside
 *   `sites/<key>/.staging/` (plus reading the staged `validation.json`). Any other name, any path
 *   segment, a symlinked folder, or an oversized file is rejected. `manifest.json` must be JSON whose
 *   `key` is the job's key.
 * - {@link ReferenceLibrary}: read-only access to an allowlist of reference documents (authoring
 *   docs, the reference adapter, the adapter kit, the port types) and, for a repair, the site's own
 *   live files. Paths are looked up in a fixed map, never resolved from agent input.
 */
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { writeFileAtomic } from "../storage/json-file.js";

export const STAGING_WRITABLE = ["manifest.json", "adapter.ts", "NOTES.md"] as const;
export const STAGING_READABLE = [...STAGING_WRITABLE, "validation.json"] as const;
export const MAX_STAGING_FILE_BYTES = 300_000;
export const MAX_REFERENCE_CHARS = 200_000;

export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

/** `./adapter.ts` → `adapter.ts`; anything with a directory part, `..`, or odd characters → null. */
function plainName(input: string): string | null {
  const s = input.trim().replace(/^\.\//, "");
  if (s === "" || s.includes("/") || s.includes("\\") || s.includes("\0") || s === "." || s === "..")
    return null;
  return s;
}

async function assertRealDirectory(path: string, what: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    throw new FileAccessError(`${what} does not exist`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new FileAccessError(`${what} is not a plain folder`);
}

export interface StagingFilesOptions {
  /** `sites/<key>/` (absolute). */
  siteDir: string;
  /** `sites/<key>/.staging/` (absolute). */
  stagingDir: string;
  key: string;
}

export class StagingFiles {
  constructor(private readonly options: StagingFilesOptions) {}

  get dir(): string {
    return this.options.stagingDir;
  }

  /** Creates `.staging/` when missing (never through a symlink). */
  async ensure(): Promise<void> {
    await assertRealDirectory(this.options.siteDir, `sites/${this.options.key}/`);
    await mkdir(this.options.stagingDir, { recursive: true });
    await assertRealDirectory(this.options.stagingDir, `sites/${this.options.key}/.staging/`);
  }

  private resolve(name: string, allowed: readonly string[]): string {
    const plain = plainName(name);
    if (plain === null || !allowed.includes(plain)) {
      throw new FileAccessError(
        `"${name}" is not allowed; only ${allowed.join(", ")} inside sites/${this.options.key}/.staging/`,
      );
    }
    return join(this.options.stagingDir, plain);
  }

  /**
   * Writes one staged file. `proceed` is asked right before the file is written (after the folder
   * checks); when it returns false nothing is written (a job cancelled while the write was on its way).
   */
  async write(
    name: string,
    content: string,
    options: { proceed?: (() => boolean) | undefined } = {},
  ): Promise<{ path: string; bytes: number }> {
    const path = this.resolve(name, STAGING_WRITABLE);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_STAGING_FILE_BYTES)
      throw new FileAccessError(`file too large (${bytes} bytes; limit ${MAX_STAGING_FILE_BYTES})`);
    if (path.endsWith("manifest.json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new FileAccessError(`manifest.json is not valid JSON: ${(error as Error).message}`);
      }
      const key = (parsed as { key?: unknown } | null)?.key;
      if (key !== this.options.key) {
        throw new FileAccessError(`manifest.json "key" must be "${this.options.key}" (the job's site key)`);
      }
    }
    await this.ensure();
    if (options.proceed !== undefined && !options.proceed()) {
      throw new FileAccessError("the job was cancelled; nothing was written");
    }
    await writeFileAtomic(path, content);
    return { path: `sites/${this.options.key}/.staging/${relative(this.options.stagingDir, path)}`, bytes };
  }

  async read(name: string): Promise<string | null> {
    const path = this.resolve(name, STAGING_READABLE);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || !st.isFile()) throw new FileAccessError(`${name} is not a plain file`);
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

export interface ReferenceLibraryOptions {
  repoRoot: string;
  sitesDir: string;
  /** The reference adapter's key (default `reuters`). */
  referenceSite?: string | undefined;
  /** For a repair: the site whose live files may be read too. */
  repairSite?: string | null | undefined;
}

const FIXED_DOCS = [
  "docs/ADAPTERS.md",
  "docs/BROWSER.md",
  "src/ports/adapter.ts",
  "src/ports/manifest.ts",
  "src/ports/browser.ts",
  "src/core/models.ts",
] as const;
const SITE_FILES = ["manifest.json", "adapter.ts", "NOTES.md", "validation.json"] as const;

export class ReferenceLibrary {
  private readonly repoRoot: string;
  private readonly sitesDir: string;
  private readonly referenceSite: string;
  private readonly repairSite: string | null;

  constructor(options: ReferenceLibraryOptions) {
    this.repoRoot = options.repoRoot;
    this.sitesDir = options.sitesDir;
    this.referenceSite = options.referenceSite ?? "reuters";
    this.repairSite = options.repairSite ?? null;
  }

  /** Logical path (as the agent names it) → absolute path. Computed fresh on each call. */
  async allowlist(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const p of FIXED_DOCS) map.set(p, join(this.repoRoot, ...p.split("/")));
    for (const f of SITE_FILES) {
      map.set(`sites/${this.referenceSite}/${f}`, join(this.sitesDir, this.referenceSite, f));
    }
    try {
      const kitDir = join(this.repoRoot, "src", "adapter-kit");
      for (const name of (await readdir(kitDir)).sort()) {
        if (name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(name)) {
          map.set(`src/adapter-kit/${name}`, join(kitDir, name));
        }
      }
    } catch {
      // no kit folder: nothing to add
    }
    if (this.repairSite !== null) {
      for (const f of SITE_FILES) {
        map.set(`sites/${this.repairSite}/${f}`, join(this.sitesDir, this.repairSite, f));
      }
    }
    return map;
  }

  async read(path: string): Promise<{ path: string; text: string; truncated: boolean }> {
    const logical = path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
    const map = await this.allowlist();
    const abs = map.get(logical);
    if (abs === undefined) {
      throw new FileAccessError(
        `"${path}" is not an allowed reference. Allowed: ${[...map.keys()].join(", ")}`,
      );
    }
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new FileAccessError(`${logical} does not exist`);
    }
    const roots = [await realpath(this.repoRoot), await realpath(this.sitesDir).catch(() => this.sitesDir)];
    if (!roots.some((r) => real === r || real.startsWith(r + sep))) {
      throw new FileAccessError(`${logical} resolves outside the project`);
    }
    const text = await readFile(real, "utf8");
    const truncated = text.length > MAX_REFERENCE_CHARS;
    return { path: logical, text: truncated ? text.slice(0, MAX_REFERENCE_CHARS) : text, truncated };
  }
}
