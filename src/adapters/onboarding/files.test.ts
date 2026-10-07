import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { FileAccessError, ReferenceLibrary, StagingFiles } from "./files.js";

describe("StagingFiles (the agent's only write access)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let siteDir: string;
  let staging: StagingFiles;

  beforeEach(async () => {
    tmp = await makeTempDir("brb-staging-");
    siteDir = join(tmp.dir, "sites", "demo");
    await mkdir(siteDir, { recursive: true });
    staging = new StagingFiles({ siteDir, stagingDir: join(siteDir, ".staging"), key: "demo" });
  });
  afterEach(async () => tmp.cleanup());

  it("writes and reads manifest.json, adapter.ts, NOTES.md inside .staging/", async () => {
    await staging.write("adapter.ts", "export default {};\n");
    await staging.write("./NOTES.md", "# notes\n");
    const r = await staging.write("manifest.json", JSON.stringify({ key: "demo" }));
    expect(r.path).toBe("sites/demo/.staging/manifest.json");
    expect((await readdir(join(siteDir, ".staging"))).sort()).toEqual([
      "NOTES.md",
      "adapter.ts",
      "manifest.json",
    ]);
    expect(await staging.read("adapter.ts")).toBe("export default {};\n");
    expect(await staging.read("validation.json")).toBeNull();
  });

  it.each([
    "../adapter.ts",
    "../../src/app/main.ts",
    "/etc/passwd",
    "sub/adapter.ts",
    ".staging/adapter.ts",
    "helper.ts",
    "validation.json",
    "adapter.js",
    "..",
    "NOTES.md\0x",
  ])("rejects writing %j", async (name) => {
    await expect(staging.write(name, "x")).rejects.toBeInstanceOf(FileAccessError);
  });

  it("writes nothing when the caller's guard says the job may no longer change files", async () => {
    await expect(staging.write("NOTES.md", "# late\n", { proceed: () => false })).rejects.toThrow(
      "the job was cancelled",
    );
    expect(await staging.read("NOTES.md")).toBeNull();
  });

  it("requires manifest.json to be JSON with the job's key", async () => {
    await expect(staging.write("manifest.json", "{nope")).rejects.toThrow("not valid JSON");
    await expect(staging.write("manifest.json", JSON.stringify({ key: "other" }))).rejects.toThrow(
      'must be "demo"',
    );
  });

  it("rejects oversized files", async () => {
    await expect(staging.write("NOTES.md", "x".repeat(300_001))).rejects.toThrow("too large");
  });

  it("refuses a staging folder that is a symlink (no writes outside the site folder)", async () => {
    const outside = join(tmp.dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(siteDir, ".staging"));
    await expect(staging.write("adapter.ts", "x")).rejects.toThrow("not a plain folder");
    expect(await readdir(outside)).toEqual([]);
  });

  it("reading a symlinked file is refused", async () => {
    await mkdir(join(siteDir, ".staging"));
    await writeFile(join(tmp.dir, "secret.txt"), "secret");
    await symlink(join(tmp.dir, "secret.txt"), join(siteDir, ".staging", "NOTES.md"));
    await expect(staging.read("NOTES.md")).rejects.toThrow("not a plain file");
  });
});

describe("ReferenceLibrary (read_reference allowlist)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTempDir("brb-ref-");
    const d = tmp.dir;
    await mkdir(join(d, "docs"), { recursive: true });
    await mkdir(join(d, "src", "adapter-kit"), { recursive: true });
    await mkdir(join(d, "src", "ports"), { recursive: true });
    await mkdir(join(d, "sites", "reuters"), { recursive: true });
    await mkdir(join(d, "sites", "other-site"), { recursive: true });
    await writeFile(join(d, "docs", "ADAPTERS.md"), "# adapters");
    await writeFile(join(d, "src", "adapter-kit", "index.ts"), "export {};");
    await writeFile(join(d, "src", "adapter-kit", "dates.test.ts"), "test");
    await writeFile(join(d, "src", "ports", "adapter.ts"), "export {};");
    await writeFile(join(d, "sites", "reuters", "adapter.ts"), "// reuters");
    await writeFile(join(d, "sites", "other-site", "adapter.ts"), "// other");
    await writeFile(join(d, ".env"), "BRIDGE_PASSPHRASE=secret");
    await writeFile(join(d, "package.json"), "{}");
  });
  afterEach(async () => tmp.cleanup());

  const lib = (repairSite: string | null = null) =>
    new ReferenceLibrary({ repoRoot: tmp.dir, sitesDir: join(tmp.dir, "sites"), repairSite });

  it("reads the authoring docs, the reference adapter, the kit, and the port types", async () => {
    expect((await lib().read("docs/ADAPTERS.md")).text).toBe("# adapters");
    expect((await lib().read("./sites/reuters/adapter.ts")).text).toBe("// reuters");
    expect((await lib().read("src/adapter-kit/index.ts")).text).toBe("export {};");
    expect((await lib().read("src/ports/adapter.ts")).path).toBe("src/ports/adapter.ts");
  });

  it.each([
    ".env",
    "package.json",
    "src/app/config.ts",
    "docs/../.env",
    "../outside",
    "/etc/hosts",
    "src/adapter-kit/dates.test.ts",
    "sites/other-site/adapter.ts",
  ])("rejects %j", async (path) => {
    await expect(lib().read(path)).rejects.toBeInstanceOf(FileAccessError);
  });

  it("allows the repaired site's live files only for that repair", async () => {
    expect((await lib("other-site").read("sites/other-site/adapter.ts")).text).toBe("// other");
    await expect(lib("another").read("sites/other-site/adapter.ts")).rejects.toThrow("not an allowed reference");
  });

  it("refuses an allowlisted path that is a symlink out of the project", async () => {
    const outside = await makeTempDir("brb-out-");
    try {
      await writeFile(join(outside.dir, "x.md"), "outside");
      await symlink(join(outside.dir, "x.md"), join(tmp.dir, "docs", "BROWSER.md"));
      await expect(lib().read("docs/BROWSER.md")).rejects.toThrow("outside the project");
      expect(await readFile(join(outside.dir, "x.md"), "utf8")).toBe("outside");
    } finally {
      await outside.cleanup();
    }
  });
});
