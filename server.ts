import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApplesauceRelayPool, NostrServerTransport } from "@contextvm/sdk";
import { PrivateKeySigner } from "@contextvm/sdk";
import { z } from "zod";
import { processCashuToken } from "./utils/cashu-access.js";
import { recordDonationAndSplitFromAmount } from "./utils/splits.js";
import {
  checkLeaderboard,
  updateLeaderboard,
  updateLeaderboardWithValidation,
  getPlayer,
  getPlayerWithValidation,
  performIntegrityCheck,
  validateAndSyncPlayerScore
} from "./utils/leaderboard.js";
import { initializeDatabase, getDatabase } from "./utils/database.js";
import { createHash } from "crypto";


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
        description: "Redeem a Cashu token via Cashuwall and return the decision (no side effects)",
        inputSchema: {
          encodedToken: z.string().describe("Cashu token (cashuA...)"),
          minAmount: z.number().optional().describe("Client hint for min sats (default 21). Server enforces threshold.")
        },
      },
      async ({ encodedToken, minAmount }) => {
        try {
          console.log(`🪙 Processing Cashu token access request (redeem + record async)`);
          const result = await processCashuToken(encodedToken, minAmount);

          // Persist access decision (idempotent) using token hash as ref_id
          try {
            const db = getDatabase();
            const tokenHash = createHash('sha256').update(encodedToken).digest('hex');
            const stmt = db.prepare(
              `INSERT INTO cashu_access_requests (ref_id, decision, amount_sats, reason, created_at, updated_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT(ref_id) DO UPDATE SET decision=excluded.decision, amount_sats=excluded.amount_sats, reason=excluded.reason, updated_at=CURRENT_TIMESTAMP`
            );
            stmt.run(tokenHash, result.decision, result.amount || 0, result.reason || '');
          } catch (err) {
            console.warn("[cashu_access] Failed to persist access request:", err);
          }

          // Fire-and-forget: if access granted, record donation/splits without blocking response
          if (result.decision === 'ACCESS_GRANTED' && result.amount > 0) {
            (async () => {
              try {
                const rec = await recordDonationAndSplitFromAmount(encodedToken, result.amount);
                console.log(`[cashu_access->finalize] donationRecorded=${rec.donationRecorded} preventedDuplicate=${rec.preventedDuplicate}`);
              } catch (e) {
                console.error("[cashu_access->finalize] Error recording donation/splits:", e);
              }
            })();
          }

          // Return decision immediately
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      description: "Update the leaderboard with new sats lost for a given npub and initials with validation and deduplication",
      inputSchema: {
        initials: z.string().describe("3-letter initials for the participant"),
        npub: z.string().describe("The npub identifier"),
        satsLost: z.number().describe("Number of sats lost in this submission"),
        refId: z.string().describe("Unique reference ID to prevent duplicate processing"),
        useValidation: z.boolean().optional().describe("Use enhanced validation (default: true)")
      },
    },
    
    async ({ initials, npub, satsLost, refId, useValidation = true }) => {
      try {
        console.log(`📝 Processing leaderboard update request (refId: ${refId}) with validation: ${useValidation}`);
        
        const result = useValidation
          ? await updateLeaderboardWithValidation(npub, initials, satsLost, refId)
          : await updateLeaderboard(npub, initials, satsLost, refId);
        
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
      description: "Get player details by npub including initials, total sats lost (score), and number of games played with validation",
      inputSchema: {
        npub: z.string().describe("The npub identifier of the player"),
        useValidation: z.boolean().optional().describe("Use enhanced validation to ensure score consistency (default: true)")
      },
    },
    
    async ({ npub, useValidation = true }) => {
      try {
        console.log(`👤 Processing get player request for npub: ${npub.substring(0, 20)}... with validation: ${useValidation}`);
        
        const result = useValidation
          ? await getPlayerWithValidation(npub)
          : await getPlayer(npub);
        
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

  mcpServer.registerTool(
    "validate_player_score",
    {
      title: "Validate Player Score",
      description: "Validate and sync a player's score to ensure consistency between leaderboard and update history",
      inputSchema: {
        npub: z.string().describe("The npub identifier of the player to validate")
      },
    },
    
    async ({ npub }) => {
      try {
        console.log(`🔍 Processing score validation request for npub: ${npub.substring(0, 20)}...`);
        
        const result = await validateAndSyncPlayerScore(npub);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Score validation error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to validate player score: ${error instanceof Error ? error.message : 'unknown'}`,
              npub: npub || 'unknown'
            }, null, 2)
          }],
        };
      }
    }
  );

  mcpServer.registerTool(
    "integrity_check",
    {
      title: "Leaderboard Integrity Check",
      description: "Perform a comprehensive integrity check of all player scores",
      inputSchema: {},
    },
    
    async () => {
      try {
        console.log(`🔍 Processing leaderboard integrity check...`);
        
        const result = await performIntegrityCheck();
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }],
        };
      } catch (error) {
        console.error("❌ Integrity check error:", error);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Failed to perform integrity check: ${error instanceof Error ? error.message : 'unknown'}`
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
