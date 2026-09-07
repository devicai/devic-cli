import { Command } from 'commander';
import {
  createClient,
  withAction,
  addListOptions,
  parseListOpts,
  readAndValidateJson,
  addSkipValidationOption,
  resolveProjectId,
  resolveEnvironmentId,
} from '../helpers.js';
import { md } from '../output.js';

interface EnvironmentDto {
  _id?: string;
  name?: string;
  description?: string;
  projectId?: string;
  envVars?: Record<string, string>;
  sandboxConfig?: Record<string, unknown>;
  shellpilotConfig?: Record<string, unknown>;
  creationTimestampMs?: number;
  lastEditTimestampMs?: number;
}

function formatEnvironment(e: EnvironmentDto): string {
  const sb = (e.sandboxConfig ?? {}) as Record<string, unknown>;
  const lines = [
    md.h(2, `Environment: ${e.name ?? '-'}`),
    '',
    `**ID:** ${md.code(e._id ?? '-')}`,
  ];
  if (e.description) lines.push(`**Description:** ${e.description}`);
  if (e.projectId) lines.push(`**Project:** ${md.code(e.projectId)}`);

  const vars = Object.keys(e.envVars ?? {});
  lines.push(
    `**Variables:** ${vars.length ? vars.join(', ') : '_none_'}${
      vars.length ? ' _(values are masked)_' : ''
    }`,
  );

  lines.push('', md.h(3, 'Sandbox'));
  lines.push(
    md.props(
      {
        runtime: sb.runtime ?? 'node24',
        memoryMib: sb.memoryMib ?? '-',
        snapshots: sb.snapshotEnabled
          ? sb.replaceSnapshotOnStop === true
            ? 'evolving (sessions replace it)'
            : 'fixed (sessions cannot rewrite it)'
          : 'off',
        perTenantSnapshots: sb.perTenantSnapshots ?? false,
        autoExtend: sb.autoExtend ?? false,
        persistAfterSessionClose: sb.persistAfterSessionClose ?? false,
        publicUrl: sb.publicUrl ?? '-',
        startCommand: sb.startCommand ?? '-',
      },
      {},
    ),
  );
  if (sb.initScript) {
    lines.push('', md.h(3, 'Init script'), md.codeBlock(String(sb.initScript), 'bash'));
  }
  if (e.lastEditTimestampMs)
    lines.push('', `**Updated:** ${new Date(e.lastEditTimestampMs).toLocaleString()}`);
  return lines.join('\n');
}

/**
 * Turn `--env KEY=VALUE` (repeatable) into the map the API takes.
 *
 * Values are taken verbatim after the first `=`, so a secret containing `=`
 * survives — which most base64 and connection strings do.
 */
function collectEnvVar(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq < 1) {
    throw new Error(`--env expects KEY=VALUE, got "${value}"`);
  }
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

