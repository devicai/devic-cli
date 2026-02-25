import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CliConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.config', 'devic');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

let globalBaseUrl: string | undefined;

export function setGlobalBaseUrl(url: string): void {
  globalBaseUrl = url;
}

function readConfigFile(): CliConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfigFile(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function loadConfig(): CliConfig {
  const file = readConfigFile();
  return {
    apiKey: process.env['DEVIC_API_KEY'] ?? file.apiKey,
    baseUrl: globalBaseUrl ?? process.env['DEVIC_BASE_URL'] ?? file.baseUrl ?? 'https://api.devic.ai',
  };
}

export function saveConfig(config: Partial<CliConfig>): void {
  const existing = readConfigFile();
  writeConfigFile({ ...existing, ...config });
}

export function deleteConfig(): void {
  try {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  } catch {
    // ignore
  }
}
