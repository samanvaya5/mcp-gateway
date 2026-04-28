#!/bin/bash
# Smoke test for MCP Gateway
# Runs the e2e test suite and reports results.
set -e

cd "$(dirname "$0")/.."

echo "=== MCP Gateway Smoke Test ==="
echo ""

echo "Running e2e tests..."
bun test tests/e2e.test.ts
echo ""

echo "=== Smoke test complete ==="
