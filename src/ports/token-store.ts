/**
 * OAuth persistence port, implemented under `data/`. Tokens and codes are stored only as
 * hashes; hashing and expiry policy live in the OAuth adapter. Timestamps are ISO 8601 strings.
 */

export interface OAuthClientRecord {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  /** Dynamic Client Registration or Client ID Metadata Document. */
  source: "dcr" | "cimd";
  createdAt: string;
  /** Used to purge clients with no token issued for N days. */
  lastTokenIssuedAt: string | null;
  /** Token endpoint client authentication; absent means `"none"` (public client). */
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
  /** Hash of the client secret issued at registration to a confidential client; never the secret itself. */
  clientSecretHash?: string | null;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string | null;
  resource: string | null;
  expiresAt: string;
}

export interface TokenRecord {
  tokenHash: string;
  kind: "access" | "refresh";
  clientId: string;
  scope: string | null;
  resource: string | null;
  /** Shared by a refresh token and everything issued from it, for rotation and family revocation. */
  familyId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface TokenStore {
  putClient(client: OAuthClientRecord): Promise<void>;
  /** Sets only the client's `lastTokenIssuedAt`; does nothing for an unknown (e.g. deleted) client. */
  markTokenIssued(clientId: string, at: Date): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRecord | undefined>;
  listClients(): Promise<OAuthClientRecord[]>;
  /** Deletes the client and all of its tokens and codes. */
  deleteClient(clientId: string): Promise<void>;

  putAuthorizationCode(code: AuthorizationCodeRecord): Promise<void>;
  /** Returns and deletes the code (single use). */
  takeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | undefined>;

  putToken(token: TokenRecord): Promise<void>;
  getToken(tokenHash: string): Promise<TokenRecord | undefined>;
  listTokens(): Promise<TokenRecord[]>;
  /**
   * Revokes the token if it is not revoked yet, as one atomic step. Returns true only for the call
   * that revoked it (false when it was missing or already revoked), so concurrent refreshes with the
   * same refresh token have exactly one winner.
   */
  revokeToken(tokenHash: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  revokeClientTokens(clientId: string, at: Date): Promise<void>;
  /** Removes expired codes and tokens; returns how many records were removed. */
  purgeExpired(now: Date): Promise<number>;
}
