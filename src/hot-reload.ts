import chokidar from "chokidar";
import type { GatewayConfig, ServerConfig } from "./types.js";
import type { LifecycleManager } from "./lifecycle.js";
import { loadConfig } from "./config.js";

export function startWatching(
  configPath: string,
  currentConfig: GatewayConfig,
  lifecycle: LifecycleManager,
  onConfigChanged: (newConfig: GatewayConfig) => void,
  invalidateServer?: (name: string) => void,
): { stop: () => void } {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const watcher = chokidar.watch(configPath, {
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("change", () => {
    if (stopped) return;

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      if (stopped) return;

      try {
        const newConfig = loadConfig(configPath);
        const { added, updated } = await applyConfigDiff(currentConfig, newConfig, lifecycle);
        copyConfigFields(currentConfig, newConfig);
        onConfigChanged(currentConfig);
        // Invalidate registry for added/updated servers so next tools/list refresh picks them up
        if (invalidateServer) {
          for (const name of [...added, ...updated]) {
            invalidateServer(name);
          }
        }
      } catch (err) {
        console.error("[hot-reload] Failed to reload config:", err);
      }
    }, 500);
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}

async function applyConfigDiff(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig,
  lifecycle: LifecycleManager,
): Promise<{ added: string[]; removed: string[]; updated: string[] }> {
  const oldByName = indexServersByName(oldConfig.servers);
  const newByName = indexServersByName(newConfig.servers);
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  // Detect removed and added servers
  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      removed.push(name);
    }
  }
  for (const [name] of newByName) {
    if (!oldByName.has(name)) {
      added.push(name);
    }
  }

  await killRemovedServers(oldByName, newByName, lifecycle);

  // Detect updated servers
  for (const [name, newServer] of newByName) {
    const oldServer = oldByName.get(name);
    if (!oldServer) continue;

    if (shouldKillServer(oldServer, newServer)) {
      await lifecycle.kill(name);
      updated.push(name);
    }
  }

  return { added, removed, updated };
}

function indexServersByName(
  servers: ServerConfig[],
): Map<string, ServerConfig> {
  const map = new Map<string, ServerConfig>();
  for (const s of servers) map.set(s.name, s);
  return map;
}

async function killRemovedServers(
  oldByName: Map<string, ServerConfig>,
  newByName: Map<string, ServerConfig>,
  lifecycle: LifecycleManager,
): Promise<void> {
  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      await lifecycle.kill(name);
    }
  }
}

function shouldKillServer(
  oldServer: ServerConfig,
  newServer: ServerConfig,
): boolean {
  if (newServer.disabled) return true;
  if (oldServer.disabled && !newServer.disabled) return false;
  if (
    oldServer.command !== newServer.command ||
    !arraysEqual(oldServer.args, newServer.args) ||
    !envsEqual(oldServer.env, newServer.env)
  ) {
    return true;
  }
  return false;
}

function copyConfigFields(
  target: GatewayConfig,
  source: GatewayConfig,
): void {
  target.port = source.port;
  target.host = source.host;
  target.servers = source.servers;
  target.registryPath = source.registryPath;
  target.logPath = source.logPath;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function envsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in b) || a[key] !== b[key]) return false;
  }
  return true;
}
