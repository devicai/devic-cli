import { Command } from 'commander';
import { createClient, withAction } from '../helpers.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';

/** A tool server's public integration shape, for the created-server message. */
interface IntegrationServer {
  _id?: string;
  name?: string;
  integration?: { app?: string; connected?: boolean; enabledToolCount?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `--tools a,b,c` → ["a","b","c"], trimmed and empties dropped. */
const parseToolList = (value?: string): string[] | undefined =>
  value
    ? value.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

/** Renders a `{tools:[{function,enabled}], total, nextCursor?}` payload. */
function formatIntegrationTools(d: unknown): string {
  const data = d as any;
  const items = data.tools ?? [];
  if (items.length === 0) return '_No tools._';
  const lines = [
    md.h(2, 'Tools'),
    '',
    md.table(
      items.map((t: any) => ({
        name: t.function?.name ?? '-',
        enabled: t.enabled ? 'yes' : 'no',
        description: (t.function?.description ?? '-').slice(0, 70),
      })),
      { columns: ['name', 'enabled', 'description'] },
    ),
  ];
  if (data.total != null) lines.push('', md.info(`${data.total} tool(s)`));
  if (data.nextCursor) {
    lines.push(
      md.info(`More — pass ${md.code(`--cursor ${data.nextCursor}`)} for the next page.`),
    );
  }
  return lines.join('\n');
}

function formatCreatedServer(s: IntegrationServer): string {
  const lines = [
    md.success(`Integration tool server created: ${md.b(s.name || '')}`),
    '',
    `**ID:** ${md.code(s._id || '-')}`,
  ];
  if (s.integration) {
    lines.push(
      `**App:** ${md.code(s.integration.app || '-')}`,
      `**Connected:** ${s.integration.connected ? 'Yes' : 'No'}`,
      `**Exposed tools:** ${s.integration.enabledToolCount ?? "all of the app's"}`,
    );
  }
  lines.push(
    '',
    `_Add a trigger with_ ${md.code(
      `devic triggers create --tool-server ${s._id ?? '<id>'} --agent <id> --trigger <slug>`,
    )}`,
  );
  return lines.join('\n');
}

export function registerIntegrationCommands(program: Command): void {
  const integrations = program
    .command('integrations')
    .description('Browse the connectable-app catalogue and connect accounts');

  // integrations list
  integrations
    .command('list')
    .description('List connectable apps (paginated by cursor)')
    .option('--search <text>', 'Search the catalogue')
    .option('--limit <n>', 'Page size')
    .option('--cursor <cursor>', 'Page token from a previous response')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as { search?: string; limit?: string; cursor?: string };
        const client = createClient();
        return client.listIntegrations({
          search: o.search,
          limit: o.limit ? Number(o.limit) : undefined,
          cursor: o.cursor,
        });
      }, (d) => {
        const data = d as any;
        const items = data.items ?? [];
        if (items.length === 0) return '_No apps found._';
        const lines = [
          md.h(2, 'Apps'),
          '',
          md.table(
            items.map((a: any) => ({
              app: a.slug,
              name: a.name,
              noAuth: a.noAuth ? 'yes' : 'no',
            })),
            { columns: ['app', 'name', 'noAuth'] },
          ),
        ];
        if (data.totalItems != null) {
          lines.push('', md.info(`${data.totalItems} app(s) in the catalogue`));
        }
        if (data.nextCursor) {
          lines.push(
            md.info(
              `More available — pass ${md.code(`--cursor ${data.nextCursor}`)} for the next page.`,
            ),
          );
        }
        return lines.join('\n');
      }),
    );

  // integrations connected
  integrations
    .command('connected')
    .description('List the integrations this workspace has connected')
    .action(
      withAction(async () => {
        const client = createClient();
        return client.listConnectedIntegrations();
      }, (d) => {
        const items = (Array.isArray(d) ? d : []) as any[];
        if (items.length === 0) {
          return [
            '_No integrations connected yet._',
            '',
            md.info(
              'This lists built integration tool servers only. An account you just ' +
                'authorized in the browser will not appear here until you build its ' +
                'server: ' +
                md.code('devic integrations connect <app> --finalize') +
                '.',
            ),
          ].join('\n');
        }
        return [
          md.h(2, 'Connected integrations'),
          '',
          md.table(
            items.map((i) => ({
              id: i.id,
              app: i.app,
              name: i.name,
              connected: i.connected ? 'yes' : 'no',
              tools: i.exposedToolCount ?? 'all',
            })),
            { columns: ['id', 'app', 'name', 'connected', 'tools'] },
          ),
        ].join('\n');
      }),
    );

  // integrations get <app>
  integrations
    .command('get <app>')
    .description('Get a connectable app')
    .action(
      withAction(async (app: unknown) => {
        const client = createClient();
        return client.getIntegration(app as string);
      }, (d) => {
        const a = d as any;
        const lines = [
          md.h(2, `App: ${a.name}`),
          '',
          `**Slug:** ${md.code(a.slug)}`,
        ];
        if (a.description) lines.push(`**Description:** ${a.description}`);
        lines.push(`**Needs connection:** ${a.noAuth ? 'No' : 'Yes'}`);
        lines.push(
          '',
          `_See its events with_ ${md.code(`devic integrations triggers ${a.slug}`)}`,
        );
        return lines.join('\n');
      }),
    );

  // integrations triggers <app> [slug]
  integrations
    .command('triggers <app> [slug]')
    .description('List an app’s event (trigger) types, or show one in full')
    .option('--search <text>', 'Search the app’s trigger types')
    .option('--limit <n>', 'Page size')
    .option('--cursor <cursor>', 'Page token from a previous response')
    .action(
      withAction(async (app: unknown, slug: unknown, opts: unknown) => {
        const o = opts as { search?: string; limit?: string; cursor?: string };
        const client = createClient();
        if (slug) {
          return client.getIntegrationTrigger(app as string, slug as string);
        }
        return client.listIntegrationTriggers(app as string, {
          search: o.search,
          limit: o.limit ? Number(o.limit) : undefined,
          cursor: o.cursor,
        });
      }, (d) => {
        const data = d as any;
        // Single trigger type (has config/payload), vs a page of them.
        if (data.slug && !data.items) {
          const lines = [
            md.h(2, `Trigger: ${data.name}`),
            '',
            `**Slug:** ${md.code(data.slug)}`,
            `**App:** ${md.code(data.app)}`,
          ];
          if (data.type) lines.push(`**Delivery:** ${data.type}`);
          if (data.description) lines.push(`**Description:** ${data.description}`);
          if (data.instructions) lines.push('', md.b('Instructions'), data.instructions);
          if (data.config) {
            lines.push(
              '',
              md.h(3, 'Config (send as triggerConfig)'),
              md.codeBlock(JSON.stringify(data.config, null, 2), 'json'),
            );
          }
          if (data.payload) {
            lines.push(
              '',
              md.h(3, 'Event payload (fields a message template can reference)'),
              md.codeBlock(JSON.stringify(data.payload, null, 2), 'json'),
            );
          }
          return lines.join('\n');
        }

        const items = data.items ?? [];
        if (items.length === 0) return '_No trigger types found._';
        const lines = [
          md.h(2, 'Trigger types'),
          '',
          md.table(
            items.map((t: any) => ({
              slug: t.slug,
              name: t.name,
              delivery: t.type || '-',
              description: (t.description ?? '-').slice(0, 60),
            })),
            { columns: ['slug', 'name', 'delivery', 'description'] },
          ),
        ];
        if (data.totalItems != null) lines.push('', md.info(`${data.totalItems} type(s)`));
        if (data.nextCursor) {
          lines.push(
            md.info(`More — pass ${md.code(`--cursor ${data.nextCursor}`)} for the next page.`),
          );
        }
        return lines.join('\n');
      }),
    );

  // integrations connect <app>
  integrations
    .command('connect <app>')
    .description('Connect an account for an app, then build its tool server')
    .option('--wait', 'Poll until the account is authorized, then build the server')
    .option('--finalize', 'Build the server now (account already authorized)')
    .option('--name <name>', 'Tool server name')
    .option('--tools <a,b,c>', 'Tools to expose (default: all of the app’s)')
    .option('--interval <s>', 'Poll interval in seconds for --wait', '4')
    .option('--timeout <s>', 'Give up after this many seconds for --wait', '180')
    .action(
      withAction(async (app: unknown, opts: unknown) => {
        const o = opts as {
          wait?: boolean;
          finalize?: boolean;
          name?: string;
          tools?: string;
          interval?: string;
          timeout?: string;
        };
        const client = createClient();
        const appSlug = app as string;
        const tools = parseToolList(o.tools);

        // Account already authorized in a previous run — just build the server.
        if (o.finalize) {
          const server = await client.createIntegrationServer(appSlug, {
            name: o.name,
            tools,
          });
          return { _action: 'server', server };
        }

        const { authorizationUrl } = await client.connectIntegration(appSlug);

        if (!o.wait) {
          // The tool server is NOT created yet — authorizing the URL only links
          // the account; a separate build step turns it into an integration.
          // Spell that out in the machine-readable payload too, not just the
          // human hint below: non-interactive callers (agents) only ever see
          // this object, and without it they stop at the URL and never finalize.
          return {
            _action: 'url',
            app: appSlug,
            authorizationUrl,
            status: 'authorization_required',
            toolServerCreated: false,
            nextStep: `Once the account is authorized in the browser, run: devic integrations connect ${appSlug} --finalize`,
            note:
              'Authorizing the URL does NOT create the tool server or activate the ' +
              'integration. Finalize afterwards (or re-run with --wait to authorize ' +
              'and build in one step). Until the server is built the account will ' +
              'not appear in `devic integrations connected`.',
          };
        }

        // Poll for the account to go active, then build the server.
        const interval = Math.max(1, Number(o.interval)) * 1000;
        const deadline = Date.now() + Math.max(5, Number(o.timeout)) * 1000;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { connected } = await client.integrationConnectionStatus(appSlug);
          if (connected) break;
          if (Date.now() >= deadline) {
            throw new DevicCliError(
              `Timed out waiting for the "${appSlug}" account to be authorized. ` +
                `Open the URL, then run \`devic integrations connect ${appSlug} --finalize\`.`,
              'CONNECT_TIMEOUT',
            );
          }
          await sleep(interval);
        }
        const server = await client.createIntegrationServer(appSlug, {
          name: o.name,
          tools,
        });
        return { _action: 'server', server, authorizationUrl };
      }, (d) => {
        const r = d as any;
        if (r._action === 'server') {
          return formatCreatedServer(r.server);
        }
        return [
          md.info('Open this URL in a browser to authorize the account:'),
          '',
          r.authorizationUrl,
          '',
          `_The tool server is not created yet._ Once authorized, build it with ${md.code(
            `devic integrations connect ${r.app} --finalize`,
          )}, or re-run with ${md.code('--wait')} to do it automatically.`,
          '',
          `_Until then the account will not show in_ ${md.code(
            'devic integrations connected',
          )}.`,
        ].join('\n');
      }),
    );

  // ── integrations tools: which of the app's tools this integration exposes ──
  const tools = integrations
    .command('tools')
    .description('Manage which tools a connected integration exposes');

  tools
    .command('list <id>')
    .description('List a connected integration’s tools')
    .option('--available', 'Browse the connected app’s whole catalogue, marking which are enabled')
    .option('--limit <n>', 'Page size when browsing the catalogue')
    .option('--cursor <cursor>', 'Page token from a previous response')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const o = opts as { available?: boolean; limit?: string; cursor?: string };
        const client = createClient();
        return client.listIntegrationTools(id as string, {
          available: o.available,
          limit: o.limit ? Number(o.limit) : undefined,
          cursor: o.cursor,
        });
      }, (d) => formatIntegrationTools(d)),
    );

  tools
    .command('enable <id> [slugs...]')
    .description('Expose more tools (add to the current selection). --all exposes them all.')
    .option('--all', 'Expose every tool the app has')
    .action(
      withAction(async (id: unknown, slugs: unknown, opts: unknown) => {
        const o = opts as { all?: boolean };
        const list = (slugs as string[]) ?? [];
        if (!o.all && list.length === 0) {
          throw new DevicCliError(
            'Name the tools to enable, or pass --all.',
            'INVALID_USAGE',
          );
        }
        const client = createClient();
        return client.updateIntegrationTools(id as string, {
          ...(o.all ? { all: true } : { enable: list }),
        });
      }, (d) => [md.success('Tools updated.'), '', formatIntegrationTools(d)].join('\n')),
    );

  tools
    .command('disable <id> <slugs...>')
    .description('Stop exposing tools (remove from the current selection)')
    .action(
      withAction(async (id: unknown, slugs: unknown) => {
        const client = createClient();
        return client.updateIntegrationTools(id as string, {
          disable: slugs as string[],
        });
      }, (d) => [md.success('Tools updated.'), '', formatIntegrationTools(d)].join('\n')),
    );
}
