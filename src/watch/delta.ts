import type { AgentTaskDto, ChatMessage } from '../types.js';

/**
 * `GET /agents/threads/:id` returns the whole conversation on every call.
 * Handing that to a model each cycle would burn its context, so the watch
 * reports only what appeared since the previous check.
 */

export interface DeltaItem {
  t: 'message' | 'tool' | 'tool_result' | 'task';
  role?: string;
  name?: string;
  text?: string;
  status?: string;
}

/** Messages reported on the very first check, when there is no memory to diff against. */
const FIRST_CHECK_TAIL = 5;
/** Hard cap so a long silence does not produce a 200-item payload. */
const MAX_ITEMS = 25;

export interface TaskSnapshot {
  title: string;
  completed: boolean;
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function messageText(message: ChatMessage): string {
  const content = message.content as { message?: string; data?: unknown } | string | undefined;
  if (typeof content === 'string') return content;
  if (content?.message) return content.message;
  if (content?.data !== undefined) return JSON.stringify(content.data);
  return '';
}

export function taskSignature(tasks?: AgentTaskDto[]): string {
  if (!tasks || tasks.length === 0) return '-';
  return `${tasks.filter(t => t.completed).length}/${tasks.length}`;
}

export function taskSnapshot(tasks?: AgentTaskDto[]): TaskSnapshot[] {
  return (tasks ?? []).map(t => ({ title: t.title || t.description || '(untitled)', completed: !!t.completed }));
}

/** Tasks that flipped to completed (or appeared already done) since the last check. */
export function taskDelta(previous: TaskSnapshot[] | undefined, current: TaskSnapshot[]): DeltaItem[] {
  const before = new Map((previous ?? []).map(t => [t.title, t.completed]));
  const items: DeltaItem[] = [];
  for (const task of current) {
    const was = before.get(task.title);
    if (task.completed && was !== true) {
      items.push({ t: 'task', name: task.title, status: 'done' });
    } else if (was === undefined && !task.completed && previous !== undefined) {
      items.push({ t: 'task', name: task.title, status: 'pending' });
    }
  }
  return items;
}

export interface MessageDelta {
  items: DeltaItem[];
  /** How many messages were dropped by the cap or the first-check tail. */
  omitted: number;
  seenUids: string[];
}

export function messageDelta(
  messages: ChatMessage[],
  seenUids: Set<string>,
  opts: { firstCheck: boolean; sinceTimestamp?: number },
): MessageDelta {
  const allUids = messages.map(m => m.uid).filter(Boolean);

  let fresh = messages.filter(m => {
    // The `developer` message is the agent's system prompt, not activity.
    if (m.role === 'developer') return false;
    if (m.uid && seenUids.has(m.uid)) return false;
    if (opts.sinceTimestamp != null && m.timestamp != null && m.timestamp <= opts.sinceTimestamp) return false;
    return true;
  });

  let omitted = 0;
  // Without memory every message looks new; only the tail is worth reporting.
  if (opts.firstCheck && opts.sinceTimestamp == null && fresh.length > FIRST_CHECK_TAIL) {
    omitted += fresh.length - FIRST_CHECK_TAIL;
    fresh = fresh.slice(-FIRST_CHECK_TAIL);
  }
  if (fresh.length > MAX_ITEMS) {
    omitted += fresh.length - MAX_ITEMS;
    fresh = fresh.slice(-MAX_ITEMS);
  }

  // Tool results only carry a tool_call_id; the name lives on the call itself.
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      if (call?.id) toolNames.set(call.id, call.function?.name ?? 'unknown');
    }
  }

  const items: DeltaItem[] = [];
  for (const message of fresh) {
    if (message.role === 'tool') {
      const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
      items.push({ t: 'tool_result', name: name ?? 'tool', text: truncate(messageText(message), 160) });
      continue;
    }
    const text = messageText(message);
    if (text) {
      items.push({ t: 'message', role: message.role, text: truncate(text, message.role === 'assistant' ? 400 : 200) });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({
        t: 'tool',
        name: call.function?.name ?? 'unknown',
        text: call.function?.arguments ? truncate(call.function.arguments, 160) : undefined,
      });
    }
  }

  return { items, omitted, seenUids: allUids };
}

/** Opaque resume token: last message timestamp plus its uid. */
export function buildCursor(messages: ChatMessage[]): string | undefined {
  const last = messages[messages.length - 1];
  if (!last) return undefined;
  return `${last.timestamp ?? 0}-${last.uid ?? ''}`;
}

export function parseCursorTimestamp(cursor?: string): number | undefined {
  if (!cursor) return undefined;
  const ts = Number(cursor.split('-')[0]);
  return Number.isFinite(ts) && ts > 0 ? ts : undefined;
}
