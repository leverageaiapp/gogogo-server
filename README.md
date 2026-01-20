# GoGoGo Server

[![npm version](https://img.shields.io/npm/v/@leverageaiapps/gogogo-server.svg)](https://www.npmjs.com/package/@leverageaiapps/gogogo-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CLI tool to forward terminal sessions to your mobile device via Cloudflare Tunnel. **Code anywhere from your pocket.**

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform">
</p>

## Features

- 🚀 **Instant Setup** - One command to start forwarding your terminal
- 📱 **Mobile Access** - Access your terminal from any device with a browser
- 🔒 **Secure** - PIN-protected sessions with automatic IP blocking
- 🌐 **No Port Forwarding** - Uses Cloudflare Quick Tunnel (no account needed)
- ⚡ **Real-time** - WebSocket-based communication for instant feedback
- 🎯 **PTY Support** - Full terminal emulation with node-pty

## Prerequisites

### Install cloudflared

GoGoGo requires `cloudflared` to create secure tunnels:

**macOS:**
```bash
brew install cloudflared
```

**Ubuntu/Debian:**
```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

**Arch Linux:**
```bash
sudo pacman -S cloudflared
```

For other systems, see the [official installation guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/).

## Installation

```bash
npm install -g @leverageaiapps/gogogo-server
```

**Verify Installation:**
```bash
gogogo --version
```

## Quick Start

```bash
# Start a terminal session
gogogo start

# Start with a specific command
gogogo start claude
gogogo start python
gogogo start vim
```

A QR code will appear - scan it with your phone and enter the 6-digit PIN to access your terminal!

## Usage

### Basic Commands

```bash
# Start a terminal session
gogogo start

# Start with a custom PIN
gogogo start --pin 123456

# Start with a machine name
gogogo start --name "My Laptop"

# Start a specific command
gogogo start claude --pin 123456
```

### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--name <name>` | `-n` | Set a custom machine name |
| `--pin <pin>` | `-p` | Set a custom 6-digit PIN |
| `--debug-asr` | | Enable verbose ASR logging |

### Configuration

```bash
# Show current configuration
gogogo config --show
```

## How It Works

1. Run `gogogo start [command]` in your terminal
2. GoGoGo starts a local web server and creates a Cloudflare tunnel
3. A QR code appears with your unique URL
4. Scan the QR code with your phone
5. Enter the 6-digit PIN to access your terminal
6. Your terminal is now accessible from your mobile device!

## Security

- **PIN Protection**: Each session requires a 6-digit PIN
- **Rate Limiting**: Max 10 failed login attempts per IP
- **Auto-blocking**: IPs are temporarily blocked after too many failures
- **Session Cookies**: Authentication persists for 24 hours

## Troubleshooting

### Error: posix_spawnp failed

Fix permissions on the node-pty spawn-helper:

```bash
# macOS ARM (M1/M2/M3)
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper

# macOS Intel
chmod +x node_modules/node-pty/prebuilds/darwin-x64/spawn-helper

# Linux x64
chmod +x node_modules/node-pty/prebuilds/linux-x64/spawn-helper
```

### cloudflared not found

Install cloudflared following the [Prerequisites](#prerequisites) section, then verify:

```bash
cloudflared --version
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for secure tunneling
- [node-pty](https://github.com/microsoft/node-pty) for PTY support
- [xterm.js](https://xtermjs.org/) for terminal emulation in the browser
