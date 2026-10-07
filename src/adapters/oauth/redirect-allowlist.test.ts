import { describe, expect, it } from "vitest";
import { RedirectAllowlist, redirectUriMatchesRegistered } from "./redirect-allowlist.js";

const list = new RedirectAllowlist([
  "https://claude.ai/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "http://localhost/*",
  "http://127.0.0.1/*",
]);

describe("RedirectAllowlist", () => {
  it("matches exact entries exactly", () => {
    expect(list.allows("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(list.allows("https://claude.ai/api/mcp/auth_callback/x")).toBe(false);
    expect(list.allows("https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(list.allows("http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(list.allows("https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(list.allows("https://claude.ai/api/mcp/auth_callback#frag")).toBe(false);
  });

  it("matches loopback patterns on any port and path, http only", () => {
    expect(list.allows("http://localhost:33418/callback")).toBe(true);
    expect(list.allows("http://localhost/callback")).toBe(true);
    expect(list.allows("http://127.0.0.1:6274/oauth/callback")).toBe(true);
    expect(list.allows("https://localhost:3000/cb")).toBe(false);
    expect(list.allows("http://localhost.evil.com/cb")).toBe(false);
    expect(list.allows("http://user@localhost:3000/cb")).toBe(false);
    expect(list.allows("http://[::1]:3000/cb")).toBe(false);
    expect(list.allows("not a url")).toBe(false);
  });

  it("rejects malformed entries at construction", () => {
    expect(() => new RedirectAllowlist(["https://*.example.com/cb"])).toThrow();
    expect(() => new RedirectAllowlist(["ftp://example.com/cb"])).toThrow();
  });

  it("pins non-loopback prefix patterns to scheme, host, and port", () => {
    const l = new RedirectAllowlist(["https://example.com/oauth/*"]);
    expect(l.allows("https://example.com/oauth/cb")).toBe(true);
    expect(l.allows("https://example.com:444/oauth/cb")).toBe(false);
    expect(l.allows("https://example.com/other")).toBe(false);
  });
});

describe("redirectUriMatchesRegistered", () => {
  it("relaxes only the port, only for loopback", () => {
    expect(redirectUriMatchesRegistered("http://localhost:5/cb", "http://localhost:6/cb")).toBe(true);
    expect(redirectUriMatchesRegistered("http://localhost:5/cb", "http://localhost:6/other")).toBe(false);
    expect(redirectUriMatchesRegistered("http://127.0.0.1:5/cb", "http://localhost:5/cb")).toBe(false);
    expect(redirectUriMatchesRegistered("https://a.example:5/cb", "https://a.example:6/cb")).toBe(false);
  });
});
