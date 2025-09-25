import { Client } from "@modelcontextprotocol/sdk/client";
import { ApplesauceRelayPool, NostrClientTransport } from "@contextvm/sdk";
import { PrivateKeySigner } from "@contextvm/sdk";
import { SimpleRelayPool } from "@contextvm/sdk";

// --- Configuration ---
// IMPORTANT: Replace with the server's public key from the server output
const SERVER_PUBKEY = process.env.SERVER_PUBKEY || "";

// IMPORTANT: Replace with your own private key
const CLIENT_PRIVATE_KEY_HEX = process.env.CLIENT_PRIVATE_KEY_HEX || "";
const RELAYS = process.env.RELAYS?.split(",") || [
  "wss://relay.contextvm.org",
  "wss://cvm.otherstuff.ai",
];

// --- Main Client Logic ---
async function main() {
  // 1. Setup Signer and Relay Pool
  const signer = new PrivateKeySigner(CLIENT_PRIVATE_KEY_HEX);
  const relayPool = new ApplesauceRelayPool(RELAYS);

  console.log("Connecting to relays...");

  // 2. Configure the Nostr Client Transport
  const clientTransport = new NostrClientTransport({
    signer,
    relayHandler: relayPool,
    serverPubkey: SERVER_PUBKEY,
  });

  // 3. Create and connect the MCP Client
  const mcpClient = new Client({
    name: "nostr-echo-client",
    version: "1.0.0",
  });
  await mcpClient.connect(clientTransport);

  console.log("Connected to server!");

  // 4. List the available tools
  console.log("\nListing available tools...");
  const tools = await mcpClient.listTools();
  console.log("Tools:", tools);

  // 5. Call the "echo" tool
  console.log('\nCalling the "echo" tool...');
  const echoResult = await mcpClient.callTool({
    name: "echo",
    arguments: { message: "Hello, Nostr!" },
  });
  console.log("Echo result:", echoResult);

  // 6. Close the connection
  await mcpClient.close();
  console.log("\nConnection closed.");
}

main().catch((error) => {
  console.error("Client failed:", error);
  process.exit(1);
});
