import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { ServerConfig, GatewayConfig } from "../src/types.js";
import {
  ToolRegistry,
  type ILifecycleManager,
} from "../src/registry.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-registry");
const REGISTRY_PATH = join(TEST_DIR, "tool-registry.json");

function makeServerConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
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

function makeGatewayConfig(
  servers: ServerConfig[],
): GatewayConfig {
  return {
    port: 8000,
    host: "127.0.0.1",
    servers,
    registryPath: REGISTRY_PATH,
    logPath: "/tmp/mcp-gateway.log",
  };
}

/**
 * Creates a mock LifecycleManager that returns the given tools per server.
 */
function mockLifecycleManager(
  serverTools: Record<string, Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>>,
): ILifecycleManager {
  return {
    spawnServer: async (config: ServerConfig) => {
      const tools = serverTools[config.name] ?? [];
      return {
        client: {
          listTools: async () => ({ tools }),
        },
      };
    },
    killServer: async (_name: string) => {
      // no-op
    },
  };
}

beforeAll(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// 1. Empty registry on first load
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.load", () => {
  test("returns empty registry when file does not exist", async () => {
    const registry = await ToolRegistry.load(
      join(TEST_DIR, "nonexistent.json"),
    );
    expect(registry.tools).toEqual([]);
    expect(registry.serverVersions).toEqual({});
    expect(registry.generatedAt).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Refresh populates tools from mock servers
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.refresh", () => {
  test("populates tools from mock servers", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "math-server": [
        { name: "add", description: "Add two numbers" },
        { name: "subtract", description: "Subtract two numbers" },
      ],
      "text-server": [
        { name: "uppercase", description: "Convert text to uppercase" },
      ],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "math-server", command: "math-srv", args: ["--port", "3001"] }),
      makeServerConfig({ name: "text-server", command: "text-srv", args: ["--port", "3002"] }),
    ]);

    await registry.refresh(config, lm);

    expect(registry.tools.length).toBe(3);
    expect(registry.serverVersions).toHaveProperty("math-server");
    expect(registry.serverVersions).toHaveProperty("text-server");
    expect(registry.generatedAt).not.toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Tools are namespaced: serverName__toolName
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry namespace", () => {
  test("tools are namespaced with double underscore", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "my-server": [
        { name: "doThing", description: "Does a thing" },
      ],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "my-server", command: "my-srv", args: [] }),
    ]);

    await registry.refresh(config, lm);

    expect(registry.tools).toHaveLength(1);
    const tool = registry.tools[0]!;
    expect(tool.name).toBe("my-server__doThing");
    expect(tool.serverName).toBe("my-server");
    expect(tool.originalName).toBe("doThing");
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Search by tool name
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.search", () => {
  test("finds tools by name", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "a": [{ name: "fetchData", description: "Retrieve remote data" }],
      "b": [{ name: "sendData", description: "Submit data to API" }],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "a", command: "a", args: [] }),
      makeServerConfig({ name: "b", command: "b", args: [] }),
    ]);

    await registry.refresh(config, lm);

    const results = registry.search("fetchData");
    expect(results).toHaveLength(1);
    expect(results[0]!.originalName).toBe("fetchData");
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Search by description keyword
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.search by description", () => {
  test("finds tools by description keyword", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "srv": [
        { name: "ping", description: "Health check endpoint" },
        { name: "metrics", description: "Export Prometheus metrics" },
      ],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "srv", command: "srv", args: [] }),
    ]);

    await registry.refresh(config, lm);

    const results = registry.search("Prometheus");
    expect(results).toHaveLength(1);
    expect(results[0]!.originalName).toBe("metrics");
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Search returns empty for no-match
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.search no-match", () => {
  test("returns empty array when no tool matches", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "srv": [
        { name: "alpha", description: "First letter" },
      ],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "srv", command: "srv", args: [] }),
    ]);

    await registry.refresh(config, lm);

    const results = registry.search("nonexistentxyz");
    expect(results).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. Invalidate clears one server
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.invalidate", () => {
  test("removes all tools from the given server", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "server-a": [{ name: "toolA", description: "Tool A" }],
      "server-b": [{ name: "toolB", description: "Tool B" }],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "server-a", command: "srv-a", args: [] }),
      makeServerConfig({ name: "server-b", command: "srv-b", args: [] }),
    ]);

    await registry.refresh(config, lm);
    expect(registry.tools).toHaveLength(2);

    registry.invalidate("server-a");

    // Only server-b's tool should remain
    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]!.serverName).toBe("server-b");
    // Version hash should be gone
    expect(registry.serverVersions["server-a"]).toBeUndefined();
    expect(registry.serverVersions["server-b"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. isStale detects config change
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry.isStale", () => {
  test("returns true when config differs from stored hash", () => {
    const registry = new ToolRegistry();
    const server = makeServerConfig({
      name: "srv",
      command: "original-cmd",
      args: ["--flag"],
    });

    // Manually set a known version hash
    registry.serverVersions["srv"] = ToolRegistry.versionHash(server);

    // Same config — not stale
    expect(registry.isStale(server)).toBe(false);

    // Changed config — stale
    const changed = makeServerConfig({
      name: "srv",
      command: "original-cmd",
      args: ["--different-flag"],
    });
    expect(registry.isStale(changed)).toBe(true);
  });

  test("returns true when no stored hash exists", () => {
    const registry = new ToolRegistry();
    const server = makeServerConfig({ name: "unknown-srv", command: "x", args: [] });
    expect(registry.isStale(server)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 9. TTL expiry
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry TTL expiry", () => {
  test("returns empty registry when TTL has elapsed", async () => {
    // Write a registry file with generatedAt = 2 hours ago, ttl = 1 hour
    const oldData = {
      tools: [
        {
          name: "old-server__oldTool",
          description: "An expired tool",
          inputSchema: {},
          serverName: "old-server",
          originalName: "oldTool",
          versionHash: "abc123",
        },
      ],
      generatedAt: new Date(Date.now() - 7200 * 1000).toISOString(),
      ttl: 3600,
      serverVersions: { "old-server": "abc123" },
    };

    const expiryPath = join(TEST_DIR, "expired-registry.json");
    writeFileSync(expiryPath, JSON.stringify(oldData, null, 2));

    const registry = await ToolRegistry.load(expiryPath);
    expect(registry.tools).toEqual([]);
    expect(registry.serverVersions).toEqual({});
    expect(registry.generatedAt).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────
// Bonus: save + load round-trip
// ─────────────────────────────────────────────────────────────────
describe("ToolRegistry save/load round-trip", () => {
  test("persists and restores registry state", async () => {
    const registry = new ToolRegistry();
    const lm = mockLifecycleManager({
      "srv": [{ name: "hello", description: "Say hello" }],
    });

    const config = makeGatewayConfig([
      makeServerConfig({ name: "srv", command: "srv", args: [] }),
    ]);

    await registry.refresh(config, lm);
    await registry.save(REGISTRY_PATH);

    // Load back from disk
    const loaded = await ToolRegistry.load(REGISTRY_PATH);
    expect(loaded.tools).toHaveLength(1);
    expect(loaded.tools[0]!.originalName).toBe("hello");
    expect(loaded.serverVersions["srv"]).toBe(registry.serverVersions["srv"]);
  });
});
