import express, { Express, Request, Response, NextFunction, Router } from 'express';
import session from 'express-session';
import { ServerResponse } from 'node:http';
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec as execCallback, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import { ProxyService } from '../core/ProxyService.js';
// Assuming ConfigService provides these and is correctly imported.
// If ConfigService itself needs to be instantiated or provides static methods for paths, adjust accordingly.
import { Config, ToolConfig, isStdioConfig, loadConfig, loadToolConfig } from '../core/ConfigService.js';

const exec = promisify(execCallback);

// Determine __dirname for ES modules
const __filename_url = import.meta.url;
const __filename = __filename_url.startsWith('file:') ? fileURLToPath(__filename_url) : __filename_url;
const __dirname = path.dirname(__filename);

// --- Admin UI Configuration ---
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const SESSION_SECRET_ENV = process.env.SESSION_SECRET;

// Read the ENABLE_ADMIN_UI environment variable.
const rawEnableAdminUI = process.env.ENABLE_ADMIN_UI;
const enableAdminUI = typeof rawEnableAdminUI === 'string' && (rawEnableAdminUI.toLowerCase() === 'true' || rawEnableAdminUI === '1' || rawEnableAdminUI.toLowerCase() === 'yes');

// Default paths - these could be made configurable via ConfigService in a more advanced setup
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');
const CONFIG_PATH = path.resolve(DEFAULT_CONFIG_DIR, 'mcp_server.json');
const TOOL_CONFIG_PATH = path.resolve(DEFAULT_CONFIG_DIR, 'tool_config.json');
const SECRET_FILE_PATH = path.resolve(DEFAULT_CONFIG_DIR, '.session_secret');
const PUBLIC_PATH = path.join(__dirname, '..', '..', 'public'); // Path to admin UI static files (e.g., index.html)

declare module 'express-session' {
    interface SessionData {
        user?: { username: string };
    }
}

export class AdminService {
    public router: Router;
    private readonly proxyService: ProxyService;
    private adminSseConnections: Map<string, ServerResponse>;

    constructor(proxyService: ProxyService) {
        this.proxyService = proxyService;

        this.router = Router();
        this.adminSseConnections = new Map();

        if (enableAdminUI) {
            console.log("AdminService: Admin UI is ENABLED. Initializing admin routes.");
            if (ADMIN_PASSWORD === 'password') {
                console.warn("AdminService: WARNING: Using default admin password. Set ADMIN_PASSWORD environment variable for security.");
            }
            this._setupRoutes();
        } else {
            console.log("AdminService: Admin UI is DISABLED. Admin routes will not be initialized.");
        }
    }