export function registerEnvironmentCommands(program: Command): void {
  const environments = program
    .command('environments')
    .alias('envs')
    .description('Manage environments: the machine, snapshot, tools and secrets an agent works with');

  // environments list
  addListOptions(
    environments
      .command('list')
      .description('List environments')
      .option('--project <project>', 'Filter by project (_id, identifier, or name)'),
  ).action(
    withAction(
      async (opts: unknown) => {
        const o = opts as { project?: string; offset?: string; limit?: string };
        const client = createClient();
        const projectId = o.project
          ? await resolveProjectId(client, o.project)
          : undefined;
        return client.listEnvironments({ projectId, ...parseListOpts(o) });
      },
      (d) => {
        const data = d as any;
        const items = data?.environments ?? (Array.isArray(data) ? data : []);
        if (items.length === 0) return '_No environments found._';
        const lines = [
          md.h(2, 'Environments'),
          '',
          md.table(
            items.map((e: any) => ({
              id: e._id,
              name: e.name,
              runtime: e.sandboxConfig?.runtime ?? 'node24',
              snapshot: e.sandboxConfig?.snapshotEnabled ? 'on' : 'off',
              vars: Object.keys(e.envVars ?? {}).length,
            })),
            { columns: ['id', 'name', 'runtime', 'snapshot', 'vars'] },
          ),
        ];
        if (data?.total != null) lines.push(md.pagination(data));
        return lines.join('\n');
      },
    ),
  );

  // environments get <environment>
  environments
    .command('get <environment>')
    .description('Get environment details (accepts _id or name)')
    .action(
      withAction(async (environment: unknown) => {
        const client = createClient();
        const id = await resolveEnvironmentId(client, environment as string);
        return client.getEnvironment(id);
      }, (d) => formatEnvironment(d as EnvironmentDto)),
    );

  // environments create
  addSkipValidationOption(
    environments
      .command('create')
      .description('Create an environment')
      .option('--name <name>', 'Environment name')
      .option('--description <desc>', 'What this environment is for')
      .option('--project <project>', 'Project (_id, identifier, or name)')
      .option('--runtime <runtime>', 'node24 | node22 | python3.13')
      .option('--memory <mib>', 'Sandbox memory in MiB')
      .option('--init-script <script>', 'Shell script run when a NEW sandbox is created')
      .option('--init-script-file <file>', 'Read the init script from a file')
      .option('--env <KEY=VALUE>', 'Environment variable (repeatable)', collectEnvVar, {})
      .option('--snapshots', 'Save the filesystem between sessions (fixed unless --evolving-snapshot)')
      .option('--evolving-snapshot', "Let every session's changes replace the snapshot. Off by default: agent runs cannot rewrite what you baked")
      .option('--fixed-snapshot', 'Sessions always start from the same saved state (the default)')
      .option('--per-tenant-snapshots', 'Give every tenant its own snapshot')
      .option('--auto-extend', 'Renew the timeout while the sandbox is in use')
      .option('--persist', 'Keep the machine alive after the session closes')
      .option('--public-slug <slug>', 'Subdomain to publish the snapshot under')
      .option('--start-command <cmd>', 'Command run after each restore to serve the snapshot')
      .option('--from-json <file>', 'Read the full payload from JSON (- for stdin)'),
  ).action(
    withAction(
      async (opts: unknown) => {
        const o = opts as Record<string, any>;
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'environment', {
            skip: o.skipValidation,
          });
        } else {
          if (!o.name) throw new Error('--name is required (or use --from-json)');
          data = { name: o.name };
          if (o.description) data.description = o.description;
          if (o.project) data.projectId = await resolveProjectId(client, o.project);
          if (Object.keys(o.env ?? {}).length) data.envVars = o.env;

          const sandboxConfig: Record<string, unknown> = {};
          if (o.runtime) sandboxConfig.runtime = o.runtime;
          if (o.memory) sandboxConfig.memoryMib = parseInt(o.memory, 10);
          if (o.initScriptFile) {
            const { readFile } = await import('node:fs/promises');
            sandboxConfig.initScript = await readFile(o.initScriptFile, 'utf8');
          } else if (o.initScript) {
            sandboxConfig.initScript = o.initScript;
          }
          if (o.snapshots || o.fixedSnapshot || o.evolvingSnapshot)
            sandboxConfig.snapshotEnabled = true;
          // `replaceSnapshotOnStop` is opt-IN in the engine: unset means agent
          // sessions never write back, which is the safe default and the one
          // the dashboard shows. Only `--evolving-snapshot` turns that on.
          if (o.evolvingSnapshot) sandboxConfig.replaceSnapshotOnStop = true;
          if (o.fixedSnapshot) sandboxConfig.replaceSnapshotOnStop = false;
          if (o.perTenantSnapshots) sandboxConfig.perTenantSnapshots = true;
          if (o.autoExtend) sandboxConfig.autoExtend = true;
          if (o.persist) sandboxConfig.persistAfterSessionClose = true;
          if (o.publicSlug) sandboxConfig.publicSlug = o.publicSlug;
          if (o.startCommand) sandboxConfig.startCommand = o.startCommand;
          if (Object.keys(sandboxConfig).length) data.sandboxConfig = sandboxConfig;
        }
        return client.createEnvironment(data);
      },
      (d) => `${md.success('Environment created')}\n\n${formatEnvironment(d as EnvironmentDto)}`,
    ),
  );

  // environments update <environment>
  addSkipValidationOption(
    environments
      .command('update <environment>')
      .description('Update an environment')
      .option('--name <name>', 'Environment name')
      .option('--description <desc>', 'Description')
      .option('--project <project>', 'Project (or "null" to unassign)')
      .option('--runtime <runtime>', 'node24 | node22 | python3.13')
      .option('--memory <mib>', 'Sandbox memory in MiB')
      .option('--init-script <script>', 'Init script')
      .option('--init-script-file <file>', 'Read the init script from a file')
      .option(
        '--env <KEY=VALUE>',
        'Set a variable (repeatable). Merged over the existing ones, so untouched secrets survive.',
        collectEnvVar,
        {},
      )
      .option('--unset-env <KEY>', 'Remove a variable (repeatable)', (v: string, prev: string[]) => [...prev, v], [])
      .option('--snapshots', 'Turn snapshots on')
      .option('--no-snapshots', 'Turn snapshots off')
      .option('--evolving-snapshot', "Let sessions' changes replace the snapshot")
      .option('--fixed-snapshot', 'Freeze the snapshot: sessions always start from the saved state')
      .option('--per-tenant-snapshots', 'Give every tenant its own snapshot')
      .option('--no-per-tenant-snapshots', 'Back to one shared snapshot')
      .option('--persist', 'Keep the machine alive after the session closes')
      .option('--no-persist', 'Let the machine go when the session closes')
      .option('--auto-extend', 'Turn auto-extend on')
      .option('--no-auto-extend', 'Turn auto-extend off')
      .option('--public-slug <slug>', 'Publish the snapshot under this subdomain ("" releases it)')
      .option('--start-command <cmd>', 'Command run after each restore')
      .option('--from-json <file>', 'Read the payload from JSON (- for stdin)'),
  ).action(
    withAction(
      async (environment: unknown, opts: unknown) => {
        const o = opts as Record<string, any>;
        const client = createClient();
        const id = await resolveEnvironmentId(client, environment as string);

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'environment', {
            skip: o.skipValidation,
          });
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
          if (o.project) {
            data.projectId =
              o.project === 'null' ? null : await resolveProjectId(client, o.project);
          }

          const setVars: Record<string, string> = o.env ?? {};
          const unset: string[] = o.unsetEnv ?? [];
          if (Object.keys(setVars).length || unset.length) {
            // The API replaces the whole map, so a partial edit has to start
            // from what is stored. The stored values come back masked, and the
            // backend reads a returned mask as "keep the secret" — which is
            // what makes this merge non-destructive.
            const current = (await client.getEnvironment(id)) as EnvironmentDto;
            const merged = { ...(current.envVars ?? {}), ...setVars };
            for (const key of unset) delete merged[key];
            data.envVars = merged;
          }

          const sandboxConfig: Record<string, unknown> = {};
          if (o.runtime) sandboxConfig.runtime = o.runtime;
          if (o.memory) sandboxConfig.memoryMib = parseInt(o.memory, 10);
          if (o.initScriptFile) {
            const { readFile } = await import('node:fs/promises');
            sandboxConfig.initScript = await readFile(o.initScriptFile, 'utf8');
          } else if (o.initScript) {
            sandboxConfig.initScript = o.initScript;
          }
          if (o.evolvingSnapshot && o.fixedSnapshot) {
            throw new Error(
              'Pass one of --evolving-snapshot or --fixed-snapshot, not both.',
            );
          }
          if (o.snapshots !== undefined) sandboxConfig.snapshotEnabled = !!o.snapshots;
          if (o.evolvingSnapshot) sandboxConfig.replaceSnapshotOnStop = true;
          if (o.fixedSnapshot) sandboxConfig.replaceSnapshotOnStop = false;
          if (o.perTenantSnapshots !== undefined)
            sandboxConfig.perTenantSnapshots = !!o.perTenantSnapshots;
          if (o.persist !== undefined)
            sandboxConfig.persistAfterSessionClose = !!o.persist;
          if (o.autoExtend !== undefined) sandboxConfig.autoExtend = !!o.autoExtend;
          if (o.publicSlug !== undefined)
            sandboxConfig.publicSlug = o.publicSlug === '' ? null : o.publicSlug;
          if (o.startCommand !== undefined) sandboxConfig.startCommand = o.startCommand;

          if (Object.keys(sandboxConfig).length) {
            // sandboxConfig is replaced wholesale too: carry the rest over.
            const current = (await client.getEnvironment(id)) as EnvironmentDto;
            data.sandboxConfig = { ...(current.sandboxConfig ?? {}), ...sandboxConfig };
          }
        }
        return client.updateEnvironment(id, data);
      },
      (d) => `${md.success('Environment updated')}\n\n${formatEnvironment(d as EnvironmentDto)}`,
    ),
  );

  // environments delete <environment>
  environments
    .command('delete <environment>')
    .description('Delete an environment and the per-tenant snapshots it owns')
    .action(
      withAction(async (environment: unknown) => {
        const client = createClient();
        const id = await resolveEnvironmentId(client, environment as string);
        return client.deleteEnvironment(id);
      }, () => md.success('Environment deleted')),
    );

  // environments connections <environment>
  environments
    .command('connections <environment>')
    .description('List the agents and assistants connected to an environment')
    .action(
      withAction(
        async (environment: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.getEnvironmentConnections(id);
        },
        (d) => {
          const data = d as { agents?: any[]; assistants?: any[] };
          const rows = [
            ...(data.agents ?? []).map((a) => ({ type: 'agent', id: a._id, name: a.name })),
            ...(data.assistants ?? []).map((a) => ({
              type: 'assistant',
              id: a._id ?? a.identifier,
              name: a.name,
            })),
          ];
          if (!rows.length) return '_Nothing is connected to this environment._';
          return [md.h(2, 'Connected'), '', md.table(rows, { columns: ['type', 'id', 'name'] })].join('\n');
        },
      ),
    );

  // environments connect <environment> <entityType> <entityId>
  environments
    .command('connect <environment> <entityType> <entityId>')
    .description('Connect an agent or assistant to an environment (entityType: agent | assistant)')
    .option('--env <KEY=VALUE>', 'Variable specific to this pair (repeatable)', collectEnvVar, {})
    .action(
      withAction(
        async (environment: unknown, entityType: unknown, entityId: unknown, opts: unknown) => {
          const o = opts as { env?: Record<string, string> };
          const type = entityType as string;
          if (type !== 'agent' && type !== 'assistant') {
            throw new Error(`entityType must be "agent" or "assistant", got "${type}"`);
          }
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.connectEnvironment(
            id,
            type,
            entityId as string,
            Object.keys(o.env ?? {}).length ? o.env : undefined,
          );
        },
        () => md.success('Connected'),
      ),
    );

  // environments disconnect <environment> <entityType> <entityId>
  environments
    .command('disconnect <environment> <entityType> <entityId>')
    .description('Disconnect an agent or assistant from an environment')
    .action(
      withAction(
        async (environment: unknown, entityType: unknown, entityId: unknown) => {
          const type = entityType as string;
          if (type !== 'agent' && type !== 'assistant') {
            throw new Error(`entityType must be "agent" or "assistant", got "${type}"`);
          }
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.disconnectEnvironment(id, type, entityId as string);
        },
        () => md.success('Disconnected'),
      ),
    );

  // ── snapshots ──

  const snapshots = environments
    .command('snapshot')
    .description('The saved machine state sessions start from');

  snapshots
    .command('init <environment>')
    .description('Bake (or re-bake) the base snapshot: runs the init script and the CLIs, then saves')
    .action(
      withAction(
        async (environment: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.initializeEnvironmentSnapshot(id);
        },
        (d) => {
          const r = d as Record<string, unknown>;
          return [
            md.success('Snapshot initialized'),
            '',
            md.props(r, { pick: ['snapshotId', 'provider', 'publicUrl', 'initScript'] }),
          ].join('\n');
        },
      ),
    );

  snapshots
    .command('tenants <environment>')
    .description('List the per-tenant snapshots derived from this environment')
    .option('--limit <n>', 'Maximum items to return')
    .option('--skip <n>', 'Items to skip')
    .action(
      withAction(
        async (environment: unknown, opts: unknown) => {
          const o = opts as { limit?: string; skip?: string };
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.listEnvironmentTenantSnapshots(id, {
            limit: o.limit ? parseInt(o.limit, 10) : undefined,
            skip: o.skip ? parseInt(o.skip, 10) : undefined,
          });
        },
        (d) => {
          const data = d as { items?: any[]; total?: number };
          const items = data?.items ?? [];
          if (!items.length) return '_No per-tenant snapshots._';
          return [
            md.h(2, 'Per-tenant snapshots'),
            '',
            md.table(
              items.map((s) => ({
                tenantId: s.tenantId,
                status: s.status,
                snapshotId: s.snapshotId ?? '-',
                sessions: s.sessionCount ?? 0,
                lastUsed: s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : '-',
              })),
              { columns: ['tenantId', 'status', 'snapshotId', 'sessions', 'lastUsed'] },
            ),
          ].join('\n');
        },
      ),
    );

  snapshots
    .command('init-tenant <environment> <tenantId>')
    .description("Derive (or re-derive) one tenant's snapshot from the base — discards its state")
    .action(
      withAction(
        async (environment: unknown, tenantId: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.initializeTenantSnapshot(id, tenantId as string);
        },
        () => md.success('Tenant snapshot initialized'),
      ),
    );

  snapshots
    .command('delete-tenant <environment> <tenantId>')
    .description("Drop a tenant's snapshot: its next session starts from the base again")
    .action(
      withAction(
        async (environment: unknown, tenantId: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.deleteTenantSnapshot(id, tenantId as string);
        },
        () => md.success('Tenant snapshot deleted'),
      ),
    );

  // ── sessions ──

  const sessions = environments
    .command('sessions')
    .description('Sandbox sessions run on an environment');

  sessions
    .command('list <environment>')
    .description('List the sessions run on this environment')
    .action(
      withAction(
        async (environment: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.listEnvironmentSessions(id);
        },
        (d) => {
          const items = (Array.isArray(d) ? d : (d as any)?.items) ?? [];
          if (!items.length) return '_No sessions yet._';
          return [
            md.h(2, 'Sessions'),
            '',
            md.table(
              items.map((s: any) => ({
                id: s._id,
                scope: s.scope,
                entity: s.entityName ?? '-',
                status: s.status,
                started: s.startedAt ? new Date(s.startedAt).toLocaleString() : '-',
              })),
              { columns: ['id', 'scope', 'entity', 'status', 'started'] },
            ),
          ].join('\n');
        },
      ),
    );

  sessions
    .command('get <environment> <sessionId>')
    .description('One session with its command log')
    .action(
      withAction(async (environment: unknown, sessionId: unknown) => {
        const client = createClient();
        const id = await resolveEnvironmentId(client, environment as string);
        return client.getEnvironmentSession(id, sessionId as string);
      }),
    );

  // environments clis <environment>
  environments
    .command('clis <environment>')
    .description('CLIs available and installed on this environment')
    .action(
      withAction(async (environment: unknown) => {
        const client = createClient();
        const id = await resolveEnvironmentId(client, environment as string);
        return client.listEnvironmentClis(id);
      }),
    );
}
