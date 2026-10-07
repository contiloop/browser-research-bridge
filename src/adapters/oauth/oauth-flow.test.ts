import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CALLBACK,
  PASSPHRASE,
  PUBLIC_URL,
  authorizeParams,
  callMcp,
  consent,
  form,
  makeHarness,
  obtainTokens,
  pkce,
  refresh,
  register,
  registerPublic,
  type Harness,
} from "../../../test/support/oauth-harness.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

async function timed<T>(fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const result = await fn();
  expect(performance.now() - start).toBeLessThan(2000);
  return result;
}

function location(res: Response): URL {
  const value = res.headers.get("location");
  expect(value).not.toBeNull();
  return new URL(value!);
}

describe("OAuth end-to-end flow (in-process)", () => {
  it("register → discovery → wrong/right passphrase → token → bearer → refresh rotation → reuse invalid_grant", async () => {
    const h = makeHarness();

    // Unauthenticated /mcp → 401 pointing at the protected-resource metadata.
    const unauth = await timed(() => callMcp(h));
    expect(unauth.status).toBe(401);
    const challengeHeader = unauth.headers.get("www-authenticate")!;
    expect(challengeHeader).toMatch(/^Bearer /);
    expect(challengeHeader).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challengeHeader).not.toContain("error=");

    // Protected resource metadata (path-suffixed and root) and AS metadata.
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const prm = await timed(() => h.app.request(path));
      expect(prm.status).toBe(200);
      expect(await prm.json()).toMatchObject({
        resource: `${PUBLIC_URL}/mcp`,
        authorization_servers: [PUBLIC_URL],
      });
    }
    const asm = await timed(() => h.app.request("/.well-known/oauth-authorization-server"));
    expect(asm.status).toBe(200);
    const meta = (await asm.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(meta["token_endpoint_auth_methods_supported"]).toContain("none");

    // Dynamic Client Registration.
    const reg = await timed(() =>
      register(h.app, {
        client_name: "Claude",
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    );
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as Record<string, unknown>;
    const clientId = client["client_id"] as string;
    expect(client["client_secret"]).toBeUndefined();
    expect(client["redirect_uris"]).toEqual([CLAUDE_CALLBACK]);

    // Consent page shows client name and redirect host.
    const { verifier, challenge } = pkce();
    const args = { clientId, challenge, state: "state-xyz" };
    const page = await timed(() =>
      h.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams(args))}`),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    expect(html).toContain('name="passphrase"');
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    // Wording in Korean and English together; the form itself is unchanged.
    for (const text of ["Bridge passphrase", "접속 암호", "Approve", "승인", "Deny", "거부"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');

    // Wrong passphrase → re-rendered form, no redirect.
    const wrong = await timed(() => consent(h.app, args, "not the passphrase"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("location")).toBeNull();
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain("Incorrect passphrase");
    expect(wrongHtml).toContain("접속 암호가 맞지 않습니다");

    // Right passphrase → redirect with code + state.
    const right = await timed(() => consent(h.app, args, PASSPHRASE));
    expect(right.status).toBe(302);
    const cb = location(right);
    expect(`${cb.origin}${cb.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(cb.searchParams.get("state")).toBe("state-xyz");
    const code = cb.searchParams.get("code")!;
    expect(code.length).toBeGreaterThanOrEqual(43);

    // Token exchange, form-urlencoded.
    const tokenRes = await timed(() =>
      h.app.request(
        "/oauth/token",
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CLAUDE_CALLBACK,
          resource: `${PUBLIC_URL}/mcp`,
        }),
      ),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const access = tokens["access_token"] as string;
    const refreshToken = tokens["refresh_token"] as string;

    // The code is single-use.
    const replay = await h.app.request(
      "/oauth/token",
      form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    // Bearer accepted on the protected route, client id attached.
    const ok = await timed(() => callMcp(h, access));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ clientId });

    // Refresh rotation.
    const rotated = await timed(() => refresh(h, clientId, refreshToken));
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(refreshToken);
    expect(next.access_token).not.toBe(access);
    expect((await callMcp(h, next.access_token)).status).toBe(200);

    // Reusing the rotated refresh token → invalid_grant (within the grace window the new pair survives).
    const reuse = await refresh(h, clientId, refreshToken);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    expect((await callMcp(h, next.access_token)).status).toBe(200);

    // Reuse after the grace window revokes the whole family.
    h.clock.advance(60_000);
    const lateReuse = await refresh(h, clientId, refreshToken);
    expect(await lateReuse.json()).toMatchObject({ error: "invalid_grant" });
    const revokedAccess = await callMcp(h, next.access_token);
    expect(revokedAccess.status).toBe(401);
    expect(revokedAccess.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await (await refresh(h, clientId, next.refresh_token)).json()).toMatchObject({
      error: "invalid_grant",
    });

    // Nothing secret reached the logs or the store file.
    const logs = h.logger.lines.join("\n");
    expect(logs).not.toContain(PASSPHRASE);
    for (const secret of [access, refreshToken, next.access_token, next.refresh_token, code]) {
      expect(logs).not.toContain(secret);
      expect(readFileSync(h.storePath, "utf8")).not.toContain(secret);
    }
    expect(logs).toContain('"outcome":"failure"');
    expect(logs).toContain('"outcome":"success"');
    expect(statSync(h.storePath).mode & 0o777).toBe(0o600);
  });

  it("two concurrent refreshes with the same refresh token: exactly one succeeds", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const t = await obtainTokens(h, clientId);
    const responses = await Promise.all([
      refresh(h, clientId, t.refresh_token),
      refresh(h, clientId, t.refresh_token),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const loser = responses.find((r) => r.status === 400) as Response;
    expect(await loser.json()).toMatchObject({ error: "invalid_grant" });
    const refreshTokens = (await h.store.listTokens()).filter((x) => x.kind === "refresh");
    // The original refresh token plus exactly one rotated one.
    expect(refreshTokens).toHaveLength(2);
  });

  it("expires access tokens after the TTL and refresh tokens after 30 days", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const t = await obtainTokens(h, clientId);
    h.clock.advance(HOUR + 1000);
    expect((await callMcp(h, t.access_token)).status).toBe(401);
    const r = await refresh(h, clientId, t.refresh_token);
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as { refresh_token: string };
    h.clock.advance(30 * DAY + 1000);
    expect(await (await refresh(h, clientId, t2.refresh_token)).json()).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("rejects malformed bearer headers and unknown tokens with 401", async () => {
    const h = makeHarness();
    expect((await callMcp(h, "garbage-token")).status).toBe(401);
    const basic = await h.app.request("/mcp", { headers: { authorization: "Basic abc" } });
    expect(basic.status).toBe(401);
    expect(basic.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("requires PKCE S256 and a matching verifier", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const { challenge } = pkce();
    const base = authorizeParams({ clientId, challenge });

    const noChallenge = { ...base };
    delete (noChallenge as Partial<typeof base>).code_challenge;
    const r1 = await h.app.request(`/oauth/authorize?${new URLSearchParams(noChallenge)}`);
    expect(r1.status).toBe(302);
    expect(location(r1).searchParams.get("error")).toBe("invalid_request");

    const r2 = await h.app.request(
      `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge_method: "plain" })}`,
    );
    expect(location(r2).searchParams.get("error")).toBe("invalid_request");

    const r3 = await consent(h.app, { clientId, challenge }, PASSPHRASE);
    const code = location(r3).searchParams.get("code")!;
    const bad = await h.app.request(
      "/oauth/token",
      form({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: clientId }),
    );
    expect(await bad.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("accepts only form-urlencoded token requests", async () => {
    const h = makeHarness();
    const res = await h.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "x" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    const unsupported = await h.app.request(
      "/oauth/token",
      form({ grant_type: "password", client_id: await registerPublic(h.app) }),
    );
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("deny redirects with access_denied", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const res = await h.app.request(
      "/oauth/authorize",
      form({ ...authorizeParams({ clientId, challenge: pkce().challenge }), decision: "deny" }),
    );
    expect(res.status).toBe(302);
    expect(location(res).searchParams.get("error")).toBe("access_denied");
  });
});

describe("redirect_uri allowlist", () => {
  it("rejects registration with only disallowed redirect URIs", async () => {
    const h = makeHarness();
    for (const uri of [
      "https://evil.example/callback",
      "http://localhost.evil.com/cb",
      "https://claude.ai/other",
    ]) {
      const res = await register(h.app, {
        client_name: "x",
        redirect_uris: [uri],
        token_endpoint_auth_method: "none",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });

  it("never redirects to an unregistered or disallowed redirect_uri", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const res = await h.app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams({ clientId, challenge: pkce().challenge, redirectUri: "https://evil.example/cb" }))}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const posted = await consent(
      h.app,
      { clientId, challenge: pkce().challenge, redirectUri: "https://evil.example/cb" },
      PASSPHRASE,
    );
    expect(posted.status).toBe(400);
    expect(posted.headers.get("location")).toBeNull();
  });

  it("rejects an unknown client_id without redirecting", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams({ clientId: "nope", challenge: pkce().challenge }))}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("allows loopback redirects on any port (Claude Code, MCP Inspector)", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app, "http://localhost:3333/callback", "Claude Code");
    const t = await obtainTokens(h, clientId, "http://localhost:51234/callback");
    expect((await callMcp(h, t.access_token)).status).toBe(200);

    const ipClient = await registerPublic(h.app, "http://127.0.0.1:6274/oauth/callback", "MCP Inspector");
    const res = await consent(
      h.app,
      {
        clientId: ipClient,
        challenge: pkce().challenge,
        redirectUri: "http://127.0.0.1:9999/oauth/callback",
      },
      PASSPHRASE,
    );
    expect(res.status).toBe(302);
    expect(location(res).port).toBe("9999");

    // Same port relaxation never lets a different path through.
    const otherPath = await consent(
      h.app,
      { clientId: ipClient, challenge: pkce().challenge, redirectUri: "http://127.0.0.1:9999/elsewhere" },
      PASSPHRASE,
    );
    expect(otherPath.status).toBe(400);
  });

  it("registers only the allowed subset of mixed redirect URIs", async () => {
    const h = makeHarness();
    const res = await register(h.app, {
      redirect_uris: [CLAUDE_CALLBACK, "https://evil.example/cb"],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { redirect_uris: string[] }).redirect_uris).toEqual([CLAUDE_CALLBACK]);
  });
});

describe("consent lockout", () => {
  async function fail(h: Harness, clientId: string, times: number, headers: Record<string, string> = {}) {
    for (let i = 0; i < times; i++) {
      const res = await consent(h.app, { clientId, challenge: pkce().challenge }, `wrong-${i}`, headers);
      expect([401, 429]).toContain(res.status);
    }
  }

  it("applies the global rule without a trusted proxy header: 20 failures → 15-minute lockout for all", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    await fail(h, clientId, 19);
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE)).status).toBe(302);
    // Success resets the counter; 20 fresh failures lock.
    await fail(h, clientId, 20);
    const locked = await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE, {
      "CF-Connecting-IP": "9.9.9.9",
    });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many failed attempts");
    h.clock.advance(15 * 60_000 + 1);
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE)).status).toBe(302);
    expect(h.logger.lines.join("\n")).toContain('"outcome":"locked_out"');
    expect(h.logger.lines.join("\n")).not.toContain(PASSPHRASE);
  });

  it("forgets failures older than the window", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    await fail(h, clientId, 19);
    h.clock.advance(15 * 60_000 + 1);
    await fail(h, clientId, 1);
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE)).status).toBe(302);
  });

  it("locks per client IP when a trusted proxy header is configured: 5 failures from one IP", async () => {
    const h = makeHarness({ trustedProxyHeader: "CF-Connecting-IP" });
    const clientId = await registerPublic(h.app);
    const attacker = { "CF-Connecting-IP": "203.0.113.7" };
    await fail(h, clientId, 5, attacker);
    expect(
      (await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE, attacker)).status,
    ).toBe(429);
    // Another IP is unaffected.
    const user = { "CF-Connecting-IP": "198.51.100.1" };
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE, user)).status).toBe(
      302,
    );
    h.clock.advance(15 * 60_000 + 1);
    expect(
      (await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE, attacker)).status,
    ).toBe(302);
    expect(h.logger.lines.join("\n")).toContain('"ip":"203.0.113.7"');
  });

  it("with a trusted proxy header configured, requests missing it use the global rule (20 failures)", async () => {
    const h = makeHarness({ trustedProxyHeader: "CF-Connecting-IP" });
    const clientId = await registerPublic(h.app);
    // Five headerless failures would lock one IP; they do not lock the shared global key.
    await fail(h, clientId, 19);
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE)).status).toBe(302);
    await fail(h, clientId, 20);
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE)).status).toBe(429);
    // A request that carries the header is counted per IP and is not locked by the global key.
    const user = { "CF-Connecting-IP": "198.51.100.1" };
    expect((await consent(h.app, { clientId, challenge: pkce().challenge }, PASSPHRASE, user)).status).toBe(
      302,
    );
    expect(h.logger.lines.join("\n")).not.toContain('"ip":"unknown"');
  });
});

