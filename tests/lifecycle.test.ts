import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { LifecycleManager } from "../src/lifecycle.js";
import { SpawnLock } from "../src/spawn-lock.js";
import type { ServerConfig } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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

let nextPid = 1000;
function allocPid(): number {
  return nextPid++;
}

// ── Mocks ────────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────

describe("LifecycleManager", () => {
  let lm: LifecycleManager;
  let lock: SpawnLock;

  beforeEach(() => {
    lm = new LifecycleManager();
    lock = new SpawnLock();
    nextPid = 1000;
  });

  afterEach(async () => {
    try {
      await lm.killAll();
    } catch {
      // Cleanup may fail if mocks are stale
    }
  });

  test("1. spawn server from config, verify process runs", async () => {
    const config = makeConfig({ name: "echo-srv" });
    const handle = await lm.spawn("echo-srv", config, lock);

    expect(handle.pid).not.toBeNull();
    expect(typeof handle.pid).toBe("number");
    expect(handle.client).toBeDefined();
    expect(handle.transport).toBeDefined();

    const entry = lm.get("echo-srv");
    expect(entry).toBeDefined();
    expect(entry!.client).toBe(handle.client);
    expect(entry!.transport).toBe(handle.transport);
    expect(entry!.mode).toBe("on-demand");
    expect(lm.listRunning()).toContain("echo-srv");
  });

  test("2. process communicates via stdio (mock MCP handshake)", async () => {
    let connected = false;

    mock.module("@modelcontextprotocol/client", () => ({
      Client: class {
        async connect() {
          connected = true;
        }
        getServerVersion() { return undefined; }
        getInstructions() { return undefined; }
      },
      StdioClientTransport: class {
        pid: number | null = allocPid();
        async start() {}
        async close() {}
        async send() {}
      },
    }));

    const lifecycleMod = await import("../src/lifecycle.js");
    const freshLm = new lifecycleMod.LifecycleManager();
    const config = makeConfig({ name: "handshake-srv" });
    const freshLock = new SpawnLock();

    await freshLm.spawn("handshake-srv", config, freshLock);
    expect(connected).toBe(true);
  });

  test("3. idle kill after timeout", async () => {
    const config = makeConfig({ name: "idle-srv", idleTimeout: 1 });
    await lm.spawn("idle-srv", config, lock);

    const entry = lm.get("idle-srv")!;
    (entry as Record<string, unknown>).lastActivity = Date.now() - 5000;

    lm.killIfIdle("idle-srv", config);

    await new Promise((r) => setTimeout(r, 100));

    expect(lm.get("idle-srv")).toBeUndefined();
  });

  test("4. activity resets idle timer", async () => {
    const config = makeConfig({ name: "active-srv", idleTimeout: 1 });
    await lm.spawn("active-srv", config, lock);

    const entry = lm.get("active-srv")!;
    const activityAfterSpawn = entry.lastActivity;

    await new Promise((r) => setTimeout(r, 50));
    lm.trackActivity("active-srv");

    const entry2 = lm.get("active-srv")!;
    expect(entry2.lastActivity).toBeGreaterThan(activityAfterSpawn);
  });

  test("5. kill() terminates process", async () => {
    const config = makeConfig({ name: "kill-srv" });
    await lm.spawn("kill-srv", config, lock);

    const origKill = process.kill;
    const killSpy = mock((_pid: number, signal?: string) => {
      if (signal && signal !== "SIGTERM" && signal !== "SIGKILL") {
        throw new Error("ESRCH");
      }
    });
    (process as unknown as Record<string, unknown>).kill = killSpy;

    try {
      expect(lm.listRunning()).toContain("kill-srv");
      await lm.kill("kill-srv");

      expect(lm.get("kill-srv")).toBeUndefined();
      expect(lm.listRunning()).not.toContain("kill-srv");
    } finally {
      (process as unknown as Record<string, unknown>).kill = origKill;
    }
  });

  test("6. double-spawn prevented (SpawnLock integration)", async () => {
    const config = makeConfig({ name: "unique-srv" });

    const [h1, h2] = await Promise.all([
      lm.spawn("unique-srv", config, lock),
      lm.spawn("unique-srv", config, lock),
    ]);

    expect(h1.pid).toBe(h2.pid);
    expect(h1.client).toBe(h2.client);
    expect(h1.transport).toBe(h2.transport);
    expect(lm.listRunning()).toHaveLength(1);
  });

  test("7. killIfIdle does nothing for non-idle", async () => {
    const config = makeConfig({ name: "non-idle-srv", idleTimeout: 3600 });
    await lm.spawn("non-idle-srv", config, lock);

    lm.killIfIdle("non-idle-srv", config);
    await new Promise((r) => setTimeout(r, 50));

    expect(lm.get("non-idle-srv")).toBeDefined();
    expect(lm.listRunning()).toContain("non-idle-srv");
  });

  test("8. killAll on shutdown", async () => {
    const configs = [
      makeConfig({ name: "srv-a" }),
      makeConfig({ name: "srv-b" }),
      makeConfig({ name: "srv-c" }),
    ];

    for (const c of configs) {
      await lm.spawn(c.name, c, lock);
    }

    expect(lm.listRunning()).toHaveLength(3);

    await lm.killAll();

    expect(lm.listRunning()).toHaveLength(0);
  });

  test("9. persistent mode NOT killed by idle check", async () => {
    const config = makeConfig({
      name: "persistent-srv",
      mode: "persistent",
      idleTimeout: 1,
    });
    await lm.spawn("persistent-srv", config, lock);

    const entry = lm.get("persistent-srv")!;
    (entry as Record<string, unknown>).lastActivity = Date.now() - 5000;

    lm.killIfIdle("persistent-srv", config);
    await new Promise((r) => setTimeout(r, 50));

    expect(lm.get("persistent-srv")).toBeDefined();
  });
});
