/**
 * Migrate all 15 agent MCP config files from per-server ports (8001-8010)
 * to the unified gateway endpoint (http://localhost:8000/sse).
 *
 * Uses structured JSON manipulation (JSON.parse / JSON.stringify) for ALL
 * config changes — NO regex for URL or key replacement.
 *
 * Usage:
 *   bun run scripts/migrate-agents.ts --dry-run    # Preview only
 *   bun run scripts/migrate-agents.ts               # Perform migration
 */

import { readFile, writeFile, copyFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { relative } from "node:path";

const HOME = homedir();
const GATEWAY_URL = "http://localhost:8000/sse";
const GATEWAY_KEY = "mcp-gateway";
const OLD_KEY = "antigravity";

const GATEWAY_ENTRY = {
  type: "sse",
  url: GATEWAY_URL,
};

const CONFIG_FILES = [
  { path: `${HOME}/.cursor/mcp.json`,                                              label: "Cursor" },
  { path: `${HOME}/.claude/.mcp.json`,                                              label: "Claude Code" },
  { path: `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`,  label: "Claude Desktop" },
  { path: `${HOME}/.codeium/windsurf/mcp_config.json`,                              label: "Windsurf" },
  { path: `${HOME}/.kiro/settings/mcp.json`,                                        label: "Kiro" },
  { path: `${HOME}/.gemini/settings.json`,                                          label: "Gemini CLI" },
  { path: `${HOME}/.claude/mcp.json`,                                               label: "Claude (global)" },
  { path: `${HOME}/.factory/mcp.json`,                                              label: "Factory" },
  { path: `${HOME}/.gemini/antigravity/mcp_config.json`,                            label: "Gemini Antigravity" },
  { path: `${HOME}/forge/.mcp.json`,                                                label: "Forge" },
  { path: `${HOME}/Library/Application Support/Qoder/SharedClientCache/mcp.json`,   label: "Qoder" },
  { path: `${HOME}/Library/Application Support/ChatMcp/mcp_server.json`,            label: "ChatMcp" },
  { path: `${HOME}/Library/Application Support/Antigravity/User/mcp.json`,          label: "Antigravity Agent" },
  { path: `${HOME}/Library/Application Support/Code/User/mcp.json`,                 label: "Code Agent" },
  { path: `${HOME}/.config/opencode/mcp.json`,                                      label: "OpenCode (MCP)" },
] as const;

type Category =
  | "rename-only"
  | "empty"
  | "has-other-servers"
  | "servers-key"
  | "zero-byte"
  | "already-migrated"
  | "unknown";

interface MigrationResult {
  label: string;
  path: string;
  category: Category | null;
  operation: string;
  error?: string;
  skipped?: string;
  backupPath?: string;
}

const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getFileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return -1;
  }
}

function countGatewayRefs(obj: unknown): number {
  const json = JSON.stringify(obj);
  let count = 0;
  let idx = json.indexOf(GATEWAY_URL);
  while (idx !== -1) {
    count++;
    idx = json.indexOf(GATEWAY_URL, idx + 1);
  }
  return count;
}

function hasOldPortRefs(content: string): boolean {
  return /localhost:80(0[1-9]|10)/.test(content);
}

function detectCategory(parsed: Record<string, unknown>, rawSize: number): Category {
  if (rawSize === 0) return "zero-byte";

  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers?.[GATEWAY_KEY]) return "already-migrated";

  const servers = parsed.servers as Record<string, unknown> | undefined;
  if (servers?.[GATEWAY_KEY]) return "already-migrated";

  if (servers && !mcpServers) return "servers-key";

  if (mcpServers && typeof mcpServers === "object") {
    const serverKeys = Object.keys(mcpServers);
    const oldEntry = mcpServers[OLD_KEY] as Record<string, unknown> | undefined;
    if (oldEntry && typeof oldEntry.url === "string" && oldEntry.url.includes("8000/sse")) {
      return "rename-only";
    }
    if (serverKeys.length === 0) return "empty";
    return "has-other-servers";
  }

  return "unknown";
}

