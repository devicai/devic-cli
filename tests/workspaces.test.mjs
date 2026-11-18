import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve('bin/devic.js');
const WS = '/api/v1/workspaces';

/**
 * Runs the CLI against a mock API. `route(call)` returns
 * `{ data }` (wrapped in the success envelope), `{ status, json }`, or
 * `{ raw: Buffer, headers }` for binary responses.
 */
async function run(args, { route = () => ({ data: {} }), env = {}, cwd, stdin } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
    calls.push(call);
    const r = (await route(call)) ?? { data: {} };
    if (r.raw) {
      res.writeHead(r.status ?? 200, r.headers ?? {});
      res.end(r.raw);
      return;
    }
    res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.json ?? { success: true, data: r.data }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const childEnv = { ...process.env, DEVIC_API_KEY: 'test-only', DEVIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ...env };
    if (!('DEVIC_USER' in env)) delete childEnv.DEVIC_USER;
    const child = spawn(process.execPath, [BIN, '-o', 'json', ...args], { env: childEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const done = new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok); });
    child.stdin.end(stdin);
    return { code: await done, calls, stdout, stderr };
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/** Final JSON document of stdout, skipping NDJSON status lines. */
function finalJson(stdout) {
  return JSON.parse(stdout.split('\n').filter((l) => !l.startsWith('{"type":')).join('\n'));
}

test('list sends search, archived and pagination as query; no X-Devic-User by default', async () => {
  const r = await run(['ws', 'list', '--search', 'ventas norte', '--archived', '--offset', '20', '--limit', '5'], {
    route: () => ({ data: { workspaces: [{ id: 'w1', name: 'Ventas' }], total: 21, offset: 20, limit: 5, hasMore: false } }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].url, `${WS}?search=ventas+norte&includeArchived=true&offset=20&limit=5`);
  assert.equal(r.calls[0].headers['x-devic-user'], undefined);
  assert.equal(finalJson(r.stdout).workspaces[0].id, 'w1');
});

test('invalid --limit fails before HTTP', async () => {
  const r = await run(['ws', 'list', '--limit', 'ten']);
  assert.notEqual(r.code, 0);
  assert.equal(r.calls.length, 0);
});

test('threads list --unread is cross-workspace; --workspace scopes it', async () => {
  const all = await run(['workspaces', 'threads', 'list', '--unread', '--search', 'factura']);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.calls[0].url, `${WS}/threads?search=factura&unread=true`);

  const one = await run(['ws', 'threads', 'list', '--workspace', 'w1', '--limit', '3']);
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.calls[0].url, `${WS}/w1/threads?limit=3`);
});

