import { AgentThreadState, EXIT_CODES } from '../types.js';
import type { AgentDto, AgentThreadDto } from '../types.js';

/**
 * Turns a raw thread state into something a copilot can act on: why the watch
 * returned, whether it should keep polling, and what a human needs to know.
 */

export type WatchAdvice = 'continue' | 'slow_down' | 'human_action_required' | 'stop_polling';

export type WatchReason =
  | 'terminal'
  | 'approval_required'
  | 'waiting_for_response'
  | 'paused'
  | 'limit_exceeded'
  | 'progress'
  | 'window_elapsed'
  | 'stalled';

export interface WatchDiagnostic {
  code: string;
  message: string;
  /** How many earlier checks already reported this same finding. */
  repeated?: number;
}

/** Extra facts the caller fetched on demand (each costs an API call). */
export interface DiagnosticContext {
  agent?: AgentDto;
  /** Threads of the same agent currently in `processing`. */
  agentRunningThreads?: number;
  /** Consecutive `watch` invocations with an unchanged fingerprint (this one included). */
  unchangedPolls: number;
  /** Total `watch` invocations for this thread. */
  polls: number;
  /** Epoch ms the thread entered its current state. */
  stateSince: number;
  now: number;
}

const TERMINAL_STATES: Set<string> = new Set([
  AgentThreadState.COMPLETED,
  AgentThreadState.FAILED,
  AgentThreadState.TERMINATED,
  AgentThreadState.APPROVAL_REJECTED,
  AgentThreadState.GUARDRAIL_TRIGGER,
]);

/** States that end the watch window immediately: nothing will change without outside action. */
const BLOCKING_STATES: Set<string> = new Set([
  AgentThreadState.PAUSED_FOR_APPROVAL,
  AgentThreadState.WAITING_FOR_RESPONSE,
  AgentThreadState.PAUSED,
  AgentThreadState.PAUSED_FOR_RESUME,
  AgentThreadState.LIMIT_EXCEEDED,
]);

/** Consecutive unchanged checks before a running thread is called stalled. */
export const STALL_THRESHOLD = 5;
/** …and before it is not worth watching at all. */
export const GIVE_UP_THRESHOLD = 10;
/** A thread sitting in `queued` for this many checks deserves a look at the agent. */
export const QUEUE_CHECK_THRESHOLD = 2;

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

export function isBlocking(state: string): boolean {
  return BLOCKING_STATES.has(state);
}

/**
 * Whether the agent itself should be inspected. Deliberately threshold-gated:
 * a healthy thread must not pay for extra requests on every check.
 */
export function needsAgentCheck(state: string, unchangedPolls: number): boolean {
  return state === AgentThreadState.QUEUED && unchangedPolls >= QUEUE_CHECK_THRESHOLD;
}

export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ADVICE_RANK: Record<WatchAdvice, number> = {
  continue: 0,
  slow_down: 1,
  human_action_required: 2,
  stop_polling: 3,
};

function strongest(a: WatchAdvice, b: WatchAdvice): WatchAdvice {
  return ADVICE_RANK[b] > ADVICE_RANK[a] ? b : a;
}

export interface DiagnosisResult {
  reason: WatchReason;
  advice: WatchAdvice;
  diagnostics: WatchDiagnostic[];
  exitCode: number;
  /** Flags for the next invocation when it still makes sense to watch. */
  suggestedNext?: { wait: number; window: number; interval?: number };
}

