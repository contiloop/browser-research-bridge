/**
 * Streamable HTTP endpoint for the tools (MCP transport over web-standard Request/Response).
 *
 * Stateless mode with JSON responses: every POST gets a fresh MCP server + transport, no session id
 * is issued, and the response is a single JSON body. This works with ChatGPT connectors and Claude
 * custom connectors alike and needs no session store; GET (standalone SSE stream) and DELETE (session
 * end) are answered 405 as the MCP spec allows for servers without sessions. Authentication happens
 * before this handler (bearer middleware); the authenticated client id is passed in for logging.
 *
 * When the HTTP client disconnects, the per-request server is closed, which aborts the running tool
 * handlers (and through their signal the browser tasks).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "../../ports/logger.js";
import { errorMessage } from "./deps.js";

/** Default cap on a POST body (JSON-RPC requests are small). */
export const DEFAULT_MCP_MAX_BODY_BYTES = 1024 * 1024;

export interface McpHttpHandlerOptions {
  /** A fresh server per request (see `createBridgeMcpServer`). */
  createServer: (clientId: string | undefined) => McpServer;
  logger: Logger;
  maxRequestBodyBytes?: number | undefined;
}

export type McpHttpHandler = (request: Request, auth: { clientId?: string | undefined }) => Promise<Response>;

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createMcpHttpHandler(options: McpHttpHandlerOptions): McpHttpHandler {
  const { logger } = options;
  const maxRequestBodySize = options.maxRequestBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES;

  return async (request, auth) => {
    if (request.method !== "POST") {
      return jsonRpcError(405, "Method not allowed: this MCP server is stateless; use POST.", {
        allow: "POST",
      });
    }
    const server = options.createServer(auth.clientId);
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize,
    });
    transport.onerror = (error) => logger.debug("mcp transport error", { error: error.message });
    try {
      await server.connect(transport);
      const handled = transport.handleRequest(
        request,
        auth.clientId === undefined
          ? undefined
          : { authInfo: { token: "", clientId: auth.clientId, scopes: [] } },
      );
      const disconnected = new Promise<Response>((resolve) => {
        const onAbort = (): void => resolve(new Response(null, { status: 499 }));
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([handled, disconnected]);
    } catch (error) {
      logger.error("mcp request failed", { error: errorMessage(error) });
      return jsonRpcError(500, "Internal server error");
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}
