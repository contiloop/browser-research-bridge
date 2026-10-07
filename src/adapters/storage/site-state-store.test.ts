import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { newSiteState } from "../../core/lifecycle.js";
import { FileSiteStateStore, siteStatePath } from "./site-state-store.js";

describe("FileSiteStateStore (data/sites.json)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => tmp.cleanup());

  it("is empty before the file exists and round-trips entries sorted by key", async () => {
    const store = new FileSiteStateStore(siteStatePath(join(tmp.dir, "data")));
    expect(await store.load()).toEqual([]);
    const at = "2026-10-05T10:00:00.000Z";
    const b = newSiteState({ key: "blog-naver", status: "needs_login", at });
    const a = newSiteState({ key: "aa", status: "onboarding", at, provisionalHostnames: ["aa.com"] });
    await store.save([b, a]);
    expect(await store.load()).toEqual([a, b]);
    const raw = JSON.parse(await readFile(store.filePath, "utf8")) as {
      version: number;
      sites: { key: string }[];
    };
    expect(raw.version).toBe(1);
    expect(raw.sites.map((s) => s.key)).toEqual(["aa", "blog-naver"]);
  });

  it("drops malformed and duplicate entries", async () => {
    const store = new FileSiteStateStore(join(tmp.dir, "sites.json"));
    const ok = newSiteState({ key: "ok-site", status: "active", at: "2026-10-05T10:00:00.000Z" });
    await writeFile(
      store.filePath,
      JSON.stringify({ version: 1, sites: [ok, { key: "x", status: "weird" }, ok] }),
    );
    expect(await store.load()).toEqual([ok]);
  });

  it("refuses an unknown file version", async () => {
    const store = new FileSiteStateStore(join(tmp.dir, "sites.json"));
    await writeFile(store.filePath, JSON.stringify({ version: 9, sites: [] }));
    await expect(store.load()).rejects.toThrow(/unsupported/);
  });
});
