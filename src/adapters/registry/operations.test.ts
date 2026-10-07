import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterSource,
  makeTempDir,
  manifestFor,
  silentLogger,
  writeAdapterFolder,
} from "../../../test/support/site-fixtures.js";
import { newSiteState } from "../../core/lifecycle.js";
import type { SiteCommitAction, SiteCommitter } from "../../ports/site-store.js";
import { InMemoryScheduler } from "../aside/scheduler.js";
import { FileCache } from "../storage/cache-store.js";
import { FileSiteStateStore } from "../storage/site-state-store.js";
import { ModuleAdapterLoader } from "./loader.js";
import { promoteStaging, removeSite } from "./operations.js";
import type { SiteOperationsDeps } from "./operations.js";
import { SiteRegistryService } from "./registry.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tagOf(path: string): Promise<string | null> {
  try {
    return /const tag: string = "([^"]+)"/.exec(await readFile(path, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

describe("staging swap and removal (real temp directories)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let sitesDir: string;
  let store: FileSiteStateStore;
  let cache: FileCache;
  let registry: SiteRegistryService;
  let commits: [string, SiteCommitAction][];
  let deps: SiteOperationsDeps;

  beforeEach(async () => {
    tmp = await makeTempDir();
    // A miniature repo layout so adapter-kit imports resolve like in the project.
    sitesDir = join(tmp.dir, "sites");
    await mkdir(join(tmp.dir, "src", "adapter-kit"), { recursive: true });
    await writeFile(
      join(tmp.dir, "src", "adapter-kit", "index.ts"),
      'export const kitName: string = "kit";\n',
    );
    await mkdir(sitesDir, { recursive: true });
    store = new FileSiteStateStore(join(tmp.dir, "data", "sites.json"));
    cache = new FileCache(join(tmp.dir, "data", "cache"));
    registry = new SiteRegistryService({
      sitesDir,
      stateStore: store,
      loader: new ModuleAdapterLoader({ repoRoot: tmp.dir, preferCompiled: false }),
      cache,
      logger: silentLogger,
    });
    commits = [];
    const committer: SiteCommitter = {
      async commitSite(key, action) {
        commits.push([key, action]);
        return { committed: true, commit: "abc" };
      },
    };
    deps = { registry, repoRoot: tmp.dir, committer, logger: silentLogger };
  });
  afterEach(async () => tmp.cleanup());

  const live = (key: string, file = "adapter.ts") => join(sitesDir, key, file);
  const staging = (key: string, file = "") => join(sitesDir, key, ".staging", file);
  const previous = (key: string, file = "") => join(sitesDir, key, ".previous", file);

  it("Add: promotes a validated staging folder, registers the site active, and commits site: add", async () => {
    await registry.init();
    await registry.registerOnboarding({ hostnames: ["demo.example.com"], key: "demo" });
    await writeAdapterFolder(staging("demo"), "demo", { adapter: adapterSource("v1") });
    const result = await promoteStaging(deps, "demo");
    expect(result).toEqual({
      ok: true,
      key: "demo",
      action: "add",
      commit: { committed: true, commit: "abc" },
    });
    expect(await tagOf(live("demo"))).toBe("v1");
    expect(await exists(staging("demo"))).toBe(false);
    expect(await exists(previous("demo"))).toBe(false);
    expect(registry.get("demo")).toMatchObject({ status: "active", loadable: true });
    expect(((await registry.load("demo"))?.adapter as unknown as { tag: string }).tag).toBe("v1");
    expect(commits).toEqual([["demo", "add"]]);
  });

  it("Repair: keeps exactly one previous generation and hot-reloads the new adapter", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo", { adapter: adapterSource("v1") });
    await writeAdapterFolder(previous("demo"), "demo", { adapter: adapterSource("v0") });
    await store.save([newSiteState({ key: "demo", status: "degraded", at: "2026-10-05T10:00:00.000Z" })]);
    await registry.init();
    expect(((await registry.load("demo"))?.adapter as unknown as { tag: string }).tag).toBe("v1");

    await writeAdapterFolder(staging("demo"), "demo", { adapter: adapterSource("v2") });
    const result = await promoteStaging(deps, "demo");
    expect(result).toMatchObject({ ok: true, action: "repair" });
    expect(await tagOf(live("demo"))).toBe("v2");
    expect(await tagOf(previous("demo", "adapter.ts"))).toBe("v1");
    expect((await readdir(previous("demo"))).sort()).toEqual([
      "adapter.ts",
      "manifest.json",
      "validation.json",
    ]);
    expect(await exists(staging("demo"))).toBe(false);
    expect(registry.get("demo")?.status).toBe("active");
    expect(((await registry.load("demo"))?.adapter as unknown as { tag: string }).tag).toBe("v2");
    expect(commits).toEqual([["demo", "repair"]]);
  });

  it("evaluates a staged adapter that imports src/adapter-kit as it will run once promoted", async () => {
    await registry.init();
    await registry.registerOnboarding({ hostnames: ["demo.example.com"], key: "demo" });
    await writeAdapterFolder(staging("demo"), "demo", {
      adapter: `import { kitName } from "../../src/adapter-kit/index.js";\n${adapterSource("kit-user", "kit: kitName,")}`,
    });
    const result = await promoteStaging(deps, "demo");
    expect(result.ok).toBe(true);
    const loaded = (await registry.load("demo"))?.adapter as unknown as { kit: string };
    expect(loaded.kit).toBe("kit");
    // The loader's temporary rewritten copy never stays behind.
    expect((await readdir(join(sitesDir, "demo"))).filter((n) => n.startsWith(".load-"))).toEqual([]);
  });

  describe("refusals leave the live adapter untouched", () => {
    beforeEach(async () => {
      await writeAdapterFolder(join(sitesDir, "demo"), "demo", { adapter: adapterSource("v1") });
      await registry.init();
    });

    it("staging without a passed validation", async () => {
      await writeAdapterFolder(staging("demo"), "demo", { adapter: adapterSource("v2"), validated: false });
      const result = await promoteStaging(deps, "demo");
      expect(result).toMatchObject({ ok: false, reason: "the staged adapter has no validation.json" });
      expect(await tagOf(live("demo"))).toBe("v1");
      expect(await tagOf(staging("demo", "adapter.ts"))).toBe("v2");
      expect(commits).toEqual([]);
    });

    it("staged files changed after validation", async () => {
      await writeAdapterFolder(staging("demo"), "demo", { adapter: adapterSource("v2") });
      await writeFile(staging("demo", "adapter.ts"), adapterSource("v2-edited"));
      const result = await promoteStaging(deps, "demo");
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? "" : result.reason).toContain("changed after validation");
      expect(await tagOf(live("demo"))).toBe("v1");
    });

    it("a staged manifest claiming another site's hostname", async () => {
      await writeAdapterFolder(join(sitesDir, "other"), "other", {
        manifest: manifestFor("other", { hostnames: ["other.com"] }),
      });
      await registry.init();
      await writeAdapterFolder(staging("demo"), "demo", {
        manifest: manifestFor("demo", { hostnames: ["demo.example.com", "www.other.com"] }),
      });
      const result = await promoteStaging(deps, "demo");
      expect(result.ok ? "" : result.reason).toContain("already registered as other");
      expect(await tagOf(live("demo"))).toBe("v1");
    });

    it("nothing staged / unknown site", async () => {
      expect(await promoteStaging(deps, "demo")).toMatchObject({ ok: false, reason: "nothing staged" });
      expect(await promoteStaging(deps, "nobody")).toMatchObject({ ok: false });
    });
  });

  it("rolls back when the promoted adapter cannot be loaded", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo", { adapter: adapterSource("v1") });
    await writeAdapterFolder(previous("demo"), "demo", { adapter: adapterSource("v0") });
    await store.save([newSiteState({ key: "demo", status: "degraded", at: "2026-10-05T10:00:00.000Z" })]);
    await registry.init();
    // Passes the static check and carries a passed validation.json, but has no smokeTest().
    const bad =
      'const tag: string = "v2-bad";\nexport default { tag, async search() {}, async read() {} };\n';
    await writeAdapterFolder(staging("demo"), "demo", { adapter: bad });

    const result = await promoteStaging(deps, "demo");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("smokeTest");
    expect(await tagOf(live("demo"))).toBe("v1");
    expect(await tagOf(previous("demo", "adapter.ts"))).toBe("v0");
    expect(await tagOf(staging("demo", "adapter.ts"))).toBe("v2-bad");
    expect((await readdir(staging("demo"))).sort()).toEqual([
      "adapter.ts",
      "manifest.json",
      "validation.json",
    ]);
    expect(registry.get("demo")?.status).toBe("degraded");
    expect(((await registry.load("demo"))?.adapter as unknown as { tag: string }).tag).toBe("v1");
    expect(commits).toEqual([]);
  });

  it("Remove: cancels the job, deletes the folder, state, and cache, and commits site: remove", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo");
    await writeAdapterFolder(staging("demo"), "demo");
    await writeAdapterFolder(previous("demo"), "demo");
    await writeAdapterFolder(join(sitesDir, "keep"), "keep");
    await registry.init();
    await cache.set("read", "demo:1", "doc", { ttlMs: 60_000, sites: ["demo"] });
    await cache.set("read", "keep:1", "doc", { ttlMs: 60_000, sites: ["keep"] });
    const order: string[] = [];
    const result = await removeSite(deps, "demo", {
      cancelJob: async (key) => {
        order.push(`cancel ${key}`);
        expect(await exists(join(sitesDir, key))).toBe(true);
      },
    });
    expect(result).toMatchObject({ ok: true, key: "demo" });
    expect(order).toEqual(["cancel demo"]);
    expect(await exists(join(sitesDir, "demo"))).toBe(false);
    expect(registry.get("demo")).toBeUndefined();
    expect(registry.list().map((s) => s.key)).toEqual(["keep"]);
    expect((await store.load()).map((s) => s.key)).toEqual(["keep"]);
    expect(await cache.get("read", "demo:1")).toBeUndefined();
    expect(await cache.get("read", "keep:1")).toBe("doc");
    expect(await exists(join(sitesDir, "keep", "adapter.ts"))).toBe(true);
    expect(commits).toEqual([["demo", "remove"]]);
    // Re-adding works after removal.
    expect(registry.checkAddHostname("demo.example.com").ok).toBe(true);
  });

  it("Remove clears the site's scheduler cool-down (a re-added site starts fresh)", async () => {
    await writeAdapterFolder(join(sitesDir, "demo"), "demo");
    await registry.init();
    const scheduler = new InMemoryScheduler();
    scheduler.setCooldown("demo", Date.now() + 600_000);
    scheduler.setCooldown("keep", Date.now() + 600_000);
    const result = await removeSite({ ...deps, scheduler }, "demo");
    expect(result.ok).toBe(true);
    expect(scheduler.cooldownUntil("demo")).toBeNull();
    expect(scheduler.cooldownUntil("keep")).not.toBeNull();
  });
});
