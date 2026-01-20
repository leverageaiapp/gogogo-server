import * as pty from 'node-pty';
import * as os from 'os';
import { onLocalResize } from './relay';

export interface PTYOptions {
    cols?: number;
    rows?: number;
    command?: string;
    args?: string[];
    cwd?: string;
}

let ptyProcess: pty.IPty | null = null;
let dataCallback: ((data: string) => void) | null = null;
let exitCallback: ((code: number) => void) | null = null;

// Track local terminal size
let localCols = 80;
let localRows = 24;

// Get local terminal size
export function getLocalSize(): { cols: number; rows: number } {
    return { cols: localCols, rows: localRows };
}

export function spawnPTY(options: PTYOptions = {}): pty.IPty {
    // Default to user's shell
    const shell = process.env.SHELL || '/bin/zsh';
    const command = options.command || shell;
    const args = options.args || [];
    localCols = options.cols || process.stdout.columns || 80;
    localRows = options.rows || process.stdout.rows || 24;
    const cwd = options.cwd || process.cwd();


    // Ensure we have a clean environment with PATH
    const env = {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        TERM: 'xterm-256color',
    } as { [key: string]: string };

    ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: localCols,
        rows: localRows,
        cwd,
        env,
    });

    // Handle PTY output - forward to both console and callback
    ptyProcess.onData((data) => {
        // Write to local terminal (mirror)
        process.stdout.write(data);

        // Also send to web client via callback
        if (dataCallback) {
            dataCallback(data);
        }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
        if (exitCallback) {
            exitCallback(exitCode);
        }
        ptyProcess = null;
    });

    // Forward local stdin to PTY (for local terminal interaction)
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', (data) => {
        if (ptyProcess) {
            ptyProcess.write(data.toString());
        }
    });

    // Handle terminal resize from local terminal
    process.stdout.on('resize', () => {
        if (process.stdout.columns && process.stdout.rows) {
            localCols = process.stdout.columns;
            localRows = process.stdout.rows;
            // Notify relay to recalculate min size
            try {
                onLocalResize();
            } catch {
                // Relay might not be initialized yet
            }
        }
    });

    return ptyProcess;
}

export function writeToPTY(data: string): void {
    if (ptyProcess) {
        ptyProcess.write(data);
    }
}

export function resizePTY(cols: number, rows: number): void {
    if (ptyProcess) {
        ptyProcess.resize(cols, rows);
    }
}

export function killPTY(): void {
    if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
    }

    // Restore terminal
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }
}

export function onPTYData(callback: (data: string) => void): void {
    dataCallback = callback;
}

export function onPTYExit(callback: (code: number) => void): void {
    exitCallback = callback;
}

export function isPTYRunning(): boolean {
    return ptyProcess !== null;
}
