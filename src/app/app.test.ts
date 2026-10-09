/** Composition root wiring: a real public listener on a loopback port, fake browser, stub helpers. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubHelpers } from "../../test/support/mcp-fixtures.js";
import { MemoryLogger } from "../../test/support/oauth-harness.js";
import {
  challengeAttempt,
  fakeBrowser,
  makeTempDir,
  writeAdapterFolder,
} from "../../test/support/site-fixtures.js";
import type { FakeSolver } from "../../test/support/site-fixtures.js";
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

async function makeBridge(
  options: { bridgeJson?: Record<string, unknown>; solveChallenge?: FakeSolver } = {},
): Promise<{
  bridge: BridgeApp;
  logger: MemoryLogger;
  browser: ReturnType<typeof fakeBrowser>;
}> {
  const tmp = await makeTempDir("brb-app-");
  cleanup = tmp.cleanup;
  await mkdir(join(tmp.dir, "sites"), { recursive: true });
  await writeAdapterFolder(join(tmp.dir, "sites", "alpha"), "alpha");
  if (options.bridgeJson !== undefined) {
    await mkdir(join(tmp.dir, "config"), { recursive: true });
    await writeFile(join(tmp.dir, "config", "bridge.json"), JSON.stringify(options.bridgeJson));
  }
  const config = loadConfig({
    env: { BRIDGE_PASSPHRASE: "a passphrase for tests", BRIDGE_DATA_DIR: join(tmp.dir, "data") },
    rootDir: tmp.dir,
  });
  const logger = new MemoryLogger();
  const browser = fakeBrowser({ solveChallenge: options.solveChallenge });
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

  it("builds the captcha coordinator from the configuration and wires it into the tools", async () => {
    const { bridge } = await makeBridge();
    const { challenges, config } = bridge.services;
    expect(config.captcha.auto).toBe(true);
    expect(challenges.enabled).toBe(true);
    expect(challenges.settings).toEqual({
      auto: true,
      attemptBudgetMs: config.tunables.captchaAttemptBudgetMs,
      detectBudgetMs: config.tunables.captchaDetectBudgetMs,
      rerunReserveMs: config.tunables.captchaRerunReserveMs,
    });
    expect(challenges.settings.detectBudgetMs).toBe(20_000);
    expect(Object.keys(challenges.settings)).not.toContain("inlineMinRemainingMs");
  });

  it("passes a configured captchaDetectBudgetMs to the coordinator; the retired inline minimum is ignored", async () => {
    const { bridge } = await makeBridge({
      bridgeJson: { tunables: { captchaDetectBudgetMs: 8_000, captchaInlineMinRemainingMs: 40_000 } },
    });
    const { challenges, config } = bridge.services;
    expect(challenges.settings.detectBudgetMs).toBe(8_000);
    expect(config.warnings).toContain('unknown tunable "captchaInlineMinRemainingMs" ignored');
  });

  it("captcha.auto false turns the attempts off", async () => {
    const { bridge, browser } = await makeBridge({
      bridgeJson: { captcha: { auto: false } },
      solveChallenge: async () => challengeAttempt(),
    });
    expect(bridge.services.challenges.enabled).toBe(false);
    expect((await bridge.services.challenges.attempt("alpha", null)).ran).toBe(false);
    expect(browser.challenges).toEqual([]);
  });

  it("stopping the core abandons a running background attempt", async () => {
    let aborted = false;
    const { bridge, browser } = await makeBridge({
      solveChallenge: (o) =>
        new Promise((resolve) => {
          o.scope.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve(challengeAttempt({ solved: false, rounds: 0 }));
            },
            { once: true },
          );
        }),
    });
    await bridge.start({ publicPort: 0, probeBrowser: false });
    expect(bridge.services.challenges.background("alpha", null)).toBe(true);
    // The attempt reaches the port once the adapter is loaded.
    for (let i = 0; i < 200 && browser.challenges.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(browser.challenges).toHaveLength(1);
    await bridge.stop();
    await bridge.services.challenges.settled();
    expect(aborted).toBe(true);
    expect(bridge.services.challenges.background("alpha", null)).toBe(false);
  });
});
