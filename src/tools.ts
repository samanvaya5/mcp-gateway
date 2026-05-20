import { z } from "zod";
import type { GatewayConfig } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { HealthTracker } from "./recovery.js";
import type { SpawnLock } from "./spawn-lock.js";
import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { DynamicToolRegistry, executeShellTool, resolveTemplate, validateTemplate, type TemplateWarning } from "./dynamic-tools.js";
import { search as bm25Search } from "./bm25.js";

// ── Schema definitions ────────────────────────────────────────────────

const SearchToolsSchema = z.object({
  query: z.string().describe("Search query to find tools by name or description"),
  limit: z.number().min(1).max(50).optional().describe("Maximum number of results to return (default: 20, max: 50)"),
  server: z.string().optional().describe("Optional server name to restrict search to (e.g. 'github', 'exa2')"),
});

const CreateToolSchema = z.object({
  name: z.string().min(1).describe("Unique name for the new tool. Will be sanitized to lowercase alphanumeric + underscores."),
  description: z.string().min(1).describe("Describe what this tool does and when to use it. This is shown when the tool is discovered later."),
  parameters: z.record(z.string(), z.any()).describe("JSON Schema object defining the tool's input parameters: { type: 'object', properties: {...}, required: [...] }"),
  implementation: z.string().min(1).describe("Shell command template. Use ${paramName} placeholders — they are shell-escaped before substitution."),
  force: z.boolean().optional().describe("If true, overwrite an existing tool with the same name. Default: false."),
});

const ListDynamicToolsSchema = z.object({}).describe("List all currently registered dynamic tools.");

const DeleteDynamicToolSchema = z.object({
  name: z.string().min(1).describe("Name of the dynamic tool to delete (original name, e.g. 'smart_grep', or namespaced, e.g. 'dynamic__smart_grep')."),
});

const RegisterServerSchema = z.object({
  name: z.string().min(1).describe("Unique name for this server. Must not conflict with existing servers."),
  command: z.string().min(1).describe("Command to launch the MCP server (e.g. 'npx')."),
  args: z.array(z.string()).optional().describe("Arguments for the command (e.g. ['-y', '@modelcontextprotocol/server-github'])"),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to pass to the server."),
  mode: z.enum(["persistent", "on-demand"]).optional().describe("'persistent' for always-running or 'on-demand' for start-on-call. Default: 'on-demand'"),
  idleTimeout: z.number().min(0).optional().describe("Idle timeout in seconds before killing on-demand servers. Default: 300."),
});

const UnregisterServerSchema = z.object({
  name: z.string().optional().describe("Name of a single server to remove."),
  names: z.array(z.string()).optional().describe("Names of multiple servers to remove in bulk. Use this to clean up test servers at once."),
}).refine((data) => data.name || data.names, { message: "Either 'name' or 'names' is required" });

const DescribeToolSchema = z.object({
  tool: z.string().describe("Namespaced tool name to describe (e.g. 'exa2__web_search_exa')"),
});

const ServerStatusSchema = z.object({
  server: z.string().describe("Name of the server to check status for"),
});

const ManageServerSchema = z.object({
  server: z.string().describe("Name of the server to manage"),
  action: z.enum(["enable", "disable", "restart"]).describe("Action: enable, disable, or restart the server"),
});

const ExecuteToolSchema = z.object({
  tool: z.string().describe("Namespaced tool name to execute (e.g. 'exa2__web_search_exa')"),
  args: z.record(z.string(), z.any()).optional().describe("Arguments object for the tool. Example: {\"query\":\"hello\",\"numResults\":10}"),
});

const BrowseServerSchema = z.object({
  server: z.string().describe("Server name to browse (e.g. 'github', 'exa2', 'playwright')"),
});

// ── Search result type ────────────────────────────────────────────────

interface SearchResult {
  name: string;
  server: string;
  description: string;
  serverStatus: string;
  bm25Score?: number;
}

interface ToolDescription {
  name: string;
  server: string;
  originalName: string;
  description: string;
  inputSchema: object;
  serverStatus: string;
  examples?: string[];
}

// ── Individual handler functions (exported for testability) ────────────

