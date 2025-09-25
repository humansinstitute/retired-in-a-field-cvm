import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplesauceRelayPool, NostrServerTransport } from "@contextvm/sdk";
import { PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";

// --- Configuration ---
// IMPORTANT: Replace with your own private key
const SERVER_PRIVATE_KEY_HEX = process.env.SERVER_PRIVATE_KEY || "";
const RELAYS = process.env.RELAYS?.split(",") || [
  "wss://relay.contextvm.org",
  "wss://cvm.otherstuff.ai",
];

// --- Main Server Logic ---
async function main() {
  // 1. Setup Signer and Relay Pool
  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY_HEX);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`Server Public Key: ${serverPubkey}`);
  console.log("Connecting to relays...");

  // 2. Create and Configure the MCP Server
  const mcpServer = new McpServer({
    name: "nostr-echo-server",
    version: "1.0.0",
  });

  // 3. Define a simple "echo" tool
  mcpServer.registerTool(
    "echo",
    {
      title: "Echo Tool",
      description: "Echoes back the provided message",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Tool echo: ${message}` }],
    })
  );

  // 4. Configure the Nostr Server Transport
  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: {
      name: "CTXVM Echo Server",
    },
  });

  // 5. Connect the server
  await mcpServer.connect(serverTransport);

  console.log("Server is running and listening for requests on Nostr...");
  console.log("Press Ctrl+C to exit.");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
