/**
 * OAuth 2.1 authorization server logic, independent of HTTP framing: client registration
 * (DCR and CIMD), authorization-request validation, code issuance with PKCE S256, code and refresh
 * grants with refresh-token rotation, access-token verification, and the dashboard's list/revoke/purge.
 * Raw tokens, codes, and secrets exist only in responses; the store sees their hashes.
 */
import { randomUUID } from "node:crypto";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { OAuthClientRecord, TokenRecord, TokenStore } from "../../ports/token-store.js";
import {
  looksLikeMetadataDocumentUrl,
  parseRegistrationRequest,
  type ClientMetadata,
  type MetadataDocumentFetcher,
  type TokenEndpointAuthMethod,
} from "./client-metadata.js";
import { hashSecret, isValidCodeChallenge, randomSecret, safeEqual, verifyPkceS256 } from "./crypto.js";
import { OAuthError } from "./errors.js";
import { redirectUriMatchesRegistered, type RedirectAllowlist } from "./redirect-allowlist.js";

export interface OAuthServiceOptions {
  /** Authorization server issuer: the public origin, no trailing slash. */
  issuer: string;
  /** Protected resource (the MCP endpoint URL as users enter it). */
  resource: string;
  /**
   * Further resource identifiers (RFC 8707) accepted in authorize/token requests and in tokens'
   * bound resource, e.g. a tunnel URL a hosted client reports instead of `resource`. Default none.
   */
  extraResources?: readonly string[];
  store: TokenStore;
  clock: Clock;
  logger: Logger;
  allowlist: RedirectAllowlist;
  metadataFetcher: MetadataDocumentFetcher;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  maxRegisteredClients: number;
  clientPurgeAfterDays: number;
  /** Authorization code lifetime (default 300 s). */
  codeTtlSeconds?: number;
  /**
   * A rotated refresh token presented again within this many seconds gets `invalid_grant` without
   * revoking its family, so a client's own concurrent refresh does not kill its fresh tokens (default 10 s).
   */
  refreshReuseGraceSeconds?: number;
}

export interface ResolvedClient {
  clientId: string;
  source: "dcr" | "cimd";
  metadata: ClientMetadata;
}

export interface AuthorizationRequest {
  client: ResolvedClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
}

/** An authorize-endpoint error. With `redirectUri` set it is reported to the client by redirect. */
export class AuthorizeError extends OAuthError {
  constructor(
    code: string,
    description: string,
    readonly redirectUri: string | null = null,
    readonly state: string | null = null,
  ) {
    super(code, description, 400);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export interface AccessGrant {
  clientId: string;
  /** Stable id of the access token (its storage hash); usable with `revoke({ tokenId })`. */
  tokenId: string;
  scope: string | null;
  resource: string | null;
  expiresAt: Date;
}

export interface TokenSummary {
  /** Storage hash of the token; pass to `revoke({ tokenId })`. */
  tokenId: string;
  kind: "access" | "refresh";
  familyId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ClientSummary {
  clientId: string;
  clientName: string | null;
  source: "dcr" | "cimd";
  redirectUris: string[];
  createdAt: string;
  lastTokenIssuedAt: string | null;
  /** Unrevoked, unexpired tokens. */
  activeTokens: number;
  tokens: TokenSummary[];
}

export type RevokeTarget = { clientId: string } | { tokenId: string };

export interface PurgeResult {
  expiredRecords: number;
  staleClients: number;
}

export interface RegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: TokenEndpointAuthMethod;
  client_secret?: string;
  client_secret_expires_at?: number;
}

/** Credentials presented at the token endpoint. */
export interface ClientCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** True when they came from an HTTP Basic header. */
  basic: boolean;
}

const DAY_MS = 86_400_000;

function sameResource(a: string, b: string): boolean {
  const norm = (v: string) => v.split("#")[0]!.replace(/\/$/, "");
  return norm(a) === norm(b);
}

export class OAuthService {
  private readonly codeTtlMs: number;
  private readonly graceMs: number;

