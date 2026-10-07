/**
 * Public listener: the loopback port that the tunnel fronts. It serves only `/mcp`
 * (bearer-protected, Streamable HTTP) and the OAuth routes (`/.well-known/oauth-authorization-server`,
 * `/.well-known/oauth-protected-resource[/mcp]`, `/oauth/register`, `/oauth/authorize`,
 * `/oauth/token`); everything else is 404. Request logs hold method, path (no query string),
 * status, timing, and the OAuth client id — never bodies, page content, or tokens.
 *
 * `startListener` binds any Hono app to a host/port; the admin listener reuses it.
 */
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { McpHttpHandler } from "../adapters/mcp/index.js";
import type { OAuthEnv, OAuthServer } from "../adapters/oauth/index.js";
import type { Logger } from "../ports/logger.js";

export const MCP_PATH = "/mcp";

export interface PublicAppOptions {
  oauth: Pick<OAuthServer, "routes" | "bearerAuth">;
  mcp: McpHttpHandler;
  logger: Logger;
}

/** Logs one line per request: listener, method, path, status, duration, OAuth client (if any). */
export function requestLog(logger: Logger, listener: string): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    await next();
    const clientId = (c.var as Record<string, unknown>)["oauthClientId"];
    const path = c.req.path;
    logger.info("http request", {
      listener,
      method: c.req.method,
      path: path.length > 200 ? `${path.slice(0, 200)}…` : path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
      client: typeof clientId === "string" ? clientId : null,
    });
  };
}

export function createPublicApp(options: PublicAppOptions): Hono<OAuthEnv> {
  const { logger } = options;
  const app = new Hono<OAuthEnv>();
  app.use("*", requestLog(logger, "public"));
  // Browser-based MCP clients (e.g. MCP Inspector in direct mode) need CORS, including the
  // preflight before the bearer check and access to WWW-Authenticate for OAuth discovery.
  app.use(
    MCP_PATH,
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Accept",
        "Mcp-Protocol-Version",
        "Mcp-Session-Id",
        "Last-Event-ID",
      ],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
      maxAge: 86_400,
    }),
  );
  app.route("/", options.oauth.routes);
  app.all(MCP_PATH, options.oauth.bearerAuth, (c) =>
    options.mcp(c.req.raw, { clientId: c.var.oauthClientId }),
  );
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    logger.error("public request failed", { path: c.req.path, error: error.message });
    return c.json({ error: "server_error" }, 500);
  });
  return app;
}

export interface RunningListener {
  hostname: string;
  port: number;
  /** `http://<hostname>:<port>`. */
  url: string;
  /** Stops accepting connections, lets in-flight requests finish, then force-closes stragglers. */
  close(): Promise<void>;
}

export interface ListenOptions {
  port: number;
  /** Default `127.0.0.1` (loopback only). */
  hostname?: string | undefined;
  /** Connections still open this long after `close()` are destroyed (default 5 s). */
  forceCloseAfterMs?: number | undefined;
}

/** Binds a fetch-style app to `hostname:port`; rejects on listen errors such as EADDRINUSE. */
export function startListener(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  options: ListenOptions,
): Promise<RunningListener> {
  const hostname = options.hostname ?? "127.0.0.1";
  const forceCloseAfterMs = options.forceCloseAfterMs ?? 5000;
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: (request) => app.fetch(request), port: options.port, hostname },
      (info: AddressInfo) => {
        server.off("error", reject);
        let closing: Promise<void> | null = null;
        resolve({
          hostname,
          port: info.port,
          url: `http://${hostname}:${info.port}`,
          close: () =>
            (closing ??= new Promise<void>((done) => {
              const force = setTimeout(() => {
                if ("closeAllConnections" in server) server.closeAllConnections();
              }, forceCloseAfterMs);
              force.unref();
              server.close(() => {
                clearTimeout(force);
                done();
              });
              if ("closeIdleConnections" in server) server.closeIdleConnections();
            })),
        });
      },
    );
    server.once("error", reject);
  });
}
