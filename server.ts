import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplesauceRelayPool, NostrServerTransport } from "@contextvm/sdk";
import { PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";
import { processCashuToken } from "./utils/cashu-access.js";


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
    name: "Retired CV",
    version: "1.0.1",
  });

  // 3. Define a simple "echo" tool
  mcpServer.registerTool(
    "Echo",
    {
      title: "Echo Tool",
      description: "Echoes back the provided message",
      inputSchema: { message: z.string() },
    },
    
    async ({ message }) => ({
      content: [{ type: "text", text: `Tool echo: ${message}` }],
    })
    
  );

    mcpServer.registerTool(
    "cashu_access",
    {
      title: "Cashu Access Tool",
      description: "Redeem a Cashu token and check access permissions",
      inputSchema: {
        encodedToken: z.string().describe("Cashu token (cashuA...)"),
        minAmount: z.number().optional().describe("Minimum sats required (default 256)")
      },
    },
    
    async ({ encodedToken, minAmount }) => {
      try {
        console.log(`🪙 Processing Cashu token access request`);
        
        const result = await processCashuToken(encodedToken, minAmount);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Cashu access error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              decision: 'ACCESS_DENIED',
              amount: 0,
              reason: `error: ${error instanceof Error ? error.message : 'unknown'}`,
              mode: 'error'
            }, null, 2)
          }],
        };
      }
    }
  );



  // 4. Configure the Nostr Server Transport
  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: {
      name: "Retired CVM Backend",
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
