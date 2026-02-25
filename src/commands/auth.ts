import { Command } from 'commander';
import { loadConfig, saveConfig, deleteConfig } from '../config.js';
import { DevicApiClient } from '../client.js';
import { withAction } from '../helpers.js';
import { outputHuman, getOutputFormat, outputJson } from '../output.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate with the Devic API')
    .requiredOption('--api-key <key>', 'Devic API key (devic-xxx)')
    .option('--base-url <url>', 'Override API base URL')
    .action(
      withAction(async (_opts: unknown) => {
        const opts = _opts as { apiKey: string; baseUrl?: string };
        const baseUrl = opts.baseUrl ?? 'https://api.devic.ai';
        const client = new DevicApiClient({ apiKey: opts.apiKey, baseUrl });

        // Validate key with a test request
        await client.getAssistants();

        saveConfig({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

        if (getOutputFormat() === 'human') {
          outputHuman('Authenticated successfully.');
          return undefined;
        }
        return { status: 'authenticated', baseUrl };
      }),
    );

  auth
    .command('status')
    .description('Show current authentication status')
    .action(
      withAction(async () => {
        const config = loadConfig();
        const status = {
          authenticated: !!config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.devic.ai',
          apiKey: config.apiKey ? `${config.apiKey.slice(0, 10)}...` : undefined,
        };
        return status;
      }, (d) => {
        const s = d as { authenticated: boolean; baseUrl: string; apiKey?: string };
        if (!s.authenticated) return 'Not authenticated. Run `devic auth login --api-key <key>`.';
        return `Authenticated\n  API Key: ${s.apiKey}\n  Base URL: ${s.baseUrl}`;
      }),
    );

  auth
    .command('logout')
    .description('Remove stored credentials')
    .action(
      withAction(async () => {
        deleteConfig();
        if (getOutputFormat() === 'human') {
          outputHuman('Logged out.');
          return undefined;
        }
        return { status: 'logged_out' };
      }),
    );
}
