# MCP Gateway

Single-point proxy for Model Context Protocol servers.

## What it does

MCP Gateway sits between an AI agent and multiple backend MCP servers. The agent connects to one endpoint. The gateway routes each tool call to the right backend server, handles lifecycle, and reports results back. You get one URL to configure instead of ten.

The gateway comes with 10 servers pre-configured: chrome-devtools, context7, exa2, firebase, framer, github, gitlab, pencil, playwright, and subtext. Each one spawns on demand when its tools are first called and shuts down after a configurable idle timeout. Persistent mode is also available for servers that should stay running.

Key features include on-demand spawning with idle timeout, persistent mode for always-on servers, health tracking with exponential backoff, crash recovery, config hot-reload via filesystem watcher, and a transparent proxy that handles tools/list and tools/call with server__tool namespacing.

The gateway exposes a single SSE endpoint at /sse that agents connect to. All backend servers appear as namespaced tools. For example, a tool called list_repos on the github server becomes github__list_repos. The gateway also exposes its own REST API at /api/* for health checks, server management, tool discovery, and event streaming.

## Architecture

Each source file has a single responsibility:

- `src/index.ts` -- Entry point. Loads config, starts the HTTP server, registers MCP protocol handlers and API routes.
- `src/mcp-server.ts` -- Creates the McpServer instance and ties it to a raw Node.js HTTP server via WebStandardStreamableHTTPServerTransport.
- `src/api.ts` -- REST API for health checks, server listing, server management (start/stop/restart), tool search, and SSE event streams.
- `src/proxy.ts` -- MCP protocol proxy that intercepts tools/list and tools/call, merges gateway-native tools with registry tools, and routes namespaced calls (server__tool) to the correct backend.
- `src/tools.ts` -- Gateway-native tool definitions and dispatch: search_tools, list_servers, server_status, manage_server.
- `src/lifecycle.ts` -- Server lifecycle manager. Spawns child processes, tracks activity timestamps, kills idle on-demand servers, and handles graceful shutdown.
- `src/hot-reload.ts` -- Filesystem watcher using chokidar. Applies config diffs live without restarting the gateway.
- `src/recovery.ts` -- HealthTracker with exponential backoff. Marks servers unhealthy after 3 consecutive failures, then retries with increasing delays up to 30 seconds.
- `src/spawn-lock.ts` -- Async mutex that prevents concurrent spawn attempts for the same server name.
- `src/registry.ts` -- Disk-cached tool catalog. Persists discovered tools to disk with a 1-hour TTL, supports search, stale detection via SHA-256 version hashes.
- `src/config.ts` -- Config loader. Reads JSON config with `${VAR}` env var resolution, supports `${cmd:...}` shell substitution, validates with Zod.
- `src/types.ts` -- Shared TypeScript interfaces and enums for ServerConfig, GatewayConfig, ToolEntry, and ServerStatus.

## Install

```bash
git clone https://github.com/samanvayayagsen/mcp-gateway.git
cd mcp-gateway && bun install
```

To run the gateway as a launchd service on macOS:

```bash
cp config/com.mcp.gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mcp.gateway.plist
```

## Configure

The gateway reads its configuration from the path in the `MCP_GATEWAY_CONFIG` environment variable. If the variable is not set, it defaults to `~/.sisyphus/mcp-gateway-config.json`.

Example config file:

```json
{
  "port": 8000,
  "host": "127.0.0.1",
  "servers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${HOME}/.github-token" },
      "mode": "on-demand",
      "idleTimeout": 300,
      "disabled": false
    }
  ]
}
```

Each server has a mode setting:

- `persistent` -- The server starts when the gateway starts and runs until the gateway stops.
- `on-demand` -- The server spawns on the first tool call and is killed after `idleTimeout` seconds of inactivity.

## Run

```bash
bun start
```

For development with automatic config reload:

```bash
bun dev
```

To run tests:

```bash
bun test
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Gateway status and server counts |
| `/api/servers` | GET | List all configured servers with status |
| `/api/servers/:name` | GET | Details for a specific server |
| `/api/servers/:name/start` | POST | Start a stopped server |
| `/api/servers/:name/stop` | POST | Stop a running server |
| `/api/servers/:name/restart` | POST | Restart a server |
| `/api/tools` | GET | List all cached tools (namespaced) |
| `/api/tools?q=` | GET | Search cached tools by name or description |
| `/api/events` | GET | SSE stream for gateway events |

## Agent Config

To point an agent at the gateway, add this to the agent's MCP configuration:

```json
{
  "mcpServers": {
    "mcp-gateway": {
      "type": "sse",
      "url": "http://localhost:8000/sse"
    }
  }
}
```

## Using the Gateway (3-Step Workflow)

The gateway exposes **6 native tools**. The 3 most important ones follow a discover → understand → execute workflow:

### Step 1: Discover Tools with `search_tools`

Search for available backend tools by keyword:

```json
{
  "name": "search_tools",
  "arguments": {
    "query": "github repository"
  }
}
```

Returns tools with namespaced names like `github__search_repositories`, `github__list_issues`.

### Step 2: Understand Parameters with `describe_tool`

Get full schema and examples for any tool:

```json
{
  "name": "describe_tool",
  "arguments": {
    "tool": "github__search_repositories"
  }
}
```

Returns the description, input schema, and auto-generated usage examples.

### Step 3: Execute with `execute_tool`

Run the tool with a proper args object:

```json
{
  "name": "execute_tool",
  "arguments": {
    "tool": "github__search_repositories",
    "args": {
      "query": "machine learning stars:>1000 language:python",
      "perPage": 10
    }
  }
}
```

**Important**: `args` must be an object, not a JSON string.

### Complete Example

```
search_tools({"query": "web search"})
→ Returns: [{"name": "exa2__web_search_exa", ...}]

describe_tool({"tool": "exa2__web_search_exa"})
→ Returns: {description, inputSchema, examples: [{"query": "...", "numResults": 10}]}

execute_tool({
  "tool": "exa2__web_search_exa",
  "args": {"query": "latest AI news", "numResults": 5}
})
→ Returns: search results!
```

### All Gateway-Native Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `search_tools` | Find tools by keyword | **Step 1** — Always start here |
| `describe_tool` | Show schema + examples | **Step 2** — Before executing |
| `execute_tool` | Run any backend tool | **Step 3** — Final execution |
| `list_servers` | List configured servers | Management |
| `server_status` | Check server health | Debugging |
| `manage_server` | Enable/disable/restart | Administration |

## Exposing to Public Internet (for Grok, etc.)

To connect Grok or other cloud-based agents to your local MCP Gateway, you can use the built-in exposure script. This script automatically handles:
1. **Security**: Generates a unique API token and enforces it via Bearer authentication.
2. **Tunneling**: Starts an `ngrok` tunnel to create a public HTTPS URL.
3. **Execution**: Starts the gateway and the tunnel simultaneously.

### Usage

```bash
bun run expose
```

The script will output a **Public URL** and a **Security Token**. 

### Connecting to Grok
1. Go to Grok Settings -> MCP Servers.
2. Click **Add Server**.
3. Set Type to **SSE**.
4. Paste the **Public URL** (ending in `/sse`) into the URL field.
5. In the Headers field, add: `{"Authorization": "Bearer YOUR_TOKEN"}`.

### Open Mode (No Authentication)

If you are in a safe environment and want to skip the token entirely, you can use:

```bash
bun run expose:open
```

This will still use a random port and `ngrok`, but the gateway will **not** require any authentication headers. **Use this with caution.**

## Adding Servers

Open your config file and add a new entry to the `servers` array. The gateway detects config file changes automatically and applies the diff without restarting. To disable a server without removing it from the config, set `"disabled": true`.

```json
{
  "name": "slack",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-slack"],
  "env": { "SLACK_TOKEN": "xoxb-..." },
  "mode": "on-demand",
  "idleTimeout": 300,
  "disabled": false
}
```

## License

MIT -- see the LICENSE file.