function transform(
  parsed: Record<string, unknown>,
  category: Category,
): { result: Record<string, unknown>; operation: string } {
  switch (category) {
    case "rename-only": {
      const mcpServers = parsed.mcpServers as Record<string, unknown>;
      const oldEntry = mcpServers[OLD_KEY];
      delete mcpServers[OLD_KEY];
      mcpServers[GATEWAY_KEY] = oldEntry;
      return {
        result: parsed,
        operation: `rename "${OLD_KEY}" → "${GATEWAY_KEY}" in mcpServers`,
      };
    }
    case "empty": {
      const mcpServers = parsed.mcpServers as Record<string, unknown>;
      mcpServers[GATEWAY_KEY] = { ...GATEWAY_ENTRY };
      return {
        result: parsed,
        operation: `add "${GATEWAY_KEY}" to empty mcpServers`,
      };
    }
    case "has-other-servers": {
      const mcpServers = (parsed.mcpServers || {}) as Record<string, unknown>;
      const existingCount = Object.keys(mcpServers).length;
      mcpServers[GATEWAY_KEY] = { ...GATEWAY_ENTRY };
      parsed.mcpServers = mcpServers;
      return {
        result: parsed,
        operation: `add "${GATEWAY_KEY}" alongside ${existingCount} existing server(s)`,
      };
    }
    case "servers-key": {
      const servers = parsed.servers as Record<string, unknown>;
      const existingCount = Object.keys(servers).length;
      servers[GATEWAY_KEY] = { ...GATEWAY_ENTRY };
      return {
        result: parsed,
        operation: `add "${GATEWAY_KEY}" under "servers" key (${existingCount} existing)`,
      };
    }
    case "zero-byte":
    case "unknown": {
      return {
        result: { mcpServers: { [GATEWAY_KEY]: { ...GATEWAY_ENTRY } } },
        operation: "create mcpServers from scratch (file was empty/missing)",
      };
    }
    default:
      throw new Error(`Unknown category: ${category}`);
  }
}

function validateResult(parsed: Record<string, unknown>): string | null {
  const json = JSON.stringify(parsed);
  if (!json.includes(GATEWAY_URL)) {
    return "gateway URL not found in result";
  }
  if (hasOldPortRefs(json)) {
    return "old port references (8001-8010) still present in result";
  }
  return null;
}

async function createBackup(path: string, _label: string): Promise<{ backupPath: string; skipped: string } | { error: string }> {
  const backupPath = `${path}.bak.gateway`;
  const backupExists = await fileExists(backupPath);
  if (backupExists) {
    return { backupPath, skipped: "backup already exists" };
  }
  try {
    await copyFile(path, backupPath);
  } catch (err) {
    return { error: `backup copy failed: ${err}` };
  }
  try {
    const origContent = await readFile(path, "utf-8");
    const backupContent = await readFile(backupPath, "utf-8");
    if (origContent !== backupContent) {
      return { error: "backup verification failed: content mismatch" };
    }
  } catch (err) {
    return { error: `backup verification read error: ${err}` };
  }
  return { backupPath, skipped: "" };
}

