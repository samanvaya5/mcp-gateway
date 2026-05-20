import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { ToolEntry, ServerConfig, GatewayConfig, ServerManifest } from "./types.js";
import { search as bm25Search } from "./bm25.js";

/**
 * Minimal interface for the LifecycleManager dependency.
 * This avoids a hard compile-time dependency on the concrete class.
 */
export interface ILifecycleManager {
  spawnServer(config: ServerConfig): Promise<{
    client: {
      listTools(): Promise<{
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }>;
      }>;
    };
    serverInfo?: { name: string; version: string; description?: string };
    instructions?: string;
  }>;
  killServer(name: string): Promise<void>;
}

const DEFAULT_TTL = 3600; // 1 hour in seconds

/**
 * Disk-cached tool catalog.  Stores every tool exposed by every configured
 * MCP server so the gateway can route incoming tool calls and expose a
 * unified /tools/list endpoint without keeping servers alive.
 */
export class ToolRegistry {
  tools: ToolEntry[] = [];
  generatedAt: string = "";
  ttl: number = DEFAULT_TTL;
  serverVersions: Record<string, string> = {};
  /** Server self-descriptions captured from MCP initialization handshake */
  serverManifests: Record<string, ServerManifest> = {};

  // ── static helpers ──────────────────────────────────────────────

  /**
   * Deterministic content-hash for a server config.
   * SHA-256 over `command + " " + args.join(" ")`.
   */
  static versionHash(config: ServerConfig): string {
    const input = config.command + " " + config.args.join(" ");
    return createHash("sha256").update(input).digest("hex");
  }

  // ── disk I/O ───────────────────────────────────────────────────

  /**
   * Load the cached registry from `registryPath`.
   * Returns an empty (just-constructed) registry when:
   *  - The file does not exist
   *  - The file is corrupt / unparseable
   *  - The TTL has elapsed since `generatedAt`
   */
  static async load(registryPath: string): Promise<ToolRegistry> {
    const registry = new ToolRegistry();

    try {
      const raw = await readFile(registryPath, "utf-8");
      const data = JSON.parse(raw);

      // Respect TTL — return empty if expired
      const age = Date.now() - new Date(data.generatedAt).getTime();
      if (age > (data.ttl ?? DEFAULT_TTL) * 1000) {
        return registry;
      }

      registry.tools = data.tools ?? [];
      registry.generatedAt = data.generatedAt ?? "";
      registry.ttl = data.ttl ?? DEFAULT_TTL;
      registry.serverVersions = data.serverVersions ?? {};
      registry.serverManifests = data.serverManifests ?? {};
    } catch {
      // File missing or corrupt → empty registry
    }

    return registry;
  }

  /**
   * Persist the current in-memory state to `registryPath`.
   */
  async save(registryPath: string): Promise<void> {
    const dir = dirname(registryPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const data = {
      tools: this.tools,
      generatedAt: this.generatedAt,
      ttl: this.ttl,
      serverVersions: this.serverVersions,
      serverManifests: this.serverManifests,
    };
    await writeFile(registryPath, JSON.stringify(data, null, 2));
  }

  // ── refresh & invalidation ─────────────────────────────────────

  /**
   * Refresh the tool catalog from live servers.
   *
   * For each server in `config.servers`:
   *  1. Spawn the server briefly via `lifecycleManager`
   *  2. Call `client.listTools()` to get the tool list
   *  3. Kill the server (best-effort)
   *  4. Namespace every tool as `serverName__toolName` (double underscore)
   *  5. Store a versionHash so we can detect stale entries later
   *
   * Servers that fail to spawn or respond are silently skipped
   * (their tools stay as-is from previous refresh if any).
   */
  async refresh(
    config: GatewayConfig,
    lifecycleManager: ILifecycleManager,
  ): Promise<void> {
    const newTools: ToolEntry[] = [];
    const newVersions: Record<string, string> = {};

    for (const server of config.servers) {
      const hash = ToolRegistry.versionHash(server);
      newVersions[server.name] = hash;

      try {
        const { client, serverInfo, instructions } =
          await lifecycleManager.spawnServer(server);
        const result = await client.listTools();

        for (const tool of result.tools) {
          newTools.push({
            name: `${server.name}__${tool.name}`,
            description: tool.description ?? "",
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
            serverName: server.name,
            originalName: tool.name,
            versionHash: hash,
          });
        }

        this.serverManifests[server.name] = {
          name: server.name,
          serverProvidedName: serverInfo?.name,
          serverProvidedDescription: serverInfo?.description,
          instructions,
          toolCount: result.tools.length,
          toolNames: result.tools.map((t) => t.name),
        };
      } catch {
        // Spawn failed or listTools errored — skip this server
      } finally {
        try {
          await lifecycleManager.killServer(server.name);
        } catch {
          // Best-effort kill — ignore errors
        }
      }
    }

    this.tools = newTools;
    this.serverVersions = newVersions;
    this.generatedAt = new Date().toISOString();
    this.ttl = DEFAULT_TTL;
  }

  // ── queries ────────────────────────────────────────────────────

  /**
   * BM25 search with token normalization (no embeddings, no FAISS).
   *
   * Features:
   *   - BM25 probabilistic scoring (TF + IDF)
   *   - Token normalization: camelCase, snake_case, kebab-case
   *   - Server-scoped search support
   *   - Zero dependencies, pure math
   *
   * @param query   - Search query string
   * @param limit   - Maximum results to return (default: 20)
   * @param server  - Optional server name to restrict search
   */
  search(query: string, limit: number = 20, server?: string): ToolEntry[] {
    const results = bm25Search(query, this.tools, { server, limit });
    return results.map((r) => r.tool);
  }

  /**
   * Return all tools belonging to `serverName`.
   */
  getByServer(serverName: string): ToolEntry[] {
    return this.tools.filter((t) => t.serverName === serverName);
  }

  /**
   * Return the self-reported manifest for a server (name, description,
   * instructions) captured during the last registry refresh.
   */
  getServerManifest(serverName: string): ServerManifest | undefined {
    return this.serverManifests[serverName];
  }

  /**
   * Return manifests for all servers.
   */
  getAllServerManifests(): ServerManifest[] {
    return Object.values(this.serverManifests);
  }

  /**
   * Remove all tools from a specific server from the in-memory catalog
   * (also drops its version hash and manifest so the next `isStale` returns true).
   */
  invalidate(serverName: string): void {
    this.tools = this.tools.filter((t) => t.serverName !== serverName);
    delete this.serverVersions[serverName];
    delete this.serverManifests[serverName];
  }

  /**
   * Returns `true` when the stored versionHash for `serverConfig.name`
   * differs from the hash of `serverConfig` itself — meaning the config
   * has changed since the last refresh.
   */
  isStale(serverConfig: ServerConfig): boolean {
    const storedHash = this.serverVersions[serverConfig.name];
    if (storedHash === undefined) return true;
    const currentHash = ToolRegistry.versionHash(serverConfig);
    return storedHash !== currentHash;
  }
}
