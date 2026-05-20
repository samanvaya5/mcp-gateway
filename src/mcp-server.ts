import {
  McpServer,
  StdioServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import type { GatewayConfig } from "./types.js";

async function readIncomingBody(req: IncomingMessage): Promise<Uint8Array | null> {
  if (req.method === "GET" || req.method === "HEAD") {
    return null;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  if (chunks.length === 0) return null;
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function nodeReqToWebRequest(req: IncomingMessage, body: Uint8Array | null, host: string, port: number): Request {
  const path = req.url || "/";
  const url = new URL(path, `http://${host}:${port}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  return new Request(url.toString(), {
    method: req.method || "GET",
    headers,
    body,
  });
}

async function sendWebResponse(res: ServerResponse, webResponse: Response): Promise<void> {
  const responseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  
  webResponse.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  res.writeHead(webResponse.status, responseHeaders);

  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();
}

export async function createGatewayServer(
  config: GatewayConfig,
): Promise<{ server: McpServer; httpServer: HttpServer }> {
  const mcpServer = new McpServer(
    {
      name: "mcp-gateway",
      version: "1.0.0",
      description: "MCP Gateway — orchestrates backend MCP servers for web search, GitHub, Firebase, browser automation, SSH, YouTube analysis, and more. Browse servers with list_servers(), explore tools with browse_server(), search tools with search_tools().",
    },
    { capabilities: { tools: {} } },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);

  let isShuttingDown = false;

  const rawHttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (isShuttingDown) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Server shutting down" }));
      return;
    }

    const path = (req.url || "/").split("?")[0]!;
    const method = req.method || "GET";

    console.log(`[HTTP] ${method} ${path}`);

    // 1. CORS Preflight (Important for Grok)
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      });
      res.end();
      return;
    }

    // 2. Authentication check
    if (config.token && !config.noAuth) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${config.token}`) {
        console.warn(`[AUTH] 401 Unauthorized: ${method} ${path}`);
        res.writeHead(401, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing token" }));
        return;
      }
    }

    // 3. Delegate ALL other requests to the MCP Transport
    // The SDK's WebStandardStreamableHTTPServerTransport handles its own internal routing.
    try {
      const body = await readIncomingBody(req);
      const webRequest = nodeReqToWebRequest(req, body, config.host, config.port);
      const webResponse = await transport.handleRequest(webRequest);
      
      if (webResponse.status === 404) {
        console.warn(`[MCP] 404 Not Found from Transport: ${method} ${path}`);
      }
      
      await sendWebResponse(res, webResponse);
    } catch (err) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: message }));
      }
    }
  });

  // Wrap the HTTP server so that close() first terminates all connections
  // (required for Bun to properly release the port) and cleans up the transport.
  const originalClose = rawHttpServer.close.bind(rawHttpServer);
  const httpServer = new Proxy(rawHttpServer, {
    get(target, prop) {
      if (prop === "close") {
        return async function (cb?: (err?: Error) => void) {
          isShuttingDown = true;
          target.closeAllConnections();
          await transport.close();
          await mcpServer.close();
          return originalClose(cb);
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as unknown as HttpServer;

  httpServer.listen(config.port, config.host);

  return { server: mcpServer, httpServer };
}

/**
 * Create a stdio-based MCP server for clients that don't support SSE.
 * Pi spawns this as a child process — communicates via stdin/stdout.
 */
export async function createStdioGatewayServer(): Promise<McpServer> {
  const mcpServer = new McpServer(
    {
      name: "mcp-gateway",
      version: "1.0.0",
      description: "MCP Gateway — orchestrates backend MCP servers for web search, GitHub, Firebase, browser automation, SSH, YouTube analysis, and more. Browse servers with list_servers(), explore tools with browse_server(), search tools with search_tools().",
    },
    { capabilities: { tools: {} } },
  );

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  return mcpServer;
}
