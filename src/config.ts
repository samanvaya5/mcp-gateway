import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import type { GatewayConfig } from "./types.js";

const ServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  mode: z.enum(["persistent", "on-demand"]),
  idleTimeout: z.number().min(0),
  disabled: z.boolean(),
});

const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  servers: z.array(ServerConfigSchema).refine(
    (servers) => {
      const names = servers.map((s) => s.name);
      return new Set(names).size === names.length;
    },
    { message: "Duplicate server names are not allowed" }
  ),
  registryPath: z.string().min(1),
  logPath: z.string().min(1),
});

export const DEFAULT_CONFIG = {
  port: 8000,
  host: "127.0.0.1",
  idleTimeout: 300,
  logPath: "/tmp/mcp-gateway.log",
};

function resolveEnvValue(
  value: string,
  env: Record<string, string>
): string {
  // Resolve ${VAR} patterns
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    if (varName.startsWith("cmd:")) {
      const command = varName.slice(4);
      try {
        return execSync(command, { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    }
    return env[varName] ?? "";
  });
}

export function loadConfig(
  path: string,
  env?: Record<string, string>
): GatewayConfig {
  const resolvedEnv = env ?? (process.env as Record<string, string>);
  const raw = JSON.parse(readFileSync(path, "utf8"));

  // Resolve env vars in server env fields
  if (raw.servers && Array.isArray(raw.servers)) {
    raw.servers = raw.servers.map((server: Record<string, unknown>) => {
      if (server.env && typeof server.env === "object") {
        const resolved: Record<string, string> = {};
        for (const [key, val] of Object.entries(
          server.env as Record<string, string>
        )) {
          resolved[key] = resolveEnvValue(val, resolvedEnv);
        }
        return { ...server, env: resolved };
      }
      return server;
    });
  }

  // Apply defaults for undefined fields only (0 and "" are intentional values)
  if (raw.port == null) raw.port = DEFAULT_CONFIG.port;
  if (raw.host == null) raw.host = DEFAULT_CONFIG.host;

  return GatewayConfigSchema.parse(raw) as GatewayConfig;
}
