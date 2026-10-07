/**
 * Client metadata intake: Dynamic Client Registration bodies (RFC 7591) and Client ID Metadata
 * Documents (draft-ietf-oauth-client-id-metadata-document), validated against the redirect allowlist.
 */
import { isIP } from "node:net";
import { OAuthError } from "./errors.js";
import { parseRedirectUri, type RedirectAllowlist } from "./redirect-allowlist.js";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface ClientMetadata {
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

const AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  "none",
  "client_secret_post",
  "client_secret_basic",
];
const GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps the redirect URIs the allowlist admits and drops the rest (RFC 7591 §3.2.1 lets the server
 * register a subset); fails when none remain. The authorize endpoint re-checks the URI actually used.
 */
function readRedirectUris(body: Record<string, unknown>, allowlist: RedirectAllowlist): string[] {
  const raw = body["redirect_uris"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS} URIs`,
    );
  }
  for (const uri of raw) {
    if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH || !parseRedirectUri(uri)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "each redirect_uri must be an absolute http(s) URL without fragment",
      );
    }
  }
  const allowed = (raw as string[]).filter((uri) => allowlist.allows(uri));
  if (allowed.length === 0) {
    throw new OAuthError(
      "invalid_redirect_uri",
      "none of the redirect_uris is allowed by this bridge's redirect allowlist",
    );
  }
  return [...new Set(allowed)];
}

function readClientName(body: Record<string, unknown>): string | null {
  const name = body["client_name"];
  if (name === undefined || name === null) return null;
  if (typeof name !== "string")
    throw new OAuthError("invalid_client_metadata", "client_name must be a string");
  const trimmed = name.trim().slice(0, MAX_CLIENT_NAME_LENGTH);
  return trimmed === "" ? null : trimmed;
}

function checkGrantAndResponseTypes(body: Record<string, unknown>): void {
  const grants = body["grant_types"];
  if (grants !== undefined) {
    if (!Array.isArray(grants) || !grants.every((g) => typeof g === "string")) {
      throw new OAuthError("invalid_client_metadata", "grant_types must be an array of strings");
    }
    if (!grants.includes("authorization_code") || grants.some((g) => !GRANT_TYPES.has(g))) {
      throw new OAuthError(
        "invalid_client_metadata",
        "grant_types must include authorization_code and may add refresh_token only",
      );
    }
  }
  const responses = body["response_types"];
  if (responses !== undefined) {
    if (!Array.isArray(responses) || responses.length === 0 || responses.some((r) => r !== "code")) {
      throw new OAuthError("invalid_client_metadata", 'response_types must be ["code"]');
    }
  }
}

/** Validates a DCR request body. An omitted auth method defaults to `none` (public client): the hosted research clients register as public clients and may omit the field; RFC 7591 would default to `client_secret_basic`, which would hand them a secret they never use. */
export function parseRegistrationRequest(body: unknown, allowlist: RedirectAllowlist): ClientMetadata {
  if (!isRecord(body))
    throw new OAuthError("invalid_client_metadata", "registration body must be a JSON object");
  const redirectUris = readRedirectUris(body, allowlist);
  const clientName = readClientName(body);
  checkGrantAndResponseTypes(body);
  const method = body["token_endpoint_auth_method"] ?? "none";
  if (typeof method !== "string" || !AUTH_METHODS.includes(method as TokenEndpointAuthMethod)) {
    throw new OAuthError(
      "invalid_client_metadata",
      `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
    );
  }
  return { clientName, redirectUris, tokenEndpointAuthMethod: method as TokenEndpointAuthMethod };
}

/** True when a client_id has the shape of a Client ID Metadata Document URL. */
export function looksLikeMetadataDocumentUrl(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * Validates a CIMD client_id URL: https, a path, no fragment/credentials/dot segments, and a DNS
 * hostname (no IP literals or localhost, which would let the URL aim the bridge at local services).
 */
export function validateMetadataDocumentUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "client_id is not a valid URL");
  }
  const segments =
    clientId
      .replace(/^https:\/\/[^/]*/, "")
      .split(/[/?]/)[0]
      ?.split("/") ?? [];
  if (
    url.protocol !== "https:" ||
    url.pathname === "/" ||
    url.hash !== "" ||
    clientId.includes("#") ||
    url.username !== "" ||
    url.password !== "" ||
    segments.some((s) => s === "." || s === "..") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    !url.hostname.includes(".")
  ) {
    throw new OAuthError("invalid_client", "client_id is not an acceptable metadata document URL");
  }
  return url;
}

/**
 * Whether a metadata document lets the client act as a public client (`none`): either its preferred
 * `token_endpoint_auth_method` is `none` (or omitted), or `token_endpoint_auth_methods_supported` lists
 * `none`. ChatGPT's document prefers `private_key_jwt` but supports `none`; the bridge treats such a
 * client as public because it does not implement `private_key_jwt`.
 */
function offersPublicClientAuth(body: Record<string, unknown>): boolean {
  const preferred = body["token_endpoint_auth_method"] ?? "none";
  if (preferred === "none") return true;
  const supported = body["token_endpoint_auth_methods_supported"];
  return Array.isArray(supported) && supported.includes("none");
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MetadataDocumentFetcherOptions {
  fetch: FetchLike;
  allowlist: RedirectAllowlist;
  /** Abort the fetch after this long so the authorize endpoint stays under 2 s. */
  timeoutMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  now: () => number;
}

/** Fetches, validates, and briefly caches Client ID Metadata Documents. */
export class MetadataDocumentFetcher {
  private readonly cache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();

  constructor(private readonly options: MetadataDocumentFetcherOptions) {}

  async resolve(clientId: string): Promise<ClientMetadata> {
    const cached = this.cache.get(clientId);
    const now = this.options.now();
    if (cached && cached.expiresAt > now) return cached.metadata;

    const url = validateMetadataDocumentUrl(clientId);
    const maxBytes = this.options.maxBytes ?? 16_384;
    let text: string;
    try {
      const response = await this.options.fetch(url.href, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 1500),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new Error("document too large");
      text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("document too large");
    } catch (error) {
      throw new OAuthError(
        "invalid_client",
        `client metadata document could not be fetched (${(error as Error).message})`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client", "client metadata document is not JSON");
    }
    if (!isRecord(body))
      throw new OAuthError("invalid_client", "client metadata document must be a JSON object");
    if (body["client_id"] !== clientId) {
      throw new OAuthError("invalid_client", "client metadata document client_id does not match its URL");
    }
    if (body["client_secret"] !== undefined || body["client_secret_expires_at"] !== undefined) {
      throw new OAuthError("invalid_client", "client metadata document must not contain a client secret");
    }
    if (!offersPublicClientAuth(body)) {
      throw new OAuthError(
        "invalid_client",
        'client metadata document offers no public client authentication: token_endpoint_auth_method must be "none" or token_endpoint_auth_methods_supported must include "none"',
      );
    }
    const metadata: ClientMetadata = {
      clientName: readClientName(body),
      redirectUris: readRedirectUris(body, this.options.allowlist),
      tokenEndpointAuthMethod: "none",
    };
    this.cache.set(clientId, { metadata, expiresAt: now + (this.options.cacheTtlMs ?? 300_000) });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return metadata;
  }
}
