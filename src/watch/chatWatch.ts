import type { DevicApiClient } from '../client.js';
import { DevicApiError, DevicCliError } from '../errors.js';
import type { ChatHistory, ChatMessage, RealtimeChatHistory } from '../types.js';
import {
  clearWatchRecord,
  fingerprintsEqual,
  loadWatchRecord,
  newWatchRecord,
  pruneWatchRecords,
  saveWatchRecord,
} from './state.js';
import type { WatchFingerprint, WatchRecord } from './state.js';
import { buildCursor, messageDelta, parseCursorTimestamp } from './delta.js';
import type { DeltaItem } from './delta.js';
import { diagnoseChat, isChatBlocking, isChatTerminal } from './diagnostics.js';
import type { ChatDiagnosticInput, DiagnosisResult, WatchAdvice, WatchDiagnostic, WatchReason } from './diagnostics.js';
import { MAX_BUDGET_SECONDS } from './threadWatch.js';

/**
 * Same contract as `threads watch`, over an assistant chat. The live view is a
 * Redis key that expires an hour after the last update, so this also has to
 * handle the moment it disappears — a 404 there is not "no such chat".
 */

export interface ChatWatchOptions {
  assistant: string;
  wait: number;
  window: number;
  interval: number;
  since?: string;
  until?: 'change' | 'terminal';
}

export interface ChatWatchResult {
  chatUid: string;
  assistant: string;
  status: string;
  statusChangedFrom?: string;
  reason: WatchReason;
  advice: WatchAdvice;
  cursor?: string;
  /** Client-side tool calls the assistant is blocked on. */
  pendingToolCalls?: string[];
  /** Set when the assistant handed the work to an agent thread. */
  handedOffSubThreadId?: string;
  limitExceeded?: { message?: string; resetsAt?: string; current?: number; limit?: number };
  new: DeltaItem[];
  omitted?: number;
  progress: {
    polls: number;
    checks: number;
    unchangedFor: { polls: number; ms: number };
    statusSince: string;
    inStatusMs: number;
  };
  diagnostics: WatchDiagnostic[];
  suggestedNext?: DiagnosisResult['suggestedNext'];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  exitCode: number;
}

