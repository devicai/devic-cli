import type { DevicApiClient } from '../client.js';
import { DevicCliError } from '../errors.js';
import { AgentThreadState } from '../types.js';
import type { AgentDto, AgentThreadDto } from '../types.js';
import {
  clearWatchRecord,
  fingerprintsEqual,
  loadWatchRecord,
  newWatchRecord,
  pruneWatchRecords,
  saveWatchRecord,
} from './state.js';
import type { WatchFingerprint, WatchRecord } from './state.js';
import {
  buildCursor,
  messageDelta,
  parseCursorTimestamp,
  taskDelta,
  taskSignature,
  taskSnapshot,
} from './delta.js';
import type { DeltaItem, TaskSnapshot } from './delta.js';
import { diagnose, isBlocking, isTerminal, needsAgentCheck } from './diagnostics.js';
import type { DiagnosisResult, WatchAdvice, WatchDiagnostic, WatchReason } from './diagnostics.js';

/**
 * Sandboxes abort a command at ~45s, so the whole invocation — the deliberate
 * wait plus the watch window — has to fit comfortably below that. Keeping the
 * pause inside the command (instead of `sleep N && devic …`) means the budget
 * is enforced in one place and cannot be composed past the limit.
 */
export const MAX_BUDGET_SECONDS = 40;

export interface ThreadWatchOptions {
  wait: number;
  window: number;
  interval: number;
  since?: string;
  until?: 'change' | 'approval' | 'terminal';
  withTasks?: boolean;
}

export interface ThreadWatchResult {
  threadId: string;
  state: string;
  /** Set when the state moved since the previous invocation. */
  stateChangedFrom?: string;
  reason: WatchReason;
  advice: WatchAdvice;
  cursor?: string;
  pausedReason?: string;
  finishReason?: string;
  resumesAt?: string;
  new: DeltaItem[];
  omitted?: number;
  progress: {
    polls: number;
    checks: number;
    unchangedFor: { polls: number; ms: number };
    stateSince: string;
    inStateMs: number;
    tasks: string;
  };
  diagnostics: WatchDiagnostic[];
  suggestedNext?: DiagnosisResult['suggestedNext'];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  exitCode: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fingerprintOf(thread: AgentThreadDto): WatchFingerprint {
  const messages = thread.threadContent ?? [];
  return {
    state: thread.state as string,
    messages: messages.length,
    tasks: taskSignature(thread.tasks),
    lastMessageUid: messages[messages.length - 1]?.uid,
  };
}

/** Backend-reported entry time for the current state; falls back to local memory. */
function stateSinceOf(thread: AgentThreadDto, fallback: number): number {
  const changes = thread.threadStatesChanges;
  if (!changes?.length) return fallback;
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]!;
    if (change.state === thread.state && change.timestamp) return change.timestamp;
  }
  return fallback;
}

/** Stops the window early when nothing more can happen without outside action. */
function shouldBreak(thread: AgentThreadDto, changed: boolean, until: ThreadWatchOptions['until']): boolean {
  const state = thread.state as string;
  if (isTerminal(state)) return true;
  if (until === 'terminal') return false;
  if (isBlocking(state)) return true;
  if (until === 'approval') return false;
  return changed;
}

