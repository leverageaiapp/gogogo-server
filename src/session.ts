import * as qrcode from 'qrcode-terminal';
import * as net from 'net';
import * as http from 'http';
import { spawnPTY, killPTY, onPTYExit } from './pty';
import { startWebServer, stopWebServer } from './web-server';
import { startTunnel, stopTunnel } from './cloudflare-tunnel';

const MIN_PORT = 8000;
const MAX_PORT = 65535;

/**
 * Validate PIN format (6 digits)
 */
function validatePIN(pin: string): boolean {
    return /^\d{6}$/.test(pin);
}

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, () => {
            server.once('close', () => {
                resolve(true);
            });
            server.close();
        });
        server.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Find an available port in the specified range
 */
async function findAvailablePort(): Promise<number> {
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const port = Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;

        if (await isPortAvailable(port)) {
            return port;
        }
    }

    throw new Error(`Unable to find available port after ${maxAttempts} attempts`);
}

/**
 * Verify that the web server is actually accessible
 */
function verifyServerStarted(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const maxAttempts = 10;
        let attempts = 0;

        const checkServer = () => {
            attempts++;

            const req = http.get(`http://localhost:${port}/health`, (res) => {
                // Server is responding, even if with 404 (health endpoint doesn't exist)
                // The important thing is that the server is reachable
                resolve();
            });

            req.on('error', (err) => {
                if (attempts >= maxAttempts) {
                    reject(new Error(`Server failed to start on port ${port} after ${maxAttempts} attempts`));
                } else {
                    // Try again after a short delay
                    setTimeout(checkServer, 200);
                }
            });

            req.setTimeout(1000, () => {
                req.destroy();
                if (attempts >= maxAttempts) {
                    reject(new Error(`Server startup timeout on port ${port}`));
                } else {
                    setTimeout(checkServer, 200);
                }
            });
        };

        checkServer();
    });
}

/**
 * Generate QR code for terminal
 */
function displayQRCode(url: string): void {
    console.log('');
    console.log('  📱 Scan this QR code with your phone:');
    console.log('');

    qrcode.generate(url, { small: true }, (qr) => {
        console.log(qr);
    });

    console.log('');
    console.log(`  📱 Or open: ${url}`);
    console.log('');
}

export interface SessionOptions {
    debugAsr?: boolean;
}

export async function startSession(machineName: string, userPin?: string, command?: string[], options: SessionOptions = {}): Promise<void> {
    console.log('');
    console.log('  🚀 gogogo - Coding anywhere in your pocket');
    console.log('');

    // Bypass system proxy to avoid issues with Shadowrocket, Clash, etc.
    // These proxies can interfere with localhost connections
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;

    // Set NO_PROXY to ensure local connections bypass any remaining proxy
    process.env.NO_PROXY = 'localhost,127.0.0.1,*.local,*.trycloudflare.com';
    process.env.no_proxy = process.env.NO_PROXY;

    try {
        // Handle PIN - default is no PIN (direct access)
        let pin: string = '';
        
        if (userPin) {
            // User specified a PIN, validate it
            if (validatePIN(userPin)) {
                pin = userPin;
            } else {
                throw new Error('PIN must be exactly 6 digits');
            }
        }
        // If no PIN provided, pin remains empty string (no authentication)

        // Show progress steps
        console.log('  Finding available port...');
        const port = await findAvailablePort();
        console.log(`  Using port: ${port}`);

        console.log('  Starting local server...');
        await startWebServer(port, pin, { debugAsr: options.debugAsr });

        // Verify server is accessible before creating tunnel
        await verifyServerStarted(port);

        console.log('  Creating tunnel...');
        let tunnelUrl: string;

        try {
            tunnelUrl = await startTunnel(port);
        } catch (error) {
            console.log('');
            console.log('  ❌ Failed to create tunnel:');
            console.log('');
            console.log(error instanceof Error ? error.message : String(error));
            console.log('');
            process.exit(1);
        }

        // Display QR code and connection info
        displayQRCode(tunnelUrl);

        // Show PIN info after QR code
        if (pin) {
            console.log(`    🔐 PIN for web access: ${pin}`);
        } else {
            console.log('    🔓 No PIN required - direct access enabled');
        }
        console.log('');
        console.log('  Started.');
        console.log('');

        // Determine what to run
        let commandToRun: string;
        let argsToRun: string[];

        if (command && command.length > 0) {
            // Check if first argument contains spaces (quoted command)
            if (command.length === 1 && command[0].includes(' ')) {
                // Single quoted command like "claude --dangerously-skip-permissions"
                const parts = command[0].split(' ');
                commandToRun = parts[0];
                argsToRun = parts.slice(1);
            } else {
                // Normal command with separate arguments
                commandToRun = command[0];
                argsToRun = command.slice(1);
            }
        } else {
            // No command provided, just start a shell
            const shell = process.env.SHELL || '/bin/zsh';
            commandToRun = shell;
            argsToRun = [];
        }

        // Spawn the command in PTY
        spawnPTY({
            command: commandToRun,
            args: argsToRun,
            cwd: process.cwd(),
        });

        // Handle command exit
        onPTYExit((code) => {
            console.log('');
            if (command && command.length > 0) {
                console.log(`  ${command.join(' ')} exited. Session ended.`);
            } else {
                console.log('  Terminal session ended.');
            }
            cleanup();
        });

        // Cleanup function
        const cleanup = () => {
            killPTY();
            stopWebServer();
            stopTunnel();
            process.exit(0);
        };

        // Handle Ctrl+C
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

    } catch (error) {
        console.error('  ✗ Failed to start session:', error);
        stopWebServer();
        stopTunnel();
        process.exit(1);
    }
}
