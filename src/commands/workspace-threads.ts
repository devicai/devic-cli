import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type { DevicApiClient } from '../client.js';
import { createClient, withAction, readJsonArg, readTextStdin, isStdinPiped } from '../helpers.js';
import { md, statusLine } from '../output.js';
import { DevicCliError } from '../errors.js';
import { EXIT_CODES } from '../types.js';
import {
  INVOCATION_TERMINAL,
  dataObject,
  formatMessage,
  formatPending,
  formatTranscript,
  intOpt,
  isWaiting,
  itemsOf,
} from './workspace-shared.js';

const MESSAGES_PAGE_MAX = 200;

function threadsTable(d: unknown): string {
  const data = d as any;
  const items = itemsOf(data, 'threads');
  if (!items.length) return '_No threads found._';
  const rows = items.map((t: any) => ({
    id: t.id,
    workspace: t.workspaceName ?? t.workspaceId,
    title: t.title || '(untitled)',
    unread: t.unreadMentionCount
      ? `${t.unreadCount ?? 0} (@${t.unreadMentionCount})`
      : t.unreadCount || (t.unread || t.manualUnread ? 'Yes' : '-'),
    waiting: t.waitingForMe ? 'You' : '-',
    running: t.activeRunCount || '-',
    updated: t.updatedAt,
    ...(t.archived ? { archived: 'Yes' } : {}),
  }));
  const columns = ['id', 'workspace', 'title', 'unread', 'waiting', 'running', 'updated'];
  if (rows.some((r: any) => r.archived)) columns.push('archived');
  return [md.h(2, 'Threads'), '', md.table(rows, { columns }), md.pagination(data)].join('\n');
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain filename
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1]!.trim() : undefined;
}

