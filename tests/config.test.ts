import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-configs");

function writeConfig(name: string, data: Record<string, unknown>): string {
  const filePath = join(TEST_DIR, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
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

describe("loadConfig", () => {
  test("loads valid config with env resolution", () => {
    const path = writeConfig("valid", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "test-server",
          command: "node",
          args: ["server.js"],
          env: { PATH: "/usr/bin" },
          mode: "on-demand",
          idleTimeout: 300,
          disabled: false,
        },
      ],
    });

    const config = loadConfig(path, {});
    expect(config.port).toBe(8000);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]?.name).toBe("test-server");
    expect(config.servers[0]?.env.PATH).toBe("/usr/bin");
  });

  test("rejects config with missing required fields (missing port)", () => {
    const path = writeConfig("missing-port", {
      host: "127.0.0.1",
      servers: [],
    });

    expect(() => loadConfig(path, {})).toThrow();
  });

  test("resolves ${HOME} env vars in server env fields", () => {
    const path = writeConfig("home-env", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "test-server",
          command: "node",
          args: ["server.js"],
          env: {
            CONFIG_DIR: "${HOME}/.config/myapp",
          },
          mode: "on-demand",
          idleTimeout: 300,
          disabled: false,
        },
      ],
    });

    const config = loadConfig(path, { HOME: "/Users/testuser" });
    expect(config.servers[0]?.env.CONFIG_DIR).toBe("/Users/testuser/.config/myapp");
  });

  test("resolves ${cmd: echo hello} command execution in server env", () => {
    const path = writeConfig("cmd-env", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "test-server",
          command: "node",
          args: ["server.js"],
          env: {
            GREETING: "${cmd:echo hello}",
          },
          mode: "on-demand",
          idleTimeout: 300,
          disabled: false,
        },
      ],
    });

    const config = loadConfig(path, {});
    expect(config.servers[0]?.env.GREETING).toBe("hello");
  });

  test("applies defaults for optional fields (port, host)", () => {
    const path = writeConfig("defaults", {
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [],
    });

    const config = loadConfig(path, {});
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
  });

  test("loads servers with disabled: true", () => {
    const path = writeConfig("disabled", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "disabled-server",
          command: "node",
          args: ["server.js"],
          env: {},
          mode: "on-demand",
          idleTimeout: 300,
          disabled: true,
        },
      ],
    });

    const config = loadConfig(path, {});
    expect(config.servers[0]?.disabled).toBe(true);
    expect(config.servers[0]?.name).toBe("disabled-server");
  });

  test("empty servers array does not throw", () => {
    const path = writeConfig("empty-servers", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [],
    });

    const config = loadConfig(path, {});
    expect(config.servers).toHaveLength(0);
  });

  test("duplicate server names are rejected", () => {
    const path = writeConfig("duplicates", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "dupe",
          command: "node",
          args: ["a.js"],
          env: {},
          mode: "on-demand",
          idleTimeout: 300,
          disabled: false,
        },
        {
          name: "dupe",
          command: "node",
          args: ["b.js"],
          env: {},
          mode: "persistent",
          idleTimeout: 600,
          disabled: false,
        },
      ],
    });

    expect(() => loadConfig(path, {})).toThrow(
      "Duplicate server names are not allowed"
    );
  });

  test("port 0 is rejected", () => {
    const path = writeConfig("port-zero", {
      port: 0,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [],
    });

    expect(() => loadConfig(path, {})).toThrow();
  });

  test("loadConfig > PORT and HOST env vars override config file", () => {
    const path = writeConfig("override", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [],
    });

    const config = loadConfig(path, { PORT: "9999", HOST: "0.0.0.0" });
    expect(config.port).toBe(9999);
    expect(config.host).toBe("0.0.0.0");
  });

  test("negative idleTimeout is rejected", () => {
    const path = writeConfig("negative-timeout", {
      port: 8000,
      host: "127.0.0.1",
      registryPath: "/tmp/registry.json",
      logPath: "/tmp/gateway.log",
      servers: [
        {
          name: "bad-server",
          command: "node",
          args: ["server.js"],
          env: {},
          mode: "on-demand",
          idleTimeout: -1,
          disabled: false,
        },
      ],
    });

    expect(() => loadConfig(path, {})).toThrow();
  });
});
