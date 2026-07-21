import { Command } from 'commander';
import {
  createClient,
  withAction,
  addListOptions,
  parseListOpts,
  readJsonInput,
  readAndValidateJson,
  addSkipValidationOption,
  resolveProjectId,
} from '../helpers.js';
import { pollChat } from '../polling.js';
import { md, output } from '../output.js';
import { DevicCliError } from '../errors.js';
import { MAX_BUDGET_SECONDS } from '../watch/threadWatch.js';
import { watchChat } from '../watch/chatWatch.js';
import type { ChatWatchResult } from '../watch/chatWatch.js';
import { renderChatWatch } from '../watch/render.js';
import type { RealtimeChatHistory, ChatHistory, AssistantSpecialization } from '../types.js';

// The chats search endpoint filters by creation timestamps in milliseconds
// (createdAfter/createdBefore). Date-only end dates are pushed to the end of
// the day so `--end-date 2026-07-09` includes chats created during that day.
function parseDateToMs(value: string, endOfDay = false): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date: "${value}". Use an ISO date like 2026-07-09 or 2026-07-09T18:00:00Z`);
  }
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return ms + 24 * 60 * 60 * 1000 - 1;
  }
  return ms;
}

function formatAssistant(a: AssistantSpecialization): string {
  const lines = [
    md.h(2, `Assistant: ${a.name}`),
    '',
    `**Identifier:** ${md.code(a.identifier)}`,
  ];
  if (a._id) lines.push(`**ID:** ${md.code(a._id)}`);
  if (a.description) lines.push(`**Description:** ${a.description}`);
  if (a.state) lines.push(`**State:** ${md.status(a.state)} ${a.state}`);
  if (a.model) lines.push(`**Model:** ${a.model}`);
  if (a.provider) lines.push(`**Provider:** ${a.provider}`);
  if (a.isCustom != null) lines.push(`**Custom:** ${a.isCustom ? 'Yes' : 'No'}`);
  if (a.creationTimestampMs) lines.push(`**Created:** ${new Date(a.creationTimestampMs).toLocaleString()}`);
  return lines.join('\n');
}

export function registerAssistantCommands(program: Command): void {
  const assistants = program.command('assistants').description('Manage assistants and chats');

  // assistants list
  addListOptions(
    assistants
      .command('list')
      .description('List all assistant specializations')
      .option('--external', 'Only show externally accessible assistants')
      .option('--project <project>', 'Filter assistants by project (_id, identifier, or name)'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as { external?: boolean; project?: string };
      const client = createClient();
      const projectId = o.project ? await resolveProjectId(client, o.project) : undefined;
      return client.getAssistants(!!o.external, projectId);
    }, (d) => {
      const items = d as AssistantSpecialization[];
      if (items.length === 0) return '_No assistants found._';
      return [
        md.h(2, 'Assistants'),
        '',
        md.table(items.map(a => ({
          identifier: a.identifier,
          name: a.name,
          description: a.description || '-',
          state: a.state || 'active',
          model: a.model || '-',
        })), { columns: ['identifier', 'name', 'description', 'state', 'model'] }),
        '',
        md.info(`${items.length} assistant(s) found`),
      ].join('\n');
    }),
  );

  // assistants get <id>
  assistants
    .command('get <identifier>')
    .description('Get details of a specific assistant')
    .action(
      withAction(async (identifier: unknown) => {
        const client = createClient();
        return client.getAssistant(identifier as string);
      }, (d) => {
        const a = d as AssistantSpecialization;
        const lines = [
          md.h(2, `Assistant: ${a.name}`),
          '',
          `**Identifier:** ${md.code(a.identifier)}`,
          `**Description:** ${a.description}`,
          `**State:** ${md.status(a.state || 'active')} ${a.state || 'active'}`,
        ];
        if (a.model) lines.push(`**Model:** ${a.model}`);
        if (a.provider) lines.push(`**Provider:** ${a.provider}`);
        if (a.isCustom != null) lines.push(`**Custom:** ${a.isCustom ? 'Yes' : 'No'}`);
        if (a.creationTimestampMs) lines.push(`**Created:** ${new Date(a.creationTimestampMs).toLocaleString()}`);

        if (a.availableToolsGroups && a.availableToolsGroups.length > 0) {
          lines.push('', md.h(3, 'Tool Groups'));
          for (const g of a.availableToolsGroups) {
            lines.push(`- **${g.name}**${g.description ? ` — ${g.description}` : ''}`);
            if (g.tools && g.tools.length > 0) {
              for (const t of g.tools) {
                lines.push(`  - ${md.code(t.name)}: ${t.description}`);
              }
            }
          }
        }

        if (a.isCustom) {
          if (a.enabledTools == null) {
            lines.push('', `**Enabled tools:** all`);
          } else if (a.enabledTools.length === 0) {
            lines.push('', `**Enabled tools:** none`);
          } else {
            lines.push('', `**Enabled tools:** ${a.enabledTools.map((t) => md.code(t)).join(', ')}`);
          }
        }
        return lines.join('\n');
      }),
    );

  // assistants create
  addSkipValidationOption(
    assistants
      .command('create')
      .description('Create a new assistant')
      .option('--name <name>', 'Assistant name')
      .option('--description <desc>', 'Assistant description')
      .option('--project <project>', 'Project this assistant belongs to (_id, identifier, or name)')
      .option('--from-json <file>', 'Read full assistant config from JSON file (- for stdin)'),
  ).action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          name?: string;
          description?: string;
          project?: string;
          fromJson?: string;
          skipValidation?: boolean;
        };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'assistant', { skip: o.skipValidation });
          if (o.project && !data.projectId) data.projectId = await resolveProjectId(client, o.project);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
          if (o.project) data.projectId = await resolveProjectId(client, o.project);
        }
        return client.createAssistant(data);
      }, (d) => {
        const a = d as AssistantSpecialization;
        return [md.success(`Assistant created: ${md.b(a.name)}`), '', formatAssistant(a)].join('\n');
      }),
    );

  // assistants update <identifier>
  addSkipValidationOption(
    assistants
      .command('update <identifier>')
      .description('Update an assistant')
      .option('--name <name>', 'Assistant name')
      .option('--description <desc>', 'Assistant description')
      .option('--project <project>', 'Project _id, identifier, or name (use "null" to unset)')
      .option(
        '--enabled-tools <names>',
        'Comma-separated tool names to enable, replacing the current selection (empty string enables none)',
      )
      .option('--all-tools', 'Enable every tool of the assigned tool groups')
      .option('--from-json <file>', 'Read update payload from JSON file (- for stdin)'),
  ).action(
      withAction(async (identifier: unknown, opts: unknown) => {
        const o = opts as {
          name?: string;
          description?: string;
          project?: string;
          enabledTools?: string;
          allTools?: boolean;
          fromJson?: string;
          skipValidation?: boolean;
        };
        if (o.enabledTools !== undefined && o.allTools) {
          throw new Error('--enabled-tools and --all-tools are mutually exclusive');
        }
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'assistant', { skip: o.skipValidation });
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
          if (o.project !== undefined)
            data.projectId = o.project === 'null' ? null : await resolveProjectId(client, o.project);
        }
        // Tool selection stays untouched unless asked for, so a partial update
        // never widens what the assistant can call.
        if (o.allTools) {
          data.enabledTools = null;
        } else if (o.enabledTools !== undefined) {
          data.enabledTools = o.enabledTools
            .split(',')
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
        }
        return client.updateAssistant(identifier as string, data);
      }, (d) => {
        const a = d as AssistantSpecialization;
        return [md.success(`Assistant updated: ${md.b(a.name)}`), '', formatAssistant(a)].join('\n');
      }),
    );

  // assistants delete <identifier>
  assistants
    .command('delete <identifier>')
    .description('Delete an assistant')
    .action(
      withAction(async (identifier: unknown) => {
        const client = createClient();
        return client.deleteAssistant(identifier as string);
      }, (d) => {
        const r = d as any;
        return md.success(r.message || `Assistant ${md.code(r.deletedId || '')} deleted.`);
      }),
    );

  // assistants chat <id> --message "..."
  assistants
    .command('chat <identifier>')
    .description('Send a message to an assistant')
    .requiredOption('-m, --message <text>', 'Message to send')
    .option('--chat-uid <uid>', 'Continue an existing conversation')
    .option('--provider <provider>', 'LLM provider override')
    .option('--model <model>', 'Model override')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--wait', 'Use async mode and poll for result (default)', true)
    .option('--no-wait', 'Use synchronous mode (blocks until response)')
    .option('--detach', 'Send in async mode and return the chatUid immediately, without polling')
    .option('--from-json <file>', 'Read full ProcessMessageDto from JSON file (- for stdin)')
    .action(
      withAction(async (identifier: unknown, opts: unknown) => {
        const id = identifier as string;
        const o = opts as {
          message: string; chatUid?: string; provider?: string; model?: string;
          tags?: string; wait: boolean; detach?: boolean; fromJson?: string;
        };
        const client = createClient();

        let dto: Record<string, unknown>;
        if (o.fromJson) {
          dto = await readJsonInput(o.fromJson);
          if (!dto.message) dto.message = o.message;
        } else {
          dto = {
            message: o.message,
            ...(o.chatUid && { chatUid: o.chatUid }),
            ...(o.provider && { provider: o.provider }),
            ...(o.model && { model: o.model }),
            ...(o.tags && { tags: o.tags.split(',').map(t => t.trim()) }),
          };
        }

        if (!o.wait && !o.detach) {
          return client.sendMessage(id, dto as any);
        }

        const asyncRes = await client.sendMessageAsync(id, dto as any);
        // `--detach` exists for callers that cannot block: polling here would
        // hold the process for up to five minutes, and a sandboxed command dies
        // long before that. Follow up with `assistants chats watch`.
        if (o.detach) return asyncRes;
        return pollChat(client, id, asyncRes.chatUid);
      }, (d) => {
        const r = d as RealtimeChatHistory & { chatUid?: string };
        if (r.chatUid && !r.chatHistory) {
          return [
            md.success(`Message sent. Chat ${md.code(r.chatUid)} is processing.`),
            '',
            `Watch it with: ${md.code(`devic assistants chats watch ${r.chatUid} --assistant <identifier>`)}`,
          ].join('\n');
        }
        if (!r.chatHistory && Array.isArray(d)) {
          // Sync mode returns ChatMessage[]
          return [
            md.h(2, 'Chat Response'),
            '',
            md.conversation(d as any),
          ].join('\n');
        }
        const lines = [
          md.h(2, 'Chat Result'),
          '',
          `**Chat UID:** ${md.code(r.chatUID)}`,
          `**Status:** ${md.status(r.status)} ${r.status}`,
        ];
        if (r.handedOffSubThreadId) {
          lines.push(`**Subthread:** ${md.code(r.handedOffSubThreadId)}`);
        }
        if (r.chatHistory && r.chatHistory.length > 0) {
          lines.push('', md.hr(), '');
          lines.push(md.conversation(r.chatHistory));
        }
        return lines.join('\n');
      }),
    );

  // assistants stop <identifier> <chatUid>
  assistants
    .command('stop <identifier> <chatUid>')
    .description('Stop an in-progress async chat')
    .action(
      withAction(async (identifier: unknown, chatUid: unknown) => {
        const client = createClient();
        return client.stopChat(identifier as string, chatUid as string);
      }, (d) => {
        const r = d as { chatUid: string; message: string };
        return md.success(`Chat ${md.code(r.chatUid)} stopped. ${r.message}`);
      }),
    );

  // assistants chats ...
  const chats = assistants.command('chats').description('Manage chat histories');

  // assistants chats list <identifier>
  addListOptions(
    chats
      .command('list <identifier>')
      .description('List chat histories for an assistant')
      .option('--omit-content', 'Exclude chat content')
      .option('--tenant-id <id>', 'Filter by tenant ID')
      .option('--subtenant-id <id>', 'Filter by subtenant ID (end user/entity inside a tenant)'),
  ).action(
    withAction(async (identifier: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string; omitContent?: boolean; tenantId?: string; subtenantId?: string };
      const client = createClient();
      return client.listConversations(identifier as string, {
        ...parseListOpts(o),
        omitContent: o.omitContent,
        tenantId: o.tenantId,
        subtenantId: o.subtenantId,
      });
    }, (d) => {
      const data = d as any;
      const items = data.histories ?? data.chats ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No chats found._';
      const lines = [
        md.h(2, 'Chat Histories'),
        '',
        md.table(items.map((c: any) => ({
          chatUID: c.chatUID ?? c.chatUid,
          name: c.name || '-',
          created: c.creationTimestampMs ? new Date(c.creationTimestampMs).toLocaleString() : c.createdAt || '-',
        }))),
      ];
      if (data.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );

  // assistants chats get <identifier> <chatUid>
  chats
    .command('get <identifier> <chatUid>')
    .description('Get a specific chat history')
    .action(
      withAction(async (identifier: unknown, chatUid: unknown) => {
        const client = createClient();
        return client.getChatHistory(identifier as string, chatUid as string);
      }, (d) => {
        const h = d as ChatHistory;
        const lines = [
          md.h(2, `Chat: ${h.name || h.chatUID}`),
          '',
          `**Chat UID:** ${md.code(h.chatUID)}`,
          `**Assistant:** ${md.code(h.assistantSpecializationIdentifier)}`,
          `**Created:** ${new Date(h.creationTimestampMs).toLocaleString()}`,
        ];
        if (h.llm) lines.push(`**Model:** ${h.llm}`);
        if (h.inputTokens != null) lines.push(`**Tokens:** ${h.inputTokens} in / ${h.outputTokens ?? 0} out`);
        if (h.handedOff) lines.push(`**Handed Off:** Yes (thread: ${md.code(h.handedOffSubThreadId ?? '?')})`);
        if (h.chatContent && h.chatContent.length > 0) {
          lines.push('', md.hr(), '', md.conversation(h.chatContent));
        }
        return lines.join('\n');
      }),
    );

  // assistants chats watch <chatUid>
  chats
    .command('watch <chatUid>')
    .description('Watch a chat for a short window and report only what changed since the last check')
    .requiredOption('--assistant <identifier>', 'Assistant identifier the chat belongs to')
    .option('--wait <seconds>', 'Wait before looking (spaces out consecutive checks)', '0')
    .option('--window <seconds>', 'How long to keep watching', '35')
    .option('--interval <seconds>', 'How often to re-check the chat', '3')
    .option('--since <cursor>', 'Only report activity after this cursor (from a previous watch)')
    .option('--until <event>', 'Return only on this event: change | terminal', 'change')
    .addHelpText(
      'after',
      `
