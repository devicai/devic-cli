import { readFileSync } from 'node:fs';
import { readJsonArg, readTextStdin } from '../helpers.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';

/** Parse an integer option, failing with a usage error naming the flag. */
export function intOpt(value: string | undefined, flag: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new DevicCliError(`${flag} must be an integer (got "${value}").`, 'INVALID_USAGE');
  }
  return n;
}

/** `--data <json|file|->` as an object. */
export async function dataObject(
  value: string | undefined,
  flag = '--data',
): Promise<Record<string, unknown>> {
  if (value == null) return {};
  const parsed = await readJsonArg(value, flag);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DevicCliError(`${flag} must be a JSON object.`, 'INVALID_USAGE');
  }
  return parsed as Record<string, unknown>;
}

/** Text given inline, `-` for stdin, or read from `file`. Exactly one source. */
export async function textInput(
  inline: string | undefined,
  file: string | undefined,
  flags: [string, string],
): Promise<string | undefined> {
  if (inline != null && file != null) {
    throw new DevicCliError(`Pass only one of ${flags[0]} / ${flags[1]}.`, 'INVALID_USAGE');
  }
  if (file != null) return file === '-' ? readTextStdin() : readFileSync(file, 'utf-8');
  if (inline === '-') return readTextStdin();
  return inline;
}

/** First numeric `revision`-like field found on the object. */
export function revisionOf(obj: unknown, keys = ['revision', 'expectedRevision']): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const key of keys) {
    if (typeof o[key] === 'number') return o[key] as number;
  }
  return undefined;
}

export function itemsOf(data: unknown, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of [...keys, 'items']) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

export function countOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return undefined;
}

// ── Thread transcript ──

export const INVOCATION_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'outcome_unknown']);

export function isWaiting(status: unknown): boolean {
  return typeof status === 'string' && status.startsWith('waiting_');
}

/** "via CLI" when the message came in over the public API (CLI, SDK, raw API). */
export function originTag(origin: unknown): string | undefined {
  if (origin == null || origin === false) return undefined;
  let source: unknown = origin;
  if (typeof origin === 'object') {
    const o = origin as Record<string, unknown>;
    source = o.source ?? o.client ?? o.channel ?? o.kind ?? o.type;
  }
  return typeof source === 'string' && source ? `via ${source.toUpperCase()}` : 'via API';
}

export function formatMessage(m: any): string {
  const author = m.authorName ?? m.authorId ?? m.role ?? 'unknown';
  const meta: string[] = [];
  if (m.role && m.role !== 'user') meta.push(m.role);
  if (m.seq != null) meta.push(`#${m.seq}`);
  if (m.createdAt) meta.push(String(m.createdAt));
  const via = originTag(m.origin);
  if (via) meta.push(via);
  const header = `**${author}**${meta.length ? ` _(${meta.join(' · ')})_` : ''}`;
  const text = typeof m.text === 'string' && m.text.length ? m.text : '_(no text)_';
  return `${header}\n${text}`;
}

function questionsOf(requestedInput: any): any[] {
  if (!requestedInput || typeof requestedInput !== 'object') return [];
  if (Array.isArray(requestedInput.questions)) return requestedInput.questions;
  if (Array.isArray(requestedInput.fields)) return requestedInput.fields;
  return [];
}

function optionLabel(option: any): string {
  if (option == null) return '';
  if (typeof option !== 'object') return String(option);
  const id = option.id ?? option.value;
  const label = option.label ?? option.text ?? option.title;
  return label && id && label !== id ? `${label} (${md.code(String(id))})` : String(label ?? id ?? '');
}

/** Invocations waiting on a person, with their questions and the command to answer. */
export function formatPending(invocations: any[], wid?: string, tid?: string): string {
  const waiting = invocations.filter((i) => isWaiting(i?.status));
  if (!waiting.length) return '';
  const lines: string[] = [md.h(3, 'Waiting')];
  for (const inv of waiting) {
    lines.push(
      '',
      `${md.status('waiting_for_response')} Invocation ${md.code(String(inv.id))} — **${inv.status}**` +
        (inv.assistantId ? ` (assistant ${md.code(String(inv.assistantId))})` : ''),
    );
    const req = inv.requestedInput;
    if (!req) continue;
    if (req.title || req.prompt || req.message) lines.push(String(req.title ?? req.prompt ?? req.message));
    for (const q of questionsOf(req)) {
      const text = q.question ?? q.text ?? q.label ?? q.title ?? '';
      const multi = q.multiple ?? q.multiSelect ?? q.allowMultiple;
      lines.push(`- ${md.code(String(q.id))}${text ? ` ${text}` : ''}${multi ? ' _(multiple)_' : ''}`);
      const options = Array.isArray(q.options) ? q.options : [];
      if (options.length) lines.push(`  Options: ${options.map(optionLabel).join(', ')}`);
    }
    if (wid && tid) {
      lines.push(
        '',
        `Answer: ${md.code(`devic workspaces answer ${wid} ${tid} ${inv.id} --answers '[{"id":"<questionId>","selected":["<option>"]}]'`)}` +
          ` or ${md.code('--skip')}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatTranscript(data: any, wid?: string, tid?: string): string {
  const lines: string[] = [];
  const thread = data?.thread;
  if (thread) {
    lines.push(md.h(2, thread.title || 'Thread'), '');
    lines.push(`**ID:** ${md.code(String(thread.id ?? tid))}`);
    if (thread.workspaceName || thread.workspaceId) {
      lines.push(`**Workspace:** ${thread.workspaceName ?? ''} ${md.code(String(thread.workspaceId ?? wid))}`.trim());
    }
    if (thread.archived) lines.push('**Archived:** Yes');
    const rs = thread.readState;
    if (rs && typeof rs === 'object') {
      const parts: string[] = [];
      if (rs.unreadCount != null) parts.push(`${rs.unreadCount} unread`);
      if (rs.lastReadSeq != null) parts.push(`read through #${rs.lastReadSeq}`);
      if (parts.length) lines.push(`**Read state:** ${parts.join(', ')}`);
    }
    lines.push('');
  }
  const messages: any[] = Array.isArray(data?.messages) ? data.messages : [];
  if (data?.hasMore && messages.length) {
    lines.push(md.info(`Older messages exist: pass --before ${messages[0]?.seq ?? data.before}`), '');
  }
  lines.push(messages.length ? messages.map(formatMessage).join('\n\n') : '_No messages._');
  const pending = formatPending(
    Array.isArray(data?.invocations) ? data.invocations : [],
    wid ?? thread?.workspaceId,
    tid ?? thread?.id,
  );
  if (pending) lines.push('', pending);
  return lines.join('\n');
}
