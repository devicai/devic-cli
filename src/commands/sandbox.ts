import { Command } from 'commander';
import {
  createClient,
  withAction,
  resolveEnvironmentId,
} from '../helpers.js';
import { md } from '../output.js';

interface SessionRef {
  sandboxId?: string;
  online?: boolean;
  expiresAt?: number;
  status?: string;
  scope?: string;
}

/**
 * Find the sandbox to act on.
 *
 * `--sandbox` wins when given. Otherwise the live session of the environment
 * is used, which is what makes `start` → `exec` → `stop` readable at a
 * terminal without copying an id between commands. When nothing is live the
 * error says so rather than failing deeper with a provider message.
 */
async function resolveSandboxId(
  client: ReturnType<typeof createClient>,
  environmentId: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;

  const session = (await client.sandboxStatus(environmentId)) as SessionRef;
  if (session?.online && session.sandboxId) return session.sandboxId;

  throw new Error(
    'No live sandbox on this environment. Start one with `devic sandbox start ' +
      '<environment>`, or name an existing one with --sandbox.',
  );
}

function remaining(expiresAt?: number): string {
  if (!expiresAt) return '-';
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function registerSandboxCommands(program: Command): void {
  const sandbox = program
    .command('sandbox')
    .description('Run a real Linux machine on an environment');

  // sandbox start <environment>
  sandbox
    .command('start <environment>')
    .description('Start a sandbox session on an environment')
    .option('--timeout <minutes>', 'Session length in minutes (1-30)', '10')
    .option('--tenant <tenantId>', "Start from this tenant's snapshot")
    .option('--force', 'Take over a session that is already active, discarding its unsaved state')
    .option('--force-unsaved-snapshot', 'Start from the last saved version while a save is still running')
    .action(
      withAction(
        async (environment: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.startSandbox(id, {
            timeoutMinutes: o.timeout ? parseInt(o.timeout, 10) : undefined,
            tenantId: o.tenant,
            force: o.force,
            forceUnsavedSnapshot: o.forceUnsavedSnapshot,
          });
        },
        (d) => {
          const r = d as Record<string, any>;
          const lines = [
            md.success('Sandbox started'),
            '',
            `**Sandbox:** ${md.code(r.sandboxId ?? '-')}`,
            `**Runtime:** ${r.runtime ?? '-'}`,
            `**Expires in:** ${remaining(r.expiresAt)}`,
          ];
          // A fresh machine runs the init script; a restore does not. Showing
          // its output here is the whole point of starting one by hand.
          if (r.initScript) {
            lines.push('', md.h(3, `Init script (exit ${r.initScript.exitCode})`));
            if (r.initScript.stdout) lines.push(md.codeBlock(r.initScript.stdout));
            if (r.initScript.stderr) lines.push(md.codeBlock(r.initScript.stderr));
          }
          return lines.join('\n');
        },
      ),
    );

  // sandbox status <environment>
  sandbox
    .command('status <environment>')
    .description('Whether a session is live, reconciled against the engine')
    .action(
      withAction(
        async (environment: unknown) => {
          const client = createClient();
          const id = await resolveEnvironmentId(client, environment as string);
          return client.sandboxStatus(id);
        },
        (d) => {
          const s = d as SessionRef;
          if (!s?.online) return md.info('No live sandbox on this environment.');
          return [
            md.h(2, 'Live sandbox'),
            '',
            `**Sandbox:** ${md.code(s.sandboxId ?? '-')}`,
            `**Scope:** ${s.scope ?? '-'}`,
            `**Expires in:** ${remaining(s.expiresAt)}`,
          ].join('\n');
        },
      ),
    );

  // sandbox exec <environment> <command>
  sandbox
    .command('exec <environment> <command>')
    .description('Run a line of shell in the sandbox (quote it: pipes and && belong inside)')
    .option('--sandbox <sandboxId>', 'Target a specific sandbox instead of the live session')
    .option('--cwd <path>', 'Working directory')
    .option('--sudo', 'Run as root')
    .action(
      withAction(
        async (environment: unknown, command: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const environmentId = await resolveEnvironmentId(client, environment as string);
          const sandboxId = await resolveSandboxId(client, environmentId, o.sandbox);
          return client.execInSandbox(environmentId, {
            sandboxId,
            command: command as string,
            cwd: o.cwd,
            sudo: o.sudo,
          });
        },
        (d) => {
          const r = d as Record<string, any>;
          const lines: string[] = [];
          if (r.stdout) lines.push(md.codeBlock(String(r.stdout).replace(/\n$/, '')));
          if (r.stderr) lines.push(md.h(3, 'stderr'), md.codeBlock(String(r.stderr).replace(/\n$/, '')));
          lines.push(
            '',
            `**Exit code:** ${r.exitCode} · **Duration:** ${r.durationMs}ms · **cwd:** ${md.code(r.cwd ?? '-')}`,
          );
          return lines.join('\n');
        },
      ),
    );

  // sandbox stop <environment>
  const stopCmd = sandbox
    .command('stop <environment>')
    .description('Stop the session. On an evolving snapshot this saves; on a fixed one pass --save')
    .option('--sandbox <sandboxId>', 'Target a specific sandbox instead of the live session')
    .option('--save', 'Write this session into the snapshot, even on a fixed one (this is how you provision)')
    .option('--no-save', 'Throw the session away')
    .option('--force', 'Overwrite the snapshot even if another session replaced it meanwhile')
    .addHelpText(
      'after',
      [
        '',
        'Whether stopping saves depends on the environment, and matches what the',
        'dashboard terminal does:',
        '',
        '  evolving snapshot  saves by default (--no-save to discard)',
        '  fixed snapshot     does NOT save (--save to bake, e.g. after installing deps)',
        '  snapshots off      nothing to save either way',
      ].join('\n'),
    );

  stopCmd.action(
      withAction(
        async (environment: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const environmentId = await resolveEnvironmentId(client, environment as string);
          const sandboxId = await resolveSandboxId(client, environmentId, o.sandbox);

          // Saying nothing must not mean "overwrite the snapshot". The engine's
          // manual-stop route saves whenever `saveChanges` is not false, which
          // would let a plain `stop` rewrite a snapshot the dashboard treats as
          // frozen — so the default is read from the environment instead, and a
          // fixed snapshot is only written when explicitly asked.
          let saveChanges: boolean;
          if (stopCmd.getOptionValueSource('save') === 'cli') {
            saveChanges = !!o.save;
          } else {
            const env = (await client.getEnvironment(environmentId)) as {
              sandboxConfig?: { snapshotEnabled?: boolean; replaceSnapshotOnStop?: boolean };
            };
            const sb = env?.sandboxConfig ?? {};
            saveChanges = !!sb.snapshotEnabled && sb.replaceSnapshotOnStop === true;
          }

          return client.stopSandbox(environmentId, {
            sandboxId,
            saveChanges,
            force: o.force,
          });
        },
        (d) => {
          const r = d as Record<string, any>;
          const lines = [md.success(r.message ?? 'Sandbox stopped')];
          if (r.saving) {
            lines.push(
              '',
              md.info('The snapshot is being saved in the background; the machine stops when it finishes.'),
            );
          }
          if (r.snapshotId) lines.push('', `**Snapshot:** ${md.code(r.snapshotId)}`);
          return lines.join('\n');
        },
      ),
  );

  // sandbox ls <environment> [path]
  sandbox
    .command('ls <environment> [path]')
    .description('List a directory inside the sandbox')
    .option('--sandbox <sandboxId>', 'Target a specific sandbox')
    .action(
      withAction(
        async (environment: unknown, path: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const environmentId = await resolveEnvironmentId(client, environment as string);
          const sandboxId = await resolveSandboxId(client, environmentId, o.sandbox);
          return client.listSandboxFiles(environmentId, {
            sandboxId,
            path: (path as string) || undefined,
          });
        },
        (d) => {
          const r = d as { path?: string; entries?: any[] };
          if (!r.entries?.length) return '_Empty directory._';
          return [
            md.h(2, r.path ?? 'Files'),
            '',
            md.table(
              r.entries.map((e) => ({ name: e.name, type: e.type, size: e.size ?? '-' })),
              { columns: ['name', 'type', 'size'] },
            ),
          ].join('\n');
        },
      ),
    );

  // sandbox cat <environment> <path>
  sandbox
    .command('cat <environment> <path>')
    .description('Read a text file from the sandbox (1 MB max, text only)')
    .option('--sandbox <sandboxId>', 'Target a specific sandbox')
    .action(
      withAction(
        async (environment: unknown, path: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const environmentId = await resolveEnvironmentId(client, environment as string);
          const sandboxId = await resolveSandboxId(client, environmentId, o.sandbox);
          return client.readSandboxFile(environmentId, {
            sandboxId,
            path: path as string,
          });
        },
        (d) => {
          const r = d as { content?: string };
          return r.content ?? '';
        },
      ),
    );

  // sandbox write <environment> <path>
  sandbox
    .command('write <environment> <path>')
    .description('Write a file into the sandbox')
    .option('--sandbox <sandboxId>', 'Target a specific sandbox')
    .option('--content <text>', 'Inline text to write')
    .option('--file <localPath>', 'Read the contents from a local file')
    .option('--url <sourceUrl>', 'Have the sandbox fetch the bytes from this URL')
    .action(
      withAction(
        async (environment: unknown, path: unknown, opts: unknown) => {
          const o = opts as Record<string, any>;
          const client = createClient();
          const environmentId = await resolveEnvironmentId(client, environment as string);
          const sandboxId = await resolveSandboxId(client, environmentId, o.sandbox);

          let content: string | undefined = o.content;
          if (o.file) {
            const { readFile } = await import('node:fs/promises');
            content = await readFile(o.file, 'utf8');
          }
          if (content === undefined && !o.url) {
            throw new Error('Pass one of --content, --file or --url.');
          }
          return client.writeSandboxFile(environmentId, {
            sandboxId,
            destinationPath: path as string,
            content,
            sourceUrl: o.url,
          });
        },
        (d) => {
          const r = d as { path?: string; size?: number };
          return md.success(`Wrote ${r.size ?? '?'} bytes to ${r.path ?? ''}`);
        },
      ),
    );
}
