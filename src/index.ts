#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp-proxy.js";

async function main() {
  const transport = new StdioServerTransport();
  const proxyService = await createServer();
  const mcpServer = proxyService.mcpServer;
  const cleanupProxy = proxyService.cleanup.bind(proxyService);

  await mcpServer.connect(transport);

  process.on("SIGINT", async () => {
    await cleanupProxy();
    await mcpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
