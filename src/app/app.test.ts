/** Composition root wiring: a real public listener on a loopback port, fake browser, stub helpers. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import { fakeBrowser, makeTempDir, writeAdapterFolder } from "../../test/support/site-fixtures.js";
import { createApp } from "./app.js";
import type { BridgeApp } from "./app.js";
import { loadConfig } from "./config.js";

let bridge: BridgeApp | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await bridge?.stop();
  await cleanup?.();
  bridge = null;
  cleanup = null;
});

async function makeBridge(): Promise<{
  bridge: BridgeApp;
  logger: MemoryLogger;
  browser: ReturnType<typeof fakeBrowser>;
}> {
  const tmp = await makeTempDir("brb-app-");
  cleanup = tmp.cleanup;
  await mkdir(join(tmp.dir, "sites"), { recursive: true });
  await writeAdapterFolder(join(tmp.dir, "sites", "alpha"), "alpha");
  const config = loadConfig({
    env: { BRIDGE_PASSPHRASE: "a passphrase for tests", BRIDGE_DATA_DIR: join(tmp.dir, "data") },
    rootDir: tmp.dir,
  });
  const logger = new MemoryLogger();
  const browser = fakeBrowser();
  bridge = createApp({ config, helpers: stubHelpers, logger, browser, repoRoot: process.cwd() });
  return { bridge, logger, browser };
}

describe("createApp", () => {
  it("starts the public listener on 127.0.0.1 with only /mcp and the OAuth routes, then stops", async () => {
    const { bridge, logger } = await makeBridge();
    const events: string[] = [];
    bridge.attach({
      name: "admin",
      start: async () => {
        events.push("admin start");
        return { hostname: "127.0.0.1", port: 1, url: "http://127.0.0.1:1", close: async () => undefined };
      },
      stop: async () => {
        events.push("admin stop");
      },
    });
    const started = await bridge.start({ publicPort: 0, probeBrowser: false });
    expect(started.public.hostname).toBe("127.0.0.1");
    expect(started.resource).toBe(`http://localhost:${bridge.services.config.publicPort}/mcp`);
    expect(started.listeners).toEqual([{ name: "admin", url: "http://127.0.0.1:1" }]);
    expect(started.reconcile.registered).toEqual(["alpha"]);
    expect(bridge.services.registry.list().map((s) => [s.key, s.status])).toEqual([["alpha", "active"]]);

    const base = started.public.url;
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="/);
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { issuer: string }).issuer).toBe(bridge.services.config.publicUrl);
    expect((await fetch(`${base}/anything`)).status).toBe(404);

    await bridge.stop();
    expect(events).toEqual(["admin start", "admin stop"]);
    await expect(fetch(`${base}/mcp`)).rejects.toThrow();
    expect(logger.lines.some((l) => l.includes('"path":"/anything"') && l.includes('"status":404'))).toBe(
      true,
    );
  });

  it("refuses attach after start and a second start", async () => {
    const { bridge } = await makeBridge();
    await bridge.start({ publicPort: 0, probeBrowser: false });
    expect(() =>
      bridge.attach({ name: "late", start: async () => undefined, stop: async () => undefined }),
    ).toThrow();
    await expect(bridge.start({ publicPort: 0 })).rejects.toThrow(/already started/);
  });

  it("stops the public listener again when an attached listener fails to start", async () => {
    const { bridge, browser } = await makeBridge();
    bridge.attach({
      name: "admin",
      start: async () => {
        throw new Error("EADDRINUSE");
      },
      stop: async () => undefined,
    });
    let shutdowns = 0;
    browser.shutdown = async () => {
      shutdowns += 1;
    };
    await expect(bridge.start({ publicPort: 0, probeBrowser: false })).rejects.toThrow("EADDRINUSE");
    expect(shutdowns).toBe(1);
  });
});