/** A name that cannot escape the target directory. */
function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = basename((name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface WaitResult {
  outcome: 'completed' | 'failed' | 'waiting';
  invocations: any[];
  messages: any[];
}

/**
 * Poll `messages?after=<seq>` until every invocation the send started is
 * terminal or waiting on someone. Page invocations update the tracked ones;
 * when a page does not mention one of them, the thread detail is asked too.
 */
async function waitForInvocations(
  client: DevicApiClient,
  wid: string,
  tid: string,
  afterSeq: number,
  started: any[],
  opts: { timeoutMs: number; intervalMs: number },
): Promise<WaitResult> {
  const tracked = new Map<string, any>(started.map((i) => [String(i.id), i]));
  const collected = new Map<string, any>();
  let cursor = afterSeq;

  const absorb = (invocations: unknown): Set<string> => {
    const seen = new Set<string>();
    for (const inv of Array.isArray(invocations) ? invocations : []) {
      const id = String(inv?.id);
      const prev = tracked.get(id);
      if (!prev) continue;
      seen.add(id);
      if (prev.status !== inv.status) {
        statusLine('workspace_invocation', { threadId: tid, invocationId: id, status: inv.status });
      }
      tracked.set(id, inv);
    }
    return seen;
  };

  const drain = async (): Promise<Set<string>> => {
    const seen = new Set<string>();
    for (let guard = 0; guard < 50; guard++) {
      const page = (await client.listWorkspaceThreadMessages(wid, tid, {
        after: cursor,
        limit: MESSAGES_PAGE_MAX,
      })) as any;
      for (const id of absorb(page?.invocations)) seen.add(id);
      const messages: any[] = Array.isArray(page?.messages) ? page.messages : [];
      for (const m of messages) {
        collected.set(String(m.id ?? m.seq), m);
        if (typeof m.seq === 'number' && m.seq > cursor) cursor = m.seq;
      }
      if (!page?.hasMore || !messages.length) break;
    }
    return seen;
  };

  const settled = () =>
    [...tracked.values()].every((i) => INVOCATION_TERMINAL.has(i.status) || isWaiting(i.status));

  const finish = (): WaitResult => {
    const invocations = [...tracked.values()];
    const outcome = invocations.some((i) => isWaiting(i.status))
      ? 'waiting'
      : invocations.every((i) => i.status === 'completed')
        ? 'completed'
        : 'failed';
    const messages = [...collected.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { outcome, invocations, messages };
  };

  const deadline = Date.now() + opts.timeoutMs;
  let interval = opts.intervalMs;
  while (!settled()) {
    if (Date.now() >= deadline) {
      throw new DevicCliError(
        `Timed out waiting for the reply (invocations: ${[...tracked.values()]
          .map((i) => `${i.id}=${i.status}`)
          .join(', ')}). Read it later with \`devic workspaces threads messages ${wid} ${tid} --after ${afterSeq}\`.`,
        'POLL_TIMEOUT',
        EXIT_CODES.POLL_TIMEOUT,
      );
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 1.5, Math.max(opts.intervalMs, 5000));
    const seen = await drain();
    if (!settled() && [...tracked.keys()].some((id) => !seen.has(id))) {
      const detail = (await client.getWorkspaceThread(wid, tid)) as any;
      absorb(detail?.invocations);
    }
  }
  // Whatever the assistant wrote before settling.
  await drain();
  return finish();
}

export function registerWorkspaceThreadCommands(ws: Command): void {
  const threads = ws.command('threads').description('Workspace threads: list, read, create, archive, mark read');

  threads
    .command('list')
    .description('List threads across every workspace you see, or one with --workspace')
    .option('--workspace <wid>', 'Only threads of this workspace')
    .option('--search <text>', 'Match thread title or workspace name (all words, accent/case-insensitive)')
    .option('--unread', 'Only threads with unread messages')
    .option('--archived', 'Include archived threads')
    .option('--offset <n>', 'Items to skip')
    .option('--limit <n>', 'Items to return (max 100, default 20)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          workspace?: string; search?: string; unread?: boolean; archived?: boolean;
          offset?: string; limit?: string;
        };
        const client = createClient();
        const query = {
          search: o.search,
          unread: o.unread ? 'true' : undefined,
          includeArchived: o.archived ? 'true' : undefined,
          offset: intOpt(o.offset, '--offset'),
          limit: intOpt(o.limit, '--limit'),
        };
        return o.workspace
          ? client.listThreadsOfWorkspace(o.workspace, query)
          : client.listWorkspaceThreads(query);
      }, threadsTable),
    );

  threads
    .command('get <wid> <tid>')
    .description('Thread with its latest messages, read state and open invocations')
    .option('--limit <n>', 'Messages to return')
    .option('--before <seq>', 'Messages older than this seq')
    .action(
      withAction(async (wid: unknown, tid: unknown, opts: unknown) => {
        const o = opts as { limit?: string; before?: string };
        return createClient().getWorkspaceThread(wid as string, tid as string, {
          limit: intOpt(o.limit, '--limit'),
          before: intOpt(o.before, '--before'),
        });
      }, (d) => formatTranscript(d)),
    );

  threads
    .command('messages <wid> <tid>')
    .description('Page through messages by seq: --before for older, --after for newer')
    .option('--before <seq>', 'Messages older than this seq')
    .option('--after <seq>', 'Messages newer than this seq')
    .option('--limit <n>', 'Messages to return (max 200, default 50)')
    .action(
      withAction(async (wid: unknown, tid: unknown, opts: unknown) => {
        const o = opts as { before?: string; after?: string; limit?: string };
        if (o.before != null && o.after != null) {
          throw new DevicCliError('Pass only one of --before / --after.', 'INVALID_USAGE');
        }
        return createClient().listWorkspaceThreadMessages(wid as string, tid as string, {
          before: intOpt(o.before, '--before'),
          after: intOpt(o.after, '--after'),
          limit: intOpt(o.limit, '--limit'),
        });
      }, (d) => formatTranscript(d)),
    );

  threads
    .command('create <wid>')
    .description('Start a thread in a workspace')
    .option('--title <title>', 'Thread title')
    .option('--direct', 'Direct (one-to-one) thread')
    .option('--user <uid>', 'With --direct: the other person (userUID)')
    .action(
      withAction(async (wid: unknown, opts: unknown) => {
        const o = opts as { title?: string; direct?: boolean; user?: string };
        if (o.user && !o.direct) {
          throw new DevicCliError('--user only applies to --direct threads.', 'INVALID_USAGE');
        }
        return createClient().createWorkspaceThread(wid as string, {
          ...(o.title != null && { title: o.title }),
          ...(o.direct && { kind: 'direct' }),
          ...(o.user && { userUID: o.user }),
        });
      }, (d) => {
        const t = (d as any)?.thread ?? d;
        return md.success(`Thread created: ${md.code(String(t?.id ?? '-'))}${t?.title ? ` — ${t.title}` : ''}`);
      }),
    );

  threads
    .command('rename <wid> <tid> <title>')
    .description('Rename a thread')
    .action(
      withAction(async (wid: unknown, tid: unknown, title: unknown) =>
        createClient().updateWorkspaceThread(wid as string, tid as string, { title }),
      () => md.success('Thread renamed.')),
    );

  for (const [name, archived] of [['archive', true], ['unarchive', false]] as const) {
    threads
      .command(`${name} <wid> <tid>`)
      .description(archived ? 'Archive a thread' : 'Bring an archived thread back')
      .action(
        withAction(async (wid: unknown, tid: unknown) =>
          createClient().updateWorkspaceThread(wid as string, tid as string, { archived }),
        () => md.success(archived ? 'Thread archived.' : 'Thread unarchived.')),
      );
  }

  threads
    .command('read <wid> <tid>')
    .description('Mark a thread read (through its latest message, or --through <seq>)')
    .option('--through <seq>', 'Last message seq to mark read')
    .action(
      withAction(async (wid: unknown, tid: unknown, opts: unknown) => {
        const o = opts as { through?: string };
        return createClient().markWorkspaceThreadRead(wid as string, tid as string, intOpt(o.through, '--through'));
      }, () => md.success('Marked read.')),
    );

  threads
    .command('unread <wid> <tid>')
    .description('Mark a thread unread')
    .action(
      withAction(async (wid: unknown, tid: unknown) =>
        createClient().markWorkspaceThreadUnread(wid as string, tid as string),
      () => md.success('Marked unread.')),
    );

  // ── send ──

  ws.command('send <wid> <tid> [text]')
    .description('Post a message to a thread (text "-" or piped stdin reads the text from stdin)')
    .option('--assistant <aid>', 'Direct the message to this assistant of the workspace')
    .option(
      '--mention <kind:id[:label]>',
      'Mention a user or assistant (repeatable), e.g. assistant:abc123:Writer',
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option('--reply-to <messageId>', 'Reply to this message')
    .option('--client-id <id>', 'Idempotency key (clientMessageId): resending it does not post twice')
    .option('--wait', 'Wait for the assistants the message started, then print their replies')
    .option('--timeout <s>', 'With --wait: give up after this many seconds (exit 3)', '300')
    .option('--poll-interval <s>', 'With --wait: first poll delay in seconds (backs off to 5s)', '1')
    .action(
      withAction(async (wid: unknown, tid: unknown, text: unknown, opts: unknown) => {
        const o = opts as {
          assistant?: string; mention?: string[]; replyTo?: string; clientId?: string;
          wait?: boolean; timeout: string; pollInterval: string;
        };
        let body = text as string | undefined;
        if (body === '-' || (body == null && isStdinPiped())) body = await readTextStdin();
        if (body == null || !body.trim()) {
          throw new DevicCliError('Message text is required (argument, "-" or piped stdin).', 'INVALID_USAGE');
        }
        const mentions = (o.mention ?? []).map((m) => {
          const [kind, id, ...rest] = m.split(':');
          if ((kind !== 'user' && kind !== 'assistant') || !id) {
            throw new DevicCliError(`--mention "${m}": expected user:<id>[:label] or assistant:<id>[:label].`, 'INVALID_USAGE');
          }
          return { kind, id, label: rest.length ? rest.join(':') : id };
        });
        const timeout = Number(o.timeout);
        const pollInterval = Number(o.pollInterval);
        if (o.wait && (!(timeout > 0) || !(pollInterval > 0))) {
          throw new DevicCliError('--timeout and --poll-interval must be positive numbers.', 'INVALID_USAGE');
        }

        const client = createClient();
        const sent = (await client.postWorkspaceMessage(wid as string, tid as string, {
          text: body,
          ...(mentions.length && { mentions }),
          ...(o.assistant && { directedAssistantId: o.assistant }),
          ...(o.replyTo && { replyToMessageId: o.replyTo }),
          ...(o.clientId && { clientMessageId: o.clientId }),
        })) as any;
        if (!o.wait) return sent;

        const started: any[] = Array.isArray(sent?.invocations) ? sent.invocations : [];
        if (!started.length) {
          return { ...sent, outcome: 'no_invocations', messages: [] };
        }
        let afterSeq = sent?.message?.seq;
        if (typeof afterSeq !== 'number') {
          const detail = (await client.getWorkspaceThread(wid as string, tid as string, { limit: 1 })) as any;
          afterSeq = detail?.messages?.at(-1)?.seq ?? 0;
        }
        const result = await waitForInvocations(client, wid as string, tid as string, afterSeq, started, {
          timeoutMs: timeout * 1000,
          intervalMs: pollInterval * 1000,
        });
        return { message: sent.message, ...result, workspaceId: wid, threadId: tid };
      }, (d) => {
        const r = d as any;
        const sentLine = md.success(`Sent ${md.code(String(r?.message?.id ?? '-'))}${r?.message?.seq != null ? ` (#${r.message.seq})` : ''}`);
        if (!r?.outcome) {
          const invs: any[] = r?.invocations ?? [];
          return invs.length
            ? `${sentLine}\nStarted: ${invs.map((i) => `${md.code(String(i.id))} ${i.status ?? ''}`.trim()).join(', ')}`
            : sentLine;
        }
        if (r.outcome === 'no_invocations') return `${sentLine}\n_No assistant was started by this message._`;
        const lines = [sentLine, ''];
        const replies = (r.messages ?? []).filter((m: any) => m.id !== r.message?.id);
        lines.push(replies.length ? replies.map(formatMessage).join('\n\n') : '_No new messages._');
        const failed = (r.invocations ?? []).filter((i: any) => i.status !== 'completed' && !isWaiting(i.status));
        for (const inv of failed) lines.push('', `${md.status(inv.status)} Invocation ${md.code(String(inv.id))} — **${inv.status}**`);
        const pending = formatPending(r.invocations ?? [], r.workspaceId, r.threadId);
        if (pending) lines.push('', pending);
        return lines.join('\n');
      }),
    );

  // ── answer / run-action ──

  ws.command('answer <wid> <tid> <invocationId>')
    .description('Answer (or skip) the questions an invocation is waiting on; revision and inputId are fetched')
    .option('--answers <json|file|->', 'Array (or {answers:[...]}) of {id, selected?:string[], other?, note?}')
    .option('--skip', 'Skip the questions instead of answering')
    .option('--revision <n>', 'Invocation revision (skips fetching the thread)')
    .option('--input-id <id>', 'requestedInput.id (skips fetching the thread)')
    .action(
      withAction(async (wid: unknown, tid: unknown, rid: unknown, opts: unknown) => {
        const o = opts as { answers?: string; skip?: boolean; revision?: string; inputId?: string };
        if (!!o.answers === !!o.skip) {
          throw new DevicCliError('Pass exactly one of --answers / --skip.', 'INVALID_USAGE');
        }
        let answers: unknown;
        if (o.answers) {
          const parsed = (await readJsonArg(o.answers, '--answers')) as any;
          answers = Array.isArray(parsed) ? parsed : parsed?.answers;
          if (!Array.isArray(answers)) {
            throw new DevicCliError('--answers must be an array or an object with "answers".', 'INVALID_USAGE');
          }
        }
        const client = createClient();
        let revision = intOpt(o.revision, '--revision');
        let inputId = o.inputId;
        if (revision == null || inputId == null) {
          const detail = (await client.getWorkspaceThread(wid as string, tid as string)) as any;
          const inv = (Array.isArray(detail?.invocations) ? detail.invocations : []).find(
            (i: any) => String(i?.id) === rid,
          );
          if (!inv) {
            throw new DevicCliError(
              `Invocation ${rid} is not among the thread's open invocations. Pass --revision and --input-id to answer it anyway.`,
              'INVOCATION_NOT_FOUND',
            );
          }
          revision ??= inv.revision;
          inputId ??= inv.requestedInput?.id;
          if (inputId == null) {
            throw new DevicCliError(
              `Invocation ${rid} is not waiting for input (status: ${inv.status ?? 'unknown'}).`,
              'NOT_WAITING_FOR_INPUT',
            );
          }
        }
        const body = o.skip
          ? { revision, inputId, skipped: true }
          : { revision, inputId, response: { answers } };
        return client.runWorkspaceInvocationAction(wid as string, tid as string, rid as string, 'answer', body);
      }, (d) => md.success(`Answer sent.${(d as any)?.status ? ` Invocation is now ${(d as any).status}.` : ''}`)),
    );

  ws.command('approve <wid> <tid> <invocationId>')
    .description('Approve the tool call an invocation is waiting on; revision and actionId are fetched')
    .option('--always', 'Also approve this tool for the future (when the run allows it)')
    .option('--revision <n>', 'Invocation revision (skips fetching the thread)')
    .option('--action-id <id>', 'requestedAction.id (skips fetching the thread)')
    .action(
      withAction(async (wid: unknown, tid: unknown, rid: unknown, opts: unknown) => {
        const o = opts as { always?: boolean; revision?: string; actionId?: string };
        const client = createClient();
        let revision = intOpt(o.revision, '--revision');
        let actionId = o.actionId;
        if (revision == null || actionId == null) {
          const detail = (await client.getWorkspaceThread(wid as string, tid as string)) as any;
          const inv = (Array.isArray(detail?.invocations) ? detail.invocations : []).find(
            (i: any) => String(i?.id) === rid,
          );
          if (!inv) {
            throw new DevicCliError(
              `Invocation ${rid} is not among the thread's open invocations. Pass --revision and --action-id to approve it anyway.`,
              'INVOCATION_NOT_FOUND',
            );
          }
          revision ??= inv.revision;
          actionId ??= inv.requestedAction?.id;
          if (inv.status !== 'waiting_approval' || actionId == null) {
            throw new DevicCliError(
              `Invocation ${rid} is not waiting for an approval (status: ${inv.status ?? 'unknown'}).`,
              'NOT_WAITING_FOR_APPROVAL',
            );
          }
        }
        return client.runWorkspaceInvocationAction(wid as string, tid as string, rid as string, 'approve', {
          revision,
          actionId,
          ...(o.always ? { always: true } : {}),
        });
      }, (d) => md.success(`Approved.${(d as any)?.status ? ` Invocation is now ${(d as any).status}.` : ''}`)),
    );

  ws.command('run-action <wid> <tid> <invocationId> <action>')
    .description('Run any invocation action (cancel, retry, approve, answer, ...) with a raw body')
    .option('--data <json|file|->', 'Request body')
    .action(
      withAction(async (wid: unknown, tid: unknown, rid: unknown, action: unknown, opts: unknown) => {
        const o = opts as { data?: string };
        return createClient().runWorkspaceInvocationAction(
          wid as string, tid as string, rid as string, action as string, await dataObject(o.data),
        );
      }),
    );

  // ── files ──

  const files = ws.command('files').description('Files attached to a thread');

  files
    .command('list <wid> <tid>')
    .description('List the files of a thread')
    .action(
      withAction(async (wid: unknown, tid: unknown) =>
        createClient().listWorkspaceThreadFiles(wid as string, tid as string),
      (d) => {
        const items = itemsOf(d, 'files');
        if (!items.length) return '_No files._';
        return md.table(items, { columns: ['id', 'name', 'size', 'mimeType'] });
      }),
    );

  files
    .command('download <wid> <tid> <fileId>')
    .description('Download a thread file (default: its own name in the current directory)')
    .option('--out <path>', 'Target file, existing directory (or ending in /), or - for stdout')
    .option('--force', 'Overwrite an existing file')
    .action(
      withAction(async (wid: unknown, tid: unknown, fid: unknown, opts: unknown) => {
        const o = opts as { out?: string; force?: boolean };
        const res = await createClient().downloadWorkspaceThreadFile(wid as string, tid as string, fid as string);
        const contentType = res.headers.get('content-type') ?? undefined;

        if (o.out === '-') {
          const bytes = Buffer.from(await res.arrayBuffer());
          process.stdout.write(bytes);
          return undefined;
        }

        const name = safeFileName(filenameFromDisposition(res.headers.get('content-disposition')), fid as string);
        let target: string;
        if (!o.out) {
          target = resolve(name);
        } else if (/[\\/]$/.test(o.out) || (existsSync(o.out) && statSync(o.out).isDirectory())) {
          mkdirSync(o.out, { recursive: true });
          target = resolve(join(o.out, name));
        } else {
          target = resolve(o.out);
          mkdirSync(dirname(target), { recursive: true });
        }
        if (existsSync(target) && !o.force) {
          await res.body?.cancel().catch(() => undefined);
          throw new DevicCliError(`${target} already exists. Pass --force to overwrite it.`, 'FILE_EXISTS');
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        writeFileSync(target, bytes, { flag: o.force ? 'w' : 'wx' });
        return { path: target, bytes: bytes.length, ...(contentType && { contentType }), fileId: fid };
      }, (d) => md.success(`Saved ${(d as any).path} (${(d as any).bytes} bytes)`)),
    );
}
