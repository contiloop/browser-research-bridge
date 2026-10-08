import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { FileCache } from "../storage/cache-store.js";
import { FileSiteStateStore } from "../storage/site-state-store.js";
import { ModuleAdapterLoader } from "./loader.js";
import { SiteRegistryService } from "./registry.js";

const AT = "2026-10-05T10:00:00.000Z";

describe("SiteRegistryService", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let sitesDir: string;
  let store: FileSiteStateStore;
  let cache: FileCache;
  let cooldowns: { site: string; until: number }[];

  const make = (): SiteRegistryService =>
    new SiteRegistryService({
      sitesDir,
      stateStore: store,
      loader: new ModuleAdapterLoader({ repoRoot: process.cwd(), preferCompiled: false }),
      cache,
      scheduler: { setCooldown: (site, until) => cooldowns.push({ site, until }) },
      logger: silentLogger,
    });

  beforeEach(async () => {
    tmp = await makeTempDir();
    sitesDir = join(tmp.dir, "sites");
    await mkdir(sitesDir, { recursive: true });
    store = new FileSiteStateStore(join(tmp.dir, "data", "sites.json"));
    cache = new FileCache(join(tmp.dir, "data", "cache"));
    cooldowns = [];
  });
  afterEach(async () => tmp.cleanup());

  describe("startup reconciliation", () => {
    it("fresh clone: a loadable folder without state is registered active, pending a check", async () => {
      await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
      const registry = make();
      const report = await registry.init();
      expect(report.registered).toEqual(["alpha"]);
      const site = registry.get("alpha");
      expect(site).toMatchObject({
        key: "alpha",
        status: "active",
        loadable: true,
        lastCheckedAt: null,
        name: "ALPHA",
      });
      expect(site?.hostnames).toEqual(["alpha.example.com"]);
      expect((await store.load()).map((s) => [s.key, s.status])).toEqual([["alpha", "active"]]);
    });

    it("half-written folders (no passed validation) are never registered or loaded", async () => {
      await writeAdapterFolder(join(sitesDir, "halfway"), "halfway", { validated: false });
      await writeAdapterFolder(join(sitesDir, "nomanifest"), "nomanifest", { manifest: null });
      await mkdir(join(sitesDir, "staged-only", ".staging"), { recursive: true });
      await writeAdapterFolder(join(sitesDir, "staged-only", ".staging"), "staged-only");
      const registry = make();
      const report = await registry.init();
      expect(report.registered).toEqual([]);
      expect(report.ignored.map((i) => i.key).sort()).toEqual(["halfway", "nomanifest", "staged-only"]);
      expect(registry.list()).toEqual([]);
      expect(await registry.load("halfway")).toBeUndefined();
    });

    it("a failed validation.json is not loadable", async () => {
      const dir = join(sitesDir, "broken");
      await writeAdapterFolder(dir, "broken");
      const v = JSON.parse(await readFile(join(dir, "validation.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(dir, "validation.json"), JSON.stringify({ ...v, passed: false }));
      const registry = make();
      expect((await registry.init()).ignored.map((i) => i.key)).toEqual(["broken"]);
    });

    it("drops state entries whose folder is missing and fails serving sites whose folder broke", async () => {
      await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
      await writeAdapterFolder(join(sitesDir, "beta"), "beta", { validated: false });
      await store.save([
        newSiteState({ key: "alpha", status: "degraded", at: AT }),
        newSiteState({ key: "beta", status: "active", at: AT }),
        newSiteState({ key: "gone", status: "active", at: AT }),
      ]);
      const registry = make();
      const report = await registry.init();
      expect(report.dropped).toEqual(["gone"]);
      expect(report.failed).toEqual(["beta"]);
      expect(registry.get("alpha")?.status).toBe("degraded");
      expect(registry.get("beta")).toMatchObject({ status: "failed", loadable: false });
      expect(registry.get("beta")?.lastFailure).toContain("validation.json is missing");
      expect(registry.get("gone")).toBeUndefined();
      expect((await store.load()).map((s) => s.key)).toEqual(["alpha", "beta"]);
    });

    it("keeps onboarding sites whose folder exists and activates one that was promoted before a crash", async () => {
      await mkdir(join(sitesDir, "newsite"), { recursive: true });
      await writeAdapterFolder(join(sitesDir, "swapped"), "swapped");
      await store.save([
        newSiteState({ key: "newsite", status: "onboarding", at: AT, provisionalHostnames: ["newsite.com"] }),
        newSiteState({ key: "swapped", status: "onboarding", at: AT }),
      ]);
      const registry = make();
      const report = await registry.init();
      expect(report.activated).toEqual(["swapped"]);
      expect(registry.get("newsite")).toMatchObject({
        status: "onboarding",
        loadable: false,
        hostnames: ["newsite.com"],
      });
      expect(registry.get("swapped")).toMatchObject({ status: "active", loadable: true });
    });

    it("ignores an unregistered folder whose hostname another site owns", async () => {
      await writeAdapterFolder(join(sitesDir, "aaa"), "aaa", {
        manifest: manifestFor("aaa", { hostnames: ["shared.com"] }),
      });
      await writeAdapterFolder(join(sitesDir, "bbb"), "bbb", {
        manifest: manifestFor("bbb", { hostnames: ["www.shared.com"] }),
      });
      const registry = make();
      const report = await registry.init();
      expect(report.registered).toEqual(["aaa"]);
      expect(report.ignored[0]?.reason).toContain("already registered as aaa");
    });
  });

  describe("hostname ownership (Add)", () => {
    it("rejects an Add whose hostname belongs to a registered site", async () => {
      await writeAdapterFolder(join(sitesDir, "reuters"), "reuters", {
        manifest: manifestFor("reuters", { hostnames: ["www.reuters.com"] }),
      });
      const registry = make();
      await registry.init();
      expect(registry.checkAddHostname("https://reuters.com/world/some-article")).toEqual({
        ok: false,
        hostname: "reuters.com",
        key: "reuters",
        message: "already registered as reuters; use Repair or Remove",
      });
      expect(registry.checkAddHostname("blog.naver.com")).toEqual({ ok: true, hostname: "blog.naver.com" });
      await expect(registry.registerOnboarding({ hostnames: ["www.reuters.com"] })).rejects.toThrow(
        "already registered as reuters; use Repair or Remove",
      );
    });

    it("registers an Add as onboarding with the derived key and provisional hostname, and owns it", async () => {
      const registry = make();
      await registry.init();
      const site = await registry.registerOnboarding({ hostnames: ["https://blog.naver.com/some/post"] });
      expect(site).toMatchObject({
        key: "blog-naver",
        status: "onboarding",
        loadable: false,
        hostnames: ["blog.naver.com"],
      });
      expect((await stat(join(sitesDir, "blog-naver"))).isDirectory()).toBe(true);
      expect(registry.checkAddHostname("blog.naver.com")).toMatchObject({ ok: false, key: "blog-naver" });
      await expect(
        registry.registerOnboarding({ hostnames: ["other.com"], key: "blog-naver" }),
      ).rejects.toThrow(/already registered/);
      // Survives a restart: the folder exists, so the state entry is kept.
      const again = make();
      await again.init();
      expect(again.get("blog-naver")?.status).toBe("onboarding");
    });

    it("a derived key skips an unregistered folder that already holds files", async () => {
      await writeAdapterFolder(join(sitesDir, "example"), "example", { validated: false });
      const registry = make();
      await registry.init();
      expect((await registry.registerOnboarding({ hostnames: ["example.com"] })).key).toBe("example-2");
    });

    it("onboarding failure and Retry", async () => {
      const registry = make();
      await registry.init();
      await registry.registerOnboarding({ hostnames: ["example.org"] });
      expect((await registry.markOnboardingFailed("example", "no article text found")).status).toBe("failed");
      expect(registry.get("example")?.lastFailure).toBe("no article text found");
      expect((await registry.markOnboarding("example")).status).toBe("onboarding");
    });

    it("findByHostname uses the manifest hostnames, www-insensitively", async () => {
      await writeAdapterFolder(join(sitesDir, "news"), "news", {
        manifest: manifestFor("news", { hostnames: ["news.com"], extraAllowedHosts: ["login.news-sso.com"] }),
      });
      const registry = make();
      await registry.init();
      expect(registry.findByHostname("WWW.news.com")?.key).toBe("news");
      expect(registry.findByHostname("login.news-sso.com")).toBeUndefined();
    });
  });

  describe("live outcome feedback", () => {
    let registry: SiteRegistryService;
    beforeEach(async () => {
      await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
      registry = make();
      await registry.init();
      await cache.set("read", "alpha:1", "doc", { ttlMs: 60_000, sites: ["alpha"] });
    });

    it("auth_required → needs_login at once with the cache cleared", async () => {
      await registry.recordOutcome("alpha", { status: "auth_required", message: "login wall" });
      expect(registry.get("alpha")).toMatchObject({ status: "needs_login", lastFailure: "login wall" });
      expect(await cache.get("read", "alpha:1")).toBeUndefined();
      expect((await store.load())[0]?.status).toBe("needs_login");
    });

    it("three consecutive adapter_errors → degraded; timeout/browser_unavailable change nothing", async () => {
      await registry.recordOutcome("alpha", { status: "adapter_error", message: "e1" });
      await registry.recordOutcome("alpha", { status: "timeout", message: "slow" });
      await registry.recordOutcome("alpha", { status: "browser_unavailable", message: "aside down" });
      await registry.recordOutcome("alpha", { status: "adapter_error", message: "e2" });
      expect(registry.get("alpha")?.status).toBe("active");
      await registry.recordOutcome("alpha", { status: "adapter_error", message: "e3" });
      expect(registry.get("alpha")).toMatchObject({ status: "degraded", lastFailure: "e3" });
      expect(await cache.get("read", "alpha:1")).toBe("doc");
    });

    it("only rate_limited starts the scheduler cool-down; a paywall or a flagged block page does not", async () => {
      await registry.recordOutcome("alpha", { status: "access_denied", message: "paywall" });
      await registry.recordOutcome("alpha", { status: "access_denied", message: "captcha", blocked: true });
      expect(cooldowns).toEqual([]);
      await registry.recordOutcome("alpha", { status: "rate_limited", message: "429" });
      expect(cooldowns.map((c) => c.site)).toEqual(["alpha"]);
      expect(registry.get("alpha")?.status).toBe("active");
    });

    it("does not extend a running cool-down (refused calls also report rate_limited)", async () => {
      const set: number[] = [];
      let until: number | null = null;
      const reg = new SiteRegistryService({
        sitesDir,
        stateStore: store,
        loader: new ModuleAdapterLoader({ repoRoot: process.cwd(), preferCompiled: false }),
        scheduler: {
          setCooldown: (_site, u) => {
            set.push(u);
            until = u;
          },
          cooldownUntil: () => until,
        },
        logger: silentLogger,
      });
      await reg.init();
      await reg.recordOutcome("alpha", { status: "rate_limited" });
      await reg.recordOutcome("alpha", { status: "rate_limited" });
      expect(set).toHaveLength(1);
    });

    it("health check: auth_required → needs_login; pass → active with the cache cleared", async () => {
      expect(
        (await registry.recordHealthCheck("alpha", { status: "auth_required", message: "wall" })).status,
      ).toBe("needs_login");
      await cache.set("read", "alpha:2", "doc2", { ttlMs: 60_000, sites: ["alpha"] });
      const after = await registry.recordHealthCheck("alpha", { status: "ok" });
      expect(after).toMatchObject({ status: "active", lastFailure: null });
      expect(after.lastLoginConfirmedAt).not.toBeNull();
      expect(after.lastCheckedAt).not.toBeNull();
      expect(await cache.get("read", "alpha:2")).toBeUndefined();
    });

    it("ignores outcomes for unknown sites", async () => {
      await expect(registry.recordOutcome("nope", { status: "auth_required" })).resolves.toBeUndefined();
    });
  });

  describe("loading and hot reload", () => {
    it("imports the adapter with a version stamp and re-imports the new code on reload", async () => {
      const dir = join(sitesDir, "alpha");
      await writeAdapterFolder(dir, "alpha", { adapter: adapterSource("v1") });
      const registry = make();
      await registry.init();
      const first = await registry.load("alpha");
      expect((first?.adapter as unknown as { tag: string }).tag).toBe("v1");
      expect(await registry.load("alpha")).toBe(first);

      await writeAdapterFolder(dir, "alpha", { adapter: adapterSource("v2") });
      await registry.reload("alpha");
      const second = await registry.load("alpha");
      expect((second?.adapter as unknown as { tag: string }).tag).toBe("v2");
      expect(second?.version).not.toBe(first?.version);
    });

    it("refuses to load an adapter that fails the static check, as adapter_error", async () => {
      await writeAdapterFolder(join(sitesDir, "evil"), "evil", {
        adapter:
          'import { readFileSync } from "fs";\nexport default { search() {}, read() {}, smokeTest() {}, f: readFileSync };\n',
      });
      const registry = make();
      await registry.init();
      await expect(registry.load("evil")).rejects.toMatchObject({ status: "adapter_error" });
      expect((await registry.load("evil").catch((e: Error) => e.message)) as string).toContain(
        "node-builtin-import",
      );
    });

    it("still loads needs_login sites (reads are attempted for needs_login and degraded)", async () => {
      await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
      const registry = make();
      await registry.init();
      await registry.recordOutcome("alpha", { status: "auth_required" });
      expect(await registry.load("alpha")).toBeDefined();
    });

    it("unregister removes state, the loaded adapter, and the cache entries", async () => {
      await writeAdapterFolder(join(sitesDir, "alpha"), "alpha");
      const registry = make();
      await registry.init();
      await cache.set("read", "alpha:1", "doc", { ttlMs: 60_000, sites: ["alpha"] });
      expect(await registry.unregister("alpha")).toBe(true);
      expect(registry.get("alpha")).toBeUndefined();
      expect(await registry.load("alpha")).toBeUndefined();
      expect(await cache.get("read", "alpha:1")).toBeUndefined();
      await rm(join(sitesDir, "alpha"), { recursive: true });
      expect(await store.load()).toEqual([]);
    });
  });
});