export function handleSearchTools(
  query: string,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
  limit?: number,
  server?: string,
  dynamicRegistry?: DynamicToolRegistry,
): { results: SearchResult[]; total: number } {
  // Filter tools to only those from healthy servers before searching.
  // This ensures the limit is applied to healthy results only.
  const healthyTools = registry.tools.filter((t) =>
    healthTracker.isHealthy(t.serverName),
  );

  const rawResults = bm25Search(query, healthyTools, { server, limit });

  const results: SearchResult[] = rawResults.map((result) => ({
    name: result.tool.name,
    server: result.tool.serverName,
    description: result.tool.description,
    serverStatus: "healthy" as const,
    bm25Score: Math.round(result.score * 100) / 100,
  }));

  // Append matching dynamic tools
  if (dynamicRegistry && (!server || server === "dynamic")) {
    const queryLower = query.toLowerCase();
    for (const tool of dynamicRegistry.list()) {
      if (
        tool.originalName.toLowerCase().includes(queryLower) ||
        tool.description.toLowerCase().includes(queryLower)
      ) {
        results.push({
          name: tool.namespacedName,
          server: "dynamic",
          description: tool.description,
          serverStatus: "healthy",
        });
      }
    }
  }

  return { results, total: results.length };
}

export function handleDescribeTool(
  toolName: string,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): ToolDescription {
  const tool = registry.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  // Generate example usage from schema
  const examples = generateExamples(tool.inputSchema);

  return {
    name: tool.name,
    server: tool.serverName,
    originalName: tool.originalName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    serverStatus: healthTracker.isHealthy(tool.serverName)
      ? "healthy"
      : "unhealthy",
    examples,
  };
}

/**
 * Generate example argument objects from a JSON schema.
 * Creates 1-3 examples showing common usage patterns.
 */
function generateExamples(schema: unknown): string[] {
  const examples: string[] = [];
  if (!schema || typeof schema !== "object") return examples;

  const obj = schema as Record<string, unknown>;
  const properties = obj.properties as Record<string, unknown> | undefined;
  const required = (obj.required as string[]) ?? [];

  if (!properties) return examples;

  // Example 1: Minimal required fields only
  const minimal: Record<string, unknown> = {};
  for (const key of required) {
    const prop = properties[key] as Record<string, unknown> | undefined;
    if (prop) {
      minimal[key] = getExampleValue(prop, key);
    }
  }
  if (Object.keys(minimal).length > 0) {
    examples.push(JSON.stringify(minimal));
  }

  // Example 2: All fields with realistic values
  const full: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    full[key] = getExampleValue(prop as Record<string, unknown>, key);
  }
  if (Object.keys(full).length > Object.keys(minimal).length) {
    examples.push(JSON.stringify(full));
  }

  return examples;
}

function getExampleValue(prop: Record<string, unknown>, key: string): unknown {
  const type = prop.type as string | undefined;
  const example = prop.example;

  if (example !== undefined) return example;

  switch (type) {
    case "string": {
      const desc = (prop.description as string) ?? "";
      if (key.includes("query") || key.includes("search")) return "example search query";
      if (key.includes("url")) return "https://example.com";
      if (key.includes("path")) return "/path/to/file";
      if (key.includes("name")) return "example-name";
      if (key.includes("id")) return "abc123";
      if (desc.includes("JSON")) return '{"key": "value"}';
      return "example string";
    }
    case "number":
    case "integer": {
      const desc = (prop.description as string) ?? "";
      if (key.includes("page") || key.includes("offset")) return 1;
      if (key.includes("limit") || key.includes("count") || key.includes("num")) return 10;
      if (desc.includes("second")) return 30;
      return 42;
    }
    case "boolean":
      return key.includes("enable") || key.includes("active") || key.includes("force");
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items?.type === "string") return ["item1", "item2"];
      return [];
    }
    case "object":
      return {};
    default:
      return null;
  }
}

export interface ServerInfo {
  name: string;
  mode: string;
  status: string;
  idleTimeout: number;
  disabled: boolean;
  /** Description the server provided during MCP initialization (or gateway's own description) */
  description?: string;
  /** Number of tools this server exposes */
  toolCount: number;
  /** Sample tool names to help understand what the server does */
  sampleTools: string[];
}