test('send posts the body and X-Devic-User from --as (anywhere on the line)', async () => {
  const route = () => ({ data: { message: { id: 'm1', seq: 4 }, invocations: [] } });
  for (const args of [
    ['ws', 'send', 'w1', 't1', 'hola equipo', '--assistant', 'a1', '--reply-to', 'm0', '--client-id', 'c-1', '--as', 'ana@acme.com'],
    ['ws', '--as', 'ana@acme.com', 'send', 'w1', 't1', 'hola equipo', '--assistant', 'a1', '--reply-to', 'm0', '--client-id', 'c-1'],
  ]) {
    const r = await run(args, { route, env: { DEVIC_USER: 'someone-else' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0].method, 'POST');
    assert.equal(r.calls[0].url, `${WS}/w1/threads/t1/messages`);
    assert.equal(r.calls[0].headers['x-devic-user'], 'ana@acme.com');
    assert.deepEqual(r.calls[0].body, {
      text: 'hola equipo', directedAssistantId: 'a1', replyToMessageId: 'm0', clientMessageId: 'c-1',
    });
  }
});

test('send takes X-Devic-User from DEVIC_USER and the text from stdin', async () => {
  const r = await run(['ws', 'send', 'w1', 't1', '-', '--mention', 'assistant:a9:Writer'], {
    env: { DEVIC_USER: 'u-123' },
    stdin: 'from stdin\n',
    route: () => ({ data: { message: { id: 'm1', seq: 1 }, invocations: [] } }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].headers['x-devic-user'], 'u-123');
  assert.deepEqual(r.calls[0].body, { text: 'from stdin\n', mentions: [{ kind: 'assistant', id: 'a9', label: 'Writer' }] });
});

test('X-Devic-User is not sent outside the Workspaces API', async () => {
  const r = await run(['models', 'list'], { env: { DEVIC_USER: 'u-123' }, route: () => ({ data: [] }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].headers['x-devic-user'], undefined);
});

test('send --wait polls messages?after=<seq> until the invocation completes', async () => {
  let polls = 0;
  const r = await run(['ws', 'send', 'w1', 't1', 'resume esto', '--wait', '--poll-interval', '0.05'], {
    route: (c) => {
      if (c.method === 'POST') return { data: { message: { id: 'm1', seq: 5 }, invocations: [{ id: 'r1', status: 'queued' }] } };
      const url = new URL(c.url, 'http://x');
      assert.equal(url.pathname, `${WS}/w1/threads/t1/messages`);
      polls++;
      const after = Number(url.searchParams.get('after'));
      if (polls === 1) return { data: { messages: [], invocations: [{ id: 'r1', status: 'running' }], hasMore: false } };
      if (after === 5) {
        return { data: {
          messages: [{ id: 'm2', seq: 6, role: 'assistant', authorName: 'Writer', text: 'Hecho.' }],
          invocations: [{ id: 'r1', status: 'completed' }], hasMore: false,
        } };
      }
      return { data: { messages: [], invocations: [], hasMore: false } };
    },
  });
  assert.equal(r.code, 0, r.stderr);
  const gets = r.calls.filter((c) => c.method === 'GET');
  assert.ok(gets.every((c) => c.url.includes('after=')), 'only paged message reads');
  assert.match(gets[0].url, /after=5/);
  assert.match(gets.at(-1).url, /after=6/, 'cursor advances past the reply');
  const out = finalJson(r.stdout);
  assert.equal(out.outcome, 'completed');
  assert.deepEqual(out.messages.map((m) => m.id), ['m2']);
  assert.equal(out.invocations[0].status, 'completed');
});

test('send --wait stops on waiting_input and falls back to the thread detail for statuses', async () => {
  const r = await run(['ws', 'send', 'w1', 't1', 'decide', '--wait', '--poll-interval', '0.05'], {
    route: (c) => {
      if (c.method === 'POST') return { data: { message: { id: 'm1', seq: 2 }, invocations: [{ id: 'r1', status: 'running' }] } };
      if (c.url.includes('/messages')) return { data: { messages: [], invocations: [], hasMore: false } };
      return { data: { thread: { id: 't1' }, messages: [], invocations: [{ id: 'r1', status: 'waiting_input', revision: 3, requestedInput: { id: 'in1' } }] } };
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.some((c) => c.url === `${WS}/w1/threads/t1`));
  assert.equal(finalJson(r.stdout).outcome, 'waiting');
});

test('send --wait exits 3 on timeout', async () => {
  const r = await run(['ws', 'send', 'w1', 't1', 'x', '--wait', '--timeout', '0.3', '--poll-interval', '0.05'], {
    route: (c) => c.method === 'POST'
      ? { data: { message: { id: 'm1', seq: 1 }, invocations: [{ id: 'r1', status: 'running' }] } }
      : { data: { messages: [], invocations: [{ id: 'r1', status: 'running' }], hasMore: false } },
  });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /POLL_TIMEOUT/);
});

test('answer fetches revision and inputId from the thread', async () => {
  const answers = [{ id: 'q1', selected: ['opt-a'] }];
  const route = (c) => c.method === 'GET'
    ? { data: { thread: { id: 't1' }, messages: [], invocations: [
        { id: 'r0', status: 'completed', revision: 1 },
        { id: 'r1', status: 'waiting_input', revision: 7, requestedInput: { id: 'in-9', questions: [{ id: 'q1' }] } },
      ] } }
    : { data: { id: 'r1', status: 'running' } };

  const r = await run(['ws', 'answer', 'w1', 't1', 'r1', '--answers', JSON.stringify(answers)], { route });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].url, `${WS}/w1/threads/t1`);
  assert.equal(r.calls[1].url, `${WS}/w1/threads/t1/invocations/r1/answer`);
  assert.deepEqual(r.calls[1].body, { revision: 7, inputId: 'in-9', response: { answers } });

  const skip = await run(['ws', 'answer', 'w1', 't1', 'r1', '--skip'], { route });
  assert.equal(skip.code, 0, skip.stderr);
  assert.deepEqual(skip.calls[1].body, { revision: 7, inputId: 'in-9', skipped: true });

  const notWaiting = await run(['ws', 'answer', 'w1', 't1', 'r0', '--skip'], { route });
  assert.notEqual(notWaiting.code, 0);
  assert.match(notWaiting.stderr, /NOT_WAITING_FOR_INPUT/);
  assert.equal(notWaiting.calls.length, 1);
});

test('approve fetches revision and actionId from the thread', async () => {
  const route = (c) => c.method === 'GET'
    ? { data: { thread: { id: 't1' }, messages: [], invocations: [
        { id: 'r0', status: 'running', revision: 3 },
        { id: 'r1', status: 'waiting_approval', revision: 14, requestedAction: { id: 'call_x' } },
      ] } }
    : { data: { id: 'r1', status: 'queued' } };

  const r = await run(['ws', 'approve', 'w1', 't1', 'r1'], { route });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[1].url, `${WS}/w1/threads/t1/invocations/r1/approve`);
  assert.deepEqual(r.calls[1].body, { revision: 14, actionId: 'call_x' });

  const always = await run(['ws', 'approve', 'w1', 't1', 'r1', '--always'], { route });
  assert.deepEqual(always.calls[1].body, { revision: 14, actionId: 'call_x', always: true });

  const notWaiting = await run(['ws', 'approve', 'w1', 't1', 'r0'], { route });
  assert.notEqual(notWaiting.code, 0);
  assert.match(notWaiting.stderr, /NOT_WAITING_FOR_APPROVAL/);
  assert.equal(notWaiting.calls.length, 1);
});

test('files download writes the bytes under the server name and refuses to overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devic-ws-dl-'));
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
  const route = () => ({ raw: bytes, headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''informe%20a%C3%B1o.pdf",
  } });

  const r = await run(['ws', 'files', 'download', 'w1', 't1', 'f1'], { route, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].url, `${WS}/w1/threads/t1/files/f1/download`);
  const target = join(dir, 'informe año.pdf');
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(finalJson(r.stdout).bytes, bytes.length);

  writeFileSync(target, 'keep me');
  const again = await run(['ws', 'files', 'download', 'w1', 't1', 'f1'], { route, cwd: dir });
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /FILE_EXISTS/);
  assert.equal(readFileSync(target, 'utf-8'), 'keep me');

  const forced = await run(['ws', 'files', 'download', 'w1', 't1', 'f1', '--force'], { route, cwd: dir });
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(readFileSync(target), bytes);

  const toDir = await run(['ws', 'files', 'download', 'w1', 't1', 'f1', '--out', 'sub/'], { route, cwd: dir });
  assert.equal(toDir.code, 0, toDir.stderr);
  assert.ok(existsSync(join(dir, 'sub', 'informe año.pdf')));
});

