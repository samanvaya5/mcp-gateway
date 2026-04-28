/**
 * migrate-config.ts — Reads MCP plist files and secrets, generates unified gateway config JSON.
 *
 * Usage: bun run scripts/migrate-config.ts [--secrets-path <path>] [--plist-dir <path>] [--output <path>]
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// ── Types ───────────────────────────────────────────────────────────────────

interface PlistData {
  Label: string;
  ProgramArguments: string[];
  EnvironmentVariables?: Record<string, string>;
}

interface SecretEntry {
  name: string;
  key_name: string;
  value: string;
}

interface SecretsFile {
  servers: SecretEntry[];
}

interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  mode: "persistent" | "on-demand";
  idleTimeout: number;
  disabled: boolean;
}

interface GatewayConfig {
  port: number;
  host: string;
  registryPath: string;
  logPath: string;
  servers: ServerConfig[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const PERSISTENT_SERVERS = new Set(["playwright", "chrome-devtools", "framer"]);
const PERSISTENT_TIMEOUT = 600;
const ON_DEMAND_TIMEOUT = 300;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse a plist XML file to JSON using plutil. */
async function readPlist(path: string): Promise<PlistData> {
  const proc = Bun.spawn(["plutil", "-convert", "json", "-o", "-", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`plutil failed for ${path} (exit ${exitCode}): ${err}`);
  }
  return JSON.parse(output) as PlistData;
}

/** Extract server name from Label (e.g., "com.mcp.github" → "github"). */
function serverNameFromLabel(label: string): string {
  const parts = label.split(".");
  return parts[parts.length - 1]!;
}

/**
 * Detect proxy wrapper patterns and extract the ACTUAL server command + args.
 *
 * Handles:
 *   - mcp-proxy:    ... -- <real-command> <real-args...>
 *   - pool-manager: ... --cmd "<real-command>"
 *   - bash -c:      bash -c "<full-command-string>" (may contain nested mcp-proxy)
 *   - npx-wrapper:  npx mcp-proxy ... -- <real-command> <real-args...>
 */
function extractActualCommand(args: string[]): { command: string; args: string[] } {
  // 1. bash -c pattern: args = ["/bin/bash", "-c", "<command-string>"]
  //    Parse the command-string to get the real command.
  if (args.length >= 3 && (args[0] === "/bin/bash" || args[0] === "bash") && args[1] === "-c") {
    const cmdStr = args[2]!;
    const tokens = shellSplit(cmdStr);
    return extractActualCommand(tokens);
  }

  // 2. pool-manager pattern: look for --cmd flag
  const cmdIndex = args.indexOf("--cmd");
  if (cmdIndex !== -1 && cmdIndex + 1 < args.length) {
    const cmdStr = args[cmdIndex + 1]!;
    const tokens = shellSplit(cmdStr);
    return extractActualCommand(tokens);
  }

  // 3. mcp-proxy pattern: look for -- separator
  const separatorIndex = args.indexOf("--");
  if (separatorIndex !== -1 && separatorIndex + 1 < args.length) {
    const realArgs = args.slice(separatorIndex + 1);
    return extractActualCommand(realArgs);
  }

  // 4. npx mcp-proxy pattern (npx running mcp-proxy as first arg): args = [npx, mcp-proxy, ...]
  if (
    args.length >= 2 &&
    (args[0] === "npx" || args[0]?.endsWith("/npx")) &&
    (args[1]?.includes("mcp-proxy") || args[1]?.includes("mcp_proxy"))
  ) {
    // Look for -- separator after mcp-proxy
    const sepIdx = args.indexOf("--");
    if (sepIdx !== -1 && sepIdx + 1 < args.length) {
      const realArgs = args.slice(sepIdx + 1);
      return extractActualCommand(realArgs);
    }
  }

  // 5. Direct: use as-is
  return {
    command: args[0]!,
    args: args.slice(1),
  };
}

/**
 * Minimal shell-like tokenizer for splitting command strings.
 * Handles quoted strings and backslash escapes.
 */
