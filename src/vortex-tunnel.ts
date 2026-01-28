import axios from 'axios';
import WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

let tunnelWs: WebSocket | null = null;
let tunnelUrl: string | null = null;
let sessionId: string | null = null;
let gatewayUrl: string | null = null;
let localPort: number | null = null;

// Map to store pending HTTP requests
const pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout: NodeJS.Timeout;
}>();

/**
 * Start Vortex tunnel
 * Creates a session with the gateway and establishes WebSocket connection
 */
export function startTunnel(port: number = 4020, gateway?: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
        try {
            localPort = port;
            gatewayUrl = gateway || process.env.VORTEX_GATEWAY || 'https://vortex.futuretech.social';

            console.log(`  [Vortex] Connecting to gateway: ${gatewayUrl}`);

            // Step 1: Create session on gateway
            const response = await axios.post(`${gatewayUrl}/api/session`, {
                client_info: {
                    name: 'gogogo-server',
                    platform: process.platform,
                    type: 'http_proxy'
                }
            });

            const { session_id, tunnel_url: sessionUrl, ws_url, expires_in } = response.data;
            sessionId = session_id;
            tunnelUrl = sessionUrl;

            console.log(`  [Vortex] Session created: ${session_id.substring(0, 8)}...`);
            console.log(`  [Vortex] Session expires in: ${expires_in}s`);

            // Step 2: Register tunnel with gateway
            await axios.post(`${gatewayUrl}/api/tunnel/register`, {
                session_id: session_id,
            });

            // Step 3: Connect WebSocket to gateway
            const wsUrl = gatewayUrl.replace('https://', 'wss://').replace('http://', 'ws://') + `/tunnel/${session_id}`;
            console.log(`  [Vortex] Establishing WebSocket tunnel...`);

            tunnelWs = new WebSocket(wsUrl);

            tunnelWs.on('open', () => {
                console.log(`  [Vortex] Tunnel connected`);
                resolve(tunnelUrl!);
            });

            tunnelWs.on('message', (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
                    handleGatewayMessage(msg);
                } catch (e) {
                    // Not JSON, might be binary data
                    console.error('[Vortex] Invalid message from gateway:', e);
                }
            });

            tunnelWs.on('close', () => {
                console.log('  [Vortex] Tunnel disconnected');
                tunnelWs = null;
                cleanup();
            });

            tunnelWs.on('error', (err) => {
                console.error('  [Vortex] Tunnel error:', err.message);
                reject(err);
            });

        } catch (error: any) {
            console.error('  [Vortex] Failed to start tunnel:', error.message);
            if (error.response) {
                console.error('  [Vortex] Response:', error.response.data);
            }
            reject(error);
        }
    });
}

// Map of WebSocket connections
const websocketConnections = new Map<string, WebSocket>();

/**
 * Handle messages from the gateway
 */
function handleGatewayMessage(msg: any): void {
    switch (msg.type) {
        case 'http_request':
            // Gateway forwarded an HTTP request from browser
            handleHttpRequest(msg);
            break;

        case 'websocket_connect':
            // New WebSocket connection from browser
            handleWebSocketConnect(msg.conn_id);
            break;

        case 'websocket_message':
            // WebSocket message from browser
            handleWebSocketMessage(msg.conn_id, msg.data);
            break;

        case 'websocket_binary':
            // WebSocket binary data from browser
            handleWebSocketBinary(msg.conn_id, msg.data);
            break;

        case 'websocket_disconnect':
            // WebSocket disconnection from browser
            handleWebSocketDisconnect(msg.conn_id);
            break;

        case 'client_connected':
            console.log(`  [Vortex] Client connected`);
            break;

        case 'client_disconnected':
            console.log(`  [Vortex] Client disconnected`);
            break;

        default:
            // Unknown message type
            break;
    }
}

/**
 * Handle HTTP request forwarded from gateway
 * Forward it to the local server and send response back
 */
