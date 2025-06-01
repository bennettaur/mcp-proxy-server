import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ConnectedClient } from './ClientFactory.js';
import { createMcpClients } from './ClientFactory.js';
import type { Config, ToolConfig, TransportConfig } from './ConfigService.js';
import { loadConfig, loadToolConfig, isSSEConfig, isStdioConfig } from './ConfigService.js';

// Reverted to /types/index.js
// All Schemas (Request and Result) are Zod schema objects, used as values at runtime.
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ListToolsResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ReadResourceResultSchema,
    ListResourceTemplatesResultSchema,
    CompatibilityCallToolResultSchema,
    GetPromptResultSchema
} from '@modelcontextprotocol/sdk/types/index.js';

// Reverted to /types/index.js
// These are interfaces or type aliases, used only for type annotations.
import type {
    Prompt,
    Resource,
    Tool,
    ResourceTemplate
} from '@modelcontextprotocol/sdk/types/index.js';

import { z } from 'zod';

export class ProxyService {
    private currentConnectedClients: ConnectedClient[] = [];
    private toolToClientMap = new Map<string, { client: ConnectedClient, toolInfo: Tool }>();
    private resourceToClientMap = new Map<string, ConnectedClient>();
    private promptToClientMap = new Map<string, ConnectedClient>();
    private currentToolConfig: ToolConfig = { tools: {} };

    public mcpServer: Server;

    constructor() {
        this.mcpServer = new Server(
            {
                name: 'mcp-proxy',
                version: '1.0.0',
            },
            {
                capabilities: {
                    prompts: { list: true, get: true },
                    resources: { list: true, read: true, listTemplates: true },
                    tools: { list: true, call: true }
                }
            }
        );

        this.mcpServer.setRequestHandler(ListToolsRequestSchema, this._handleListTools.bind(this));
        this.mcpServer.setRequestHandler(CallToolRequestSchema, this._handleCallTool.bind(this));
        this.mcpServer.setRequestHandler(GetPromptRequestSchema, this._handleGetPrompt.bind(this));
        this.mcpServer.setRequestHandler(ListPromptsRequestSchema, this._handleListPrompts.bind(this));
        this.mcpServer.setRequestHandler(ListResourcesRequestSchema, this._handleListResources.bind(this));
        this.mcpServer.setRequestHandler(ReadResourceRequestSchema, this._handleReadResource.bind(this));
        this.mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, this._handleListResourceTemplates.bind(this));

