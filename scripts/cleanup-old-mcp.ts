/**
 * cleanup-old-mcp.ts — Removes the old 10-port MCP infrastructure (ports 8001-8010).
 *
 * Unloads and deletes old launchd plists, kills orphan mcp-proxy processes,
 * and verifies a clean state.
 *
 * Usage:
 *   bun run scripts/cleanup-old-mcp.ts --dry-run    # Preview only
 *   bun run scripts/cleanup-old-mcp.ts               # Execute cleanup
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

// ── Constants ───────────────────────────────────────────────────────────────

const HOME = homedir();
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const PRESERVE_PLIST = "com.mcp.gateway.plist";
/** Ports the old 10 MCP servers ran on. */
const OLD_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010];

// ── Helpers ─────────────────────────────────────────────────────────────────

function plistLabel(file: string): string {
  return file.replace(/\.plist$/, "");
}

async function run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    proc.on("error", () => resolve({ exitCode: 1, stdout, stderr: `Failed to spawn ${cmd}` }));
  });
}

// ── Core Operations ─────────────────────────────────────────────────────────

/** Find all old plist files (excludes the gateway plist). */
async function findOldPlists(): Promise<string[]> {
  const files = await readdir(LAUNCH_AGENTS_DIR);
  return files
    .filter((f) => f.startsWith("com.mcp.") && f.endsWith(".plist") && f !== PRESERVE_PLIST)
    .sort();
}

/** Unload a single plist via launchctl. */
async function unloadPlist(fileName: string): Promise<boolean> {
  const path = join(LAUNCH_AGENTS_DIR, fileName);
  const { exitCode, stderr } = await run("launchctl", ["unload", path]);

  if (exitCode === 0) {
    console.log(`  ✓ unloaded: ${plistLabel(fileName)}`);
    return true;
  }

  // exit code 3 means "not loaded" — that's fine
  if (exitCode === 3 || stderr.includes("Could not find specified service")) {
    console.log(`  ⚠ already unloaded: ${plistLabel(fileName)}`);
    return true;
  }

  console.error(`  ✗ failed to unload ${plistLabel(fileName)}: ${stderr.trim()}`);
  return false;
}

/** Delete a plist file. */
async function deletePlist(fileName: string): Promise<void> {
  const path = join(LAUNCH_AGENTS_DIR, fileName);
  await rm(path);
  console.log(`  ✓ removed: ${fileName}`);
}

/** Find orphan mcp-proxy processes listening on old ports. */
async function findOrphanProxies(): Promise<Array<{ port: number; pid: string; command: string }>> {
  const results: Array<{ port: number; pid: string; command: string }> = [];

  for (const port of OLD_PORTS) {
    try {
      const { stdout } = await run("lsof", ["-ti", `:${port}`]);
      const pids = stdout.trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        // Check if it is a mcp-proxy process
        const { stdout: cmdOut } = await run("ps", ["-p", pid, "-o", "command="]);
        const cmd = cmdOut.trim();
        if (cmd.includes("mcp-proxy") || cmd.includes("mcp_proxy")) {
          results.push({ port, pid, command: cmd });
        }
      }
    } catch {
      // lsof returns non-zero when no process is on the port — skip silently
    }
  }

  return results;
}

