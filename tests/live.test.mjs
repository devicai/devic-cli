import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { consumeChatStream } from '../dist/live/stream.js';
import { LiveRenderer } from '../dist/live/render.js';
import { runLocalTool } from '../dist/live/local-tools.js';

const message = text => ({ uid: 'reply', role: 'assistant', content: { message: text } });
const frame = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const snapshot = { status: 'processing', chatHistory: [], streamingMessage: message('H') };

test('SSE handles byte splits, UTF-8, CRLF, partials and deltas', async () => {
  const bytes = new TextEncoder().encode(frame('snapshot', snapshot) + frame('partial', { streamingMessage: message('Hé') }) + frame('delta', { append: 'llo' }));
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const results = [];
  await consumeChatStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), s => results.push(s));
  assert.equal(results.at(-1).streamingMessage.content.message, 'Héllo');
});

test('renderer appends partials once and strips terminal escape commands', () => {
  let output = '';
  const renderer = new LiveRenderer(text => { output += text; });
  renderer.messages([message('H')]); renderer.messages([message('Hello')]);
  renderer.messages([message('Hello')]); renderer.messages([message('Hello\x1b[2J!')]);
  assert.equal(output, '\nassistant › Hello!');
});

test('local tools require approval and reject traversal and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devic-live-'));
  const call = path => ({ id: '1', function: { name: 'read_file', arguments: JSON.stringify({ path }) } });
  try {
    await writeFile(join(root, 'a.txt'), 'fixture');
    assert.deepEqual(await runLocalTool(root, call('a.txt'), async () => false), { error: 'User denied local access' });
    assert.equal((await runLocalTool(root, call('a.txt'), async () => true)).text, 'fixture');
    await assert.rejects(runLocalTool(root, call('..'), async () => true), /outside/);
    await symlink(tmpdir(), join(root, 'escape'));
    await assert.rejects(runLocalTool(root, call('escape'), async () => true), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function runMock(mode) {
  let sends = 0;
  const server = createServer(async (req, res) => {
    if (req.url.includes('/messages')) {
      sends++; for await (const _ of req) {};
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ chatUid: 'mock-chat' }));
    } else if (req.url.includes('/stream?')) {
      if (mode === 'fallback') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame('snapshot', snapshot));
      res.write(frame('delta', { append: 'ello' }));
      res.end(frame('snapshot', { status: 'completed', chatHistory: [message('Hello')] }));
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'completed', chatHistory: [message('Hello')] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['bin/devic.js', 'live', 'test', '-m', 'hello'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DEVIC_API_KEY: 'test-key', DEVIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 0, output); assert.equal(sends, 1); assert.match(output, /completed/);
    if (mode === 'fallback') assert.match(output, /continuing with polling/);
    else assert.equal((output.match(/ello/g) || []).length, 1, output);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('CLI completes a streamed cloud turn without replaying final text', () => runMock('sse'));
test('CLI falls back on missing SSE without resending the user message', () => runMock('fallback'));

test('agent follow renders tasks and stops for approval', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ state: 'paused_for_approval', threadContent: [message('Review needed')], tasks: [{ title: 'Inspect input', completed: true }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['bin/devic.js', 'live', 'agent', '--agent', '--thread', 'thread'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DEVIC_API_KEY: 'test-key', DEVIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 0, output);
    assert.match(output, /paused_for_approval/); assert.match(output, /\[x\] Inspect input/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