async function handleHttpRequest(msg: any): Promise<void> {
    const { request_id, method, path, headers, body } = msg;

    if (!localPort) {
        sendToGateway({
            type: 'http_response',
            request_id,
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
            body: 'Local server not configured'
        });
        return;
    }

    try {
        // Remove host header to avoid conflicts
        const requestHeaders = { ...headers };
        delete requestHeaders.host;
        delete requestHeaders.Host;

        // Make request to local server
        const options: http.RequestOptions = {
            hostname: 'localhost',
            port: localPort,
            path: path,
            method: method,
            headers: requestHeaders
        };

        const localReq = http.request(options, (localRes) => {
            const chunks: Buffer[] = [];

            localRes.on('data', (chunk) => {
                chunks.push(chunk);
            });

            localRes.on('end', () => {
                const responseBody = Buffer.concat(chunks);

                // Send response back to gateway
                sendToGateway({
                    type: 'http_response',
                    request_id,
                    status: localRes.statusCode || 200,
                    headers: localRes.headers,
                    body: responseBody.toString('base64'),
                    encoding: 'base64'
                });
            });
        });

        localReq.on('error', (err) => {
            console.error('[Vortex] Local request error:', err.message);
            sendToGateway({
                type: 'http_response',
                request_id,
                status: 502,
                headers: { 'Content-Type': 'text/plain' },
                body: `Failed to connect to local server: ${err.message}`
            });
        });

        // Send request body if present
        if (body) {
            // Decode base64 body if encoded
            const bodyBuffer = msg.encoding === 'base64' ? Buffer.from(body, 'base64') : body;
            localReq.write(bodyBuffer);
        }
        localReq.end();

    } catch (error: any) {
        sendToGateway({
            type: 'http_response',
            request_id,
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
            body: `Internal error: ${error.message}`
        });
    }
}

/**
 * Handle new WebSocket connection
 */
function handleWebSocketConnect(connId: string): void {
    if (!localPort) {
        sendToGateway({
            type: 'websocket_close',
            conn_id: connId
        });
        return;
    }

    // Create WebSocket connection to local server
    const localWs = new WebSocket(`ws://localhost:${localPort}/ws`);

    localWs.on('open', () => {
        console.log(`[Vortex] Local WebSocket connected for ${connId.substring(0, 8)}...`);
        websocketConnections.set(connId, localWs);
    });

    localWs.on('message', (data: any) => {
        // Forward data from local server to browser through gateway
        // Local server sends JSON text, we need to preserve it
        if (Buffer.isBuffer(data)) {
            sendToGateway({
                type: 'websocket_data',
                conn_id: connId,
                data: data.toString('base64'),
                binary: true
            });
        } else {
            // data is already a string (JSON), send it as-is
            sendToGateway({
                type: 'websocket_data',
                conn_id: connId,
                data: data.toString(),
                binary: false
            });
        }
    });

    localWs.on('close', () => {
        console.log(`[Vortex] Local WebSocket closed for ${connId.substring(0, 8)}...`);
        websocketConnections.delete(connId);
        sendToGateway({
            type: 'websocket_close',
            conn_id: connId
        });
    });

    localWs.on('error', (err) => {
        console.error(`[Vortex] Local WebSocket error for ${connId.substring(0, 8)}...`, err.message);
        websocketConnections.delete(connId);
        sendToGateway({
            type: 'websocket_close',
            conn_id: connId
        });
    });
}

/**
 * Handle WebSocket message from browser
 */
function handleWebSocketMessage(connId: string, data: string): void {
    const localWs = websocketConnections.get(connId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
        localWs.send(data);
    }
}

/**
 * Handle WebSocket binary data from browser
 */
function handleWebSocketBinary(connId: string, data: string): void {
    const localWs = websocketConnections.get(connId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
        // Decode base64 and send as binary
        const buffer = Buffer.from(data, 'base64');
        localWs.send(buffer);
    }
}

/**
 * Handle WebSocket disconnection from browser
 */
function handleWebSocketDisconnect(connId: string): void {
    const localWs = websocketConnections.get(connId);
    if (localWs) {
        localWs.close();
        websocketConnections.delete(connId);
        console.log(`[Vortex] WebSocket disconnected for ${connId.substring(0, 8)}...`);
    }
}

/**
 * Send message to gateway
 */
function sendToGateway(msg: any): void {
    if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
        tunnelWs.send(JSON.stringify(msg));
    }
}

/**
 * Clean up resources
 */
function cleanup(): void {
    // Clear any pending requests
    pendingRequests.forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(new Error('Tunnel closed'));
    });
    pendingRequests.clear();

    // Close all WebSocket connections
    websocketConnections.forEach(ws => {
        ws.close();
    });
    websocketConnections.clear();
}

export function stopTunnel(): void {
    if (tunnelWs) {
        tunnelWs.close();
        tunnelWs = null;
    }
    cleanup();
    tunnelUrl = null;
    sessionId = null;
}

export function getTunnelUrl(): string | null {
    return tunnelUrl;
}

export function isTunnelRunning(): boolean {
    return tunnelWs !== null && tunnelWs.readyState === WebSocket.OPEN;
}