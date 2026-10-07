/**
 * Admin listener: the dashboard app (static UI + JSON API) and the listener that binds it to
 * 127.0.0.1:<adminPort>, never to the public listener. A new admin token is issued at every start,
 * written to `data/admin-token` (0600), and printed as a one-time link.
 *
 * In the bridge process the listener is started once and outlives the core: it is built from a
 * {@link DashboardSource} whose `core()` returns the running core's services or null, so the token
 * and cookie stay valid across core restarts. Passing plain `DashboardDeps` binds it to one core.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BridgeListener } from "../../app/app.js";
import { requestLog, startListener } from "../../app/public-server.js";
import type { ListenOptions, RunningListener } from "../../app/public-server.js";
import { createApi } from "./api.js";
import { toDashboardSource } from "./deps.js";
import type { DashboardDeps, DashboardSource } from "./deps.js";
import {
  ADMIN_BIND_HOST,
  adminTokenPath,
  assertLoopbackBind,
  generateAdminToken,
  originGuard,
  removeAdminToken,
  requireCookieForReads,
  securityHeaders,
  tokenExchange,
  writeAdminToken,
} from "./security.js";

const UI_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/labels.js": { file: "labels.js", type: "text/javascript; charset=utf-8" },
  "/instructions.js": { file: "instructions.js", type: "text/javascript; charset=utf-8" },
  "/state.js": { file: "state.js", type: "text/javascript; charset=utf-8" },
};

/** The static UI paths (a fixed list; nothing else under `/` is served from disk). */
export const UI_PATHS: readonly string[] = Object.keys(UI_FILES);

/** `src/adapters/dashboard/ui/` next to this module, else under the repository root (built output). */
export function defaultUiDir(repoRoot?: string): string {
  const local = fileURLToPath(new URL("./ui/", import.meta.url));
  if (existsSync(join(local, "index.html")) || repoRoot === undefined) return local;
  return join(repoRoot, "src", "adapters", "dashboard", "ui");
}

export interface AdminAppOptions {
  /** The per-launch admin token. */
  token: string;
  /** The listener's port (a function: the real port is known after binding). */
  port: () => number;
  /** Directory holding the UI files (index.html, app.css, and the ES modules). */
  uiDir: string;
  /** Shown in the overview (never the token itself). */
  tokenFile: string;
  ssePingMs?: number | undefined;
}

export function createAdminApp(deps: DashboardDeps | DashboardSource, options: AdminAppOptions): Hono {
  const source = toDashboardSource(deps);
  const guard = { token: options.token, port: options.port };
  const app = new Hono();
  app.use("*", requestLog(source.logger, "admin"));
  app.use("*", securityHeaders());
  app.use("*", originGuard(guard));
  app.use("*", tokenExchange(guard));
  app.use("*", requireCookieForReads(guard));
  app.use("/api/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));
  app.route(
    "/api",
    createApi(source, {
      adminOrigin: () => `http://${ADMIN_BIND_HOST}:${options.port()}`,
      tokenFile: options.tokenFile,
      ssePingMs: options.ssePingMs,
      adminPort: options.port,
    }),
  );
  for (const [path, asset] of Object.entries(UI_FILES)) {
    app.get(path, async (c) => {
      const body = await readFile(join(options.uiDir, asset.file), "utf8");
      return c.body(body, 200, { "Content-Type": asset.type });
    });
  }
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    source.logger.error("dashboard request failed", { path: c.req.path, error: error.message });
    return c.json({ error: "server_error" }, 500);
  });
  return app;
}

export type Listen = (
  app: { fetch: (request: Request) => Response | Promise<Response> },
  options: ListenOptions,
) => Promise<RunningListener>;

export interface AdminListenerOptions {
  /** Overrides `config.adminPort` (0 = any free port; tests). */
  port?: number | undefined;
  /** Must be 127.0.0.1 (the default); anything else is refused. */
  hostname?: string | undefined;
  /** Binds the app (default `startListener`). */
  listen?: Listen | undefined;
  /** Where the one-time link is printed (default stdout). */
  print?: ((text: string) => void) | undefined;
  /** Default: ./ui next to this module. */
  uiDir?: string | undefined;
  repoRoot?: string | undefined;
  ssePingMs?: number | undefined;
}

export interface AdminListener extends BridgeListener {
  /** `http://127.0.0.1:<port>/?token=<token>` while running, else null. */
  openUrl(): string | null;
}

/** The dashboard listener (started once per process by main.ts; also attachable with `bridge.attach(...)`). */
export function createAdminListener(
  deps: DashboardDeps | DashboardSource,
  options: AdminListenerOptions = {},
): AdminListener {
  const source = toDashboardSource(deps);
  const hostname = options.hostname ?? ADMIN_BIND_HOST;
  assertLoopbackBind(hostname);
  const listen = options.listen ?? startListener;
  const print = options.print ?? ((text: string) => process.stdout.write(`${text}\n`));
  const tokenFile = adminTokenPath(source.location.dataDir);
  const uiDir = options.uiDir ?? defaultUiDir(options.repoRoot);
  let running: RunningListener | null = null;
  let token: string | null = null;

  return {
    name: "dashboard",
    async start() {
      if (running !== null) throw new Error("the dashboard is already running");
      const issued = generateAdminToken();
      await writeAdminToken(tokenFile, issued);
      let port = options.port ?? source.location.adminPort;
      const app = createAdminApp(source, {
        token: issued,
        port: () => port,
        uiDir,
        tokenFile,
        ssePingMs: options.ssePingMs,
      });
      running = await listen(app, { port, hostname });
      port = running.port;
      token = issued;
      print(
        [
          `Dashboard (loopback only): http://${hostname}:${port}/?token=${issued}`,
          `  Open this link in a browser on this Mac; it sets a cookie and is valid until the bridge process restarts.`,
          `  The token is also stored in ${tokenFile}.`,
        ].join("\n"),
      );
      source.logger.info("dashboard listening", { url: running.url });
      return running;
    },
    async stop() {
      const current = running;
      running = null;
      token = null;
      await current?.close();
      await removeAdminToken(tokenFile).catch(() => undefined);
    },
    openUrl() {
      return running !== null && token !== null ? `${running.url}/?token=${token}` : null;
    },
  };
}
