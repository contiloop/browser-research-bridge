/**
 * Regression tests for the real ChatGPT connector flow: CIMD document advertising private_key_jwt with
 * "none" supported, per-connector redirect path, and the tunnel's RFC 8707 resource identifier.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_REDIRECT_URI_ALLOWLIST } from "../../app/config.js";
import {
  FakeClock,
  MemoryLogger,
  PASSPHRASE,
  PUBLIC_URL,
  TUNABLES,
  form,
  pkce,
} from "../../../test/support/oauth-harness.js";
import { FileTokenStore } from "../storage/token-store.js";
import { RedirectAllowlist } from "./redirect-allowlist.js";
import { createOAuthServer, type OAuthEnv } from "./server.js";

const CLIENT_ID = "https://chatgpt.com/oauth/QTOb4VcHdCsW/client.json";
const REDIRECT = "https://chatgpt.com/connector/oauth/QTOb4VcHdCsW";
const TUNNEL_RESOURCE =
  "https://tunnel-service.gateway.unified-0.internal.api.openai.org/v1/mcp/tunnel_6ac39813672c819197cf45718a28a6ae";

function chatgptDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_uri: "https://chatgpt.com/",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    logo_uri: "https://chatgpt.com/logo.png",
    ...overrides,
  };
}

function harness(document: Record<string, unknown>, extraResources?: string[]) {
  const store = new FileTokenStore(join(mkdtempSync(join(tmpdir(), "bridge-chatgpt-")), "store.json"));
  const logger = new MemoryLogger();
  const oauth = createOAuthServer({
    publicUrl: PUBLIC_URL,
    passphrase: PASSPHRASE,
    redirectUriAllowlist: DEFAULT_REDIRECT_URI_ALLOWLIST,
    trustedProxyHeader: null,
    store,
    logger,
    clock: new FakeClock(),
    tunables: TUNABLES,
    fetch: async () => new Response(JSON.stringify(document), { status: 200 }),
    ...(extraResources === undefined ? {} : { extraResources }),
  });
  const app = new Hono<OAuthEnv>();
  app.route("/", oauth.routes);
  app.all("/mcp", oauth.bearerAuth, (c) => c.json({ clientId: c.var.oauthClientId }));
  return { app, oauth, logger };
}

function authorizeQuery(challenge: string, resource: string): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    resource,
  }).toString();
}

async function runFlow(app: Hono<OAuthEnv>, resource: string) {
  const { verifier, challenge } = pkce();
  const page = await app.request(`/oauth/authorize?${authorizeQuery(challenge, resource)}`);
  if (page.status !== 200) return { page, token: null };
  const params = Object.fromEntries(new URLSearchParams(authorizeQuery(challenge, resource)));
  const approved = await app.request(
    "/oauth/authorize",
    form({ ...params, passphrase: PASSPHRASE, decision: "approve" }),
  );
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const token = await app.request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      resource,
    }),
  );
  return { page, token };
}

describe("ChatGPT connector (CIMD + tunnel resource)", () => {
  it("default allowlist admits the per-connector ChatGPT redirect path", () => {
    const allow = new RedirectAllowlist(DEFAULT_REDIRECT_URI_ALLOWLIST);
    expect(allow.allows("https://chatgpt.com/connector/oauth/abc")).toBe(true);
    expect(allow.allows(REDIRECT)).toBe(true);
    expect(allow.allows("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(allow.allows("https://chatgpt.com/other/oauth/abc")).toBe(false);
  });

  it("accepts a private_key_jwt document that also supports none, as a public client, with an extra resource", async () => {
    const { app, oauth } = harness(chatgptDocument(), [TUNNEL_RESOURCE]);
    const { page, token } = await runFlow(app, TUNNEL_RESOURCE);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ChatGPT");
    expect(token!.status).toBe(200);
    const t = (await token!.json()) as { access_token: string; refresh_token: string };
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toEqual({ clientId: CLIENT_ID });
    expect((await oauth.service.verifyAccessToken(t.access_token))?.resource).toBe(TUNNEL_RESOURCE);

    const refreshed = await app.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
        resource: TUNNEL_RESOURCE,
      }),
    );
    expect(refreshed.status).toBe(200);
    const r = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect((await oauth.service.verifyAccessToken(r.access_token))?.resource).toBe(TUNNEL_RESOURCE);

    // A refresh naming a resource outside the accepted set is refused and does not consume the token.
    const foreign = await app.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        refresh_token: r.refresh_token,
        client_id: CLIENT_ID,
        resource: "https://evil.example/mcp",
      }),
    );
    expect(await foreign.json()).toMatchObject({ error: "invalid_target" });
    const again = await app.request(
      "/oauth/token",
      form({ grant_type: "refresh_token", refresh_token: r.refresh_token, client_id: CLIENT_ID }),
    );
    expect(again.status).toBe(200);
  });

  it("rejects a document that offers no public auth method, and logs the reason", async () => {
    const { app, logger } = harness(
      chatgptDocument({ token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
      [TUNNEL_RESOURCE],
    );
    const { page } = await runFlow(app, TUNNEL_RESOURCE);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("invalid_client");
    const line = logger.lines.find((l) => l.includes("oauth authorization request rejected"));
    expect(line).toContain("invalid_client");
    expect(line).toContain("token_endpoint_auth_method");
  });

  it("rejects a foreign resource not in the accepted set with invalid_target", async () => {
    const { app } = harness(chatgptDocument(), [TUNNEL_RESOURCE]);
    const { page } = await runFlow(app, "https://evil.example/v1/mcp/x");
    expect(page.status).toBe(302);
    expect(new URL(page.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

    const without = harness(chatgptDocument());
    const r = await runFlow(without.app, TUNNEL_RESOURCE);
    expect(new URL(r.page.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

    // The bridge's own resource is still accepted when extras are configured.
    const own = await runFlow(app, `${PUBLIC_URL}/mcp`);
    expect(own.token!.status).toBe(200);
  });

  it("token endpoint rejects a code exchange naming a foreign resource", async () => {
    const { app } = harness(chatgptDocument(), [TUNNEL_RESOURCE]);
    const { verifier, challenge } = pkce();
    const params = Object.fromEntries(new URLSearchParams(authorizeQuery(challenge, TUNNEL_RESOURCE)));
    const approved = await app.request(
      "/oauth/authorize",
      form({ ...params, passphrase: PASSPHRASE, decision: "approve" }),
    );
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const res = await app.request(
      "/oauth/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        resource: "https://evil.example/mcp",
      }),
    );
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });
});
