import type { Submission } from '../live/paste.js';
import { Command } from 'commander';
import { LiveInput, commandOptions } from '../live/input.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../helpers.js';
import { ConversationFailure, compactionNotFound, explainFailure, requireActiveAssistant } from '../live/failures.js';
import { LiveRenderer, safe } from '../live/render.js';
import { localTools, runLocalTool } from '../live/local-tools.js';
import type { RealtimeChatHistory, ToolCallResponse } from '../types.js';

interface Options { agent?: boolean; chatUid?: string; thread?: string; message?: string; localTools?: boolean; workspace: string; polling?: boolean }

export function registerLiveCommand(program: Command): void {
  program.command('live <identifier>')
    .description('Interactive cloud assistant, or live agent execution with --agent (prototype)')
    .option('--agent', 'Use an agent instead of an assistant (thread polling)')
    .option('--chat-uid <uid>', 'Resume an assistant conversation')
    .option('--thread <id>', 'Follow an existing agent thread (requires --agent)')
    .option('-m, --message <text>', 'Send one message, follow the response and exit')
    .option('--local-tools', 'Offer read_file and list_files via MIP, confirming each call (TTY only)')
    .option('--workspace <path>', 'Root for local tools', process.cwd())
    .option('--polling', 'Use polling instead of assistant SSE')
    .action(async (identifier: string, options: Options) => {
      if (options.agent && (options.chatUid || options.localTools)) throw new Error('--chat-uid and --local-tools are assistant-only');
      if (options.thread && !options.agent) throw new Error('--thread requires --agent');
      if (options.thread && options.message) throw new Error('Use --thread to follow or -m to create a thread, not both');
      const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
      if (!interactive && options.localTools) throw new Error('--local-tools requires an interactive terminal for approvals');
      if (!interactive && !options.message && !options.thread && !options.chatUid) throw new Error('Use -m, --thread or --chat-uid outside an interactive terminal');
      const client = createClient();
      const rl = interactive ? new LiveInput() : undefined;
      const renderer = new LiveRenderer();
      let chatUid = options.chatUid;
      let threadId = options.thread;
      let active: AbortController | undefined;
      let closed = false;
      let displayName = identifier;
      let state = '';
      let tasks = '';
      let useStream = !options.polling;
      const answered = new Set<string>();
      const note = (text: string) => renderer.note(text);
      const question = async (prompt: string, commands = false) => { renderer.finish(); return closed ? '/exit' : (await rl!.question(prompt, commands ? commandOptions(!!options.agent) : [])).trim(); };
      const detach = () => {
        if (active) { active.abort(); note('Detached. Cloud execution continues. Use /follow or /stop.'); }
        else { closed = true; rl?.close(); }
      };
      if (rl) { rl.on('pasteError', error => note(`Paste failed: ${error instanceof Error ? error.message : String(error)}`)); rl.on('SIGINT', detach); rl.on('close', () => { closed = true; active?.abort(); }); }
      else process.on('SIGINT', detach);

      async function follow(): Promise<void> {
        const controller = new AbortController();
        active = controller;
        renderer.busy();
        const deadline = Date.now() + 10 * 60_000;
        const pause = () => delay(1000, undefined, { signal: controller.signal });
        try {
          while (!controller.signal.aborted && !closed) {
            if (Date.now() > deadline) { note('Follow timeout after 10 minutes; resume with /follow. Session details: /status.'); break; }
            if (options.agent) {
              if (!threadId) return;
              const thread = await client.getThread(threadId, true, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
              renderer.messages(thread.threadContent || []);
              if (thread.state !== state) {
                state = thread.state;
                if (state === 'paused_for_approval') note('Approval needed · /approve or /reject');
                else if (['paused', 'paused_for_resume'].includes(state)) note('Paused · /resume to continue');
                else if (state === 'waiting_for_response') note('Waiting for your response');
              }
              const nextTasks = JSON.stringify(thread.tasks || []);
              if (nextTasks !== tasks) {
                tasks = nextTasks;
                for (const task of thread.tasks || []) note(`${task.completed ? '[x]' : '[ ]'} ${task.title || task.description || ''}`);
              }
              if (['failed', 'limit_exceeded', 'guardrail_trigger'].includes(thread.state)) {
                throw new Error(thread.finishReason || `Thread ${thread.state}`);
              }
              if (!['queued', 'processing', 'handed_off'].includes(thread.state)) return;
              renderer.busy(thread.state === 'handed_off' ? 'Working with a subagent' : 'Working');
              await pause(); continue;
            }
            if (!chatUid) return;
            let gate: RealtimeChatHistory | undefined;
            const receive = (snapshot: RealtimeChatHistory) => {
              renderer.snapshot(snapshot);
              renderer.busy(snapshot.status === 'handed_off' ? 'Working with a subagent' : 'Thinking');
              state = snapshot.status;
              if (['completed', 'error', 'limit_exceeded', 'waiting_for_tool_response'].includes(snapshot.status)) gate = snapshot;
            };
            if (useStream) {
              const connection = new AbortController();
              const abort = () => connection.abort();
              controller.signal.addEventListener('abort', abort, { once: true });
              // Bound a silent/broken connection; polling recovers from the authoritative snapshot.
              const timeout = setTimeout(abort, Math.min(60_000, deadline - Date.now()));
              try {
                await client.streamRealtimeHistory(identifier, chatUid, snapshot => {
                  receive(snapshot);
                  if (gate) connection.abort();
                }, connection.signal);
              } catch (error) {
                if (!gate && !controller.signal.aborted) {
                  useStream = false;
                }
              } finally {
                clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
              }
            } else receive(await client.getRealtimeHistory(identifier, chatUid, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])));
            if (controller.signal.aborted || closed) return;
            // Assignment occurs inside the stream callback.
            const snapshot = gate as RealtimeChatHistory | undefined;
            if (snapshot) {
              if (snapshot.status === 'error' || snapshot.status === 'limit_exceeded') {
                throw await explainFailure(client, identifier, snapshot);
              }
              if (snapshot.status === 'completed') return;
              const calls = snapshot.pendingToolCalls || [];
              if (!options.localTools || !calls.length) { note('Waiting for client tools. Enable --local-tools for read_file/list_files, or use assistants chats tool-response.'); return; }
              if (calls.some(call => answered.has(call.id))) { note('Tool response is still pending; not executing it again. Recheck the conversation before resuming.'); return; }
              const responses: ToolCallResponse[] = [];
              for (const call of calls) {
                let content: unknown;
                try {
                  content = await runLocalTool(options.workspace, call, async description =>
                    (await question(`\nAllow ${safe(description)}? [y/N] `)).toLowerCase() === 'y');
                } catch (error) { content = { error: error instanceof Error ? error.message : 'Local tool failed' }; }
                if (closed || controller.signal.aborted) return;
                responses.push({ tool_call_id: call.id, role: 'tool', content });
                answered.add(call.id);
              }
              // Never retry ambiguous submissions automatically.
              await client.sendToolResponses(identifier, chatUid, responses);
            }
            await pause();
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally { active = undefined; renderer.finish(); }
      }

      async function switchAssistant(target: string): Promise<void> {
        if (!target) {
          renderer.busy('Loading assistants');
          const assistants = (await client.getAssistants()).filter(a => a.state !== 'inactive' && a.state !== 'coming_soon');
          renderer.finish();
          if (!assistants.length) { note('No active assistants available.'); return; }
          const selected = await rl!.select(assistants.map(a => ({ value: a.identifier, label: a.name,
            description: a.identifier === identifier && !options.agent ? 'current' : undefined,
          })), options.agent ? undefined : identifier);
          if (!selected || closed) return;
          target = selected;
        }
        renderer.busy('Loading assistant');
        const assistant = await client.getAssistant(target);
        requireActiveAssistant(assistant);
        if (closed) return;
        if (identifier === assistant.identifier && !options.agent) { note(`Already chatting with ${assistant.name}.`); return; }
        identifier = assistant.identifier;
        options.agent = false;
        chatUid = undefined; threadId = undefined; state = ''; tasks = '';
        useStream = !options.polling;
        answered.clear(); renderer.reset(); renderer.setAssistantName(assistant.name); displayName = assistant.name;
        note(`${assistant.name} · new conversation`);
      }

      async function resumeConversation(target: string): Promise<void> {
        if (!target) { note('Usage: /resume <chatUID> · /conversations to choose a recent chat.'); return; }
        renderer.busy('Loading conversation');
        const history = await client.getChatHistory(identifier, target);
        if (history.chatUID !== target || history.assistantSpecializationIdentifier !== identifier) {
          throw new Error('Conversation does not belong to the selected assistant');
        }
        if (closed) return;
        // Validate before discarding the current display/session. Reattaching to
        // the same chat keeps tool-response deduplication and rendered messages.
        if (chatUid !== target) {
          renderer.reset(); answered.clear();
          chatUid = target; threadId = undefined; state = ''; tasks = '';
          useStream = !options.polling;
        }
        note(`Resumed ${history.name || 'conversation'} · ${target}`);
        renderer.recalled(history.recalledMemories || []);
        renderer.messages(history.chatContent || []);
        await follow();
      }

      async function chooseConversation(): Promise<void> {
        renderer.busy('Loading recent conversations');
        const result = await client.listConversations(identifier, { limit: 20, omitContent: true });
        const histories = result.histories.filter(h => h.assistantSpecializationIdentifier === identifier);
        renderer.finish();
        if (!histories.length) { note('No conversations for this assistant yet.'); return; }
        const selected = await rl!.select(histories.map(h => ({
          value: h.chatUID,
          label: h.name || 'Untitled conversation',
          description: `${h.chatUID === chatUid ? 'current · ' : ''}${h.chatUID} · ${new Date(h.creationTimestampMs).toLocaleString()}`,
        })), chatUid, 'Recent conversations');
        if (selected && !closed) await resumeConversation(selected);
      }

      async function compact(): Promise<void> {
        if (options.agent) { note('/compact currently supports assistant conversations.'); return; }
        if (!chatUid) { note('Send a message before compacting this conversation.'); return; }
        renderer.busy('Compacting context');
        let result: Awaited<ReturnType<typeof client.compactConversation>>;
        try { result = await client.compactConversation(identifier, chatUid); }
        catch (error) {
          const explanation = compactionNotFound(error);
          if (explanation) {
            note(explanation);
            return;
          }
          throw error;
        }
        if (result.compacted) {
          const count = result.checkpoint?.compactedMessageCount;
          note(`Context compacted${typeof count === 'number' ? ` · ${count} messages summarized` : ''}. You can continue chatting.`);
        } else {
          const reasons: Record<string, string> = {
            empty: 'There is no context to compact yet.',
            'tail-covers-everything': 'The conversation is still short; all messages belong to the recent context.',
            'nothing-new': 'The context is already compacted; there is nothing new to summarize.',
            'not-worth-it': 'The context is too small for compaction to help.',
            'below-threshold': 'The context does not need compaction yet.',
            disabled: 'Compaction is disabled for this conversation.',
            failed: 'Compaction could not complete. Your conversation is preserved.',
          };
          note(reasons[result.reason || ''] || 'No compaction was performed. Your conversation is preserved.');
        }
      }

      async function send(message: string, alreadyVisible = false, submission?: Submission): Promise<void> {
        if (options.agent && submission?.images.length) throw new Error('Image attachments currently require assistant mode.');
        if (options.agent) renderer.reset();
        renderer.user(message, alreadyVisible, submission?.display);
        renderer.busy('Sending');
        if (options.agent) {
          const result = await client.createThread(identifier, { message }) as { threadId?: string; _id?: string };
          threadId = result.threadId || result._id;
          if (!threadId) throw new Error('API did not return a thread ID');
          state = ''; tasks = '';

        } else {
          const assistant = await client.getAssistant(identifier);
          requireActiveAssistant(assistant);
          renderer.setAssistantName(assistant.name); displayName = assistant.name;
          const files = [];
          for (const image of submission?.images || []) {
            renderer.busy('Uploading image');
            const uploaded = await client.uploadImage(image);
            if (!uploaded.downloadUrl) throw new Error('Image upload did not return a download URL');
            files.push({name:uploaded.name || image.name, donwloadUrl:uploaded.downloadUrl, fileType:'image' as const});
          }
          const result = await client.sendMessageAsync(identifier, { message, chatUid,
            ...(files.length ? {files} : {}),
            ...(options.localTools ? { tools: localTools } : {}),
          });
          chatUid = result.chatUid;
          if (!chatUid) throw new Error('API did not return a chat UID');

        }
        await follow();
      }

      try {
        const entity = options.agent ? await client.getAgent(identifier) : await client.getAssistant(identifier);
        renderer.setAssistantName(entity.name); displayName = entity.name;
        if (interactive) renderer.banner();
        if (options.message) { await send(options.message); return; }
        if (threadId || chatUid) await follow();
        if (!rl) return;

        while (!closed) {
          const input = await question(renderer.prompt(), true);
          const submission = rl.takeSubmission();
          if (!input && !submission?.images.length) continue;
          if (!submission && input === '/exit') break;
          try {
            if (submission) { await send(submission.message, false, submission); continue; }
            if (input === '/help') note('/assistants · /assistant [identifier] · /compact · /conversations · /resume <chatUID> · /follow /stop /new /status /memories /exit · agents: /approve /reject /pause /resume\nCtrl+V pastes clipboard text/images; large pastes stay folded until sent. Ctrl+C detaches; cloud execution continues. New agent prompts start new threads.');
            else if (input === '/assistants') await switchAssistant('');
            else if (input === '/assistant' || input.startsWith('/assistant ')) await switchAssistant(input.slice('/assistant'.length).trim());
            else if (!options.agent && input === '/conversations') await chooseConversation();
            else if (!options.agent && (input === '/resume' || input.startsWith('/resume '))) await resumeConversation(input.slice('/resume'.length).trim());
            else if (input === '/compact') await compact();
            else if (input === '/status') {
              renderer.session({name: displayName, kind: options.agent ? 'Agent' : 'Assistant',
                id: threadId || chatUid, state, transport: options.agent || !useStream ? 'polling' : 'streaming'});
              if (options.agent && threadId) {
                renderer.busy('Loading usage');
                const thread = await client.getThread(threadId, true);
                renderer.usage({ tokenUsage: thread.tokenUsage }, thread.threadContent);
              } else if (chatUid) {
                renderer.busy('Loading usage');
                const history = await client.getChatHistory(identifier, chatUid);
                renderer.recalled(history.recalledMemories || [], false);
                renderer.usage(history);
              } else note('Send a message to see conversation usage and context.');
            }
            else if (input === '/memories') {
              if (options.agent) note('Recalled memories are available for assistant conversations.');
              else {
                if (chatUid) {
                  renderer.busy('Loading memories');
                  try { renderer.recalled((await client.getChatHistory(identifier, chatUid)).recalledMemories || [], false); }
                  catch { note('Could not refresh memories; showing those received during this session.'); }
                }
                renderer.showMemories();
              }
            }
            else if (input === '/follow') await follow();
            else if (input === '/new') { chatUid = undefined; threadId = undefined; state = ''; renderer.reset(); note('Next prompt starts a new conversation or execution.'); }
            else if (input === '/stop') {
              if (options.agent && threadId) { await client.pauseThread(threadId); note('Cloud thread pause requested.'); }
              else if (chatUid) { await client.stopChat(identifier, chatUid); note('Cloud chat stop requested.'); }
            } else if (options.agent && threadId && ['/approve', '/reject', '/pause', '/resume'].includes(input)) {
              if (input === '/approve' || input === '/reject') await client.handleApproval(threadId, input === '/approve');
              else if (input === '/pause') await client.pauseThread(threadId);
              else await client.resumeThread(threadId);
              await follow();
            } else if (input.startsWith('/')) note('Unknown command. Use /help.');
            else await send(input);
          } catch (error) { note(`Error: ${error instanceof Error ? error.message : String(error)}${error instanceof ConversationFailure ? '' : '. Use /follow to inspect current execution.'}`); }
        }
      } finally { renderer.finish(); rl?.close(); process.removeListener('SIGINT', detach); }
      // This foreground command is finished. Aborting SSE can leave a fetch
      // preconnect alive; do not make an explicit /exit wait for its timeout.
      // This path is interactive: POSIX TTY writes are synchronous.
      process.exit(0);
    });
}
