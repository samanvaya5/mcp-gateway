import { loadConfig } from "./config.js";
import { createGatewayServer } from "./mcp-server.js";
import { LifecycleManager } from "./lifecycle.js";
import { ToolRegistry, type ILifecycleManager } from "./registry.js";
import { HealthTracker } from "./recovery.js";
import { SpawnLock } from "./spawn-lock.js";
import { registerProxyHandlers } from "./proxy.js";
import { registerApiRoutes } from "./api.js";
import { startWatching } from "./hot-reload.js";
import type { GatewayConfig, ServerConfig } from "./types.js";

const configPath =
  process.env.MCP_GATEWAY_CONFIG ||
  "/Users/samanvayayagsen/.sisyphus/mcp-gateway-config.json";

const watch = process.argv.includes("--watch");
const refreshRegistry = process.argv.includes("--refresh-registry");

async function main(): Promise<void> {
  const config: GatewayConfig = loadConfig(configPath);

  const spawnLock = new SpawnLock();
  const lifecycle = new LifecycleManager();
  const healthTracker = new HealthTracker();
  const registry = await ToolRegistry.load(config.registryPath);

  const { server: mcpServer, httpServer } =
    await createGatewayServer(config);

  registerProxyHandlers(
    mcpServer,
    config,
    lifecycle,
    registry,
    healthTracker,
    spawnLock,
  );

  registerApiRoutes(httpServer, config, lifecycle, registry, healthTracker);

  let hotReloadHandle: { stop: () => void } | null = null;
  if (watch) {
    hotReloadHandle = startWatching(configPath, config, lifecycle, () => {
      console.log(
        JSON.stringify({
          event: "config_changed",
          timestamp: new Date().toISOString(),
        }),
      );
    });
  }

  if (refreshRegistry) {
    const adapter: ILifecycleManager = {
      async spawnServer(serverConfig: ServerConfig) {
        const handle = await lifecycle.spawn(
          serverConfig.name,
          serverConfig,
          spawnLock,
        );
        return { client: handle.client };
      },
      async killServer(name: string) {
        await lifecycle.kill(name);
      },
    };
    await registry.refresh(config, adapter);
    await registry.save(config.registryPath);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(
      JSON.stringify({
        event: "gateway_shutdown",
        signal,
        timestamp: new Date().toISOString(),
      }),
    );

    if (hotReloadHandle) {
      await hotReloadHandle.stop();
    }

    await lifecycle.killAll();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(
    JSON.stringify({
      event: "gateway_started",
      port: config.port,
      host: config.host,
      servers: config.servers.length,
      pid: process.pid,
      watch,
      refreshRegistry,
      timestamp: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
