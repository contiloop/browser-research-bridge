/**
 * The bridge process: the settings page (dashboard listener, started once, loopback only) plus the
 * core under run-mode control. The page's source carries the run-mode control, the settings store,
 * the settings-page support (`settings-page.ts`), and the ChatGPT connection service. Order: settings-page location from the store → bind the settings
 * page (a bind failure throws: main.ts exits 1) → attempt the core start (a configuration or start
 * problem leaves the process up in `setup`). `main.ts` adds the adapter helpers, the console
 * logger, and the signal handlers; tests call this with a fake browser and port 0.
 */
import { adminTokenPath, createAdminListener } from "../adapters/dashboard/index.js";
import type { AdminListener, DashboardSource } from "../adapters/dashboard/index.js";
import type { ConnectionTool } from "../ports/connection-tool.js";
import type { Logger } from "../ports/logger.js";
import type { EnvironmentMap } from "../ports/settings-store.js";
import type { BridgeApp } from "./app.js";
import { ChatgptConnectionService, createConfigTargetResolver } from "./chatgpt-connection.js";
import type { BridgeConfig } from "./config.js";
import type { RunningListener } from "./public-server.js";
import { RunModeController } from "./run-mode.js";
import { createSettingsPageSupport } from "./settings-page.js";
import type { BridgeSettingsStore } from "./settings.js";

export interface StartBridgeProcessOptions {
  /** Built once at process start, before anything changes `process.env`. */
  store: BridgeSettingsStore;
  logger: Logger;
  /** Builds a new, unstarted core for a configuration (production: `createApp`). */
  createCore: (config: BridgeConfig) => BridgeApp;
  repoRoot: string;
  /** Overrides the settings page's port (0 = any free port; tests). */
  adminPort?: number | undefined;
  /** Overrides the public port of every core start (0 = any free port; tests). */
  publicPort?: number | undefined;
  /** Probe the browser after each core start (default true). */
  probeBrowser?: boolean | undefined;
  /**
   * The ChatGPT connection tool (production: `TunnelClientConnectionTool`). When given, the ChatGPT
   * connection service is built and its hooks are registered before the first core start.
   */
  connectionTool?: ConnectionTool | undefined;
  /**
   * Where the public side's address (and the settings page's read-only information) is read from
   * when the configuration does not load because of the passphrase (setup mode): the start
   * environment and the project root.
   */
  chatgptTargetFallback?:
    { env: EnvironmentMap; rootDir: string; configPath?: string | undefined } | undefined;
  /** Tunable tunnel-service address prefix (default in `chatgpt-connection.ts`). */
  tunnelResourcePrefix?: string | undefined;
}

export interface BridgeProcess {
  readonly controller: RunModeController;
  readonly settings: BridgeSettingsStore;
  /** The ChatGPT connection service (`GET/POST/DELETE chatgpt…`), or null without a connection tool. */
  readonly chatgpt: ChatgptConnectionService | null;
  /** Where the settings page listens. */
  readonly dashboard: RunningListener;
  readonly tokenFile: string;
  /** The one-time sign-in link (`http://127.0.0.1:<port>/?token=…`) while the settings page runs. */
  openUrl(): string | null;
  /** Graceful shutdown: the core (through the controller), then the settings page. Idempotent. */
  stop(): Promise<void>;
}

export async function startBridgeProcess(options: StartBridgeProcessOptions): Promise<BridgeProcess> {
  const { store, logger } = options;
  const location = store.pageLocation();
  const controller = new RunModeController({
    settings: store,
    createCore: options.createCore,
    logger,
    startOptions: { publicPort: options.publicPort, probeBrowser: options.probeBrowser },
  });
  // Before the first start, so a managed connection tool starts with the first core.
  const chatgpt =
    options.connectionTool === undefined
      ? null
      : new ChatgptConnectionService({
          tool: options.connectionTool,
          settings: store,
          controller,
          target: createConfigTargetResolver({ store, fallback: options.chatgptTargetFallback }),
          logger,
          tunnelResourcePrefix: options.tunnelResourcePrefix,
        });
  const source: DashboardSource = {
    logger,
    location,
    core: () => controller.services(),
    runMode: controller,
    settings: store,
    settingsPage: createSettingsPageSupport({ store, fallback: options.chatgptTargetFallback }),
    chatgpt,
  };
  const listener: AdminListener = createAdminListener(source, {
    port: options.adminPort,
    repoRoot: options.repoRoot,
    // The link is printed in the process banner instead.
    print: () => undefined,
  });
  const dashboard = await listener.start();
  if (!dashboard) throw new Error("the settings page did not report where it listens");

  await controller.start();

  let stopping: Promise<void> | null = null;
  return {
    controller,
    settings: store,
    chatgpt,
    dashboard,
    tokenFile: adminTokenPath(location.dataDir),
    openUrl: () => listener.openUrl(),
    stop: () =>
      (stopping ??= (async () => {
        await controller.stop();
        await listener.stop();
      })()),
  };
}

/** The startup banner: the mode (with the reason in setup), the core's addresses when running, the settings-page link. */
export function processBanner(proc: BridgeProcess): string {
  const status = proc.controller.status();
  const core = proc.controller.current();
  const lines: string[] = [];
  if (status.mode === "running" && core !== null) {
    const { started, config } = core;
    lines.push(
      "Browser Research Bridge is running",
      `  public listener : ${started.public.url} (loopback; expose it through the tunnel)`,
      started.publicUrlConfigured
        ? `  public URL      : ${started.publicUrl}`
        : `  public URL      : ${started.publicUrl} (PUBLIC_URL is not set: only local clients can complete OAuth)`,
      `  MCP server URL  : ${started.resource} (OAuth protected resource; add this URL as the connector)`,
      `  Aside account   : ${config.asideAccount}`,
      `  sites           : ${core.services.registry.list().length} registered`,
    );
  } else if (status.mode === "setup" && status.problem !== null) {
    lines.push(
      "Browser Research Bridge is in setup mode: only the settings page runs (no public listener)",
      `  reason          : ${status.problem.code}: ${status.problem.message}`,
      "  Open the settings page below to fix it.",
    );
  } else {
    lines.push(`Browser Research Bridge: ${status.mode}`);
  }
  lines.push(
    `  settings page   : ${proc.openUrl() ?? proc.dashboard.url}`,
    "                    (loopback only; open this link in a browser on this Mac; it sets a cookie",
    "                    and is valid until the bridge process restarts)",
    `  token file      : ${proc.tokenFile}`,
  );
  return lines.join("\n");
}
