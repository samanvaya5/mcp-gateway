import { describe, test, expect, mock } from "bun:test";
import type { GatewayConfig, ServerConfig, ToolEntry } from "../src/types.js";
import { ToolRegistry } from "../src/registry.js";
import { LifecycleManager } from "../src/lifecycle.js";
import { HealthTracker } from "../src/recovery.js";
import type { SpawnLock } from "../src/spawn-lock.js";
import {
  handleSearchTools,
  handleListServers,
  handleServerStatus,
  handleManageServer,
} from "../src/tools.js";

function makeToolEntry(overrides?: Partial<ToolEntry>): ToolEntry {
  return {
    name: "test-server__testTool",
    description: "A test tool",
    inputSchema: {},
    serverName: "test-server",
    originalName: "testTool",
    versionHash: "abc123",
    ...overrides,
  };
}

function makeServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    name: "test-server",
    command: "node",
    args: ["server.js"],
    env: {},
    mode: "on-demand",
    idleTimeout: 300,
    disabled: false,
    ...overrides,
  };
}

function makeGatewayConfig(servers: ServerConfig[]): GatewayConfig {
  return {
    port: 8000,
    host: "127.0.0.1",
    servers,
    registryPath: "/tmp/mcp-gateway/registry.json",
    logPath: "/tmp/mcp-gateway.log",
  };
}

function makeMockLifecycle(
  overrides?: Partial<{
    listRunning: () => string[];
    kill: (name: string) => Promise<void>;
    spawn: (name: string, config: ServerConfig, lock: SpawnLock) => Promise<unknown>;
    get: (name: string) => unknown;
  }>,
) {
  return {
    listRunning: mock(() => []),
    kill: mock(async (_name: string) => {}),
    spawn: mock(async (_name: string, _config: ServerConfig, _lock: SpawnLock) => ({
      pid: 1234,
      client: {},
      transport: { pid: 1234 },
    })),
    get: mock((_name: string) => undefined),
    ...overrides,
  } as unknown as LifecycleManager;
}

function makeMockHealthTracker(
  overrides?: Partial<{
    isHealthy: (name: string) => boolean;
  }>,
) {
  return {
    isHealthy: mock(() => true),
    ...overrides,
  } as unknown as HealthTracker;
}

function makeMockSpawnLock(): SpawnLock {
  return {
    acquire: mock(async <T>(_name: string, fn: () => Promise<T>) => fn()),
  } as unknown as SpawnLock;
}

