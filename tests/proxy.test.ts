import { describe, test, expect, mock, spyOn } from "bun:test";
import {
  handleToolsList,
  handleToolsCall,
  parseNamespacedToolName,
  findServerConfig,
  errorResult,
} from "../src/proxy.js";
import { LifecycleManager } from "../src/lifecycle.js";
import { ToolRegistry } from "../src/registry.js";
import { HealthTracker } from "../src/recovery.js";
import { SpawnLock } from "../src/spawn-lock.js";
import type { GatewayConfig, ServerConfig, ToolEntry } from "../src/types.js";

function makeServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "test-server",
    command: "node",
    args: ["server.js"],
    env: {},
    mode: "on-demand",
    idleTimeout: 60,
    disabled: false,
    ...overrides,
  };
}

function makeConfig(servers: ServerConfig[]): GatewayConfig {
  return {
    port: 8080,
    host: "localhost",
    servers,
    registryPath: "/tmp/registry.json",
    logPath: "/tmp/logs",
  };
}

function makeMockCallToolResult(content?: string) {
  return {
    content: [{ type: "text" as const, text: content ?? "ok" }],
  };
}

function makeMockClient(callToolImpl = () => Promise.resolve(makeMockCallToolResult())) {
  return {
    callTool: mock(callToolImpl),
  };
}

// ── parseNamespacedToolName / findServerConfig / errorResult ──────

describe("proxy helpers", () => {
  test("parseNamespacedToolName splits on __", () => {
    expect(parseNamespacedToolName("echo__greet")).toEqual({
      serverName: "echo",
      originalToolName: "greet",
    });
    expect(parseNamespacedToolName("db__query__v2")).toEqual({
      serverName: "db",
      originalToolName: "query__v2",
    });
    expect(parseNamespacedToolName("notoolsep")).toBeNull();
    expect(parseNamespacedToolName("")).toBeNull();
  });

  test("findServerConfig returns matching server", () => {
    const config = makeConfig([
      makeServerConfig({ name: "alpha" }),
      makeServerConfig({ name: "beta" }),
    ]);
    expect(findServerConfig(config, "alpha")?.name).toBe("alpha");
    expect(findServerConfig(config, "beta")?.name).toBe("beta");
    expect(findServerConfig(config, "gamma")).toBeUndefined();
  });

  test("errorResult returns structured MCP error", () => {
    const result = errorResult("something went wrong");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "something went wrong" }]);
  });
});

// ── tools/list handler ────────────────────────────────────────────

describe("handleToolsList", () => {
  test("returns only gateway-native tools, not backend tools", async () => {
    const registry = new ToolRegistry();
    registry.tools = [
      { name: "echo__greet", description: "Say hello", inputSchema: {}, serverName: "echo", originalName: "greet", versionHash: "abc" },
      { name: "calc__add", description: "Add numbers", inputSchema: {}, serverName: "calc", originalName: "add", versionHash: "def" },
    ] as ToolEntry[];

    const config = makeConfig([]);

    const result = await handleToolsList(registry, config);

    // 12 gateway-native tools are now exposed
    expect(result.tools).toHaveLength(12);
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("search_tools");
    expect(toolNames).toContain("list_servers");
    expect(toolNames).toContain("browse_server");
    expect(toolNames).toContain("server_status");
    expect(toolNames).toContain("manage_server");
    expect(toolNames).not.toContain("echo__greet");
    expect(toolNames).not.toContain("calc__add");
  });

  test("triggers refresh when registry is stale but still only returns gateway tools", async () => {
    const registry = new ToolRegistry();
    registry.tools = [];
    registry.serverVersions = {}; // empty versions → stale

    const server = makeServerConfig({ name: "echo" });
    const config = makeConfig([server]);

    let refreshCalled = false;
    registry.refresh = mock(async (_cfg) => {
      refreshCalled = true;
      registry.tools = [
        { name: "echo__greet", description: "Hi", inputSchema: {}, serverName: "echo", originalName: "greet", versionHash: "xyz" },
      ] as ToolEntry[];
    });

    const result = await handleToolsList(registry, config);

    expect(refreshCalled).toBe(true);
    // Still only 12 gateway-native tools exposed
    expect(result.tools).toHaveLength(12);
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("browse_server");
    expect(toolNames).not.toContain("echo__greet");
  });
});

