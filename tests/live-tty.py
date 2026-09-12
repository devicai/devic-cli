"""Exercise the real interactive CLI and MIP over a local mock HTTP API (stdlib only)."""
import http.server
import json
import os
import pty
import select
import subprocess
import tempfile
import threading
import time
from pathlib import Path

submitted = []
messages = []
compacted = []
class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/compact'):
            compacted.append(self.path)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"compacted":true,"checkpoint":{"compactedMessageCount":12}}')
            return
        if self.path.endswith('/tool-response'):
            submitted.extend(data['responses'])
        else:
            assert len(data['tools']) == 2
            messages.append((self.path, data))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'chatUid': data.get('chatUid') or ('new-chat' if '/second/' in self.path else 'tty-chat')}).encode())
    def do_GET(self):
        assistants = [
            {'identifier': 'fixture', 'name': 'Fixture assistant', 'state': 'active'},
            {'identifier': 'second', 'name': 'Second assistant', 'state': 'active'},
            {'identifier': 'archived', 'name': 'Archived assistant', 'state': 'inactive'},
        ]
        if self.path == '/api/v1/assistants' or self.path.count('/') == 4:
            target = next((a for a in assistants if self.path.endswith('/' + a['identifier'])), None)
            self.send_response(200 if target or self.path == '/api/v1/assistants' else 404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(assistants if self.path == '/api/v1/assistants' else target or {'message': 'Assistant not found'}).encode())
            return
        if self.path.endswith('/chats/tty-chat'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'contextWindow': 128000, 'tokenUsage': {'inputTokens': 100, 'outputTokens': 20, 'cost': {'totalCost': 0.01}}, 'recalledMemories': [{'uid': 'recall', 'source': 'search_memory', 'facts': [{'fact': 'TTY memory detail'}]}]}).encode())
            return
        if self.path.startswith('/api/v1/assistants/second/chats?'):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'histories': [
                {'chatUID': 'recent-a', 'name': 'Recent A', 'assistantSpecializationIdentifier': 'second', 'creationTimestampMs': 2000},
                {'chatUID': 'recent-b', 'name': 'Recent B', 'assistantSpecializationIdentifier': 'second', 'creationTimestampMs': 1000},
            ], 'total': 2, 'offset': 0, 'limit': 20}).encode())
            return
        if self.path.rsplit('/', 1)[-1] in ['recent-a', 'recent-b', 'wrong', 'missing']:
            uid = self.path.rsplit('/', 1)[-1]
            self.send_response(404 if uid == 'missing' else 200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'message': 'Chat not found'} if uid == 'missing' else {
                'chatUID': uid, 'name': 'Saved ' + uid, 'assistantSpecializationIdentifier': 'other' if uid == 'wrong' else 'second',
                'chatContent': [{'uid': 'old-' + uid, 'role': 'assistant', 'content': {'message': 'HISTORY ' + uid}}],
            }).encode())
            return
        result = {'chatHistory': [], 'status': 'completed' if submitted else 'waiting_for_tool_response'}
        if submitted:
            result['chatHistory'] = [{'uid': 'answer', 'role': 'assistant', 'content': {'message': 'TURN_DONE ' + messages[-1][1]['message'] if messages and messages[-1][1]['message'].startswith('continue ') else 'LOCAL_TOOL_OK'}}]
        else:
            result['pendingToolCalls'] = [{'id': 'read1', 'type': 'function', 'function': {'name': 'read_file', 'arguments': '{"path":"fixture.txt"}'}}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(('event: snapshot\ndata: ' + json.dumps(result) + '\n\n').encode())

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), API)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='devic-live-tty-') as root:
    Path(root, 'fixture.txt').write_text('fixture only')
    master, slave = pty.openpty()
    proc = subprocess.Popen(['node', 'bin/devic.js', 'live', 'fixture', '--local-tools', '--workspace', root],
        cwd=Path(__file__).resolve().parent.parent, stdin=slave, stdout=slave, stderr=slave,
        env={**os.environ, 'TERM': 'xterm-256color', 'NO_COLOR': '1', 'DEVIC_API_KEY': 'test-key', 'DEVIC_BASE_URL': f'http://127.0.0.1:{server.server_port}'})
    os.close(slave)
    output = ''
    transcript = ''
    def until(marker):
        global output, transcript
        deadline = time.monotonic() + 10
        while marker not in output:
            assert time.monotonic() < deadline, output
            if select.select([master], [], [], .2)[0]:
                chunk = os.read(master, 65536).decode(errors='replace')
                assert chunk, output
                transcript += chunk
                output += chunk
        output = output.split(marker, 1)[1]
    try:
        until('you ›')
        os.write(master, b'read fixture\n')
        until('[y/N]')
        assert not submitted
        os.write(master, b'y\n')
        until('LOCAL_TOOL_OK')
        until('you ›')
        os.write(master, b'/status\n')
        until('Context window: 128,000 tokens')
        until('you ›')
        os.write(master, b'/memories\n')
        until('TTY memory detail')
        until('you ›')
        os.write(master, b'/assistant archived\n')
        until('is archived')
        until('you ›')
        os.write(master, b'/')
        until('Tab complete')
        os.write(master, b'\x1b')
        time.sleep(.6)  # Standalone Escape must be disambiguated from an arrow sequence.
        os.write(master, b'\x15/comp')
        until('Compact conversation context')
        os.write(master, b'\t')
        time.sleep(.1)
        assert not compacted
        os.write(master, b'\n')
        until('Context compacted')
        until('you ›')
        assert compacted == ['/api/v1/assistants/fixture/chats/tty-chat/compact']
        os.write(master, b'/assistants\n')
        until('Enter switch')
        os.write(master, b'\x1b')
        until('you ›')
        os.write(master, b'/assistants\n')
        until('Enter switch')
        os.write(master, b'\x1b[B\n')
        until('Second assistant · new conversation')
        until('you ›')
        os.write(master, b'/compact\n')
        until('Send a message before compacting')
        until('you ›')
        assert len(compacted) == 1
        os.write(master, 'hola segundo 🌞\n'.encode())
        until('LOCAL_TOOL_OK')
        until('you ›')
        assert messages[-1][0] == '/api/v1/assistants/second/messages?async=true'
        assert 'chatUid' not in messages[-1][1]
        assert messages[-1][1]['message'] == 'hola segundo 🌞'
        os.write(master, b'/')
        until('Tab complete')
        os.write(master, b'\x1b[B\x1b[B\n')
        until('Context compacted')
        until('you ›')
        assert compacted[-1] == '/api/v1/assistants/second/chats/new-chat/compact'
        os.write(master, b'/conversations\n')
        until('Recent conversations ›')
        until('Enter switch')
        os.write(master, b'\x1b')
        until('you ›')
        os.write(master, b'/conversations\n')
        until('Enter switch')
        os.write(master, b'\x1b[B\n')
        until('HISTORY recent-b')
        until('you ›')
        for command, expected in [('/resume wrong', 'does not belong'), ('/resume missing', 'Chat not found')]:
            os.write(master, (command + '\n').encode())
            until(expected)
            until('you ›')
        os.write(master, b'continue selected\n')
        until('TURN_DONE continue selected')
        until('you ›')
        assert messages[-1][1]['chatUid'] == 'recent-b'
        os.write(master, b'/resume recent-a\n')
        until('HISTORY recent-a')
        until('you ›')
        os.write(master, b'continue direct\n')
        until('TURN_DONE continue direct')
        until('you ›')
        assert messages[-1][1]['chatUid'] == 'recent-a'
        os.write(master, b'/exit\n')
        until('/exit')
        # Keep consuming the PTY while waiting: terminal writes may block the
        # child until the terminal emulator (this test) reads them.
        deadline = time.monotonic() + 8
        while proc.poll() is None:
            assert time.monotonic() < deadline, repr(transcript + output)
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536).decode(errors='replace')
                    transcript += chunk
                except OSError:
                    break
        assert proc.wait(timeout=2) == 0
        assert 'Chat: tty-chat' in transcript
        assert 'waiting_for_tool_response' not in transcript
        assert 'RAW_PAYLOAD' not in transcript
        assert 'Thinking' in transcript or 'Sending' in transcript
        assert len(submitted) == 1
        assert submitted[0]['content']['text'] == 'fixture only'
        print('PASS: slash menu, Tab completion, Escape, arrow assistant picker, MIP, context isolation, compaction, status, memories, conversation resume and /exit')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        server.shutdown()
