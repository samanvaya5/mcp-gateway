// MCP Gateway — REST API routes (Node.js built-in http module only)
import { EventEmitter } from "node:events";
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { GatewayConfig, ServerConfig } from "./types.js";
import { SpawnLock } from "./spawn-lock.js";
import type { LifecycleManager } from "./lifecycle.js";
import type { ToolRegistry } from "./registry.js";
import type { HealthTracker } from "./recovery.js";

// ── Event bus for SSE ─────────────────────────────────────────────

/** Global event emitter that SSE streams listen to. */
export const gatewayEvents = new EventEmitter();

// ── Helpers ───────────────────────────────────────────────────────

const SECRET_PATTERN =
  /(key|secret|token|password|auth|credential|private)/i;

function sanitizeEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_PATTERN.test(k) ? "***REDACTED***" : v;
  }
  return out;
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function getServerStatus(
  name: string,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
): string {
  if (lifecycle.listRunning().includes(name)) {
    return healthTracker.isHealthy(name) ? "running" : "unhealthy";
  }
  return "stopped";
}

// ── Route handlers ────────────────────────────────────────────────

async function handleHealth(
  res: ServerResponse,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
): Promise<void> {
  const total = config.servers.length;
  const running = lifecycle.listRunning().length;
  const body = {
    status: "ok",
    uptime: Math.round(process.uptime()),
    serversTotal: total,
    serversRunning: running,
    memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  };
  jsonResponse(res, 200, body);
}

async function handleListServers(
  res: ServerResponse,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
): Promise<void> {
  const servers = config.servers
    .filter((s) => !s.disabled)
    .map((s) => {
      const entry = lifecycle.get(s.name);
      const status = getServerStatus(s.name, lifecycle, healthTracker);
      return {
        name: s.name,
        mode: s.mode,
        status,
        uptime: entry ? Math.round((Date.now() - entry.startedAt) / 1000) : undefined,
      };
    });

  jsonResponse(res, 200, { servers });
}

async function handleGetServer(
  res: ServerResponse,
  name: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
): Promise<void> {
  const serverCfg = config.servers.find((s) => s.name === name);
  if (!serverCfg) {
    jsonResponse(res, 404, { error: `Server not found: ${name}` });
    return;
  }

  const entry = lifecycle.get(name);
  const status = getServerStatus(name, lifecycle, healthTracker);
  const health = healthTracker.getHealth?.(name) ?? healthTracker.isHealthy(name);

  const failures =
    typeof (health as Record<string, unknown>)?.consecutiveFailures ===
    "number"
      ? (health as Record<string, unknown>).consecutiveFailures
      : undefined;

  const body: Record<string, unknown> = {
    name: serverCfg.name,
    mode: serverCfg.mode,
    status,
    idleTimeout: serverCfg.idleTimeout,
  };

  if (entry) {
    body.pid = entry.transport?.pid;
    body.uptime = Math.round((Date.now() - entry.startedAt) / 1000);
    body.lastActivity = new Date(entry.lastActivity).toISOString();
  }

  if (failures !== undefined && failures > 0) {
    body.failures = failures;
  }

  jsonResponse(res, 200, body);
}