test('memory add posts section, content and pinned; bad section fails before HTTP', async () => {
  const r = await run(['ws', 'memory', 'add', 'w1', 'a1', '--section', 'decisions', '--content', 'Usamos EUR', '--pinned']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].method, 'POST');
  assert.equal(r.calls[0].url, `${WS}/w1/assistants/a1/memory/core`);
  assert.deepEqual(r.calls[0].body, { section: 'decisions', content: 'Usamos EUR', pinned: true });

  const bad = await run(['ws', 'memory', 'add', 'w1', 'a1', '--section', 'notes', '--content', 'x']);
  assert.notEqual(bad.code, 0);
  assert.equal(bad.calls.length, 0);
});

test('rules set sends the current revision as expectedRevision', async () => {
  const route = (c) => (c.method === 'GET' ? { data: { content: 'old', revision: 4 } } : { data: { content: 'new', revision: 5 } });
  const r = await run(['ws', 'rules', 'set', 'w1', '--content', 'Responde en español'], { route });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls[0].url, `${WS}/w1/rules`);
  assert.equal(r.calls[1].method, 'PUT');
  assert.deepEqual(r.calls[1].body, { content: 'Responde en español', expectedRevision: 4 });

  const thread = await run(['ws', 'rules', 'set', 'w1', '--thread', 't1', '--content', '-', '--expected-revision', '9'], { route, stdin: 'from stdin' });
  assert.equal(thread.code, 0, thread.stderr);
  assert.equal(thread.calls.length, 1, 'no fetch when the revision is given');
  assert.equal(thread.calls[0].url, `${WS}/w1/threads/t1/rules`);
  assert.deepEqual(thread.calls[0].body, { content: 'from stdin', expectedRevision: 9 });
});

