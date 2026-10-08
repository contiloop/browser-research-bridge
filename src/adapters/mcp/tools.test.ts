/**
 * What the research models read and receive from the tool surface: the server instructions and tool
 * descriptions (spec 3.1 phrases), the exact tool set, and the ChatGPT `search`/`fetch` output keys.
 * Driven through the SDK client over an in-memory transport with stub services (no browser, no sites).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryLogger } from "../../../test/support/oauth-harness.js";
import type { Document, SearchResult } from "../../core/models.js";
import type { ReadItem } from "./read-service.js";
import type { SearchOutput } from "./search-service.js";
import { TOOL_NAMES, createBridgeMcpServer } from "./tools.js";

const RESULT: SearchResult = {
  id: "alpha:1",
  site: "alpha",
  title: "alpha article 1",
  url: "https://alpha.example.com/articles/1",
  publishedAt: "2026-10-05T09:00:00+00:00",
  datePrecision: "minute",
  excerpt: "excerpt 1",
  author: null,
};

const DOCUMENT: Document = {
  id: "alpha:1",
  site: "alpha",
  title: "alpha document 1",
  url: "https://alpha.example.com/articles/1",
  publishedAt: "2026-10-05T09:00:00+00:00",
  datePrecision: "minute",
  author: "A. Writer",
  text: "First paragraph.\n\nSecond paragraph.",
  truncated: false,
  accessLevel: "subscriber",
  fetchedAt: "2026-10-08T00:00:00.000Z",
  metadata: { section: "world" },
};

const SEARCH_OUT: SearchOutput = {
  results: [RESULT],
  nextCursor: "cursor-2",
  nextPage: 2,
  siteStatuses: [{ site: "alpha", status: "ok" }],
  page: 1,
  ignoredFields: [],
  cached: false,
};

const OK_ITEM: ReadItem = { ref: "alpha:1", status: "ok", document: DOCUMENT };

let client: Client;
let instructions: string;
let tools: Map<string, Tool>;

beforeEach(async () => {
  const server = createBridgeMcpServer({
    search: { search: () => Promise.resolve(SEARCH_OUT) },
    read: {
      fetch: () => Promise.resolve(OK_ITEM),
      readDocuments: () => Promise.resolve({ items: [OK_ITEM] }),
    },
    registry: { list: () => [] },
    logger: new MemoryLogger(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "tools-test", version: "1.0.0" });
  await client.connect(clientTransport);
  instructions = client.getInstructions() ?? "";
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
});

afterEach(async () => {
  await client.close();
});

function description(name: string): string {
  return tools.get(name)?.description ?? "";
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBeFalsy();
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** Spec 3.1 points as stable key phrases (case-insensitive). */
const HOW_SEARCH_WORKS = [
  "typed, unchanged, into",
  "own search box",
  "a few keywords",
  "no sentences",
  "returns nothing on most sites",
];
const LOGIN_ARTICLES = [
  "logged in",
  "full text is available only through this server",
  "web browsing",
  "must not",
];
const ANY_URL = ["any http(s) URL on a registered site", "found elsewhere"];
const PARALLEL = ["several times at once", "one keyword set per"];

function expectPhrases(text: string, phrases: readonly string[]): void {
  const lower = text.toLowerCase();
  for (const phrase of phrases) expect(lower, phrase).toContain(phrase.toLowerCase());
}

describe("server instructions", () => {
  it("explain how a search works, including that qualifiers are the only syntax", () => {
    expectPhrases(instructions, [
      ...HOW_SEARCH_WORKS,
      "the site's own search answers",
      "in the language of the site",
      "no quotation marks or operator syntax",
      "site:, after:, before:, limit:, page: are the only syntax",
    ]);
  });

  it("say results are the user's login articles, read through fetch or read_documents, never web browsing", () => {
    expectPhrases(instructions, [
      ...LOGIN_ARTICLES,
      "fetch (ChatGPT)",
      "read_documents (Claude)",
      "login wall",
    ]);
  });

  it("say fetch and read_documents accept any URL on a registered site", () => {
    expectPhrases(instructions, ANY_URL);
  });

  it("welcome parallel calls with one keyword set per search", () => {
    expectPhrases(instructions, [...PARALLEL, "several tabs"]);
  });

  it("keep list_sites and the failed-versus-empty distinction", () => {
    expectPhrases(instructions, [
      "list_sites",
      "auth_required",
      "contributed no results",
      "different from empty",
    ]);
  });

  it("do not steer the model to its own web search for finding articles", () => {
    expect(instructions).not.toMatch(/web search/i);
    for (const name of TOOL_NAMES) expect(description(name), name).not.toMatch(/web search/i);
  });
});