Exit codes:
  0   finished, or the realtime view expired and the outcome came from history
  10  waiting for a client-side tool response
  11  blocked by a usage limit
  12  still running — call again with the returned cursor
  13  no progress across several consecutive checks

\`--wait\` + \`--window\` must stay at or below ${MAX_BUDGET_SECONDS}s: sandboxed commands are killed at ~45s.
The realtime view lives in Redis for one hour after the last update; once it is gone this
falls back to the persisted history, which is complete but no longer live.`,
    )
    .action(
      withAction(async (chatUid: unknown, opts: unknown) => {
        const o = opts as {
          assistant: string; wait: string; window: string; interval: string;
          since?: string; until?: string;
        };
        const until = o.until as 'change' | 'terminal';
        if (!['change', 'terminal'].includes(until)) {
          throw new DevicCliError('--until must be one of: change, terminal', 'INVALID_UNTIL');
        }
        const client = createClient();
        const result = await watchChat(client, chatUid as string, {
          assistant: o.assistant,
          wait: Number(o.wait),
          window: Number(o.window),
          interval: Number(o.interval),
          since: o.since,
          until,
        });
        // The exit code is the signal the copilot branches on, so it has to be
        // set here: `withAction` only owns the failure paths.
        output(result, d => renderChatWatch(d as ChatWatchResult));
        process.exit(result.exitCode);
      }),
    );

  // assistants chats search [filters]
  addListOptions(
    chats
      .command('search')
      .description('Search chat histories across all assistants')
      .option('--assistant <identifier>', 'Filter by assistant')
      .option('--tags <tags>', 'Comma-separated tags filter')
      .option('--start-date <date>', 'Chats created on/after this date (ISO string, inclusive)')
      .option('--end-date <date>', 'Chats created on/before this date (ISO string, inclusive)')
      .option('--omit-content', 'Exclude chat content')
      .option('--from-json <file>', 'Read filters from JSON file (- for stdin)'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as {
        assistant?: string; tags?: string; startDate?: string; endDate?: string;
        omitContent?: boolean; fromJson?: string; offset?: string; limit?: string;
      };
      const client = createClient();
      let filters: Record<string, unknown>;
      if (o.fromJson) {
        filters = await readJsonInput(o.fromJson);
      } else {
        filters = {
          ...(o.assistant && { assistantSpecializationIdentifier: o.assistant }),
          ...(o.tags && { tags: o.tags.split(',').map(t => t.trim()) }),
          ...(o.startDate && { createdAfter: parseDateToMs(o.startDate) }),
          ...(o.endDate && { createdBefore: parseDateToMs(o.endDate, true) }),
        };
      }
      return client.searchChats(filters, { ...parseListOpts(o), omitContent: o.omitContent });
    }, (d) => {
      const data = d as any;
      const items = data.histories ?? data.chats ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No chats found matching filters._';
      const lines = [
        md.h(2, 'Search Results'),
        '',
        md.table(items.map((c: any) => ({
          chatUID: c.chatUID ?? c.chatUid,
          assistant: c.assistantSpecializationIdentifier || '-',
          name: c.name || '-',
          created: c.creationTimestampMs ? new Date(c.creationTimestampMs).toLocaleString() : c.createdAt || '-',
        }))),
      ];
      if (data.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );
}