async function handleStartServer(
  res: ServerResponse,
  name: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  spawnLock: SpawnLock,
): Promise<void> {
  const serverCfg = config.servers.find((s) => s.name === name);
  if (!serverCfg) {
    jsonResponse(res, 404, { error: `Server not found: ${name}` });
    return;
  }

  if (lifecycle.listRunning().includes(name)) {
    jsonResponse(res, 400, { error: `Server already running: ${name}` });
    return;
  }

  try {
    const handle = await lifecycle.spawn(name, serverCfg, spawnLock);
    gatewayEvents.emit("gateway_event", {
      event: "server_started",
      server: name,
      timestamp: new Date().toISOString(),
    });
    jsonResponse(res, 200, { status: "started", pid: handle.pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 500, { error: message });
  }
}

async function handleStopServer(
  res: ServerResponse,
  name: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
): Promise<void> {
  const serverCfg = config.servers.find((s) => s.name === name);
  if (!serverCfg) {
    jsonResponse(res, 404, { error: `Server not found: ${name}` });
    return;
  }

  if (!lifecycle.listRunning().includes(name)) {
    jsonResponse(res, 400, { error: `Server not running: ${name}` });
    return;
  }

  await lifecycle.kill(name);
  gatewayEvents.emit("gateway_event", {
    event: "server_stopped",
    server: name,
    timestamp: new Date().toISOString(),
  });
  jsonResponse(res, 200, { status: "stopped" });
}

async function handleRestartServer(
  res: ServerResponse,
  name: string,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  spawnLock: SpawnLock,
): Promise<void> {
  const serverCfg = config.servers.find((s) => s.name === name);
  if (!serverCfg) {
    jsonResponse(res, 404, { error: `Server not found: ${name}` });
    return;
  }

  // Kill if running (kill is a no-op if already stopped)
  await lifecycle.kill(name);

  try {
    const handle = await lifecycle.spawn(name, serverCfg, spawnLock);
    gatewayEvents.emit("gateway_event", {
      event: "server_restarted",
      server: name,
      timestamp: new Date().toISOString(),
    });
    jsonResponse(res, 200, { status: "restarted", pid: handle.pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jsonResponse(res, 500, { error: message });
  }
}

async function handleListTools(
  res: ServerResponse,
  url: URL,
  registry: ToolRegistry,
): Promise<void> {
  const q = url.searchParams.get("q");
  const tools = q ? registry.search(q) : registry.tools;
  jsonResponse(res, 200, { tools });
}

function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Flush headers immediately so the client receives the 200
  res.write(":\n\n");

  const onEvent = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  gatewayEvents.on("gateway_event", onEvent);

  req.on("close", () => {
    gatewayEvents.off("gateway_event", onEvent);
    res.end();
  });
}

// ── Router ────────────────────────────────────────────────────────

async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
  spawnLock: SpawnLock,
): Promise<void> {
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const parts = path.split("/").filter(Boolean);

  // GET /api/health
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "health") {
    return handleHealth(res, config, lifecycle);
  }

  // GET /api/tools and GET /api/tools?q=...
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "tools") {
    return handleListTools(res, url, registry);
  }

  // GET /api/events — SSE stream
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "events") {
    return handleSSE(req, res);
  }

  // GET /api/servers
  if (parts.length === 2 && parts[0] === "api" && parts[1] === "servers") {
    return handleListServers(res, config, lifecycle, healthTracker);
  }

  // /api/servers/:name, /api/servers/:name/start, etc.
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "servers") {
    const serverName = parts[2]!;
    const action = parts[3];

    if (!action) {
      // GET /api/servers/:name
      if (method === "GET") {
        return handleGetServer(
          res,
          serverName,
          config,
          lifecycle,
          healthTracker,
        );
      }
    } else if (action === "start" && method === "POST") {
      return handleStartServer(res, serverName, config, lifecycle, spawnLock);
    } else if (action === "stop" && method === "POST") {
      return handleStopServer(res, serverName, config, lifecycle);
    } else if (action === "restart" && method === "POST") {
      return handleRestartServer(
        res,
        serverName,
        config,
        lifecycle,
        spawnLock,
      );
    }
  }

  // Unknown route
  jsonResponse(res, 404, { error: "Not Found" });
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Register REST API routes on the existing HTTP server.
 *
 * API routes are prefixed with `/api/` and coexist alongside
 * the MCP transport endpoints (`/mcp`, `/sse`).
 *
 * This function intercepts incoming requests BEFORE the MCP transport
 * handler so that `/api/*` routes are never forwarded.
 */
export function registerApiRoutes(
  httpServer: HttpServer,
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): void {
  // Preserve any existing request listeners (e.g. the MCP transport handler)
  // so we can delegate non-API requests back to them.
  const mcpListeners = httpServer.listeners("request").slice();

  httpServer.removeAllListeners("request");

  const spawnLock = new SpawnLock();

  httpServer.on("request", async (req, res): Promise<void> => {
    const url = new URL(
      req.url ?? "/",
      `http://${config.host}:${config.port}`,
    );
    const path = url.pathname;

    // API routes — handle here
    if (path.startsWith("/api/")) {
      try {
        await handleApiRoute(
          req,
          res,
          url,
          config,
          lifecycle,
          registry,
          healthTracker,
          spawnLock,
        );
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          jsonResponse(res, 500, { error: message });
        }
      }
      return;
    }

    // Delegate to original MCP transport handler(s)
    for (const listener of mcpListeners) {
      try {
        await (listener as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req, res);
      } catch {
        // Original handler manages its own errors
      }
    }
  });
}
