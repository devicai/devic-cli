import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function send(args, input) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('async=true') ? { chatUid: 'new-chat' } : []));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['bin/devic.js', 'assistants', 'chat', 'bot', ...args], {
      env: { ...process.env, DEVIC_API_KEY: 'test-only', DEVIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    child.stdin.end(input);
    assert.equal(await done, 0, stderr);
    return calls;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

for (const mode of ['--no-wait', '--detach']) {
  test(`--chat-name sends a conversation name (${mode})`, async () => {
    const calls = await send(['-m', 'hello', '--chat-name', 'Contrato 📄', mode]);
    assert.deepEqual(calls[0].body, { message: 'hello', chatName: 'Contrato 📄' });
    assert.equal(calls[0].url, '/api/v1/assistants/bot/messages' + (mode === '--detach' ? '?async=true' : ''));
  });
}

test('--chat-name overrides JSON, preserving its other fields and --chat-uid', async () => {
  const calls = await send(['--from-json', '-', '--chat-name', 'Flag title', '--chat-uid', 'custom-id', '--detach'],
    JSON.stringify({ message: 'hello', chatName: 'JSON title', tenantId: 'tenant', metadata: { source: 'test' } }));
  assert.deepEqual(calls[0].body, { message: 'hello', chatName: 'Flag title', chatUid: 'custom-id', tenantId: 'tenant', metadata: { source: 'test' } });
});

test('JSON file can supply chatName without a flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devic-chat-name-'));
  try {
    const file = join(directory, 'payload.json');
    await writeFile(file, JSON.stringify({ message: 'hello', chatName: 'JSON title' }));
    const calls = await send(['--from-json', file, '--detach']);
    assert.equal(calls[0].body.chatName, 'JSON title');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('omitting --chat-name preserves the existing payload', async () => {
  const calls = await send(['-m', 'hello', '--detach']);
  assert.deepEqual(calls[0].body, { message: 'hello' });
});
