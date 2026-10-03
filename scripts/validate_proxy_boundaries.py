"""Exercise the candidate Nginx config in disposable containers, never production.

Requires two already-present immutable image IDs. No host ports, credentials,
production mounts, or supplier requests are used. The API is an echo fixture.
"""

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import tempfile
from pathlib import Path

MOCK_API = r'''
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond(0)

    def do_POST(self):
        remaining = int(self.headers.get('Content-Length', '0'))
        size = remaining
        while remaining:
            part = self.rfile.read(min(remaining, 65536))
            if not part:
                raise ValueError('incomplete body')
            remaining -= len(part)
        self.respond(size)

    def respond(self, size):
        body = json.dumps({'bytes': size, 'headers': dict(self.headers)}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()
'''

CLIENT = r'''
import http.client
import json
import time

checks = []

def request(path, size=0, spoof=False):
    connection = http.client.HTTPConnection('web', 8080, timeout=20)
    headers = {'Content-Type': 'application/octet-stream'}
    if spoof:
        headers.update({'X-Forwarded-For': '127.0.0.1, 169.254.169.254',
                        'X-Forwarded-Proto': 'https', 'X-Real-IP': '127.0.0.1',
                        'Forwarded': 'for=127.0.0.1;proto=https',
                        'X-Forwarded-Host': 'attacker.invalid'})
    try:
        try:
            connection.request('POST' if size else 'GET', path,
                               body=b'x' * size if size else None, headers=headers)
        except BrokenPipeError:
            # Nginx may reject Content-Length before the whole body is sent.
            pass
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()
    status, actual, body = result
    assert actual.get('X-Content-Type-Options') == 'nosniff', (path, status, actual)
    assert actual.get('X-Frame-Options') == 'DENY', (path, status, actual)
    assert "frame-ancestors 'none'" in actual.get('Content-Security-Policy', '')
    assert 'publickey-credentials-get=(self)' in actual.get('Permissions-Policy', '')
    assert actual.get('Referrer-Policy') == 'strict-origin-when-cross-origin'
    return result

for attempt in range(30):
    try:
        ready = request('/health/ready')
        if ready[0] == 200:
            break
    except (OSError, http.client.HTTPException):
        pass
    time.sleep(0.2)
else:
    raise AssertionError('isolated proxy not ready')

large = 1280 * 1024
for path, size, wanted in [
    ('/api/v1/admin/import-jobs', large, 200),
    ('/api/v1/admin/import-jobs', 10 * 1024 * 1024, 200),
    ('/api/v1/admin/import-jobs', 10 * 1024 * 1024 + 1, 413),
    ('/api/v1/admin/import-jobs/', large, 413),
    ('/api/v1/admin/configurations/example', large, 413),
    ('/api/v1/admin/points/00000000-0000-0000-0000-000000000001/experience-captions', 1024 * 1024, 200),
    ('/api/v1/admin/points/00000000-0000-0000-0000-000000000001/experience-captions', 1024 * 1024 + 1, 413),
    ('/agent/embed.html', 0, 410),
    ('/assets/nonexistent-test.js', 0, 404),
]:
    status, headers, body = request(path, size)
    assert status == wanted, (path, size, wanted, status, body[:120])
    if status == 200:
        assert json.loads(body)['bytes'] == size
    checks.append({'path': path, 'bytes': size, 'status': status})

status, _, body = request('/api/v1/proxy-fixture', spoof=True)
assert status == 200
headers = {key.lower(): value for key, value in json.loads(body)['headers'].items()}
assert headers['x-forwarded-proto'] == 'http', headers
assert headers['x-real-ip'] == headers['x-forwarded-for']
assert ',' not in headers['x-forwarded-for']
assert headers['x-forwarded-for'] not in {'127.0.0.1', '169.254.169.254'}
assert 'forwarded' not in headers and 'x-forwarded-host' not in headers
checks.append({'check': 'untrusted forwarding headers replaced', 'status': status})

statuses = [request('/api/v1/admin/import-jobs')[0] for _ in range(4)]
assert 429 in statuses, statuses
checks.append({'check': 'import ingress rate limit', 'statuses': statuses})
print(json.dumps({'checks': checks, 'security_headers_checked_on_every_response': True}))
'''


def run(arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--web-image', required=True)
    parser.add_argument('--python-image', required=True)
    args = parser.parse_args()
    for image in (args.web_image, args.python_image):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
            parser.error('Images must be explicit local immutable IDs')
        # Inspect only; a missing image is an error, never an implicit pull.
        run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    config = args.config.resolve(strict=True)
    body = config.read_bytes()
    token = secrets.token_hex(6)
    network = 'twinnku-proxy-check-' + token
    api, web = network + '-api', network + '-web'
    report = {
        'config_sha256': hashlib.sha256(body).hexdigest(),
        'web_image': args.web_image,
        'python_image': args.python_image,
        'scope': 'isolated proxy with echo API; no application authentication or TLS verification',
    }
    with tempfile.TemporaryDirectory(prefix='twinnku-proxy-check-') as folder:
        root = Path(folder)
        root.chmod(0o755)
        (root / 'nginx.conf').write_bytes(body)
        (root / 'mock.py').write_text(MOCK_API, encoding='utf-8')
        (root / 'client.py').write_text(CLIENT, encoding='utf-8')
        for item in root.iterdir():
            item.chmod(0o644)
        restricted = [
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '192m', '--cpus', '0.5', '--pids-limit', '64',
            '--tmpfs', '/tmp:size=32m',
        ]
        fixture = ['--mount', f'type=bind,src={root},dst=/qa,readonly']
        nginx_mount = ['--mount', f'type=bind,src={root / "nginx.conf"},dst=/etc/nginx/nginx.conf,readonly']
        try:
            run(['docker', 'network', 'create', '--internal', network])
            run(['docker', 'run', '-d', '--name', api, '--network', network,
                 '--network-alias', 'api', *restricted, *fixture,
                 '--entrypoint', 'python', args.python_image, '/qa/mock.py'])
            run(['docker', 'run', '--rm', '--network', network, *restricted, *nginx_mount,
                 '--entrypoint', 'nginx', args.web_image, '-t'])
            run(['docker', 'run', '-d', '--name', web, '--network', network,
                 '--network-alias', 'web', *restricted, *nginx_mount,
                 '--entrypoint', 'nginx', args.web_image, '-g', 'daemon off;'])
            report['result'] = json.loads(run([
                'docker', 'run', '--rm', '--network', network, *restricted, *fixture,
                '--entrypoint', 'python', args.python_image, '/qa/client.py',
            ]))
            report['status'] = 'passed'
        except subprocess.CalledProcessError as error:
            report['status'] = 'failed'
            report['diagnostic'] = (error.stderr or error.stdout or '')[-5000:]
            raise
        finally:
            for container in (web, api):
                subprocess.run(['docker', 'rm', '-f', container], capture_output=True, check=False)
            subprocess.run(['docker', 'network', 'rm', network], capture_output=True, check=False)
            print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
