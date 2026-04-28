import { describe, expect, test } from "bun:test";
import { migrateConfig } from "../scripts/migrate-config.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const PERSISTENT_SERVER_NAMES = ["playwright", "chrome-devtools", "framer"];
const REQUIRED_SERVER_FIELDS = ["name", "command", "args", "env", "mode", "idleTimeout", "disabled"];
const REQUIRED_TOP_FIELDS = ["port", "host", "registryPath", "logPath", "servers"];

const config = await migrateConfig({
  secretsPath: join(homedir(), ".sisyphus", "mcp-secrets.json"),
  plistDir: join(homedir(), "Library", "LaunchAgents"),
  output: join(homedir(), ".sisyphus", "mcp-gateway-config.json"),
});

describe("migrate-config", () => {
  test("generates config with 10 servers", () => {
    expect(config.servers).toHaveLength(10);
  });

  test("has all required top-level fields", () => {
    for (const field of REQUIRED_TOP_FIELDS) {
      expect(config).toHaveProperty(field);
    }
  });

  test("top-level fields have correct values", () => {
    expect(config.port).toBe(8000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.registryPath).toBe("~/.sisyphus/tool-registry.json");
    expect(config.logPath).toBe("~/.sisyphus/mcp-gateway/logs/gateway.log");
  });

  test("persistent servers have mode persistent and idleTimeout 600", () => {
    for (const server of config.servers) {
      if (PERSISTENT_SERVER_NAMES.includes(server.name)) {
        expect(server.mode).toBe("persistent");
        expect(server.idleTimeout).toBe(600);
      }
    }
  });

  test("on-demand servers have mode on-demand and idleTimeout 300", () => {
    for (const server of config.servers) {
      if (!PERSISTENT_SERVER_NAMES.includes(server.name)) {
        expect(server.mode).toBe("on-demand");
        expect(server.idleTimeout).toBe(300);
      }
    }
  });

  test("each server has all required fields", () => {
    for (const server of config.servers) {
      for (const field of REQUIRED_SERVER_FIELDS) {
        expect(server).toHaveProperty(field);
      }
    }
  });

  test("each server has disabled set to false", () => {
    for (const server of config.servers) {
      expect(server.disabled).toBe(false);
    }
  });

  test("each server has non-empty env object", () => {
    for (const server of config.servers) {
      expect(typeof server.env).toBe("object");
      expect(Object.keys(server.env).length).toBeGreaterThan(0);
    }
  });

  test("servers have expected names", () => {
    const names = config.servers.map((s) => s.name).sort();
    expect(names).toEqual([
      "chrome-devtools",
      "context7",
      "exa2",
      "firebase",
      "framer",
      "github",
      "gitlab",
      "pencil",
      "playwright",
      "subtext",
    ]);
  });

  test("persistent servers are exactly playwright, chrome-devtools, framer", () => {
    const persistentNames = config.servers
      .filter((s) => s.mode === "persistent")
      .map((s) => s.name)
      .sort();
    expect(persistentNames).toEqual(["chrome-devtools", "framer", "playwright"]);
  });

  test("all servers have valid string command", () => {
    for (const server of config.servers) {
      expect(typeof server.command).toBe("string");
      expect(server.command.length).toBeGreaterThan(0);
    }
  });

  test("all servers have array args", () => {
    for (const server of config.servers) {
      expect(Array.isArray(server.args)).toBe(true);
    }
  });
});
