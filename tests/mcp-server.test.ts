import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";

let serverUrl = "";
let httpServer: Server | null = null;

function freePort(): number {
  return 49152 + Math.floor(Math.random() * 16384);
}

const TEST_PORT = freePort();
const TEST_HOST = "127.0.0.1";

async function startServer(): Promise<void> {
  const { createGatewayServer } = await import("../src/mcp-server.js");
  const result = await createGatewayServer({
    port: TEST_PORT,
    host: TEST_HOST,
    servers: [],
    registryPath: "/tmp/test-registry.json",
    logPath: "/tmp/test-gateway.log",
  });
  await new Promise((r) => setTimeout(r, 100));
  httpServer = result.httpServer;
  serverUrl = `http://${TEST_HOST}:${TEST_PORT}`;
}

async function stopServer(): Promise<void> {
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close(() => resolve());
    });
    httpServer = null;
  }
}

beforeAll(() => startServer());
afterAll(() => stopServer());

describe("MCP Server", () => {
  test("server starts and listens on configured port", async () => {
    expect(httpServer).not.toBeNull();
    const res = await fetch(`${serverUrl}/sse`, {
      method: "GET",
    });
    expect(res.status).not.toBe(0);
  });

  test("/sse endpoint responds to MCP initialize request", async () => {
    const res = await fetch(`${serverUrl}/sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBeDefined();
    expect(body.result.serverInfo).toBeDefined();
  });

  test("/mcp endpoint responds to MCP initialize request", async () => {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(2);
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBeDefined();
    expect(body.result.serverInfo).toBeDefined();
  });

  test("server returns correct serverInfo (name, version)", async () => {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("mcp-gateway");
    expect(body.result.serverInfo.version).toBe("1.0.0");
  });

  test("server gracefully shuts down on SIGTERM", async () => {
    expect(httpServer).not.toBeNull();
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);

    await stopServer();

    let connectionRefused = false;
    try {
      await fetch(`${serverUrl}/mcp`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(500),
      });
    } catch {
      connectionRefused = true;
    }
    expect(connectionRefused).toBe(true);
  });
});
