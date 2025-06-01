import { ProxyService } from './core/ProxyService.js';
import { Config, loadConfig, ToolConfig, loadToolConfig } from './core/ConfigService.js';
import * as eventsource from 'eventsource';

// Ensure EventSource is available globally for the SDK
global.EventSource = eventsource.EventSource as any;


// --- Function to update backend connections (delegated to ProxyService) ---
// This function will now call the ProxyService's method to update connections.
// It's kept if an external trigger for updates is still needed (e.g., from a file watcher).
// If not, this can be removed if updates are only triggered internally or via other means.
export const updateBackendConnections = async (proxyService: ProxyService, newServerConfig: Config, newToolConfig: ToolConfig) => {
    console.log("Triggering update of backend connections via ProxyService...");
    await proxyService.updateBackendConnections(newServerConfig, newToolConfig);
};

// --- Function to get current proxy state (delegated to ProxyService) ---
export const getCurrentProxyState = (proxyService: ProxyService) => {
    return proxyService.getCurrentProxyState();
};

// --- Server Creation ---
export const createServer = async () => {
  // Instantiate the ProxyService.
  // The ProxyService constructor handles its own initial configuration loading
  // and backend connection setup.
  const proxyService = new ProxyService();

  // The ProxyService's mcpServer is already configured and has its request handlers set.
  // The cleanup method is also provided by the ProxyService instance.
  // Return the proxyService instance directly.
  return proxyService;
};
