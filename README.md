# MCP Gateway

[![CI](https://github.com/samanvaya5/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/samanvaya5/mcp-gateway/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-gateway?color=blue)](https://www.npmjs.com/package/mcp-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-≥1.0-black?logo=bun)](https://bun.sh)

**Single-point proxy for Model Context Protocol servers.** One SSE endpoint.
Twelve gateway-native tools. Unlimited backend servers.

Stop wiring every AI agent to a different MCP server URL. Point them at one
gateway and get unified tool discovery, on-demand lifecycle, crash recovery,
and config hot-reload — all behind a single port.

```bash
npm install -g mcp-gateway
mcp-gateway
# Agent connects to http://localhost:8000/sse
```

## Features

- **12 gateway-native tools** — `search_tools`, `describe_tool`, `execute_tool`,
  `list_servers`, `browse_server`, `server_status`, `manage_server`,
  `create_tool`, `list_dynamic_tools`, `delete_dynamic_tool`,
  `register_server`, `unregister_server`
- **BM25 search** — Token-aware ranking over camelCase/snake_case/kebab-case names
- **On-demand spawning** — Backend servers start when first called, die when idle
- **Persistent mode** — Always-on servers that never idle-kill
- **Health tracking** — Exponential backoff crash recovery (1s → 2s → 4s → ... → 30s)
- **Auth** — Optional Bearer token via `MCP_GATEWAY_TOKEN` env var
- **Config hot-reload** — `chokidar` watches your config file, applies diffs live
- **Dynamic tools** — Create reusable shell tools at runtime with `${param}` templates
- **ngrok expose** — `bun run expose` generates a public URL + auth token for Grok/cloud agents
- **3-step workflow** — Discover → Describe → Execute (inspired by how agents actually think)

## Quick Start

### Install & Run

```bash
# Using npm (recommended)
npm install -g mcp-gateway
mcp-gateway

# Or from source
git clone https://github.com/samanvaya5/mcp-gateway.git
cd mcp-gateway && bun install
bun start
```

### Connect an Agent

Add this to your agent's MCP configuration:

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

That's it. The agent now has access to every backend server behind the gateway.

## How It Works

```
┌─────────────┐     /sse (SSE)     ┌─────────────────────────────┐
│             │ ──────────────────→ │                             │
│  AI Agent   │                    │       MCP Gateway            │
│  (Claude,   │ ←────────────────── │  ┌───────────────────────┐  │
│   Grok...)  │   tools/list,       │  │   12 Native Tools     │  │
│             │   tools/call        │  │  (search, describe,   │  │
└─────────────┘                     │  │   execute, manage...)  │  │
                                    │  └───────────────────────┘  │
                                    │           │                 │
                                    │     ┌─────┴──────┐          │
                                    │     │  Proxy +   │          │
                                    │     │  Registry  │          │
                                    │     │  (BM25,    │          │
                                    │     │   caching) │          │
                                    │     └─────┬──────┘          │
                                    │           │                 │
                                    │     ┌─────┴──────────────┐  │
                                    │     │  Lifecycle Manager  │  │
                                    │     │  (spawn, kill,     │  │
                                    │     │   health, recovery) │  │
                                    │     └─────┬──────────────┘  │
                                    └────────────┼────────────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────┐
                    │                            │                    │
               ┌────▼────┐                ┌──────▼──────┐     ┌─────▼─────┐
               │ GitHub  │                │    Exa2     │     │ Playwright│
               │ MCP Srv │                │  Web Search │     │  MCP Srv  │
               └─────────┘                └─────────────┘     └───────────┘
                    │                            │                    │
              (spawns on                    (spawns on           (spawns on
               demand)                       demand)              startup)
```

The gateway connects to a single SSE endpoint (`/sse`). When an agent calls a
tool, the proxy extracts the server prefix from the namespaced tool name
(e.g., `github__search_repositories`), spawns the backend if needed, and routes
the call. Results flow back through the same connection.

## Configuration

The gateway reads from `MCP_GATEWAY_CONFIG` (defaults to
`~/.sisyphus/mcp-gateway-config.json`):

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

### Server Modes

| Mode | Behavior |
|------|----------|
| `persistent` | Starts with gateway, runs until shutdown |
| `on-demand` | Spawns on first tool call, killed after `idleTimeout` seconds idle |

### Environment Variables

| Variable | Effect |
|----------|--------|
| `MCP_GATEWAY_CONFIG` | Path to config file |
| `MCP_GATEWAY_TOKEN` | Enable Bearer auth (all endpoints except `/api/health`) |
| `MCP_GATEWAY_NO_AUTH` | Set to `true` to disable auth even if token is set |
| `PORT` | Override config port |
| `HOST` | Override config host |

## Using the Gateway (3-Step Workflow)

The gateway's native tools follow a **discover → understand → execute** workflow
designed for how AI agents think:

### Step 1: Discover

```json
{
  "name": "search_tools",
  "arguments": { "query": "github repository" }
}
```

Returns namespaced tool names like `github__search_repositories`.

### Step 2: Describe

```json
{
  "name": "describe_tool",
  "arguments": { "tool": "github__search_repositories" }
}
```

Returns full schema, description, and auto-generated usage examples.

### Step 3: Execute

```json
{
  "name": "execute_tool",
  "arguments": {
    "tool": "github__search_repositories",
    "args": { "query": "machine learning stars:>1000", "perPage": 10 }
  }
}
```

### All 12 Gateway-Native Tools

| Tool | Purpose | When to Reach For It |
|------|---------|---------------------|
| `search_tools` | Find backend tools by keyword | **Always first** |
| `describe_tool` | Show schema + examples | Before executing |
| `execute_tool` | Run any backend tool | Final step |
| `list_servers` | List configured servers | Management |
| `browse_server` | List all tools on one server | Exploring a server |
| `server_status` | Check server health + diagnostics | Debugging |
| `manage_server` | Enable/disable/restart servers | Administration |
| `create_tool` | Create a reusable shell tool | Ad-hoc automation |
| `list_dynamic_tools` | List runtime-created tools | Management |
| `delete_dynamic_tool` | Remove a dynamic tool | Cleanup |
| `register_server` | Add a new backend server at runtime | Dynamic config |
| `unregister_server` | Remove a backend server | Cleanup |

## Exposing to Cloud Agents (Grok, etc.)

```bash
# Secure mode — generates random token + ngrok URL
bun run expose

# Open mode — no auth (trusted networks only)
bun run expose:open
```

The script prints a public URL and token. In Grok (or any SSE-compatible agent):

1. Settings → MCP Servers → Add Server
2. Type: **SSE**, URL: the public URL ending in `/sse`
3. Headers: `{"Authorization": "Bearer YOUR_TOKEN"}`

## Architecture

```
src/
├── index.ts           Entry point — HTTP server, MCP handlers, API routes
├── config.ts          Config loader (JSON + ${VAR} + ${cmd:...} substitution)
├── types.ts           Shared TypeScript interfaces
├── mcp-server.ts      MCP protocol server (McpServer + SSE transport)
├── proxy.ts           MCP proxy — tools/list, tools/call with namespace routing
├── tools.ts           12 gateway-native tool definitions and dispatch
├── api.ts             REST API routes (/api/health, /api/servers, etc.)
├── lifecycle.ts       Server lifecycle — spawn, kill, idle tracking
├── registry.ts        Disk-cached tool catalog (BM25 search, SHA-256 versioning)
├── bm25.ts            BM25 full-text search tokenizer and ranker
├── dynamic-tools.ts   Runtime shell tool creation (${param} templates)
├── hot-reload.ts      Config file watcher (chokidar, zero-downtime diffs)
├── recovery.ts        Health tracker with exponential backoff
└── spawn-lock.ts      Async mutex — prevents concurrent spawns of same server
```

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Gateway status, server counts, uptime |
| `/api/servers` | GET | All servers with status (running/stopped/unhealthy/disabled) |
| `/api/servers/:name` | GET | Server details, process info, health diagnostics |
| `/api/servers/:name/start` | POST | Start a stopped server |
| `/api/servers/:name/stop` | POST | Stop a running server |
| `/api/servers/:name/restart` | POST | Restart (kill + spawn) |
| `/api/tools` | GET | All cached tools (namespaced) |
| `/api/tools?q=` | GET | Search cached tools |
| `/api/events` | GET | SSE stream for gateway events |

## Tests

```bash
bun test                      # 156 tests across 15 files
bun test --watch              # Watch mode
bun test --coverage           # Coverage report
```

Tests run automatically on every push via GitHub Actions (Bun v1.0, v1.1, v1.2).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, project
structure, and pull request guidelines. All contributions are welcome.

## License

MIT — see the [LICENSE](LICENSE) file.
