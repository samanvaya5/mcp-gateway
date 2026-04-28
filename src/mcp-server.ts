import {
  McpServer,
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
  const responseHeaders: Record<string, string> = {};
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
    { name: "mcp-gateway", version: "1.0.0" },
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

    if (path !== "/mcp" && path !== "/sse") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    try {
      const body = await readIncomingBody(req);
      const webRequest = nodeReqToWebRequest(req, body, config.host, config.port);
      const webResponse = await transport.handleRequest(webRequest);
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
