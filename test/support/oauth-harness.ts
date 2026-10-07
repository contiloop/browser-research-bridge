/** Shared fixtures for the OAuth adapter tests (in-process Hono requests, real file store in a temp dir). */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Clock } from "../../src/ports/clock.js";
import type { LogFields, Logger } from "../../src/ports/logger.js";
import { FileTokenStore } from "../../src/adapters/storage/token-store.js";
import type { FetchLike } from "../../src/adapters/oauth/client-metadata.js";
import {
  createOAuthServer,
  type OAuthEnv,
  type OAuthServer,
  type OAuthTunables,
} from "../../src/adapters/oauth/server.js";

export const PUBLIC_URL = "https://bridge.test";
export const PASSPHRASE = "correct horse battery staple";
export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const ALLOWLIST = [
  CLAUDE_CALLBACK,
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "http://localhost/*",
  "http://127.0.0.1/*",
];
export const TUNABLES: OAuthTunables = {
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2_592_000,
  consentFailuresPerIp: 5,
  consentGlobalFailures: 20,
  consentLockoutSeconds: 900,
  maxRegisteredClients: 50,
  clientPurgeAfterDays: 7,
};

export class FakeClock implements Clock {
  constructor(public ms = Date.parse("2026-10-05T12:00:00Z")) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  private push(level: string, message: string, fields?: LogFields) {
    this.lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  }
  debug(m: string, f?: LogFields) {
    this.push("debug", m, f);
  }
  info(m: string, f?: LogFields) {
    this.push("info", m, f);
  }
  warn(m: string, f?: LogFields) {
    this.push("warn", m, f);
  }
  error(m: string, f?: LogFields) {
    this.push("error", m, f);
  }
}

export interface Harness {
  app: Hono<OAuthEnv>;
  oauth: OAuthServer;
  clock: FakeClock;
  logger: MemoryLogger;
  store: FileTokenStore;
  storePath: string;
}

export function makeHarness(
  overrides: {
    trustedProxyHeader?: string | null;
    fetch?: FetchLike;
    tunables?: Partial<OAuthTunables>;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bridge-oauth-"));
  const storePath = join(dir, "oauth", "token-store.json");
  const store = new FileTokenStore(storePath);
  const clock = new FakeClock();
  const logger = new MemoryLogger();
  const oauth = createOAuthServer({
    publicUrl: PUBLIC_URL,
    passphrase: PASSPHRASE,
    redirectUriAllowlist: ALLOWLIST,
    trustedProxyHeader: overrides.trustedProxyHeader ?? null,
    store,
    logger,
    clock,
    tunables: { ...TUNABLES, ...overrides.tunables },
    fetch: overrides.fetch ?? (() => Promise.reject(new Error("network disabled in tests"))),
  });
  // Same shape the public listener builds: OAuth routes + bearer-protected /mcp, 404 elsewhere.
  const app = new Hono<OAuthEnv>();
  app.route("/", oauth.routes);
  app.all("/mcp", oauth.bearerAuth, (c) => c.json({ clientId: c.var.oauthClientId }));
  return { app, oauth, clock, logger, store, storePath };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function form(values: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(values).toString(),
  };
}

export async function register(app: Hono<OAuthEnv>, body: Record<string, unknown>): Promise<Response> {
  return app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function registerPublic(
  app: Hono<OAuthEnv>,
  redirectUri = CLAUDE_CALLBACK,
  name = "Claude",
): Promise<string> {
  const res = await register(app, {
    client_name: name,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export interface AuthorizeArgs {
  clientId: string;
  redirectUri?: string;
  challenge: string;
  state?: string;
}

export function authorizeParams(a: AuthorizeArgs): Record<string, string> {
  return {
    response_type: "code",
    client_id: a.clientId,
    redirect_uri: a.redirectUri ?? CLAUDE_CALLBACK,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
    state: a.state ?? "st-123",
    resource: `${PUBLIC_URL}/mcp`,
  };
}

/** Posts the consent form; returns the response. */
export function consent(
  app: Hono<OAuthEnv>,
  a: AuthorizeArgs,
  passphrase: string,
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  return app.request(
    "/oauth/authorize",
    form({ ...authorizeParams(a), passphrase, decision: "approve" }, headers),
  );
}

/** Full consent + code exchange; returns the token response JSON. */
export async function obtainTokens(
  h: Harness,
  clientId: string,
  redirectUri = CLAUDE_CALLBACK,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: string }> {
  const { verifier, challenge } = pkce();
  const res = await consent(h.app, { clientId, redirectUri, challenge }, PASSPHRASE);
  if (res.status !== 302) throw new Error(`consent failed: ${res.status}`);
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const token = await h.app.request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  );
  if (token.status !== 200) throw new Error(`token exchange failed: ${token.status} ${await token.text()}`);
  return (await token.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };
}

export function refresh(h: Harness, clientId: string, refreshToken: string): Promise<Response> | Response {
  return h.app.request(
    "/oauth/token",
    form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
}

export function callMcp(h: Harness, accessToken?: string): Promise<Response> | Response {
  return h.app.request("/mcp", {
    method: "POST",
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
  });
}
