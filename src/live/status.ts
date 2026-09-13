import { stripVTControlCharacters } from 'node:util';
import wrapAnsi from 'wrap-ansi';
import type { ChatHistory, ChatMessage, ThreadTokenUsage } from '../types.js';

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const number = (n: unknown) => valid(n) ? n.toLocaleString('en-US') : 'unavailable';
const money = (n: unknown) => valid(n) ? `$${n.toFixed(6)} USD` : 'unavailable';
const sum = (...values: Array<number | undefined>): number | undefined =>
  values.some(valid) ? values.reduce<number>((total, value) => total + (valid(value) ? value : 0), 0) : undefined;

export interface StatusStyle { color?: boolean; columns?: number }

export function usageBar(value: number | undefined, total: number | undefined, size = 20): string {
  if (!valid(value) || !valid(total) || total <= 0) return '— unavailable';
  const ratio = value / total;
  const cells = Math.min(size, Math.max(0, Math.round(ratio * size)));
  return `${'━'.repeat(cells)}${'┄'.repeat(size - cells)} ${(ratio * 100).toFixed(1)}%`;
}

/** Devic counters separate uncached, cache reads/writes and reasoning tokens. */
export function usageStatus(history: Partial<ChatHistory>, messages: ChatMessage[] = history.chatContent || [], style: StatusStyle = {}): string {
  const usage: ThreadTokenUsage = history.tokenUsage || {};
  const input = usage.inputTokens ?? history.inputTokens;
  const output = usage.outputTokens ?? history.outputTokens;
  const primary = sum(input, output, usage.inputCachedTokens, usage.inputCacheWriteTokens, usage.outputCachedTokens, usage.reasoningOutputTokens);
  const secondary = sum(usage.secondaryInputTokens, usage.secondaryOutputTokens, usage.secondaryInputCachedTokens,
    usage.secondaryInputCacheWriteTokens, usage.secondaryOutputCachedTokens, usage.secondaryReasoningOutputTokens);
  const total = valid(primary) ? primary + (secondary ?? 0) : undefined;
  const primaryCost = usage.cost?.totalCost;
  const totalCost = valid(primaryCost) ? primaryCost + (usage.secondaryCost ?? 0) : undefined;
  const columns = Math.max(20, style.columns || 80);
  const barSize = Math.max(8, Math.min(24, columns - 38));
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
  const ink = (code: string, value: string) => style.color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const heading = (label: string) => ink('1;36', `◆ ${label}`);
  const meter = (label: string, value: number | undefined, denominator = total) =>
    `  ${label.padEnd(11)} ${ink('36', usageBar(value, denominator, barSize))}  ${number(value)}`;
  const lines = [
    `${ink('1', clean(usage.model || history.llm || 'Model unavailable'))} ${ink('2', '· ' + clean(usage.provider || history.provider || 'provider unavailable'))}`,
    '', heading('CONTEXT'),
    `  Context window: ${valid(history.contextWindow) ? `${number(history.contextWindow)} tokens` : 'unavailable on this API/model'}`,
  ];
  // Input usage lives on the last user/tool record before a model call. Assistant
  // records can repeat the same prompt counters; do not sum message-level usage.
  const last = [...messages].reverse().find(m => m.role !== 'assistant' && valid(m.messageTokenUsage?.inputTokens));
  const prompt = last?.messageTokenUsage;
  const recordedInput = prompt ? sum(prompt.inputTokens, prompt.inputCachedTokens, prompt.inputCacheWriteTokens) : undefined;
  lines.push(`  Last recorded input: ${number(recordedInput)} tokens`);
  lines.push(`  ${ink('36', usageBar(recordedInput, history.contextWindow, barSize))} of model capacity`);
  lines.push('  Recorded input may include retries; it is not the current context size.');
  lines.push('', heading('TOKENS · accumulated usage'),
    `  Tokens total (reported): ${ink('1', number(total))}`,
    meter('Input', sum(input, usage.inputCacheWriteTokens)),
    meter('Cache read', usage.inputCachedTokens),
    meter('Output', sum(output, usage.outputCachedTokens, usage.reasoningOutputTokens)),
    meter('Auxiliary', secondary),
    `  Input: ${number(input)} · output: ${number(output)} · reasoning: ${number(usage.reasoningOutputTokens)}`,
    `  Cache write: ${number(usage.inputCacheWriteTokens)} · cached output: ${number(usage.outputCachedTokens)}`,
    '', heading('COST · USD'),
    `  Conversation cost (reported): ${ink('1;32', money(totalCost))}`,
    `  Model calls: ${money(primaryCost)}`,
    `  Auxiliary calls: ${money(usage.secondaryCost)}`,
    '', heading('COMPACTION'));
  const checkpoints = history.compactions || [];
  lines.push(`  Compactions: ${checkpoints.length}`);
  if (checkpoints.length) {
    const latest = checkpoints.reduce((a, b) => a.timestampMs > b.timestampMs ? a : b);
    lines.push(`  Last summarized region: ${number(latest.tokensBefore)} → ${number(latest.tokensAfter)} tokens · ${number(latest.compactedMessageCount)} messages`);
  }
  return lines.map(line => wrapAnsi(line, columns, { hard: true, trim: false })).join('\n');
}
