import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig, deleteConfig } from '../config.js';
import { DevicApiClient } from '../client.js';
import { withAction } from '../helpers.js';
import { md, getOutputFormat, outputHuman } from '../output.js';
import {
  awaitAuthorizationCode,
  exchangeCodeForTokens,
  generatePkce,
  openBrowser,
  reservePort,
  revokeRefreshToken,
} from '../oauth.js';

const DEFAULT_CLIENT_ID = 'devic-cli';
const DEFAULT_FRONTEND = 'https://app.devic.ai';
const DEFAULT_BASE_URL = 'https://api.devic.ai';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('login')
    .description(
      'Authenticate with the Devic platform using OAuth (or pass --api-key for legacy auth)',
    )
    .option('--api-key <key>', 'Use a long-lived API key instead of OAuth')
    .option('--base-url <url>', 'Override API base URL (e.g. http://localhost:8033)')
    .option(
      '--frontend-url <url>',
      'Frontend URL used for the consent screen',
      process.env['DEVIC_FRONTEND_URL'] ?? DEFAULT_FRONTEND,
    )
    .option('--client-id <id>', 'OAuth client ID', DEFAULT_CLIENT_ID)
    .option('--scope <scope>', 'OAuth scopes (space separated)')
    .option('--timeout <seconds>', 'Browser login timeout in seconds', '300')
    .action(
      withAction(async (_opts: unknown) => {
        const opts = _opts as {
          apiKey?: string;
          baseUrl?: string;
          frontendUrl: string;
          clientId: string;
          scope?: string;
          timeout: string;
        };

        const baseUrl =
          opts.baseUrl ?? loadConfig().baseUrl ?? DEFAULT_BASE_URL;

        // Legacy mode: --api-key still works for CI/headless cases.
        if (opts.apiKey) {
          const client = new DevicApiClient({ apiKey: opts.apiKey, baseUrl });
          await client.getAssistants();
          saveConfig({
            apiKey: opts.apiKey,
            baseUrl: opts.baseUrl ?? baseUrl,
            oauth: undefined,
          });
          return {
            mode: 'api_key',
            baseUrl,
            apiKey: `${opts.apiKey.slice(0, 10)}...`,
          };
        }

        // OAuth Authorization Code + PKCE
        const port = await reservePort();
        const redirectUri = `http://127.0.0.1:${port}/cli-callback`;
        const state = randomBytes(16).toString('hex');
        const pkce = generatePkce();

        const authorizeUrl = new URL(
          `${opts.frontendUrl.replace(/\/$/, '')}/oauth/authorize`,
        );
        authorizeUrl.searchParams.set('client_id', opts.clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
        authorizeUrl.searchParams.set('code_challenge_method', pkce.method);
        authorizeUrl.searchParams.set('state', state);
        if (opts.scope) authorizeUrl.searchParams.set('scope', opts.scope);

        if (getOutputFormat() === 'human') {
          outputHuman(
            [
              md.h(2, 'Authenticate with Devic'),
              '',
              'Opening your browser to complete login.',
              'If it does not open automatically, paste this URL:',
              '',
              md.code(authorizeUrl.toString()),
              '',
              md.info(`Waiting for callback on ${redirectUri} ...`),
            ].join('\n'),
          );
        }
        openBrowser(authorizeUrl.toString());

        const { code } = await awaitAuthorizationCode({
          port,
          expectedState: state,
          timeoutMs: parseInt(opts.timeout, 10) * 1000,
        });

        const tokens = await exchangeCodeForTokens({
          baseUrl,
          clientId: opts.clientId,
          redirectUri,
          code,
          codeVerifier: pkce.verifier,
        });

        // Validate the access token by hitting an API endpoint.
        const client = new DevicApiClient({
          apiKey: tokens.accessToken,
          baseUrl,
        });
        await client.getAssistants();

        saveConfig({
          baseUrl: opts.baseUrl ?? baseUrl,
          oauth: tokens,
          apiKey: undefined,
        });

        return {
          mode: 'oauth',
          baseUrl,
          clientId: opts.clientId,
          scope: tokens.scope,
          expiresAt: new Date(tokens.expiresAt).toISOString(),
        };
      }, (d) => {
        const r = d as Record<string, unknown>;
        if (r.mode === 'api_key') {
          return [
            md.success('Authenticated successfully (API key).'),
            '',
            `**API Key:** ${md.code(String(r.apiKey))}`,
            `**Base URL:** ${r.baseUrl}`,
          ].join('\n');
        }
        return [
          md.success('Authenticated successfully (OAuth).'),
          '',
          `**Client ID:** ${md.code(String(r.clientId))}`,
          `**Scope:** ${md.code(String(r.scope ?? '-'))}`,
          `**Access token expires:** ${r.expiresAt}`,
          `**Base URL:** ${r.baseUrl}`,
        ].join('\n');
      }),
    );

  auth
    .command('status')
    .description('Show current authentication status')
    .action(
      withAction(async () => {
        const config = loadConfig();
        const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        if (config.oauth) {
          return {
            authenticated: true,
            mode: 'oauth',
            baseUrl,
            clientId: config.oauth.clientId,
            scope: config.oauth.scope,
            expiresAt: new Date(config.oauth.expiresAt).toISOString(),
            expired: config.oauth.expiresAt < Date.now(),
          };
        }
        return {
          authenticated: !!config.apiKey,
          mode: config.apiKey ? 'api_key' : 'none',
          baseUrl,
          apiKey: config.apiKey ? `${config.apiKey.slice(0, 10)}...` : undefined,
        };
      }, (d) => {
        const s = d as Record<string, any>;
        if (!s.authenticated) {
          return [
            md.h(2, 'Authentication Status'),
            '',
            `${md.status('error')} **Not authenticated**`,
            '',
            `Run ${md.code('devic auth login')} to authenticate.`,
          ].join('\n');
        }
        const lines = [
          md.h(2, 'Authentication Status'),
          '',
          `${md.status('active')} **Authenticated**`,
          '',
          `**Mode:** ${s.mode}`,
          `**Base URL:** ${s.baseUrl}`,
        ];
        if (s.mode === 'oauth') {
          lines.push(
            `**Client ID:** ${md.code(s.clientId)}`,
            `**Scope:** ${md.code(s.scope ?? '-')}`,
            `**Access token expires:** ${s.expiresAt}${s.expired ? ' (expired — will auto-refresh)' : ''}`,
          );
        } else {
          lines.push(`**API Key:** ${md.code(s.apiKey)}`);
        }
        return lines.join('\n');
      }),
    );

  auth
    .command('logout')
    .description('Remove stored credentials and revoke OAuth refresh token')
    .action(
      withAction(async () => {
        const config = loadConfig();
        const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        if (config.oauth?.refreshToken) {
          await revokeRefreshToken({
            baseUrl,
            refreshToken: config.oauth.refreshToken,
          });
        }
        deleteConfig();
        return { status: 'logged_out' };
      }, () => md.success('Logged out. Credentials removed.')),
    );
}