  constructor(private readonly o: OAuthServiceOptions) {
    this.codeTtlMs = (o.codeTtlSeconds ?? 300) * 1000;
    this.graceMs = (o.refreshReuseGraceSeconds ?? 10) * 1000;
  }

  /** True for the bridge's own resource or one of the configured extra resources. */
  private acceptsResource(resource: string): boolean {
    return [this.o.resource, ...(this.o.extraResources ?? [])].some((r) => sameResource(resource, r));
  }

  private now(): Date {
    return this.o.clock.now();
  }

  // ---------------------------------------------------------------- registration

  async registerClient(body: unknown): Promise<RegistrationResponse> {
    const metadata = parseRegistrationRequest(body, this.o.allowlist);
    await this.purgeStaleClients();
    const registered = (await this.o.store.listClients()).filter((c) => c.source === "dcr").length;
    if (registered >= this.o.maxRegisteredClients) {
      this.o.logger.warn("oauth registration refused: client limit reached", {
        limit: this.o.maxRegisteredClients,
      });
      throw new OAuthError(
        "invalid_client_metadata",
        `client registration limit reached (${this.o.maxRegisteredClients}); revoke unused clients in the bridge dashboard`,
      );
    }
    const now = this.now();
    const clientId = randomUUID();
    const confidential = metadata.tokenEndpointAuthMethod !== "none";
    const secret = confidential ? randomSecret() : undefined;
    await this.o.store.putClient({
      clientId,
      clientName: metadata.clientName,
      redirectUris: metadata.redirectUris,
      source: "dcr",
      createdAt: now.toISOString(),
      lastTokenIssuedAt: null,
      tokenEndpointAuthMethod: metadata.tokenEndpointAuthMethod,
      clientSecretHash: secret === undefined ? null : hashSecret(secret),
    });
    this.o.logger.info("oauth client registered", {
      clientId,
      clientName: metadata.clientName,
      authMethod: metadata.tokenEndpointAuthMethod,
    });
    const response: RegistrationResponse = {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      redirect_uris: metadata.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: metadata.tokenEndpointAuthMethod,
    };
    if (metadata.clientName !== null) response.client_name = metadata.clientName;
    if (secret !== undefined) {
      response.client_secret = secret;
      response.client_secret_expires_at = 0;
    }
    return response;
  }

  /** Resolves a client_id to a registered (DCR) client or a fetched metadata document (CIMD). */
  async resolveClient(clientId: string): Promise<ResolvedClient> {
    if (looksLikeMetadataDocumentUrl(clientId)) {
      return { clientId, source: "cimd", metadata: await this.o.metadataFetcher.resolve(clientId) };
    }
    const record = await this.o.store.getClient(clientId);
    if (!record || record.source !== "dcr") throw new OAuthError("invalid_client", "unknown client_id");
    return {
      clientId,
      source: "dcr",
      metadata: {
        clientName: record.clientName,
        redirectUris: record.redirectUris,
        tokenEndpointAuthMethod: record.tokenEndpointAuthMethod ?? "none",
      },
    };
  }

  // ---------------------------------------------------------------- authorization

