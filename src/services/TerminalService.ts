import os from 'os';
import pty, { IPty } from 'node-pty'; // Correctly import IPty
import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { ServerResponse } from 'node:http';

// --- Constants ---
const PTY_PROCESS_TIMEOUT_MS = 1000 * 60 * 60; // 1 hour
const MAX_BUFFER_LENGTH = 200; // Max number of lines/chunks to buffer for initial output

// --- Interface ---
export interface ActiveTerminal {
    id: string;
    ptyProcess: IPty;
    lastActivityTime: number;
    initialOutputBuffer: string[]; // Renamed from buffer, and it's an array of strings
    name?: string;
}

export class TerminalService {
    public router: Router;
    private activeTerminals: Map<string, ActiveTerminal>;
    private terminalOutputSseConnections: Map<string, ServerResponse>;
    private readonly shell: string;
    private cleanupInterval: NodeJS.Timeout;

    constructor() {
        this.router = Router();
        this.activeTerminals = new Map();
        this.terminalOutputSseConnections = new Map();

        this.shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        console.log(`TerminalService: Using shell: ${this.shell}`);

        this._setupRoutes();
        this.cleanupInterval = setInterval(this._cleanupInactiveTerminals.bind(this), PTY_PROCESS_TIMEOUT_MS / 2); // Check twice per timeout period
        console.log("TerminalService: Initialized and cleanup interval started.");
    }

    private _setupRoutes(): void {
        this.router.post('/start', this._handleStartTerminal.bind(this));
        this.router.post('/:termId/input', this._handleTerminalInput.bind(this));
        this.router.post('/:termId/resize', this._handleTerminalResize.bind(this));
        this.router.delete('/:termId', this._handleKillTerminal.bind(this));
        this.router.get('/:termId/output', this._handleTerminalOutputSse.bind(this));
        this.router.get('/list', this._handleListTerminals.bind(this));
    }

    private _startPtyProcess(name?: string): ActiveTerminal {
        const termId = crypto.randomUUID(); // Use UUID for better uniqueness
        const ptyProcess = pty.spawn(this.shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd: process.env.HOME || process.cwd(),
            env: process.env as { [key: string]: string }
        });

        const terminal: ActiveTerminal = {
            id: termId,
            ptyProcess,
            lastActivityTime: Date.now(),
            initialOutputBuffer: [], // Initialize as empty array
            name: name || `Terminal ${termId.substring(0, 6)}`
        };

        this.activeTerminals.set(termId, terminal);
        console.log(`TerminalService: PTY process created with ID: ${termId}, PID: ${ptyProcess.pid}, Name: ${terminal.name}`);

        ptyProcess.onData((data: string) => {
            terminal.lastActivityTime = Date.now();
            const sseRes = this.terminalOutputSseConnections.get(termId);

            if (sseRes && !sseRes.writableEnded) {
                if (terminal.initialOutputBuffer.length > 0) {
                    console.log(`TerminalService [${termId}]: Flushing ${terminal.initialOutputBuffer.length} buffered items to SSE.`);
                    terminal.initialOutputBuffer.forEach(bufferedData => {
                        try { sseRes.write(`event: output\ndata: ${JSON.stringify(bufferedData)}\n\n`); }
                        catch (e) { console.error(`TerminalService [${termId}]: Error writing buffered data to SSE:`, e); }
                    });
                    terminal.initialOutputBuffer = [];
                }
                try { sseRes.write(`event: output\ndata: ${JSON.stringify(data)}\n\n`); }
                catch (e) { console.error(`TerminalService [${termId}]: Error writing live data to SSE:`, e); }
            } else {
                terminal.initialOutputBuffer.push(data);
                if (terminal.initialOutputBuffer.length > MAX_BUFFER_LENGTH) {
                    terminal.initialOutputBuffer.shift();
                }
            }
        });

