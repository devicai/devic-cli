import { md } from '../output.js';
import { humanDuration } from './diagnostics.js';
import type { ThreadWatchResult } from './threadWatch.js';
import type { DeltaItem } from './delta.js';

/**
 * Markdown built to be pasted straight into a chat by the copilot, so it never
 * dumps the raw thread: the point of `watch` is a short, actionable report.
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

const HEADLINE: Record<string, string> = {
  terminal: 'Finished',
  approval_required: 'Waiting for approval',
  waiting_for_response: 'Waiting for an external reply',
  paused: 'Paused',
  limit_exceeded: 'Usage limit reached',
  progress: 'Running',
  window_elapsed: 'Still running',
  stalled: 'No progress',
};

export function renderThreadWatch(result: ThreadWatchResult): string {
  const lines: string[] = [
    md.h(2, `Thread ${md.code(shortId(result.threadId))} — ${result.state}`),
    '',
  ];

  const inState = humanDuration(result.progress.inStateMs);
  lines.push(
    `${md.status(result.state)} ${md.b(HEADLINE[result.reason] ?? result.reason)} · ${inState} in this state · check ${result.progress.polls}`,
  );

  if (result.stateChangedFrom) {
    lines.push(`State moved from ${md.code(result.stateChangedFrom)} to ${md.code(result.state)}.`);
  }
  if (result.progress.tasks !== '-') lines.push(`Tasks: ${result.progress.tasks}`);
  if (result.pausedReason) lines.push('', md.info(result.pausedReason));
  if (result.resumesAt) lines.push('', `Resumes at ${new Date(result.resumesAt).toLocaleString()}.`);

  if (result.new.length > 0) {
    lines.push('', md.b('New since the last check'), ...result.new.map(renderItem));
    if (result.omitted) lines.push(`_…${result.omitted} earlier messages omitted._`);
  } else if (result.progress.unchangedFor.polls > 0) {
    lines.push(
      '',
      `_Nothing new in ${result.progress.unchangedFor.polls} consecutive check(s) (${humanDuration(result.progress.unchangedFor.ms)})._`,
    );
  } else {
    lines.push('', '_No new messages in this check._');
  }

  if (result.diagnostics.length > 0) {
    const ok = result.state === 'completed';
    lines.push('');
    for (const diagnostic of result.diagnostics) {
      lines.push(ok ? md.success(diagnostic.message) : md.warn(diagnostic.message));
    }
  }

  if (result.advice === 'human_action_required') {
    lines.push(
      '',
      md.b('A human has to decide. Stop watching.'),
      `Approve: ${md.code(`devic agents threads approve ${result.threadId} -m "…"`)}`,
      `Reject:  ${md.code(`devic agents threads reject ${result.threadId} -m "…" --retry`)}`,
    );
  } else if (result.advice === 'stop_polling') {
    lines.push('', md.b('Stop watching and report to the user.'));
    if (result.reason !== 'terminal') {
      lines.push(`Resume later with: ${md.code(`devic agents threads watch ${result.threadId}`)}`);
    }
  } else if (result.suggestedNext) {
    const { wait, window, interval } = result.suggestedNext;
    lines.push(
      '',
      `_Next check: ${md.code(
        `devic agents threads watch ${result.threadId} --wait ${wait} --window ${window}${interval ? ` --interval ${interval}` : ''}`,
      )}_`,
    );
  }

  const footer: string[] = [];
  if (result.usage?.inputTokens != null || result.usage?.outputTokens != null) {
    const total = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
    footer.push(`${total.toLocaleString()} tokens`);
  }
  if (result.usage?.costUsd != null) footer.push(`$${result.usage.costUsd}`);
  if (result.cursor) footer.push(`cursor ${md.code(result.cursor)}`);
  if (footer.length > 0) lines.push('', `_${footer.join(' · ')}_`);

  return lines.join('\n');
}
