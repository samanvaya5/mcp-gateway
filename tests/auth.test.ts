import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { registerApiRoutes } from "../src/api.ts";
import type { GatewayConfig, ServerConfig } from "../src/types.ts";
import type { LifecycleManager } from "../src/lifecycle.ts";
import type { ToolRegistry } from "../src/registry.ts";
import type { HealthTracker } from "../src/recovery.ts";

function makeGatewayConfig(token?: string): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    servers: [],
    registryPath: "/tmp/test-registry.json",
    logPath: "/tmp/test-gateway.log",
    token,
  };
}

function startTestServer(
  config: GatewayConfig
): Promise<{ server: HttpServer; port: number; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer() as unknown as HttpServer;
    const lifecycle = {
      listRunning: () => []
    } as unknown as LifecycleManager;
    const registry = { tools: [], search: () => [] } as unknown as ToolRegistry;
    const healthTracker = { isHealthy: () => true } as unknown as HealthTracker;

    registerApiRoutes(server, config, lifecycle, registry, healthTracker);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("No address"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

describe("Authentication", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  const testToken = "test-secret-token";

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  test("API: Request fails without token when token is configured", async () => {
    const config = makeGatewayConfig(testToken);
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/servers`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Unauthorized");
  });

  test("API: Request fails with invalid token when token is configured", async () => {
    const config = makeGatewayConfig(testToken);
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/servers`, {
      headers: { "Authorization": "Bearer wrong-token" }
    });
    expect(res.status).toBe(401);
  });

  test("API: Request succeeds with valid token when token is configured", async () => {
    const config = makeGatewayConfig(testToken);
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/servers`, {
      headers: { "Authorization": `Bearer ${testToken}` }
    });
    expect(res.status).toBe(200);
  });

  test("API: Health check succeeds without token even if token is configured", async () => {
    const config = makeGatewayConfig(testToken);
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
  });

  test("API: Request succeeds without token when no token is configured", async () => {
    const config = makeGatewayConfig(undefined);
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/servers`);
    expect(res.status).toBe(200);
  });

  test("API: Request succeeds without token when noAuth is enabled (even if token exists)", async () => {
    const config = makeGatewayConfig(testToken);
    config.noAuth = true;
    const result = await startTestServer(config);
    httpServer = result.server;
    baseUrl = result.baseUrl;

    const res = await fetch(`${baseUrl}/api/servers`);
    expect(res.status).toBe(200);
  });
});
