import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';
import { pollChat } from '../polling.js';
import { output, getOutputFormat, outputHuman } from '../output.js';

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
      const items = d as Array<{ identifier: string; name: string; description: string }>;
      if (items.length === 0) return '(no assistants)';
      return items.map(a => `${a.identifier.padEnd(24)} ${a.name}`).join('\n');
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
          // Synchronous mode
          return client.sendMessage(id, dto as any);
        }

        // Async mode with polling
        const asyncRes = await client.sendMessageAsync(id, dto as any);
        const result = await pollChat(client, id, asyncRes.chatUid);
        return result;
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
    }),
  );
}
