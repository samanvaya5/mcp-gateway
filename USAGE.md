# MCP Gateway — Usage Guide

## Quick Start (3-Step Workflow)

The gateway uses a **discover → understand → execute** pattern. Every tool interaction follows these 3 steps:

```
Step 1: search_tools    → Find tools by keyword
Step 2: describe_tool   → See parameters and examples
Step 3: execute_tool    → Run the tool with correct args
```

---

## Step 1: search_tools — Discover Available Tools

Find backend MCP tools by searching with keywords.

**Parameters:**
- `query` (string, required) — Search terms to match tool names and descriptions

**Example:**
```json
{
  "name": "search_tools",
  "arguments": {
    "query": "github repository"
  }
}
```

**Returns:**
```json
{
  "results": [
    {
      "name": "github__search_repositories",
      "server": "github",
      "description": "Find GitHub repositories by name, description, readme...",
      "inputSchema": { ... },
      "serverStatus": "healthy"
    },
    {
      "name": "github__list_issues",
      "server": "github",
      "description": "List issues in a repository...",
      "inputSchema": { ... },
      "serverStatus": "healthy"
    }
  ]
}
```

**Tips:**
- Use broad keywords ("web", "search", "browser", "git")
- Results are filtered to healthy servers only
- Tool names use `server__tool` format (double underscore)

---

## Step 2: describe_tool — Understand Tool Parameters

Get detailed information about a specific tool before executing it.

**Parameters:**
- `tool` (string, required) — Full namespaced tool name from search_tools (e.g. "github__search_repositories")

**Example:**
```json
{
  "name": "describe_tool",
  "arguments": {
    "tool": "github__search_repositories"
  }
}
```

**Returns:**
```json
{
  "name": "github__search_repositories",
  "server": "github",
  "originalName": "search_repositories",
  "description": "Find GitHub repositories by name, description...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query..." },
      "perPage": { "type": "number", "description": "Results per page" },
      "sort": { "type": "string", "enum": ["stars", "forks", "updated"] }
    },
    "required": ["query"]
  },
  "serverStatus": "healthy",
  "examples": [
    "{\"query\":\"example search query\"}",
    "{\"query\":\"example search query\",\"perPage\":10,\"sort\":\"stars\"}"
  ]
}
```

**Tips:**
- The `examples` field shows sample args you can adapt
- `inputSchema` shows which parameters are required vs optional
- Check `serverStatus` — "unhealthy" means the server is temporarily down

---

## Step 3: execute_tool — Run the Tool

Execute any discovered tool with the correct parameters.

**Parameters:**
- `tool` (string, required) — Namespaced tool name (format: `server__tool`)
- `args` (object, optional) — Parameters as a JSON object. Use `{}` or omit for no args.

**Important:** `args` must be a **proper object**, NOT a JSON string.

**Example — Search GitHub:**
```json
{
  "name": "execute_tool",
  "arguments": {
    "tool": "github__search_repositories",
    "args": {
      "query": "machine learning stars:>1000 language:python",
      "perPage": 10,
      "sort": "stars"
    }
  }
}
```

**Example — Web search with Exa:**
```json
{
  "name": "execute_tool",
  "arguments": {
    "tool": "exa2__web_search_exa",
    "args": {
      "query": "latest AI coding agent news",
      "numResults": 5
    }
  }
}
```

**Example — No arguments needed:**
```json
{
  "name": "execute_tool",
  "arguments": {
    "tool": "github__get_authenticated_user",
    "args": {}
  }
}
```

**Tips:**
- Always use `describe_tool` first to see the correct parameter names
- The gateway auto-spawns the backend server if it's not running
- On-demand servers auto-shutdown after idle timeout

---

## Common Patterns

### Pattern 1: Find and Use a Tool

```
1. search_tools({"query": "browser click"})
   → Found: playwright__browser_click

2. describe_tool({"tool": "playwright__browser_click"})
   → Schema shows: url (required), selector (required)

3. execute_tool({
     "tool": "playwright__browser_click",
     "args": {
       "url": "https://example.com",
       "selector": "button.submit"
     }
   })
```

### Pattern 2: Explore a Server's Tools

```
1. search_tools({"query": "github"})
   → Returns all github__* tools

2. describe_tool({"tool": "github__create_issue"})
   → See how to create an issue

3. execute_tool({
     "tool": "github__create_issue",
     "args": {
       "owner": "myorg",
       "repo": "myrepo",
       "title": "Bug: ...",
       "body": "Description..."
     }
   })
```

### Pattern 3: Chain Multiple Tools

```
1. execute_tool({
     "tool": "exa2__web_search_exa",
     "args": {"query": "React best practices 2025", "numResults": 3}
   })
   → Returns URLs

2. execute_tool({
     "tool": "exa2__web_fetch_exa",
     "args": {"urls": ["https://...", "https://..."]}
   })
   → Returns full content of those pages
```

---

## Troubleshooting

### "Tool not found" Error
- Make sure you're using the **namespaced** name: `server__tool` (double underscore)
- Use `search_tools` to find the exact name
- Check `list_servers` to see if the server is configured

### "Invalid args" Error
- Use `describe_tool` to see the correct parameter names and types
- Ensure required parameters are included
- `args` must be an object, not a string

### "Server unhealthy" Error
- The backend server failed 3+ times and is temporarily disabled
- Wait 30 seconds for auto-retry, or use `manage_server` to restart it
- Check `server_status` for details

### "Server disabled" Error
- The server is disabled in config
- Use `manage_server({"server": "name", "action": "enable"})` to enable it

---

## Management Tools

### list_servers — See All Servers
```json
{
  "name": "list_servers",
  "arguments": {}
}
```
Returns all configured servers with status (running, stopped, unhealthy, disabled).

### server_status — Check One Server
```json
{
  "name": "server_status",
  "arguments": {
    "server": "github"
  }
}
```
Returns detailed status: PID, uptime, last activity, health.

### manage_server — Control Servers
```json
{
  "name": "manage_server",
  "arguments": {
    "server": "github",
    "action": "restart"
  }
}
```
Actions: `enable`, `disable`, `restart`

---

## REST API

The gateway also exposes a REST API for external integration:

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Gateway status |
| `GET /api/servers` | List all servers |
| `GET /api/servers/:name` | Server details |
| `POST /api/servers/:name/start` | Start server |
| `POST /api/servers/:name/stop` | Stop server |
| `POST /api/servers/:name/restart` | Restart server |
| `GET /api/tools?q=keyword` | Search tools |
| `GET /api/events` | SSE event stream |

---

## Namespacing Convention

All backend tools are namespaced as `server__tool`:

| Backend Server | Original Tool | Namespaced Name |
|---------------|---------------|-----------------|
| github | search_repositories | `github__search_repositories` |
| exa2 | web_search_exa | `exa2__web_search_exa` |
| playwright | browser_click | `playwright__browser_click` |
| context7 | query_docs | `context7__query_docs` |

The double underscore (`__`) separates server name from tool name.
