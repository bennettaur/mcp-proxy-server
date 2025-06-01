import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import crypto from 'crypto';

// SDK Types that are likely interfaces or type aliases
// Path reverted to /types/index.js
import type {
    McpMessageSchema,
    McpMessage,
    McpStreamChunk,
    McpStreamClose,
    McpStreamOpen,
    JSONRPCMessage,
    JSONRPCError
} from '@modelcontextprotocol/sdk/types/index.js';


// --- Authentication Configuration ---
const allowedKeysRaw = process.env.ALLOWED_KEYS || "";
const allowedKeys = new Set(allowedKeysRaw.split(',').map(k => k.trim()).filter(k => k.length > 0));

const allowedTokensRaw = process.env.ALLOWED_TOKENS || "";
const allowedTokens = new Set(allowedTokensRaw.split(',').map(t => t.trim()).filter(t => t.length > 0));

const authEnabled = allowedKeys.size > 0 || allowedTokens.size > 0;
console.log(`HttpService: MCP Endpoint Authentication: ${authEnabled ? `Enabled. ${allowedKeys.size} key(s) and ${allowedTokens.size} token(s) configured.` : 'Disabled.'}`);


export class HttpService {
    private _app: Express;
    private _httpServer: http.Server;
    private readonly _mcpServer: Server;
    private sseTransports: Map<string, SSEServerTransport> = new Map();
    private streamableHttpTransports: Map<string, StreamableHTTPServerTransport> = new Map();

    constructor(mcpServer: Server) {
        this._mcpServer = mcpServer;
        this._app = express();
        this._httpServer = http.createServer(this._app);

        this._initializeMiddleware();
        this._setupRoutes();
        this._serveStaticFiles();
    }

    private _initializeMiddleware(): void {
        this._app.use(express.json());
        this._app.use(express.urlencoded({ extended: true }));
    }

    private _serveStaticFiles(): void {
        this._app.use(express.static('public'));
        console.log("HttpService: Serving static files from 'public' directory.");
    }

    private _setupRoutes(): void {
        this._app.get('/sse', this._handleSse.bind(this));
        this._app.all('/mcp/:sessionId?', this._handleMcp.bind(this));
        this._app.post('/message/:sessionId?', this._handleMessage.bind(this));
    }

    private async _handleSse(req: Request, res: Response): Promise<void> {
        const clientId = req.ip || `client-sse-${Date.now()}`;
        console.log(`[${clientId}] HttpService: SSE connection received`);

        if (authEnabled) {
            let authenticated = false;
            const authHeader = req.headers['authorization'] as string | undefined;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring('Bearer '.length).trim();
                if (allowedTokens.has(token)) {
                    console.log(`[${clientId}] HttpService: Authorized SSE connection using Bearer Token.`);
                    authenticated = true;
                } else {
                    console.warn(`[${clientId}] HttpService: Unauthorized SSE (Bearer). Invalid Token.`);
                }
            }
            if (!authenticated && allowedKeys.size > 0) {
                const headerKey = req.headers['x-api-key'] as string | undefined;
                const queryKey = req.query.key as string | undefined;
                const providedKey = headerKey || queryKey;
                if (providedKey && allowedKeys.has(providedKey)) {
                    console.log(`[${clientId}] HttpService: Authorized SSE using ${headerKey ? 'header' : 'query'} API Key.`);
                    authenticated = true;
                } else if (providedKey) {
                    console.warn(`[${clientId}] HttpService: Unauthorized SSE (API Key). Invalid Key.`);
                }
            }
            if (!authenticated) {
                console.warn(`[${clientId}] HttpService: Unauthorized SSE. No valid credentials.`);
                res.status(401).send('Unauthorized');
                return;
            }
        }

        let clientTransport: SSEServerTransport | null = null;
        const sessionIdFromClientQuery = req.query.session_id as string | undefined;
        let actualTransportSessionId: string | undefined;

