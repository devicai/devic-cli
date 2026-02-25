import type { DevicApiClient } from './client.js';
import type { RealtimeChatHistory, AgentThreadDto, PollOptions } from './types.js';
import { AgentThreadState } from './types.js';
import { DevicCliError } from './errors.js';
import { statusLine } from './output.js';

const CHAT_TERMINAL: Set<string> = new Set(['completed', 'error']);
const THREAD_TERMINAL: Set<string> = new Set([
  AgentThreadState.COMPLETED,
  AgentThreadState.FAILED,
  AgentThreadState.TERMINATED,
]);

const CHAT_POLL_DEFAULTS: PollOptions = {
  initialIntervalMs: 1000,
  backoffMultiplier: 1.5,
  maxIntervalMs: 10_000,
  timeoutMs: 5 * 60 * 1000,
};

const THREAD_POLL_DEFAULTS: PollOptions = {
  initialIntervalMs: 2000,
  backoffMultiplier: 1.5,
  maxIntervalMs: 15_000,
  timeoutMs: 10 * 60 * 1000,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollChat(
  client: DevicApiClient,
  assistantId: string,
  chatUid: string,
  opts?: Partial<PollOptions>,
): Promise<RealtimeChatHistory> {
  const o = { ...CHAT_POLL_DEFAULTS, ...opts };
  let interval = o.initialIntervalMs;
  const deadline = Date.now() + o.timeoutMs;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const result = await client.getRealtimeHistory(assistantId, chatUid);

    if (result.status !== lastStatus) {
      lastStatus = result.status;
      statusLine('chat_status', { chatUid, status: result.status });
    }

    if (CHAT_TERMINAL.has(result.status)) {
      return result;
    }

    // waiting_for_tool_response — return to caller so it can handle tool calls
    if (result.status === 'waiting_for_tool_response') {
      return result;
    }

    await sleep(interval);
    interval = Math.min(interval * o.backoffMultiplier, o.maxIntervalMs);
  }

  throw new DevicCliError('Polling timed out waiting for chat completion', 'POLL_TIMEOUT', 3);
}

export async function pollThread(
  client: DevicApiClient,
  threadId: string,
  opts?: Partial<PollOptions>,
): Promise<AgentThreadDto> {
  const o = { ...THREAD_POLL_DEFAULTS, ...opts };
  let interval = o.initialIntervalMs;
  const deadline = Date.now() + o.timeoutMs;
  let lastState = '';

  while (Date.now() < deadline) {
    const result = await client.getThread(threadId, true);

    if (result.state !== lastState) {
      lastState = result.state;
      statusLine('thread_status', {
        threadId,
        state: result.state,
        tasks: result.tasks?.map(t => ({ title: t.title, completed: t.completed })),
      });
    }

    if (THREAD_TERMINAL.has(result.state)) {
      return result;
    }

    // paused_for_approval — return to caller for action
    if (result.state === AgentThreadState.PAUSED_FOR_APPROVAL) {
      return result;
    }

    // handed_off — keep polling
    await sleep(interval);
    interval = Math.min(interval * o.backoffMultiplier, o.maxIntervalMs);
  }

  throw new DevicCliError('Polling timed out waiting for thread completion', 'POLL_TIMEOUT', 3);
}
