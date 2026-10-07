/**
 * Adapter static check. Adapter code runs in the bridge process and
 * may use only the injected adapter API (`ctx`: browser port, helpers, manifest, logger). The check
 * parses every source file of the adapter folder with the TypeScript parser and rejects:
 *
 * - imports of Node built-ins (`fs`, `child_process`, `net`, `http`, … with or without `node:`),
 * - imports of anything outside the adapter helper package `src/adapter-kit` (packages, other
 *   project code, other site folders); `import type` may also name `src/ports` and `src/core`
 *   (erased at runtime); `import(…)`, `require`, and `import x = require(…)` are rejected,
 * - value imports of other files in the adapter folder (an adapter is one module, `adapter.ts`, so
 *   a hot reload never runs a stale helper module),
 * - reading `process.env`, and the escape hatches `process`, `globalThis`, `global`, `eval`,
 *   `Function`, `require`, `module`, `exports`, `__dirname`, `__filename`, `import.meta`, `.constructor`,
 *   and the network globals `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` (the browser goes
 *   through `ctx.browser`, which is restricted to the site's hostnames).
 *
 * Imports are resolved as if the files already lived in the live folder `sites/<key>/`, so a staged
 * adapter is checked exactly as it will be served. This is a static guard, not a sandbox.
 */
import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as TS from "typescript";

export type StaticRule =
  | "missing-adapter"
  | "parse-error"
  | "node-builtin-import"
  | "outside-import"
  | "local-import"
  | "dynamic-import"
  | "require"
  | "process-env"
  | "forbidden-global"
  | "import-meta"
  | "constructor-access";

export interface StaticViolation {
  /** Path relative to the checked folder. */
  file: string;
  line: number;
  rule: StaticRule;
  detail: string;
}

export interface StaticCheckResult {
  ok: boolean;
  /** Files checked, relative to the folder. */
  files: string[];
  violations: StaticViolation[];
}

export interface StaticCheckPaths {
  /** Folder the files are in now (the live folder or its `.staging/`). */
  dir: string;
  /** The live folder `sites/<key>/`; imports are resolved from here. Defaults to `dir`. */
  liveDir?: string | undefined;
  /** Absolute path of `src/adapter-kit`. */
  adapterKitDir: string;
  /** Extra directories `import type` may name (e.g. `src/ports`, `src/core`). */
  typeOnlyDirs?: readonly string[] | undefined;
}

export interface ResolvedStaticCheckPaths {
  dir: string;
  liveDir: string;
  adapterKitDir: string;
  typeOnlyDirs: readonly string[];
}

/** Repo-layout defaults: `<root>/src/adapter-kit`, type-only `<root>/src/ports` and `<root>/src/core`. */
export function defaultStaticCheckPaths(
  repoRoot: string,
  dir: string,
  liveDir?: string,
): ResolvedStaticCheckPaths {
  return {
    dir,
    liveDir: liveDir ?? dir,
    adapterKitDir: join(repoRoot, "src", "adapter-kit"),
    typeOnlyDirs: [join(repoRoot, "src", "ports"), join(repoRoot, "src", "core")],
  };
}

const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  "process",
  "globalThis",
  "global",
  "eval",
  "Function",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);

const NODE_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.flatMap((m) => [m, m.split("/")[0] ?? m]).filter((m) => !m.startsWith("_")),
);

const SOURCE_FILE = /\.(?:[mc]?ts|[mc]?js|tsx|jsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[mc]?ts|[mc]?js|tsx|jsx)$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".staging", ".previous", "node_modules"]);

let tsModule: typeof TS | undefined;
async function typescript(): Promise<typeof TS> {
  if (tsModule === undefined) {
    const mod = (await import("typescript")) as unknown as { default?: typeof TS } & typeof TS;
    tsModule = mod.default ?? mod;
  }
  return tsModule;
}

function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
}

interface ImportCheck {
  rule: StaticRule;
  detail: string;
}

/**
 * Classifies one module specifier. `liveFile` is where the importing file will be served from.
 * Returns null when the import is allowed.
 */
export function checkImportSpecifier(
  specifier: string,
  liveFile: string,
  typeOnly: boolean,
  paths: ResolvedStaticCheckPaths,
): ImportCheck | null {
  if (isNodeBuiltin(specifier)) {
    return { rule: "node-builtin-import", detail: `imports the Node built-in "${specifier}"` };
  }
  if (specifier.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return { rule: "outside-import", detail: `imports "${specifier}" by absolute path or URL` };
  }
  if (!isRelative(specifier)) {
    return {
      rule: "outside-import",
      detail: `imports the package "${specifier}"; only the adapter helper package src/adapter-kit is allowed`,
    };
  }
  const target = resolve(dirname(liveFile), specifier);
  if (isWithin(target, paths.adapterKitDir)) return null;
  if (isWithin(target, paths.liveDir)) {
    if (typeOnly) return null;
    return {
      rule: "local-import",
      detail: `imports "${specifier}" at runtime; an adapter is a single module (adapter.ts) — use import type, or move shared helpers into src/adapter-kit`,
    };
  }
  if (typeOnly && paths.typeOnlyDirs.some((d) => isWithin(target, d))) return null;
  return {
    rule: "outside-import",
    detail: `imports "${specifier}" outside the adapter folder and src/adapter-kit`,
  };
}

