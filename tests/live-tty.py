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
        self.wfile.write(json.dumps({'chatUid': 'new-chat' if '/second/' in self.path else 'tty-chat'}).encode())
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
        result = {'chatHistory': [], 'status': 'completed' if submitted else 'waiting_for_tool_response'}
        if submitted:
            result['chatHistory'] = [{'uid': 'answer', 'role': 'assistant', 'content': {'message': 'LOCAL_TOOL_OK'}}]
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
        env={**os.environ, 'DEVIC_API_KEY': 'test-key', 'DEVIC_BASE_URL': f'http://127.0.0.1:{server.server_port}'})
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
        os.write(master, b'/assistant archived\n')
        until('is archived')
        until('you ›')
        os.write(master, b'/compact\n')
        until('Context compacted')
        until('you ›')
        assert compacted == ['/api/v1/assistants/fixture/chats/tty-chat/compact']
        os.write(master, b'/assistant\n')
        until('Choose a number')
        os.write(master, b'2\n')
        until('Second assistant · new conversation')
        until('you ›')
        os.write(master, b'/compact\n')
        until('Send a message before compacting')
        until('you ›')
        assert len(compacted) == 1
        os.write(master, b'hello second\n')
        until('LOCAL_TOOL_OK')
        until('you ›')
        assert messages[-1][0] == '/api/v1/assistants/second/messages?async=true'
        assert 'chatUid' not in messages[-1][1]
        os.write(master, b'/compact\n')
        until('Context compacted')
        until('you ›')
        assert compacted[-1] == '/api/v1/assistants/second/chats/new-chat/compact'
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
        assert 'tty-chat' not in transcript
        assert 'waiting_for_tool_response' not in transcript
        assert 'RAW_PAYLOAD' not in transcript
        assert 'Thinking' in transcript or 'Sending' in transcript
        assert len(submitted) == 1
        assert submitted[0]['content']['text'] == 'fixture only'
        print('PASS: interactive prompt, MIP, assistant picker, rejected switch, context isolation, compaction and /exit')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        server.shutdown()