describe("registration cap and purge", () => {
  it("caps dynamic registrations at 50 and purges token-less clients after 7 days", async () => {
    const h = makeHarness();
    const active = await registerPublic(h.app, CLAUDE_CALLBACK, "Active");
    await obtainTokens(h, active);
    for (let i = 1; i < 50; i++) await registerPublic(h.app, CLAUDE_CALLBACK, `client-${i}`);
    const over = await register(h.app, {
      client_name: "51st",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
    });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error_description: string }).error_description).toContain("limit");

    h.clock.advance(7 * DAY + 1000);
    // The 49 token-less clients are purged on the next registration; the client with a live refresh token stays.
    expect(
      (
        await register(h.app, {
          client_name: "new",
          redirect_uris: [CLAUDE_CALLBACK],
          token_endpoint_auth_method: "none",
        })
      ).status,
    ).toBe(201);
    const names = (await h.oauth.listClients()).map((c) => c.clientName);
    expect(names).toEqual(["Active", "new"]);

    // Once its tokens are dead too, the active client is purged by maintenance.
    h.clock.advance(31 * DAY);
    const result = await h.oauth.purge();
    expect(result.staleClients).toBe(2);
    expect(result.expiredRecords).toBeGreaterThan(0);
    expect(await h.oauth.listClients()).toEqual([]);
  });
});