function isTypePosition(ts: typeof TS, node: TS.Node): boolean {
  for (let n: TS.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    // `class X extends Base` names a value (e.g. `extends Function` would build functions from strings).
    if (
      ts.isExpressionWithTypeArguments(n) &&
      ts.isHeritageClause(n.parent) &&
      n.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(n.parent.parent)
    ) {
      return false;
    }
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
    if (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/** True when the identifier is a property/member name rather than a reference to a binding. */
function isNameOnly(ts: typeof TS, id: TS.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return true;
  }
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return true;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  return false;
}

/** Checks one source file. `relPath` is its path relative to the adapter folder. */
export async function checkAdapterSource(
  source: string,
  relPath: string,
  pathsInput: StaticCheckPaths,
): Promise<StaticViolation[]> {
  const ts = await typescript();
  const paths: ResolvedStaticCheckPaths = {
    dir: pathsInput.dir,
    liveDir: pathsInput.liveDir ?? pathsInput.dir,
    adapterKitDir: pathsInput.adapterKitDir,
    typeOnlyDirs: pathsInput.typeOnlyDirs ?? [],
  };
  const liveFile = join(paths.liveDir, relPath);
  const violations: StaticViolation[] = [];

  const syntax = ts.transpileModule(source, {
    fileName: relPath,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).diagnostics;
  for (const d of syntax ?? []) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
    violations.push({
      file: relPath,
      line,
      rule: "parse-error",
      detail: ts.flattenDiagnosticMessageText(d.messageText, " "),
    });
  }

  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.ES2022, true);
  const add = (node: TS.Node, rule: StaticRule, detail: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push({ file: relPath, line, rule, detail });
  };
  const checkSpecifier = (node: TS.Node, specNode: TS.Expression | undefined, typeOnly: boolean): void => {
    if (specNode === undefined) return;
    if (!ts.isStringLiteralLike(specNode)) {
      add(node, "dynamic-import", "module specifier is not a string literal");
      return;
    }
    const problem = checkImportSpecifier(specNode.text, liveFile, typeOnly, paths);
    if (problem) add(node, problem.rule, problem.detail);
  };

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node)) {
      checkSpecifier(node, node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      checkSpecifier(node, node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add(node, "require", "import = require(...) is not allowed");
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg)) checkSpecifier(node, arg.literal, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, "dynamic-import", "dynamic import() is not allowed");
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      add(node, "import-meta", "import.meta is not allowed");
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") {
      add(node, "constructor-access", "access to .constructor is not allowed");
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "constructor"
    ) {
      add(node, "constructor-access", "access to .constructor is not allowed");
    } else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      if (!isNameOnly(ts, node) && !isTypePosition(ts, node)) {
        const p = node.parent;
        const readsEnv =
          node.text === "process" &&
          ((ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === "env") ||
            (ts.isElementAccessExpression(p) &&
              p.expression === node &&
              ts.isStringLiteralLike(p.argumentExpression) &&
              p.argumentExpression.text === "env"));
        if (readsEnv) add(node, "process-env", "reads process.env");
        else add(node, "forbidden-global", `uses "${node.text}"; adapters use only the injected ctx API`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

async function listSourceFiles(dir: string, base = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, base), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isFile()) continue; // e.g. the loader's temporary .load-*.ts
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...(await listSourceFiles(dir, rel)));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Checks every source file of an adapter folder (`*.test.ts` and `.staging/`/`.previous/` excluded). */
export async function staticCheckAdapterDir(pathsInput: StaticCheckPaths): Promise<StaticCheckResult> {
  const files = await listSourceFiles(pathsInput.dir);
  const violations: StaticViolation[] = [];
  if (!files.includes("adapter.ts")) {
    violations.push({
      file: "adapter.ts",
      line: 0,
      rule: "missing-adapter",
      detail: "adapter.ts is missing",
    });
  }
  for (const file of files) {
    const source = await readFile(join(pathsInput.dir, file), "utf8");
    violations.push(...(await checkAdapterSource(source, file, pathsInput)));
  }
  return { ok: violations.length === 0, files, violations };
}

export function describeStaticViolations(violations: readonly StaticViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.detail}`).join("; ");
}

/**
 * Returns `source` with every relative value-import specifier that leaves the folder rewritten to
 * the absolute file URL it resolves to from the live location. Used to evaluate a staged adapter
 * (one directory deeper) exactly as it will run once promoted. Type-only imports are untouched.
 */
export async function rewriteImportsForLiveLocation(
  source: string,
  relPath: string,
  dir: string,
  liveDir: string,
): Promise<string> {
  const ts = await typescript();
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.ES2022, true);
  const liveFile = join(liveDir, relPath);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const stmt of sf.statements) {
    let spec: TS.Expression | undefined;
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly !== true) spec = stmt.moduleSpecifier;
    else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) spec = stmt.moduleSpecifier;
    if (spec === undefined || !ts.isStringLiteralLike(spec) || !isRelative(spec.text)) continue;
    const target = resolve(dirname(liveFile), spec.text);
    if (isWithin(target, liveDir)) continue;
    edits.push({
      start: spec.getStart(sf),
      end: spec.getEnd(),
      text: JSON.stringify(pathToFileURL(target).href),
    });
  }
  if (dir === liveDir || edits.length === 0) return source;
  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
