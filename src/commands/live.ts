import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../helpers.js';
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
      const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
      const renderer = new LiveRenderer();
      let chatUid = options.chatUid;
      let threadId = options.thread;
      let active: AbortController | undefined;
      let closed = false;
      let state = '';
      let tasks = '';
      let useStream = !options.polling;
      const answered = new Set<string>();
      const note = (text: string) => renderer.note(text);
      const question = async (prompt: string) => { renderer.finish(); return closed ? '/exit' : (await rl!.question(prompt)).trim(); };
      const detach = () => {
        if (active) { active.abort(); note('Detached. Cloud execution continues. Use /follow or /stop.'); }
        else { closed = true; rl?.close(); }
      };
      if (rl) { rl.on('SIGINT', detach); rl.on('close', () => { closed = true; active?.abort(); }); }
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
              const messages = [...(snapshot.chatHistory || [])];
              if (snapshot.streamingMessage && snapshot.status === 'processing') {
                const index = messages.findIndex(m => m.uid === snapshot.streamingMessage!.uid);
                if (index < 0) messages.push(snapshot.streamingMessage); else messages[index] = snapshot.streamingMessage;
              }
              renderer.messages(messages);
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
                throw new Error(snapshot.limitExceeded?.message || `Conversation ${snapshot.status}`);
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

      async function send(message: string, alreadyVisible = false): Promise<void> {
        if (options.agent) renderer.reset();
        renderer.user(message, alreadyVisible);
        renderer.busy('Sending');
        if (options.agent) {
          const result = await client.createThread(identifier, { message }) as { threadId?: string; _id?: string };
          threadId = result.threadId || result._id;
          if (!threadId) throw new Error('API did not return a thread ID');
          state = ''; tasks = '';

        } else {
          const result = await client.sendMessageAsync(identifier, { message, chatUid,
            ...(options.localTools ? { tools: localTools } : {}),
          });
          chatUid = result.chatUid;
          if (!chatUid) throw new Error('API did not return a chat UID');

        }
        await follow();
      }

      try {
        if (interactive) renderer.banner();
        if (options.message) { await send(options.message); return; }
        if (threadId || chatUid) await follow();
        if (!rl) return;

        while (!closed) {
          const input = await question(renderer.prompt());
          if (!input) continue;
          if (input === '/exit') break;
          try {
            if (input === '/help') note('/follow /stop /new /status /exit · agents: /approve /reject /pause /resume\nCtrl+C detaches; cloud execution continues. New agent prompts start new threads.');
            else if (input === '/status') note(`${options.agent ? 'Agent' : 'Assistant'}: ${identifier}\n${options.agent ? 'Thread' : 'Chat'}: ${threadId || chatUid || 'not started'}\nTransport: ${options.agent || !useStream ? 'polling' : 'streaming'}`);
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
            else await send(input, true);
          } catch (error) { note(`Error: ${error instanceof Error ? error.message : String(error)}. Use /follow to inspect current execution.`); }
        }
      } finally { renderer.finish(); rl?.close(); process.removeListener('SIGINT', detach); }
      // This foreground command is finished. Aborting SSE can leave a fetch
      // preconnect alive; do not make an explicit /exit wait for its timeout.
      await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
      process.exit(0);
    });
}
