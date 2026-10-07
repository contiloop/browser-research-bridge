/**
 * Validation of a staged adapter for the onboarding job. The service — never the agent's
 * claim — decides whether a staged folder may be promoted:
 *
 * - `full(key)`: the real-site full validation of `sites/<key>/.staging/` (SiteValidator, writes
 *   `validation.json` into staging) plus a TypeScript type check of the staged `adapter.ts` as it
 *   will compile once live (so a promoted adapter never breaks `npm run typecheck`).
 * - `quick(key)`: manifest + hostname ownership + static check + type check, no browser; fast
 *   feedback while the agent writes files.
 * - `stagedPassed(key)`: whether the staged folder carries a passed full validation for exactly its
 *   current files (hash match) and type-checks; the precondition of the agent's `finish`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as TS from "typescript";
import type { SiteManifestSchemaOptions } from "../../ports/manifest.js";
import { STAGING_DIR, readManifest } from "../registry/folders.js";
import { ADAPTER_FILE, computeAdapterHash, readValidationReport } from "../validation/report.js";
import type { ValidationReport } from "../validation/report.js";
import {
  defaultStaticCheckPaths,
  describeStaticViolations,
  staticCheckAdapterDir,
} from "../validation/static-check.js";
import type { SiteValidator } from "../validation/validator.js";

export interface QuickCheckResult {
  ok: boolean;
  problems: string[];
}

export type StagedState = { ok: true } | { ok: false; reason: string };

/** What the job service and the agent's tools need from validation. */
export interface FullStagingOptions {
  /** Run despite the site's cool-down (the service's promotion gate); the agent's runs omit it. */
  ignoreCooldown?: boolean | undefined;
}

export interface StagingValidation {
  full(key: string, signal?: AbortSignal, options?: FullStagingOptions): Promise<ValidationReport>;
  quick(key: string): Promise<QuickCheckResult>;
  stagedPassed(key: string): Promise<StagedState>;
  typecheck(key: string): Promise<string[]>;
}

export interface SiteStagingValidationOptions {
  validator: Pick<SiteValidator, "full">;
  sitesDir: string;
  repoRoot: string;
  manifestOptions?: SiteManifestSchemaOptions | undefined;
  hostnameOwner?: ((hostname: string) => string | null) | undefined;
  /** Replaces the TypeScript check (tests); default {@link typecheckStagedAdapter}. */
  typechecker?: ((input: TypecheckInput) => Promise<string[]>) | undefined;
}

export class SiteStagingValidation implements StagingValidation {
  constructor(private readonly options: SiteStagingValidationOptions) {}

  private dirs(key: string): { live: string; staging: string } {
    const live = join(this.options.sitesDir, key);
    return { live, staging: join(live, STAGING_DIR) };
  }

  async typecheck(key: string): Promise<string[]> {
    const { live, staging } = this.dirs(key);
    const check = this.options.typechecker ?? typecheckStagedAdapter;
    return check({ repoRoot: this.options.repoRoot, liveDir: live, stagingDir: staging });
  }

  async full(key: string, signal?: AbortSignal, options: FullStagingOptions = {}): Promise<ValidationReport> {
    const report = await this.options.validator.full(key, {
      staging: true,
      write: true,
      signal,
      ignoreCooldown: options.ignoreCooldown === true,
    });
    if (!report.passed) return report;
    const typeErrors = await this.typecheck(key);
    if (typeErrors.length === 0) return report;
    // The real-site steps passed but the adapter does not compile: not promotable.
    return {
      ...report,
      passed: false,
      failure: {
        step: "static",
        status: "adapter_error",
        message: `adapter.ts has TypeScript errors: ${typeErrors.slice(0, 5).join("; ")}`,
      },
    };
  }

  async quick(key: string): Promise<QuickCheckResult> {
    const { live, staging } = this.dirs(key);
    const problems: string[] = [];
    const { manifest, error } = await readManifest(staging, this.options.manifestOptions);
    if (manifest === null) problems.push(error ?? "manifest.json is missing");
    else {
      if (manifest.key !== key) problems.push(`manifest key "${manifest.key}" must be "${key}"`);
      for (const h of manifest.hostnames) {
        const owner = this.options.hostnameOwner?.(h) ?? null;
        if (owner !== null && owner !== key) problems.push(`hostname ${h} is already registered as ${owner}`);
      }
    }
    const result = await staticCheckAdapterDir(defaultStaticCheckPaths(this.options.repoRoot, staging, live));
    if (!result.ok) problems.push(`static check: ${describeStaticViolations(result.violations)}`);
    else problems.push(...(await this.typecheck(key)).map((e) => `type error: ${e}`));
    return { ok: problems.length === 0, problems };
  }

  async stagedPassed(key: string): Promise<StagedState> {
    const { staging } = this.dirs(key);
    const report = await readValidationReport(staging);
    if (report === null) return { ok: false, reason: "the staged adapter has not been validated yet" };
    if (!report.passed || report.form !== "full")
      return { ok: false, reason: "the last full validation of the staged adapter did not pass" };
    if (report.key !== key) return { ok: false, reason: `validation.json is for "${report.key}"` };
    const hash = await computeAdapterHash(staging);
    if (hash === null || hash !== report.adapterHash)
      return { ok: false, reason: "the staged files changed after the last validation" };
    const typeErrors = await this.typecheck(key);
    if (typeErrors.length > 0)
      return { ok: false, reason: `adapter.ts has TypeScript errors: ${typeErrors.slice(0, 5).join("; ")}` };
    return { ok: true };
  }
}

export interface TypecheckInput {
  repoRoot: string;
  /** `sites/<key>/`: the staged file is checked as if it were `sites/<key>/adapter.ts`. */
  liveDir: string;
  stagingDir: string;
}

let tsModule: Promise<typeof TS> | null = null;
async function loadTypescript(): Promise<typeof TS> {
  tsModule ??= import("typescript").then((mod) => {
    const m = mod as unknown as { default?: typeof TS } & typeof TS;
    return m.default ?? m;
  });
  return tsModule;
}

/**
 * Type-checks the staged `adapter.ts` with the project's tsconfig, served at its live path so its
 * `../../src/adapter-kit/index.js` imports resolve exactly as after promotion. Returns the errors
 * reported for that file (`line: message`), empty when it compiles.
 */
export async function typecheckStagedAdapter(input: TypecheckInput): Promise<string[]> {
  const ts = await loadTypescript();
  let source: string;
  try {
    source = await readFile(join(input.stagingDir, ADAPTER_FILE), "utf8");
  } catch {
    return ["adapter.ts is missing"];
  }
  const configPath = join(input.repoRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, input.repoRoot);
  const options: TS.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  const target = join(input.liveDir, ADAPTER_FILE);
  const host = ts.createCompilerHost(options, true);
  const same = (p: string): boolean => p === target || p.replace(/\\/g, "/") === target.replace(/\\/g, "/");
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (p) => same(p) || baseFileExists(p);
  host.readFile = (p) => (same(p) ? source : baseReadFile(p));
  host.getSourceFile = (p, languageVersion, onError, shouldCreate) =>
    same(p)
      ? ts.createSourceFile(p, source, languageVersion, true)
      : baseGetSourceFile(p, languageVersion, onError, shouldCreate);
  const program = ts.createProgram({ rootNames: [target], options, host });
  const sf = program.getSourceFile(target);
  if (!sf) return ["adapter.ts could not be loaded for the type check"];
  const diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  return diagnostics.slice(0, 20).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `adapter.ts:${line + 1} ${text}`;
    }
    return text;
  });
}
