import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client";
import type { ServerConfig } from "./types.js";
import type { SpawnLock } from "./spawn-lock.js";

interface ServerEntry {
  client: Client;
  transport: StdioClientTransport;
  startedAt: number;
  lastActivity: number;
  mode: "persistent" | "on-demand";
  serverInfo?: { name: string; version: string; description?: string };
  instructions?: string;
}

export interface SpawnHandle {
  pid: number | null;
  client: Client;
  transport: StdioClientTransport;
  serverInfo?: { name: string; version: string; description?: string };
  instructions?: string;
}

const IDLE_CHECK_INTERVAL_MS = 30_000;
const SIGKILL_GRACE_MS = 3_000;

export class LifecycleManager {
  private servers = new Map<string, ServerEntry>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  async spawn(
    name: string,
    config: ServerConfig,
    lock: SpawnLock,
  ): Promise<SpawnHandle> {
    if (config.disabled) {
      throw new Error(`Cannot spawn disabled server: ${name}`);
    }

    return lock.acquire(name, async () => {
      const existing = this.servers.get(name);
      if (existing) {
        return {
          pid: existing.transport.pid,
          client: existing.client,
          transport: existing.transport,
          serverInfo: existing.serverInfo,
          instructions: existing.instructions,
        };
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

      const client = new Client(
        { name: "mcp-gateway", version: "0.1.0" },
        { capabilities: {} },
      );

      await client.connect(transport);

      const serverInfo = client.getServerVersion();
      const instructions = client.getInstructions();

      const entry: ServerEntry = {
        client,
        transport,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        mode: config.mode,
        serverInfo,
        instructions,
      };

      this.servers.set(name, entry);
      this.ensureIdleCheckInterval();

      return { pid: transport.pid, client, transport, serverInfo, instructions };
    });
  }

  async kill(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;

    const pid = entry.transport.pid;
    this.servers.delete(name);

    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // process already exited — expected during race with transport.close
      }

      const exited = await this.waitForExit(pid, SIGKILL_GRACE_MS);

      if (!exited) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // process already exited
        }
      }
    }

    try {
      await entry.transport.close();
    } catch {
      // transport already closed
    }
  }

  killIfIdle(name: string, config: ServerConfig): void {
    if (config.mode === "persistent") return;

    const entry = this.servers.get(name);
    if (!entry) return;

    const idleTimeoutMs = config.idleTimeout * 1000;
    if (Date.now() - entry.lastActivity < idleTimeoutMs) return;

    this.kill(name).catch(() => {});
  }

  get(name: string): ServerEntry | undefined {
    return this.servers.get(name);
  }

  trackActivity(name: string): void {
    const entry = this.servers.get(name);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  listRunning(): string[] {
    return Array.from(this.servers.keys());
  }

  async killAll(): Promise<void> {
    this.stopIdleCheckInterval();
    await Promise.all(
      Array.from(this.servers.keys()).map((name) => this.kill(name)),
    );
  }

  private ensureIdleCheckInterval(): void {
    if (this.idleTimer !== null) return;

    this.idleTimer = setInterval(() => {
      for (const [, entry] of this.servers) {
        if (entry.mode === "persistent") continue;
      }
    }, IDLE_CHECK_INTERVAL_MS);

    if (
      this.idleTimer &&
      typeof this.idleTimer === "object" &&
      "unref" in this.idleTimer
    ) {
      (this.idleTimer as unknown as { unref(): void }).unref();
    }
  }

  private stopIdleCheckInterval(): void {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async waitForExit(
    pid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await this.sleep(100);
    }

    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
