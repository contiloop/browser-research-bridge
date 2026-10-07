/**
 * Bridge entry point (`npm start`, `npm run dev`, the launchd agent). Builds the settings store
 * (once, before anything changes `process.env`), starts the settings page on
 * 127.0.0.1:<adminPort> for the life of the process, then attempts to start the core (browser port,
 * scheduler, cache, registry, OAuth, MCP tools, public listener on 127.0.0.1:<publicPort>, health
 * timer) under run-mode control. A configuration problem (no or short `BRIDGE_PASSPHRASE`, a
 * malformed or invalid setting) or a failed core start does not end the process: it stays up in
 * `setup` with only the settings page, which can fix the settings and restart the core. Exit code 1
 * only when the settings page cannot be bound or the adapter helpers cannot be loaded. SIGINT/SIGTERM
 * shut down gracefully; a second signal exits immediately with code 1.
 *
 * This is the only module that imports the adapter helper package (src/adapter-kit); everything
 * else receives the helpers through `createApp`.
 *
 * The ChatGPT connection tool (`tunnel-client`, from `TUNNEL_CLIENT_BIN`) is built here and handed
 * to the process, whose ChatGPT connection service starts it with the core when the settings mark a
 * program-managed connection (`proc.chatgpt`).
 *
 * Environment (besides config.ts): `ASIDE_CLI` (Aside executable, default `aside`),
 * `BRIDGE_LOG_LEVEL` (debug | info | warn | error, default info).
 */
import { TunnelClientConnectionTool } from "../adapters/tunnel-client/index.js";
import type { AdapterHelpers } from "../ports/adapter.js";
import { createApp, createConsoleLogger, isLogLevel } from "./app.js";
import { processBanner, startBridgeProcess } from "./bridge-process.js";
import type { BridgeProcess } from "./bridge-process.js";
import { createSettingsStore } from "./settings.js";

/** `createAdapterHelpers()` from the adapter helper package (src/adapter-kit). */
async function loadAdapterHelpers(): Promise<AdapterHelpers> {
  const kit = (await import("../adapter-kit/index.js")) as Record<string, unknown>;
  const factory = kit["createAdapterHelpers"];
  if (typeof factory !== "function") {
    throw new Error(
      "src/adapter-kit does not export createAdapterHelpers(); site adapters cannot run without it",
    );
  }
  return (factory as () => AdapterHelpers)();
}

function installShutdown(proc: BridgeProcess, log: (message: string) => void): void {
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) {
      log(`bridge: ${signal} again, exiting immediately`);
      process.exit(1);
    }
    signalled = true;
    log(`bridge: ${signal} received, shutting down`);
    proc.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log(`bridge: shutdown failed: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(): Promise<number> {
  // First: the store snapshots the start environment (which values came from .env, which are locked).
  const repoRoot = process.cwd();
  const store = createSettingsStore({ rootDir: repoRoot, env: process.env });
  const level = process.env["BRIDGE_LOG_LEVEL"];
  const logger = createConsoleLogger({ level: isLogLevel(level) ? level : "info" });

  let helpers: AdapterHelpers;
  try {
    helpers = await loadAdapterHelpers();
  } catch (error) {
    console.error(`bridge: ${(error as Error).message}`);
    return 1;
  }

  const asideCommand = process.env["ASIDE_CLI"];
  // The connection tool's location (`TUNNEL_CLIENT_BIN`) comes from the environment, so it is known
  // even when the configuration does not load (setup mode). One instance for the process: it owns
  // the managed child across core restarts.
  const loaded = store.loadConfig();
  const tunnelClientBin = process.env["TUNNEL_CLIENT_BIN"]?.trim();
  const connectionTool = new TunnelClientConnectionTool({
    binary: loaded.ok
      ? loaded.config.executables.tunnelClient
      : tunnelClientBin === undefined || tunnelClientBin === ""
        ? "tunnel-client"
        : tunnelClientBin,
    logger,
  });
  let proc: BridgeProcess;
  try {
    proc = await startBridgeProcess({
      store,
      logger,
      repoRoot,
      createCore: (config) => createApp({ config, helpers, logger, repoRoot, asideCommand }),
      connectionTool,
      chatgptTargetFallback: { env: process.env, rootDir: repoRoot },
    });
  } catch (error) {
    // Only the settings page's bind can fail here; core problems end in setup mode instead.
    console.error(`bridge: cannot start the settings page: ${(error as Error).message}`);
    return 1;
  }
  installShutdown(proc, (message) => console.error(message));
  console.log(processBanner(proc));
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
