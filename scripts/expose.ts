import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configPath =
  process.env.MCP_GATEWAY_CONFIG ||
  join(process.env.HOME || "", ".sisyphus/mcp-gateway-config.json");

async function main() {
  // 1. Load and validate config
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Error reading config at ${configPath}:`, err);
    process.exit(1);
  }

  // 2. Ensure token exists for security
  if (!config.token) {
    config.token = crypto.randomUUID();
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("✅ Generated new security token and saved to config.");
  }

  // 2.5. Pick a random port to avoid collisions
  const port = Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000;

  console.log(`\n🔒 Security Token: ${config.token}`);
  console.log(`📂 Config Path: ${configPath}`);
  console.log(`🔌 Local Port: ${port} (Randomly selected)`);

  // 3. Start Gateway in background
  console.log("\nStarting MCP Gateway...");
  const gateway = spawn("bun", ["run", "src/index.ts"], {
    stdio: "inherit",
    env: { ...process.env, MCP_GATEWAY_CONFIG: configPath, PORT: port.toString() },
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
      // Ignore errors while waiting for ngrok to start
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (publicUrl) {
    console.log("\n" + "=".repeat(50));
    console.log("🚀 MCP GATEWAY IS NOW PUBLIC!");
    console.log("=".repeat(50));
    console.log(`\nPublic URL: ${publicUrl}/sse`);
    console.log(`Token:      ${config.token}`);
    console.log("\n--- GROK CONFIGURATION ---");
    console.log("1. Open Grok Settings -> MCP Servers");
    console.log("2. Add Server -> Type: SSE");
    console.log(`3. URL: ${publicUrl}/sse`);
    console.log(`4. Headers: {"Authorization": "Bearer ${config.token}"}`);
    console.log("=".repeat(50));
    console.log("\nPress Ctrl+C to stop the gateway and tunnel.");
  } else {
    console.log("\n❌ Failed to retrieve ngrok URL.");
    console.log("Make sure ngrok is installed and you are logged in (`ngrok config add-authtoken ...`)");
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
