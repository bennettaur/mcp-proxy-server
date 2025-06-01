import express from 'express'; // For type hints and main app creation if needed by services
import { fileURLToPath } from 'url';
import path from 'path';

// Core and Service Imports
import { createServer } from './mcp-proxy.js'; // Returns ProxyService instance
import { ProxyService } from './core/ProxyService.js'; // For type hinting
// ConfigService functions (loadConfig, loadToolConfig) are imported directly by services that need them.
import { HttpService } from './services/HttpService.js';
import { AdminService } from './services/AdminService.js';
import { TerminalService } from './services/TerminalService.js';

// Determine __dirname for ES modules if needed for top-level path construction (though most paths are now within services)
const __filename_url = import.meta.url;
const __filename = __filename_url.startsWith('file:') ? fileURLToPath(__filename_url) : __filename_url;
const __dirname = path.dirname(__filename);

// This is a simplified check. AdminService itself uses process.env.ENABLE_ADMIN_UI.
// We might need this check here to decide whether to mount terminalService routes.
const rawEnableAdminUI = process.env.ENABLE_ADMIN_UI;
const enableAdminUI = typeof rawEnableAdminUI === 'string' && (rawEnableAdminUI.toLowerCase() === 'true' || rawEnableAdminUI === '1' || rawEnableAdminUI.toLowerCase() === 'yes');


async function main() {
  console.log("Starting server orchestration...");

  // 1. Create ProxyService instance.
  // createServer is async, handles ProxyService instantiation and its internal initialization.
  // ProxyService internally uses loadConfig/loadToolConfig.
  const proxyService: ProxyService = await createServer();
  console.log("ProxyService created.");

  // 2. Get the actual MCP Server from ProxyService to pass to HttpService.
  const mcpServer = proxyService.mcpServer;
  if (!mcpServer) {
    throw new Error("MCP Server instance not found in ProxyService.");
  }
  console.log("MCP Server instance obtained from ProxyService.");

  // 3. Instantiate HttpService.
  const httpService = new HttpService(mcpServer);
  console.log("HttpService instantiated.");

  // 4. Instantiate TerminalService.
  const terminalService = new TerminalService();
  console.log("TerminalService instantiated.");

  // 5. Instantiate AdminService.
  // AdminService constructor now only takes ProxyService.
  // It will import loadConfig/loadToolConfig directly if needed.
  const adminService = new AdminService(proxyService);
  console.log("AdminService instantiated.");

  // 6. Get the Express app from HttpService.
  const app = httpService.getExpressApp();
  console.log("Express app obtained from HttpService.");

  // 8. Initialize AdminService and conditionally mount TerminalService routes.
  // AdminService's init method handles session setup and mounting its own routes.
  // It's conditional based on its internal check of enableAdminUI.
  await adminService.init(app); // adminService.init is async due to _getSessionSecret

  // Mount terminal router if Admin UI is generally enabled
  // The actual terminal routes within AdminService might be further controlled by its own logic.
  // Here, we link the TerminalService router to the main app under the /admin/terminal path.
  // This should also be conditional on enableAdminUI, consistent with AdminService.
  if (enableAdminUI) {
      // This assumes AdminService's isAuthenticated middleware will protect the /admin path,
      // including /admin/terminal.
      app.use('/admin/terminal', terminalService.getRouter());
      console.log("TerminalService router mounted under /admin/terminal.");
  }


  // 9. Start the HTTP server.
  const PORT = process.env.PORT || 3663;
  const HOSTNAME = process.env.HOSTNAME || '0.0.0.0'; // Listen on all interfaces by default

  httpService.start(Number(PORT), HOSTNAME);
  console.log(`HttpService started on ${HOSTNAME}:${PORT}.`);

  // Log main endpoints
  const baseUrl = `http://${HOSTNAME === '0.0.0.0' ? 'localhost' : HOSTNAME}:${PORT}`;
  console.log(`MCP Proxy Server is running.`);
  console.log(`SSE endpoint: ${baseUrl}/sse`);
  console.log(`Streamable HTTP (MCP) endpoint: ${baseUrl}/mcp`);
  if (enableAdminUI) {
      console.log(`Admin UI available at ${baseUrl}/admin`);
  }


  // 10. Setup Shutdown Logic.
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      console.log("Closing MCP Server (via ProxyService)...");
      // The mcpServer instance is directly from proxyService.mcpServer
      await proxyService.mcpServer.close();
      console.log("MCP Server successfully closed.");

      console.log("Cleaning up backend clients (via ProxyService)...");
      await proxyService.cleanup(); // ProxyService's own cleanup method
      console.log("Backend clients successfully cleaned up.");

      console.log("Shutting down terminal service...");
      terminalService.shutdown(); // TerminalService's shutdown method
      console.log("Terminal service successfully shut down.");

      console.log("Closing HTTP server...");
      const httpServer = httpService.getHttpServer();
      httpServer.close((err) => {
        if (err) {
          console.error("Error closing HTTP server:", err);
          process.exit(1); // Exit with error on server close failure
        } else {
          console.log("HTTP server closed.");
          process.exit(0); // Exit successfully
        }
      });

      // Force exit if graceful shutdown takes too long
      setTimeout(() => {
        console.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
      }, 10000); // 10 seconds timeout

    } catch (error) {
      console.error("Error during graceful shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Server orchestration complete. Application is running.");
}

main().catch(error => {
  console.error("Server failed to start or encountered a critical error during main execution:", error);
  process.exit(1);
});
