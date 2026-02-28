#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import server from "./server.js";
import { shutdownAllClients } from "./matrix/clientCache.js";

// In stdio mode, stdout is reserved for the MCP JSON-RPC protocol.
// Redirect console.log to stderr so debug output doesn't corrupt the stream.
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  console.error(...args);
};

// Validate required environment variables
const required = ["MATRIX_USER_ID", "MATRIX_ACCESS_TOKEN", "MATRIX_HOMESERVER_URL"] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("Set them in your environment or in a .env file.");
  process.exit(1);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("matrix-mcp-server running on stdio");
}

// Graceful shutdown
function shutdown() {
  console.error("Shutting down...");
  shutdownAllClients();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