  /**
   * Validates an authorization request. Errors before the redirect URI is trusted carry no
   * `redirectUri` and must be shown directly; later errors carry it for an error redirect.
   */
  async validateAuthorizationRequest(
    params: Record<string, string | undefined>,
  ): Promise<AuthorizationRequest> {
    const clientId = params["client_id"];
    if (!clientId) throw new AuthorizeError("invalid_request", "client_id is required");
    let client: ResolvedClient;
    try {
      client = await this.resolveClient(clientId);
    } catch (error) {
      if (error instanceof OAuthError) throw new AuthorizeError(error.code, error.description);
      throw error;
    }

    const requested = params["redirect_uri"];
    let redirectUri: string;
    if (requested) {
      if (!client.metadata.redirectUris.some((r) => redirectUriMatchesRegistered(requested, r))) {
        throw new AuthorizeError("invalid_request", "redirect_uri is not registered for this client");
      }
      redirectUri = requested;
    } else if (client.metadata.redirectUris.length === 1) {
      redirectUri = client.metadata.redirectUris[0]!;
    } else {
      throw new AuthorizeError("invalid_request", "redirect_uri is required");
    }
    if (!this.o.allowlist.allows(redirectUri)) {
      throw new AuthorizeError("invalid_request", "redirect_uri is not allowed by this bridge");
    }

    const state = params["state"] ?? null;
    const fail = (code: string, description: string) =>
      new AuthorizeError(code, description, redirectUri, state);
    if (params["response_type"] !== "code")
      throw fail("unsupported_response_type", 'response_type must be "code"');
    const challenge = params["code_challenge"];
    if (!challenge) throw fail("invalid_request", "code_challenge is required (PKCE S256)");
    if (params["code_challenge_method"] !== "S256")
      throw fail("invalid_request", 'code_challenge_method must be "S256"');
    if (!isValidCodeChallenge(challenge)) throw fail("invalid_request", "code_challenge is malformed");
    const resource = params["resource"] || null;
    if (resource !== null && !this.acceptsResource(resource)) {
      throw fail("invalid_target", `resource is not served by this bridge (expected ${this.o.resource})`);
    }
    return { client, redirectUri, state, codeChallenge: challenge, scope: params["scope"] || null, resource };
  }

  /** Issues a single-use authorization code after consent; returns the redirect URL carrying it. */
  async approve(request: AuthorizationRequest): Promise<string> {
    const now = this.now();
    if (request.client.source === "cimd") await this.upsertMetadataClient(request.client, now);
    const code = randomSecret();
    await this.o.store.putAuthorizationCode({
      codeHash: hashSecret(code),
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: "S256",
      scope: request.scope,
      resource: request.resource,
      expiresAt: new Date(now.getTime() + this.codeTtlMs).toISOString(),
    });
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state !== null) url.searchParams.set("state", request.state);
    return url.href;
  }

  /** Redirect URL reporting an error (consent denied or a post-validation failure). */
  errorRedirect(redirectUri: string, code: string, description: string, state: string | null): string {
    const url = new URL(redirectUri);
    url.searchParams.set("error", code);
    url.searchParams.set("error_description", description);
    if (state !== null) url.searchParams.set("state", state);
    return url.href;
  }

  private async upsertMetadataClient(client: ResolvedClient, now: Date): Promise<void> {
    const existing = await this.o.store.getClient(client.clientId);
    await this.o.store.putClient({
      clientId: client.clientId,
      clientName: client.metadata.clientName,
      redirectUris: client.metadata.redirectUris,
      source: "cimd",
      createdAt: existing?.createdAt ?? now.toISOString(),
      lastTokenIssuedAt: existing?.lastTokenIssuedAt ?? null,
      tokenEndpointAuthMethod: "none",
      clientSecretHash: null,
    });
  }

  // ---------------------------------------------------------------- token endpoint

  async token(
    params: Record<string, string | undefined>,
    credentials: ClientCredentials,
  ): Promise<TokenResponse> {
    const client = await this.authenticateClient(params, credentials);
    switch (params["grant_type"]) {
      case "authorization_code":
        return this.exchangeCode(client, params);
      case "refresh_token":
        return this.refresh(client, params);
      case undefined:
      case "":
        throw new OAuthError("invalid_request", "grant_type is required");
      default:
        throw new OAuthError(
          "unsupported_grant_type",
          "grant_type must be authorization_code or refresh_token",
        );
    }
  }

