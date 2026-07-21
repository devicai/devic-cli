import { md } from '../output.js';
import { humanDuration } from './diagnostics.js';
import type { WatchAdvice, WatchDiagnostic, WatchReason } from './diagnostics.js';
import type { ThreadWatchResult } from './threadWatch.js';
import type { ChatWatchResult } from './chatWatch.js';
import type { DeltaItem } from './delta.js';

/**
 * Markdown built to be pasted straight into a chat by the copilot, so it never
 * dumps the raw conversation: the point of `watch` is a short, actionable report.
 */

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function renderItem(item: DeltaItem): string {
  switch (item.t) {
    case 'task':
      return `- ${item.status === 'done' ? '[x]' : '[ ]'} task — ${item.name}`;
    case 'tool':
      return `- -> tool — ${md.code(item.name ?? 'unknown')}${item.text ? ` ${item.text}` : ''}`;
    case 'tool_result':
      return `- <- result — ${md.code(item.name ?? 'tool')}${item.text ? `: ${item.text}` : ''}`;
    default:
      return `- ${item.role === 'user' ? 'user' : 'agent'} — ${item.text ?? ''}`;
  }
}

const HEADLINE: Record<WatchReason, string> = {
  terminal: 'Finished',
  approval_required: 'Waiting for approval',
  tool_response_required: 'Waiting for a tool response',
  waiting_for_response: 'Waiting for an external reply',
  paused: 'Paused',
  limit_exceeded: 'Usage limit reached',
  realtime_expired: 'No live view left',
  progress: 'Running',
  window_elapsed: 'Still running',
  stalled: 'No progress',
};

/** The parts every watch report shares, whatever it is watching. */
interface CommonReport {
  title: string;
  state: string;
  reason: WatchReason;
  advice: WatchAdvice;
  polls: number;
  inStateMs: number;
  unchangedFor: { polls: number; ms: number };
  new: DeltaItem[];
  omitted?: number;
  diagnostics: WatchDiagnostic[];
  cursor?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** Extra lines right under the headline (state change, quoted request, …). */
  context?: string[];
  /** What to do now, when a human or another command has to act. */
  actions?: string[];
  /** The command that continues watching, when it still makes sense. */
  nextCommand?: string;
  /** The command that resumes later, after a `stop_polling`. */
  resumeCommand?: string;
  /** Renders success-styled diagnostics instead of warnings. */
  succeeded?: boolean;
}

function renderCommon(report: CommonReport): string {
  const lines: string[] = [md.h(2, report.title), ''];

  lines.push(
    `${md.status(report.state)} ${md.b(HEADLINE[report.reason] ?? report.reason)} · ${humanDuration(
      report.inStateMs,
    )} in this state · check ${report.polls}`,
  );
  if (report.context?.length) lines.push(...report.context);

  if (report.new.length > 0) {
    lines.push('', md.b('New since the last check'), ...report.new.map(renderItem));
    if (report.omitted) lines.push(`_…${report.omitted} earlier messages omitted._`);
  } else if (report.unchangedFor.polls > 0) {
    lines.push(
      '',
      `_Nothing new in ${report.unchangedFor.polls} consecutive check(s) (${humanDuration(report.unchangedFor.ms)})._`,
    );
  } else {
    lines.push('', '_No new messages in this check._');
  }

  if (report.diagnostics.length > 0) {
    lines.push('');
    for (const diagnostic of report.diagnostics) {
      lines.push(report.succeeded ? md.success(diagnostic.message) : md.warn(diagnostic.message));
    }
  }

  if (report.advice === 'human_action_required' && report.actions?.length) {
    lines.push('', md.b('Someone has to act. Stop watching.'), ...report.actions);
  } else if (report.advice === 'stop_polling') {
    lines.push('', md.b('Stop watching and report to the user.'));
    if (report.actions?.length) lines.push(...report.actions);
    if (report.resumeCommand) lines.push(`Resume later with: ${md.code(report.resumeCommand)}`);
  } else if (report.nextCommand) {
    lines.push('', `_Next check: ${md.code(report.nextCommand)}_`);
  }

  const footer: string[] = [];
  if (report.usage?.inputTokens != null || report.usage?.outputTokens != null) {
    const total = (report.usage.inputTokens ?? 0) + (report.usage.outputTokens ?? 0);
    footer.push(`${total.toLocaleString()} tokens`);
  }
  if (report.usage?.costUsd != null) footer.push(`$${report.usage.costUsd}`);
  if (report.cursor) footer.push(`cursor ${md.code(report.cursor)}`);
  if (footer.length > 0) lines.push('', `_${footer.join(' · ')}_`);

  return lines.join('\n');
}

