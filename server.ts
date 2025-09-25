import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplesauceRelayPool, NostrServerTransport } from "@contextvm/sdk";
import { PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";
import { processCashuToken } from "./utils/cashu-access.js";
import { checkLeaderboard, updateLeaderboard, getPlayer } from "./utils/leaderboard.js";
import { initializeDatabase } from "./utils/database.js";


// --- Configuration ---
// IMPORTANT: Replace with your own private key
const SERVER_PRIVATE_KEY_HEX = process.env.SERVER_PRIVATE_KEY || "";
const RELAYS = process.env.RELAYS?.split(",") || [
  "wss://relay.contextvm.org",
  "wss://cvm.otherstuff.ai",
];

// --- Main Server Logic ---
async function main() {
  // 1. Initialize Database
  console.log("Initializing database...");
  initializeDatabase();

  // 2. Setup Signer and Relay Pool
  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY_HEX);
  const relayPool = new ApplesauceRelayPool(RELAYS);
  const serverPubkey = await signer.getPublicKey();

  console.log(`Server Public Key: ${serverPubkey}`);
  console.log("Connecting to relays...");

  // 3. Create and Configure the MCP Server
  const mcpServer = new McpServer({
    name: "Retired CV",
    version: "1.0.1",
  });

  // 4. Define a simple "echo" tool
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
      description: "Redeem a Cashu token via Cashuwall and check access permissions",
      inputSchema: {
        encodedToken: z.string().describe("Cashu token (cashuA...)"),
        minAmount: z.number().optional().describe("Client hint for min sats (default 21). Server enforces threshold.")
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

  mcpServer.registerTool(
    "check_leaderboard",
    {
      title: "Check Leaderboard",
      description: "Get the current leaderboard showing initials, npub, and sats lost",
      inputSchema: {},
    },
    
    async () => {
      try {
        console.log(`🏆 Processing leaderboard request`);
        
        const result = await checkLeaderboard();
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Leaderboard error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to fetch leaderboard: ${error instanceof Error ? error.message : 'unknown'}`,
              data: []
            }, null, 2)
          }],
        };
      }
    }
  );

  mcpServer.registerTool(
    "update_leaderboard",
    {
      title: "Update Leaderboard",
      description: "Update the leaderboard with new sats lost for a given npub and initials with deduplication",
      inputSchema: {
        initials: z.string().describe("3-letter initials for the participant"),
        npub: z.string().describe("The npub identifier"),
        satsLost: z.number().describe("Number of sats lost in this submission"),
        refId: z.string().describe("Unique reference ID to prevent duplicate processing")
      },
    },
    
    async ({ initials, npub, satsLost, refId }) => {
      try {
        console.log(`📝 Processing leaderboard update request (refId: ${refId})`);
        
        const result = await updateLeaderboard(npub, initials, satsLost, refId);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Leaderboard update error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to update leaderboard: ${error instanceof Error ? error.message : 'unknown'}`,
              initials: initials || 'unknown',
              npub: npub || 'unknown',
              satsLost: satsLost || 0,
              refId: refId || 'unknown'
            }, null, 2)
          }],
        };
      }
    }
  );

  mcpServer.registerTool(
    "get_player",
    {
      title: "Get Player Details",
      description: "Get player details by npub including initials, total sats lost (score), and number of games played",
      inputSchema: {
        npub: z.string().describe("The npub identifier of the player")
      },
    },
    
    async ({ npub }) => {
      try {
        console.log(`👤 Processing get player request for npub: ${npub.substring(0, 20)}...`);
        
        const result = await getPlayer(npub);
        
        if (!result) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Player not found",
                npub: npub
              }, null, 2)
            }],
          };
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Get player error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to get player details: ${error instanceof Error ? error.message : 'unknown'}`,
              npub: npub || 'unknown'
            }, null, 2)
          }],
        };
      }
    }
  );

  // 5. Configure the Nostr Server Transport
  const serverTransport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    serverInfo: {
      name: "Retired CVM Backend",
    },
  });

  // 6. Connect the server
  await mcpServer.connect(serverTransport);

  console.log("Server is running and listening for requests on Nostr...");
  console.log("Press Ctrl+C to exit.");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