test('skills attach/detach read-modify-write resources.knowledgeSkills', async () => {
  const route = (c) => (c.method === 'GET'
    ? { data: { knowledgeSkills: [{ type: 'document', id: 's1', name: 'One', enabled: true }], knowledge: [], revision: 12 } }
    : { data: {} });
  // Display fields are dropped; a bare id is a skill document, folder:<id> a folder.
  const add = await run(['ws', 'skills', 'attach', 'w1', 's1', 's2', 'folder:f1'], { route });
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.calls[1].method, 'PUT');
  assert.equal(add.calls[1].url, `${WS}/w1/resources`);
  assert.deepEqual(add.calls[1].body, {
    knowledgeSkills: [
      { type: 'document', id: 's1', enabled: true },
      { type: 'document', id: 's2' },
      { type: 'folder', id: 'f1' },
    ],
    revision: 12,
  });

  const drop = await run(['ws', 'skills', 'detach', 'w1', 'document:s1'], { route });
  assert.equal(drop.code, 0, drop.stderr);
  assert.deepEqual(drop.calls[1].body, { knowledgeSkills: [], revision: 12 });
});

test('API error body {error, message} surfaces the code', async () => {
  const r = await run(['ws', 'get', 'nope'], { route: () => ({ status: 404, json: { error: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } }) });
  assert.equal(r.code, 1);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'WORKSPACE_NOT_FOUND');
  assert.equal(err.statusCode, 404);
});

test('dm: list, open by userUID or email, and send opens then posts', async () => {
  const list = await run(['ws', 'dm', 'list'], { route: () => ({ data: { workspaceId: 'dm', items: [{ id: 't1', workspaceId: 'dm', kind: 'direct', title: 'Ana · Bea' }] } }) });
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.calls[0].url, `${WS}/direct-messages`);

  const byId = await run(['ws', 'dm', 'open', 'u1'], { route: () => ({ data: { id: 't1', workspaceId: 'dm' } }) });
  assert.equal(byId.calls[0].method, 'POST');
  assert.deepEqual(byId.calls[0].body, { userUID: 'u1' });
  const byEmail = await run(['ws', 'dm', 'open', 'bea@example.test'], { route: () => ({ data: { id: 't1', workspaceId: 'dm' } }) });
  assert.deepEqual(byEmail.calls[0].body, { email: 'bea@example.test' });

  const send = await run(['ws', 'dm', 'send', 'u1', 'hola', '--client-id', 'c1'], {
    route: (c) => (c.url.endsWith('/direct-messages') ? { data: { id: 't1', workspaceId: 'dm' } } : { data: { message: { id: 'm1' }, invocations: [] } }),
  });
  assert.equal(send.code, 0, send.stderr);
  assert.equal(send.calls[1].url, `${WS}/dm/threads/t1/messages`);
  assert.deepEqual(send.calls[1].body, { text: 'hola', clientMessageId: 'c1' });
});

test('send --everybody mentions everyone and puts @everybody in the text', async () => {
  const r = await run(['ws', 'send', 'w1', 't1', 'Reunión a las 5', '--everybody'], { route: () => ({ data: { message: {}, invocations: [] } }) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls[0].body, { text: 'Reunión a las 5 @everybody', mentions: [{ kind: 'everyone', id: 'everyone', label: 'everybody' }] });
  const kept = await run(['ws', 'send', 'w1', 't1', '@everyone mirad esto', '--mention', 'everyone'], { route: () => ({ data: { message: {}, invocations: [] } }) });
  assert.equal(kept.calls[0].body.text, '@everyone mirad esto', 'already in the text: not added again');
});

test('threads list --kind direct is passed; anything else is refused', async () => {
  const r = await run(['ws', 'threads', 'list', '--kind', 'direct'], { route: () => ({ data: { items: [] } }) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.calls[0].url, /kind=direct/);
  const bad = await run(['ws', 'threads', 'list', '--kind', 'other']);
  assert.notEqual(bad.code, 0);
});
