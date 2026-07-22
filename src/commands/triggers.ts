import { Command } from 'commander';
import { createClient, withAction, readJsonInput } from '../helpers.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';

/** Outcome → compact marker for the events table. */
const OUTCOME_MARK: Record<string, string> = {
  executed: '[OK]',
  duplicate: '[--]',
  rate_limited: '[!!]',
  disabled: '[off]',
  error: '[XX]',
};

function targetLabel(t: any): string {
  const target = t.target ?? {};
  return target.name || target.id || t.targetId || '-';
}

function formatTrigger(t: any): string {
  const lines = [
    md.h(2, `Trigger: ${t.name || t.triggerSlug}`),
    '',
    `**ID:** ${md.code(t.id)}`,
    `**App:** ${md.code(t.app)}`,
    `**Event:** ${md.code(t.triggerSlug)}`,
    `**Target:** ${t.targetType} — ${targetLabel(t)} (${md.code(t.target?.id ?? '-')})`,
    `**Tool server:** ${md.code(t.toolServerId)}`,
    `**Enabled:** ${t.enabled ? 'Yes' : 'No'}`,
  ];
  if (t.newThreadsState) lines.push(`**New threads:** ${t.newThreadsState}`);
  if (t.rateLimitPerMinute) lines.push(`**Rate limit:** ${t.rateLimitPerMinute}/min`);
  if (t.eventCount != null) lines.push(`**Events seen:** ${t.eventCount}`);
  if (t.autoPausedAt) {
    lines.push(`**Auto-paused:** ${t.autoPauseReason || 'rate limit'}`);
  }
  if (t.messageTemplate) {
    lines.push('', md.h(3, 'Message template'), md.codeBlock(t.messageTemplate));
  }
  if (t.chatUidTemplate) {
    lines.push(`**Chat id template:** ${md.code(t.chatUidTemplate)}`);
  }
  if (t.triggerConfig && Object.keys(t.triggerConfig).length) {
    lines.push(
      '',
      md.h(3, 'Trigger config'),
      md.codeBlock(JSON.stringify(t.triggerConfig, null, 2), 'json'),
    );
  }
  return lines.join('\n');
}

