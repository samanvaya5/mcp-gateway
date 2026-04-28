import type { McpServer } from "@modelcontextprotocol/server";
import type { GatewayConfig } from "./types.js";
import { LifecycleManager } from "./lifecycle.js";
import { ToolRegistry, type ILifecycleManager } from "./registry.js";
import { HealthTracker } from "./recovery.js";
import type { SpawnLock } from "./spawn-lock.js";
import { getGatewayToolDefs, callGatewayTool } from "./tools.js";

interface ToolListResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export function errorResult(message: string): ToolCallResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function parseNamespacedToolName(namespacedName: string): { serverName: string; originalToolName: string } | null {
  const sepIdx = namespacedName.indexOf("__");
  if (sepIdx === -1) return null;
  return {
    serverName: namespacedName.slice(0, sepIdx),
    originalToolName: namespacedName.slice(sepIdx + 2),
  };
}

export function findServerConfig(config: GatewayConfig, serverName: string) {
  return config.servers.find((s) => s.name === serverName);
}

export async function handleToolsList(
  registry: ToolRegistry,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  spawnLock: SpawnLock,
): Promise<ToolListResult> {
  const anyStale = config.servers.some((s) => registry.isStale(s));

  if (registry.tools.length === 0 || anyStale) {
    const adapter: ILifecycleManager = {
      async spawnServer(serverConfig) {
        return lifecycle.spawn(serverConfig.name, serverConfig, spawnLock);
      },
      async killServer(name) {
        await lifecycle.kill(name);
      },
    };
    await registry.refresh(config, adapter);
  }

  const tools = [
    ...getGatewayToolDefs().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...registry.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  ];

  return { tools };
}

export async function handleToolsCall(
  params: ToolCallParams,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
  spawnLock: SpawnLock,
  registry: ToolRegistry,
): Promise<ToolCallResult> {
  const { name: toolName, arguments: toolArgs = {} } = params;

  // Check gateway-native tools first (non-namespaced names)
  const gatewayResult = await callGatewayTool(
    toolName, toolArgs, config, registry, lifecycle, healthTracker, spawnLock,
  );
  if (gatewayResult !== null) return gatewayResult;

  // Otherwise parse as server__tool namespace
  const parsed = parseNamespacedToolName(toolName);
  if (!parsed) {
    return errorResult(
      `invalid tool name: ${toolName} (expected server__tool format)`,
    );
  }

  const { serverName, originalToolName } = parsed;

  const serverConfig = findServerConfig(config, serverName);
  if (!serverConfig) {
    return errorResult(`unknown server: ${serverName}`);
  }

  if (!healthTracker.isHealthy(serverName)) {
    return errorResult(`server ${serverName} is unhealthy`);
  }

  if (serverConfig.disabled) {
    return errorResult(`server ${serverName} is disabled`);
  }

  try {
    const { client } = await lifecycle.spawn(serverName, serverConfig, spawnLock);

    const result = await (client as any).callTool(
      { name: originalToolName, arguments: toolArgs },
      { timeout: 10000 },
    );

    lifecycle.trackActivity(serverName);
    healthTracker.recordSuccess(serverName);

    return result;
  } catch (error) {
    healthTracker.recordFailure(serverName, error as Error);
    return errorResult(`tool call failed: ${(error as Error).message}`);
  }
}

export function registerProxyHandlers(
  mcpServer: McpServer,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
  spawnLock: SpawnLock,
): void {
  const server = mcpServer.server;

  server.setRequestHandler("tools/list" as any, async (_request: any, _ctx: any) => {
    return handleToolsList(registry, config, lifecycle, spawnLock);
  });

  server.setRequestHandler("tools/call" as any, async (request: any, _ctx: any) => {
    return handleToolsCall(
      request.params as ToolCallParams,
      config,
      lifecycle,
      healthTracker,
      spawnLock,
      registry,
    );
  });
}