        ptyProcess.onExit(({ exitCode, signal }: { exitCode: number, signal?: number }) => {
            console.log(`TerminalService [${termId}]: PTY process exited with code ${exitCode}, signal ${signal}`);
            const sseRes = this.terminalOutputSseConnections.get(termId);
            if (sseRes && !sseRes.writableEnded) {
                try {
                    sseRes.write(`event: exit\ndata: ${JSON.stringify({ exitCode, signal })}\n\n`);
                    sseRes.end();
                } catch (e) { console.error(`TerminalService [${termId}]: Error writing exit event to SSE:`, e); }
            }
            this.terminalOutputSseConnections.delete(termId);
            this.activeTerminals.delete(termId);
            console.log(`TerminalService [${termId}]: Cleaned up terminal and SSE connection.`);
        });
        return terminal;
    }

    private _writeToPty(termId: string, data: string): boolean {
        const terminal = this.activeTerminals.get(termId);
        if (terminal) {
            terminal.ptyProcess.write(data);
            terminal.lastActivityTime = Date.now();
            return true;
        }
        return false;
    }

    private _resizePty(termId: string, cols: number, rows: number): boolean {
        const terminal = this.activeTerminals.get(termId);
        if (terminal) {
            try {
                const safeCols = Math.max(1, Math.floor(cols));
                const safeRows = Math.max(1, Math.floor(rows));
                terminal.ptyProcess.resize(safeCols, safeRows);
                terminal.lastActivityTime = Date.now();
                console.log(`TerminalService [${termId}]: Resized to ${safeCols}x${safeRows}`);
                return true;
            } catch (e) {
                console.error(`TerminalService [${termId}]: Error resizing PTY:`, e);
                return false;
            }
        }
        return false;
    }

    private _killPty(termId: string): boolean {
        const terminal = this.activeTerminals.get(termId);
        if (terminal) {
            console.log(`TerminalService [${termId}]: Killing PTY process (PID: ${terminal.ptyProcess.pid})`);
            terminal.ptyProcess.kill(); // This will trigger the onExit handler for cleanup
            return true;
        }
        return false;
    }

    private _cleanupInactiveTerminals(): void {
        const now = Date.now();
        console.log("TerminalService: Running cleanup for inactive terminals...");
        this.activeTerminals.forEach((terminal, termId) => {
            if (now - terminal.lastActivityTime > PTY_PROCESS_TIMEOUT_MS) {
                console.log(`TerminalService [${termId}]: PTY process timed out due to inactivity. Killing.`);
                this._killPty(termId); // Use the internal method
            }
        });
    }

    private _handleStartTerminal(req: Request, res: Response): void {
        try {
            const { name } = req.body; // Optional name from request body
            const terminal = this._startPtyProcess(name);
            res.status(200).json({ id: terminal.id, name: terminal.name, shell: this.shell });
        } catch (e: any) {
            console.error("TerminalService: Error starting PTY process:", e);
            res.status(500).json({ error: 'Failed to start terminal session.', details: e.message });
        }
    }

    private _handleTerminalInput(req: Request, res: Response): void {
        const { termId } = req.params;
        const { input } = req.body;
        if (typeof input !== 'string') {
            res.status(400).json({ error: 'Invalid input data. Expecting { "input": "string" }.' });
            return;
        }
        if (this._writeToPty(termId, input)) {
            res.status(200).json({ success: true });
        } else {
            res.status(404).json({ error: `Terminal session not found: ${termId}` });
        }
    }

    private _handleTerminalResize(req: Request, res: Response): void {
        const { termId } = req.params;
        const { cols, rows } = req.body;
        if (typeof cols !== 'number' || typeof rows !== 'number' || cols <= 0 || rows <= 0) {
            res.status(400).json({ error: 'Invalid size data. Expecting { "cols": number, "rows": number }.' });
            return;
        }
        if (this._resizePty(termId, cols, rows)) {
            res.status(200).json({ success: true });
        } else {
            res.status(404).json({ error: `Terminal session not found: ${termId}` });
        }
    }

    private _handleKillTerminal(req: Request, res: Response): void {
        const { termId } = req.params;
        if (this._killPty(termId)) {
            res.status(200).json({ success: true, message: `Terminal session ${termId} killed.` });
        } else {
            res.status(404).json({ error: `Terminal session not found: ${termId}` });
        }
    }

    private _handleTerminalOutputSse(req: Request, res: Response): void {
        const { termId } = req.params;
        const terminal = this.activeTerminals.get(termId);

        if (!terminal) {
            res.status(404).json({ error: `Terminal session not found: ${termId}` });
            return;
        }

        if (this.terminalOutputSseConnections.has(termId)) {
            console.warn(`TerminalService [${termId}]: Attempted duplicate SSE output stream. Closing old one.`);
            const oldSseRes = this.terminalOutputSseConnections.get(termId);
            try { oldSseRes?.end(); } catch (e) { /* ignore */ }
            this.terminalOutputSseConnections.delete(termId);
        }

        console.log(`TerminalService [${termId}]: SSE output stream connection received.`);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ message: `Connected to terminal ${termId} output`, name: terminal.name })}\n\n`);
        this.terminalOutputSseConnections.set(termId, res);

        if (terminal.initialOutputBuffer.length > 0) {
            console.log(`TerminalService [${termId}]: Flushing initial output buffer (${terminal.initialOutputBuffer.length} items) to new SSE.`);
            terminal.initialOutputBuffer.forEach(bufferedData => {
                try { if (!res.writableEnded) res.write(`event: output\ndata: ${JSON.stringify(bufferedData)}\n\n`); }
                catch (e) { console.error(`TerminalService [${termId}]: Error writing initial buffered data to SSE:`, e); }
            });
            terminal.initialOutputBuffer = [];
        }

        req.on('close', () => {
            console.log(`TerminalService [${termId}]: SSE output stream connection closed by client.`);
            this.terminalOutputSseConnections.delete(termId);
        });
    }

    private _handleListTerminals(req: Request, res: Response): void {
        const terms = Array.from(this.activeTerminals.values()).map(t => ({
            id: t.id,
            name: t.name,
            pid: t.ptyProcess.pid,
            lastActivity: t.lastActivityTime,
            bufferSize: t.initialOutputBuffer.length
        }));
        res.json({ terminals: terms });
    }

    public getRouter(): Router {
        return this.router;
    }

    public shutdown(): void {
        console.log("TerminalService: Shutting down all active terminals...");
        clearInterval(this.cleanupInterval);
        this.activeTerminals.forEach(term => {
            try {
                console.log(`TerminalService: Killing PTY process ${term.id} (PID: ${term.ptyProcess.pid}, Name: ${term.name})`);
                term.ptyProcess.kill();
            } catch (e) {
                console.warn(`TerminalService: Error killing PTY process ${term.id}:`, e);
            }
        });
        this.activeTerminals.clear();
        this.terminalOutputSseConnections.forEach(sseRes => {
            try { sseRes.end(); } catch (e) { /* ignore */ }
        });
        this.terminalOutputSseConnections.clear();
        console.log("TerminalService: All terminals shut down and connections cleared.");
    }
}
