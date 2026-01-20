#!/usr/bin/env node

/**
 * Installation verification script
 * Checks if all dependencies and permissions are correctly set up
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

console.log('🔍 Verifying gogogo installation...\n');

let hasErrors = false;
let hasWarnings = false;

// Check 1: Node.js version
console.log('1. Checking Node.js version...');
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
if (majorVersion >= 18) {
    console.log(`   ✓ Node.js ${nodeVersion} (>= 18.0.0)\n`);
} else {
    console.log(`   ✗ Node.js ${nodeVersion} is too old. Required: >= 18.0.0\n`);
    hasErrors = true;
}

// Check 2: cloudflared
console.log('2. Checking cloudflared...');
try {
    const cloudflaredVersion = execSync('cloudflared --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`   ✓ cloudflared installed: ${cloudflaredVersion.trim()}\n`);
} catch (error) {
    console.log('   ✗ cloudflared not found');
    console.log('   Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/\n');
    hasErrors = true;
}

// Check 3: node-pty installation
console.log('3. Checking node-pty...');
const nodePtyPath = path.join(__dirname, '..', 'node_modules', 'node-pty');
if (fs.existsSync(nodePtyPath)) {
    console.log('   ✓ node-pty installed\n');
} else {
    console.log('   ✗ node-pty not found. Run: npm install\n');
    hasErrors = true;
}

// Check 4: spawn-helper permissions (macOS/Linux only)
if (os.platform() === 'darwin' || os.platform() === 'linux') {
    console.log('4. Checking spawn-helper permissions...');
    
    const arch = os.arch();
    const platform = os.platform();
    let prebuildDir;
    
    if (platform === 'darwin') {
        prebuildDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    } else {
        prebuildDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    }
    
    const spawnHelperPath = path.join(nodePtyPath, 'prebuilds', prebuildDir, 'spawn-helper');
    
    if (fs.existsSync(spawnHelperPath)) {
        try {
            const stats = fs.statSync(spawnHelperPath);
            const hasExecute = (stats.mode & fs.constants.S_IXUSR) !== 0;
            
            if (hasExecute) {
                console.log('   ✓ spawn-helper has execute permissions\n');
            } else {
                console.log('   ✗ spawn-helper missing execute permissions');
                console.log(`   Fix: chmod +x ${spawnHelperPath}\n`);
                hasErrors = true;
            }
        } catch (error) {
            console.log(`   ⚠ Could not check permissions: ${error.message}\n`);
            hasWarnings = true;
        }
    } else {
        console.log(`   ⚠ spawn-helper not found at expected location`);
        console.log(`   This may be normal if using a different node-pty version\n`);
        hasWarnings = true;
    }
} else {
    console.log('4. Skipping spawn-helper check (Windows)\n');
}

// Check 5: Built files
console.log('5. Checking built files...');
const distPath = path.join(__dirname, '..', 'dist', 'index.js');
if (fs.existsSync(distPath)) {
    console.log('   ✓ Project built successfully\n');
} else {
    console.log('   ⚠ Project not built yet. Run: npm run build\n');
    hasWarnings = true;
}

// Check 6: Shell availability
console.log('6. Checking shell...');
const shell = process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh');
if (fs.existsSync(shell)) {
    console.log(`   ✓ Shell available: ${shell}\n`);
} else {
    console.log(`   ⚠ Default shell not found: ${shell}\n`);
    hasWarnings = true;
}

// Summary
console.log('═'.repeat(50));
if (hasErrors) {
    console.log('❌ Installation has errors. Please fix the issues above.');
    process.exit(1);
} else if (hasWarnings) {
    console.log('⚠️  Installation complete with warnings.');
    console.log('   You may want to address the warnings above.');
    process.exit(0);
} else {
    console.log('✅ Installation verified successfully!');
    console.log('\nYou can now run: gogogo start');
    process.exit(0);
}
