/**
 * Hono wiring for the built-in OAuth 2.1 authorization server. `createOAuthServer` returns:
 * - `routes`: a Hono app with exactly the discovery documents and `/oauth/{register,authorize,token}`;
 *   it has no other routes, so the public listener can mount it next to `/mcp` and 404 everything else;
 * - `bearerAuth`: middleware for `/mcp` that answers `401` + `WWW-Authenticate: Bearer resource_metadata=…`
 *   and, on success, sets `c.var.oauthClientId` / `c.var.oauthGrant`;
 * - `listClients`, `revoke`, `purge` for the dashboard and the health timer.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { systemClock, type Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { TokenStore } from "../../ports/token-store.js";
import { MetadataDocumentFetcher, type FetchLike } from "./client-metadata.js";
import { CONSENT_HEADERS, renderConsentPage, renderMessagePage } from "./consent-page.js";
import { safeEqual } from "./crypto.js";
import { OAuthError } from "./errors.js";
import { LockoutTracker } from "./lockout.js";
import { RedirectAllowlist } from "./redirect-allowlist.js";
import {
  AuthorizeError,
  OAuthService,
  type AccessGrant,
  type AuthorizationRequest,
  type ClientCredentials,
  type ClientSummary,
  type PurgeResult,
  type RevokeTarget,
} from "./service.js";

/** The OAuth-related tunables (names match `config/bridge.json` → `tunables`). */
export interface OAuthTunables {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  consentFailuresPerIp: number;
  consentGlobalFailures: number;
  consentLockoutSeconds: number;
  maxRegisteredClients: number;
  clientPurgeAfterDays: number;
}

export interface OAuthServerOptions {
  /** Public origin (issuer), e.g. `https://bridge.example.com`; a trailing slash is ignored. */
  publicUrl: string;
  /** Path of the protected MCP endpoint (default `/mcp`). The resource is `publicUrl + mcpPath`. */
  mcpPath?: string;
  /** `BRIDGE_PASSPHRASE`; at least 12 characters. */
  passphrase: string;
  redirectUriAllowlist: readonly string[];
  /** Header holding the real client IP (e.g. `CF-Connecting-IP`); null selects the global lockout rule. */
  trustedProxyHeader: string | null;
  store: TokenStore;
  logger: Logger;
  tunables: OAuthTunables;
  clock?: Clock;
  /** Used to fetch Client ID Metadata Documents; defaults to global `fetch`. */
  fetch?: FetchLike;
  /**
   * Additional RFC 8707 resource identifiers accepted besides `publicUrl + mcpPath`, e.g. the
   * resource ChatGPT sends when it reaches the bridge through OpenAI's MCP tunnel. Default none.
   */
  extraResources?: readonly string[];
}

export type OAuthVariables = {
  /** Client id behind the bearer token of the current `/mcp` request. */
  oauthClientId: string;
  oauthGrant: AccessGrant;
};
export type OAuthEnv = { Variables: OAuthVariables };

export interface OAuthServer {
  routes: Hono;
  bearerAuth: ReturnType<typeof createMiddleware<OAuthEnv>>;
  /** `publicUrl + mcpPath`: the value of `resource` in the protected-resource metadata. */
  resource: string;
  issuer: string;
  /** URL advertised in `WWW-Authenticate: Bearer resource_metadata="…"`. */
  resourceMetadataUrl: string;
  service: OAuthService;
  listClients(): Promise<ClientSummary[]>;
  revoke(target: RevokeTarget): Promise<boolean>;
  purge(): Promise<PurgeResult>;
}

