import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { writeToPTY, resizePTY, onPTYData, onPTYExit, getLocalSize } from './pty';

let httpServer: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let connectedClients: Map<WebSocket, { cols: number; rows: number; id: string; asrWs?: any }> = new Map();

// PIN authentication state
let serverPIN: string = '';
let failedAttempts: Map<string, number> = new Map();
let blockedIPs: Set<string> = new Set();
const MAX_FAILED_ATTEMPTS = 10;
const BLOCK_DURATION = 60000; // 1 minute in milliseconds

// Terminal output buffer for new connections
let outputBuffer: string[] = [];
const MAX_BUFFER_SIZE = 5000;

// Generate unique client ID
let clientIdCounter = 0;
function generateClientId(): string {
    return `client-${Date.now()}-${++clientIdCounter}`;
}

// Calculate minimum size across all connected clients and local terminal
function calculateMinSize(): { cols: number; rows: number } {
    const local = getLocalSize();
    let minCols = local.cols;
    let minRows = local.rows;

    // Find minimum dimensions across all connected clients
    connectedClients.forEach((clientInfo) => {
        if (clientInfo.cols > 0 && clientInfo.rows > 0) {
            minCols = Math.min(minCols, clientInfo.cols);
            minRows = Math.min(minRows, clientInfo.rows);
        }
    });

    return { cols: minCols, rows: minRows };
}

// Apply minimum size to PTY
function applyMinSize(): void {
    if (connectedClients.size === 0) {
        // No web clients, use local size
        const local = getLocalSize();
        resizePTY(local.cols, local.rows);
        return;
    }

    const { cols, rows } = calculateMinSize();
    if (cols > 0 && rows > 0) {
        resizePTY(cols, rows);
        // Silently resize PTY to minimum dimensions
    }
}

/**
 * Get client IP address from request
 */
function getClientIP(req: express.Request): string {
    return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

/**
 * Check if IP is blocked
 */
function isIPBlocked(ip: string): boolean {
    return blockedIPs.has(ip);
}

/**
 * Check if user is authenticated via cookie
 */
function isAuthenticated(req: express.Request): boolean {
    return req.cookies && req.cookies.auth === serverPIN;
}

/**
 * PIN authentication middleware
 */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const clientIP = getClientIP(req);

    // Check if IP is blocked
    if (isIPBlocked(clientIP)) {
        res.status(429).json({ error: 'IP blocked due to too many failed attempts' });
        return;
    }

    // Check if authenticated
    if (isAuthenticated(req)) {
        next();
        return;
    }

    // Not authenticated, redirect to login
    if (req.path === '/login' || req.path === '/api/login') {
        next();
        return;
    }

    res.redirect('/login');
}

/**
 * Generate login page HTML
 */
function generateLoginPage(): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>gogogo - Enter PIN</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #fff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: #1a1a1a;
            padding: 2rem;
            border-radius: 12px;
            border: 1px solid #333;
            max-width: 400px;
            width: 100%;
            margin: 1rem;
        }
        .logo {
            text-align: center;
            margin-bottom: 2rem;
        }
        .logo h1 {
            color: #3b82f6;
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
        }
        .logo p {
            color: #888;
            font-size: 0.9rem;
        }
        .form-group {
            margin-bottom: 1.5rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            color: #ccc;
        }
        input[type="text"] {
            width: 100%;
            padding: 0.75rem;
            background: #0a0a0a;
            border: 1px solid #333;
            border-radius: 6px;
            color: #fff;
            font-size: 1.1rem;
            text-align: center;
            letter-spacing: 0.1em;
        }
        input[type="text"]:focus {
            outline: none;
            border-color: #3b82f6;
        }
        .submit-btn {
            width: 100%;
            padding: 0.75rem;
            background: #3b82f6;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 1rem;
            cursor: pointer;
            transition: background 0.2s;
        }
        .submit-btn:hover {
            background: #2563eb;
        }
        .submit-btn:disabled {
            background: #555;
            cursor: not-allowed;
        }
        .error {
            color: #ef4444;
            font-size: 0.9rem;
            margin-top: 0.5rem;
            text-align: center;
        }
        .info {
            color: #888;
            font-size: 0.8rem;
            text-align: center;
            margin-top: 1rem;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo">
            <h1>🚀 gogogo</h1>
            <p>Enter your 6-digit PIN to access the terminal</p>
        </div>

        <form id="loginForm">
            <div class="form-group">
                <label for="pin">PIN</label>
                <input type="text" id="pin" name="pin" placeholder="000000" maxlength="6" required autocomplete="off">
            </div>
            <button type="submit" class="submit-btn">Access Terminal</button>
            <div id="error-message" class="error"></div>
        </form>

        <div class="info">
            The PIN was displayed when the server started.
        </div>
    </div>

    <script>
        const form = document.getElementById('loginForm');
        const pinInput = document.getElementById('pin');
        const errorDiv = document.getElementById('error-message');
        const submitBtn = form.querySelector('.submit-btn');

        // Auto-focus on PIN input
        pinInput.focus();

        // Allow only digits
        pinInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const pin = pinInput.value.trim();

            if (pin.length !== 6) {
                errorDiv.textContent = 'PIN must be exactly 6 digits';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying...';
            errorDiv.textContent = '';

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });

                const result = await response.json();

                if (response.ok) {
                    // Success - redirect to main page
                    window.location.href = '/';
                } else {
                    errorDiv.textContent = result.error || 'Authentication failed';
                    pinInput.value = '';
                    pinInput.focus();
                }
            } catch (error) {
                errorDiv.textContent = 'Network error. Please try again.';
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Access Terminal';
            }
        });
    </script>
</body>
</html>`;
}

export interface WebServerOptions {
    debugAsr?: boolean;
}

// ASR debug logging flag
let debugAsrEnabled = false;

// Helper function for ASR debug logging
function asrLog(...args: any[]): void {
    if (debugAsrEnabled) {
        console.log(...args);
    }
}

// Process transcript with Claude API
async function processWithClaude(ws: WebSocket, transcript: string, context: string, apiKey: string, model: string): Promise<void> {
    asrLog('[Claude] Processing transcript with Claude API');
    asrLog('[Claude] Transcript:', transcript);
    asrLog('[Claude] Context length:', context?.length || 0);
    asrLog('[Claude] Model:', model);

    try {
        const systemPrompt = `You are a speech-to-text correction assistant for a terminal/coding environment. Your ONLY job is to fix transcription errors based on context and common sense.