function nextCommand(base: string, next?: { wait: number; window: number; interval?: number }): string | undefined {
  if (!next) return undefined;
  return `${base} --wait ${next.wait} --window ${next.window}${next.interval ? ` --interval ${next.interval}` : ''}`;
}

export function renderThreadWatch(result: ThreadWatchResult): string {
  const context: string[] = [];
  if (result.stateChangedFrom) {
    context.push(`State moved from ${md.code(result.stateChangedFrom)} to ${md.code(result.state)}.`);
  }
  if (result.progress.tasks !== '-') context.push(`Tasks: ${result.progress.tasks}`);
  if (result.pausedReason) context.push('', md.info(result.pausedReason));
  if (result.resumesAt) context.push('', `Resumes at ${new Date(result.resumesAt).toLocaleString()}.`);

  return renderCommon({
    title: `Thread ${md.code(shortId(result.threadId))} — ${result.state}`,
    state: result.state,
    reason: result.reason,
    advice: result.advice,
    polls: result.progress.polls,
    inStateMs: result.progress.inStateMs,
    unchangedFor: result.progress.unchangedFor,
    new: result.new,
    omitted: result.omitted,
    diagnostics: result.diagnostics,
    cursor: result.cursor,
    usage: result.usage,
    context,
    actions:
      result.advice === 'human_action_required'
        ? [
            `Approve: ${md.code(`devic agents threads approve ${result.threadId} -m "…"`)}`,
            `Reject:  ${md.code(`devic agents threads reject ${result.threadId} -m "…" --retry`)}`,
          ]
        : undefined,
    nextCommand: nextCommand(`devic agents threads watch ${result.threadId}`, result.suggestedNext),
    resumeCommand:
      result.reason === 'terminal' ? undefined : `devic agents threads watch ${result.threadId}`,
    succeeded: result.state === 'completed',
  });
}

export function renderChatWatch(result: ChatWatchResult): string {
  const context: string[] = [];
  if (result.statusChangedFrom) {
    context.push(`Status moved from ${md.code(result.statusChangedFrom)} to ${md.code(result.status)}.`);
  }
  if (result.limitExceeded?.message) context.push('', md.info(result.limitExceeded.message));

  const base = `devic assistants chats watch ${result.chatUid} --assistant ${result.assistant}`;
  const actions: string[] = [];
  if (result.pendingToolCalls?.length) {
    actions.push(
      `Pending tool call(s): ${result.pendingToolCalls.map(name => md.code(name)).join(', ')}`,
      'Answer with `POST /api/v1/assistants/:identifier/chats/:chatUid/tool-response` (curl — the CLI does not cover it).',
    );
  }
  if (result.handedOffSubThreadId) {
    actions.push(`Watch the agent doing the work: ${md.code(`devic agents threads watch ${result.handedOffSubThreadId}`)}`);
  }

  return renderCommon({
    title: `Chat ${md.code(shortId(result.chatUid))} — ${result.status}`,
    state: result.status,
    reason: result.reason,
    advice: result.advice,
    polls: result.progress.polls,
    inStateMs: result.progress.inStatusMs,
    unchangedFor: result.progress.unchangedFor,
    new: result.new,
    omitted: result.omitted,
    diagnostics: result.diagnostics,
    cursor: result.cursor,
    usage: result.usage,
    context,
    actions: actions.length > 0 ? actions : undefined,
    nextCommand: nextCommand(base, result.suggestedNext),
    resumeCommand: result.reason === 'terminal' || result.reason === 'realtime_expired' ? undefined : base,
    succeeded: result.status === 'completed',
  });
}
