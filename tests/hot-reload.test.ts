import { describe, expect, test, mock, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import type { GatewayConfig, ServerConfig } from "../src/types.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-hot-reload");

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

let mockWatcher: MockFSWatcher;

mock.module("chokidar", () => ({
  default: {
    watch: () => {
      mockWatcher = new MockFSWatcher();
      return mockWatcher;
    },
  },
}));

function makeServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: "test-srv",
    command: "echo",
    args: ["hello"],
    env: {},
    mode: "on-demand" as const,
    idleTimeout: 300,
    disabled: false,
    ...overrides,
  };
}

function makeGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 8000,
    host: "127.0.0.1",
    servers: [makeServerConfig()],
    registryPath: "/tmp/registry.json",
    logPath: "/tmp/gateway.log",
    ...overrides,
  };
}

function writeConfigFile(name: string, config: Record<string, unknown>): string {
  const filePath = join(TEST_DIR, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

function makeKillTracker(): {
  calls: string[];
  lifecycle: { kill: (name: string) => Promise<void> };
} {
  const calls: string[] = [];
  return {
    calls,
    lifecycle: {
      kill: mock(async (name: string) => {
        calls.push(name);
      }),
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  mockWatcher = new MockFSWatcher();
});

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

describe("hot-reload", () => {
  test("1. file change triggers config reload and calls onConfigChanged", async () => {
    const configPath = writeConfigFile("test1", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [makeServerConfig({ name: "srv-a" })],
    });

    const currentConfig = makeGatewayConfig({ servers: [] });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).toHaveLength(0);

    await stop();
  });

  test("2. added server appears in config without spawning", async () => {
    const configPath = writeConfigFile("test2", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        makeServerConfig({ name: "existing-srv" }),
        makeServerConfig({ name: "new-srv", command: "node", args: ["new.js"] }),
      ],
    });

    const currentConfig = makeGatewayConfig({
      servers: [makeServerConfig({ name: "existing-srv" })],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).not.toContain("new-srv");
    expect(killed).not.toContain("existing-srv");
    expect(currentConfig.servers).toHaveLength(2);

    await stop();
  });

  test("3. removed server is killed if running", async () => {
    const configPath = writeConfigFile("test3", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [makeServerConfig({ name: "kept-srv" })],
    });

    const currentConfig = makeGatewayConfig({
      servers: [
        makeServerConfig({ name: "kept-srv" }),
        makeServerConfig({ name: "removed-srv" }),
      ],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).toContain("removed-srv");
    expect(killed).not.toContain("kept-srv");
    expect(currentConfig.servers).toHaveLength(1);

    await stop();
  });

  test("4. modified server is killed", async () => {
    const configPath = writeConfigFile("test4", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        makeServerConfig({
          name: "modified-srv",
          command: "node",
          args: ["updated.js"],
          env: { MODE: "prod" },
        }),
        makeServerConfig({ name: "unchanged-srv" }),
      ],
    });

    const currentConfig = makeGatewayConfig({
      servers: [
        makeServerConfig({
          name: "modified-srv",
          command: "node",
          args: ["old.js"],
          env: {},
        }),
        makeServerConfig({ name: "unchanged-srv" }),
      ],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).toContain("modified-srv");
    expect(killed).not.toContain("unchanged-srv");

    await stop();
  });

  test("5. unchanged server left untouched", async () => {
    const configPath = writeConfigFile("test5", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        makeServerConfig({ name: "srv-a", command: "node", args: ["a.js"] }),
        makeServerConfig({ name: "srv-b", command: "deno", args: ["b.ts"] }),
      ],
    });

    const currentConfig = makeGatewayConfig({
      servers: [
        makeServerConfig({ name: "srv-a", command: "node", args: ["a.js"] }),
        makeServerConfig({ name: "srv-b", command: "deno", args: ["b.ts"] }),
      ],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).toHaveLength(0);

    await stop();
  });

  test("6. disabled server is killed", async () => {
    const configPath = writeConfigFile("test6", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        makeServerConfig({ name: "disabled-srv", disabled: true }),
        makeServerConfig({ name: "active-srv" }),
      ],
    });

    const currentConfig = makeGatewayConfig({
      servers: [
        makeServerConfig({ name: "disabled-srv", disabled: false }),
        makeServerConfig({ name: "active-srv" }),
      ],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).toHaveBeenCalled();
    expect(killed).toContain("disabled-srv");
    expect(killed).not.toContain("active-srv");

    await stop();
  });

  test("7. rapid changes are debounced", async () => {
    const configPath = writeConfigFile("test7", {
      port: 9000,
      host: "0.0.0.0",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [makeServerConfig({ name: "final-srv" })],
    });

    const currentConfig = makeGatewayConfig({ servers: [] });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    mockWatcher.emit("change", configPath);
    mockWatcher.emit("change", configPath);
    mockWatcher.emit("change", configPath);

    await delay(700);

    expect(onChanged).toHaveBeenCalledTimes(1);

    await stop();
  });

  test("8. invalid config does not crash gateway", async () => {
    const configPath = writeConfigFile("test8-initial", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [makeServerConfig({ name: "good-srv" })],
    });

    const currentConfig = makeGatewayConfig({
      servers: [makeServerConfig({ name: "good-srv" })],
    });
    const { calls: killed, lifecycle } = makeKillTracker();
    const onChanged = mock(() => {});

    const { startWatching } = await import("../src/hot-reload.js");
    const { stop } = startWatching(
      configPath,
      currentConfig,
      lifecycle as unknown as import("../src/lifecycle.js").LifecycleManager,
      onChanged,
    );

    writeFileSync(configPath, "not valid json {{{");

    mockWatcher.emit("change", configPath);

    await delay(600);

    expect(onChanged).not.toHaveBeenCalled();
    expect(currentConfig.servers).toHaveLength(1);
    expect(currentConfig.servers[0]?.name).toBe("good-srv");

    await stop();
  });
});