IMPORTANT: Common technical terms that are often misrecognized:
- "Claude" (AI assistant by Anthropic) is often mistranscribed as "cloud", "克劳德", or "科劳德"
- "Claude Code" (coding assistant) is often mistranscribed as "cloud code"
- "Claude API" is often mistranscribed as "cloud API" or "cloud的API"
- "API" not "a p i" or "ap i"
- "npm" not "n p m"
- "git" not "get"
- "GitHub" not "get hub"
- "Docker" not "doctor"
- "webpack" not "web pack"
- "React" not "react" (capitalize)
- "Vue" not "view"
- "VS Code" not "vs coat" or "vscode"
- "Python" not "python" (capitalize properly)
- "JavaScript" not "java script"
- "TypeScript" not "type script"
- "terminal" (终端) not "terminal" when speaking Chinese
- Terminal commands: ls, cd, pwd, mkdir, rm, grep, cat, echo, etc.

Correction Rules:
1. Fix obvious transcription errors based on context (especially tech terms above)
2. Remove filler words ONLY: um, uh, er, ah, well, 嗯, 呃, 那个, 就是
3. Fix spacing and punctuation errors
4. DO NOT change sentence structure or meaning
5. DO NOT convert natural language to commands unless explicitly a command
6. Keep user's original intent and wording
7. When you see "cloud" in contexts about AI, coding, or APIs, it's likely "Claude"

ABSOLUTE OUTPUT REQUIREMENT:
- Output ONLY the corrected text itself
- NO explanations, NO parentheses, NO annotations
- NO text like "(Minor correction: ...)" or "(Note: ...)"
- NO meta-commentary about what you changed
- Just return the clean, corrected text and nothing else
- If the input is "xxxxx", output should be "xxxxx" NOT "xxxxx (some explanation)"
- If the input is empty, blank, or contains no meaningful speech, output a single space character " " and nothing else
- NEVER output phrases like "[empty string - no output]" or "[no speech detected]" - just output a space

Terminal context (helps identify what user is working on):
${context || ''}`;

        const userMessage = `Transcribed speech: "${transcript}"

