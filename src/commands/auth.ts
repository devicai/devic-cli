import { Command } from 'commander';
import { loadConfig, saveConfig, deleteConfig } from '../config.js';
import { DevicApiClient } from '../client.js';
import { withAction } from '../helpers.js';
import { md, getOutputFormat } from '../output.js';

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
        return { status: 'authenticated', baseUrl };
      }, () => md.success('Authenticated successfully. Credentials saved.')),
    );

  auth
    .command('status')
    .description('Show current authentication status')
    .action(
      withAction(async () => {
        const config = loadConfig();
        return {
          authenticated: !!config.apiKey,
          baseUrl: config.baseUrl ?? 'https://api.devic.ai',
          apiKey: config.apiKey ? `${config.apiKey.slice(0, 10)}...` : undefined,
        };
      }, (d) => {
        const s = d as { authenticated: boolean; baseUrl: string; apiKey?: string };
        if (!s.authenticated) {
          return [
            md.h(2, 'Authentication Status'),
            '',
            `${md.status('error')} **Not authenticated**`,
            '',
            `Run ${md.code('devic auth login --api-key <key>')} or set ${md.code('DEVIC_API_KEY')} env var.`,
          ].join('\n');
        }
        return [
          md.h(2, 'Authentication Status'),
          '',
          `${md.status('active')} **Authenticated**`,
          '',
          `**API Key:** ${md.code(s.apiKey!)}`,
          `**Base URL:** ${s.baseUrl}`,
        ].join('\n');
      }),
    );

  auth
    .command('logout')
    .description('Remove stored credentials')
    .action(
      withAction(async () => {
        deleteConfig();
        return { status: 'logged_out' };
      }, () => md.success('Logged out. Credentials removed.')),
    );
}
