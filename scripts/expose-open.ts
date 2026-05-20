import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const configPath =
  process.env.MCP_GATEWAY_CONFIG ||
  join(process.env.HOME || "", ".sisyphus/mcp-gateway-config.json");

async function main() {
  // 1. Load config
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Error reading config at ${configPath}:`, err);
    process.exit(1);
  }

  // 2. Pick a random port
  const port = Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000;

  console.log(`\n⚠️  WARNING: NO AUTHENTICATION ENABLED`);
  console.log(`📂 Config Path: ${configPath}`);
  console.log(`🔌 Local Port: ${port} (Randomly selected)`);

  // 3. Start Gateway in background with NO_AUTH=true
  console.log("\nStarting MCP Gateway (Open Mode)...");
  const gateway = spawn("bun", ["run", "src/index.ts"], {
    stdio: "inherit",
    env: { 
      ...process.env, 
      MCP_GATEWAY_CONFIG: configPath, 
      PORT: port.toString(),
      NO_AUTH: "true" 
    },
  });

  // 4. Start ngrok
  console.log("Starting ngrok tunnel...");
  const ngrok = spawn("ngrok", ["http", port.toString()], {
    stdio: "ignore",
  });

  // 5. Poll for ngrok URL
  console.log("Waiting for public URL...");
  let publicUrl = null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      const data = (await res.json()) as any;
      if (data.tunnels && data.tunnels.length > 0) {
        publicUrl = data.tunnels[0].public_url;
        break;
      }
    } catch (e) {
      // Ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (publicUrl) {
    console.log("\n" + "=".repeat(50));
    console.log("🚀 MCP GATEWAY IS NOW PUBLIC (OPEN MODE)!");
    console.log("=".repeat(50));
    console.log(`\nPublic URL: ${publicUrl}/sse`);
    console.log(`Auth:       DISABLED (Any user can connect)`);
    console.log("\n--- GROK CONFIGURATION ---");
    console.log("1. Open Grok Settings -> MCP Servers");
    console.log("2. Add Server -> Type: SSE");
    console.log(`3. URL: ${publicUrl}/sse`);
    console.log(`4. Headers: {} (Leave empty)`);
    console.log("=".repeat(50));
    console.log("\nPress Ctrl+C to stop the gateway and tunnel.");
  } else {
    console.log("\n❌ Failed to retrieve ngrok URL.");
    gateway.kill();
    ngrok.kill();
    process.exit(1);
  }

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    gateway.kill();
    ngrok.kill();
    process.exit(0);
  });
}

main().catch(console.error);