interface ChatSnapshot {
  status: string;
  messages: ChatMessage[];
  pendingToolCalls?: RealtimeChatHistory['pendingToolCalls'];
  handedOffSubThreadId?: string;
  limitExceeded?: ChatDiagnosticInput['limitExceeded'];
  lastUpdatedAt?: number;
  realtimeExpired: boolean;
  usage?: ChatWatchResult['usage'];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fingerprintOf(snapshot: ChatSnapshot): WatchFingerprint {
  return {
    state: snapshot.status,
    messages: snapshot.messages.length,
    tasks: '-',
    lastMessageUid: snapshot.messages[snapshot.messages.length - 1]?.uid,
  };
}

/**
 * The Redis realtime key expires an hour after the last update, and the API then
 * rebuilds the response from Mongo with a hardcoded `status: 'completed'`
 * (`public-assistants-v1.service.ts`). That synthetic status is indistinguishable
 * from a real one, so anything `completed` and older than the TTL is flagged as
 * reconstructed — a chat killed mid-run looks exactly the same.
 */
const REALTIME_TTL_MS = 60 * 60 * 1000;
async function snapshot(
  client: DevicApiClient,
  assistant: string,
  chatUid: string,
): Promise<ChatSnapshot> {
  try {
    const realtime = await client.getRealtimeHistory(assistant, chatUid);
    return {
      status: realtime.status,
      messages: realtime.chatHistory ?? [],
      pendingToolCalls: realtime.pendingToolCalls,
      handedOffSubThreadId: realtime.handedOffSubThreadId,
      limitExceeded: realtime.limitExceeded,
      lastUpdatedAt: realtime.lastUpdatedAt,
      realtimeExpired:
        realtime.status === 'completed' &&
        !!realtime.lastUpdatedAt &&
        Date.now() - realtime.lastUpdatedAt > REALTIME_TTL_MS,
    };
  } catch (err) {
    if (!(err instanceof DevicApiError) || err.statusCode !== 404) throw err;
  }

  let history: ChatHistory;
  try {
    history = await client.getChatHistory(assistant, chatUid);
  } catch (err) {
    if (err instanceof DevicApiError && err.statusCode === 404) {
      throw new DevicCliError(
        `Chat \`${chatUid}\` does not exist for assistant \`${assistant}\` (neither live nor persisted).`,
        'CHAT_NOT_FOUND',
      );
    }
    throw err;
  }

  const costUsd = history.tokenUsage?.cost?.totalCost;
  return {
    status: 'completed',
    messages: history.chatContent ?? [],
    realtimeExpired: true,
    lastUpdatedAt: history.lastEditTimestampMs,
    usage: history.tokenUsage
      ? {
          inputTokens: history.tokenUsage.inputTokens,
          outputTokens: history.tokenUsage.outputTokens,
          ...(costUsd != null ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
        }
      : undefined,
  };
}

function shouldBreak(snap: ChatSnapshot, changed: boolean, until: ChatWatchOptions['until']): boolean {
  if (snap.realtimeExpired || isChatTerminal(snap.status)) return true;
  if (until === 'terminal') return false;
  if (isChatBlocking(snap.status)) return true;
  return changed;
}

export async function watchChat(
  client: DevicApiClient,
  chatUid: string,
  opts: ChatWatchOptions,
): Promise<ChatWatchResult> {
  if (opts.wait < 0 || opts.window < 1 || opts.interval < 1) {
    throw new DevicCliError('--wait must be >= 0 and --window/--interval >= 1', 'INVALID_WATCH_BUDGET');
  }
  if (opts.wait + opts.window > MAX_BUDGET_SECONDS) {
    throw new DevicCliError(
      `--wait + --window must be <= ${MAX_BUDGET_SECONDS}s (got ${opts.wait + opts.window}s). ` +
        'Sandboxed commands are killed at ~45s; split the wait across several calls instead.',
      'INVALID_WATCH_BUDGET',
    );
  }

  const started = Date.now();
  pruneWatchRecords(started);

  const previous = loadWatchRecord(chatUid);
  const record: WatchRecord = previous ?? newWatchRecord(chatUid, 'chat', started);
  const baseline = record.fingerprint;
  const firstCheck = previous === null;
  const seenUids = new Set(record.seenMessageUids);

  if (opts.wait > 0) await sleep(opts.wait * 1000);

  const deadline = Date.now() + opts.window * 1000;
  let snap: ChatSnapshot | undefined;
  let checks = 0;
  let changed = false;

  for (;;) {
    snap = await snapshot(client, opts.assistant, chatUid);
    checks++;
    changed = !fingerprintsEqual(baseline, fingerprintOf(snap));

    if (shouldBreak(snap, changed, opts.until)) break;
    if (Date.now() + opts.interval * 1000 >= deadline) break;
    await sleep(opts.interval * 1000);
  }

  const now = Date.now();
  const delta = messageDelta(snap!.messages, seenUids, {
    firstCheck,
    sinceTimestamp: parseCursorTimestamp(opts.since),
  });

  const unchangedPolls = changed ? 0 : record.unchangedPolls + 1;
  // The realtime view has no state history, so "since when" is either the
  // moment the status last changed locally or the key's own last update.
  const statusSince =
    baseline.state === snap!.status ? record.stateSince : snap!.lastUpdatedAt ?? now;

  const diagnosis = diagnoseChat(
    {
      status: snap!.status,
      pendingToolCalls: snap!.pendingToolCalls,
      handedOffSubThreadId: snap!.handedOffSubThreadId,
      limitExceeded: snap!.limitExceeded,
      realtimeExpired: snap!.realtimeExpired,
    },
    { unchangedPolls, polls: record.polls + 1, stateSince: statusSince, now },
    { changed },
  );

  const seenCounts = new Map<string, number>();
  for (const code of record.advicesEmitted) seenCounts.set(code, (seenCounts.get(code) ?? 0) + 1);
  const diagnostics = diagnosis.diagnostics.map(diagnostic => {
    const repeated = seenCounts.get(diagnostic.code) ?? 0;
    if (repeated === 0) return diagnostic;
    return {
      ...diagnostic,
      repeated,
      message: `${diagnostic.message} Already reported in ${repeated} previous check(s).`,
    };
  });

  const cursor = buildCursor(snap!.messages);

  if (isChatTerminal(snap!.status) || snap!.realtimeExpired) {
    clearWatchRecord(chatUid);
  } else {
    saveWatchRecord({
      ...record,
      polls: record.polls + 1,
      updatedAt: now,
      lastChangeAt: changed ? now : record.lastChangeAt,
      unchangedPolls,
      stateSince: statusSince,
      fingerprint: fingerprintOf(snap!),
      cursor,
      seenMessageUids: delta.seenUids,
      advicesEmitted: [...record.advicesEmitted, ...diagnostics.map(d => d.code)],
    });
  }

  const pendingToolCalls = (snap!.pendingToolCalls ?? [])
    .map(call => call?.function?.name)
    .filter((name): name is string => !!name);

  return {
    chatUid,
    assistant: opts.assistant,
    status: snap!.status,
    ...(baseline.state && baseline.state !== snap!.status ? { statusChangedFrom: baseline.state } : {}),
    reason: diagnosis.reason,
    advice: diagnosis.advice,
    cursor,
    ...(pendingToolCalls.length > 0 ? { pendingToolCalls } : {}),
    ...(snap!.handedOffSubThreadId ? { handedOffSubThreadId: snap!.handedOffSubThreadId } : {}),
    ...(snap!.limitExceeded
      ? {
          limitExceeded: {
            message: snap!.limitExceeded.message,
            current: snap!.limitExceeded.current,
            limit: snap!.limitExceeded.limit,
            ...(snap!.limitExceeded.resetsAt
              ? { resetsAt: new Date(snap!.limitExceeded.resetsAt).toISOString() }
              : {}),
          },
        }
      : {}),
    new: delta.items,
    ...(delta.omitted > 0 ? { omitted: delta.omitted } : {}),
    progress: {
      polls: record.polls + 1,
      checks,
      unchangedFor: { polls: unchangedPolls, ms: now - record.lastChangeAt },
      statusSince: new Date(statusSince).toISOString(),
      inStatusMs: now - statusSince,
    },
    diagnostics,
    suggestedNext: diagnosis.suggestedNext,
    usage: snap!.usage,
    exitCode: diagnosis.exitCode,
  };
}
