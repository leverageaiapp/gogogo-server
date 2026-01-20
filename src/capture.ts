import axios from 'axios';
import * as readline from 'readline';

// Buffer for accumulating partial lines
let lineBuffer = '';
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 100;
let rl: readline.Interface | null = null;

export function startCapture(sessionId: string, serverUrl: string): void {
    // Only set up stdin capture if we're receiving piped input
    if (process.stdin.isTTY) {
        // Running interactively (not piped), don't capture stdin
        console.log('  [Capture] Running in interactive mode');
        return;
    }

    // Create readline interface for stdin (for piped input)
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
    });

    // Listen for lines from Claude Code (piped input)
    rl.on('line', (line) => {
        // Accumulate lines and debounce sending
        lineBuffer += line + '\n';

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            sendMessage(sessionId, serverUrl, lineBuffer.trim());
            lineBuffer = '';
        }, DEBOUNCE_MS);
    });

    rl.on('close', () => {
        // Send any remaining buffer
        if (lineBuffer.trim()) {
            sendMessage(sessionId, serverUrl, lineBuffer.trim());
        }
        console.log('  Input stream closed.');
    });

    console.log('  [Capture] Listening for piped input...');
}

export function stopCapture(): void {
    if (rl) {
        rl.close();
        rl = null;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

async function sendMessage(sessionId: string, serverUrl: string, text: string): Promise<void> {
    if (!text) return;

    try {
        // Try to parse as Claude Code message format
        const content = parseClaudeCodeMessage(text);

        await axios.post(`${serverUrl}/api/sessions/${sessionId}/messages`, {
            role: 'agent',
            content,
        });
    } catch (error) {
        // Silently fail - we don't want to interrupt the user
        if (process.env.DEBUG) {
            console.error('Failed to send message:', error);
        }
    }
}

// Parse Claude Code output into structured format
function parseClaudeCodeMessage(text: string): { type: string; text?: string; name?: string; input?: unknown } {
    // Check for tool use patterns
    const toolUseMatch = text.match(/^(?:Using|Running|Executing|Calling)\s+(\w+)/i);
    if (toolUseMatch) {
        return {
            type: 'tool-call',
            name: toolUseMatch[1],
            input: { description: text },
        };
    }

    // Check for code blocks
    if (text.includes('```')) {
        return {
            type: 'text',
            text,
        };
    }

    // Default to text
    return {
        type: 'text',
        text,
    };
}