describe("tool descriptions", () => {
  it("search and search_sites carry how a search works, login articles, and parallel calls", () => {
    for (const name of ["search", "search_sites"]) {
      expectPhrases(description(name), [...HOW_SEARCH_WORKS, ...LOGIN_ARTICLES, ...PARALLEL]);
    }
    expectPhrases(description("search"), ["via fetch"]);
    expectPhrases(description("search_sites"), ["via read_documents"]);
  });

  it("fetch and read_documents carry login articles and any registered URL", () => {
    for (const name of ["fetch", "read_documents"]) {
      expectPhrases(description(name), [...LOGIN_ARTICLES, ...ANY_URL]);
    }
  });

  it("keep qualifier help, return shapes, status list, and pagination", () => {
    expectPhrases(description("search"), [
      "site:<key|hostname>",
      "after:YYYY-MM-DD",
      "limit:N",
      "page:N",
      "{ id, title, url, publishedAt, site, excerpt }",
      "page:<nextPage> for more",
      "ok, empty, auth_required, unsupported, access_denied, rate_limited, timeout, adapter_error, browser_unavailable",
    ]);
    expectPhrases(description("search_sites"), [
      "structured fields win over inline qualifiers",
      "nextCursor back as cursor",
      "non-ok status contributed no results",
    ]);
    expectPhrases(description("fetch"), [
      "{ id, title, text, url, metadata",
      "{ error: { code, message, site, action? } }",
    ]);
    expectPhrases(description("read_documents"), [
      "1-5 documents",
      "{ items: [{ ref, status, document?, error? }] }",
      "truncated: true",
    ]);
  });

  it("stay under about 900 characters each", () => {
    for (const name of ["search", "fetch", "search_sites", "read_documents"]) {
      expect(description(name).length, name).toBeLessThanOrEqual(900);
    }
  });
});

describe("tool surface", () => {
  it("lists exactly the five tools", () => {
    expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    expect([...TOOL_NAMES].sort()).toEqual([
      "fetch",
      "list_sites",
      "read_documents",
      "search",
      "search_sites",
    ]);
  });

  it("search keeps ChatGPT's { results: [{ id, title, url }] } shape with no new keys", async () => {
    const body = await call("search", { query: "election" });
    expect(Object.keys(body)).toEqual(["results", "nextPage", "siteStatuses"]);
    const [first] = body["results"] as Record<string, unknown>[];
    expect(first).toMatchObject({ id: RESULT.id, title: RESULT.title, url: RESULT.url });
  });

  it("fetch keeps ChatGPT's { id, title, text, url, metadata } shape with no new keys", async () => {
    const body = await call("fetch", { id: "alpha:1" });
    expect(Object.keys(body)).toEqual([
      "id",
      "title",
      "text",
      "url",
      "metadata",
      "site",
      "publishedAt",
      "datePrecision",
      "author",
      "accessLevel",
      "truncated",
      "fetchedAt",
    ]);
    expect(body).toMatchObject({ id: DOCUMENT.id, url: DOCUMENT.url, metadata: DOCUMENT.metadata });
  });

  it("search_sites and read_documents keep their output keys", async () => {
    expect(Object.keys(await call("search_sites", { query: "election" }))).toEqual([
      "results",
      "nextCursor",
      "siteStatuses",
    ]);
    expect(Object.keys(await call("read_documents", { refs: ["alpha:1"] }))).toEqual(["items"]);
  });
});