export function diagnose(
  thread: AgentThreadDto,
  ctx: DiagnosticContext,
  opts: { changed: boolean },
): DiagnosisResult {
  const state = thread.state as string;
  const diagnostics: WatchDiagnostic[] = [];
  let advice: WatchAdvice = 'continue';
  const inState = humanDuration(ctx.now - ctx.stateSince);

  const add = (code: string, message: string, a: WatchAdvice): void => {
    diagnostics.push({ code, message });
    advice = strongest(advice, a);
  };

  let reason: WatchReason;

  if (isTerminal(state)) {
    reason = 'terminal';
    add(
      'THREAD_FINISHED',
      `Thread finished in state \`${state}\`${thread.finishReason ? ` (${thread.finishReason})` : ''}.`,
      'stop_polling',
    );
  } else if (state === AgentThreadState.PAUSED_FOR_APPROVAL) {
    reason = 'approval_required';
    // The request itself is reported once, as `pausedReason`; repeating it here
    // would duplicate a potentially long message in every output format.
    add(
      'APPROVAL_PENDING',
      `The agent has been waiting for a decision for ${inState}. Nothing moves until someone approves or rejects.`,
      'human_action_required',
    );
  } else if (state === AgentThreadState.WAITING_FOR_RESPONSE) {
    reason = 'waiting_for_response';
    add(
      'WAITING_EXTERNAL_CHANNEL',
      `The agent is waiting for a reply on an external channel (${inState} so far). ` +
        'Listeners live for 15 days by default; nothing will happen until someone answers.',
      'stop_polling',
    );
  } else if (state === AgentThreadState.PAUSED || state === AgentThreadState.PAUSED_FOR_RESUME) {
    reason = 'paused';
    const resumeAt = thread.pausedUntil ?? thread.pauseUntil;
    if (resumeAt) {
      const inMs = resumeAt - ctx.now;
      add(
        'THREAD_PAUSED',
        inMs > 0
          ? `Paused until ${new Date(resumeAt).toLocaleString()} (resumes in ${humanDuration(inMs)}).`
          : `Paused, scheduled to resume at ${new Date(resumeAt).toLocaleString()} — the queue cron should pick it up within a minute.`,
        'stop_polling',
      );
    } else {
      add(
        'THREAD_PAUSED',
        `Paused for ${inState}. This API version does not report the scheduled resume time.`,
        'stop_polling',
      );
    }
  } else if (state === AgentThreadState.LIMIT_EXCEEDED) {
    reason = 'limit_exceeded';
    add('LIMIT_EXCEEDED', 'The tenant hit its usage limit; the thread will not progress until the quota resets.', 'stop_polling');
  } else if (state === AgentThreadState.QUEUED) {
    reason = opts.changed ? 'progress' : ctx.unchangedPolls >= STALL_THRESHOLD ? 'stalled' : 'window_elapsed';
    if (ctx.agent?.archived) {
      add('AGENT_ARCHIVED', 'The agent is archived, so this thread will never be picked up.', 'stop_polling');
    } else if (ctx.agent?.disabled) {
      add('AGENT_DISABLED', 'The agent is disabled, so this thread will never be picked up.', 'stop_polling');
    } else if (ctx.agentRunningThreads != null && ctx.agentRunningThreads >= 5) {
      add(
        'AGENT_AT_CONCURRENCY',
        `The agent already has ${ctx.agentRunningThreads} threads running and is likely at its concurrency limit (5 by default).`,
        'slow_down',
      );
    } else if (ctx.unchangedPolls >= QUEUE_CHECK_THRESHOLD) {
      add(
        'QUEUE_CRON_DELAY',
        `Queued for ${inState}. The queue cron runs once a minute, so up to ~60s without movement is normal.`,
        'slow_down',
      );
    }
  } else if (state === AgentThreadState.HANDED_OFF) {
    reason = opts.changed ? 'progress' : 'window_elapsed';
    add(
      'HANDED_OFF',
      'A subagent is doing the work; the parent thread stays still until it reports back.',
      'slow_down',
    );
  } else if (state === AgentThreadState.UNDER_CONSTRUCTION) {
    reason = 'window_elapsed';
    add('UNDER_CONSTRUCTION', 'The thread is still being assembled.', 'continue');
  } else {
    // processing and anything this CLI version does not know about
    reason = opts.changed ? 'progress' : ctx.unchangedPolls >= STALL_THRESHOLD ? 'stalled' : 'window_elapsed';
  }

  // Stall detection is state-agnostic: `processing` with no new messages and no
  // task movement is as stuck as `queued`. There is no hot watchdog in the
  // engine — a wedged thread holds its concurrency slot until the next restart.
  if (!opts.changed && !isTerminal(state) && !isBlocking(state)) {
    if (ctx.unchangedPolls >= GIVE_UP_THRESHOLD) {
      add(
        'NO_PROGRESS',
        `Nothing has changed in ${ctx.unchangedPolls} consecutive checks (${humanDuration(ctx.now - ctx.stateSince)} in \`${state}\`). Stop watching and tell the user.`,
        'stop_polling',
      );
    } else if (ctx.unchangedPolls >= STALL_THRESHOLD) {
      add(
        'SLOW_PROGRESS',
        `No new messages or task changes in ${ctx.unchangedPolls} consecutive checks. Check back less often.`,
        'slow_down',
      );
    }
  }

  const exitCode = exitCodeFor(reason);
  return { reason, advice, diagnostics, exitCode, suggestedNext: suggestNext(advice, reason) };
}

function exitCodeFor(reason: WatchReason): number {
  switch (reason) {
    case 'terminal':
      return EXIT_CODES.SUCCESS;
    case 'approval_required':
      return EXIT_CODES.WATCH_APPROVAL_REQUIRED;
    case 'waiting_for_response':
    case 'paused':
    case 'limit_exceeded':
      return EXIT_CODES.WATCH_WAITING;
    case 'stalled':
      return EXIT_CODES.WATCH_STALLED;
    default:
      return EXIT_CODES.WATCH_ALIVE;
  }
}

/**
 * The next call's flags, so the copilot does not have to reason about cadence.
 * Budget stays within the sandbox command limit (see MAX_BUDGET_SECONDS).
 */
function suggestNext(advice: WatchAdvice, reason: WatchReason): DiagnosisResult['suggestedNext'] {
  if (advice === 'stop_polling' || advice === 'human_action_required' || reason === 'terminal') {
    return undefined;
  }
  if (advice === 'slow_down') return { wait: 30, window: 10, interval: 5 };
  return { wait: 5, window: 35, interval: 3 };
}