    private async _getSessionSecret(): Promise<string> {
        if (SESSION_SECRET_ENV && SESSION_SECRET_ENV !== 'unsafe-default-secret' && SESSION_SECRET_ENV.trim() !== '') {
            console.log("AdminService: Using session secret from SESSION_SECRET environment variable.");
            return SESSION_SECRET_ENV;
        }
        try {
            await access(SECRET_FILE_PATH);
            const secretFromFile = await readFile(SECRET_FILE_PATH, 'utf-8');
            if (secretFromFile.trim() !== '') {
                console.log("AdminService: Read existing session secret from file.");
                return secretFromFile.trim();
            }
            console.log("AdminService: Session secret file exists but is empty. Generating a new one...");
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                console.error("AdminService: Error accessing session secret file, attempting to generate new:", error);
            } else {
                console.log("AdminService: Session secret file not found. Generating a new one...");
            }
        }
        const newSecret = crypto.randomBytes(32).toString('hex');
        try {
            await mkdir(path.dirname(SECRET_FILE_PATH), { recursive: true });
            await writeFile(SECRET_FILE_PATH, newSecret, { encoding: 'utf-8', mode: 0o600 });
            console.log(`AdminService: New session secret generated and saved to ${SECRET_FILE_PATH}.`);
            return newSecret;
        } catch (writeError) {
            console.error("AdminService: FATAL: Could not write new session secret file:", writeError);
            console.warn("AdminService: WARNING: Falling back to a temporary, insecure session secret.");
            return 'temporary-insecure-secret-' + crypto.randomBytes(16).toString('hex');
        }
    }

    private _isAuthenticated(req: Request, res: Response, next: NextFunction): void {
        if (req.session.user) {
            next();
        } else {
            if (req.headers.accept?.includes('application/json')) {
                res.status(401).json({ error: 'Unauthorized' });
            } else {
                res.status(401).send('Unauthorized. Please login via the admin interface.');
            }
        }
    }

    private _setupRoutes(): void {
        this.router.post('/login', this._handleLogin.bind(this));
        this.router.post('/logout', this._handleLogout.bind(this));
        this.router.get('/config', this._isAuthenticated.bind(this), this._handleGetConfig.bind(this));
        this.router.post('/config', this._isAuthenticated.bind(this), this._handlePostConfig.bind(this));
        this.router.get('/tools/list', this._isAuthenticated.bind(this), this._handleListTools.bind(this));
        this.router.get('/tools/config', this._isAuthenticated.bind(this), this._handleGetToolConfig.bind(this));
        this.router.post('/tools/config', this._isAuthenticated.bind(this), this._handlePostToolConfig.bind(this));
        this.router.post('/server/reload', this._isAuthenticated.bind(this), this._handleServerReload.bind(this));
        this.router.post('/server/install/:serverKey', this._isAuthenticated.bind(this), this._handleServerInstall.bind(this));
        this.router.get('/environment', this._isAuthenticated.bind(this), this._handleGetEnvironment.bind(this));
        this.router.get('/sse/updates', this._isAuthenticated.bind(this), this._handleAdminSseUpdates.bind(this));
    }

    private _handleLogin(req: Request, res: Response): void {
        const { username, password } = req.body;
        if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
            req.session.user = { username: username };
            console.log(`AdminService: Admin user '${username}' logged in.`);
            res.json({ success: true });
        } else {
            console.warn(`AdminService: Failed admin login attempt for username: '${username}'`);
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
    }

    private _handleLogout(req: Request, res: Response): void {
        const username = req.session.user?.username;
        req.session.destroy((err) => {
            if (err) {
                console.error("AdminService: Error destroying session:", err);
                res.status(500).json({ success: false, error: 'Failed to logout' });
                return;
            }
            console.log(`AdminService: Admin user '${username}' logged out.`);
            res.clearCookie('connect.sid');
            res.json({ success: true });
        });
    }

    private async _handleGetConfig(req: Request, res: Response): Promise<void> {
        try {
            console.log("AdminService: GET /admin/config");
            const configData = await readFile(CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(configData);
        } catch (error: any) {
            console.error(`AdminService: Error reading config file at ${CONFIG_PATH}:`, error);
            if (error.code === 'ENOENT') {
                res.status(404).json({ error: 'Configuration file not found.' });
            } else {
                res.status(500).json({ error: 'Failed to read configuration file.' });
            }
        }
    }

    private async _handlePostConfig(req: Request, res: Response): Promise<void> {
        try {
            console.log("AdminService: POST /admin/config");
            const newConfigData = req.body;
            if (typeof newConfigData !== 'object' || newConfigData === null) {
                res.status(400).json({ error: 'Invalid configuration format: Expected a JSON object.' });
                return;
            }
            const configString = JSON.stringify(newConfigData, null, 2);
            await writeFile(CONFIG_PATH, configString, 'utf-8');
            console.log(`AdminService: Configuration file updated by admin '${req.session.user?.username}'.`);
            res.json({ success: true });
        } catch (error) {
            console.error(`AdminService: Error writing config file at ${CONFIG_PATH}:`, error);
            res.status(500).json({ error: 'Failed to write configuration file.' });
        }
    }

    private async _handleListTools(req: Request, res: Response): Promise<void> {
        console.log("AdminService: GET /admin/tools/list");
        try {
            const { tools } = this.proxyService.getCurrentProxyState();
            console.log(`AdminService: Returning ${tools.length} tools from proxy state.`);
            res.json({ tools });
        } catch (error: any) {
            console.error(`AdminService: Error getting proxy state for tools/list:`, error?.message || error);
            res.status(500).json({ error: 'Failed to retrieve tool list from proxy state.' });
        }
    }

    private async _handleGetToolConfig(req: Request, res: Response): Promise<void> {
        try {
            console.log("AdminService: GET /admin/tools/config");
            const toolConfigData = await readFile(TOOL_CONFIG_PATH, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.send(toolConfigData);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`AdminService: Tool config file ${TOOL_CONFIG_PATH} not found, returning empty config.`);
                res.json({ tools: {} });
            } else {
                console.error(`AdminService: Error reading tool config file at ${TOOL_CONFIG_PATH}:`, error);
                res.status(500).json({ error: 'Failed to read tool configuration file.' });
            }
        }
    }

    private async _handlePostToolConfig(req: Request, res: Response): Promise<void> {
        try {
            console.log("AdminService: POST /admin/tools/config");
            const newToolConfigData = req.body;
            if (typeof newToolConfigData !== 'object' || newToolConfigData === null || typeof newToolConfigData.tools !== 'object') {
                res.status(400).json({ error: 'Invalid tool configuration format: Expected { "tools": { ... } }.' });
                return;
            }
            const configString = JSON.stringify(newToolConfigData, null, 2);
            await writeFile(TOOL_CONFIG_PATH, configString, 'utf-8');
            console.log(`AdminService: Tool configuration file updated by admin '${req.session.user?.username}'.`);
            res.json({ success: true, message: "Tool configuration saved. Use 'Reload Server Configuration' to apply changes." });
        } catch (error) {
            console.error(`AdminService: Error writing tool config file at ${TOOL_CONFIG_PATH}:`, error);
            res.status(500).json({ error: 'Failed to write tool configuration file.' });
        }
    }

    private async _handleServerReload(req: Request, res: Response): Promise<void> {
        console.log(`AdminService: POST /admin/server/reload by user '${req.session.user?.username}'`);
        try {
            const latestServerConfig = await loadConfig(); // Use imported function
            const latestToolConfig = await loadToolConfig(); // Use imported function
            await this.proxyService.updateBackendConnections(latestServerConfig, latestToolConfig);
            console.log("AdminService: Configuration reload completed successfully.");
            res.json({ success: true, message: 'Server configuration reloaded successfully.' });
        } catch (error: any) {
            console.error("AdminService: Error during configuration reload:", error);
            res.status(500).json({ success: false, error: 'Failed to reload server configuration.', details: error.message });
        }
    }

    private async _handleServerInstall(req: Request, res: Response): Promise<void> {
        const serverKey = req.params.serverKey;
        const adminSessionId = req.session.id;
        const clientId = req.ip || `admin-install-${Date.now()}`;

        console.log(`[${clientId}] AdminService: POST /admin/server/install/${serverKey} for session ${adminSessionId}`);
        res.json({ success: true, message: `Installation process for '${serverKey}' started. Check for live updates via Admin SSE.` });

        (async () => {
            const adminSseRes = this.adminSseConnections.get(adminSessionId);
            const sendAdminSseEvent = (event: string, data: any) => {
                if (adminSseRes && !adminSseRes.writableEnded) {
                    try { adminSseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
                    catch (e) { console.error(`[${clientId}] AdminService: Failed to send admin SSE event ${event} for session ${adminSessionId}:`, e); }
                } else if (adminSessionId) {
                    console.warn(`[${clientId}] AdminService: No active admin SSE connection for session ${adminSessionId} to send event ${event}.`);
                }
            };

            try {
                const config = await loadConfig(); // Use imported function
                const serverConfig = config.mcpServers[serverKey];

                if (!serverConfig) throw new Error(`Server configuration not found for key: ${serverKey}`);
                if (!isStdioConfig(serverConfig)) throw new Error(`Installation commands only supported for stdio servers.`);

                const { installDirectory, installCommands } = serverConfig;
                let absoluteInstallDir: string;
                const toolsFolderEnv = process.env.TOOLS_FOLDER;

                if (installDirectory) absoluteInstallDir = path.resolve(installDirectory);
                else if (toolsFolderEnv?.trim()) absoluteInstallDir = path.resolve(toolsFolderEnv.trim(), serverKey);
                else absoluteInstallDir = path.resolve(process.cwd(), 'tools', serverKey);

                sendAdminSseEvent('install_info', { serverKey, message: `Target server directory: ${absoluteInstallDir}` });
                const executionCwd = path.dirname(absoluteInstallDir);
                sendAdminSseEvent('install_info', { serverKey, message: `Install commands CWD: ${executionCwd}` });

                await mkdir(executionCwd, { recursive: true });
                sendAdminSseEvent('install_info', { serverKey, message: `Ensured execution directory exists: ${executionCwd}` });

                try {
                    await access(absoluteInstallDir);
                    sendAdminSseEvent('install_info', { serverKey, message: `Target directory '${absoluteInstallDir}' already exists. Skipping install commands.` });
                    sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Already installed." });
                    return;
                } catch (error: any) { if (error.code !== 'ENOENT') throw error; }

                sendAdminSseEvent('install_info', { serverKey, message: `Target directory '${absoluteInstallDir}' does not exist. Proceeding...` });
                const commandsToRun = installCommands && Array.isArray(installCommands) ? installCommands : [];
                if (commandsToRun.length > 0) {
                    for (const command of commandsToRun) {
                        sendAdminSseEvent('install_info', { serverKey, message: `Executing: ${command}` });
                        const child = spawn(command.split(' ')[0], command.split(' ').slice(1), { shell: true, cwd: executionCwd, stdio: ['ignore', 'pipe', 'pipe'] });
                        child.stdout.on('data', (data) => sendAdminSseEvent('install_stdout', { serverKey, output: data.toString() }));
                        child.stderr.on('data', (data) => sendAdminSseEvent('install_stderr', { serverKey, output: data.toString() }));
                        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
                        if (exitCode !== 0) throw new Error(`Command "${command}" failed with exit code ${exitCode}.`);
                        sendAdminSseEvent('install_info', { serverKey, message: `Command "${command}" completed.` });
                    }
                } else sendAdminSseEvent('install_info', { serverKey, message: `No installation commands provided.` });

                try { await access(absoluteInstallDir); }
                catch (e: any) {
                    if (e.code === 'ENOENT') {
                        sendAdminSseEvent('install_info', { serverKey, message: `Target server directory ${absoluteInstallDir} not found after commands. Creating directory now.` });
                        await mkdir(absoluteInstallDir, { recursive: true });
                    } else throw e;
                }
                sendAdminSseEvent('install_info', { serverKey, message: `Confirmed target server directory exists: ${absoluteInstallDir}` });
                sendAdminSseEvent('install_complete', { serverKey, code: 0, message: "Installation process completed successfully." });
            } catch (error: any) {
                console.error(`[${clientId}] AdminService: Error during server install for '${serverKey}':`, error);
                sendAdminSseEvent('install_error', { serverKey, error: `Installation failed: ${error.message}` });
            }
        })();
    }

    private _handleGetEnvironment(req: Request, res: Response): void {
        res.json({ toolsFolder: process.env.TOOLS_FOLDER || "" });
    }

    private _handleAdminSseUpdates(req: Request, res: Response): void {
        const sessionId = req.session.id;
        if (!sessionId) {
            res.status(400).send("Session not found for Admin SSE.");
            // No return here, as send() ends the response.
            return;
        }
        console.log(`AdminService: Admin SSE connection received for session: ${sessionId}`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive' });
        res.write(`event: connected\ndata: ${JSON.stringify({ message: "Admin SSE connected" })}\n\n`);
        this.adminSseConnections.set(sessionId, res);
        req.on('close', () => {
            this.adminSseConnections.delete(sessionId);
            console.log(`AdminService: Admin SSE connection closed for session ${sessionId}. Total: ${this.adminSseConnections.size}`);
        });
    }

    private async _initSessions(app: Express): Promise<void> {
        const sessionSecret = await this._getSessionSecret();
        app.use(session({
            secret: sessionSecret,
            resave: false,
            saveUninitialized: false,
            cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 } // 24 hours
        }));
        console.log("AdminService: Session middleware initialized.");
    }

    private _mountAdminUI(app: Express): void {
        console.log(`AdminService: Serving static admin files from: ${PUBLIC_PATH}`);
        // Serve static files for the admin UI (e.g., index.html, css, js)
        // These are accessed under the /admin path.
        this.router.use(express.static(PUBLIC_PATH));

        // Redirect /admin and /admin/ to /admin/index.html
        // This ensures that navigating to the base /admin path serves the UI's entry point.
        this.router.get('/', (req, res) => res.redirect('/admin/index.html'));
        this.router.get('', (req, res) => res.redirect('/admin/index.html')); // Handles /admin (no trailing slash)


        app.use('/admin', this.router); // Mount all admin routes under /admin
        console.log("AdminService: Admin UI and routes mounted on /admin.");
    }

    public async init(app: Express): Promise<void> {
        if (enableAdminUI) {
            await this._initSessions(app); // Setup session middleware first
            this._mountAdminUI(app);      // Then mount the admin UI and router
        } else {
            console.log("AdminService: Admin UI is disabled. Skipping full initialization.");
        }
    }
}
