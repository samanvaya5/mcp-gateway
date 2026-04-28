import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, get as httpGet } from "node:http";
import type { Server as HttpServer } from "node:http";
import { registerApiRoutes, gatewayEvents } from "../src/api.js";
import type { GatewayConfig, ServerConfig } from "../src/types.js";
import { SpawnLock } from "../src/spawn-lock.js";
import type { LifecycleManager } from "../src/lifecycle.js";
import type { ToolRegistry } from "../src/registry.js";
import type { HealthTracker } from "../src/recovery.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "test-server",
    command: "echo",
    args: ["hello"],
    env: {},
    mode: "on-demand",
    idleTimeout: 60,
    disabled: false,
    ...overrides,
  };
}

function makeGatewayConfig(servers: ServerConfig[]): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    servers,
    registryPath: "/tmp/test-registry.json",
    logPath: "/tmp/test-gateway.log",
  };
}

function startTestServer(
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): Promise<{ server: HttpServer; port: number; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const raw = createServer();
    const server = raw as unknown as HttpServer;

    server.on("error", reject);

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

function mockLifecycle(): LifecycleManager & {
  _running: Set<string>;
  _pid: number;
} {
  const running = new Set<string>();
  return {
    _running: running,
    _pid: 99999,
    spawn: async (name: string, _config: ServerConfig, _lock: SpawnLock) => {
      running.add(name);
      return {
        pid: 99999,
        client: {} as unknown as ReturnType<LifecycleManager["spawn"]> extends Promise<infer T> ? T : never,
        transport: { pid: 99999 } as unknown as ReturnType<LifecycleManager["spawn"]> extends Promise<infer T> ? T : never,
      };
    },
    kill: async (name: string) => {
      running.delete(name);
    },
    get: (name: string) => {
      if (!running.has(name)) return undefined;
      return {
        client: {} as any,
        transport: { pid: 99999 } as any,
        startedAt: Date.now() - 60000,
        lastActivity: Date.now(),
        mode: "on-demand" as const,
      };
    },
    listRunning: () => Array.from(running),
    trackActivity: (_name: string) => {},
    killAll: async () => {
      running.clear();
    },
    killIfIdle: (_name: string, _cfg: ServerConfig) => {},
  } as unknown as LifecycleManager & { _running: Set<string>; _pid: number };
}

function mockRegistry(): ToolRegistry {
  return {
    tools: [
      {
        name: "github__list_repos",
        description: "List GitHub repositories",
        inputSchema: {},
        serverName: "github",
        originalName: "list_repos",
        versionHash: "abc123",
      },
      {
        name: "github__create_issue",
        description: "Create a GitHub issue",
        inputSchema: { type: "object" },
        serverName: "github",
        originalName: "create_issue",
        versionHash: "abc123",
      },
      {
        name: "slack__send_message",
        description: "Send a Slack message",
        inputSchema: {},
        serverName: "slack",
        originalName: "send_message",
        versionHash: "def456",
      },
    ],
    generatedAt: new Date().toISOString(),
    ttl: 3600,
    serverVersions: {},
    search: (query: string) => {
      const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      if (tokens.length === 0) return [];
      return (
        [
          {
            name: "github__list_repos",
            description: "List GitHub repositories",
            inputSchema: {},
            serverName: "github",
            originalName: "list_repos",
            versionHash: "abc123",
          },
          {
            name: "github__create_issue",
            description: "Create a GitHub issue",
            inputSchema: { type: "object" },
            serverName: "github",
            originalName: "create_issue",
            versionHash: "abc123",
          },
          {
            name: "slack__send_message",
            description: "Send a Slack message",
            inputSchema: {},
            serverName: "slack",
            originalName: "send_message",
            versionHash: "def456",
          },
        ] as ToolRegistry["tools"]
      ).filter((tool) => {
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      });
    },
  } as ToolRegistry;
}

function mockHealthTracker(): HealthTracker {
  let unhealthy = false;
  return {
    isHealthy: (_name: string) => !unhealthy,
    recordSuccess: (_name: string) => {},
    recordFailure: (_name: string, _error: Error) => {},
    getHealth: (_name: string) => undefined,
    getFailureCount: (_name: string) => 0,
    isUnhealthy: (_name: string) => unhealthy,
    set unhealthy(v: boolean) {
      unhealthy = v;
    },
  } as unknown as HealthTracker & { unhealthy: boolean };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("API Routes", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let lifecycle: ReturnType<typeof mockLifecycle>;
  let registry: ToolRegistry;
  let healthTracker: ReturnType<typeof mockHealthTracker>;
  let config: GatewayConfig;

  beforeEach(async () => {
    const servers: ServerConfig[] = [
      makeServerConfig({
        name: "github",
        command: "github-mcp",
        args: ["--stdio"],
        env: { GITHUB_TOKEN: "secret123", NODE_ENV: "production" },
        mode: "persistent",
      }),
      makeServerConfig({
        name: "slack",
        command: "slack-mcp",
        args: ["--stdio"],
        env: { SLACK_API_KEY: "secret456", LOG_LEVEL: "debug" },
        mode: "on-demand",
        idleTimeout: 300,
      }),
    ];

    config = makeGatewayConfig(servers);
    lifecycle = mockLifecycle();
    registry = mockRegistry();
    healthTracker = mockHealthTracker();

    // Ensure no leftover event listeners from previous tests
    gatewayEvents.removeAllListeners("gateway_event");

    const result = await startTestServer(
      config,
      lifecycle as unknown as LifecycleManager,
      registry,
      healthTracker as unknown as HealthTracker,
    );
    httpServer = result.server;
    baseUrl = result.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // ── Test 1: GET /api/health ────────────────────────────────────

  test("1. GET /api/health returns ok with correct fields", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.serversTotal).toBe(2);
    expect(typeof body.serversRunning).toBe("number");
    expect(typeof body.memoryMB).toBe("number");
    expect(body.memoryMB).toBeGreaterThan(0);
  });

  // ── Test 2: GET /api/servers ───────────────────────────────────

  test("2. GET /api/servers lists all servers with correct status", async () => {
    // Start github server to have a running server
    lifecycle._running.add("github");

    const res = await fetch(`${baseUrl}/api/servers`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.servers).toBeArray();
    expect(body.servers.length).toBe(2);

    const github = body.servers.find((s: any) => s.name === "github");
    expect(github).toBeDefined();
    expect(github.status).toBe("running");
    expect(github.mode).toBe("persistent");
    expect(typeof github.uptime).toBe("number");

    const slack = body.servers.find((s: any) => s.name === "slack");
    expect(slack).toBeDefined();
    expect(slack.status).toBe("stopped");
    expect(slack.mode).toBe("on-demand");
    expect(slack.uptime).toBeUndefined();
  });

  // ── Test 3: GET /api/servers/:name ─────────────────────────────

  test("3. GET /api/servers/:name returns details (200) or 404", async () => {
    lifecycle._running.add("github");

    // Known server — 200
    const resOk = await fetch(`${baseUrl}/api/servers/github`);
    expect(resOk.status).toBe(200);
    const bodyOk = await resOk.json();
    expect(bodyOk.name).toBe("github");
    expect(bodyOk.mode).toBe("persistent");
    expect(bodyOk.status).toBe("running");
    expect(typeof bodyOk.pid).toBe("number");
    expect(typeof bodyOk.uptime).toBe("number");
    expect(typeof bodyOk.lastActivity).toBe("string");

    // Unknown server — 404
    const res404 = await fetch(`${baseUrl}/api/servers/unknown-srv`);
    expect(res404.status).toBe(404);
    const body404 = await res404.json();
    expect(body404.error).toBeDefined();
  });

  // ── Test 4: POST /api/servers/:name/start ──────────────────────

  test("4. POST /api/servers/:name/start spawns server (200) or returns 400/404", async () => {
    // Not running — 200
    const resOk = await fetch(`${baseUrl}/api/servers/slack/start`, {
      method: "POST",
    });
    expect(resOk.status).toBe(200);
    const bodyOk = await resOk.json();
    expect(bodyOk.status).toBe("started");
    expect(typeof bodyOk.pid).toBe("number");
    expect(lifecycle._running.has("slack")).toBe(true);

    // Already running — 400
    const res400 = await fetch(`${baseUrl}/api/servers/slack/start`, {
      method: "POST",
    });
    expect(res400.status).toBe(400);
    const body400 = await res400.json();
    expect(body400.error).toContain("already running");

    // Unknown server — 404
    const res404 = await fetch(`${baseUrl}/api/servers/unknown-srv/start`, {
      method: "POST",
    });
    expect(res404.status).toBe(404);
  });

  // ── Test 5: POST /api/servers/:name/stop ───────────────────────

  test("5. POST /api/servers/:name/stop kills server (200) or returns 400/404", async () => {
    // Start first
    lifecycle._running.add("github");

    // Running — 200
    const resOk = await fetch(`${baseUrl}/api/servers/github/stop`, {
      method: "POST",
    });
    expect(resOk.status).toBe(200);
    const bodyOk = await resOk.json();
    expect(bodyOk.status).toBe("stopped");
    expect(lifecycle._running.has("github")).toBe(false);

    // Not running — 400
    const res400 = await fetch(`${baseUrl}/api/servers/slack/stop`, {
      method: "POST",
    });
    expect(res400.status).toBe(400);
    const body400 = await res400.json();
    expect(body400.error).toContain("not running");

    // Unknown server — 404
    const res404 = await fetch(`${baseUrl}/api/servers/unknown-srv/stop`, {
      method: "POST",
    });
    expect(res404.status).toBe(404);
  });

  // ── Test 6: POST /api/servers/:name/restart ────────────────────

  test("6. POST /api/servers/:name/restart cycles successfully", async () => {
    lifecycle._running.add("github");

    const res = await fetch(`${baseUrl}/api/servers/github/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restarted");
    expect(typeof body.pid).toBe("number");
    expect(lifecycle._running.has("github")).toBe(true);

    // Unknown server — 404
    const res404 = await fetch(`${baseUrl}/api/servers/unknown-srv/restart`, {
      method: "POST",
    });
    expect(res404.status).toBe(404);
  });

  // ── Test 7: GET /api/tools ─────────────────────────────────────

  test("7. GET /api/tools returns all cached tools", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body.tools).toBeArray();
    expect(body.tools.length).toBe(3);

    const names = body.tools.map((t: any) => t.name);
    expect(names).toContain("github__list_repos");
    expect(names).toContain("github__create_issue");
    expect(names).toContain("slack__send_message");
  });

  // ── Test 8: GET /api/tools?q=github ────────────────────────────

  test("8. GET /api/tools?q=github filters results correctly", async () => {
    const res = await fetch(`${baseUrl}/api/tools?q=github`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.tools).toBeArray();
    expect(body.tools.length).toBe(2);

    const names = body.tools.map((t: any) => t.name);
    expect(names).toContain("github__list_repos");
    expect(names).toContain("github__create_issue");

    // Filter by different query
    const res2 = await fetch(`${baseUrl}/api/tools?q=slack`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.tools.length).toBe(1);
    expect(body2.tools[0].name).toBe("slack__send_message");

    // No match query
    const res3 = await fetch(`${baseUrl}/api/tools?q=nonexistent`);
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.tools.length).toBe(0);
  });

  // ── Test 9: GET /api/events SSE stream ─────────────────────────

  test("9. GET /api/events opens SSE stream and receives events", async () => {
    const url = new URL(`${baseUrl}/api/events`);

    await new Promise<void>((resolve, reject) => {
      const req = httpGet(url, (res) => {
        expect(res.statusCode).toBe(200);
        const ct = res.headers["content-type"] ?? "";
        expect(ct).toContain("text/event-stream");

        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes("server_started") && data.includes("test-srv")) {
            req.destroy();
            resolve();
          }
        });

        res.on("error", reject);
      });

      req.on("error", reject);

      // Emit an event after the connection is established
      setTimeout(() => {
        gatewayEvents.emit("gateway_event", {
          event: "server_started",
          server: "test-srv",
          timestamp: "2025-01-01T00:00:00Z",
        });
      }, 100);
    });
  });
});