describe("dashboard API", () => {
  it("lists clients with token summaries and revokes by token or client", async () => {
    const h = makeHarness();
    const clientId = await registerPublic(h.app);
    const first = await obtainTokens(h, clientId);
    const second = await obtainTokens(h, clientId);

    const [summary] = await h.oauth.listClients();
    expect(summary).toMatchObject({ clientId, clientName: "Claude", source: "dcr", activeTokens: 4 });
    expect(JSON.stringify(summary)).not.toContain(first.access_token);

    const firstGrant = await h.oauth.service.verifyAccessToken(first.access_token);
    expect(await h.oauth.revoke({ tokenId: firstGrant!.tokenId })).toBe(true);
    expect((await callMcp(h, first.access_token)).status).toBe(401);
    expect(await (await refresh(h, clientId, first.refresh_token)).json()).toMatchObject({
      error: "invalid_grant",
    });
    expect((await callMcp(h, second.access_token)).status).toBe(200);

    expect(await h.oauth.revoke({ clientId })).toBe(true);
    expect((await callMcp(h, second.access_token)).status).toBe(401);
    expect(await h.oauth.listClients()).toEqual([]);
    expect(await h.oauth.revoke({ clientId })).toBe(false);
    expect(await h.oauth.revoke({ tokenId: "missing" })).toBe(false);
  });
});

