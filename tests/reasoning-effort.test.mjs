import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

async function run(args, input, response = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: response }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['bin/devic.js', '-o', 'json', ...args], {
      env: { ...process.env, DEVIC_API_KEY: 'test-only', DEVIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    return { code: await done, calls, stdout, stderr };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

for (const action of [['create'], ['update', 'bot']]) {
  test(`assistant ${action[0]} accepts reasoning JSON and flag resets override it`, async () => {
    const r = await run(['assistants', ...action, '--from-json', '-', '--reasoning-effort', 'default'], { name: 'QA', reasoningEffort: 'high' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].body.reasoningEffort, null);
    assert.equal(r.calls[0].body.name, 'QA');
    assert.equal(r.calls[0].method, action[0] === 'create' ? 'POST' : 'PATCH');
  });
  test(`assistant ${action[0]} preserves reasoning effort from JSON`, async () => {
    const r = await run(['assistants', ...action, '--from-json', '-'], { reasoningEffort: 'medium' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].body.reasoningEffort, 'medium');
  });
}

for (const mode of ['--no-wait', '--detach']) {
  test(`message and conversation efforts are independent (${mode})`, async () => {
    const r = await run(['assistants', 'chat', 'bot', '-m', 'hello', mode, '--reasoning-effort', 'none', '--conversation-reasoning-effort', 'low'], undefined, mode === '--detach' ? { chatUid: 'chat' } : []);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls[0].body, { message: 'hello', reasoningEffort: 'none', conversationReasoningEffort: 'low' });
    assert.equal(r.calls[0].url.endsWith('?async=true'), mode === '--detach');
  });
}

test('message flags reset JSON values without losing chat or metadata', async () => {
  const r = await run(['assistants', 'chat', 'bot', '--detach', '--from-json', '-', '--reasoning-effort', 'null', '--conversation-reasoning-effort', 'default'], {
    message: 'hello', chatUid: 'chat', reasoningEffort: 'max', conversationReasoningEffort: 'high', metadata: { source: 'test' },
  }, { chatUid: 'chat' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls[0].body, { message: 'hello', chatUid: 'chat', reasoningEffort: null, conversationReasoningEffort: null, metadata: { source: 'test' } });
});

test('omitting effort flags leaves the payload unchanged', async () => {
  const r = await run(['assistants', 'update', 'bot', '--name', 'Renamed']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls[0].body, { name: 'Renamed' });
});

for (const value of ['ultra', 'HIGH', '']) {
  test(`invalid effort ${JSON.stringify(value)} fails before HTTP`, async () => {
    const r = await run(['assistants', 'update', 'bot', '--reasoning-effort', value]);
    assert.notEqual(r.code, 0);
    assert.equal(r.calls.length, 0);
    assert.match(r.stderr + r.stdout, /Invalid reasoning effort/);
  });
}

test('model discovery unwraps API response and filters exact model/provider', async () => {
  const catalog = [{ provider: 'openai', reasoningEfforts: ['low', 'high'], models: [{ model: 'a', reasoningEfforts: ['low'] }, { model: 'b', reasoningEfforts: ['high'] }] }, { provider: 'other', reasoningEfforts: [], models: [{ model: 'b', reasoningEfforts: [] }] }];
  const r = await run(['models', 'list', '--provider', 'openai', '--model', 'b'], undefined, catalog);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].url, '/api/v1/models');
  assert.deepEqual(JSON.parse(r.stdout), [{ ...catalog[0], models: [catalog[0].models[1]] }]);
});
