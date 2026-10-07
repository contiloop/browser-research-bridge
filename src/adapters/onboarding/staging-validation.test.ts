import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterSource,
  makeTempDir,
  manifestFor,
  passedReport,
} from "../../../test/support/site-fixtures.js";
import { computeAdapterHash, writeValidationReport } from "../validation/report.js";
import { SiteStagingValidation, typecheckStagedAdapter } from "./staging-validation.js";

describe("SiteStagingValidation", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let staging: string;

  beforeEach(async () => {
    tmp = await makeTempDir("brb-sv-");
    await mkdir(join(tmp.dir, "src", "adapter-kit"), { recursive: true });
    await writeFile(join(tmp.dir, "src", "adapter-kit", "index.ts"), "export const kit: number = 1;\n");
    await writeFile(join(tmp.dir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(tmp.dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          lib: ["ES2023"],
          types: [],
          skipLibCheck: true,
        },
      }),
    );
    staging = join(tmp.dir, "sites", "demo", ".staging");
    await mkdir(staging, { recursive: true });
  });
  afterEach(async () => tmp.cleanup());

  let fullOptions: unknown[] = [];
  const make = (passed = true) =>
    new SiteStagingValidation({
      validator: {
        async full(key, opts) {
          fullOptions.push(opts?.ignoreCooldown);
          const report = { ...passedReport(key, await computeAdapterHash(staging), "staging"), passed };
          await writeValidationReport(staging, report);
          return report;
        },
      },
      sitesDir: join(tmp.dir, "sites"),
      repoRoot: tmp.dir,
      hostnameOwner: (h) => (h === "taken.example.com" ? "other" : null),
    });

  it("full() honors the site's cool-down unless the caller passes ignoreCooldown", async () => {
    fullOptions = [];
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifestFor("demo")));
    await writeFile(join(staging, "adapter.ts"), "export const n: number = 1;\n");
    const v = make();
    await v.full("demo");
    await v.full("demo", undefined, { ignoreCooldown: true });
    expect(fullOptions).toEqual([false, true]);
  });

  it("type-checks the staged adapter as if it were live (kit imports resolve from sites/<key>/)", async () => {
    await writeFile(
      join(staging, "adapter.ts"),
      'import { kit } from "../../src/adapter-kit/index.js";\nexport const n: number = kit;\n',
    );
    expect(
      await typecheckStagedAdapter({
        repoRoot: tmp.dir,
        liveDir: join(tmp.dir, "sites", "demo"),
        stagingDir: staging,
      }),
    ).toEqual([]);
    await writeFile(join(staging, "adapter.ts"), 'export const n: number = "text";\n');
    const errors = await typecheckStagedAdapter({
      repoRoot: tmp.dir,
      liveDir: join(tmp.dir, "sites", "demo"),
      stagingDir: staging,
    });
    expect(errors[0]).toMatch(/^adapter\.ts:1 Type 'string' is not assignable to type 'number'/);
  });

  it("full(): a real-site pass that does not type-check is not promotable", async () => {
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifestFor("demo")));
    await writeFile(join(staging, "adapter.ts"), 'export const n: number = "text";\n');
    const report = await make().full("demo");
    expect(report.passed).toBe(false);
    expect(report.failure?.message).toContain("TypeScript errors");
  });

  it("stagedPassed(): requires a passed full report for exactly the current files", async () => {
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifestFor("demo")));
    await writeFile(join(staging, "adapter.ts"), "export const n: number = 1;\n");
    const v = make();
    expect(await v.stagedPassed("demo")).toEqual({
      ok: false,
      reason: "the staged adapter has not been validated yet",
    });
    await v.full("demo");
    expect(await v.stagedPassed("demo")).toEqual({ ok: true });
    await writeFile(join(staging, "adapter.ts"), "export const n: number = 2;\n");
    expect(await v.stagedPassed("demo")).toEqual({
      ok: false,
      reason: "the staged files changed after the last validation",
    });
    await make(false).full("demo");
    expect((await v.stagedPassed("demo")).ok).toBe(false);
  });

  it("quick(): manifest, hostname ownership, static check", async () => {
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifestFor("demo", { hostnames: ["taken.example.com"] })),
    );
    await writeFile(
      join(staging, "adapter.ts"),
      'import { readFile } from "node:fs";\nexport default { readFile };\n',
    );
    const q = await make().quick("demo");
    expect(q.ok).toBe(false);
    expect(q.problems.join("\n")).toContain("already registered as other");
    expect(q.problems.join("\n")).toContain("static check");
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifestFor("demo")));
    await writeFile(join(staging, "adapter.ts"), adapterSource("v1"));
    expect(await make().quick("demo")).toEqual({ ok: true, problems: [] });
  });
});