export async function watchThread(
  client: DevicApiClient,
  threadId: string,
  opts: ThreadWatchOptions,
): Promise<ThreadWatchResult> {
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

  const previous = loadWatchRecord(threadId);
  const record: WatchRecord = previous ?? newWatchRecord(threadId, 'thread', started);
  const baseline = record.fingerprint;
  const firstCheck = previous === null;
  const seenUids = new Set(record.seenMessageUids);
  const previousTasks: TaskSnapshot[] | undefined = record.tasksSnapshot;

  if (opts.wait > 0) await sleep(opts.wait * 1000);

  const deadline = Date.now() + opts.window * 1000;
  let thread: AgentThreadDto | undefined;
  let checks = 0;
  let changed = false;

  for (;;) {
    thread = await client.getThread(threadId, opts.withTasks);
    checks++;
    changed = !fingerprintsEqual(baseline, fingerprintOf(thread));

    if (shouldBreak(thread, changed, opts.until)) break;
    if (Date.now() + opts.interval * 1000 >= deadline) break;
    await sleep(opts.interval * 1000);
  }

  const now = Date.now();
  const messages = thread!.threadContent ?? [];
  const delta = messageDelta(messages, seenUids, {
    firstCheck,
    sinceTimestamp: parseCursorTimestamp(opts.since),
  });
  const currentTasks = taskSnapshot(thread!.tasks);
  const newItems = [...taskDelta(previousTasks, currentTasks), ...delta.items];

  const unchangedPolls = changed ? 0 : record.unchangedPolls + 1;
  const stateSince = stateSinceOf(thread!, record.fingerprint.state === thread!.state ? record.stateSince : now);

  const context = await gatherContext(client, thread!, unchangedPolls);
  const diagnosis = diagnose(thread!, { ...context, unchangedPolls, polls: record.polls + 1, stateSince, now }, { changed });

  const cursor = buildCursor(messages);
  const state = thread!.state as string;

  // Re-reporting the same finding verbatim invites the copilot to keep polling.
  // Saying it has already been said is the cheapest brake available.
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

  // Memory is pointless once the thread is done, and a stale file would make a
  // future watch of a recycled id start with the wrong baseline.
  if (isTerminal(state)) {
    clearWatchRecord(threadId);
  } else {
    saveWatchRecord({
      ...record,
      polls: record.polls + 1,
      updatedAt: now,
      lastChangeAt: changed ? now : record.lastChangeAt,
      unchangedPolls,
      stateSince,
      fingerprint: fingerprintOf(thread!),
      cursor,
      seenMessageUids: delta.seenUids,
      advicesEmitted: [...record.advicesEmitted, ...diagnostics.map(d => d.code)],
      ...(currentTasks.length > 0 ? { tasksSnapshot: currentTasks } : {}),
    });
  }

  const resumeAt = thread!.pausedUntil ?? thread!.pauseUntil;

  const previousState = baseline.state;

  return {
    threadId,
    state,
    ...(previousState && previousState !== state ? { stateChangedFrom: previousState } : {}),
    reason: diagnosis.reason,
    advice: diagnosis.advice,
    cursor,
    // `pausedReason` survives in the document after the thread resumes; only
    // report it while it actually explains the current state.
    ...(isBlocking(state) && thread!.pausedReason ? { pausedReason: thread!.pausedReason } : {}),
    ...(thread!.finishReason ? { finishReason: thread!.finishReason } : {}),
    ...(resumeAt ? { resumesAt: new Date(resumeAt).toISOString() } : {}),
    new: newItems,
    ...(delta.omitted > 0 ? { omitted: delta.omitted } : {}),
    progress: {
      polls: record.polls + 1,
      checks,
      unchangedFor: { polls: unchangedPolls, ms: now - record.lastChangeAt },
      stateSince: new Date(stateSince).toISOString(),
      inStateMs: now - stateSince,
      tasks: taskSignature(thread!.tasks),
    },
    diagnostics,
    suggestedNext: diagnosis.suggestedNext,
    usage: usageOf(thread!),
    exitCode: diagnosis.exitCode,
  };
}

/**
 * Extra lookups that only pay off once a thread looks stuck. Failures here are
 * swallowed: a diagnostic is a nice-to-have, the state report is not.
 */
async function gatherContext(
  client: DevicApiClient,
  thread: AgentThreadDto,
  unchangedPolls: number,
): Promise<{ agent?: AgentDto; agentRunningThreads?: number }> {
  if (!needsAgentCheck(thread.state as string, unchangedPolls)) return {};
  const agentId = typeof thread.agentId === 'string' ? thread.agentId : undefined;
  if (!agentId) return {};

  try {
    const agent = (await client.getAgent(agentId)) as AgentDto;
    if (agent?.disabled || agent?.archived) return { agent };
    const running = (await client.listThreads(agentId, {
      state: AgentThreadState.PROCESSING,
      limit: 1,
      omitContent: true,
    })) as { total?: number; threads?: unknown[] };
    return {
      agent,
      agentRunningThreads: running?.total ?? running?.threads?.length,
    };
  } catch {
    return {};
  }
}

function usageOf(thread: AgentThreadDto): ThreadWatchResult['usage'] {
  const usage = thread.tokenUsage;
  if (!usage) return undefined;
  const costUsd = usage.cost?.totalCost;
  if (usage.inputTokens == null && usage.outputTokens == null && costUsd == null) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(costUsd != null ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
  };
}