async function processConfig(
  entry: typeof CONFIG_FILES[number],
  dry: boolean,
): Promise<MigrationResult> {
  const relPath = relative(HOME, entry.path);
  const exists = await fileExists(entry.path);

  if (!exists) {
    const msg = `${c.yellow(dry ? "  [SKIP]" : "  SKIP")} ${c.bold(entry.label)} (${relPath}): file not found`;
    console.log(msg);
    return { label: entry.label, path: entry.path, category: null, operation: "not found", skipped: "file not found" };
  }

  const rawSize = await getFileSize(entry.path);
  if (rawSize < 0) {
    const msg = `${c.red(dry ? "  [ERR]" : "  ERR")}  ${c.bold(entry.label)} (${relPath}): cannot stat file`;
    console.log(msg);
    return { label: entry.label, path: entry.path, category: null, operation: "stat error", error: "cannot stat file" };
  }

  let raw = "";
  let parsed: Record<string, unknown>;

  if (rawSize === 0) {
    parsed = {};
  } else {
    try {
      raw = await readFile(entry.path, "utf-8");
    } catch (err) {
      console.log(`${c.red(dry ? "  [ERR]" : "  ERR")}  ${c.bold(entry.label)} (${relPath}): read error: ${err}`);
      return { label: entry.label, path: entry.path, category: null, operation: "read error", error: `read error: ${err}` };
    }
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.log(`${c.red(dry ? "  [ERR]" : "  ERR")}  ${c.bold(entry.label)} (${relPath}): invalid JSON: ${err}`);
      return { label: entry.label, path: entry.path, category: null, operation: "parse error", error: `invalid JSON: ${err}` };
    }
  }

  const category = detectCategory(parsed, rawSize);

  if (category === "already-migrated") {
    const tag = dry ? "  [OK]" : "  OK";
    console.log(`${c.green(tag)}   ${c.bold(entry.label)} (${relPath}): already migrated`);
    return { label: entry.label, path: entry.path, category, operation: "already migrated" };
  }

  if (category === "unknown") {
    const tag = dry ? "  [WARN]" : "  WARN";
    console.log(`${c.yellow(tag)} ${c.bold(entry.label)} (${relPath}): unrecognized config structure — skipping`);
    return { label: entry.label, path: entry.path, category, operation: "unknown", skipped: "unrecognized config structure" };
  }

  const { result, operation } = transform(parsed, category);
  const validationErr = validateResult(result);

  if (validationErr) {
    const tag = dry ? "  [FAIL]" : "  FAIL";
    console.log(`${c.red(tag)} ${c.bold(entry.label)} (${relPath}): ${operation}`);
    console.log(`         validation: ${c.red(validationErr)}`);
    return { label: entry.label, path: entry.path, category, operation, error: `validation: ${validationErr}` };
  }

  if (dry) {
    const catLabel = category.replace(/-/g, " ");
    console.log(`${c.cyan("  [PLAN]")} ${c.bold(entry.label)} (${relPath})`);
    console.log(`         category: ${c.dim(catLabel)}`);
    console.log(`         ${c.yellow(operation)}`);
    return { label: entry.label, path: entry.path, category, operation };
  }

  const backup = await createBackup(entry.path, entry.label);
  if ("error" in backup) {
    console.log(`${c.red("  FAIL")} ${entry.label} (${relPath}): ${backup.error}`);
    return { label: entry.label, path: entry.path, category, operation, error: backup.error };
  }

  if (backup.skipped) {
    console.log(c.dim(`         backup: ${backup.skipped}`));
  } else {
    console.log(c.dim(`         backup: ${relative(HOME, backup.backupPath)}`));
  }

  const output = JSON.stringify(result, null, 2) + "\n";
  try {
    await writeFile(entry.path, output, "utf-8");
  } catch (err) {
    console.log(`${c.red("  FAIL")} ${entry.label} (${relPath}): write error: ${err}`);
    return { label: entry.label, path: entry.path, category, operation, error: `write error: ${err}` };
  }

  try {
    const written = await readFile(entry.path, "utf-8");
    const writtenParsed = JSON.parse(written) as Record<string, unknown>;
    const postErr = validateResult(writtenParsed);
    if (postErr) {
      console.log(`${c.red("  FAIL")} ${entry.label} (${relPath}): post-write validation: ${postErr}`);
      return { label: entry.label, path: entry.path, category, operation, error: `post-write validation: ${postErr}` };
    }
  } catch (err) {
    console.log(`${c.red("  FAIL")} ${entry.label} (${relPath}): post-write read/parse error: ${err}`);
    return { label: entry.label, path: entry.path, category, operation, error: `post-write read/parse error: ${err}` };
  }

  console.log(`${c.green("  ✓")}    ${entry.label} (${relPath}): ${operation}`);
  return { label: entry.label, path: entry.path, category, operation, backupPath: backup.backupPath };
}