export function registerTriggerCommands(program: Command): void {
  const triggers = program
    .command('triggers')
    .description('Manage triggers — start an agent or assistant from an app event');

  // triggers list
  triggers
    .command('list')
    .description('List triggers')
    .option('--tool-server <id>', 'Only triggers on this tool server')
    .option('--agent <id>', 'Only triggers that start this agent')
    .option('--assistant <id>', 'Only triggers that start this assistant')
    .option('--limit <n>', 'Page size')
    .option('--offset <n>', 'Items to skip')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          toolServer?: string;
          agent?: string;
          assistant?: string;
          limit?: string;
          offset?: string;
        };
        const client = createClient();
        return client.listTriggers({
          toolServerId: o.toolServer,
          agentId: o.agent,
          assistantId: o.assistant,
          limit: o.limit ? Number(o.limit) : undefined,
          offset: o.offset ? Number(o.offset) : undefined,
        });
      }, (d) => {
        const data = d as any;
        const items = data.items ?? [];
        if (items.length === 0) return '_No triggers found._';
        const lines = [
          md.h(2, 'Triggers'),
          '',
          md.table(
            items.map((t: any) => ({
              id: t.id,
              name: t.name || '-',
              app: t.app,
              target: targetLabel(t),
              trigger: t.triggerSlug,
              enabled: t.enabled ? 'yes' : 'no',
            })),
            { columns: ['id', 'name', 'app', 'target', 'trigger', 'enabled'] },
          ),
        ];
        if (data.total != null) lines.push('', md.info(`${data.total} trigger(s)`));
        return lines.join('\n');
      }),
    );

  // triggers get <id>
  triggers
    .command('get <id>')
    .description('Get a trigger')
    .action(
      withAction(async (id: unknown) => {
        const client = createClient();
        return client.getTrigger(id as string);
      }, (d) => formatTrigger(d)),
    );

  // triggers create
  triggers
    .command('create')
    .description('Create a trigger')
    .requiredOption('--tool-server <id>', 'App-integration tool server (source of events)')
    .option('--agent <id>', 'Agent to start (one of --agent / --assistant)')
    .option('--assistant <id>', 'Assistant to start (one of --agent / --assistant)')
    .requiredOption('--trigger <slug>', 'Trigger type slug')
    .option('--name <name>', 'Trigger name')
    .option('--message <template>', 'Message template (empty ⇒ raw event JSON)')
    .option('--chat-uid-template <template>', 'Assistants: stable chat id per event group')
    .option('--state <queued|paused>', 'Agents: initial thread state')
    .option('--rate-limit <n>', 'Events/minute ceiling')
    .option('--from-json <file>', 'triggerConfig JSON (the trigger type’s config schema; - for stdin)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          toolServer: string;
          agent?: string;
          assistant?: string;
          trigger: string;
          name?: string;
          message?: string;
          chatUidTemplate?: string;
          state?: string;
          rateLimit?: string;
          fromJson?: string;
        };
        if (!!o.agent === !!o.assistant) {
          throw new DevicCliError(
            'Provide exactly one of --agent or --assistant.',
            'INVALID_USAGE',
          );
        }
        if (o.state && o.state !== 'queued' && o.state !== 'paused') {
          throw new DevicCliError('--state must be queued or paused.', 'INVALID_USAGE');
        }
        const client = createClient();
        const triggerConfig = o.fromJson
          ? await readJsonInput(o.fromJson)
          : undefined;
        return client.createTrigger({
          toolServerId: o.toolServer,
          ...(o.agent ? { agentId: o.agent } : { assistantId: o.assistant }),
          triggerSlug: o.trigger,
          ...(o.name && { name: o.name }),
          ...(o.message && { messageTemplate: o.message }),
          ...(o.chatUidTemplate && { chatUidTemplate: o.chatUidTemplate }),
          ...(o.state && { newThreadsState: o.state }),
          ...(o.rateLimit && { rateLimitPerMinute: Number(o.rateLimit) }),
          ...(triggerConfig ? { triggerConfig } : {}),
        });
      }, (d) => {
        const t = d as any;
        return [md.success(`Trigger created: ${md.code(t.id)}`), '', formatTrigger(t)].join('\n');
      }),
    );

  // triggers update <id>
  triggers
    .command('update <id>')
    .description('Update a trigger')
    .option('--name <name>', 'Trigger name')
    .option('--message <template>', 'Message template')
    .option('--chat-uid-template <template>', 'Assistants: chat id template')
    .option('--state <queued|paused>', 'Agents: initial thread state')
    .option('--rate-limit <n>', 'Events/minute ceiling')
    .option('--enabled', 'Enable the trigger')
    .option('--disabled', 'Disable the trigger')
    .option('--from-json <file>', 'triggerConfig JSON (- for stdin)')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const o = opts as {
          name?: string;
          message?: string;
          chatUidTemplate?: string;
          state?: string;
          rateLimit?: string;
          enabled?: boolean;
          disabled?: boolean;
          fromJson?: string;
        };
        if (o.enabled && o.disabled) {
          throw new DevicCliError(
            'Pass only one of --enabled / --disabled.',
            'INVALID_USAGE',
          );
        }
        const client = createClient();
        const triggerConfig = o.fromJson ? await readJsonInput(o.fromJson) : undefined;
        const body: Record<string, unknown> = {
          ...(o.name != null && { name: o.name }),
          ...(o.message != null && { messageTemplate: o.message }),
          ...(o.chatUidTemplate != null && { chatUidTemplate: o.chatUidTemplate }),
          ...(o.state && { newThreadsState: o.state }),
          ...(o.rateLimit && { rateLimitPerMinute: Number(o.rateLimit) }),
          ...(o.enabled && { enabled: true }),
          ...(o.disabled && { enabled: false }),
          ...(triggerConfig ? { triggerConfig } : {}),
        };
        return client.updateTrigger(id as string, body);
      }, (d) => {
        const t = d as any;
        return [md.success('Trigger updated.'), '', formatTrigger(t)].join('\n');
      }),
    );

  // triggers delete <id>
  triggers
    .command('delete <id>')
    .description('Delete a trigger')
    .action(
      withAction(async (id: unknown) => {
        const client = createClient();
        return client.deleteTrigger(id as string);
      }, (d) => {
        const r = d as any;
        return md.success(`Trigger ${md.code(r.deletedId || '')} deleted.`);
      }),
    );

  // triggers events <id>
  triggers
    .command('events <id>')
    .description('List a trigger’s recent deliveries')
    .option('--limit <n>', 'Page size')
    .option('--offset <n>', 'Items to skip')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const o = opts as { limit?: string; offset?: string };
        const client = createClient();
        return client.listTriggerEvents(id as string, {
          limit: o.limit ? Number(o.limit) : undefined,
          offset: o.offset ? Number(o.offset) : undefined,
        });
      }, (d) => {
        const data = d as any;
        const items = data.items ?? [];
        if (items.length === 0) return '_No deliveries yet._';
        const lines = [
          md.h(2, 'Deliveries'),
          '',
          md.table(
            items.map((e: any) => ({
              receivedAt: e.receivedAt
                ? new Date(e.receivedAt).toISOString()
                : '-',
              outcome: `${OUTCOME_MARK[e.outcome] ?? ''} ${e.outcome ?? '-'}`.trim(),
              run: e.threadId || e.chatUID || '-',
            })),
            { columns: ['receivedAt', 'outcome', 'run'] },
          ),
        ];
        if (data.total != null) lines.push('', md.info(`${data.total} event(s)`));
        return lines.join('\n');
      }),
    );
}
