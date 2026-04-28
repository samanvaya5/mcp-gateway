import { z } from "zod";
import type { GatewayConfig } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { HealthTracker } from "./recovery.js";
import type { SpawnLock } from "./spawn-lock.js";

// ── Schema definitions ────────────────────────────────────────────────

const SearchToolsSchema = z.object({ query: z.string().describe("Search query to find tools by name or description") });
const ServerStatusSchema = z.object({ server: z.string().describe("Name of the server to check status for") });
const ManageServerSchema = z.object({
  server: z.string().describe("Name of the server to manage"),
  action: z.enum(["enable", "disable", "restart"]).describe("Action: enable, disable, or restart the server"),
});

// ── Search result type ────────────────────────────────────────────────

interface SearchResult {
  name: string;
  server: string;
  description: string;
  inputSchema: object;
  serverStatus: string;
}

// ── Individual handler functions (exported for testability) ────────────

export function handleSearchTools(
  query: string,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): { results: SearchResult[] } {
  const rawResults = registry.search(query);

  const results: SearchResult[] = rawResults
    .filter((tool) => healthTracker.isHealthy(tool.serverName))
    .map((tool) => ({
      name: tool.name,
      server: tool.serverName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      serverStatus: "healthy" as const,
    }));

  return { results };
}

export interface ServerInfo {
  name: string;
  mode: string;
  status: string;
  idleTimeout: number;
  disabled: boolean;
}

export function handleListServers(
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
): { servers: ServerInfo[] } {
  const running = new Set(lifecycle.listRunning());

  const servers: ServerInfo[] = config.servers.map((srv) => {
    let status: string;

    if (srv.disabled) {
      status = "disabled";
    } else if (running.has(srv.name)) {
      if (!healthTracker.isHealthy(srv.name)) {
        status = "unhealthy";
      } else {
        status = "running";
      }
    } else if (!healthTracker.isHealthy(srv.name)) {
      status = "unhealthy";
    } else {
      status = "stopped";
    }

    return {
      name: srv.name,
      mode: srv.mode,
      status,
      idleTimeout: srv.idleTimeout,
      disabled: srv.disabled,
    };
  });

  return { servers };
}

export interface ServerStatusDetail {
  name: string;
  mode: string;
  status: string;
  pid?: number | null;
  uptime?: number;
  lastActivity?: number;
  memory?: number;
  disabled: boolean;
}

export function handleServerStatus(
  server: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
): ServerStatusDetail {
  const serverConfig = config.servers.find((s) => s.name === server);
  if (!serverConfig) {
    throw new Error(`Unknown server: ${server}`);
  }

  const entry = lifecycle.get(server);
  const running = lifecycle.listRunning().includes(server);
  const healthy = healthTracker.isHealthy(server);

  let status: string;
  if (serverConfig.disabled) {
    status = "disabled";
  } else if (running) {
    status = healthy ? "running" : "unhealthy";
  } else if (!healthy) {
    status = "unhealthy";
  } else {
    status = "stopped";
  }

  const result: ServerStatusDetail = {
    name: server,
    mode: serverConfig.mode,
    status,
    disabled: serverConfig.disabled,
  };

  if (entry) {
    result.pid = entry.transport.pid;
    result.uptime = Date.now() - entry.startedAt;
    result.lastActivity = entry.lastActivity;
    // memory is not tracked by LifecycleManager — omitted
  }

  return result;
}

export interface ManageResult {
  server: string;
  action: string;
  result: "ok";
}

export async function handleManageServer(
  server: string,
  action: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  spawnLock: SpawnLock,
): Promise<ManageResult> {
  const serverConfig = config.servers.find((s) => s.name === server);
  if (!serverConfig) {
    throw new Error(`Unknown server: ${server}`);
  }

  switch (action) {
    case "enable":
      serverConfig.disabled = false;
      break;

    case "disable":
      serverConfig.disabled = true;
      await lifecycle.kill(server);
      break;

    case "restart":
      await lifecycle.kill(server);
      // Spawn uses the lock so multiple concurrent restarts are safe
      await lifecycle.spawn(server, serverConfig, spawnLock);
      break;

    default:
      throw new Error(`Unknown action: ${action}. Must be one of: enable, disable, restart`);
  }

  return { server, action, result: "ok" };
}

// ── Gateway tool call result type ──────────────────────────────────────

export interface GatewayToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Gateway tool definitions (used by proxy to merge into tools/list) ───

export interface GatewayToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function getGatewayToolDefs(): GatewayToolDef[] {
  return [
    {
      name: "search_tools",
      description: "Search across all registered MCP tools by name or description. Returns tools tagged with their source server and health status.",
      inputSchema: SearchToolsSchema as any,
    },
    {
      name: "list_servers",
      description: "List all configured MCP servers with their current status (running, stopped, unhealthy, disabled) and idle timeout.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "server_status",
      description: "Get detailed status for a specific server including PID, uptime, and last activity timestamp.",
      inputSchema: ServerStatusSchema as any,
    },
    {
      name: "manage_server",
      description: "Manage a gateway server: enable (allow spawning), disable (prevent spawning and kill if running), or restart (kill and respawn).",
      inputSchema: ManageServerSchema as any,
    },
  ];
}

// ── Gateway tool dispatch (used by proxy's tools/call handler) ─────────

export async function callGatewayTool(
  name: string,
  args: Record<string, unknown>,
  config: GatewayConfig,
  registry: ToolRegistry,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
  spawnLock: SpawnLock,
): Promise<GatewayToolCallResult | null> {
  switch (name) {
    case "search_tools": {
      const query = typeof args.query === "string" ? args.query : "";
      return {
        content: [{
          type: "text",
          text: JSON.stringify(handleSearchTools(query, registry, healthTracker)),
        }],
      };
    }
    case "list_servers": {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(handleListServers(config, lifecycle, healthTracker)),
        }],
      };
    }
    case "server_status": {
      const server = typeof args.server === "string" ? args.server : "";
      const result = handleServerStatus(server, config, lifecycle, healthTracker);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result),
        }],
      };
    }
    case "manage_server": {
      const server = typeof args.server === "string" ? args.server : "";
      const action = typeof args.action === "string" ? args.action : "";
      const result = await handleManageServer(server, action, config, lifecycle, spawnLock);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result),
        }],
      };
    }
    default:
      return null; // Not a gateway tool — proxy should fall through to upstream
  }
}