        try {
            if (sessionIdFromClientQuery && this.sseTransports.has(sessionIdFromClientQuery)) {
                console.log(`[${clientId}] HttpService: Client provided existing SSE session ID: ${sessionIdFromClientQuery}. Closing old one.`);
                const existingTransport = this.sseTransports.get(sessionIdFromClientQuery)!;
                this.sseTransports.delete(sessionIdFromClientQuery);
                if (typeof existingTransport.close === 'function') {
                    existingTransport.close().catch((err: Error) => console.warn(`[${clientId}] HttpService: Non-critical error closing existing SSE transport for session ${sessionIdFromClientQuery}:`, err));
                }
            }

            console.log(`[${clientId}] HttpService: Creating new SSEServerTransport for /sse...`);
            clientTransport = new SSEServerTransport("/message", res);
            actualTransportSessionId = clientTransport.sessionId;

            if (!actualTransportSessionId) {
                throw new Error("Failed to obtain session ID from new SSE transport instance.");
            }

            this.sseTransports.set(actualTransportSessionId, clientTransport);
            console.log(`[${clientId}] HttpService: New SSE transport created. Actual Session ID: ${actualTransportSessionId}. Client provided: ${sessionIdFromClientQuery || 'none'}. Active SSE: ${this.sseTransports.size}`);

            const currentTransport = clientTransport;
            const currentSessionId = actualTransportSessionId;

            currentTransport.onerror = (err: Error) => {
                console.error(`[${clientId}] HttpService: SSE transport error for session ${currentSessionId}: ${err?.stack || err?.message || err}`);
                if (this.sseTransports.has(currentSessionId)) {
                    this.sseTransports.delete(currentSessionId);
                    console.log(`[${clientId}] HttpService: SSE transport for session ${currentSessionId} removed due to error. Active SSE: ${this.sseTransports.size}`);
                }
            };

            currentTransport.onclose = () => {
                console.log(`[${clientId}] HttpService: SSE client disconnected for session ${currentSessionId}.`);
                if (this.sseTransports.has(currentSessionId)) {
                    this.sseTransports.delete(currentSessionId);
                    console.log(`[${clientId}] HttpService: SSE transport for session ${currentSessionId} removed on close. Active SSE: ${this.sseTransports.size}`);
                }
            };

            console.log(`[${clientId}] HttpService: Attempting _mcpServer.connect for new SSE transport with session ${currentSessionId}...`);
            await this._mcpServer.connect(currentTransport);
            console.log(`[${clientId}] HttpService: SSE client connected successfully via _mcpServer.connect for session ${currentSessionId}.`);

        } catch (error: any) {
            const logSessionIdOnError = actualTransportSessionId || sessionIdFromClientQuery || "unknown_sse_setup_error";
            console.error(`[${clientId}] HttpService: Failed during SSE setup or connection for session attempt ${logSessionIdOnError}:`, error);
            if (actualTransportSessionId && this.sseTransports.has(actualTransportSessionId)) {
                this.sseTransports.delete(actualTransportSessionId);
            }
            if (clientTransport && typeof clientTransport.close === 'function') {
                clientTransport.close().catch((e: any) => console.error(`[${clientId}] HttpService: Error closing SSE transport for session ${logSessionIdOnError} after failure:`, e));
            }
            if (!res.headersSent) {
                res.status(500).send('Failed to establish SSE connection');
            }
        }
    }

    private async _handleMcp(req: Request, res: Response): Promise<void> {
        const clientId = req.ip || `client-mcp-${Date.now()}`;
        console.log(`[${clientId}] HttpService: Received ${req.method} request on /mcp`);

        if (authEnabled) {
            let authenticated = false;
            const authHeader = req.headers['authorization'] as string | undefined;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.substring('Bearer '.length).trim();
                if (allowedTokens.has(token)) {
                    console.log(`[${clientId}] HttpService: Authorized /mcp (Bearer).`);
                    authenticated = true;
                } else {
                     console.warn(`[${clientId}] HttpService: Unauthorized /mcp (Bearer). Invalid Token.`);
                }
            }
            if (!authenticated && allowedKeys.size > 0) {
                const headerKey = req.headers['x-api-key'] as string | undefined;
                const queryKey = req.query.key as string | undefined;
                const providedKey = headerKey || queryKey;
                if (providedKey && allowedKeys.has(providedKey)) {
                    console.log(`[${clientId}] HttpService: Authorized /mcp (${headerKey ? 'header' : 'query'} API Key).`);
                    authenticated = true;
                } else if (providedKey) {
                     console.warn(`[${clientId}] HttpService: Unauthorized /mcp (API Key). Invalid Key.`);
                }
            }
            if (!authenticated) {
                console.warn(`[${clientId}] HttpService: Unauthorized /mcp. No valid credentials.`);
                res.status(401).send('Unauthorized');
                return;
            }
        }

        let httpTransport: StreamableHTTPServerTransport | undefined;
        const clientProvidedSessionId = req.headers['mcp-session-id'] as string | undefined || req.params.sessionId;
        let transportSessionIdToUse: string | undefined = clientProvidedSessionId;

        if (clientProvidedSessionId) {
            httpTransport = this.streamableHttpTransports.get(clientProvidedSessionId);
            if (!httpTransport) {
                console.warn(`[${clientId}] HttpService: /mcp: Client provided Mcp-Session-Id '${clientProvidedSessionId}', but no active transport. 404.`);
                if (!res.headersSent) {
                    res.status(404).json({
                        jsonrpc: "2.0",
                        error: { code: -32000, message: `Session not found: ${clientProvidedSessionId}` },
                        id: (req.body as any)?.id ?? null
                    });
                    return;
                }
                return;
            }
            console.log(`[${clientId}] HttpService: /mcp: Using existing transport for Mcp-Session-Id: ${clientProvidedSessionId}`);
        } else {
            console.log(`[${clientId}] HttpService: /mcp: No Mcp-Session-Id. Creating new StreamableHTTPServerTransport.`);
            const tempGeneratedIdForEarlyMap = `pending-mcp-${crypto.randomBytes(8).toString('hex')}`;
            let capturedHttpTransportInstance: StreamableHTTPServerTransport | null = null;

            const newTransportOptions: StreamableHTTPServerTransportOptions = {
                sessionIdGenerator: () => crypto.randomUUID(),
                enableJsonResponse: false,
                onsessioninitialized: (sdkGeneratedSessionId: string) => {
                    console.log(`[${clientId}] HttpService: /mcp: SDK 'onsessioninitialized'. SDK Session ID: ${sdkGeneratedSessionId}`);
                    if (capturedHttpTransportInstance) {
                        const finalSessionId = sdkGeneratedSessionId;
                        if (this.streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === capturedHttpTransportInstance) {
                            this.streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                            this.streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                             if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) transportSessionIdToUse = finalSessionId;
                            console.log(`[${clientId}] HttpService: /mcp: Transport map updated. Temp '${tempGeneratedIdForEarlyMap}' to final '${finalSessionId}'. Active MCP: ${this.streamableHttpTransports.size}`);
                        } else {
                             if (!this.streamableHttpTransports.has(finalSessionId) || this.streamableHttpTransports.get(finalSessionId) !== capturedHttpTransportInstance) {
                                this.streamableHttpTransports.set(finalSessionId, capturedHttpTransportInstance);
                                if (transportSessionIdToUse === tempGeneratedIdForEarlyMap) transportSessionIdToUse = finalSessionId;
                                console.log(`[${clientId}] HttpService: /mcp: Transport (re)added with final ID '${finalSessionId}'. Active MCP: ${this.streamableHttpTransports.size}`);
                             }
                        }
                    }
                },
            };

            httpTransport = new StreamableHTTPServerTransport(newTransportOptions);
            capturedHttpTransportInstance = httpTransport;
            transportSessionIdToUse = tempGeneratedIdForEarlyMap;
            this.streamableHttpTransports.set(tempGeneratedIdForEarlyMap, httpTransport);
            console.log(`[${clientId}] HttpService: /mcp: New transport created. Temp ID: ${tempGeneratedIdForEarlyMap}. Active MCP: ${this.streamableHttpTransports.size}`);

            const currentTransportForHandlers = httpTransport;
            currentTransportForHandlers.onerror = (error: Error) => {
                const idToClean = currentTransportForHandlers.sessionId || transportSessionIdToUse;
                console.error(`[${clientId}] HttpService: /mcp: Transport error for session ${idToClean}:`, error);
                if (this.streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) this.streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                if (currentTransportForHandlers.sessionId && this.streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) this.streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
                console.log(`[${clientId}] HttpService: /mcp: Transport for session ${idToClean} removed (error). Active MCP: ${this.streamableHttpTransports.size}`);
            };
            currentTransportForHandlers.onclose = () => {
                const idToClean = currentTransportForHandlers.sessionId || transportSessionIdToUse;
                console.log(`[${clientId}] HttpService: /mcp: Transport closed for session ${idToClean}.`);
                if (this.streamableHttpTransports.get(tempGeneratedIdForEarlyMap) === currentTransportForHandlers) this.streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                if (currentTransportForHandlers.sessionId && this.streamableHttpTransports.get(currentTransportForHandlers.sessionId) === currentTransportForHandlers) this.streamableHttpTransports.delete(currentTransportForHandlers.sessionId);
                console.log(`[${clientId}] HttpService: /mcp: Transport for session ${idToClean} removed (close). Active MCP: ${this.streamableHttpTransports.size}`);
            };

            try {
                await this._mcpServer.connect(currentTransportForHandlers);
                console.log(`[${clientId}] HttpService: /mcp: New transport (temp ID: ${transportSessionIdToUse}) connected to _mcpServer.`);
            } catch (connectError: any) {
                console.error(`[${clientId}] HttpService: /mcp: Failed to connect new transport:`, connectError);
                this.streamableHttpTransports.delete(tempGeneratedIdForEarlyMap);
                if (!res.headersSent) {
                    res.status(500).json({ jsonrpc: "2.0", error: { code: -32001, message: `MCP transport connection failed: ${connectError.message}` }, id: (req.body as any)?.id ?? null });
                    return;
                }
                return;
            }
        }

        if (!httpTransport) {
            console.error(`[${clientId}] HttpService: /mcp: Transport undefined before handleRequest.`);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: "2.0", error: { code: -32002, message: "MCP transport unavailable." }, id: (req.body as any)?.id ?? null });
                return;
            }
            return;
        }

        console.log(`[${clientId}] HttpService: /mcp: Calling transport.handleRequest for session ${transportSessionIdToUse || httpTransport.sessionId} - Method: ${req.method}`);
        try {
            await httpTransport.handleRequest(req, res, req.body);
            console.log(`[${clientId}] HttpService: /mcp: transport.handleRequest completed for session ${transportSessionIdToUse || httpTransport.sessionId}.`);
        } catch (error: any) {
            const idToLog = transportSessionIdToUse || httpTransport.sessionId;
            console.error(`[${clientId}] HttpService: /mcp: Error in transport.handleRequest for session ${idToLog}:`, error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: `MCP request error: ${error.message || error}` }, id: (req.body as any)?.id ?? null }) + '\n');
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    }

    private async _handleMessage(req: Request, res: Response): Promise<void> {
        const sessionId = req.params.sessionId || req.query.sessionId as string;
        const clientId = req.ip || `client-message-${Date.now()}`;
        console.log(`[${clientId}] HttpService: Received POST /message for Session ID: ${sessionId}`);

        if (!sessionId) {
            console.error(`[${clientId}] HttpService: POST /message error: Missing sessionId.`);
            res.status(400).send({ error: "Missing sessionId in path or query" });
            return;
        }

        const transport = this.sseTransports.get(sessionId);

        if (!transport) {
            console.error(`[${clientId}] HttpService: POST /message error: No active SSE transport for Session ID: ${sessionId}`);
            res.status(404).send({ error: `No active SSE session found for ID ${sessionId}` });
            return;
        }

        console.log(`[${clientId}] HttpService: Found SSE transport for session ${sessionId}. Handling POST message...`);
        try {
            await transport.handlePostMessage(req, res, req.body);
            console.log(`[${clientId}] HttpService: Successfully handled POST for SSE session ${sessionId}`);
        } catch (error: any) {
            console.error(`[${clientId}] HttpService: Error in SSE transport.handlePostMessage for session ${sessionId}:`, error);
            if (!res.headersSent) {
                res.status(500).send({ error: "Failed to process message via SSE transport" });
            }
        }
    }

    public start(port: number, hostname?: string): void {
        const callback = () => {
            console.log(`HttpService: Server running on port ${port}` + (hostname ? ` and hostname ${hostname}` : ''));
            console.log(`HttpService: SSE endpoint: http://${hostname || 'localhost'}:${port}/sse`);
            console.log(`HttpService: MCP (Streamable HTTP) endpoint: http://${hostname || 'localhost'}:${port}/mcp`);
        };
        if (hostname) {
            this._httpServer.listen(port, hostname, callback);
        } else {
            this._httpServer.listen(port, callback);
        }
    }

    public getExpressApp(): Express {
        return this._app;
    }

    public getHttpServer(): http.Server {
        return this._httpServer;
    }
}