export function handleListServers(
  config: GatewayConfig,
  lifecycle: LifecycleManager,
  healthTracker: HealthTracker,
  registry: ToolRegistry,
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

    const manifest = registry.getServerManifest(srv.name);
    const serverTools = registry.getByServer(srv.name);

    return {
      name: srv.name,
      mode: srv.mode,
      status,
      idleTimeout: srv.idleTimeout,
      disabled: srv.disabled,
      description: manifest?.serverProvidedDescription,
      toolCount: manifest?.toolCount ?? serverTools.length,
      sampleTools: manifest?.toolNames.slice(0, 5) ?? serverTools.slice(0, 5).map((t) => t.originalName),
    };
  });

  // Prepend the gateway itself as a virtual server
  const gatewayTools = getGatewayToolDefs();
  servers.unshift({
    name: "mcp-gateway",
    mode: "persistent",
    status: "running",
    idleTimeout: 0,
    disabled: false,
    description: "MCP Gateway — orchestrates backend MCP servers for web search, GitHub, Firebase, browser automation, SSH, YouTube analysis, and more",
    toolCount: gatewayTools.length,
    sampleTools: gatewayTools.map((t) => t.name),
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
  /** Seconds until on-demand server auto-kills (0 for persistent) */
  idleTimeout?: number;
  /** Seconds since last activity */
  idleFor?: number;
  /** Whether this server will auto-start on tool call */
  autoStart?: boolean;
  /** Health diagnostics grouped for agent clarity */
  health?: {
    consecutiveFailures: number;
    unhealthy: boolean;
    lastError?: string;
    retryDelay: number;
  };
  /** Instructions from the MCP server handshake */
  instructions?: string;
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
    idleTimeout: serverConfig.mode === "on-demand" ? serverConfig.idleTimeout : 0,
    idleFor: undefined, // computed below if running
    autoStart: serverConfig.mode === "on-demand",
  };

  if (entry) {
    result.pid = entry.transport.pid;
    result.uptime = Date.now() - entry.startedAt;
    result.lastActivity = entry.lastActivity;
    result.idleFor = Math.round((Date.now() - entry.lastActivity) / 1000);
    result.instructions = entry.instructions;
  }

  // Health diagnostics
  const serverHealth = healthTracker.getHealth(server);
  if (serverHealth) {
    result.health = {
      consecutiveFailures: serverHealth.consecutiveFailures,
      unhealthy: serverHealth.unhealthy,
      lastError: serverHealth.lastError?.message,
      retryDelay: healthTracker.getRetryDelay(server),
    };
  }

  return result;
}

export interface ManageResult {
  server: string;
  action: string;
  result: "ok";
}

// ── browse_server types ────────────────────────────────────────────

interface BrowseServerTool {
  name: string;
  originalName: string;
  description: string;
}

interface BrowseServerGroup {
  pattern: string;
  tools: BrowseServerTool[];
}

interface BrowseServerResult {
  server: {
    name: string;
    serverProvidedName?: string;
    description?: string;
    instructions?: string;
    toolCount: number;
  };
  toolGroups: BrowseServerGroup[];
}

// ── browse_server handler ─────────────────────────────────────────

/**
 * Group tools by common prefix in their original names (e.g. "search_*", "create_*").
 * Only prefixes shared by 2+ tools form a group; remaining tools are "other".
 */
function groupToolsByPrefix(tools: import("./types.js").ToolEntry[]): BrowseServerGroup[] {
  // Collect prefix → tools
  const prefixMap = new Map<string, BrowseServerTool[]>();

  for (const tool of tools) {
    const parts = tool.originalName.split("_");
    const prefix = parts.length >= 2 ? (parts[0] ?? "") : "";
    if (!prefixMap.has(prefix)) {
      prefixMap.set(prefix, []);
    }
    prefixMap.get(prefix)!.push({
      name: tool.name,
      originalName: tool.originalName,
      description: tool.description,
    });
  }

  // Groups: only prefixes with 2+ tools get their own group
  const groups: BrowseServerGroup[] = [];
  const groupedNames = new Set<string>();

  for (const [prefix, groupTools] of prefixMap) {
    if (prefix && groupTools.length >= 2) {
      groups.push({ pattern: prefix, tools: groupTools });
      for (const t of groupTools) {
        groupedNames.add(t.name);
      }
    }
  }

  // Remaining tools go into "other"
  const other: BrowseServerTool[] = [];
  for (const tool of tools) {
    if (!groupedNames.has(tool.name)) {
      other.push({
        name: tool.name,
        originalName: tool.originalName,
        description: tool.description,
      });
    }
  }
  if (other.length > 0) {
    groups.push({ pattern: "other", tools: other });
  }

  // Sort groups: named groups by size desc, "other" last
  groups.sort((a, b) => {
    if (a.pattern === "other") return 1;
    if (b.pattern === "other") return -1;
    return b.tools.length - a.tools.length;
  });

  return groups;
}