// ── tools/call handler ────────────────────────────────────────────

describe("handleToolsCall", () => {
  test("routes to correct server based on prefix", async () => {
    const config = makeConfig([makeServerConfig({ name: "echo" })]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    let receivedName = "";
    let receivedArgs: any = undefined;

    const mockClient = makeMockClient((params: any) => {
      receivedName = params.name;
      receivedArgs = params.arguments;
      return Promise.resolve(makeMockCallToolResult("echoed"));
    });

    spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);
    spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

    const result = await handleToolsCall(
      { name: "echo__greet", arguments: { name: "World" } },
      config,
      lifecycle,
      healthTracker,
      spawnLock,
    );

    expect(result.isError).toBeFalsy();
    expect(receivedName).toBe("greet");
    expect(receivedArgs).toEqual({ name: "World" });
  });

  test("spawns server if not running", async () => {
    const serverConfig = makeServerConfig({ name: "echo" });
    const config = makeConfig([serverConfig]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    const mockClient = makeMockClient();
    let spawnCalled = false;
    spyOn(lifecycle, "spawn").mockImplementation(async (name, cfg, lock) => {
      spawnCalled = true;
      expect(name).toBe("echo");
      expect(cfg).toBe(serverConfig);
      return { client: mockClient } as any;
    });
    spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

    await handleToolsCall({ name: "echo__greet" }, config, lifecycle, healthTracker, spawnLock);

    expect(spawnCalled).toBe(true);
  });

  test("updates lastActivity after call", async () => {
    const config = makeConfig([makeServerConfig({ name: "echo" })]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    const mockClient = makeMockClient();
    spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);

    let trackedName = "";
    spyOn(lifecycle, "trackActivity").mockImplementation((name: string) => {
      trackedName = name;
    });

    await handleToolsCall({ name: "echo__greet" }, config, lifecycle, healthTracker, spawnLock);

    expect(trackedName).toBe("echo");
  });

  test("returns error for unknown server", async () => {
    const config = makeConfig([makeServerConfig({ name: "echo" })]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    const result = await handleToolsCall(
      { name: "unknown__tool" },
      config,
      lifecycle,
      healthTracker,
      spawnLock,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unknown server");
  });

  test("returns error when server is unhealthy", async () => {
    const config = makeConfig([makeServerConfig({ name: "echo" })]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    healthTracker.markUnhealthy("echo", new Error("crash"));

    const result = await handleToolsCall(
      { name: "echo__greet" },
      config,
      lifecycle,
      healthTracker,
      spawnLock,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unhealthy");
  });

  test("returns error for disabled server", async () => {
    const config = makeConfig([
      makeServerConfig({ name: "echo", disabled: true }),
    ]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    const result = await handleToolsCall(
      { name: "echo__greet" },
      config,
      lifecycle,
      healthTracker,
      spawnLock,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("disabled");
  });

  test("propagates upstream error from remote tool", async () => {
    const config = makeConfig([makeServerConfig({ name: "echo" })]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    const mockClient = makeMockClient(() =>
      Promise.reject(new Error("remote tool crashed")),
    );

    spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);
    spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

    const result = await handleToolsCall(
      { name: "echo__greet" },
      config,
      lifecycle,
      healthTracker,
      spawnLock,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("remote tool crashed");
  });

  test("concurrent calls to same server share one spawn via SpawnLock", async () => {
    const serverConfig = makeServerConfig({ name: "echo" });
    const config = makeConfig([serverConfig]);
    const lifecycle = new LifecycleManager();
    const healthTracker = new HealthTracker();
    const spawnLock = new SpawnLock();

    let spawnCalls = 0;
    const mockClient = makeMockClient();

    spyOn(lifecycle, "spawn").mockImplementation(async (name, cfg, lock) => {
      return lock!.acquire(name, async () => {
        spawnCalls++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { client: mockClient } as any;
      });
    });
    spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

    const [r1, r2] = await Promise.all([
      handleToolsCall({ name: "echo__greet" }, config, lifecycle, healthTracker, spawnLock),
      handleToolsCall({ name: "echo__count" }, config, lifecycle, healthTracker, spawnLock),
    ]);

    expect(spawnCalls).toBe(1);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
  });
});
