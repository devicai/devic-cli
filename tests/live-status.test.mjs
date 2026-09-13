import test from 'node:test';
import assert from 'node:assert/strict';
import { usageStatus, usageBar } from '../dist/live/status.js';
import { LiveRenderer } from '../dist/live/render.js';

test('status sums disjoint cache/reasoning/auxiliary counters and costs once', () => {
  const result = usageStatus({ contextWindow: 128000, tokenUsage: {
    model: 'fixture', inputTokens: 100, outputTokens: 20, inputCachedTokens: 50,
    inputCacheWriteTokens: 10, reasoningOutputTokens: 5, secondaryInputTokens: 8,
    secondaryOutputTokens: 2, secondaryInputCachedTokens: 3, secondaryReasoningOutputTokens: 2,
    cost: { totalCost: 0.12 }, secondaryCost: 0.03,
  }, chatContent: [
    { role: 'user', messageTokenUsage: { inputTokens: 70, inputCachedTokens: 30 } },
    { role: 'assistant', messageTokenUsage: { inputTokens: 70, inputCachedTokens: 30, outputTokens: 20 } },
  ], compactions: [{ timestampMs: 1, tokensBefore: 900, tokensAfter: 100, compactedMessageCount: 12 }] });
  assert.match(result, /Tokens total \(reported\): 200/);
  assert.match(result, /Conversation cost \(reported\): \$0.150000 USD/);
  assert.match(result, /Context window: 128,000 tokens/);
  assert.match(result, /Last recorded input: 100 tokens/);
  assert.match(result, /not the current context size/);
  assert.match(result, /Last summarized region: 900 → 100/);
});

test('unknown usage remains unavailable and actual zero beats legacy values', () => {
  assert.match(usageStatus({}), /Tokens total \(reported\): unavailable/);
  assert.match(usageStatus({}), /Conversation cost \(reported\): unavailable/);
  assert.match(usageStatus({}), /Context window: unavailable/);
  const zero = usageStatus({ inputTokens: 123, outputTokens: 456, tokenUsage: { inputTokens: 0, outputTokens: 0, cost: { totalCost: 0 } } });
  assert.match(zero, /Tokens total \(reported\): 0/);
  assert.match(zero, /\$0.000000 USD/);
  assert.match(usageStatus({ inputTokens: 10, outputTokens: 5 }), /Tokens total \(reported\): 15/);
});

const recall = { uid: 'memory', source: 'conversation_start', timestampMs: 1,
  facts: [{ fact: 'Likes solar', source: 'User', relation: 'likes', target: 'Solar' }, { fact: 'likes solar' }],
  entities: [{ id: 'e', name: 'Solar', type: 'topic', summary: 'Renewable energy' }],
  turns: [{ role: 'user', content: 'Previous session' }],
};
test('recalls deduplicate SSE replays, hide details until requested, survive partial updates and reset', () => {
  let output = '';
  const renderer = new LiveRenderer(text => { output += text; }, { tty: false });
  const snapshot = { status: 'processing', chatHistory: [], recalledMemories: [recall] };
  renderer.snapshot(snapshot); renderer.snapshot(snapshot);
  renderer.snapshot({ status: 'completed', chatHistory: [] });
  assert.equal(output.match(/Recalled memories/g)?.length, 1);
  assert.match(output, /1 facts · 1 entities · 1 turns/);
  assert.doesNotMatch(output, /Likes solar|Previous session/);
  output = ''; renderer.showMemories();
  assert.match(output, /Likes solar/); assert.doesNotMatch(output, /likes solar/);
  assert.match(output, /User → likes → Solar/);
  assert.match(output, /Renewable energy/); assert.match(output, /Previous session/);
  renderer.reset(); output = ''; renderer.showMemories();
  assert.match(output, /No recalled memories/);
});

test('memory details sanitize terminal escapes, empty records stay hidden and updated records are shown', () => {
  let output = '';
  const renderer = new LiveRenderer(text => { output += text; }, { tty: false });
  renderer.recalled([{ uid: 'empty', source: 'search_memory', facts: [] }]);
  assert.equal(output, '');
  renderer.recalled([recall], false);
  assert.equal(output, '');
  renderer.recalled([{ ...recall, query: '\x1b[2Jsearch', facts: [{ fact: '\x1b[31mNew fact' }] }]);
  renderer.showMemories();
  assert.match(output, /New fact/); assert.match(output, /Query: search/);
  assert.doesNotMatch(output, /\x1b/);
});


test('status bars retain honest percentages, handle unknown/zero capacity and fit narrow terminals', () => {
  assert.match(usageBar(36217,1050000), /3\.4%$/);
  assert.match(usageBar(558883,797034), /70\.1%$/);
  assert.match(usageBar(200,100,8), /^━━━━━━━━ 200\.0%$/);
  assert.match(usageBar(0,100,8), /^┄┄┄┄┄┄┄┄ 0\.0%$/);
  assert.equal(usageBar(10,0), '— unavailable');
  assert.equal(usageBar(undefined,100), '— unavailable');
  const output = usageStatus({ llm: '\x1b[2JModel', tokenUsage: { inputTokens: 10, outputTokens: 5 } }, [], {columns:32});
  assert.doesNotMatch(output, /\x1b/);
  assert.ok(output.split('\n').every(line => line.length <= 32));
});