describe("confidential DCR clients", () => {
  it("registers an omitted token_endpoint_auth_method as a public client (none)", async () => {
    const h = makeHarness();
    const res = await register(h.app, { client_name: "Pub", redirect_uris: [CLAUDE_CALLBACK] });
    const reg = (await res.json()) as { token_endpoint_auth_method: string; client_secret?: string };
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.client_secret).toBeUndefined();
  });

  it("issues a secret and requires it at the token endpoint (basic or post)", async () => {
    const h = makeHarness();
    const res = await register(h.app, {
      client_name: "Conf",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "client_secret_basic",
    });
    const reg = (await res.json()) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(reg.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(reg.client_secret).toBeTruthy();
    expect(readFileSync(h.storePath, "utf8")).not.toContain(reg.client_secret);

    const { verifier, challenge } = pkce();
    const code = location(
      await consent(h.app, { clientId: reg.client_id, challenge }, PASSPHRASE),
    ).searchParams.get("code")!;
    const noSecret = await h.app.request(
      "/oauth/token",
      form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }),
    );
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toMatchObject({ error: "invalid_client" });

    const { verifier: v2, challenge: c2 } = pkce();
    const code2 = location(
      await consent(h.app, { clientId: reg.client_id, challenge: c2 }, PASSPHRASE),
    ).searchParams.get("code")!;
    const basic = Buffer.from(
      `${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`,
    ).toString("base64");
    const ok = await h.app.request(
      "/oauth/token",
      form(
        { grant_type: "authorization_code", code: code2, code_verifier: v2 },
        { authorization: `Basic ${basic}` },
      ),
    );
    expect(ok.status).toBe(200);
    const t = (await ok.json()) as { refresh_token: string };
    const viaPost = await h.app.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
      }),
    );
    expect(viaPost.status).toBe(200);
  });
});

