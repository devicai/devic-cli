import type { ChatHistory, ChatMessage, ThreadTokenUsage } from '../types.js';

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const number = (n: unknown) => valid(n) ? n.toLocaleString('en-US') : 'unavailable';
const money = (n: unknown) => valid(n) ? `$${n.toFixed(6)} USD` : 'unavailable';
const sum = (...values: Array<number | undefined>): number | undefined =>
  values.some(valid) ? values.reduce<number>((total, value) => total + (valid(value) ? value : 0), 0) : undefined;

/** Devic counters separate uncached, cache reads/writes and reasoning tokens. */
export function usageStatus(history: Partial<ChatHistory>, messages: ChatMessage[] = history.chatContent || []): string {
  const usage: ThreadTokenUsage = history.tokenUsage || {};
  const input = usage.inputTokens ?? history.inputTokens;
  const output = usage.outputTokens ?? history.outputTokens;
  const primary = sum(input, output, usage.inputCachedTokens, usage.inputCacheWriteTokens, usage.outputCachedTokens, usage.reasoningOutputTokens);
  const secondary = sum(usage.secondaryInputTokens, usage.secondaryOutputTokens, usage.secondaryInputCachedTokens,
    usage.secondaryInputCacheWriteTokens, usage.secondaryOutputCachedTokens, usage.secondaryReasoningOutputTokens);
  const total = valid(primary) ? primary + (secondary ?? 0) : undefined;
  const primaryCost = usage.cost?.totalCost;
  const totalCost = valid(primaryCost) ? primaryCost + (usage.secondaryCost ?? 0) : undefined;
  const lines = [
    `Model: ${usage.model || history.llm || 'unavailable'} · ${usage.provider || history.provider || 'provider unavailable'}`,
    `Tokens total (reported): ${number(total)}`,
    `  Input: ${number(input)} · output: ${number(output)} · reasoning: ${number(usage.reasoningOutputTokens)}`,
    `  Cache read: ${number(usage.inputCachedTokens)} · cache write: ${number(usage.inputCacheWriteTokens)} · cached output: ${number(usage.outputCachedTokens)}`,
    `  Auxiliary tokens: ${number(secondary)}`,
    `Conversation cost (reported): ${money(totalCost)}`,
    `  Model calls: ${money(primaryCost)} · auxiliary calls: ${money(usage.secondaryCost)}`,
    `Context window: ${valid(history.contextWindow) ? `${number(history.contextWindow)} tokens` : 'unavailable on this API/model'}`,
  ];
  // Input usage lives on the last user/tool record before a model call. Assistant
  // records can repeat the same prompt counters; do not sum message-level usage.
  const last = [...messages].reverse().find(m => m.role !== 'assistant' && valid(m.messageTokenUsage?.inputTokens));
  const prompt = last?.messageTokenUsage;
  lines.push(`Last recorded input: ${number(prompt ? sum(prompt.inputTokens, prompt.inputCachedTokens, prompt.inputCacheWriteTokens) : undefined)} tokens`);
  lines.push('  Recorded input may include retries; it is not the current context size.');
  const checkpoints = history.compactions || [];
  lines.push(`Compactions: ${checkpoints.length}`);
  if (checkpoints.length) {
    const latest = checkpoints.reduce((a, b) => a.timestampMs > b.timestampMs ? a : b);
    lines.push(`  Last summarized region: ${number(latest.tokensBefore)} → ${number(latest.tokensAfter)} tokens · ${number(latest.compactedMessageCount)} messages`);
  }
  return lines.join('\n');
}
