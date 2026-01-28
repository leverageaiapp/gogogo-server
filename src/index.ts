#!/usr/bin/env node

import { Command } from 'commander';
import { startSession } from './session';
import { getConfig, setConfig } from './config';
import * as fs from 'fs';
import * as path from 'path';

// Read version from package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const program = new Command();

program
    .name('gogogo')
    .description('gogogo - Forward Claude Code to your mobile device')
    .version(version);

program
    .command('start')
    .description('Start a new gogogo session')
    .argument('[command...]', 'Command to run (default: none, opens terminal only)')
    .option('-n, --name <name>', 'Machine name to display', process.env.HOSTNAME || 'My Computer')
    .option('--pin <pin>', 'Set a 6-digit PIN for web access security (default: no PIN, direct access)')
    .option('--debug-asr', 'Enable verbose ASR (voice recognition) logging')
    .option('-g, --gateway <url>', 'Vortex gateway URL (default: https://vortex.futuretech.social)')
    .allowUnknownOption(true)
    .action(async (command, options) => {
        console.log('');
        console.log('  🚀 gogogo - Coding anywhere in your pocket');
        console.log('');

        // PIN is optional - if not provided, no authentication required
        await startSession(options.name, options.pin, command, {
            debugAsr: options.debugAsr,
            gatewayUrl: options.gateway
        });
    });

program
    .command('config')
    .description('Configure gogogo')
    .option('-s, --server <url>', 'Set server URL')
    .option('--show', 'Show current configuration')
    .action((options) => {
        if (options.show) {
            const config = getConfig();
            console.log('Current configuration:');
            console.log(`  Server URL: ${config.serverUrl}`);
            console.log(`  Machine ID: ${config.machineId}`);
            return;
        }

        if (options.server) {
            setConfig({ serverUrl: options.server });
            console.log(`Server URL set to: ${options.server}`);
        }
    });

program.parse();
