import axios from 'axios';
import { writeToPTY, resizePTY, onPTYData, onPTYExit, getLocalSize } from './pty';

let isRunning = false;
let pollInterval: NodeJS.Timeout | null = null;
let outputBuffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;

const POLL_INTERVAL = 100; // Poll for input every 100ms
const FLUSH_INTERVAL = 50; // Flush output every 50ms

// Track web client size
let webCols = 0;
let webRows = 0;

// Calculate and apply minimum size
function applyMinSize(): void {
    const local = getLocalSize();

    // If web client hasn't connected yet, use local size
    if (webCols === 0 || webRows === 0) {
        return; // Don't resize yet
    }

    // Use minimum of both dimensions (byobu-style)
    const minCols = Math.min(local.cols, webCols);
    const minRows = Math.min(local.rows, webRows);

    // Only resize if we have valid dimensions
    if (minCols > 0 && minRows > 0) {
        resizePTY(minCols, minRows);
    }
}

export function startRelay(sessionId: string, serverUrl: string): void {
    isRunning = true;

    console.log('  [Relay] Starting HTTP relay...');

    // Set up PTY data forwarding
    onPTYData((data) => {
        outputBuffer.push(data);
    });

    // Handle PTY exit
    onPTYExit(async (code) => {
        try {
            await axios.post(`${serverUrl}/api/terminal?sessionId=${sessionId}`, {
                type: 'exit',
                code,
            });
        } catch {
            // Ignore errors on exit
        }
    });

    // Start output flushing
    flushTimer = setInterval(async () => {
        if (outputBuffer.length === 0) return;

        const dataToSend = outputBuffer.join('');
        outputBuffer = [];

        try {
            await axios.post(`${serverUrl}/api/terminal?sessionId=${sessionId}`, {
                type: 'output',
                data: dataToSend,
            });
        } catch (error) {
            if (process.env.DEBUG) {
                console.error('  [Relay] Failed to send output:', error);
            }
        }
    }, FLUSH_INTERVAL);

    // Start polling for input and resize events
    pollInterval = setInterval(async () => {
        if (!isRunning) return;

        try {
            const response = await axios.get(`${serverUrl}/api/terminal`, {
                params: { sessionId, mode: 'input' },
                timeout: 5000,
            });

            const { inputs, resize } = response.data;

            // Handle resize from web client
            if (resize && resize.cols && resize.rows) {
                webCols = resize.cols;
                webRows = resize.rows;
                applyMinSize();
            }

            // Handle input from web client
            if (inputs && Array.isArray(inputs)) {
                for (const input of inputs) {
                    // Debug: log input
                    if (process.env.DEBUG) {
                        const hex = Array.from(Buffer.from(input)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                        console.log(`[Debug] Sending to PTY: "${input.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}" [${hex}]`);
                    }
                    writeToPTY(input);
                }
            }
        } catch (error) {
            if (process.env.DEBUG) {
                console.error('  [Relay] Failed to poll input:', error);
            }
        }
    }, POLL_INTERVAL);

    console.log('  [Relay] ✓ HTTP relay started');
}

export function stopRelay(): void {
    isRunning = false;

    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }

    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }

    outputBuffer = [];
    webCols = 0;
    webRows = 0;
    console.log('  [Relay] Stopped');
}

export function isRelayRunning(): boolean {
    return isRunning;
}

// Called when local terminal resizes
export function onLocalResize(): void {
    applyMinSize();
}