/** Verify clean state: no old launchd entries, no orphan processes, no port bindings. */
async function verifyClean(): Promise<boolean> {
  let clean = true;

  const { stdout: launchdList } = await run("launchctl", ["list"]);
  const mcpLines = launchdList.split("\n").filter((l) => l.includes("com.mcp") && !l.includes("com.mcp.gateway"));
  if (mcpLines.length > 0) {
    console.error("  ✗ Found old launchd entries:");
    for (const line of mcpLines) console.error(`    ${line}`);
    clean = false;
  } else {
    console.log("  ✓ No old launchd entries.");
  }

  let anyPortInUse = false;
  for (const port of OLD_PORTS) {
    try {
      const { stdout } = await run("lsof", ["-ti", `:${port}`]);
      const pids = stdout.trim();
      if (pids) {
        console.error(`  ✗ Port ${port} is still in use (PID: ${pids})`);
        anyPortInUse = true;
        clean = false;
      }
    } catch { /* port is free */ }
  }
  if (!anyPortInUse) {
    console.log("  ✓ All old ports (8001-8010) are free.");
  }

  const { stdout: psOut } = await run("ps", ["aux"]);
  const proxyLines = psOut.split("\n").filter((l) => !l.includes("grep") && (l.includes("mcp-proxy") || l.includes("mcp_proxy")));
  if (proxyLines.length > 0) {
    console.error("  ✗ Found orphan mcp-proxy processes:");
    for (const line of proxyLines) console.error(`    ${line.trim()}`);
    clean = false;
  } else {
    console.log("  ✓ No orphan mcp-proxy processes.");
  }

  return clean;
}

// ── Dry-Run Preview ─────────────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  console.log("DRY RUN — no changes will be made\n");

  const oldPlists = await findOldPlists();

  if (oldPlists.length === 0) {
    console.log("No old com.mcp.*.plist files found. Nothing to clean up.");
    return;
  }

  console.log("Would perform:\n");

  let step = 1;
  for (const plist of oldPlists) {
    console.log(`  ${step}. unload: ${plistLabel(plist)}`);
    step++;
    console.log(`  ${step}. delete: ~/Library/LaunchAgents/${plist}`);
    step++;
  }

  const orphans = await findOrphanProxies();
  for (const orphan of orphans) {
    console.log(`  ${step}. kill process on port ${orphan.port} (PID ${orphan.pid}): ${orphan.command.slice(0, 60)}...`);
    step++;
  }

  console.log(`\nWould remove ${oldPlists.length} plist file(s) from ~/Library/LaunchAgents/`);
  console.log(`Would kill ${orphans.length} orphan mcp-proxy process(es).`);
  console.log("Preserving: com.mcp.gateway.plist (not touched).");
}

// ── Live Execution ──────────────────────────────────────────────────────────

async function liveRun(): Promise<void> {
  console.log("Cleaning up old MCP infrastructure...\n");

  const oldPlists = await findOldPlists();

  if (oldPlists.length === 0) {
    console.log("No old com.mcp.*.plist files found. Nothing to clean up.");
    process.exit(0);
  }

  console.log(`Found ${oldPlists.length} old plist file(s):

  UNLOAD + REMOVE`);
  console.log("  ──────────────\n");

  let unloadFailures = 0;
  for (const plist of oldPlists) {
    const ok = await unloadPlist(plist);
    if (ok) {
      await deletePlist(plist);
    } else {
      unloadFailures++;
    }
  }

  if (unloadFailures > 0) {
    console.warn(`\nWarning: ${unloadFailures} plist(s) failed to unload. Those files were NOT deleted.`);
  }

  // Kill orphan proxies
  console.log("\n  ORPHAN PROCESSES");
  console.log("  ────────────────\n");

  const orphans = await findOrphanProxies();
  if (orphans.length === 0) {
    console.log("  No orphan mcp-proxy processes found.");
  } else {
    console.log(`Found ${orphans.length} orphan mcp-proxy process(es):\n`);
    for (const orphan of orphans) {
      process.stdout.write(`  Killing PID ${orphan.pid} (port ${orphan.port})... `);
      const { exitCode } = await run("kill", ["-9", orphan.pid]);
      if (exitCode === 0) {
        console.log("done.");
      } else {
        console.log("failed (process may have already exited).");
      }
    }
  }

  // Verify
  console.log("\n  VERIFICATION");
  console.log("  ────────────\n");

  const clean = await verifyClean();
  console.log(clean ? "\n✓ Cleanup complete. Old MCP infrastructure removed." : "\n⚠ Cleanup complete with warnings. Review the issues above.");
}

// ── Entry Point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values["dry-run"]) {
    await dryRun();
    process.exit(0);
  }

  await liveRun();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  });
}
