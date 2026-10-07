/**
 * Test fixtures for registry/validation tests: adapter folders in real temp directories, a fake
 * browser port (sessions only; no site behavior), and helpers. Real validation never uses these.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAdapterHash, writeValidationReport } from "../../src/adapters/validation/report.js";
import type { ValidationReport } from "../../src/adapters/validation/report.js";
import type { BrowserPort, BrowserScope, BrowserSession } from "../../src/ports/browser.js";
import type { Logger } from "../../src/ports/logger.js";

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export async function makeTempDir(prefix = "brb-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export function manifestFor(key: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    name: key.toUpperCase(),
    hostnames: [`${key}.example.com`],
    timezone: "UTC",
    capabilities: { search: true, read: true },
    sampleQuery: "sample",
    createdBy: "human",
    ...patch,
  };
}

/** A minimal adapter module; `tag` lets tests see which version is loaded. */
export function adapterSource(tag: string, extra = ""): string {
  return `const tag: string = ${JSON.stringify(tag)};
export default {
  tag,
  async search() { return { results: [], nextCursor: null, status: "empty" as const }; },
  async read() { return { status: "unsupported" as const, message: tag }; },
  async smokeTest() { return { status: "ok" as const }; },
  ${extra}
};
`;
}

export function passedReport(
  key: string,
  adapterHash: string | null,
  target: "live" | "staging" = "live",
): ValidationReport {
  const at = "2026-10-05T10:00:00.000Z";
  return {
    version: 1,
    key,
    form: "full",
    target,
    passed: true,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    adapterHash,
    manifestVersion: 1,
    gatedCheck: "not_applicable",
    failure: null,
    steps: [],
  };
}

export interface FolderOptions {
  manifest?: Record<string, unknown> | null;
  adapter?: string | null;
  /** Write a passed validation.json (with the files' hash). */
  validated?: boolean;
}

/** Writes `dir` as an adapter folder. */
export async function writeAdapterFolder(
  dir: string,
  key: string,
  options: FolderOptions = {},
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const manifest = options.manifest === undefined ? manifestFor(key) : options.manifest;
  if (manifest !== null)
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const adapter = options.adapter === undefined ? adapterSource("v1") : options.adapter;
  if (adapter !== null) await writeFile(join(dir, "adapter.ts"), adapter);
  if (options.validated !== false && manifest !== null && adapter !== null) {
    const target = dir.endsWith(".staging") ? "staging" : "live";
    await writeValidationReport(dir, passedReport(key, await computeAdapterHash(dir), target));
  }
}

export interface FakeBrowser extends BrowserPort {
  scopes: BrowserScope[];
  disposed: number;
}

/** A browser port whose sessions do nothing; adapters under test never call it. */
export function fakeBrowser(): FakeBrowser {
  const port: FakeBrowser = {
    scopes: [],
    disposed: 0,
    async status() {
      return { reachable: true, account: "u0" };
    },
    async openSession(scope: BrowserScope): Promise<BrowserSession> {
      port.scopes.push(scope);
      const unsupported = (): never => {
        throw new Error("fake browser: no site behavior");
      };
      return {
        scope,
        openTab: async () => unsupported(),
        closeTab: async () => undefined,
        snapshot: async () => unsupported(),
        runScript: async () => unsupported(),
        fetch: async () => unsupported(),
        screenshot: async () => unsupported(),
        dispose: async () => {
          port.disposed += 1;
        },
      };
    },
    async shutdown() {},
  };
  return port;
}
