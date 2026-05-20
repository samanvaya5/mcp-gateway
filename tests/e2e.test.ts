/**
 * e2e.test.ts — End-to-end integration tests for the MCP Gateway.
 *
 * These tests verify full user-facing scenarios across module boundaries:
 * cold start, tool discovery, on-demand spawning, tool proxying, idle kill,
 * concurrent calls, crash recovery, config hot-reload, and graceful shutdown.
 *
 * Transport is mocked (same pattern as lifecycle.test.ts) so tests run
 * without real child processes or external MCP servers.
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Modules under test
import { LifecycleManager } from "../src/lifecycle.js";
import { ToolRegistry } from "../src/registry.js";
import { HealthTracker } from "../src/recovery.js";
import { SpawnLock } from "../src/spawn-lock.js";
import {
  handleToolsList,
  handleToolsCall,
} from "../src/proxy.js";
import { handleSearchTools } from "../src/tools.js";
import { registerApiRoutes } from "../src/api.js";
import type { GatewayConfig, ServerConfig, ToolEntry } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "test-server",
    command: "node",
    args: ["server.js"],
    env: {},
    mode: "on-demand" as const,
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
    registryPath: "/tmp/test-e2e-registry.json",
    logPath: "/tmp/test-e2e-gateway.log",
  };
}

function makeMockCallToolResult(content?: string) {
  return {
    content: [{ type: "text" as const, text: content ?? "ok" }],
  };
}

function makeMockClient(callToolImpl?: (params: any) => Promise<any>) {
  return {
    callTool: mock(callToolImpl ?? (() => Promise.resolve(makeMockCallToolResult()))),
    listTools: mock(() =>
      Promise.resolve({
        tools: [
          { name: "greet", description: "Say hello", inputSchema: {} },
          { name: "count", description: "Count items", inputSchema: {} },
        ],
      }),
    ),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextPid = 50000;
function allocPid(): number {
  return nextPid++;
}

// Global mock for @modelcontextprotocol/client (same pattern as lifecycle.test.ts)
mock.module("@modelcontextprotocol/client", () => ({
  Client: class {
    async connect() {}
    getServerVersion() { return undefined; }
    getInstructions() { return undefined; }
  },
  StdioClientTransport: class {
    pid: number | null = allocPid();
    onclose?: () => void;
    onerror?: (err: Error) => void;
    onmessage?: (msg: unknown) => void;
    async start() {}
    async close() {
      this.onclose?.();
    }
    async send() {}
  },
}));

// ── HTTP test server helper ───────────────────────────────────────

function startTestApiServer(
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): Promise<{ server: HttpServer; baseUrl: string }> {
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
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════

describe("e2e: MCP Gateway full lifecycle", () => {
  // ── Test 1: Cold start ──────────────────────────────────────
  describe("1. COLD START", () => {
    test("health endpoint returns ok with zero running servers on startup", async () => {
      const config = makeGatewayConfig([makeServerConfig({ name: "echo" })]);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.serversTotal).toBe(1);
      expect(body.serversRunning).toBe(0);
      expect(typeof body.uptime).toBe("number");
      expect(typeof body.memoryMB).toBe("number");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("/api/servers returns all configured servers as stopped", async () => {
      const servers = [
        makeServerConfig({ name: "alpha", mode: "persistent" }),
        makeServerConfig({ name: "beta", mode: "on-demand", idleTimeout: 120 }),
      ];
      const config = makeGatewayConfig(servers);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      const res = await fetch(`${baseUrl}/api/servers`);
      const body = await res.json();

      expect(body.servers).toHaveLength(2);
      const alpha = body.servers.find((s: any) => s.name === "alpha");
      const beta = body.servers.find((s: any) => s.name === "beta");
      expect(alpha.status).toBe("stopped");
      expect(alpha.mode).toBe("persistent");
      expect(beta.status).toBe("stopped");
      expect(beta.mode).toBe("on-demand");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  // ── Test 2: Tool discovery without spawn ────────────────────
  describe("2. TOOL DISCOVERY WITHOUT SPAWN", () => {
    test("handleToolsList returns cached tools without spawning processes", async () => {
      const registry = new ToolRegistry();
      registry.tools = [
        {
          name: "echo__greet",
          description: "Say hello",
          inputSchema: {},
          serverName: "echo",
          originalName: "greet",
          versionHash: "abc",
        },
        {
          name: "calc__add",
          description: "Add two numbers",
          inputSchema: { type: "object" },
          serverName: "calc",
          originalName: "add",
          versionHash: "def",
        },
      ] as ToolEntry[];
      registry.generatedAt = new Date().toISOString();
      registry.serverVersions = { echo: "abc", calc: "def" };

      const lifecycle = new LifecycleManager();
      const spawnLock = new SpawnLock();
      const config = makeGatewayConfig([
        makeServerConfig({ name: "echo" }),
        makeServerConfig({ name: "calc" }),
      ]);

      const spawnSpy = spyOn(lifecycle, "spawn");
      // Prevent auto-refresh — tools are already populated
      spyOn(registry, "isStale").mockReturnValue(false);

      const result = await handleToolsList(registry, config, lifecycle, spawnLock);

      // Only gateway-native tools are exposed to prevent context bloat
      expect(result.tools).toHaveLength(12);
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("search_tools");
      expect(toolNames).toContain("describe_tool");
      expect(toolNames).toContain("execute_tool");
      expect(toolNames).toContain("list_servers");
      expect(toolNames).toContain("browse_server");
      expect(toolNames).toContain("server_status");
      expect(toolNames).toContain("manage_server");
      // Backend tools should NOT be directly exposed
      expect(toolNames).not.toContain("echo__greet");
      expect(toolNames).not.toContain("calc__add");
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(lifecycle.listRunning()).toHaveLength(0);
    });

    test("search_tools returns results from registry without spawning", async () => {
      const registry = new ToolRegistry();
      registry.tools = [
        {
          name: "github__list_repos",
          description: "List GitHub repositories",
          inputSchema: {},
          serverName: "github",
          originalName: "list_repos",
          versionHash: "abc",
        },
        {
          name: "github__create_issue",
          description: "Create a GitHub issue",
          inputSchema: { type: "object" },
          serverName: "github",
          originalName: "create_issue",
          versionHash: "abc",
        },
      ] as ToolEntry[];

      const healthTracker = new HealthTracker();

      const result = handleSearchTools("github", registry, healthTracker);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]!.name).toBe("github__list_repos");
      expect(result.results[0]!.server).toBe("github");
      expect(result.results[1]!.name).toBe("github__create_issue");
    });
  });

  // ── Test 3: First tool call spawns server ───────────────────
  describe("3. FIRST TOOL CALL SPAWNS", () => {
    test("handleToolsCall spawns server on first call and succeeds", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();
      const mockClient = makeMockClient();

      let spawnCalled = false;
      spyOn(lifecycle, "spawn").mockImplementation(async () => {
        spawnCalled = true;
        return { client: mockClient } as any;
      });
      spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

      const config = makeGatewayConfig([makeServerConfig({ name: "echo" })]);

      expect(lifecycle.listRunning()).toHaveLength(0);

      const result = await handleToolsCall(
        { name: "echo__greet", arguments: { name: "World" } },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBeFalsy();
      expect(spawnCalled).toBe(true);
      expect(mockClient.callTool).toHaveBeenCalledWith(
        { name: "greet", arguments: { name: "World" } },
        { timeout: 10000 },
      );
    });

    test("call succeeds without errors when spawn resolves correctly", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      let callToolParams: any = null;
      const mockClient = makeMockClient((params) => {
        callToolParams = params;
        return Promise.resolve(makeMockCallToolResult("hello from echo"));
      });

      spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);
      spyOn(lifecycle, "trackActivity").mockImplementation(() => {});
      spyOn(healthTracker, "recordSuccess");

      const config = makeGatewayConfig([makeServerConfig({ name: "echo" })]);

      const result = await handleToolsCall(
        { name: "echo__greet" },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBeFalsy();
      expect(callToolParams.name).toBe("greet");
      expect(healthTracker.recordSuccess).toHaveBeenCalledWith("echo");
    });
  });

  // ── Test 4: Idle kill ───────────────────────────────────────
  describe("4. IDLE KILL", () => {
    test("on-demand server is killed after exceeding idle timeout", async () => {
      const lm = new LifecycleManager();
      const lock = new SpawnLock();
      const config = makeServerConfig({
        name: "idle-srv", idleTimeout: 1, mode: "on-demand",
      });

      await lm.spawn("idle-srv", config, lock);
      expect(lm.listRunning()).toContain("idle-srv");

      const entry = lm.get("idle-srv")!;
      (entry as Record<string, unknown>).lastActivity = Date.now() - 5000;

      lm.killIfIdle("idle-srv", config);
      await delay(100);

      expect(lm.get("idle-srv")).toBeUndefined();
      expect(lm.listRunning()).not.toContain("idle-srv");
    });

    test("persistent servers are NOT killed by idle check", async () => {
      const lm = new LifecycleManager();
      const lock = new SpawnLock();
      const config = makeServerConfig({
        name: "persistent-srv", idleTimeout: 1, mode: "persistent",
      });

      await lm.spawn("persistent-srv", config, lock);
      expect(lm.listRunning()).toContain("persistent-srv");

      const entry = lm.get("persistent-srv")!;
      (entry as Record<string, unknown>).lastActivity = Date.now() - 5000;

      lm.killIfIdle("persistent-srv", config);
      await delay(50);

      expect(lm.get("persistent-srv")).toBeDefined();
    });

    test("activity tracking resets idle timer", async () => {
      const lm = new LifecycleManager();
      const lock = new SpawnLock();
      const config = makeServerConfig({ name: "active-srv", idleTimeout: 60 });

      await lm.spawn("active-srv", config, lock);
      const entry = lm.get("active-srv")!;
      const beforeTrack = entry.lastActivity;

      await delay(10);
      lm.trackActivity("active-srv");

      const after = lm.get("active-srv")!;
      expect(after.lastActivity).toBeGreaterThan(beforeTrack);
    });
  });

  // ── Test 5: Concurrent calls share one spawn ────────────────
  describe("5. CONCURRENT CALLS SHARE ONE SPAWN", () => {
    test("two concurrent calls result in exactly one spawn", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      let spawnCount = 0;
      const mockClient = makeMockClient();

      spyOn(lifecycle, "spawn").mockImplementation(async (name, _cfg, lock) => {
        return lock!.acquire(name, async () => {
          spawnCount++;
          await delay(30);
          return { client: mockClient } as any;
        });
      });
      spyOn(lifecycle, "trackActivity").mockImplementation(() => {});

      const config = makeGatewayConfig([makeServerConfig({ name: "shared-srv" })]);

      const [r1, r2] = await Promise.all([
        handleToolsCall(
          { name: "shared-srv__greet" },
          config, lifecycle, healthTracker, spawnLock,
        ),
        handleToolsCall(
          { name: "shared-srv__count" },
          config, lifecycle, healthTracker, spawnLock,
        ),
      ]);

      expect(spawnCount).toBe(1);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
    });

    test("SpawnLock returns same result for simultaneous acquires", async () => {
      const lock = new SpawnLock();
      const results: number[] = [];

      const promises = [1, 2, 3].map((id) =>
        lock.acquire("lock-test", async () => {
          await delay(10);
          results.push(id);
          return id;
        }),
      );

      const resolved = await Promise.all(promises);
      expect(new Set(resolved).size).toBe(1);
      expect(results).toHaveLength(1);
    });
  });

  // ── Test 6: Transparent proxy ───────────────────────────────
  describe("6. TRANSPARENT PROXY", () => {
    test("agent can call a tool without prior tool discovery", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      const mockClient = makeMockClient();
      spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);
      spyOn(lifecycle, "trackActivity").mockImplementation(() => {});
      spyOn(healthTracker, "recordSuccess");

      const config = makeGatewayConfig([makeServerConfig({ name: "mystery-srv" })]);

      const result = await handleToolsCall(
        { name: "mystery-srv__do_something", arguments: { data: "test" } },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBeFalsy();
      expect(mockClient.callTool).toHaveBeenCalledWith(
        { name: "do_something", arguments: { data: "test" } },
        { timeout: 10000 },
      );
      expect(healthTracker.recordSuccess).toHaveBeenCalledWith("mystery-srv");
    });

    test("transparent proxy respects disabled servers", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      const config = makeGatewayConfig([
        makeServerConfig({ name: "disabled-srv", disabled: true }),
      ]);

      const result = await handleToolsCall(
        { name: "disabled-srv__some_tool" },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("disabled");
    });

    test("transparent proxy returns error for unknown server", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      const config = makeGatewayConfig([makeServerConfig({ name: "known-srv" })]);

      const result = await handleToolsCall(
        { name: "unknown-srv__some_tool" },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("unknown server");
    });
  });

  // ── Test 7: Management API ──────────────────────────────────
  describe("7. MANAGEMENT API", () => {
    test("start → verify running → stop → verify stopped lifecycle", async () => {
      const servers = [makeServerConfig({ name: "api-test-srv" })];
      const config = makeGatewayConfig(servers);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      // Initially stopped
      let res = await fetch(`${baseUrl}/api/servers/api-test-srv`);
      let body = await res.json();
      expect(body.status).toBe("stopped");

      // Start
      res = await fetch(`${baseUrl}/api/servers/api-test-srv/start`, { method: "POST" });
      expect(res.status).toBe(200);
      body = await res.json();
      expect(body.status).toBe("started");
      expect(typeof body.pid).toBe("number");

      // Verify running
      res = await fetch(`${baseUrl}/api/servers/api-test-srv`);
      body = await res.json();
      expect(body.status).toBe("running");
      expect(lifecycle.listRunning()).toContain("api-test-srv");

      // Stop
      res = await fetch(`${baseUrl}/api/servers/api-test-srv/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      body = await res.json();
      expect(body.status).toBe("stopped");

      // Verify stopped
      res = await fetch(`${baseUrl}/api/servers/api-test-srv`);
      body = await res.json();
      expect(body.status).toBe("stopped");
      expect(lifecycle.listRunning()).not.toContain("api-test-srv");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("POST restart cycles the server", async () => {
      const servers = [makeServerConfig({ name: "restart-srv" })];
      const config = makeGatewayConfig(servers);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      await fetch(`${baseUrl}/api/servers/restart-srv/start`, { method: "POST" });
      expect(lifecycle.listRunning()).toContain("restart-srv");

      const res = await fetch(`${baseUrl}/api/servers/restart-srv/restart`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restarted");
      expect(lifecycle.listRunning()).toContain("restart-srv");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("POST start returns 400 if already running, 404 if unknown", async () => {
      const servers = [makeServerConfig({ name: "dup-srv" })];
      const config = makeGatewayConfig(servers);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      await fetch(`${baseUrl}/api/servers/dup-srv/start`, { method: "POST" });

      const res400 = await fetch(`${baseUrl}/api/servers/dup-srv/start`, { method: "POST" });
      expect(res400.status).toBe(400);

      const res404 = await fetch(`${baseUrl}/api/servers/nonexistent/start`, { method: "POST" });
      expect(res404.status).toBe(404);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  // ── Test 8: Crash recovery ──────────────────────────────────
  describe("8. CRASH RECOVERY", () => {
    test("tool call failure marks server as unhealthy via HealthTracker", async () => {
      const lifecycle = new LifecycleManager();
      const healthTracker = new HealthTracker();
      const spawnLock = new SpawnLock();

      const mockClient = makeMockClient(() =>
        Promise.reject(new Error("mid-call crash: process exited")),
      );

      spyOn(lifecycle, "spawn").mockResolvedValue({ client: mockClient } as any);
      spyOn(lifecycle, "trackActivity").mockImplementation(() => {});
      spyOn(healthTracker, "recordFailure");

      const config = makeGatewayConfig([makeServerConfig({ name: "crashy-srv" })]);

      const result = await handleToolsCall(
        { name: "crashy-srv__explode" },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("mid-call crash");
      expect(healthTracker.recordFailure).toHaveBeenCalledWith(
        "crashy-srv", expect.any(Error),
      );
    });

    test("three consecutive failures mark server completely unhealthy", async () => {
      const healthTracker = new HealthTracker();

      healthTracker.recordFailure("unstable-srv", new Error("crash 1"));
      healthTracker.recordFailure("unstable-srv", new Error("crash 2"));
      healthTracker.recordFailure("unstable-srv", new Error("crash 3"));

      expect(healthTracker.isUnhealthy("unstable-srv")).toBe(true);
      expect(healthTracker.isHealthy("unstable-srv")).toBe(false);
      expect(healthTracker.getFailureCount("unstable-srv")).toBe(3);

      // Unhealthy server blocks tool calls
      const lifecycle = new LifecycleManager();
      const spawnLock = new SpawnLock();
      const config = makeGatewayConfig([makeServerConfig({ name: "unstable-srv" })]);

      const result = await handleToolsCall(
        { name: "unstable-srv__some_tool" },
        config, lifecycle, healthTracker, spawnLock,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("unhealthy");
    });

    test("successful call after failures resets health", async () => {
      const healthTracker = new HealthTracker();

      healthTracker.recordFailure("recovery-srv", new Error("crash 1"));
      healthTracker.recordFailure("recovery-srv", new Error("crash 2"));
      expect(healthTracker.getFailureCount("recovery-srv")).toBe(2);

      healthTracker.recordSuccess("recovery-srv");
      expect(healthTracker.isHealthy("recovery-srv")).toBe(true);
      expect(healthTracker.getFailureCount("recovery-srv")).toBe(0);
      expect(healthTracker.isUnhealthy("recovery-srv")).toBe(false);
    });
  });

  // ── Test 9: Config hot-reload ───────────────────────────────
  describe("9. CONFIG HOT-RELOAD", () => {
    const TEST_DIR = join(import.meta.dirname ?? ".", ".test-e2e-hot-reload");

    type ChangeHandler = (path: string) => void;
    class MockFSWatcher {
      private handlers: Record<string, ChangeHandler[]> = {};
      on(event: string, handler: ChangeHandler): this {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(handler);
        return this;
      }
      emit(event: string, path: string): void {
        for (const h of this.handlers[event] ?? []) h(path);
      }
      async close(): Promise<void> {
        this.handlers = {};
      }
    }

    let mockWatcher = new MockFSWatcher();

    beforeEach(() => {
      mockWatcher = new MockFSWatcher();
      mock.module("chokidar", () => ({
        default: { watch: () => mockWatcher },
      }));
      if (!existsSync(TEST_DIR)) {
        mkdirSync(TEST_DIR, { recursive: true });
      }
    });

    afterEach(() => {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch { /* cleanup best-effort */ }
    });

    test("added server appears in config after file change without restart", async () => {
      const configPath = join(TEST_DIR, "hot-reload-test.json");

      writeFileSync(configPath, JSON.stringify({
        port: 8000, host: "127.0.0.1",
        registryPath: "/tmp/registry.json", logPath: "/tmp/gateway.log",
        servers: [makeServerConfig({ name: "existing-srv" })],
      }, null, 2));

      const currentConfig = makeGatewayConfig([
        makeServerConfig({ name: "existing-srv" }),
      ]);

      const killed: string[] = [];
      const mockLifecycle = {
        kill: mock(async (name: string) => { killed.push(name); }),
      };
      const onChanged = mock(() => {});

      const { startWatching } = await import("../src/hot-reload.js");
      const { stop } = startWatching(
        configPath, currentConfig,
        mockLifecycle as unknown as LifecycleManager, onChanged,
      );

      // Write updated config with new server
      writeFileSync(configPath, JSON.stringify({
        port: 8000, host: "127.0.0.1",
        registryPath: "/tmp/registry.json", logPath: "/tmp/gateway.log",
        servers: [
          makeServerConfig({ name: "existing-srv" }),
          makeServerConfig({ name: "new-srv", command: "deno", args: ["new.ts"] }),
        ],
      }, null, 2));

      mockWatcher.emit("change", configPath);
      await delay(600);

      expect(onChanged).toHaveBeenCalled();
      expect(currentConfig.servers).toHaveLength(2);
      expect(currentConfig.servers[1]!.name).toBe("new-srv");

      await stop();
    });

    test("removed server is killed on config change", async () => {
      const configPath = join(TEST_DIR, "hot-reload-remove.json");

      writeFileSync(configPath, JSON.stringify({
        port: 8000, host: "127.0.0.1",
        registryPath: "/tmp/registry.json", logPath: "/tmp/gateway.log",
        servers: [makeServerConfig({ name: "kept-srv" })],
      }, null, 2));

      const currentConfig = makeGatewayConfig([
        makeServerConfig({ name: "kept-srv" }),
        makeServerConfig({ name: "removed-srv" }),
      ]);

      const killed: string[] = [];
      const mockLifecycle = {
        kill: mock(async (name: string) => { killed.push(name); }),
      };
      const onChanged = mock(() => {});

      const { startWatching } = await import("../src/hot-reload.js");
      const { stop } = startWatching(
        configPath, currentConfig,
        mockLifecycle as unknown as LifecycleManager, onChanged,
      );

      mockWatcher.emit("change", configPath);
      await delay(600);

      expect(onChanged).toHaveBeenCalled();
      expect(killed).toContain("removed-srv");
      expect(killed).not.toContain("kept-srv");

      await stop();
    });
  });

  // ── Test 10: Gateway graceful shutdown ──────────────────────
  describe("10. GRACEFUL SHUTDOWN", () => {
    test("lifecycle.killAll stops all running servers", async () => {
      const lm = new LifecycleManager();
      const lock = new SpawnLock();

      const configs = [
        makeServerConfig({ name: "srv-a" }),
        makeServerConfig({ name: "srv-b" }),
        makeServerConfig({ name: "srv-c" }),
      ];

      for (const c of configs) {
        await lm.spawn(c.name, c, lock);
      }

      expect(lm.listRunning()).toHaveLength(3);

      await lm.killAll();

      expect(lm.listRunning()).toHaveLength(0);
    });

    test("HTTP server close releases the port", async () => {
      const config = makeGatewayConfig([]);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      // Server is running
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      // Close the server
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // Verify port released
      let connectionRefused = false;
      try {
        await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
      } catch {
        connectionRefused = true;
      }
      expect(connectionRefused).toBe(true);
    });

    test("full shutdown flow: spawn servers → killAll → port released", async () => {
      const servers = [
        makeServerConfig({ name: "alice" }),
        makeServerConfig({ name: "bob" }),
      ];
      const config = makeGatewayConfig(servers);
      const lifecycle = new LifecycleManager();
      const registry = new ToolRegistry();
      const healthTracker = new HealthTracker();
      const lock = new SpawnLock();

      const { server, baseUrl } = await startTestApiServer(
        config, lifecycle, registry, healthTracker,
      );

      for (const srv of servers) {
        await lifecycle.spawn(srv.name, srv, lock);
      }
      expect(lifecycle.listRunning()).toHaveLength(2);

      const healthRes = await fetch(`${baseUrl}/api/health`);
      const healthBody = await healthRes.json();
      expect(healthBody.serversRunning).toBe(2);

      await lifecycle.killAll();
      expect(lifecycle.listRunning()).toHaveLength(0);

      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      let connectionRefused = false;
      try {
        await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
      } catch {
        connectionRefused = true;
      }
      expect(connectionRefused).toBe(true);
    });
  });
});
