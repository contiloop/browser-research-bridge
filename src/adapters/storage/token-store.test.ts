import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenRecord } from "../../ports/token-store.js";
import { FileTokenStore, tokenStorePath } from "./token-store.js";

function token(overrides: Partial<TokenRecord>): TokenRecord {
  return {
    tokenHash: "h1",
    kind: "access",
    clientId: "c1",
    scope: null,
    resource: null,
    familyId: "f1",
    createdAt: "2026-10-05T00:00:00.000Z",
    expiresAt: "2026-10-05T01:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

describe("FileTokenStore", () => {
  it("persists across instances with owner-only permissions", async () => {
    const path = tokenStorePath(mkdtempSync(join(tmpdir(), "bridge-store-")));
    const a = new FileTokenStore(path);
    await a.putClient({
      clientId: "c1",
      clientName: "x",
      redirectUris: [],
      source: "dcr",
      createdAt: "2026-10-05T00:00:00.000Z",
      lastTokenIssuedAt: null,
    });
    await a.putToken(token({}));
    await a.putAuthorizationCode({
      codeHash: "k1",
      clientId: "c1",
      redirectUri: "https://x/cb",
      codeChallenge: "c",
      codeChallengeMethod: "S256",
      scope: null,
      resource: null,
      expiresAt: "2026-10-05T00:05:00.000Z",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const b = new FileTokenStore(path);
    expect(await b.getClient("c1")).toMatchObject({ clientName: "x" });
    expect(await b.getToken("h1")).toMatchObject({ familyId: "f1" });
    expect(await b.takeAuthorizationCode("k1")).toMatchObject({ clientId: "c1" });
    expect(await b.takeAuthorizationCode("k1")).toBeUndefined();
    expect((JSON.parse(readFileSync(path, "utf8")) as { codes: unknown[] }).codes).toEqual([]);
  });

  it("revokes by token, family, and client; purges expired; deletes a client with its records", async () => {
    const store = new FileTokenStore(tokenStorePath(mkdtempSync(join(tmpdir(), "bridge-store-"))));
    const at = new Date("2026-10-05T00:30:00.000Z");
    await store.putToken(token({ tokenHash: "a", familyId: "f1" }));
    await store.putToken(
      token({ tokenHash: "b", familyId: "f1", kind: "refresh", expiresAt: "2026-11-04T00:00:00.000Z" }),
    );
    await store.putToken(token({ tokenHash: "c", familyId: "f2", clientId: "c2" }));
    await store.revokeToken("a", at);
    expect((await store.getToken("a"))?.revokedAt).toBe(at.toISOString());
    await store.revokeFamily("f1", at);
    expect((await store.getToken("b"))?.revokedAt).toBe(at.toISOString());
    await store.revokeClientTokens("c2", at);
    expect((await store.getToken("c"))?.revokedAt).toBe(at.toISOString());
    expect(await store.purgeExpired(new Date("2026-10-05T02:00:00.000Z"))).toBe(2);
    expect((await store.listTokens()).map((t) => t.tokenHash)).toEqual(["b"]);
    await store.deleteClient("c1");
    expect(await store.listTokens()).toEqual([]);
  });

  it("revokeToken reports whether this call revoked the token (one winner under concurrency)", async () => {
    const store = new FileTokenStore(tokenStorePath(mkdtempSync(join(tmpdir(), "bridge-store-"))));
    const at = new Date("2026-10-05T00:30:00.000Z");
    await store.putToken(token({ tokenHash: "r", kind: "refresh" }));
    const results = await Promise.all([store.revokeToken("r", at), store.revokeToken("r", at)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.revokeToken("missing", at)).toBe(false);
  });

  it("markTokenIssued updates only lastTokenIssuedAt and never recreates a deleted client", async () => {
    const store = new FileTokenStore(tokenStorePath(mkdtempSync(join(tmpdir(), "bridge-store-"))));
    await store.putClient({
      clientId: "c1",
      clientName: "x",
      redirectUris: ["https://x/cb"],
      source: "dcr",
      createdAt: "2026-10-05T00:00:00.000Z",
      lastTokenIssuedAt: null,
    });
    const at = new Date("2026-10-05T00:30:00.000Z");
    await store.markTokenIssued("c1", at);
    expect(await store.getClient("c1")).toMatchObject({
      clientName: "x",
      redirectUris: ["https://x/cb"],
      lastTokenIssuedAt: at.toISOString(),
    });
    await store.deleteClient("c1");
    await store.markTokenIssued("c1", at);
    expect(await store.getClient("c1")).toBeUndefined();
  });

  it("returns copies so callers cannot mutate stored state", async () => {
    const store = new FileTokenStore(tokenStorePath(mkdtempSync(join(tmpdir(), "bridge-store-"))));
    await store.putToken(token({}));
    const t = await store.getToken("h1");
    t!.revokedAt = "x";
    expect((await store.getToken("h1"))?.revokedAt).toBeNull();
  });
});
