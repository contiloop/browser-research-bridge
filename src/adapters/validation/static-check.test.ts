import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import {
  checkAdapterSource,
  defaultStaticCheckPaths,
  rewriteImportsForLiveLocation,
  staticCheckAdapterDir,
} from "./static-check.js";

const ROOT = "/repo";
const LIVE = "/repo/sites/demo";
const STAGING = "/repo/sites/demo/.staging";
const livePaths = defaultStaticCheckPaths(ROOT, LIVE);
const stagingPaths = defaultStaticCheckPaths(ROOT, STAGING, LIVE);

async function rules(source: string, paths = livePaths): Promise<string[]> {
  return (await checkAdapterSource(source, "adapter.ts", paths)).map((v) => v.rule);
}

describe("adapter static check", () => {
  it.each([
    ['import { readFile } from "fs";'],
    ['import * as fs from "node:fs/promises";'],
    ['import { exec } from "child_process";'],
    ['import net from "net";'],
    ['import http from "node:http";'],
    ['export { request } from "https";'],
  ])("rejects Node built-in imports: %s", async (source) => {
    expect(await rules(source)).toEqual(["node-builtin-import"]);
  });

  it("rejects reading process.env in any form", async () => {
    expect(await rules("const k = process.env.API_KEY;")).toEqual(["process-env"]);
    expect(await rules('const k = process["env"];')).toEqual(["process-env"]);
    expect(await rules("const p = process; p.exit(1);")).toEqual(["forbidden-global"]);
  });

  it("rejects imports outside src/adapter-kit", async () => {
    expect(await rules('import { z } from "zod";')).toEqual(["outside-import"]);
    expect(await rules('import { loadConfig } from "../../src/app/config.js";')).toEqual(["outside-import"]);
    expect(await rules('import other from "../other-site/adapter.js";')).toEqual(["outside-import"]);
    expect(await rules('import x from "/etc/passwd";')).toEqual(["outside-import"]);
    expect(await rules('import x from "file:///repo/src/app/config.js";')).toEqual(["outside-import"]);
  });

  it("rejects dynamic import, require, and import.meta", async () => {
    expect(await rules('const m = await import("fs");')).toEqual(["dynamic-import"]);
    expect(await rules('const m = require("fs");')).toEqual(["forbidden-global"]);
    expect(await rules('import fs = require("fs");')).toEqual(["require"]);
    expect(await rules("const u = import.meta.url;")).toEqual(["import-meta"]);
  });

  it("rejects escape hatches and direct network globals", async () => {
    expect(await rules("const g = globalThis;")).toEqual(["forbidden-global"]);
    expect(await rules('eval("1");')).toEqual(["forbidden-global"]);
    expect(await rules('const f = new Function("return 1");')).toEqual(["forbidden-global"]);
    expect(await rules("const F = (() => 0).constructor;")).toEqual(["constructor-access"]);
    expect(await rules('const F = (() => 0)["constructor"];')).toEqual(["constructor-access"]);
    expect(await rules("class X extends Function {}")).toEqual(["forbidden-global"]);
    expect(await rules('await fetch("https://evil.example");')).toEqual(["forbidden-global"]);
    expect(await rules('new WebSocket("wss://x");')).toEqual(["forbidden-global"]);
  });

  it("accepts adapter-kit imports, type-only port imports, and ctx usage", async () => {
    const source = `
      import { parseList } from "../../src/adapter-kit/index.js";
      import type { SiteAdapter, AdapterContext } from "../../src/ports/adapter.js";
      import type { Document } from "../../src/core/index.js";
      export type { SiteAdapter } from "../../src/ports/adapter.js";
      const adapter: SiteAdapter = {
        async search(req, ctx: AdapterContext) {
          const r = await ctx.browser.fetch("https://demo.example.com/search?q=" + encodeURIComponent(req.text));
          const page = { fetch: 1, process: 2, env: 3 };
          void page.fetch; void parseList;
          const script = "return await fetch('/api').then((r) => r.json());";
          void script;
          return { results: [], nextCursor: null, status: r.status === 200 ? "empty" : "adapter_error" };
        },
        async read() { return { status: "unsupported" }; },
        async smokeTest() { return { status: "ok" }; },
      };
      let d: Document | null = null; void d;
      class Helper { constructor(readonly n: number) {} }
      void Helper;
      export default adapter;
    `;
    expect(await checkAdapterSource(source, "adapter.ts", livePaths)).toEqual([]);
  });

  it("checks a staged adapter as if it lived in the live folder", async () => {
    const source = 'import { x } from "../../src/adapter-kit/index.js";\nexport default { x };';
    expect(await rules(source, stagingPaths)).toEqual([]);
    // Written for the staging depth, it would break once promoted.
    expect(await rules('import { x } from "../../../src/adapter-kit/index.js";', stagingPaths)).toEqual([
      "outside-import",
    ]);
  });

  it("rejects runtime imports of other files in the folder (single-module adapters)", async () => {
    expect(await rules('import { parse } from "./parse.js";')).toEqual(["local-import"]);
    expect(await rules('import type { Row } from "./types.js";')).toEqual([]);
  });

  it("reports syntax errors", async () => {
    expect(await rules("export default {")).toContain("parse-error");
  });

  it("does not flag type positions", async () => {
    expect(await rules("type F = Function; let g: typeof globalThis | null = null; void g;")).toEqual([]);
  });
});

