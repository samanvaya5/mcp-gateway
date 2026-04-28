// MCP Gateway — TypeScript type definitions

export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  mode: "persistent" | "on-demand";
  idleTimeout: number;
  disabled: boolean;
}

export interface GatewayConfig {
  port: number;
  host: string;
  servers: ServerConfig[];  // Array form (matches generated config)
  registryPath: string;
  logPath: string;
}

export enum ServerStatus {
  STOPPED = "stopped",
  STARTING = "starting",
  RUNNING = "running",
  UNHEALTHY = "unhealthy",
  KILLING = "killing",
}

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  originalName: string;
  versionHash: string;
}

export interface ToolRegistry {
  tools: ToolEntry[];
  generatedAt: string;
  ttl: number;
  serverVersions: Record<string, string>;
}
