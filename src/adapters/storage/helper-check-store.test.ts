import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test/support/site-fixtures.js";
import { FileHelperCheckStore, MAX_HELPER_CHECK_MESSAGE, helperCheckPath } from "./helper-check-store.js";

describe("FileHelperCheckStore (data/helper-check.json)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => tmp.cleanup());

  const record = {
    at: "2026-10-08T01:02:03.000Z",
    runtime: "claude",
    result: "ok",
    message: "round trip passed",
  };

  it("is null before the file exists and round-trips the last record, owner-only", async () => {
    const store = new FileHelperCheckStore(helperCheckPath(join(tmp.dir, "data")));
    expect(store.filePath).toBe(join(tmp.dir, "data", "helper-check.json"));
    expect(await store.load()).toBeNull();
    await store.save(record);
    expect(await store.load()).toEqual(record);
    const raw = JSON.parse(await readFile(store.filePath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ version: 1, ...record });
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(tmp.dir, "data"))).mode & 0o777).toBe(0o700);

    // The last save wins; a null runtime (nothing was available) is kept as null.
    const none = { at: "2026-10-08T02:00:00.000Z", runtime: null, result: "not_installed", message: null };
    await store.save(none);
    expect(await new FileHelperCheckStore(store.filePath).load()).toEqual(none);
  });

  it("clips a long runtime message", async () => {
    const store = new FileHelperCheckStore(join(tmp.dir, "helper-check.json"));
    await store.save({ ...record, result: "failed", message: "x".repeat(MAX_HELPER_CHECK_MESSAGE + 500) });
    expect((await store.load())?.message).toHaveLength(MAX_HELPER_CHECK_MESSAGE);
  });

  it("reads a malformed file, an unknown version, or a wrong field type as no record", async () => {
    const store = new FileHelperCheckStore(join(tmp.dir, "helper-check.json"));
    for (const text of [
      "{ not json",
      JSON.stringify([record]),
      JSON.stringify({ version: 2, ...record }),
      JSON.stringify({ version: 1, ...record, at: 7 }),
      JSON.stringify({ version: 1, ...record, runtime: 3 }),
      JSON.stringify({ version: 1, ...record, result: null }),
      JSON.stringify({ version: 1, ...record, message: {} }),
    ]) {
      await writeFile(store.filePath, text);
      expect(await store.load(), text).toBeNull();
    }
  });
});