// ─────────────────────────────────────────────────────────────────
// Test 1: search_tools returns namespaced results from registry
// ─────────────────────────────────────────────────────────────────
describe("handleSearchTools", () => {
  test("returns namespaced results from registry", () => {
    const registry = new ToolRegistry();
    registry.tools = [
      makeToolEntry({ name: "weather__forecast", serverName: "weather", description: "Get weather forecast" }),
      makeToolEntry({ name: "db__query", serverName: "db", description: "Run SQL query" }),
    ];
    const healthTracker = makeMockHealthTracker();

    const result = handleSearchTools("weather", registry, healthTracker);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.name).toBe("weather__forecast");
    expect(result.results[0]!.server).toBe("weather");
    expect(result.results[0]!.description).toBe("Get weather forecast");
    expect(result.results[0]!.serverStatus).toBe("healthy");
  });

  // Test 2: excludes tools from unhealthy servers
  test("excludes tools from unhealthy servers", () => {
    const registry = new ToolRegistry();
    registry.tools = [
      makeToolEntry({ name: "math__add", serverName: "math", description: "Add numbers" }),
      makeToolEntry({ name: "math__multiply", serverName: "math", description: "Multiply numbers" }),
      makeToolEntry({ name: "db__query", serverName: "db", description: "Run query" }),
    ];
    const healthTracker = makeMockHealthTracker({
      isHealthy: mock((name: string) => name !== "math"),
    });

    const result = handleSearchTools("math", registry, healthTracker);

    // Only db__query should appear because math server is marked unhealthy
    // (but it doesn't match the query either), and math__add/multiply are filtered out
    expect(result.results).toHaveLength(0);
  });

  // Test 3: returns empty results for no-match query
  test("returns empty results for no-match query", () => {
    const registry = new ToolRegistry();
    registry.tools = [
      makeToolEntry({ name: "aws__s3_list", serverName: "aws", description: "List S3 buckets" }),
    ];
    const healthTracker = makeMockHealthTracker();

    const result = handleSearchTools("nonexistent", registry, healthTracker);

    expect(result.results).toEqual([]);
  });

  // Bonus: empty query returns empty
  test("returns empty for empty query", () => {
    const registry = new ToolRegistry();
    registry.tools = [
      makeToolEntry({ name: "test__tool", serverName: "test", description: "A tool" }),
    ];
    const healthTracker = makeMockHealthTracker();

    const result = handleSearchTools("", registry, healthTracker);

    expect(result.results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Test 4: list_servers shows all configured servers with correct statuses
// ─────────────────────────────────────────────────────────────────
describe("handleListServers", () => {
  test("shows all configured servers with correct statuses", () => {
    const config = makeGatewayConfig([
      makeServerConfig({ name: "web", mode: "persistent", idleTimeout: 0 }),
      makeServerConfig({ name: "worker", mode: "on-demand", idleTimeout: 600 }),
    ]);
    const lifecycle = makeMockLifecycle({
      listRunning: mock(() => []),
    });
    const healthTracker = makeMockHealthTracker();

    const result = handleListServers(config, lifecycle, healthTracker);

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]!.name).toBe("web");
    expect(result.servers[0]!.mode).toBe("persistent");
    expect(result.servers[0]!.status).toBe("stopped");
    expect(result.servers[0]!.idleTimeout).toBe(0);
    expect(result.servers[0]!.disabled).toBe(false);
    expect(result.servers[1]!.name).toBe("worker");
    expect(result.servers[1]!.mode).toBe("on-demand");
    expect(result.servers[1]!.idleTimeout).toBe(600);
  });

  // Test 5: shows running/stopped/unhealthy/disabled statuses correctly
  test("shows running, stopped, unhealthy, and disabled statuses correctly", () => {
    const config = makeGatewayConfig([
      makeServerConfig({ name: "running-srv", command: "node", args: [] }),
      makeServerConfig({ name: "stopped-srv", command: "node", args: [] }),
      makeServerConfig({ name: "unhealthy-srv", command: "node", args: [] }),
      makeServerConfig({ name: "disabled-srv", command: "node", args: [], disabled: true }),
    ]);
    const lifecycle = makeMockLifecycle({
      listRunning: mock(() => ["running-srv", "unhealthy-srv"]),
    });
    const healthTracker = makeMockHealthTracker({
      isHealthy: mock((name: string) => {
        const healthy = new Map([
          ["running-srv", true],
          ["stopped-srv", true],
          ["unhealthy-srv", false],
          ["disabled-srv", false],
        ]);
        return healthy.get(name) ?? true;
      }),
    });

    const result = handleListServers(config, lifecycle, healthTracker);

    expect(result.servers).toHaveLength(4);

    const running = result.servers.find((s) => s.name === "running-srv")!;
    expect(running.status).toBe("running");

    const stopped = result.servers.find((s) => s.name === "stopped-srv")!;
    expect(stopped.status).toBe("stopped");

    const unhealthy = result.servers.find((s) => s.name === "unhealthy-srv")!;
    expect(unhealthy.status).toBe("unhealthy");

    const disabled = result.servers.find((s) => s.name === "disabled-srv")!;
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Test 6: server_status returns full detail for running server
// ─────────────────────────────────────────────────────────────────
describe("handleServerStatus", () => {
  test("returns full detail for running server", () => {
    const config = makeGatewayConfig([
      makeServerConfig({ name: "srv", command: "node", args: ["--serve"], mode: "persistent" }),
    ]);
    const startedAt = Date.now() - 5000;
    const lifecycle = makeMockLifecycle({
      listRunning: mock(() => ["srv"]),
      get: mock((_name: string) => ({
        client: {},
        transport: { pid: 9999 },
        startedAt,
        lastActivity: Date.now() - 2000,
        mode: "persistent",
      })),
    });
    const healthTracker = makeMockHealthTracker();

    const result = handleServerStatus("srv", config, lifecycle, healthTracker);

    expect(result.name).toBe("srv");
    expect(result.mode).toBe("persistent");
    expect(result.status).toBe("running");
    expect(result.pid).toBe(9999);
    expect(result.uptime).toBeGreaterThan(4000);
    expect(result.lastActivity).toBeGreaterThan(startedAt);
    expect(result.disabled).toBe(false);
  });

  // Test 7: returns basic info for stopped server
  test("returns basic info for stopped server", () => {
    const config = makeGatewayConfig([
      makeServerConfig({ name: "dormant", command: "sleep", args: ["infinity"], mode: "on-demand", idleTimeout: 120 }),
    ]);
    const lifecycle = makeMockLifecycle();
    const healthTracker = makeMockHealthTracker();

    const result = handleServerStatus("dormant", config, lifecycle, healthTracker);

    expect(result.name).toBe("dormant");
    expect(result.mode).toBe("on-demand");
    expect(result.status).toBe("stopped");
    expect(result.pid).toBeUndefined();
    expect(result.uptime).toBeUndefined();
    expect(result.disabled).toBe(false);
  });

  // Test 8: returns error for unknown server
  test("throws error for unknown server", () => {
    const config = makeGatewayConfig([]);
    const lifecycle = makeMockLifecycle();
    const healthTracker = makeMockHealthTracker();

    expect(() => handleServerStatus("ghost", config, lifecycle, healthTracker)).toThrow("Unknown server: ghost");
  });

  test("reports disabled server correctly", () => {
    const config = makeGatewayConfig([
      makeServerConfig({ name: "off", command: "node", args: [], disabled: true }),
    ]);
    const lifecycle = makeMockLifecycle();
    const healthTracker = makeMockHealthTracker();

    const result = handleServerStatus("off", config, lifecycle, healthTracker);

    expect(result.status).toBe("disabled");
    expect(result.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Test 9: manage_server disable kills running server and sets disabled
// ─────────────────────────────────────────────────────────────────
describe("handleManageServer", () => {
  test("disable kills running server and sets disabled flag", async () => {
    const serverConfig = makeServerConfig({ name: "target-srv", disabled: false });
    const config = makeGatewayConfig([serverConfig]);
    const lifecycle = makeMockLifecycle();
    const spawnLock = makeMockSpawnLock();

    const result = await handleManageServer("target-srv", "disable", config, lifecycle, spawnLock);

    expect(result.server).toBe("target-srv");
    expect(result.action).toBe("disable");
    expect(result.result).toBe("ok");
    expect(serverConfig.disabled).toBe(true);
    expect(lifecycle.kill).toHaveBeenCalledWith("target-srv");
  });

  // Test 10: manage_server enable allows subsequent spawn
  test("enable sets disabled to false", async () => {
    const serverConfig = makeServerConfig({ name: "target-srv", disabled: true });
    const config = makeGatewayConfig([serverConfig]);
    const lifecycle = makeMockLifecycle();
    const spawnLock = makeMockSpawnLock();

    await handleManageServer("target-srv", "enable", config, lifecycle, spawnLock);

    expect(serverConfig.disabled).toBe(false);
  });

  // Test 11: manage_server restart kills and respawns
  test("restart kills and respawns the server", async () => {
    const serverConfig = makeServerConfig({ name: "target-srv", disabled: false });
    const config = makeGatewayConfig([serverConfig]);
    const lifecycle = makeMockLifecycle();
    const spawnLock = makeMockSpawnLock();

    await handleManageServer("target-srv", "restart", config, lifecycle, spawnLock);

    expect(lifecycle.kill).toHaveBeenCalledWith("target-srv");
    expect(lifecycle.spawn).toHaveBeenCalledWith("target-srv", serverConfig, spawnLock);
  });

  test("throws error for unknown server", async () => {
    const config = makeGatewayConfig([]);
    const lifecycle = makeMockLifecycle();
    const spawnLock = makeMockSpawnLock();

    await expect(handleManageServer("ghost", "enable", config, lifecycle, spawnLock)).rejects.toThrow(
      "Unknown server: ghost",
    );
  });

  test("throws error for unknown action", async () => {
    const serverConfig = makeServerConfig({ name: "srv" });
    const config = makeGatewayConfig([serverConfig]);
    const lifecycle = makeMockLifecycle();
    const spawnLock = makeMockSpawnLock();

    await expect(
      handleManageServer("srv", "destroy" as never, config, lifecycle, spawnLock),
    ).rejects.toThrow("Unknown action: destroy");
  });
});
