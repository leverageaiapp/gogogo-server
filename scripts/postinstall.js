#!/usr/bin/env node

/**
 * Post-install script to fix node-pty permissions on macOS/Linux
 * This ensures the spawn-helper binary has execute permissions
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = os.platform();

// Only run on macOS and Linux
if (platform !== 'darwin' && platform !== 'linux') {
    console.log('Skipping node-pty permission fix (not macOS/Linux)');
    process.exit(0);
}

// Determine the architecture
const arch = os.arch();
let prebuildDir;

if (platform === 'darwin') {
    prebuildDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
} else if (platform === 'linux') {
    prebuildDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

const spawnHelperPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'node-pty',
    'prebuilds',
    prebuildDir,
    'spawn-helper'
);

// Check if spawn-helper exists
if (!fs.existsSync(spawnHelperPath)) {
    console.log(`spawn-helper not found at: ${spawnHelperPath}`);
    console.log('This is normal if node-pty uses a different installation method');
    process.exit(0);
}

try {
    // Get current permissions
    const stats = fs.statSync(spawnHelperPath);
    const currentMode = stats.mode;
    
    // Add execute permission (chmod +x)
    const newMode = currentMode | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;
    
    if (currentMode !== newMode) {
        fs.chmodSync(spawnHelperPath, newMode);
        console.log('✓ Fixed node-pty spawn-helper permissions');
    } else {
        console.log('✓ node-pty spawn-helper permissions already correct');
    }
} catch (error) {
    console.error('Warning: Failed to fix node-pty permissions:', error.message);
    console.error('You may need to run manually: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper');
    // Don't fail the installation
    process.exit(0);
}