export function handleBrowseServer(
  serverName: string,
  registry: ToolRegistry,
  healthTracker: HealthTracker,
): BrowseServerResult {
  // Handle the gateway itself as a virtual server
  if (serverName === "mcp-gateway") {
    const gatewayTools = getGatewayToolDefs();
    return {
      server: {
        name: "mcp-gateway",
        serverProvidedName: "mcp-gateway",
        description: "MCP Gateway — orchestrates backend MCP servers for web search, GitHub, Firebase, browser automation, SSH, YouTube analysis, and more",
        toolCount: gatewayTools.length,
      },
      toolGroups: [{
        pattern: "gateway",
        tools: gatewayTools.map((t) => ({
          name: t.name,
          originalName: t.name,
          description: t.description,
        })),
      }],
    };
  }

  const manifest = registry.getServerManifest(serverName);
  if (!manifest) {
    throw new Error(`Server not found: ${serverName}`);
  }

  const tools = registry.getByServer(serverName);
  const groups = groupToolsByPrefix(tools);

  return {
    server: {
      name: serverName,
      serverProvidedName: manifest.serverProvidedName,
      description: manifest.serverProvidedDescription,
      instructions: manifest.instructions,
      toolCount: manifest.toolCount,
    },
    toolGroups: groups,
  };
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
      description: `Search across all registered MCP tools by name or description. Returns lightweight results (name, server, description) — use describe_tool to get full parameter details for any result.

WORKFLOW: This is the FIRST step to discover available tools.
1. Call search_tools with a keyword query (e.g. "github", "browser", "search")
2. Results show namespaced tool names like "server__tool" (e.g. "github__list_repos")
3. Use describe_tool to see the parameters for any interesting tool
4. Use execute_tool to run it with the correct args

EXAMPLE:
  search_tools({"query": "web search"})
  → Returns: [{"name": "exa2__web_search_exa", "server": "exa2", "description": "..."}]

EXAMPLE with limit:
  search_tools({"query": "github", "limit": 5})
  → Returns top 5 matches only

EXAMPLE scoped to server:
  search_tools({"query": "search", "server": "github"})
  → Only searches github tools

TIP: Use broad keywords. The search uses BM25 ranking with token normalization (camelCase, snake_case, kebab-case).`,
      inputSchema: SearchToolsSchema as any,
    },
    {
      name: "describe_tool",
      description: `Show detailed information about a specific tool including its description, parameters schema, and usage examples.

WORKFLOW: Use this AFTER search_tools and BEFORE execute_tool.
1. Call search_tools to find interesting tools
2. Call describe_tool with the exact namespaced name (e.g. "github__search_repositories")
3. Review the schema and examples to understand required parameters
4. Call execute_tool with the correct args object

EXAMPLE:
  describe_tool({"tool": "exa2__web_search_exa"})
  → Returns: {name, server, description, inputSchema, examples: [...]}

TIP: The "examples" field shows sample args objects you can adapt.`,
      inputSchema: DescribeToolSchema as any,
    },
    {
      name: "execute_tool",
      description: `Execute any registered MCP tool by its namespaced name. This is the final step after discovering and understanding a tool.

WORKFLOW: Complete 3-step process to use any backend tool:
  Step 1: search_tools({"query": "keyword"}) → discover tools
  Step 2: describe_tool({"tool": "server__tool_name"}) → see parameters
  Step 3: execute_tool({"tool": "server__tool_name", "args": {...}}) → run it

EXAMPLE - Search the web:
  execute_tool({
    "tool": "exa2__web_search_exa",
    "args": {"query": "latest AI news", "numResults": 5}
  })

EXAMPLE - Search GitHub repos:
  execute_tool({
    "tool": "github__search_repositories",
    "args": {"query": "machine learning stars:>1000", "perPage": 10}
  })

ARGS FORMAT:
  - "tool": string (required) — Namespaced name from search_tools (format: "server__tool")
  - "args": object (optional) — Parameters as a JSON object. Use {} for no args.

IMPORTANT: The args must be a proper object, NOT a JSON string.`,
      inputSchema: ExecuteToolSchema as any,
    },
    {
      name: "list_servers",
      description: `List all configured MCP servers with descriptions, tool counts, and sample tool names — everything comes directly from the servers themselves during MCP initialization.

WORKFLOW: This is the FIRST step to discover available capabilities.
1. Call list_servers() to see all servers with their descriptions and tool counts
2. Pick a server whose purpose matches what you want to do
3. Call browse_server({"server": "name"}) to see ALL its tools grouped by naming pattern
4. Call describe_tool to see any tool's full schema
5. Call execute_tool to run it

EXAMPLE:
  list_servers()
  → Returns: [{name: "github", description: "GitHub API server...", toolCount: 41, sampleTools: ["search_repositories", ...]},
               {name: "exa2", description: "Web search API...", toolCount: 3, sampleTools: ["web_search_exa", ...]}]

TIP: Server descriptions are the server's own words from its MCP initialization handshake.
If a server doesn't provide a description, the tool count and sample tool names still tell you what it does.`,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "browse_server",
      description: `Browse all tools available on one specific MCP server. Tools are grouped by naming pattern (e.g. "search" group for search_*, "create" group for create_*) so you can quickly find what you need.

WORKFLOW: Use this AFTER list_servers and BEFORE describe_tool.
1. Call list_servers() to find a server that matches your intent
2. Call browse_server({"server": "github"}) to see EVERY tool for that server
3. Pick a tool from the group that matches what you need
4. Call describe_tool to see its full schema and examples
5. Call execute_tool to run it

EXAMPLE:
  browse_server({"server": "github"})
  → Returns: {
      server: {name, description, toolCount},
      toolGroups: [
        {pattern: "search", tools: [
          {name: "github__search_repositories", originalName: "search_repositories", description: "Search GitHub..."},
          ...
        ]},
        {pattern: "create", tools: [...]},
        ...
      ]
    }

TIP: Every tool name, description, and grouping comes from the server itself.
You don't need to guess keywords — just read what's available and pick the right tool.`,
      inputSchema: BrowseServerSchema as any,
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
    {
      name: "create_tool",
      description: `Create a reusable shell tool right now. Use this when you find yourself repeating the same multi-step shell pattern, hitting shell escaping/quoting errors repeatedly, or building a pipeline you will call more than once during this session.

The tool becomes immediately callable via execute_tool with the "dynamic__<name>" namespace.

HOW TO USE:
  1. Pick a short, descriptive name (e.g. "ssh_run_script")
  2. Write a description that explains what the tool does
  3. Define the input parameters as a JSON Schema (type: object, properties, required)
  4. Write a shell template implementation using \${paramName} placeholders
     — Values are shell-escaped automatically before substitution

EXAMPLE — Encapsulate the SSH + base64 pattern:
  create_tool({
    name: "ssh_run_script",
    description: "Execute a script on a remote host via SSH using base64 encoding to avoid all shell escaping issues",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Target host" },
        script: { type: "string", description: "Script content to execute" },
        user: { type: "string", default: "root", description: "SSH user" }
      },
      required: ["host", "script"]
    },
    implementation: "echo '\${script}' | base64 | ssh \${user}@\${host} 'base64 -d | bash'"
  })

Then call it:
  execute_tool({ tool: "dynamic__ssh_run_script", args: { host: "10.0.1.5", script: "ls -la" } })

TIP: Use create_tool whenever you catch yourself writing a command that is: (a) repeated more than once, (b) fragile with quoting, (c) a multi-step pipeline. The tool is only available during this gateway session.

IMPORTANT: Call this directly as a gateway tool, NOT via execute_tool. Use execute_tool only for the created tool after it exists.`,
      inputSchema: CreateToolSchema as any,
    },
    {
      name: "list_dynamic_tools",
      description: "List all currently registered dynamic tools created via create_tool. Returns name, description, input schema, and timestamps for each.",
      inputSchema: ListDynamicToolsSchema as any,
    },
    {
      name: "delete_dynamic_tool",
      description: "Delete a dynamic tool by name. Provide the original name (e.g. 'smart_grep') or the namespaced name (e.g. 'dynamic__smart_grep'). Use list_dynamic_tools to see what exists.",
      inputSchema: DeleteDynamicToolSchema as any,
    },
    {
      name: "register_server",
      description: `Register a new MCP server dynamically. The server is immediately available and persisted to the gateway config file.

Use this when you need a server that isn't in the static config. After registration, the server is instantly usable:

  execute_tool({ tool: "my-server__tool_name", args: {...} })

The server starts on-demand (if mode is 'on-demand') when first called.

EXAMPLE — Register a custom MCP server:
  register_server({
    name: "my-llm",
    command: "npx",
    args: ["-y", "@my-org/my-mcp-server"],
    env: { API_KEY: "\${env:MY_API_KEY}" },
    mode: "on-demand",
    idleTimeout: 600,
  })

Available servers are listed by list_servers.`,
      inputSchema: RegisterServerSchema as any,
    },
    {
      name: "unregister_server",
      description: "Remove a server from the gateway config. Kills the server process if running, removes the server from the config file, and makes it unavailable for future tool calls. Use list_servers to see available servers.",
      inputSchema: UnregisterServerSchema as any,
    },
  ];
}

