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
  token?: string; // Optional API token for authentication
  noAuth?: boolean; // Whether to disable authentication entirely
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

/**
 * Server-level identity and capabilities, captured from the MCP initialization
 * handshake and tool list.  All fields come from what the server tells us —
 * nothing is inferred or generated.
 */
export interface DynamicToolEntry {
  namespacedName: string;       // "dynamic__<name>"
  originalName: string;         // "<name>"
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema object
  implementation: string;       // shell template with ${param} placeholders
  createdAt: string;            // ISO timestamp
  updatedAt: string;            // ISO timestamp (same as createdAt on creation)
}

export interface ServerManifest {
  /** Config name from gateway config (e.g. "github") */
  name: string;
  /** Name the server provided during MCP initialization (e.g. "github-mcp-server") */
  serverProvidedName?: string;
  /** Description the server provided during MCP initialization */
  serverProvidedDescription?: string;
  /** Usage instructions the server provided during MCP initialization */
  instructions?: string;
  /** Number of tools this server exposes */
  toolCount: number;
  /** Original tool names (before namespace prefix) */
  toolNames: string[];
}
