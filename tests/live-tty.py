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
class API(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/tool-response'):
            submitted.extend(data['responses'])
        else:
            assert len(data['tools']) == 2
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"chatUid":"tty-chat"}')
    def do_GET(self):
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
    def until(marker):
        global output
        deadline = time.monotonic() + 10
        while marker not in output:
            assert time.monotonic() < deadline, output
            if select.select([master], [], [], .2)[0]:
                output += os.read(master, 65536).decode(errors='replace')
        output = output.split(marker, 1)[1]
    try:
        until('you ›')
        os.write(master, b'read fixture\n')
        until('[y/N]')
        assert not submitted
        os.write(master, b'y\n')
        until('LOCAL_TOOL_OK')
        until('you ›')
        os.write(master, b'/exit\n')
        until('/exit')
        try:
            assert proc.wait(timeout=8) == 0
        except subprocess.TimeoutExpired:
            for _ in range(10):
                if not select.select([master], [], [], .1)[0]:
                    break
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                output += chunk.decode(errors='replace')
            raise AssertionError(repr(output))
        assert len(submitted) == 1
        assert submitted[0]['content']['text'] == 'fixture only'
        print('PASS: interactive prompt, MIP approval, local result, cloud continuation, /exit')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        server.shutdown()
