# Contributing to MCP Gateway

Thanks for your interest in MCP Gateway! This is a small but ambitious project —
a single-point proxy that routes AI agent MCP tool calls to 10+ backend servers.
We welcome contributions of all kinds: bug reports, feature requests, docs,
tests, and code.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [What We're Building](#what-were-building)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Release Process](#release-process)

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating, you agree to uphold its standards.

## What We're Building

MCP Gateway sits between an AI agent and multiple backend MCP servers. The agent
connects to one SSE endpoint, and the gateway routes each tool call to the right
backend server. Key design goals:

- **Zero-config for agents**: One URL to configure instead of ten
- **On-demand servers**: Backends spawn when first called, die when idle
- **Resilient**: Health tracking, exponential backoff, automatic crash recovery
- **Hot-reloadable**: Config changes apply without restarting the gateway
- **Extensible**: Add new backend servers by editing the config file

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0 or later
- A GitHub account (for contributing)

### Setup

```bash
git clone https://github.com/samanvaya5/mcp-gateway.git
cd mcp-gateway
bun install
bun test          # Run the test suite
bun start         # Start the gateway on port 8000
```

## Development Workflow

### Branch Strategy

- `main` is the stable branch. All changes land via pull request.
- Create feature branches off `main`.
- Use conventional commit messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

### Running in Dev Mode

```bash
bun dev    # Starts with --watch for automatic reload on file changes
```

### Adding a New Backend Server

1. Add the server to your local config file (`~/.sisyphus/mcp-gateway-config.json`).
2. Verify it works: `curl http://localhost:8000/api/health`
3. If the server uses static tool definitions, add them to the test fixtures.

### Adding a Gateway-Native Tool

Gateway-native tools live in `src/tools.ts`. Each tool is an MCP tool definition
with a `name`, `description`, `inputSchema`, and a handler function. If the tool
manages server lifecycle, wire it through the proxy in `src/proxy.ts`.

## Project Structure

```
mcp-gateway/
├── src/                  # Source code
│   ├── index.ts          # Entry point — HTTP server, MCP handlers, API routes
│   ├── config.ts         # Config loader (JSON + env var + cmd substitution)
│   ├── types.ts          # Shared TypeScript types
│   ├── mcp-server.ts     # MCP protocol server (McpServer + SSE transport)
│   ├── proxy.ts          # MCP protocol proxy (tools/list, tools/call routing)
│   ├── tools.ts          # Gateway-native tool definitions and dispatch
│   ├── api.ts            # REST API routes (/api/*)
│   ├── lifecycle.ts      # Server lifecycle (spawn, kill, idle tracking)
│   ├── registry.ts       # Disk-cached tool catalog with BM25 search
│   ├── bm25.ts           # BM25 full-text search tokenizer and ranker
│   ├── dynamic-tools.ts  # Runtime shell tool creation
│   ├── hot-reload.ts     # Config file watcher (chokidar)
│   ├── recovery.ts       # Health tracker with exponential backoff
│   └── spawn-lock.ts     # Async mutex for concurrent spawn prevention
├── tests/                # Test suite (Bun test)
│   ├── auth.test.ts
│   ├── bm25.test.ts
│   ├── config.test.ts
│   ├── e2e.test.ts
│   ├── hot-reload.test.ts
│   ├── lifecycle.test.ts
│   ├── mcp-server.test.ts
│   ├── migrate-config.test.ts
│   ├── proxy.test.ts
│   ├── recovery.test.ts
│   ├── registry.test.ts
│   ├── smoke.test.ts
│   ├── spawn-lock.test.ts
│   ├── tools.test.ts
│   └── setup.ts
├── scripts/              # Utility scripts
│   ├── expose.ts         # Ngrok tunnel + auth for cloud agents
│   ├── expose-open.ts    # Ngrok tunnel without auth
│   └── migrate-config.ts # Plist → gateway config migration
└── config/               # Sample configs and launchd plist
```

## Testing

We use [Bun's built-in test runner](https://bun.sh/docs/cli/test).

```bash
bun test                    # Run all tests
bun test --watch            # Run in watch mode
bun test --coverage         # Generate coverage report
bun test tests/proxy.test.ts  # Run a single test file
```

### Test Philosophy

- **Unit tests** for individual modules (config, bm25, spawn-lock, recovery)
- **Integration tests** for module interactions (proxy, registry, lifecycle)
- **E2E tests** for the full gateway lifecycle (cold start, tool discovery,
  spawning, idle kill, config hot-reload, graceful shutdown)
- Tests use mocks for external processes; no real MCP servers are required
- Environment-dependent tests (e.g., plist scanning) are guarded with
  `test.skipIf` to pass anywhere

## Pull Request Guidelines

1. **Open an issue first** for significant changes so we can discuss direction.
2. **Keep PRs focused** — one feature or fix per PR.
3. **Add tests** for new functionality. We aim for 80%+ coverage on `src/`.
4. **Update docs** — README.md for user-facing changes, CONTRIBUTING.md for
   development workflow changes.
5. **Update CHANGELOG.md** with a summary under the "Unreleased" heading.
6. **Ensure CI passes** — tests run on Bun v1.0, v1.1, and v1.2.
7. **Use conventional commits** in the PR title: `feat:`, `fix:`, `docs:`,
   `refactor:`, `test:`, `chore:`.

### PR Checklist

- [ ] Tests pass (`bun test`)
- [ ] TypeScript compiles (`bun tsc --noEmit`)
- [ ] New code has tests
- [ ] Documentation updated (README, CHANGELOG, or inline comments)
- [ ] Commit messages follow conventional commits

## Release Process

1. Update `CHANGELOG.md` with the new version and date.
2. Update `package.json` version.
3. Create a tag: `git tag v1.x.x && git push origin v1.x.x`
4. GitHub Actions publishes to npm automatically.

## Getting Help

- Open a [GitHub issue](https://github.com/samanvaya5/mcp-gateway/issues)
- For security issues, see [SECURITY.md](SECURITY.md)