Output the corrected text only, with no explanations or parenthetical notes.`;

        // Use dynamic import for axios
        const axios = (await import('axios')).default;

        asrLog('[Claude] Sending request to Claude API...');

        const response = await axios({
            method: 'POST',
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            data: {
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: userMessage
                    }
                ],
                system: systemPrompt,
                max_tokens: 1000,
                stream: true
            },
            responseType: 'stream'
        });

        asrLog('[Claude] Received streaming response');

        // Process streaming response
        let buffer = '';
        response.data.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        ws.send(JSON.stringify({
                            type: 'claude_response',
                            data: { done: true }
                        }));
                        continue;
                    }

                    try {
                        const event = JSON.parse(data);
                        if (event.type === 'content_block_delta' && event.delta?.text) {
                            // Stream text to client
                            ws.send(JSON.stringify({
                                type: 'claude_response',
                                data: { text: event.delta.text }
                            }));
                        }
                    } catch (e) {
                        // Ignore JSON parse errors
                    }
                }
            }
        });

        response.data.on('end', () => {
            asrLog('[Claude] Streaming complete');
            ws.send(JSON.stringify({
                type: 'claude_response',
                data: { done: true }
            }));
        });

        response.data.on('error', (error: any) => {
            console.error('[Claude] Stream error:', error);
            ws.send(JSON.stringify({
                type: 'claude_response',
                data: { error: error.message, fallback: transcript }
            }));
        });

    } catch (error: any) {
        console.error('[Claude] API error:', error.message);
        if (error.response) {
            console.error('[Claude] Response status:', error.response.status);
            console.error('[Claude] Response data:', error.response.data);
        }
        // Send error to client with fallback
        ws.send(JSON.stringify({
            type: 'claude_response',
            data: { error: error.message, fallback: transcript }
        }));
    }
}

export function startWebServer(port: number, pin?: string, options: WebServerOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        // Set the server PIN
        serverPIN = pin || '';

        // Set ASR debug logging flag
        debugAsrEnabled = options.debugAsr || false;
        if (debugAsrEnabled) {
            console.log('[ASR] Debug logging enabled');
        }

        // Reset authentication state
        failedAttempts.clear();
        blockedIPs.clear();

        const app = express();

        // Trust proxy for getting real client IP
        app.set('trust proxy', true);

        app.use(cors());
        app.use(cookieParser());
        app.use(express.json());

        // Health check (no auth required)
        app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', timestamp: Date.now() });
        });

        // Login page
        app.get('/login', (req, res) => {
            if (serverPIN && !isAuthenticated(req)) {
                res.send(generateLoginPage());
            } else {
                res.redirect('/');
            }
        });

        // Login API
        app.post('/api/login', (req, res) => {
            const { pin } = req.body;
            const clientIP = getClientIP(req);

            // Check if IP is blocked
            if (isIPBlocked(clientIP)) {
                res.status(429).json({ error: 'IP blocked due to too many failed attempts' });
                return;
            }

            // Validate PIN
            if (!pin || typeof pin !== 'string' || pin.length !== 6) {
                res.status(400).json({ error: 'PIN must be exactly 6 digits' });
                return;
            }

            if (pin === serverPIN) {
                // Success - set authentication cookie
                res.cookie('auth', pin, {
                    httpOnly: true,
                    secure: false, // Set to true in production with HTTPS
                    maxAge: 24 * 60 * 60 * 1000, // 24 hours
                    sameSite: 'lax'
                });

                // Clear failed attempts for this IP
                failedAttempts.delete(clientIP);

                res.json({ success: true });
            } else {
                // Failed authentication
                const attempts = (failedAttempts.get(clientIP) || 0) + 1;
                failedAttempts.set(clientIP, attempts);

                if (attempts >= MAX_FAILED_ATTEMPTS) {
                    // Block IP
                    blockedIPs.add(clientIP);

                    // Unblock after duration
                    setTimeout(() => {
                        blockedIPs.delete(clientIP);
                        failedAttempts.delete(clientIP);
                    }, BLOCK_DURATION);

                    res.status(429).json({
                        error: `Too many failed attempts. IP blocked for ${BLOCK_DURATION / 60000} minute(s)`
                    });
                } else {
                    res.status(401).json({
                        error: `Invalid PIN. ${MAX_FAILED_ATTEMPTS - attempts} attempts remaining`
                    });
                }
            }
        });

        // Logout API
        app.post('/api/logout', (req, res) => {
            res.clearCookie('auth');
            res.json({ success: true });
        });

        // Apply authentication middleware if PIN is set
        if (serverPIN) {
            app.use(requireAuth);
        }

        app.get('/api/terminal-context', (req, res) => {
            res.json({
                recentOutput: outputBuffer.slice(-50),
                bufferLength: outputBuffer.length,
                debugAsr: debugAsrEnabled  // Include debug flag
            });
        });

        // Proxy for ModelScope API to handle CORS
        app.post('/api/modelscope/proxy', async (req, res) => {
            try {
                const { url, headers, body } = req.body;

                console.log('[ModelScope Proxy] Request to:', url);
                console.log('[ModelScope Proxy] Headers:', { ...headers, Authorization: headers.Authorization ? 'Bearer ***' : 'Not set' });

                // Make request to ModelScope API
                const axios = (await import('axios')).default;
                const response = await axios({
                    method: 'POST',
                    url: url,
                    headers: headers,
                    data: body
                });

                res.json(response.data);
            } catch (error: any) {
                console.error('[ModelScope Proxy] Error:', error.message);
                if (error.response) {
                    console.error('[ModelScope Proxy] Response status:', error.response.status);
                    console.error('[ModelScope Proxy] Response data:', error.response.data);
                }
                res.status(error.response?.status || 500).json({
                    error: error.response?.data?.message || error.message,
                    status: error.response?.status,
                    details: error.response?.data
                });
            }
        });

        app.get('/api/modelscope/proxy', async (req, res) => {
            try {
                const { url, headers } = req.query;

                // Make request to ModelScope API
                const axios = (await import('axios')).default;
                const response = await axios({
                    method: 'GET',
                    url: url as string,
                    headers: JSON.parse(headers as string || '{}')
                });

                res.json(response.data);
            } catch (error: any) {
                console.error('[ModelScope Proxy] Error:', error.message);
                res.status(error.response?.status || 500).json({
                    error: error.message,
                    status: error.response?.status
                });
            }
        });

        // Serve static files from public directory
        const publicDir = path.join(__dirname, '..', 'public');
        if (fs.existsSync(publicDir)) {
            app.use(express.static(publicDir));
        }

        // Fallback for SPA routing - use regex pattern for Express 5 compatibility
        app.use((req, res, next) => {
            // Skip API routes and WebSocket
            if (req.path.startsWith('/api') || req.path === '/ws') {
                return next();
            }

            // Skip static asset requests (favicon, images, etc.)
            const staticExtensions = ['.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.map', '.woff', '.woff2', '.ttf', '.eot'];
            if (staticExtensions.some(ext => req.path.endsWith(ext))) {
                return res.status(404).end();
            }

            // Only serve index.html for HTML requests (browser navigation)
            const acceptHeader = req.get('Accept') || '';
            if (!acceptHeader.includes('text/html')) {
                return res.status(404).end();
            }

            const indexPath = path.join(publicDir, 'index.html');
            if (fs.existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                // Minimal inline HTML if no public directory
                res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>gogogo Terminal</title>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        html, body {
            height: 100%;
            width: 100%;
            background: #0a0a0a;
            overflow: hidden;
            /* Prevent iOS edge swipe gestures */
            overscroll-behavior: none;
            -webkit-overflow-scrolling: auto;
        }
        /* Prevent swipe-to-go-back on iOS */
        body {
            position: fixed;
            width: 100%;
            height: 100%;
        }
        /* Terminal area - leave space for input at bottom */
        #terminal-container {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 50px; /* Space for input */
            padding: 8px;
            /* Prevent all default touch behaviors */
            touch-action: none;
            -webkit-touch-callout: none;
            -webkit-user-select: none;
            user-select: none;
            /* Prevent iOS edge swipe gestures */
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain;
        }
        /* xterm viewport handles its own scrolling */
        .xterm-viewport {
            overflow-y: auto !important;
            scrollbar-width: none; /* Firefox */
            -ms-overflow-style: none; /* IE/Edge */
            /* Ensure custom touch handling works */
            touch-action: none;
            -webkit-overflow-scrolling: auto; /* Disable iOS momentum scrolling */
        }
        .xterm-viewport::-webkit-scrollbar {
            display: none; /* Chrome/Safari */
        }
        /* Prevent text selection on mobile during scrolling */
        .xterm-screen {
            user-select: none;
            -webkit-user-select: none;
        }
        /* Scroll to bottom button */
        #scroll-to-bottom {
            position: fixed;
            bottom: 60px; /* Above input area */
            right: 12px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: rgba(59, 130, 246, 0.9);
            border: none;
            color: white;
            cursor: pointer;
            z-index: 999;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            opacity: 0;
            transform: scale(0.8);
            transition: all 0.2s ease;
            pointer-events: none;
        }
        #scroll-to-bottom.visible {
            opacity: 1;
            transform: scale(1);
            pointer-events: auto;
        }
        #scroll-to-bottom:hover {
            background: rgba(59, 130, 246, 1);
            transform: scale(1.1);
        }
        #scroll-to-bottom:active {
            transform: scale(0.95);
        }
        #scroll-to-bottom svg {
            width: 20px;
            height: 20px;
            fill: currentColor;
        }
        /* Floating status dot - top right */
        #status-dot {
            position: fixed;
            top: 12px;
            right: 12px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #22c55e;
            z-index: 1000;
            box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
            transition: all 0.3s ease;
        }
        #status-dot.disconnected { 
            background: #ef4444; 
            box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
        }
        #status-dot.connecting { 
            background: #f59e0b; 
            box-shadow: 0 0 8px rgba(245, 158, 11, 0.5);
            animation: pulse 1s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        /* Fixed bottom input area */
        #input-area {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 8px 12px;
            background: rgba(26, 26, 26, 0.95);
            border-top: 1px solid #333;
            z-index: 1000;
        }
        #input-wrapper {
            display: flex;
            align-items: flex-end;
            gap: 8px;
        }
        #input {
            flex: 1;
            min-height: 34px;
            max-height: 100px;
            background: #0a0a0a;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 8px 12px;
            color: #fff;
            font-size: 16px;
            font-family: inherit;
            outline: none;
            resize: none;
            overflow-y: auto;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }
        #input::-webkit-scrollbar { display: none; }
        #input:focus { border-color: #3b82f6; }

        /* Special keys button */
        #special-keys-btn {
            width: 40px;
            height: 40px;
            background: #1a1a1a;
            border: 1px solid #444;
            border-radius: 6px;
            color: #888;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            flex-shrink: 0;
        }
        #special-keys-btn:hover {
            background: #2a2a2a;
            color: #fff;
            border-color: #555;
        }
        #special-keys-btn:active {
            transform: scale(0.95);
        }

        /* Special keys popup */
        #special-keys-popup {
            position: fixed;
            bottom: 60px;
            right: 12px;
            background: rgba(26, 26, 26, 0.98);
            border: 1px solid #444;
            border-radius: 8px;
            padding: 8px;
            display: none;
            z-index: 1001;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            min-width: 200px;
        }
        #special-keys-popup.show {
            display: block;
        }
        .key-group {
            margin-bottom: 8px;
        }
        .key-group:last-child {
            margin-bottom: 0;
        }
        .key-group-title {
            color: #888;
            font-size: 11px;
            text-transform: uppercase;
            margin-bottom: 4px;
            padding: 0 4px;
        }
        .key-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
        }
        .special-key {
            padding: 6px 10px;
            background: #0a0a0a;
            border: 1px solid #333;
            border-radius: 4px;
            color: #fff;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.15s ease;
            white-space: nowrap;
            min-width: 40px;
            text-align: center;
        }
        .special-key:hover {
            background: #1a1a1a;
            border-color: #3b82f6;
        }
        .special-key:active {
            transform: scale(0.95);
            background: #2a2a2a;
        }
    </style>
</head>
<body>
    <div id="terminal-container"></div>
    
    <!-- Floating status dot -->
    <div id="status-dot"></div>

    <!-- Scroll to bottom button -->
    <button id="scroll-to-bottom" aria-label="Scroll to bottom">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 10l5 5 5-5H7z"/>
            <path d="M7 14l5 5 5-5H7z"/>
        </svg>
    </button>

    <!-- Fixed bottom input -->
    <div id="input-area">
        <div id="input-wrapper">
            <textarea id="input" rows="1" placeholder="Type command..." autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
            <button id="special-keys-btn" aria-label="Special keys">⌘</button>
        </div>
    </div>

    <!-- Special keys popup -->
    <div id="special-keys-popup">
        <div class="key-group">
            <div class="key-group-title">Control Keys</div>
            <div class="key-buttons">
                <button class="special-key" data-key="Escape">ESC</button>
                <button class="special-key" data-key="Tab">TAB</button>
                <button class="special-key" data-key="Enter">ENTER</button>
                <button class="special-key" data-key="Backspace">⌫</button>
            </div>
        </div>
        <div class="key-group">
            <div class="key-group-title">Modifiers</div>
            <div class="key-buttons">
                <button class="special-key" data-key="Control">CTRL</button>
                <button class="special-key" data-key="Alt">ALT</button>
                <button class="special-key" data-key="Shift">SHIFT</button>
                <button class="special-key" data-key="Meta">CMD</button>
            </div>
        </div>
        <div class="key-group">
            <div class="key-group-title">Function Keys</div>
            <div class="key-buttons">
                <button class="special-key" data-key="F1">F1</button>
                <button class="special-key" data-key="F2">F2</button>
                <button class="special-key" data-key="F3">F3</button>
                <button class="special-key" data-key="F4">F4</button>
            </div>
        </div>
        <div class="key-group">
            <div class="key-group-title">Navigation</div>
            <div class="key-buttons">
                <button class="special-key" data-key="ArrowUp">↑</button>
                <button class="special-key" data-key="ArrowDown">↓</button>
                <button class="special-key" data-key="ArrowLeft">←</button>
                <button class="special-key" data-key="ArrowRight">→</button>
                <button class="special-key" data-key="Home">HOME</button>
                <button class="special-key" data-key="End">END</button>
                <button class="special-key" data-key="PageUp">PgUp</button>
                <button class="special-key" data-key="PageDown">PgDn</button>
            </div>
        </div>
        <div class="key-group">
            <div class="key-group-title">Shortcuts</div>
            <div class="key-buttons">
                <button class="special-key" data-combo="ctrl+c">Ctrl+C</button>
                <button class="special-key" data-combo="ctrl+v">Ctrl+V</button>
                <button class="special-key" data-combo="ctrl+z">Ctrl+Z</button>
                <button class="special-key" data-combo="ctrl+d">Ctrl+D</button>
                <button class="special-key" data-combo="ctrl+l">Ctrl+L</button>
            </div>
        </div>
    </div>

    <script>
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            theme: { background: '#0a0a0a', foreground: '#ededed' },
            scrollback: 10000,
            allowTransparency: false,
        });

        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        const statusDot = document.getElementById('status-dot');
        const input = document.getElementById('input');

        let ws = null;
        let pendingInputs = [];
        let reconnectAttempts = 0;
        const MAX_RECONNECT_ATTEMPTS = 3;
        let reconnectTimeoutId = null;
        let wasHidden = false;
        let isReconnecting = false;
        let pendingMessage = '';

        function setInputEnabled(enabled) {
            input.disabled = !enabled;
            input.style.opacity = enabled ? '1' : '0.5';
            input.style.cursor = enabled ? 'text' : 'not-allowed';
            if (!enabled) {
                input.placeholder = 'Reconnecting...';
            } else {
                input.placeholder = 'Type command...';
            }
        }

        function updateStatus(state) {
            statusDot.className = '';
            if (state === 'disconnected') {
                statusDot.classList.add('disconnected');
                isReconnecting = true;
                // Don't disable input during reconnection
            } else if (state === 'connecting') {
                statusDot.classList.add('connecting');
                isReconnecting = true;
                // Don't disable input during reconnection
            } else if (state === 'connected') {
                isReconnecting = false;
            }
            // 'connected' - input enabled after history sync
        }

        function closeExistingConnection() {
            if (ws) {
                // Remove handlers to prevent triggering reconnect logic
                ws.onclose = null;
                ws.onerror = null;
                ws.onopen = null;
                ws.onmessage = null;
                try {
                    ws.close();
                } catch (e) {}
                ws = null;
            }
        }

        function startReconnect() {
            // Clear any pending reconnect
            if (reconnectTimeoutId) {
                clearTimeout(reconnectTimeoutId);
                reconnectTimeoutId = null;
            }
            
            // Close existing connection first
            closeExistingConnection();
            
            // Reset attempts counter
            reconnectAttempts = 0;
            
            // Start reconnecting
            // Don't disable input during reconnection
            doReconnect();
        }

        function doReconnect() {
            if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                console.log('Max reconnect attempts reached (' + MAX_RECONNECT_ATTEMPTS + ')');
                updateStatus('disconnected');
                isReconnecting = false;  // Stop reconnecting
                setInputEnabled(false);  // Disable input since connection failed
                input.placeholder = 'Connection failed. Refresh page.';
                return;
            }
            
            reconnectAttempts++;
            console.log('Reconnect attempt ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS);
            updateStatus('connecting');

            const wsUrl = location.protocol.replace('http', 'ws') + '//' + location.host + '/ws';
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('WebSocket connected');
                updateStatus('connected');
                reconnectAttempts = 0;
                fitAddon.fit();
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            };

            ws.onclose = () => {
                console.log('WebSocket closed, attempt ' + reconnectAttempts);
                updateStatus('disconnected');
                ws = null;
                // If we haven't hit max attempts, schedule retry
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectTimeoutId = setTimeout(() => {
                        doReconnect();
                    }, 500);
                } else {
                    isReconnecting = false;  // Stop reconnecting
                    setInputEnabled(false);  // Disable input since connection failed
                    input.placeholder = 'Connection failed. Refresh page.';
                }
            };
            
            ws.onerror = (err) => {
                console.log('WebSocket error');
                // onclose will be called after onerror
            };

            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'output') term.write(msg.data);
                if (msg.type === 'history') {
                    // Clear terminal before writing history to avoid duplication
                    term.clear();
                    msg.data.forEach(d => term.write(d));
                    // History received, sync complete - enable input and scroll to bottom
                    console.log('History received, enabling input');
                    setInputEnabled(true);

                    // Force scroll to bottom using both xterm and viewport methods
                    term.scrollToBottom();
                    setTimeout(() => {
                        const viewport = document.querySelector('.xterm-viewport');
                        if (viewport) {
                            viewport.scrollTop = viewport.scrollHeight;
                        }
                        // Also reset the user scrolling flag
                        isUserScrolling = false;
                    }, 100);

                    // If there was a pending message, send it now
                    if (pendingMessage) {
                        ws.send(JSON.stringify({ type: 'input', data: pendingMessage }));
                        ws.send(JSON.stringify({ type: 'input', data: String.fromCharCode(13) }));
                        pendingMessage = '';
                        // Re-enable input after sending
                        setInputEnabled(true);
                        // Scroll to bottom again after sending pending message
                        setTimeout(() => scrollToBottom(), 150);
                    }

                    while (pendingInputs.length > 0) {
                        ws.send(JSON.stringify({ type: 'input', data: pendingInputs.shift() }));
                    }
                }
            };
        }

        // Track when page is hidden
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                console.log('Page hidden');
                wasHidden = true;
            } else if (document.visibilityState === 'visible' && wasHidden) {
                console.log('Page became visible after being hidden');
                wasHidden = false;
                // Only reconnect if the connection is actually broken
                if (!ws || ws.readyState !== 1) {
                    console.log('WebSocket disconnected while hidden, reconnecting...');
                    startReconnect();
                } else {
                    console.log('WebSocket still connected, no reconnection needed');
                }
            }
        });

        function sendInput(data) {
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'input', data }));
            } else {
                pendingInputs.push(data);
            }
        }

        function send() {
            // If reconnecting, store the message and disable input
            if (isReconnecting) {
                const text = input.value;
                if (text) {
                    pendingMessage = text;
                    input.value = '';
                    input.style.height = 'auto'; // Reset height
                    // Disable input until reconnection completes
                    setInputEnabled(false);
                    input.placeholder = 'Sending after reconnection...';
                }
                return;
            }

            if (input.disabled) return;

            const text = input.value;
            input.value = '';
            input.style.height = 'auto'; // Reset height
            if (text) {
                sendInput(text);
                setTimeout(() => {
                    sendInput(String.fromCharCode(13));
                    // Scroll to bottom after sending command
                    scrollToBottom();
                }, 50);
            } else {
                sendInput(String.fromCharCode(13));
                // Scroll to bottom after sending empty command
                scrollToBottom();
            }
        }

        // Auto-resize textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 100) + 'px';
        });

        // Enter to send, Shift+Enter for newline
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        };

        // Focus input when clicking terminal area
        document.getElementById('terminal-container').addEventListener('click', () => {
            if (!input.disabled) {
                input.focus();
            }
        });

        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                fitAddon.fit();
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                }
            }, 100);
        });

        // Touch scrolling state
        let isUserScrolling = false;
        const terminalContainer = document.getElementById('terminal-container');
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        // Initialize touch scrolling for mobile devices
        if (isTouchDevice) {
            initTouchScrolling(terminalContainer, () => { isUserScrolling = true; });
        }

        // Touch scrolling implementation
        function initTouchScrolling(container, onScrollStart) {
            const touchState = {
                startY: 0, lastY: 0, lastTime: 0,
                velocity: 0, identifier: null,
                touching: false, velocityHistory: [],
                accumulator: 0, inertiaId: null
            };

            // Create touch overlay
            const overlay = createTouchOverlay(container);

            // Attach event handlers
            overlay.addEventListener('touchstart', handleTouchStart, { passive: false });
            overlay.addEventListener('touchmove', handleTouchMove, { passive: false });
            overlay.addEventListener('touchend', handleTouchEnd, { passive: false });
            overlay.addEventListener('touchcancel', handleTouchCancel, { passive: false });

            // Prevent conflicts with input area
            document.getElementById('input-area').addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

            function createTouchOverlay(parent) {
                const div = document.createElement('div');
                Object.assign(div.style, {
                    position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
                    zIndex: '1', touchAction: 'none', webkitTouchCallout: 'none',
                    webkitUserSelect: 'none', userSelect: 'none', pointerEvents: 'auto'
                });
                parent.appendChild(div);
                return div;
            }

            function performScroll(deltaY) {
                const viewport = container.querySelector('.xterm-viewport');
                if (!viewport) return;
                viewport.scrollTop += deltaY;
                viewport.dispatchEvent(new WheelEvent('wheel', {
                    deltaY, deltaMode: 0, bubbles: true, cancelable: true
                }));
            }

            function handleTouchStart(e) {
                e.preventDefault();
                cancelInertia();
                touchState.accumulator = 0;

                if (e.touches.length > 0) {
                    const touch = e.touches[0];
                    Object.assign(touchState, {
                        identifier: touch.identifier,
                        startY: touch.clientY,
                        lastY: touch.clientY,
                        lastTime: performance.now(),
                        velocity: 0,
                        velocityHistory: [],
                        touching: true
                    });
                    onScrollStart();
                }
            }

            function handleTouchMove(e) {
                e.preventDefault();
                if (!touchState.touching || e.touches.length === 0) return;

                const touch = findTrackedTouch(e.touches) || e.touches[0];
                const currentY = touch.clientY;
                const deltaY = touchState.lastY - currentY;
                const currentTime = performance.now();
                const timeDelta = Math.max(1, currentTime - touchState.lastTime);

                // Update velocity
                updateVelocity(deltaY / timeDelta);

                touchState.lastY = currentY;
                touchState.lastTime = currentTime;
                touchState.accumulator += deltaY;

                // Apply scroll when threshold reached
                if (Math.abs(touchState.accumulator) >= 0.5) {
                    performScroll(touchState.accumulator * 1.8);
                    touchState.accumulator = touchState.accumulator % 0.5;
                }
            }

            function handleTouchEnd(e) {
                e.preventDefault();
                if (!isTouchEnded(e.touches)) return;

                touchState.touching = false;
                touchState.identifier = null;

                // Apply remaining scroll
                if (Math.abs(touchState.accumulator) > 0) {
                    performScroll(touchState.accumulator * 1.8);
                    touchState.accumulator = 0;
                }

                // Start inertia if needed
                if (Math.abs(touchState.velocity) > 0.01) {
                    startInertia();
                }
            }

            function handleTouchCancel(e) {
                e.preventDefault();
                resetTouchState();
                cancelInertia();
            }

            function findTrackedTouch(touches) {
                for (let i = 0; i < touches.length; i++) {
                    if (touches[i].identifier === touchState.identifier) {
                        return touches[i];
                    }
                }
                return null;
            }

            function isTouchEnded(touches) {
                return !findTrackedTouch(touches);
            }

            function updateVelocity(instant) {
                touchState.velocityHistory.push(instant);
                if (touchState.velocityHistory.length > 5) {
                    touchState.velocityHistory.shift();
                }

                // Calculate weighted average
                let weightedSum = 0, totalWeight = 0;
                touchState.velocityHistory.forEach((v, i) => {
                    const weight = i + 1;
                    weightedSum += v * weight;
                    totalWeight += weight;
                });
                touchState.velocity = totalWeight ? weightedSum / totalWeight : 0;
            }

            function startInertia() {
                const friction = 0.95;
                const minVelocity = 0.01;

                function animate() {
                    if (Math.abs(touchState.velocity) < minVelocity || touchState.touching) {
                        touchState.inertiaId = null;
                        touchState.velocity = 0;
                        return;
                    }

                    performScroll(touchState.velocity * 25);
                    touchState.velocity *= friction;
                    touchState.inertiaId = requestAnimationFrame(animate);
                }
                animate();
            }

            function cancelInertia() {
                if (touchState.inertiaId) {
                    cancelAnimationFrame(touchState.inertiaId);
                    touchState.inertiaId = null;
                }
            }

            function resetTouchState() {
                Object.assign(touchState, {
                    touching: false, identifier: null,
                    velocity: 0, velocityHistory: [],
                    accumulator: 0
                });
            }
        }

        // Scroll to bottom button functionality
        const scrollToBottomBtn = document.getElementById('scroll-to-bottom');
        let scrollCheckTimer = null;

        function isAtBottom() {
            const viewport = document.querySelector('.xterm-viewport');
            if (!viewport) return true;

            // Check if scrolled to bottom (with 50px tolerance)
            return viewport.scrollTop >= (viewport.scrollHeight - viewport.clientHeight - 50);
        }

        function updateScrollButton() {
            if (isAtBottom()) {
                scrollToBottomBtn.classList.remove('visible');
                isUserScrolling = false;
            } else {
                scrollToBottomBtn.classList.add('visible');
                isUserScrolling = true;
            }
        }

        function scrollToBottom() {
            const viewport = document.querySelector('.xterm-viewport');
            if (viewport) {
                viewport.scrollTo({
                    top: viewport.scrollHeight,
                    behavior: 'smooth'
                });
            }
            // Hide button immediately when clicked
            scrollToBottomBtn.classList.remove('visible');
            isUserScrolling = false;
        }

        // Click handler for scroll to bottom button
        scrollToBottomBtn.addEventListener('click', scrollToBottom);

        // Monitor scroll events on terminal viewport
        function attachScrollListener() {
            const viewport = document.querySelector('.xterm-viewport');
            if (viewport) {
                viewport.addEventListener('scroll', () => {
                    // Debounce scroll check
                    clearTimeout(scrollCheckTimer);
                    scrollCheckTimer = setTimeout(updateScrollButton, 100);
                });

                // Also listen for wheel events to detect user scrolling
                viewport.addEventListener('wheel', () => {
                    // Quick check without debounce for wheel events
                    updateScrollButton();
                });
            }
        }

        // Attach scroll listener after terminal is initialized
        setTimeout(attachScrollListener, 100);

        // Special keys functionality
        const specialKeysBtn = document.getElementById('special-keys-btn');
        const specialKeysPopup = document.getElementById('special-keys-popup');
        // 'input' already declared above

        // Toggle popup visibility
        specialKeysBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            specialKeysPopup.classList.toggle('show');
        });

        // Close popup when clicking outside
        document.addEventListener('click', (e) => {
            if (!specialKeysPopup.contains(e.target) && e.target !== specialKeysBtn) {
                specialKeysPopup.classList.remove('show');
            }
        });

        // Handle special key clicks
        document.querySelectorAll('.special-key').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation();

                const key = button.dataset.key;
                const combo = button.dataset.combo;

                if (combo) {
                    // Handle key combinations
                    handleKeyCombo(combo);
                } else if (key) {
                    // Handle single keys
                    handleSpecialKey(key);
                }

                // Keep popup open for modifier keys
                if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
                    // Close popup after non-modifier key press
                    setTimeout(() => {
                        specialKeysPopup.classList.remove('show');
                    }, 100);
                }
            });
        });

        function handleSpecialKey(key) {
            const currentInput = input.value;

            switch(key) {
                case 'Escape':
                    // Send ESC sequence
                    ws.send(JSON.stringify({ type: 'input', data: '\\x1b' }));
                    break;
                case 'Tab':
                    // Send TAB
                    ws.send(JSON.stringify({ type: 'input', data: '\\t' }));
                    break;
                case 'Enter':
                    // Send current input
                    if (currentInput) {
                        ws.send(JSON.stringify({ type: 'input', data: currentInput + '\\n' }));
                        addToHistory(currentInput);
                        input.value = '';
                        input.style.height = 'auto';
                    }
                    break;
                case 'Backspace':
                    // Remove last character from input
                    input.value = currentInput.slice(0, -1);
                    break;
                case 'Control':
                case 'Alt':
                case 'Shift':
                case 'Meta':
                    // These are modifiers, could be used to set a state
                    // For now, just show visual feedback
                    break;
                case 'ArrowUp':
                    // Navigate history up
                    navigateHistory('up');
                    break;
                case 'ArrowDown':
                    // Navigate history down
                    navigateHistory('down');
                    break;
                case 'ArrowLeft':
                    // Move cursor left in input
                    const cursorPos = input.selectionStart;
                    if (cursorPos > 0) {
                        input.setSelectionRange(cursorPos - 1, cursorPos - 1);
                    }
                    break;
                case 'ArrowRight':
                    // Move cursor right in input
                    const cursorPosRight = input.selectionStart;
                    if (cursorPosRight < input.value.length) {
                        input.setSelectionRange(cursorPosRight + 1, cursorPosRight + 1);
                    }
                    break;
                case 'Home':
                    // Move to start of input
                    input.setSelectionRange(0, 0);
                    input.focus();
                    break;
                case 'End':
                    // Move to end of input
                    input.setSelectionRange(input.value.length, input.value.length);
                    input.focus();
                    break;
                case 'PageUp':
                    // Scroll terminal up
                    const viewportUp = document.querySelector('.xterm-viewport');
                    if (viewportUp) {
                        viewportUp.scrollBy(0, -viewportUp.clientHeight);
                    }
                    break;
                case 'PageDown':
                    // Scroll terminal down
                    const viewportDown = document.querySelector('.xterm-viewport');
                    if (viewportDown) {
                        viewportDown.scrollBy(0, viewportDown.clientHeight);
                    }
                    break;
                case 'F1':
                case 'F2':
                case 'F3':
                case 'F4':
                    // Send function key sequences
                    const fKeyMap = {
                        'F1': '\\x1bOP',
                        'F2': '\\x1bOQ',
                        'F3': '\\x1bOR',
                        'F4': '\\x1bOS'
                    };
                    ws.send(JSON.stringify({ type: 'input', data: fKeyMap[key] }));
                    break;
            }

            // Focus back to input for most keys
            if (!['PageUp', 'PageDown'].includes(key)) {
                input.focus();
            }
        }

        function handleKeyCombo(combo) {
            switch(combo) {
                case 'ctrl+c':
                    // Send Ctrl+C (interrupt)
                    ws.send(JSON.stringify({ type: 'input', data: '\\x03' }));
                    break;
                case 'ctrl+v':
                    // Paste from clipboard
                    navigator.clipboard.readText().then(text => {
                        const cursorPos = input.selectionStart;
                        const currentValue = input.value;
                        input.value = currentValue.slice(0, cursorPos) + text + currentValue.slice(cursorPos);
                        input.setSelectionRange(cursorPos + text.length, cursorPos + text.length);
                        input.focus();
                    }).catch(() => {
                        // Fallback: let user know paste is not available
                        console.log('Clipboard access denied');
                    });
                    break;
                case 'ctrl+z':
                    // Send Ctrl+Z (suspend)
                    ws.send(JSON.stringify({ type: 'input', data: '\\x1a' }));
                    break;
                case 'ctrl+d':
                    // Send Ctrl+D (EOF)
                    ws.send(JSON.stringify({ type: 'input', data: '\\x04' }));
                    break;
                case 'ctrl+l':
                    // Send Ctrl+L (clear screen)
                    ws.send(JSON.stringify({ type: 'input', data: '\\x0c' }));
                    break;
            }
            input.focus();
        }

        // Also update button visibility when new content arrives
        const originalTermWrite = term.write.bind(term);
        term.write = function(data) {
            originalTermWrite(data);
            // Only auto-scroll if user is not manually scrolling
            if (!isUserScrolling) {
                setTimeout(() => {
                    const viewport = document.querySelector('.xterm-viewport');
                    if (viewport) {
                        viewport.scrollTop = viewport.scrollHeight;
                    }
                }, 0);
            }
            // Update button visibility
            setTimeout(updateScrollButton, 50);
        };

        doReconnect();
        input.focus();
    </script>
</body>
</html>
                `);
            }
        });

        httpServer = createServer(app);

        // WebSocket server - handle authentication in connection event
        wss = new WebSocketServer({
            server: httpServer,
            path: '/ws'
        });

        wss.on('connection', (ws) => {

            const clientId = generateClientId();
            // Client connected silently

            // Initialize client with default size and ASR state
            const clientInfo: any = { cols: 80, rows: 24, id: clientId };
            connectedClients.set(ws, clientInfo);

            // Send buffered history
            if (outputBuffer.length > 0) {
                ws.send(JSON.stringify({ type: 'history', data: outputBuffer }));
            }

            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.type === 'input' && msg.data) {
                        // Debug logging commented out for production
                        // console.log('  [WebServer] Input received:', JSON.stringify(msg.data), 'charCodes:', [...msg.data].map(c => c.charCodeAt(0)));
                        writeToPTY(msg.data);
                    }

                    // Handle ASR messages - Connect to ASR Gateway instead of DashScope directly
                    // This reduces latency by keeping audio processing local before sending to cloud
                    if (msg.type === 'asr_start') {
                        // Start ASR session via ASR Gateway
                        asrLog('[ASR] Starting ASR session via Gateway');

                        // Connect to ASR Gateway (handles DashScope + Claude correction)
                        const gatewayUrl = 'wss://voice.futuretech.social';
                        const WebSocketClient = require('ws');

                        clientInfo.asrWs = new WebSocketClient(gatewayUrl);
                        clientInfo.sessionReady = false;
                        clientInfo.audioChunkCount = 0;
                        clientInfo.terminalContext = msg.context || '';

                        clientInfo.asrWs.on('open', () => {
                            asrLog('[ASR] Connected to ASR Gateway');

                            // Send start_asr message to gateway
                            const startMessage = {
                                type: 'start_asr',
                                config: {
                                    language: msg.language || 'zh',
                                    model: msg.model || 'qwen3-asr-flash-realtime'
                                }
                            };
                            clientInfo.asrWs.send(JSON.stringify(startMessage));
                            asrLog('[ASR] Sent start_asr to Gateway');

                            // Send context if available
                            if (clientInfo.terminalContext) {
                                clientInfo.asrWs.send(JSON.stringify({
                                    type: 'context_update',
                                    context: clientInfo.terminalContext
                                }));
                                asrLog('[ASR] Sent context to Gateway');
                            }
                        });

                        clientInfo.asrWs.on('message', (gatewayData: any) => {
                            // Forward Gateway responses to client
                            const response = JSON.parse(gatewayData.toString());
                            asrLog('[ASR] Received from Gateway:', response.type);

                            // Handle different gateway message types
                            switch (response.type) {
                                case 'connected':
                                    asrLog('[ASR] Gateway connected, client ID:', response.clientId);
                                    break;

                                case 'asr_connected':
                                    asrLog('[ASR] ASR backend ready');
                                    clientInfo.sessionReady = true;
                                    // Notify client that ASR is ready
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: { type: 'asr_ready' }
                                    }));
                                    break;

                                case 'asr_disconnected':
                                    asrLog('[ASR] ASR backend disconnected');
                                    clientInfo.sessionReady = false;
                                    break;

                                case 'partial_result':
                                    // Partial transcription result
                                    asrLog('[ASR] Partial result:', response.text);
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: {
                                            type: 'partial',
                                            text: response.text,
                                            transcript: response.text
                                        }
                                    }));
                                    break;

                                case 'final_result':
                                    // Final transcription result
                                    asrLog('[ASR] Final result:', response.text);
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: {
                                            type: 'conversation.item.input_audio_transcription.completed',
                                            transcript: response.text,
                                            text: response.text
                                        }
                                    }));
                                    break;

                                case 'correction_result':
                                    // Claude correction result
                                    asrLog('[ASR] Claude correction:', response.original, '->', response.corrected);
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: {
                                            type: 'correction_result',
                                            original: response.original,
                                            corrected: response.corrected
                                        }
                                    }));
                                    break;

                                case 'error':
                                    asrLog('[ASR] Gateway error:', response.message);
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: { error: response.message }
                                    }));
                                    break;

                                case 'pong':
                                    // Gateway responded to ping, connection is alive
                                    break;

                                default:
                                    // Forward any other messages as-is for compatibility
                                    ws.send(JSON.stringify({
                                        type: 'asr_response',
                                        data: response
                                    }));
                            }
                        });

                        clientInfo.asrWs.on('error', (error: any) => {
                            asrLog('[ASR] Gateway error:', error);
                            ws.send(JSON.stringify({
                                type: 'asr_response',
                                data: { error: error.message || 'Gateway connection error' }
                            }));
                        });

                        clientInfo.asrWs.on('close', (code: number, reason: Buffer) => {
                            const reasonText = reason ? reason.toString() : 'Unknown';
                            asrLog('[ASR] Gateway connection closed. Code:', code, 'Reason:', reasonText);
                            clientInfo.asrWs = null;
                            clientInfo.sessionReady = false;
                        });
                    }

                    if (msg.type === 'asr_audio' && clientInfo.asrWs) {
                        // Forward audio to Gateway only if session is ready
                        if (clientInfo.asrWs.readyState === WebSocket.OPEN && clientInfo.sessionReady) {
                            // Log first few chunks for debugging
                            if (!clientInfo.audioChunkCount) {
                                clientInfo.audioChunkCount = 0;
                                asrLog('[ASR] First audio chunk length:', msg.audio?.length || 0);
                            }

                            // Send audio to gateway in its expected format
                            const audioMessage = {
                                type: 'audio_data',
                                audio: msg.audio
                            };
                            clientInfo.asrWs.send(JSON.stringify(audioMessage));

                            if (clientInfo.audioChunkCount++ < 5) {
                                asrLog('[ASR] Sent audio chunk to Gateway', clientInfo.audioChunkCount);
                            }
                        } else if (!clientInfo.sessionReady) {
                            asrLog('[ASR] Buffering audio - session not ready yet');
                            // Gateway handles buffering internally
                        }
                    }

                    if (msg.type === 'asr_commit' && clientInfo.asrWs) {
                        // Gateway handles commit internally based on VAD, but we can forward if needed
                        asrLog('[ASR] Commit request (gateway handles VAD automatically)');
                    }

                    if (msg.type === 'asr_stop') {
                        // Stop ASR session
                        if (clientInfo.asrWs) {
                            if (clientInfo.asrWs.readyState === WebSocket.OPEN) {
                                // Send stop command to gateway
                                clientInfo.asrWs.send(JSON.stringify({
                                    type: 'stop_asr'
                                }));
                                asrLog('[ASR] Sent stop_asr to Gateway');

                                // Close after a delay to receive final results
                                setTimeout(() => {
                                    if (clientInfo.asrWs) {
                                        clientInfo.asrWs.close(1000, 'Recording stopped normally');
                                        clientInfo.asrWs = null;
                                        clientInfo.audioChunkCount = 0;
                                    }
                                }, 1000);  // Longer delay for gateway to process
                            } else {
                                clientInfo.asrWs = null;
                                clientInfo.audioChunkCount = 0;
                            }
                        }
                    }

                    // Handle Claude correction request (now goes through gateway)
                    if (msg.type === 'claude_process') {
                        asrLog('[Claude] Processing request via Gateway');

                        // If we have an active gateway connection, use it for Claude correction
                        if (clientInfo.asrWs && clientInfo.asrWs.readyState === WebSocket.OPEN) {
                            clientInfo.asrWs.send(JSON.stringify({
                                type: 'correct_text',
                                text: msg.transcript,
                                context: msg.context || clientInfo.terminalContext
                            }));
                        } else {
                            // Fallback: connect to gateway just for correction
                            const WebSocketClient = require('ws');
                            const correctionWs = new WebSocketClient('wss://voice.futuretech.social');

                            correctionWs.on('open', () => {
                                correctionWs.send(JSON.stringify({
                                    type: 'correct_text',
                                    text: msg.transcript,
                                    context: msg.context
                                }));
                            });

                            correctionWs.on('message', (data: any) => {
                                const response = JSON.parse(data.toString());
                                if (response.type === 'correction_result') {
                                    ws.send(JSON.stringify({
                                        type: 'claude_response',
                                        data: {
                                            text: response.corrected,
                                            done: true
                                        }
                                    }));
                                    correctionWs.close();
                                }
                            });

                            correctionWs.on('error', (error: any) => {
                                asrLog('[Claude] Gateway correction error:', error);
                                ws.send(JSON.stringify({
                                    type: 'claude_response',
                                    data: { error: error.message, fallback: msg.transcript }
                                }));
                            });
                        }
                    }

                    if (msg.type === 'resize' && msg.cols && msg.rows) {
                        // Update this client's dimensions
                        const clientInfo = connectedClients.get(ws);
                        if (clientInfo) {
                            clientInfo.cols = msg.cols;
                            clientInfo.rows = msg.rows;
                            // Client resized silently
                        }
                        applyMinSize();
                    }
                } catch (e) {
                    console.error('  [WebServer] Invalid message:', e);
                }
            });

            ws.on('close', () => {
                const clientInfo = connectedClients.get(ws);
                if (clientInfo) {
                    // Clean up ASR WebSocket if exists
                    if (clientInfo.asrWs) {
                        clientInfo.asrWs.close(1001, 'Client disconnected');
                        clientInfo.asrWs = null;
                    }

                    // Client disconnected silently
                    connectedClients.delete(ws);

                    // Recalculate minimum size after client disconnection
                    applyMinSize();
                }
            });
        });

        // Forward PTY output to all clients
        onPTYData((data) => {
            outputBuffer.push(data);
            if (outputBuffer.length > MAX_BUFFER_SIZE) {
                outputBuffer = outputBuffer.slice(-3000);
            }

            const msg = JSON.stringify({ type: 'output', data });
            connectedClients.forEach((clientInfo, client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(msg);
                }
            });
        });


        // Notify clients on PTY exit
        onPTYExit((code) => {
            const msg = JSON.stringify({ type: 'exit', code });
            connectedClients.forEach((clientInfo, client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(msg);
                }
            });
        });

        httpServer.listen(port, '0.0.0.0', () => {
            // Add a small delay to ensure the server is fully ready
            setTimeout(() => {
                resolve();
            }, 100);
        });

        httpServer.on('error', (err) => {
            console.error('  Failed to start server:', err);
            reject(err);
        });
    });
}

export function stopWebServer(): void {
    if (wss) {
        wss.clients.forEach((client) => client.close());
        wss.close();
        wss = null;
    }

    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }

    connectedClients.clear();
    outputBuffer = [];
    clientIdCounter = 0;
}