describe("Client ID Metadata Documents", () => {
  const CIMD_URL = "https://client.example.com/oauth/client-metadata.json";

  it("accepts a CIMD client_id and runs the full flow as a public client", async () => {
    const fetched: string[] = [];
    const h = makeHarness({
      fetch: async (url) => {
        fetched.push(url);
        return new Response(
          JSON.stringify({
            client_id: CIMD_URL,
            client_name: "ChatGPT",
            redirect_uris: [CLAUDE_CALLBACK],
            token_endpoint_auth_method: "none",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const { verifier, challenge } = pkce();
    const page = await h.app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams({ clientId: CIMD_URL, challenge }))}`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ChatGPT");
    const code = location(
      await consent(h.app, { clientId: CIMD_URL, challenge }, PASSPHRASE),
    ).searchParams.get("code")!;
    const tok = await h.app.request(
      "/oauth/token",
      form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CIMD_URL }),
    );
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string };
    expect((await callMcp(h, t.access_token)).status).toBe(200);
    expect(fetched[0]).toBe(CIMD_URL);
    expect((await h.oauth.listClients())[0]).toMatchObject({
      clientId: CIMD_URL,
      source: "cimd",
      clientName: "ChatGPT",
    });
  });

  it("rejects a document whose client_id does not match, and unsafe URLs, without redirecting", async () => {
    const h = makeHarness({
      fetch: async () =>
        new Response(
          JSON.stringify({ client_id: "https://other.example.com/x", redirect_uris: [CLAUDE_CALLBACK] }),
        ),
    });
    for (const id of [
      CIMD_URL,
      "https://127.0.0.1/meta.json",
      "https://localhost/meta.json",
      "https://client.example.com/",
    ]) {
      const res = await h.app.request(
        `/oauth/authorize?${new URLSearchParams(authorizeParams({ clientId: id, challenge: pkce().challenge }))}`,
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("answers within 2 seconds when the metadata host hangs", async () => {
    const h = makeHarness({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("timeout")));
        }),
    });
    const res = await timed(() =>
      h.app.request(
        `/oauth/authorize?${new URLSearchParams(authorizeParams({ clientId: CIMD_URL, challenge: pkce().challenge }))}`,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe("public surface", () => {
  it("serves only the OAuth and well-known routes; everything else is 404", async () => {
    const h = makeHarness();
    for (const path of [
      "/",
      "/oauth/revoke",
      "/.well-known/openid-configuration",
      "/admin",
      "/oauth/authorize/x",
      "/mcp/extra",
    ]) {
      expect((await h.app.request(path)).status).toBe(404);
    }
    expect((await h.oauth.routes.request("/mcp")).status).toBe(404);
    expect((await h.app.request("/oauth/token")).status).toBe(404);
  });
});
