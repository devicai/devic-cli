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

let globalActingUser: string | undefined;

/** `devic workspaces --as <user>`: wins over `DEVIC_USER`. */
export function setGlobalActingUser(user: string): void {
  globalActingUser = user;
}

/**
 * Person of the account the Workspaces API acts as (userUID or email), from
 * `--as` or `DEVIC_USER`. Undefined means "whoever the token is".
 */
export function getActingUser(): string | undefined {
  const value = (globalActingUser ?? process.env['DEVIC_USER'])?.trim();
  return value ? value : undefined;
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
    oauth: file.oauth,
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