async function dryRun(): Promise<void> {
  console.log(c.bold("\n═══ DRY-RUN: Previewing all 15 agent config migrations ═══\n"));

  const results: MigrationResult[] = [];
  for (const entry of CONFIG_FILES) {
    results.push(await processConfig(entry, true));
  }

  console.log(c.bold("\n═══ Dry-Run Summary ═══"));
  const toMigrate = results.filter((r) => r.category && r.category !== "already-migrated" && !r.error && !r.skipped);
  const alreadyDone = results.filter((r) => r.category === "already-migrated");
  const skipped = results.filter((r) => r.skipped);
  const errors = results.filter((r) => r.error);

  console.log(`  Total configs scanned:   ${results.length}`);
  console.log(`  Planned migrations:      ${c.cyan(String(toMigrate.length))}`);
  console.log(`  Already migrated:        ${c.green(String(alreadyDone.length))}`);
  if (skipped.length > 0) {
    console.log(`  Skipped:                 ${c.yellow(String(skipped.length))} (${skipped.map((r) => r.label).join(", ")})`);
  }
  if (errors.length > 0) {
    console.log(`  Errors:                  ${c.red(String(errors.length))}`);
    for (const e of errors) {
      console.log(`    ${c.red("✗")} ${e.label}: ${e.error}`);
    }
  }
  console.log(c.dim("\n  Run without --dry-run to apply changes.\n"));
}

async function migrate(): Promise<void> {
  console.log(c.bold("\n═══ Migrating All 15 Agent Configs to MCP Gateway ═══\n"));

  const results: MigrationResult[] = [];
  for (const entry of CONFIG_FILES) {
    results.push(await processConfig(entry, false));
  }

  const succeeded = results.filter((r) => !r.error && !r.skipped && r.category !== "already-migrated");
  const alreadyDone = results.filter((r) => r.category === "already-migrated");
  const skipped = results.filter((r) => r.skipped);
  const errors = results.filter((r) => r.error);

  console.log(c.bold("\n═══ Migration Summary ═══"));
  for (const r of succeeded) {
    console.log(c.green(`  ✓ ${r.label}: ${r.operation}`));
  }
  for (const r of alreadyDone) {
    console.log(c.dim(`  - ${r.label}: already migrated`));
  }
  for (const r of skipped) {
    console.log(c.yellow(`  ⚠ ${r.label}: ${r.skipped}`));
  }
  for (const r of errors) {
    console.log(c.red(`  ✗ ${r.label}: ${r.error}`));
  }

  console.log();
  console.log(`  Migrated:    ${c.green(String(succeeded.length))} configs`);
  console.log(`  Backups:     ${c.dim(String(results.filter((r) => r.backupPath && !r.error).length))} new`);
  console.log(`  Already ok:  ${c.dim(String(alreadyDone.length))}`);
  if (skipped.length > 0) console.log(`  Skipped:     ${c.yellow(String(skipped.length))}`);
  if (errors.length > 0) console.log(`  Errors:      ${c.red(String(errors.length))}`);

  console.log(c.bold("\n═══ Post-Migration Sweep: Checking for old port references ═══"));
  let anyOldRefs = false;
  for (const entry of CONFIG_FILES) {
    if (!(await fileExists(entry.path))) continue;
    try {
      const content = await readFile(entry.path, "utf-8");
      if (hasOldPortRefs(content)) {
        console.log(c.red(`  ✗ ${entry.label}: STILL has references to ports 8001-8010`));
        anyOldRefs = true;
      }
      if (!content.includes(GATEWAY_URL)) {
        console.log(c.yellow(`  ⚠ ${entry.label}: gateway URL not found in config`));
      }
    } catch {
    }
  }

  if (!anyOldRefs) {
    console.log(c.green("  ✓ Zero references to ports 8001-8010 across all configs"));
  }
  console.log();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values["dry-run"]) {
    await dryRun();
  } else {
    await migrate();
  }
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err}`));
  process.exit(1);
});