  private async authenticateClient(
    params: Record<string, string | undefined>,
    credentials: ClientCredentials,
  ): Promise<OAuthClientRecord> {
    const clientId = credentials.clientId ?? params["client_id"];
    if (!clientId)
      throw new OAuthError("invalid_client", "client authentication failed: client_id missing", 401);
    if (
      credentials.clientId !== undefined &&
      params["client_id"] &&
      params["client_id"] !== credentials.clientId
    ) {
      throw new OAuthError("invalid_request", "client_id does not match the authenticated client");
    }
    const client = await this.o.store.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "client authentication failed: unknown client", 401);
    const method = client.tokenEndpointAuthMethod ?? "none";
    if (method !== "none") {
      const secret = credentials.clientSecret ?? params["client_secret"];
      if (!secret || !client.clientSecretHash || !safeEqual(hashSecret(secret), client.clientSecretHash)) {
        throw new OAuthError("invalid_client", "client authentication failed", 401);
      }
    }
    return client;
  }

  private async exchangeCode(
    client: OAuthClientRecord,
    params: Record<string, string | undefined>,
  ): Promise<TokenResponse> {
    const code = params["code"];
    const verifier = params["code_verifier"];
    if (!code) throw new OAuthError("invalid_request", "code is required");
    if (!verifier) throw new OAuthError("invalid_request", "code_verifier is required (PKCE)");
    const record = await this.o.store.takeAuthorizationCode(hashSecret(code));
    const now = this.now();
    if (!record || Date.parse(record.expiresAt) <= now.getTime()) {
      throw new OAuthError("invalid_grant", "authorization code is invalid or expired");
    }
    if (record.clientId !== client.clientId)
      throw new OAuthError("invalid_grant", "authorization code was issued to another client");
    const redirectUri = params["redirect_uri"];
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!verifyPkceS256(verifier, record.codeChallenge)) {
      throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
    }
    const resource = params["resource"];
    if (resource && !this.acceptsResource(resource)) {
      throw new OAuthError(
        "invalid_target",
        `resource is not served by this bridge (expected ${this.o.resource})`,
      );
    }
    const response = await this.issueTokens(client, randomUUID(), record.scope, record.resource, now);
    this.o.logger.info("oauth tokens issued", { clientId: client.clientId, grant: "authorization_code" });
    return response;
  }

  private async refresh(
    client: OAuthClientRecord,
    params: Record<string, string | undefined>,
  ): Promise<TokenResponse> {
    const raw = params["refresh_token"];
    if (!raw) throw new OAuthError("invalid_request", "refresh_token is required");
    const now = this.now();
    const token = await this.o.store.getToken(hashSecret(raw));
    if (!token || token.kind !== "refresh" || token.clientId !== client.clientId) {
      throw new OAuthError("invalid_grant", "refresh token is invalid");
    }
    if (token.revokedAt !== null) {
      const revokedAgo = now.getTime() - Date.parse(token.revokedAt);
      if (revokedAgo > this.graceMs) {
        await this.o.store.revokeFamily(token.familyId, now);
        this.o.logger.warn("oauth refresh token reuse; token family revoked", { clientId: client.clientId });
      }
      throw new OAuthError("invalid_grant", "refresh token has been revoked or already used");
    }
    if (Date.parse(token.expiresAt) <= now.getTime())
      throw new OAuthError("invalid_grant", "refresh token has expired");
    const resource = params["resource"];
    if (resource && !this.acceptsResource(resource)) {
      throw new OAuthError(
        "invalid_target",
        `resource is not served by this bridge (expected ${this.o.resource})`,
      );
    }
    // Rotation: only the request that revokes the presented token gets new tokens; a concurrent
    // refresh with the same token loses here (the revoke is one atomic store step).
    if (!(await this.o.store.revokeToken(token.tokenHash, now))) {
      throw new OAuthError("invalid_grant", "refresh token has been revoked or already used");
    }
    const response = await this.issueTokens(client, token.familyId, token.scope, token.resource, now);
    this.o.logger.info("oauth tokens issued", { clientId: client.clientId, grant: "refresh_token" });
    return response;
  }

  private async issueTokens(
    client: OAuthClientRecord,
    familyId: string,
    scope: string | null,
    resource: string | null,
    now: Date,
  ): Promise<TokenResponse> {
    const access = randomSecret();
    const refresh = randomSecret();
    const base = {
      clientId: client.clientId,
      scope,
      resource,
      familyId,
      createdAt: now.toISOString(),
      revokedAt: null,
    };
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
    await this.o.store.putToken({
      ...base,
      tokenHash: hashSecret(access),
      kind: "access",
      expiresAt: at(this.o.accessTokenTtlSeconds),
    });
    await this.o.store.putToken({
      ...base,
      tokenHash: hashSecret(refresh),
      kind: "refresh",
      expiresAt: at(this.o.refreshTokenTtlSeconds),
    });
    await this.o.store.markTokenIssued(client.clientId, now);
    const response: TokenResponse = {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.o.accessTokenTtlSeconds,
      refresh_token: refresh,
    };
    if (scope !== null) response.scope = scope;
    return response;
  }

  // ---------------------------------------------------------------- resource server

  /** The grant behind a bearer access token, or null when it is unknown, revoked, expired, or for another resource. */
  async verifyAccessToken(token: string): Promise<AccessGrant | null> {
    if (token.length === 0 || token.length > 512) return null;
    const record = await this.o.store.getToken(hashSecret(token));
    if (!record || record.kind !== "access" || record.revokedAt !== null) return null;
    const expiresAt = new Date(record.expiresAt);
    if (expiresAt.getTime() <= this.now().getTime()) return null;
    if (record.resource !== null && !this.acceptsResource(record.resource)) return null;
    return {
      clientId: record.clientId,
      tokenId: record.tokenHash,
      scope: record.scope,
      resource: record.resource,
      expiresAt,
    };
  }

  // ---------------------------------------------------------------- dashboard API

  async listClients(): Promise<ClientSummary[]> {
    const [clients, tokens] = await Promise.all([this.o.store.listClients(), this.o.store.listTokens()]);
    const now = this.now().getTime();
    return clients
      .map((client) => {
        const own = tokens.filter((t) => t.clientId === client.clientId);
        return {
          clientId: client.clientId,
          clientName: client.clientName,
          source: client.source,
          redirectUris: client.redirectUris,
          createdAt: client.createdAt,
          lastTokenIssuedAt: client.lastTokenIssuedAt,
          activeTokens: own.filter((t) => isLive(t, now)).length,
          tokens: own.map((t) => ({
            tokenId: t.tokenHash,
            kind: t.kind,
            familyId: t.familyId,
            createdAt: t.createdAt,
            expiresAt: t.expiresAt,
            revokedAt: t.revokedAt,
          })),
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * `{ clientId }` deletes the client with all its tokens and codes (it must register or consent again);
   * `{ tokenId }` revokes that token's whole family (the access and refresh tokens of one connection).
   * Returns false when nothing matched.
   */
  async revoke(target: RevokeTarget): Promise<boolean> {
    const now = this.now();
    if ("clientId" in target) {
      const client = await this.o.store.getClient(target.clientId);
      if (!client) return false;
      await this.o.store.deleteClient(target.clientId);
      this.o.logger.info("oauth client revoked", { clientId: target.clientId });
      return true;
    }
    const token = await this.o.store.getToken(target.tokenId);
    if (!token) return false;
    await this.o.store.revokeFamily(token.familyId, now);
    this.o.logger.info("oauth token family revoked", { clientId: token.clientId });
    return true;
  }

  /** Removes expired codes/tokens and clients with no live token and none issued for `clientPurgeAfterDays`. */
  async purge(): Promise<PurgeResult> {
    const expiredRecords = await this.o.store.purgeExpired(this.now());
    const staleClients = await this.purgeStaleClients();
    return { expiredRecords, staleClients };
  }

  private async purgeStaleClients(): Promise<number> {
    const [clients, tokens] = await Promise.all([this.o.store.listClients(), this.o.store.listTokens()]);
    const now = this.now().getTime();
    const cutoff = now - this.o.clientPurgeAfterDays * DAY_MS;
    let removed = 0;
    for (const client of clients) {
      const lastActivity = Date.parse(client.lastTokenIssuedAt ?? client.createdAt);
      if (lastActivity > cutoff) continue;
      if (tokens.some((t) => t.clientId === client.clientId && isLive(t, now))) continue;
      await this.o.store.deleteClient(client.clientId);
      removed++;
    }
    if (removed > 0) this.o.logger.info("oauth stale clients purged", { count: removed });
    return removed;
  }
}

function isLive(token: TokenRecord, now: number): boolean {
  return token.revokedAt === null && Date.parse(token.expiresAt) > now;
}
