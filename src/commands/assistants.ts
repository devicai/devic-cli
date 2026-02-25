import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';
import { pollChat } from '../polling.js';
import { md } from '../output.js';
import type { RealtimeChatHistory, ChatHistory, AssistantSpecialization } from '../types.js';

export function registerAssistantCommands(program: Command): void {
  const assistants = program.command('assistants').description('Manage assistants and chats');

  // assistants list
  addListOptions(
    assistants
      .command('list')
      .description('List all assistant specializations')
      .option('--external', 'Only show externally accessible assistants'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as { external?: boolean };
      const client = createClient();
      return client.getAssistants(!!o.external);
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
        return lines.join('\n');
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
    .option('--from-json <file>', 'Read full ProcessMessageDto from JSON file (- for stdin)')
    .action(
      withAction(async (identifier: unknown, opts: unknown) => {
        const id = identifier as string;
        const o = opts as {
          message: string; chatUid?: string; provider?: string; model?: string;
          tags?: string; wait: boolean; fromJson?: string;
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

        if (!o.wait) {
          return client.sendMessage(id, dto as any);
        }

        const asyncRes = await client.sendMessageAsync(id, dto as any);
        const result = await pollChat(client, id, asyncRes.chatUid);
        return result;
      }, (d) => {
        const r = d as RealtimeChatHistory;
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
      .option('--omit-content', 'Exclude chat content'),
  ).action(
    withAction(async (identifier: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string; omitContent?: boolean };
      const client = createClient();
      return client.listConversations(identifier as string, {
        ...parseListOpts(o),
        omitContent: o.omitContent,
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

  // assistants chats search [filters]
  addListOptions(
    chats
      .command('search')
      .description('Search chat histories across all assistants')
      .option('--assistant <identifier>', 'Filter by assistant')
      .option('--tags <tags>', 'Comma-separated tags filter')
      .option('--start-date <date>', 'Start date (ISO string)')
      .option('--end-date <date>', 'End date (ISO string)')
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
          ...(o.assistant && { assistantIdentifier: o.assistant }),
          ...(o.tags && { tags: o.tags.split(',').map(t => t.trim()) }),
          ...(o.startDate && { startDate: o.startDate }),
          ...(o.endDate && { endDate: o.endDate }),
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