/** Every path `routes` serves (for route-restriction checks in the public listener). */
export function oauthPublicPaths(mcpPath = "/mcp"): string[] {
  return [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${mcpPath}`,
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/token",
  ];
}

const MIN_PASSPHRASE_LENGTH = 12;
const BODY_LIMIT_BYTES = 64 * 1024;
const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

type Params = Record<string, string | undefined>;

class DuplicateParamError extends OAuthError {
  constructor(name: string) {
    super("invalid_request", `parameter ${name} must not be repeated`);
  }
}

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  if ([...options.passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`OAuth server requires a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const clock = options.clock ?? systemClock;
  const { logger, tunables } = options;
  const issuer = new URL(options.publicUrl).origin;
  const mcpPath = options.mcpPath ?? "/mcp";
  const resource = `${issuer}${mcpPath}`;
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource${mcpPath}`;
  const allowlist = new RedirectAllowlist(options.redirectUriAllowlist);
  const fetcher = new MetadataDocumentFetcher({
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    allowlist,
    now: () => clock.now().getTime(),
  });
  const service = new OAuthService({
    issuer,
    resource,
    extraResources: options.extraResources ?? [],
    store: options.store,
    clock,
    logger,
    allowlist,
    metadataFetcher: fetcher,
    accessTokenTtlSeconds: tunables.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: tunables.refreshTokenTtlSeconds,
    maxRegisteredClients: tunables.maxRegisteredClients,
    clientPurgeAfterDays: tunables.clientPurgeAfterDays,
  });
  const lockoutMs = tunables.consentLockoutSeconds * 1000;
  // Per-IP counting needs a trusted client IP; a request without one (no header configured, or the
  // configured header missing) counts against the single global key with the global threshold.
  const ipLockout = new LockoutTracker(
    { threshold: tunables.consentFailuresPerIp, windowMs: lockoutMs, lockoutMs },
    clock,
  );
  const globalLockout = new LockoutTracker(
    { threshold: tunables.consentGlobalFailures, windowMs: lockoutMs, lockoutMs },
    clock,
  );

  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
  };
  const prMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Browser Research Bridge",
  };

  const app = new Hono();
  const publicCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version"],
    maxAge: 86_400,
  });

  for (const path of oauthPublicPaths(mcpPath).filter((p) => p.startsWith("/.well-known/"))) {
    app.use(path, publicCors);
  }
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(asMetadata));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(prMetadata));
  app.get(`/.well-known/oauth-protected-resource${mcpPath}`, (c) => c.json(prMetadata));

  const limit = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json(new OAuthError("invalid_request", "request body too large").toJSON(), 413),
  });

  app.use("/oauth/register", publicCors, limit);
  app.post("/oauth/register", async (c) => {
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(new OAuthError("invalid_client_metadata", "body must be JSON").toJSON(), 400);
    }
    try {
      return c.json(await service.registerClient(body), 201);
    } catch (error) {
      return oauthErrorResponse(c, error, logger);
    }
  });

  app.use("/oauth/token", publicCors, limit);
  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    let credentials: ClientCredentials;
    try {
      if (!isFormRequest(c)) {
        throw new OAuthError("invalid_request", "token requests must be application/x-www-form-urlencoded");
      }
      const params = await formParams(c);
      credentials = basicCredentials(c.req.header("authorization"));
      return c.json(await service.token(params, credentials));
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_client" && c.req.header("authorization")) {
        c.header("WWW-Authenticate", 'Basic realm="oauth"');
      }
      return oauthErrorResponse(c, error, logger);
    }
  });

  app.use("/oauth/authorize", limit);
  app.get("/oauth/authorize", async (c) => {
    let params: Params;
    try {
      params = queryParams(c);
    } catch (error) {
      return authorizePageError(c, error, service, logger);
    }
    let request: AuthorizationRequest;
    try {
      request = await service.validateAuthorizationRequest(params);
    } catch (error) {
      return authorizePageError(c, error, service, logger);
    }
    return consentPage(c, request, 200);
  });

  app.post("/oauth/authorize", async (c) => {
    let params: Params;
    let request: AuthorizationRequest;
    try {
      params = await formParams(c);
      request = await service.validateAuthorizationRequest(params);
    } catch (error) {
      return authorizePageError(c, error, service, logger);
    }
    const clientId = request.client.clientId;
    if (params["decision"] === "deny") {
      logger.info("oauth consent denied", { clientId });
      return c.redirect(
        service.errorRedirect(request.redirectUri, "access_denied", "the user denied access", request.state),
        302,
      );
    }

    const ip = options.trustedProxyHeader ? clientIp(c.req.header(options.trustedProxyHeader)) : null;
    const key = ip === null ? "global" : `ip:${ip}`;
    const lockout = ip === null ? globalLockout : ipLockout;
    const lockedUntil = lockout.lockedUntil(key);
    if (lockedUntil !== null) {
      logger.warn("oauth consent attempt", { clientId, ip, outcome: "locked_out" });
      return consentPage(c, request, 429, lockedMessage(lockedUntil, clock));
    }

    const passphrase = params["passphrase"] ?? "";
    if (!safeEqual(passphrase, options.passphrase)) {
      const nowLocked = lockout.recordFailure(key);
      logger.warn("oauth consent attempt", {
        clientId,
        ip,
        outcome: nowLocked ? "failure_locked" : "failure",
      });
      const until = lockout.lockedUntil(key);
      return consentPage(
        c,
        request,
        401,
        until === null ? "접속 암호가 맞지 않습니다. / Incorrect passphrase." : lockedMessage(until, clock),
      );
    }

    lockout.recordSuccess(key);
    logger.info("oauth consent attempt", { clientId, ip, outcome: "success" });
    try {
      return c.redirect(await service.approve(request), 302);
    } catch (error) {
      return authorizePageError(c, error, service, logger);
    }
  });

  const bearerAuth = createMiddleware<OAuthEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const match = header === undefined ? null : /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(header);
    if (!match) {
      return unauthorized(c, resourceMetadataUrl, null);
    }
    const grant = await service.verifyAccessToken(match[1]!);
    if (!grant) return unauthorized(c, resourceMetadataUrl, "invalid_token");
    c.set("oauthClientId", grant.clientId);
    c.set("oauthGrant", grant);
    await next();
  });

  return {
    routes: app,
    bearerAuth,
    resource,
    issuer,
    resourceMetadataUrl,
    service,
    listClients: () => service.listClients(),
    revoke: (target) => service.revoke(target),
    purge: () => service.purge(),
  };

  function consentPage(
    c: Context,
    request: AuthorizationRequest,
    status: 200 | 401 | 429,
    error?: string,
  ): Response {
    const hidden: Record<string, string> = {
      client_id: request.client.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    };
    if (request.state !== null) hidden["state"] = request.state;
    if (request.scope !== null) hidden["scope"] = request.scope;
    if (request.resource !== null) hidden["resource"] = request.resource;
    const html = renderConsentPage({
      clientName: request.client.metadata.clientName,
      clientId: request.client.clientId,
      redirectHost: new URL(request.redirectUri).host,
      params: hidden,
      ...(error === undefined ? {} : { error }),
    });
    return c.html(html, status, CONSENT_HEADERS);
  }
}

function unauthorized(c: Context, resourceMetadataUrl: string, error: "invalid_token" | null): Response {
  const challenge =
    error === null
      ? `Bearer resource_metadata="${resourceMetadataUrl}"`
      : `Bearer error="${error}", error_description="The access token is invalid or expired", resource_metadata="${resourceMetadataUrl}"`;
  c.header("WWW-Authenticate", challenge);
  c.header("Cache-Control", "no-store");
  return c.json(
    error === null
      ? { error: "invalid_token", error_description: "Authorization required" }
      : { error, error_description: "The access token is invalid or expired" },
    401,
  );
}

function oauthErrorResponse(c: Context, error: unknown, logger: Logger): Response {
  if (error instanceof OAuthError) {
    return c.json(error.toJSON(), error.status as 400 | 401);
  }
  logger.error("oauth endpoint failed", { path: c.req.path, error: (error as Error).message });
  return c.json({ error: "server_error", error_description: "internal error" }, 500);
}

function authorizePageError(c: Context, error: unknown, service: OAuthService, logger: Logger): Response {
  if (error instanceof AuthorizeError && error.redirectUri !== null) {
    return c.redirect(
      service.errorRedirect(error.redirectUri, error.code, error.description, error.state),
      302,
    );
  }
  if (error instanceof OAuthError) {
    logger.warn("oauth authorization request rejected", {
      error: error.code,
      description: error.description,
    });
    return c.html(
      renderMessagePage("Authorization request rejected", `${error.code}: ${error.description}`),
      400,
      CONSENT_HEADERS,
    );
  }
  logger.error("oauth authorize failed", { error: (error as Error).message });
  return c.html(renderMessagePage("Authorization failed", "Internal error."), 500, CONSENT_HEADERS);
}

function lockedMessage(until: number, clock: Clock): string {
  const minutes = Math.max(1, Math.ceil((until - clock.now().getTime()) / 60_000));
  return `실패한 시도가 너무 많습니다. ${minutes}분 뒤에 다시 시도하세요. / Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** The first address of the trusted header, or null when the header is missing or empty. */
function clientIp(header: string | undefined): string | null {
  const first = header?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : null;
}

function isFormRequest(c: Context): boolean {
  const type = c.req.header("content-type") ?? "";
  return type.toLowerCase().startsWith("application/x-www-form-urlencoded");
}

function queryParams(c: Context): Params {
  const out: Params = {};
  for (const [name, values] of Object.entries(c.req.queries())) {
    if (values.length > 1 && (AUTHORIZE_PARAMS as readonly string[]).includes(name))
      throw new DuplicateParamError(name);
    out[name] = values[0];
  }
  return out;
}

async function formParams(c: Context): Promise<Params> {
  if (!isFormRequest(c))
    throw new OAuthError("invalid_request", "body must be application/x-www-form-urlencoded");
  const body = await c.req.parseBody({ all: true });
  const out: Params = {};
  for (const [name, value] of Object.entries(body)) {
    if (Array.isArray(value)) throw new DuplicateParamError(name);
    if (typeof value !== "string") throw new OAuthError("invalid_request", `parameter ${name} must be text`);
    out[name] = value;
  }
  return out;
}

/** RFC 6749 §2.3.1 HTTP Basic client credentials (form-urlencoded id and secret). */
function basicCredentials(header: string | undefined): ClientCredentials {
  const match = header === undefined ? null : /^Basic[ ]+([A-Za-z0-9+/=]+)[ ]*$/i.exec(header);
  if (!match) return { clientId: undefined, clientSecret: undefined, basic: false };
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")),
      clientSecret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")),
      basic: true,
    };
  } catch {
    throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
  }
}