describe("folder check", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => tmp.cleanup());

  it("checks every source file except tests, dotfiles, .staging and .previous", async () => {
    const dir = join(tmp.dir, "sites", "demo");
    await mkdir(join(dir, ".staging"), { recursive: true });
    await mkdir(join(dir, ".previous"), { recursive: true });
    await writeFile(join(dir, "adapter.ts"), "export default {};\n");
    await writeFile(join(dir, "helper.ts"), 'import fs from "fs";\nexport { fs };\n');
    await writeFile(join(dir, "adapter.test.ts"), 'import { it } from "vitest";\nit("x", () => {});\n');
    await writeFile(join(dir, ".load-abc.ts"), 'import fs from "fs";\n');
    await writeFile(join(dir, ".staging", "adapter.ts"), 'import fs from "fs";\n');
    await writeFile(join(dir, ".previous", "adapter.ts"), "process.env.X;\n");
    const result = await staticCheckAdapterDir(defaultStaticCheckPaths(tmp.dir, dir));
    expect(result.files).toEqual(["adapter.ts", "helper.ts"]);
    expect(result.violations.map((v) => `${v.file}:${v.rule}`)).toEqual(["helper.ts:node-builtin-import"]);
    expect(result.ok).toBe(false);
  });

  it("requires adapter.ts", async () => {
    const dir = join(tmp.dir, "sites", "empty");
    await mkdir(dir, { recursive: true });
    const result = await staticCheckAdapterDir(defaultStaticCheckPaths(tmp.dir, dir));
    expect(result.violations.map((v) => v.rule)).toEqual(["missing-adapter"]);
  });
});

describe("rewriteImportsForLiveLocation", () => {
  it("rewrites out-of-folder value imports to absolute URLs and leaves the rest", async () => {
    const source = [
      'import { a } from "../../src/adapter-kit/index.js";',
      'import type { T } from "../../src/ports/adapter.js";',
      "export default { a };",
    ].join("\n");
    const out = await rewriteImportsForLiveLocation(source, "adapter.ts", STAGING, LIVE);
    expect(out).toContain('from "file:///repo/src/adapter-kit/index.js"');
    expect(out).toContain('import type { T } from "../../src/ports/adapter.js"');
    expect(await rewriteImportsForLiveLocation(source, "adapter.ts", LIVE, LIVE)).toBe(source);
  });
});