function shellSplit(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function stripSensitiveParams(url: string): string {
  return url.replace(/([?&])(id|secret|key|token|api_key|apikey)=[^&\s]*/gi, "")
    .replace(/[?&]$/, "").replace(/\?&/, "?");
}

/** Merge secrets into server env vars, strip from args where applicable. */
function mergeSecrets(
  serverName: string,
  env: Record<string, string>,
  args: string[],
  secrets: SecretEntry[],
): { env: Record<string, string>; args: string[] } {
  const mergedEnv = { ...env };
  let mergedArgs = [...args];

  for (const secret of secrets) {
    if (secret.name === serverName) {
      mergedEnv[secret.key_name] = secret.value;
    }
  }

  mergedArgs = mergedArgs.map((arg) => stripSensitiveParams(arg));

  return { env: mergedEnv, args: mergedArgs };
}

// ── Main Logic ──────────────────────────────────────────────────────────────

export interface MigrateOptions {
  secretsPath: string;
  plistDir: string;
  output: string;
}

/** Try to discover servers from existing gateway config (post-migration). */
async function discoverFromGatewayConfig(
  secrets: SecretEntry[],
): Promise<{ servers: ServerConfig[]; missingServers: string[] } | null> {
  const gatewayConfigPath = join(homedir(), ".sisyphus", "mcp-gateway-config.json");

  try {
    const raw = await readFile(gatewayConfigPath, "utf-8");
    const existing = JSON.parse(raw);

    if (!existing.servers || !Array.isArray(existing.servers) || existing.servers.length === 0) {
      return null;
    }

    console.log(`Reading ${existing.servers.length} servers from existing gateway config.`);

    const servers: ServerConfig[] = [];
    const expectedServers = [
      "github", "gitlab", "exa2", "context7", "framer",
      "playwright", "chrome-devtools", "pencil", "firebase", "subtext",
    ];
    const foundServers = new Set<string>();

    for (const s of existing.servers) {
      foundServers.add(s.name);

      const env = typeof s.env === "object" && s.env !== null ? { ...s.env } : {};
      const args = Array.isArray(s.args) ? [...s.args] : [];
      const { env: mergedEnv, args: mergedArgs } = mergeSecrets(s.name, env, args, secrets);

      const isPersistent = PERSISTENT_SERVERS.has(s.name);

      servers.push({
        name: s.name,
        command: s.command || "",
        args: mergedArgs,
        env: mergedEnv,
        mode: isPersistent ? "persistent" : "on-demand",
        idleTimeout: isPersistent ? PERSISTENT_TIMEOUT : ON_DEMAND_TIMEOUT,
        disabled: s.disabled ?? false,
      });

      console.log(`  ✓ ${s.name} (${isPersistent ? "persistent" : "on-demand"})`);
    }

    const missingServers = expectedServers.filter((e) => !foundServers.has(e));
    if (missingServers.length > 0) {
      console.warn(`Warning: Missing servers from gateway config: ${missingServers.join(", ")}`);
    }

    return { servers, missingServers };
  } catch {
    return null;
  }
}

/** Discover servers from plist files (legacy fallback). */
async function discoverFromPlists(
  plistDir: string,
  secrets: SecretEntry[],
): Promise<{ servers: ServerConfig[]; missingServers: string[] }> {
  const plistFiles = (await readdir(plistDir))
    .filter((f) => f.startsWith("com.mcp.") && f.endsWith(".plist"))
    .sort();

  if (plistFiles.length === 0) {
    console.warn(`Warning: No com.mcp.*.plist files found in ${plistDir}`);
  }

  console.log(`Found ${plistFiles.length} plist files.`);

  const servers: ServerConfig[] = [];
  const expectedServers = [
    "github", "gitlab", "exa2", "context7", "framer",
    "playwright", "chrome-devtools", "pencil", "firebase", "subtext",
  ];
  const foundServers = new Set<string>();

  for (const plistFile of plistFiles) {
    const plistPath = join(plistDir, plistFile);
    let plist: PlistData;

    try {
      plist = await readPlist(plistPath);
    } catch (err) {
      console.warn(`Warning: Failed to read ${plistPath}: ${err}. Skipping.`);
      continue;
    }

    const serverName = serverNameFromLabel(plist.Label);
    foundServers.add(serverName);

    const env = plist.EnvironmentVariables ? { ...plist.EnvironmentVariables } : {};
    const { command, args } = extractActualCommand(plist.ProgramArguments);
    const { env: mergedEnv, args: mergedArgs } = mergeSecrets(serverName, env, args, secrets);

    const isPersistent = PERSISTENT_SERVERS.has(serverName);

    servers.push({
      name: serverName,
      command,
      args: mergedArgs,
      env: mergedEnv,
      mode: isPersistent ? "persistent" : "on-demand",
      idleTimeout: isPersistent ? PERSISTENT_TIMEOUT : ON_DEMAND_TIMEOUT,
      disabled: false,
    });

    console.log(`  ✓ ${serverName} (${isPersistent ? "persistent" : "on-demand"})`);
  }

  const missingServers = expectedServers.filter((e) => !foundServers.has(e));
  if (missingServers.length > 0) {
    console.warn(`Warning: Missing plist files for servers: ${missingServers.join(", ")}`);
  }

  return { servers, missingServers };
}

export async function migrateConfig(options: MigrateOptions): Promise<GatewayConfig> {
  const { secretsPath, plistDir } = options;

  let secrets: SecretEntry[] = [];
  try {
    const secretsRaw = await readFile(secretsPath, "utf-8");
    const secretsData = JSON.parse(secretsRaw) as SecretsFile;
    secrets = secretsData.servers || [];
  } catch {
    console.warn(`Warning: Could not read secrets from ${secretsPath}, continuing without secrets.`);
  }

  // Try gateway config first (post-migration), fall back to plist scanning
  let result = await discoverFromGatewayConfig(secrets);
  if (!result) {
    console.log("No existing gateway config found, falling back to plist scanning.");
    result = await discoverFromPlists(plistDir, secrets);
  }

  const { servers, missingServers } = result;

  const config: GatewayConfig = {
    port: 8000,
    host: "127.0.0.1",
    registryPath: "~/.sisyphus/tool-registry.json",
    logPath: "~/.sisyphus/mcp-gateway/logs/gateway.log",
    servers,
  };

  return config;
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "secrets-path": { type: "string", default: join(homedir(), ".sisyphus", "mcp-secrets.json") },
      "plist-dir": { type: "string", default: join(homedir(), "Library", "LaunchAgents") },
      "output": { type: "string", default: join(homedir(), ".sisyphus", "mcp-gateway-config.json") },
    },
    allowPositionals: false,
    strict: false,
  });

  const options: MigrateOptions = {
    secretsPath: values["secrets-path"] as string,
    plistDir: values["plist-dir"] as string,
    output: values["output"] as string,
  };

  console.log("Secrets path:", options.secretsPath);
  console.log("Plist dir:", options.plistDir);
  console.log("Output:", options.output);
  console.log("");

  const config = await migrateConfig(options);

  const outDir = dirname(options.output);
  await mkdir(outDir, { recursive: true });
  await writeFile(options.output, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nConfig written to ${options.output} (${config.servers.length} servers)`);
}


if (import.meta.main) {
  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
