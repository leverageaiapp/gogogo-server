import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.codingin');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Config {
    serverUrl: string;
    machineId: string;
}

const DEFAULT_CONFIG: Config = {
    serverUrl: process.env.CODINGIN_SERVER_URL || 'https://codingin.futuretech.social',
    machineId: generateMachineId(),
};

function generateMachineId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export function getConfig(): Config {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
        }
    } catch (error) {
        console.error('Error reading config:', error);
    }

    // Create default config
    setConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
}

export function setConfig(updates: Partial<Config>): void {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        const current = fs.existsSync(CONFIG_FILE)
            ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
            : DEFAULT_CONFIG;

        const newConfig = { ...current, ...updates };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    } catch (error) {
        console.error('Error writing config:', error);
    }
}
