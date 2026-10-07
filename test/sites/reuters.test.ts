/**
 * Unit tests of the reference adapter (Reuters): search verdicts with a scripted browser session (the
 * page script's result is given) and the folder's integrity (static check, manifest, validation.json
 * matching the files). The live behavior is validated by `npm run site:validate -- reuters`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdapterHelpers } from "../../src/adapter-kit/helpers.js";
import { checkPageScript, shadowParams } from "../../src/adapters/aside/shim.js";
import { readManifest } from "../../src/adapters/registry/folders.js";
import { computeAdapterHash, readValidationReport } from "../../src/adapters/validation/report.js";
import {
  defaultStaticCheckPaths,
  staticCheckAdapterDir,
} from "../../src/adapters/validation/static-check.js";
import type { BrowserSession } from "../../src/ports/browser.js";
import type { AdapterContext } from "../../src/ports/adapter.js";
import adapter from "../../sites/reuters/adapter.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const dir = join(repoRoot, "sites", "reuters");

const API_BODY = JSON.stringify({
  result: {
    pagination: { total_size: 1 },
    articles: [
      {
        canonical_url: "/markets/europe/some-story-2026-09-18/",
        title: "Some story",
        description: "d",
        display_time: "2026-09-18T10:00:00Z",
        authors: [{ name: "A. Writer" }],
      },
    ],
  },
});

const scripts: string[] = [];

async function ctxWith(scriptResult: unknown): Promise<AdapterContext> {
  const { manifest } = await readManifest(dir);
  if (manifest === null) throw new Error("reuters manifest missing");
  const browser = {
    scope: { siteKey: "reuters", hostnames: ["www.reuters.com"] },
    openTab: async (url: string) => ({ id: "t", url }),
    closeTab: async () => undefined,
    snapshot: async () => "",
    runScript: async (script: string) => {
      scripts.push(script);
      return scriptResult;
    },
    fetch: async () => {
      throw new Error("not used");
    },
    screenshot: async () => ({ mimeType: "image/png" as const, base64: "" }),
    dispose: async () => undefined,
  } as unknown as BrowserSession;
  return {
    browser,
    helpers: createAdapterHelpers(),
    manifest,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => new Date("2026-10-06T00:00:00Z"),
  };
}

const request = { text: "inflation", limit: 10, cursor: null, after: null, before: null };

describe("reuters search", () => {
  it("returns results when the search page shows the signed-in account control", async () => {
    const res = await adapter.search(request, await ctxWith({ status: 200, text: API_BODY, signedIn: true }));
    expect(res.status).toBe("ok");
    expect(res.status === "ok" ? res.results.length : 0).toBe(1);
    // The search page script passes the port's static page-script check.
    expect(checkPageScript(scripts.at(-1) ?? "", shadowParams())).toMatchObject({ ok: true });
  });

  it("reports auth_required with the login action when the signed-in marker is absent", async () => {
    const res = await adapter.search(
      request,
      await ctxWith({ status: 200, text: API_BODY, signedIn: false }),
    );
    expect(res).toMatchObject({
      status: "auth_required",
      message: "Reuters is not signed in in Aside",
      action: "Log in to reuters.com in Aside (account u0), then retry",
    });
  });
});

describe("reuters folder", () => {
  it("passes the static check", async () => {
    const result = await staticCheckAdapterDir(defaultStaticCheckPaths(repoRoot, dir));
    expect(result.violations).toEqual([]);
    expect(result.files).toEqual(["adapter.ts"]);
  });

  it("has a valid manifest whose key matches the folder", async () => {
    const { manifest, error } = await readManifest(dir);
    expect(error).toBeNull();
    expect(manifest).toMatchObject({ key: "reuters", requiresLogin: true });
  });

  it("carries a passed full validation.json for exactly these files (re-run site:validate after edits)", async () => {
    const report = await readValidationReport(dir);
    expect(report).toMatchObject({
      key: "reuters",
      form: "full",
      passed: true,
      gatedCheck: "passed",
    });
    expect(report?.adapterHash).toBe(await computeAdapterHash(dir));
  });
});
