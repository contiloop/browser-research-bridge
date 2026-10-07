/**
 * The public listener end to end in-process: real OAuth server (bearer tokens from a real consent +
 * code exchange), real MCP Streamable HTTP transport driven by the SDK client, and the tool services
 * over the in-memory site world.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addOnboarding,
  documentFor,
  item,
  makeMcpWorld,
  ok,
  setNeedsLogin,
} from "../../test/support/mcp-fixtures.js";
import type { McpWorld } from "../../test/support/mcp-fixtures.js";
import { PUBLIC_URL, makeHarness, obtainTokens, registerPublic } from "../../test/support/oauth-harness.js";
import type { Harness } from "../../test/support/oauth-harness.js";
import {
  ReadService,
  SearchService,
  TOOL_NAMES,
  createBridgeMcpServer,
  createMcpHttpHandler,
} from "../adapters/mcp/index.js";
import { createPublicApp } from "./public-server.js";

const BODY_MARKER = "ARTICLE-BODY-MARKER";

let world: McpWorld;
let h: Harness;
let app: ReturnType<typeof createPublicApp>;
let token: string;

beforeEach(async () => {
  world = await makeMcpWorld({
    sites: [
      {
        key: "alpha",
        search: async (req) =>
          req.cursor === null
            ? ok([item("alpha", 1, "2026-10-05"), item("alpha", 2, "2026-10-03")], "next")
            : ok([item("alpha", 3, "2026-10-01")]),
        read: async (ref) =>
          ref.localId === "1"
            ? {
                status: "ok",
                document: documentFor("alpha", "1", `${BODY_MARKER} first paragraph.\n\nSecond paragraph.`),
              }
            : { status: "auth_required", message: "subscriber wall" },
      },
      { key: "beta", search: async () => ok([item("beta", 1, "2026-10-04")]) },
    ],
  });
  await setNeedsLogin(world, "beta");
  await addOnboarding(world, "gamma");
  h = makeHarness();
  const logger = h.logger;
  const services = { ...world.deps, logger };
  const search = new SearchService(services);
  const read = new ReadService(services);
  const mcp = createMcpHttpHandler({
    createServer: (clientId) =>
      createBridgeMcpServer({ search, read, registry: world.registry, logger }, clientId),
    logger,
  });
  app = createPublicApp({ oauth: h.oauth, mcp, logger });
  const clientId = await registerPublic(app);
  token = (await obtainTokens({ ...h, app }, clientId)).access_token;
});

afterEach(async () => {
  await world.cleanup();
});

async function connect(accessToken = token): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    fetch: (url, init) => Promise.resolve(app.request(url.toString(), init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  // The SDK's own client transport trips exactOptionalPropertyTypes on `sessionId`.
  await client.connect(transport as unknown as Transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("public listener routes", () => {
  it("answers 401 with WWW-Authenticate on /mcp without a token", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it("serves the OAuth discovery documents and 404s everything else", async () => {
    expect((await app.request("/.well-known/oauth-authorization-server")).status).toBe(200);
    expect((await app.request("/.well-known/oauth-protected-resource/mcp")).status).toBe(200);
    for (const path of ["/", "/anything", "/mcp/extra", "/admin", "/oauth", "/.well-known/other", "/sse"]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it("answers CORS preflight on /mcp before authentication", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:6274", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is stateless: GET and DELETE on /mcp are 405 with a valid token", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      });
      expect(res.status).toBe(405);
    }
  });
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists exactly the five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const search = tools.find((t) => t.name === "search");
    expect(search?.inputSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    const fetchTool = tools.find((t) => t.name === "fetch");
    expect(fetchTool?.inputSchema).toMatchObject({
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    await client.close();
  });

  it("search: ChatGPT shape with structuredContent and an identical JSON text block", async () => {
    const client = await connect();
    const result = await call(client, "search", { query: "election limit:2" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(result.structuredContent).toEqual(parsed);
    const body = parsed as {
      results: { id: string; title: string; url: string }[];
      nextPage: number | null;
      siteStatuses: { site: string; status: string }[];
    };
    expect(body.results.map((r) => [r.id, r.title, r.url])).toEqual([
      ["alpha:1", "alpha article 1", "https://alpha.example.com/articles/1"],
      ["alpha:2", "alpha article 2", "https://alpha.example.com/articles/2"],
    ]);
    expect(body.nextPage).toBe(2);
    expect(body.siteStatuses.map((s) => [s.site, s.status])).toEqual([
      ["alpha", "ok"],
      ["beta", "auth_required"],
      ["gamma", "unsupported"],
    ]);
    const page2 = JSON.parse(
      textOf(await call(client, "search", { query: "election limit:2 page:2" })),
    ) as typeof body;
    expect(page2.results.map((r) => r.id)).toEqual(["alpha:3"]);
    expect(page2.nextPage).toBeNull();
    await client.close();
  });

  it("fetch: ChatGPT shape { id, title, text, url, metadata } in both encodings", async () => {
    const client = await connect();
    const result = await call(client, "fetch", { id: "alpha:1" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
    expect(result.structuredContent).toEqual(parsed);
    expect(Object.keys(parsed).slice(0, 5)).toEqual(["id", "title", "text", "url", "metadata"]);
    expect(parsed).toMatchObject({
      id: "alpha:1",
      title: "alpha document 1",
      url: "https://alpha.example.com/articles/1",
      metadata: { section: "world" },
      truncated: false,
      accessLevel: "subscriber",
    });
    expect(parsed["text"]).toContain(BODY_MARKER);
    await client.close();
  });

  it("fetch failures are tool errors whose text is { error: { code, message, site, action? } }", async () => {
    const client = await connect();
    const unknown = await call(client, "fetch", { id: "https://unknown.example.net/story" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toBeUndefined();
    expect(JSON.parse(textOf(unknown))).toEqual({
      error: {
        code: "unsupported",
        message: "no registered site owns unknown.example.net",
        site: "unknown.example.net",
        availableSites: ["alpha", "beta"],
      },
    });
    const wall = await call(client, "fetch", { id: "alpha:2" });
    expect(wall.isError).toBe(true);
    expect(JSON.parse(textOf(wall))).toEqual({
      error: {
        code: "auth_required",
        message: "subscriber wall",
        site: "alpha",
        action: expect.stringContaining("Log in to alpha") as string,
      },
    });
    await client.close();
  });

  it("search_sites: typed fields, JSON text only, cursor round trip", async () => {
    const client = await connect();
    await world.registry.recordHealthCheck("beta", { status: "ok" });
    const first = await call(client, "search_sites", {
      query: "election",
      sites: ["alpha", "beta"],
      limit: 2,
    });
    expect(first.structuredContent).toBeUndefined();
    const p1 = JSON.parse(textOf(first)) as { results: { id: string }[]; nextCursor: string | null };
    expect(p1.results.map((r) => r.id)).toEqual(["alpha:1", "beta:1"]);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const second = await call(client, "search_sites", {
      query: "election",
      sites: ["alpha", "beta"],
      limit: 2,
      cursor: p1.nextCursor,
    });
    const p2 = JSON.parse(textOf(second)) as { results: { id: string }[]; nextCursor: string | null };
    // One adapter call per site per page: alpha's rest of its first adapter page, then its next page.
    expect(p2.results.map((r) => r.id)).toEqual(["alpha:2"]);
    const third = await call(client, "search_sites", {
      query: "election",
      sites: ["alpha", "beta"],
      limit: 2,
      cursor: p2.nextCursor,
    });
    const p3 = JSON.parse(textOf(third)) as { results: { id: string }[]; nextCursor: string | null };
    expect(p3.results.map((r) => r.id)).toEqual(["alpha:3"]);
    expect(p3.nextCursor).toBeNull();

    const invalid = JSON.parse(
      textOf(await call(client, "search_sites", { query: "x", after: "yesterday", limit: 99 })),
    ) as { ignoredFields?: string[] };
    expect(invalid.ignoredFields).toEqual(["after"]);
    await client.close();
  });

  it("read_documents: per-item outcomes in input order, JSON text only; more than 5 refs is rejected", async () => {
    const client = await connect();
    const result = await call(client, "read_documents", { refs: ["alpha:2", "alpha:1", "nope:1"] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeUndefined();
    const body = JSON.parse(textOf(result)) as {
      items: { ref: string; status: string; document?: { id: string } }[];
    };
    expect(body.items.map((i) => [i.ref, i.status])).toEqual([
      ["alpha:2", "auth_required"],
      ["alpha:1", "ok"],
      ["nope:1", "unsupported"],
    ]);
    expect(body.items[1]?.document?.id).toBe("alpha:1");
    const tooMany = await call(client, "read_documents", {
      refs: ["a:1", "a:2", "a:3", "a:4", "a:5", "a:6"],
    });
    expect(tooMany.isError).toBe(true);
    await client.close();
  });

  it("list_sites: every registered site in every status, with message/action when not active", async () => {
    const client = await connect();
    const result = await call(client, "list_sites", {});
    expect(result.structuredContent).toBeUndefined();
    const body = JSON.parse(textOf(result)) as { sites: Record<string, unknown>[] };
    expect(body.sites).toEqual([
      {
        key: "alpha",
        name: "ALPHA",
        hostnames: ["alpha.example.com"],
        status: "active",
        requiresLogin: false,
        loginUrl: null,
        capabilities: { search: true, read: true, dateFilter: false, pagination: false },
        lastCheckedAt: null,
      },
      expect.objectContaining({
        key: "beta",
        status: "needs_login",
        action: expect.stringContaining("Log in") as string,
      }),
      expect.objectContaining({ key: "gamma", status: "onboarding", message: "onboarding in progress" }),
    ]);
    await client.close();
  });

  it("logs request metadata only: no page content and no tokens", async () => {
    const client = await connect();
    await call(client, "search", { query: "election" });
    await call(client, "fetch", { id: "alpha:1" });
    await call(client, "read_documents", { refs: ["alpha:1"] });
    await client.close();
    const log = h.logger.lines.join("\n");
    expect(log).toContain('"tool":"search"');
    expect(log).toContain('"tool":"fetch"');
    expect(log).toContain('"path":"/mcp"');
    expect(log).not.toContain(BODY_MARKER);
    expect(log).not.toContain("excerpt 1");
    expect(log).not.toContain(token);
  });
});