        this.updateBackendConnections().catch(error => {
            console.error("Error during initial backend connection update:", error);
        });
    }

    public async updateBackendConnections(newServerConfig?: Config, newToolConfig?: ToolConfig): Promise<void> {
        console.log("Starting update of backend connections in ProxyService...");
        const configToUse = newServerConfig || await loadConfig();
        const toolConfigToUse = newToolConfig || await loadToolConfig();
        this.currentToolConfig = toolConfigToUse;

        const activeServersConfig: Record<string, TransportConfig> = {};
        for (const serverKey in configToUse.mcpServers) {
            if (Object.prototype.hasOwnProperty.call(configToUse.mcpServers, serverKey)) {
                const serverConf = configToUse.mcpServers[serverKey];
                const isActive = !(serverConf.active === false || String(serverConf.active).toLowerCase() === 'false');
                if (isActive) {
                    activeServersConfig[serverKey] = serverConf;
                } else {
                    const serverName = serverConf.name || (isSSEConfig(serverConf) ? serverConf.url : isStdioConfig(serverConf) ? serverConf.command : serverKey);
                    console.log(`Skipping inactive server during update: ${serverName}`);
                }
            }
        }

        const newClientKeys = new Set(Object.keys(activeServersConfig));
        const currentClientKeys = new Set(this.currentConnectedClients.map(c => c.name));
        const clientsToRemove = this.currentConnectedClients.filter(c => !newClientKeys.has(c.name));
        const clientsToKeep = this.currentConnectedClients.filter(c => newClientKeys.has(c.name));
        const keysToAdd = Object.keys(activeServersConfig).filter(key => !currentClientKeys.has(key));

        if (clientsToRemove.length > 0) {
            await Promise.all(clientsToRemove.map(async ({ name, cleanup }) => {
                try { await cleanup(); console.log(`  Cleaned up client: ${name}`); }
                catch (error) { console.error(`  Error cleaning up client ${name}:`, error); }
            }));
        }

        let newlyConnectedClients: ConnectedClient[] = [];
        if (keysToAdd.length > 0) {
            const configToAdd: Record<string, TransportConfig> = {};
            keysToAdd.forEach(key => { configToAdd[key] = activeServersConfig[key]; });
            newlyConnectedClients = await createMcpClients(configToAdd);
        }
        this.currentConnectedClients = [...clientsToKeep, ...newlyConnectedClients];

        this.toolToClientMap.clear();
        this.resourceToClientMap.clear();
        this.promptToClientMap.clear();

        for (const connectedClient of this.currentConnectedClients) {
            try {
                const result = await connectedClient.client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
                if (result.tools && result.tools.length > 0) {
                    for (const tool of result.tools) {
                        const qualifiedName = `${connectedClient.name}--${tool.name}`;
                        const toolSettings = this.currentToolConfig.tools[qualifiedName];
                        const isEnabled = !toolSettings || toolSettings.enabled !== false;
                        if (isEnabled) this.toolToClientMap.set(qualifiedName, { client: connectedClient, toolInfo: tool });
                    }
                }
            } catch (error: any) {
                if (!(error?.name === 'McpError' && error?.code === -32601))
                    console.error(`Error fetching tools from ${connectedClient.name}:`, error?.message || error);
            }
            try {
                const result = await connectedClient.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema);
                if (result.resources) result.resources.forEach((resource: Resource) => this.resourceToClientMap.set(resource.uri, connectedClient));
            } catch (error: any) {
                if (!(error?.name === 'McpError' && error?.code === -32601))
                    console.error(`Error fetching resources from ${connectedClient.name}:`, error?.message || error);
            }
            try {
                const result = await connectedClient.client.request({ method: 'prompts/list', params: {} }, ListPromptsResultSchema);
                if (result.prompts) result.prompts.forEach((prompt: Prompt) => this.promptToClientMap.set(prompt.name, connectedClient));
            } catch (error: any) {
                if (!(error?.name === 'McpError' && error?.code === -32601))
                    console.error(`Error fetching prompts from ${connectedClient.name}:`, error?.message || error);
            }
        }
        console.log("Backend connections update finished.");
    }

    public getCurrentProxyState() {
        const tools = Array.from(this.toolToClientMap.entries()).map(([_, { client: _c, toolInfo }]) => ({
            name: toolInfo.name, serverName: _c?.name || 'Unknown', description: toolInfo.description
        }));
        return { tools };
    }

    public async cleanup(): Promise<void> {
        await Promise.all(this.currentConnectedClients.map(async ({ name, cleanup: clientCleanup }) => {
            try { await clientCleanup(); console.log(`  Cleaned up client: ${name}`); }
            catch (error) { console.error(`  Error cleaning up client ${name}:`, error); }
        }));
        this.currentConnectedClients = [];
    }

    private async _handleListTools(request: z.infer<typeof ListToolsRequestSchema>): Promise<z.infer<typeof ListToolsResultSchema>> {
        const enabledTools: Tool[] = [];
        const toolOverrides = this.currentToolConfig.tools || {};
        for (const [originalQualifiedName, { toolInfo }] of this.toolToClientMap.entries()) {
            const overrideSettings = toolOverrides[originalQualifiedName];
            enabledTools.push({
                name: overrideSettings?.exposedName || originalQualifiedName,
                description: overrideSettings?.exposedDescription || toolInfo.description,
                inputSchema: toolInfo.inputSchema,
            });
        }
        return { tools: enabledTools };
    }

    private async _handleCallTool(request: z.infer<typeof CallToolRequestSchema>): Promise<z.infer<typeof CompatibilityCallToolResultSchema>> {
        const { name: requestedExposedName, arguments: args } = request.params;
        let originalQualifiedName: string | undefined;
        let mapEntry: { client: ConnectedClient, toolInfo: Tool } | undefined;
        const toolOverrides = this.currentToolConfig.tools || {};
        for (const [key, entry] of this.toolToClientMap.entries()) {
            const currentExposedName = (toolOverrides[key]?.exposedName || key);
            if (currentExposedName === requestedExposedName) {
                originalQualifiedName = key; mapEntry = entry; break;
            }
        }
        if (!mapEntry || !originalQualifiedName) throw new Error(`Unknown or disabled tool: ${requestedExposedName}`);
        const { client: clientForTool, toolInfo } = mapEntry;
        return clientForTool.client.request(
            { method: 'tools/call', params: { name: toolInfo.name, arguments: args || {}, _meta: request.params._meta }},
            CompatibilityCallToolResultSchema
        );
    }

    private async _handleGetPrompt(request: z.infer<typeof GetPromptRequestSchema>): Promise<z.infer<typeof GetPromptResultSchema>> {
        const clientForPrompt = this.promptToClientMap.get(request.params.name);
        if (!clientForPrompt) throw new Error(`Unknown prompt: ${request.params.name}`);
        return clientForPrompt.client.request(
            { method: 'prompts/get', params: request.params }, GetPromptResultSchema
        );
    }

    private async _handleListPrompts(request: z.infer<typeof ListPromptsRequestSchema>): Promise<z.infer<typeof ListPromptsResultSchema>> {
        const allPrompts: Prompt[] = Array.from(this.promptToClientMap.entries()).map(([name, connectedClient]) => ({
            name, description: `[${connectedClient.name}] Prompt`, inputSchema: {}
        }));
        return { prompts: allPrompts, nextCursor: undefined };
    }

    private async _handleListResources(request: z.infer<typeof ListResourcesRequestSchema>): Promise<z.infer<typeof ListResourcesResultSchema>> {
        const allResources: Resource[] = Array.from(this.resourceToClientMap.entries()).map(([uri, connectedClient]) => ({
            uri, name: `[${connectedClient.name}] Resource`, description: undefined, methods: []
        }));
        return { resources: allResources, nextCursor: undefined };
    }

    private async _handleReadResource(request: z.infer<typeof ReadResourceRequestSchema>): Promise<z.infer<typeof ReadResourceResultSchema>> {
        const clientForResource = this.resourceToClientMap.get(request.params.uri);
        if (!clientForResource) throw new Error(`Unknown resource: ${request.params.uri}`);
        return clientForResource.client.request(
            { method: 'resources/read', params: request.params }, ReadResourceResultSchema
        );
    }

    private async _handleListResourceTemplates(request: z.infer<typeof ListResourceTemplatesRequestSchema>): Promise<z.infer<typeof ListResourceTemplatesResultSchema>> {
        const allTemplates: ResourceTemplate[] = [];
        for (const connectedClient of this.currentConnectedClients) {
            try {
                const result = await connectedClient.client.request(
                    { method: 'resources/templates/list', params: request.params },
                    ListResourceTemplatesResultSchema
                );
                if (result.resourceTemplates) {
                    allTemplates.push(...result.resourceTemplates.map((template: ResourceTemplate) => ({
                        ...template, name: `[${connectedClient.name}] ${template.name || ''}`,
                        description: template.description ? `[${connectedClient.name}] ${template.description}` : undefined
                    })));
                }
            } catch (error: any) {
                if (!(error?.name === 'McpError' && error?.code === -32601))
                    console.error(`Error fetching resource templates from ${connectedClient.name}:`, error?.message || error);
            }
        }
        return { resourceTemplates: allTemplates, nextCursor: request.params?.cursor };
    }
}
