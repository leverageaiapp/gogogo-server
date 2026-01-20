import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;

/**
 * Get platform-specific installation instructions for cloudflared
 */
function getInstallationInstructions(): string {
    const platform = os.platform();

    switch (platform) {
        case 'darwin': // macOS
            return `cloudflared is required for gogogo to work. Please install it using Homebrew:

    brew install cloudflared

Alternatively, you can download it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/`;

        case 'linux':
            // Detect Linux distribution
            const fs = require('fs');
            let distroInstructions = '';

            try {
                // Check for common package managers
                if (fs.existsSync('/usr/bin/apt') || fs.existsSync('/usr/bin/apt-get')) {
                    // Debian/Ubuntu
                    distroInstructions = `    # Add Cloudflare GPG key
    sudo mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

    # Add Cloudflare repository
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list

    # Install cloudflared
    sudo apt-get update && sudo apt-get install cloudflared`;
                } else if (fs.existsSync('/usr/bin/yum')) {
                    // CentOS/RHEL
                    distroInstructions = `    # Add Cloudflare repository
    curl -fsSl https://pkg.cloudflare.com/cloudflared.repo | sudo tee /etc/yum.repos.d/cloudflared.repo

    # Install cloudflared
    sudo yum update && sudo yum install cloudflared`;
                } else if (fs.existsSync('/usr/bin/dnf')) {
                    // Fedora
                    distroInstructions = `    # Add Cloudflare repository
    sudo dnf config-manager --add-repo https://pkg.cloudflare.com/cloudflared.repo

    # Install cloudflared
    sudo dnf install cloudflared`;
                } else if (fs.existsSync('/usr/bin/pacman')) {
                    // Arch Linux
                    distroInstructions = `    # Install from community repository
    sudo pacman -S cloudflared`;
                } else {
                    // Generic Linux
                    distroInstructions = `    # Download and install manually
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
    chmod +x cloudflared
    sudo mv cloudflared /usr/local/bin/`;
                }
            } catch (error) {
                // Fallback to generic instructions
                distroInstructions = `    # Download and install manually
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
    chmod +x cloudflared
    sudo mv cloudflared /usr/local/bin/`;
            }

            return `cloudflared is required for gogogo to work. Please install it:

${distroInstructions}

For other distributions, see: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/`;

        default:
            return `cloudflared is required for gogogo to work. Please install it from:
https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/`;
    }
}

/**
 * Start Cloudflare Quick Tunnel
 * Returns the generated tunnel URL
 */
export function startTunnel(localPort: number = 4020): Promise<string> {
    return new Promise((resolve, reject) => {

        // Check if cloudflared is installed
        const which = spawn('which', ['cloudflared']);
        which.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(getInstallationInstructions()));
                return;
            }

            startTunnelProcess(localPort, resolve, reject);
        });
    });
}

function startTunnelProcess(
    localPort: number,
    resolve: (url: string) => void,
    reject: (err: Error) => void
): void {
    // Create environment without proxy settings for cloudflared
    const env = { ...process.env };
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.ALL_PROXY;
    delete env.all_proxy;

    // Ensure localhost bypasses proxy
    env.NO_PROXY = 'localhost,127.0.0.1,*.local';
    env.no_proxy = env.NO_PROXY;

    // Use --url for quick tunnel (no account needed)
    // Bypass proxy to avoid TLS handshake issues
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
    });

    let urlFound = false;
    const timeout = setTimeout(() => {
        if (!urlFound) {
            reject(new Error('Timeout waiting for tunnel URL'));
            stopTunnel();
        }
    }, 30000); // 30 second timeout

    // cloudflared outputs the URL to stderr
    tunnelProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();

        // Debug output
        if (process.env.DEBUG) {
        }

        // Look for the tunnel URL in the output
        // Format: "https://xxx-yyy-zzz.trycloudflare.com"
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !urlFound) {
            urlFound = true;
            clearTimeout(timeout);
            tunnelUrl = urlMatch[0];
            resolve(tunnelUrl);
        }
    });

    tunnelProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (process.env.DEBUG) {
        }

        // Also check stdout for URL
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch && !urlFound) {
            urlFound = true;
            clearTimeout(timeout);
            tunnelUrl = urlMatch[0];
            resolve(tunnelUrl);
        }
    });

    tunnelProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('  [Tunnel] Failed to start:', err);
        reject(err);
    });

    tunnelProcess.on('close', (code) => {
        if (!urlFound) {
            clearTimeout(timeout);
            reject(new Error(`cloudflared exited with code ${code}`));
        }
        tunnelProcess = null;
        tunnelUrl = null;
    });
}

export function stopTunnel(): void {
    if (tunnelProcess) {
        tunnelProcess.kill('SIGTERM');
        tunnelProcess = null;
        tunnelUrl = null;
    }
}

export function getTunnelUrl(): string | null {
    return tunnelUrl;
}

export function isTunnelRunning(): boolean {
    return tunnelProcess !== null && !tunnelProcess.killed;
}