// ── Handler: create_tool ─────────────────────────────────────────────

export function handleCreateTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  implementation: string,
  dynamicRegistry: DynamicToolRegistry,
  force?: boolean,
): { namespacedName: string; originalName: string; description: string; inputSchema: unknown; warnings?: TemplateWarning[] } {
  const entry = dynamicRegistry.register({ name, description, parameters, implementation, force });

  // Run template validation
  const declaredParams = dynamicRegistry.getDeclaredParamNames(entry);
  const warnings = validateTemplate(implementation, declaredParams);

  return {
    namespacedName: entry.namespacedName,
    originalName: entry.originalName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
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
  dynamicRegistry?: DynamicToolRegistry,
  configPath?: string,
): Promise<GatewayToolCallResult | null> {
  switch (name) {
    case "create_tool": {
      const rawName = typeof args.name === "string" ? args.name : "";
      const description = typeof args.description === "string" ? args.description : "";
      const parameters = typeof args.parameters === "object" && args.parameters !== null ? args.parameters as Record<string, unknown> : {};
      const implementation = typeof args.implementation === "string" ? args.implementation : "";
      const force = typeof args.force === "boolean" ? args.force : false;

      if (!rawName || !description || !implementation) {
        return {
          content: [{ type: "text", text: "Missing required field: name, description, parameters, and implementation are all required." }],
          isError: true,
        };
      }

      if (!dynamicRegistry) {
        return {
          content: [{ type: "text", text: "Dynamic tool registry is not available." }],
          isError: true,
        };
      }

      try {
        const result = handleCreateTool(rawName, description, parameters, implementation, dynamicRegistry, force);
        const payload: Record<string, unknown> = {
          status: "created",
          namespacedName: result.namespacedName,
          originalName: result.originalName,
          description: result.description,
          inputSchema: result.inputSchema,
          howToCall: `Use execute_tool({ tool: "${result.namespacedName}", args: {...} })`,
          note: "This tool is only available during this gateway session. It will be lost on restart.",
        };
        if (result.warnings) {
          payload.warnings = result.warnings;
        }
        if (force) {
          payload.status = "updated";
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
    case "list_dynamic_tools": {
      if (!dynamicRegistry) {
        return {
          content: [{ type: "text", text: "Dynamic tool registry not available." }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ tools: dynamicRegistry.list() }) }],
      };
    }
    case "delete_dynamic_tool": {
      const rawName = typeof args.name === "string" ? args.name : "";
      if (!rawName) {
        return {
          content: [{ type: "text", text: "Missing required field: name" }],
          isError: true,
        };
      }
      if (!dynamicRegistry) {
        return {
          content: [{ type: "text", text: "Dynamic tool registry not available." }],
          isError: true,
        };
      }
      // Find by either name format
      const entry = dynamicRegistry.find(rawName);
      if (!entry) {
        return {
          content: [{ type: "text", text: `Tool not found: ${rawName}. Use list_dynamic_tools to see registered tools.` }],
          isError: true,
        };
      }
      dynamicRegistry.remove(entry.namespacedName);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted", name: entry.namespacedName }) }],
      };
    }
    case "register_server": {
      const name = typeof args.name === "string" ? args.name : "";
      const command = typeof args.command === "string" ? args.command : "";
      const rawArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
      const env = typeof args.env === "object" && args.env !== null ? args.env as Record<string, string> : {};
      const mode: "persistent" | "on-demand" = args.mode === "persistent" ? "persistent" : "on-demand";
      const idleTimeout = typeof args.idleTimeout === "number" ? args.idleTimeout : 300;

      if (!name || !command) {
        return {
          content: [{ type: "text", text: "Missing required field: name and command are required." }],
          isError: true,
        };
      }

      if (config.servers.some((s) => s.name === name)) {
        return {
          content: [{ type: "text", text: `Server "${name}" already exists. Delete it first or choose another name.` }],
          isError: true,
        };
      }

      const newServer = {
        name,
        command,
        args: rawArgs,
        env,
        mode,
        idleTimeout,
        disabled: false,
      };

      config.servers.push(newServer);

      // Persist to disk
      if (configPath) {
        try {
          const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
          onDisk.servers = config.servers;
          await writeFile(configPath, JSON.stringify(onDisk, null, 2));
        } catch {
          // Best-effort — server is registered in-memory either way
        }
      }

      // Auto-start persistent servers — await with timeout, report actual outcome
      let autoStarted = false;
      let autoStartError: string | undefined;
      if (mode === "persistent") {
        try {
          await lifecycle.spawn(name, newServer, spawnLock);
          autoStarted = true;
        } catch (e) {
          autoStartError = (e as Error).message;
        }
      }

      const response: Record<string, unknown> = {
        status: "registered",
        name,
        mode,
      };
      if (mode === "persistent") {
        response.autoStarted = autoStarted;
        if (autoStartError) response.autoStartError = autoStartError;
      }
      response.note = "Server is live now. Hot-reload will persist it across gateway restarts.";

      return {
        content: [{
          type: "text",
          text: JSON.stringify(response),
        }],
      };
    }
    case "unregister_server": {
      const singleName = typeof args.name === "string" ? args.name : "";
      const batchNames = Array.isArray(args.names) ? (args.names as string[]).filter((n): n is string => typeof n === "string") : [];
      const targets = singleName ? [singleName] : batchNames;

      if (targets.length === 0) {
        return {
          content: [{ type: "text", text: "Missing required field: name or names" }],
          isError: true,
        };
      }

      const removed: string[] = [];
      const notFound: string[] = [];

      for (const target of targets) {
        const idx = config.servers.findIndex((s) => s.name === target);
        if (idx === -1) {
          notFound.push(target);
          continue;
        }
        await lifecycle.kill(target);
        config.servers.splice(idx, 1);
        removed.push(target);
      }

      // Persist to disk
      if (configPath && removed.length > 0) {
        try {
          const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
          onDisk.servers = config.servers;
          await writeFile(configPath, JSON.stringify(onDisk, null, 2));
        } catch {
          // Best-effort
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "removed",
            removed,
            notFound: notFound.length > 0 ? notFound : undefined,
            note: "Server config removed. Running processes killed.",
          }),
        }],
      };
    }
    case "search_tools": {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const server = typeof args.server === "string" ? args.server : undefined;
      return {
        content: [{
          type: "text",
          text: JSON.stringify(handleSearchTools(query, registry, healthTracker, limit, server, dynamicRegistry)),
        }],
      };
    }
    case "describe_tool": {
      const toolName = typeof args.tool === "string" ? args.tool : "";
      try {
        const result = handleDescribeTool(toolName, registry, healthTracker);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
    }
    case "list_servers": {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(handleListServers(config, lifecycle, healthTracker, registry)),
        }],
      };
    }
    case "browse_server": {
      const serverName = typeof args.server === "string" ? args.server : "";
      try {
        const result = handleBrowseServer(serverName, registry, healthTracker);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
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
    case "execute_tool": {
      const toolName = typeof args.tool === "string" ? args.tool : "";

      // Accept args as either an object or a JSON string (backward compatible)
      let toolArgs: Record<string, unknown> = {};
      if (args.args && typeof args.args === "object" && !Array.isArray(args.args)) {
        toolArgs = args.args as Record<string, unknown>;
      } else if (typeof args.args === "string") {
        try {
          toolArgs = JSON.parse(args.args);
        } catch {
          return {
            content: [{ type: "text", text: "Invalid args: must be a valid JSON object or JSON string" }],
            isError: true,
          };
        }
      }

      // Parse server__tool namespace
      const sepIdx = toolName.indexOf("__");
      if (sepIdx === -1) {
        return {
          content: [{ type: "text", text: `Invalid tool name: ${toolName} (expected server__tool format)` }],
          isError: true,
        };
      }
      const serverName = toolName.slice(0, sepIdx);
      const originalToolName = toolName.slice(sepIdx + 2);

      // ── Dynamic tool routing ────────────────────────────────────────
      if (serverName === "dynamic" && dynamicRegistry) {
        const toolEntry = dynamicRegistry.get(toolName);
        if (toolEntry) {
          try {
            // Strip cwd from args — it's used for execution directory, not template
            const { cwd: execCwd, ...cleanArgs } = toolArgs as Record<string, unknown>;
            const paramTypes = dynamicRegistry.getParamTypes(toolEntry);
            const command = resolveTemplate(toolEntry.implementation, cleanArgs, { paramTypes });

            const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
              const child = exec(
                command,
                {
                  shell: "/bin/bash",
                  timeout: 30_000,
                  maxBuffer: 10 * 1024 * 1024,
                  cwd: typeof execCwd === "string" ? execCwd : undefined,
                },
                (error, stdout, stderr) => {
                  resolve({
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                    exitCode: error?.code ?? 0,
                  });
                },
              );
            });

            const outputParts: string[] = [];
            if (result.stdout) outputParts.push(result.stdout);
            if (result.stderr) outputParts.push("stderr: " + result.stderr);
            const output = outputParts.join("\n");
            if (result.exitCode !== 0) {
              return {
                content: [{ type: "text", text: output || `Exit code: ${result.exitCode}` }],
                isError: true,
              };
            }
            return {
              content: [{ type: "text", text: output || `(exit code: 0)` }],
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Dynamic tool execution failed: ${(error as Error).message}` }],
              isError: true,
            };
          }
        }
        // Tool name wasn't found — give agent guidance
        return {
          content: [{ type: "text", text: `Dynamic tool not found: ${toolName}. Use list_dynamic_tools to see what's registered.` }],
          isError: true,
        };
      }

      const serverConfig = config.servers.find((s) => s.name === serverName);
      if (!serverConfig) {
        return {
          content: [{ type: "text", text: `Unknown server: ${serverName}` }],
          isError: true,
        };
      }

      // --- Smart Argument Mapping ---
      // If the tool is in our registry, try to reconcile provided args with the schema.
      const toolEntry = registry.tools.find((t) => t.name === toolName);
      // Capture for use in all error/success paths below (block-scoped inside if)
      let registryToolEntry: typeof toolEntry | undefined;
      const appliedMappings: Array<{ from: string; to: string }> = [];
      if (toolEntry && toolEntry.inputSchema && typeof toolEntry.inputSchema === "object") {
        const schema = toolEntry.inputSchema as any;
        const properties = schema.properties || {};
        const required = schema.required || [];
        const expectedKeys = Object.keys(properties);

        // 1. Alias mapping: if user sent 'q' but tool wants 'query'
        const commonAliases: Record<string, string[]> = {
          q: ["query", "search", "text", "input"],
          query: ["q", "search", "text", "input"],
          input: ["text", "data", "value"],
          content: ["text", "body", "data"],
          message: ["text", "body", "content", "description"],
          description: ["text", "body", "content", "message", "desc"],
          limit: ["numResults", "maxResults", "perPage", "count", "n"],
          numResults: ["limit", "maxResults", "count", "perPage"],
          maxResults: ["limit", "numResults", "count", "n"],
          count: ["limit", "numResults", "maxResults", "n", "perPage"],
          n: ["count", "limit", "numResults"],
          perPage: ["limit", "count", "numResults"],
          repo: ["repository", "name", "repoName"],
          repository: ["repo", "name", "repoName"],
          owner: ["org", "user", "username"],
          org: ["owner", "user"],
          path: ["file", "filepath", "filePath", "dir", "directory"],
          branch: ["ref", "tag"],
        };

        for (const [expected, aliases] of Object.entries(commonAliases)) {
          if (expectedKeys.includes(expected) && !toolArgs[expected]) {
            const foundAlias = aliases.find((alias) => toolArgs[alias]);
            if (foundAlias) {
              toolArgs[expected] = toolArgs[foundAlias];
              appliedMappings.push({ from: foundAlias, to: expected });
            }
          }
        }

        // 2. Single-parameter auto-mapping: if tool has only ONE required param (or one total param)
        // and user sent exactly one param with a different name.
        const providedKeys = Object.keys(toolArgs);
        if (providedKeys.length === 1 && expectedKeys.length === 1) {
          const expectedKey = expectedKeys[0];
          const providedKey = providedKeys[0];
          if (expectedKey !== providedKey && !toolArgs[expectedKey]) {
            toolArgs[expectedKey] = toolArgs[providedKey];
            appliedMappings.push({ from: providedKey, to: expectedKey });
          }
        } else if (providedKeys.length === 1 && required.length === 1) {
          const reqKey = required[0];
          if (!toolArgs[reqKey]) {
            toolArgs[reqKey] = toolArgs[providedKeys[0]];
            appliedMappings.push({ from: providedKeys[0], to: reqKey });
          }
        }

        // Persist for use in error/success paths below
        registryToolEntry = toolEntry;
      }

      if (!healthTracker.isHealthy(serverName)) {
        const unhealthyPayload: Record<string, unknown> = {
          error: `Server ${serverName} is unhealthy`,
          server: serverName,
          retryable: false,
        };
        if (registryToolEntry?.inputSchema && typeof registryToolEntry.inputSchema === "object") {
          unhealthyPayload.expectedSchema = registryToolEntry.inputSchema;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(unhealthyPayload) }],
          isError: true,
        };
      }
      if (serverConfig.disabled) {
        const disabledPayload: Record<string, unknown> = {
          error: `Server ${serverName} is disabled`,
          server: serverName,
          retryable: false,
        };
        if (registryToolEntry?.inputSchema && typeof registryToolEntry.inputSchema === "object") {
          disabledPayload.expectedSchema = registryToolEntry.inputSchema;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(disabledPayload) }],
          isError: true,
        };
      }

      try {
        const { client } = await lifecycle.spawn(serverName, serverConfig, spawnLock);
        const result = await (client as any).callTool(
          { name: originalToolName, arguments: toolArgs },
          { timeout: 10000 },
        );
        lifecycle.trackActivity(serverName);
        healthTracker.recordSuccess(serverName);

        // Append mapping hints so the agent learns correct param names
        const content = [...(result.content ?? [])];
        if (appliedMappings.length > 0) {
          content.push({
            type: "text",
            text: JSON.stringify({ _mappingHints: appliedMappings }),
          });
        }
        return { content };
      } catch (error) {
        const err = error as Error & { code?: string };
        healthTracker.recordFailure(serverName, err);

        const serverHealth = healthTracker.getHealth(serverName);

        // Build structured error response — include schema for agent self-correction
        const errorPayload: Record<string, unknown> = {
          error: err.message,
          code: err.code,
          server: serverName,
          retryable: serverHealth ? serverHealth.consecutiveFailures < 3 : true,
        };

        // Include the tool's schema so the agent can self-correct args without
        // a separate describe_tool call
        if (registryToolEntry?.inputSchema && typeof registryToolEntry.inputSchema === "object") {
          errorPayload.expectedSchema = registryToolEntry.inputSchema;
        }

        return {
          content: [{ type: "text", text: JSON.stringify(errorPayload) }],
          isError: true,
        };
      }
    }
    default:
      return null; // Not a gateway tool — proxy should fall through to upstream
  }
}
