"""A loopback JSON-RPC forwarder for qualify_position_plan_fork.py on a chain read through a hosted provider.

The fork tool accepts only a loopback upstream, so no provider key ever reaches it. For Base and Arbitrum the key
is in the provider's URL, sealed on the VM as the credential v2-rpc-<chain>-<name> (backend/v2_rpc.py). This
forwarder runs on the VM as a transient unit that imports that credential. It listens on a Unix socket owned by
the operator's SSH account, mode 0600, and passes each JSON-RPC POST through unchanged. The operator's machine
reaches it with `ssh -L 127.0.0.1:<port>:<socket>`. It never logs, and its errors never carry the URL.

    systemd-run --unit domino-qualify-forward --collect -p ImportCredential=v2-rpc-base-8453-chainstack \\
        -p RuntimeDirectory=domino-qualify /usr/bin/python3 -B qualify_rpc_forwarder.py \\
        --credential v2-rpc-base-8453-chainstack --socket /run/domino-qualify/base.sock --owner domino
    ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18650:/run/domino-qualify/base.sock domino-prod

Standard library only: it runs with the host's python3, outside any release.
"""
import argparse
import http.client
import http.server
import os
from pathlib import Path
import pwd
import re
import socketserver
import sys
import threading
from urllib.parse import urlsplit

MAX_BODY_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 60
CREDENTIAL = re.compile(r'^v2-rpc-[a-z0-9-]{1,48}$')
UPSTREAM_FAILED = (b'{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"upstream_unavailable"}}')


def credential_url(name, environ=os.environ):
    """The sealed provider URL, from the unit's own credentials: HTTPS only."""
    if not CREDENTIAL.match(name or ''):
        raise ValueError('invalid_credential_name')
    directory = environ.get('CREDENTIALS_DIRECTORY')
    if not directory:
        raise ValueError('credential_missing')
    url = (Path(directory) / name).read_text().strip()
    if not url.startswith('https://') or any(ord(c) < 33 or ord(c) > 126 for c in url):
        raise ValueError('credential_not_https')
    return url


class Upstream:
    """The provider, over one keep-alive HTTPS connection per serving thread. A fork asks thousands of times, one
    cold storage slot each; a new TLS handshake per call tripled the round trip (5 Oct 2026, from the VM: 360 ms
    against 118 ms) and the fork's calls timed out. A reused connection the provider closed is opened once again."""

    def __init__(self, url):
        parts = urlsplit(url)
        self.host, self.port = parts.hostname, parts.port or 443
        self.path = (parts.path or '/') + ('?' + parts.query if parts.query else '')
        self.local = threading.local()

    def connect(self):
        return http.client.HTTPSConnection(self.host, self.port, timeout=TIMEOUT_SECONDS)

    def post(self, body):
        for attempt in (0, 1):
            connection = getattr(self.local, 'connection', None)
            reused = connection is not None
            if not reused:
                connection = self.local.connection = self.connect()
            try:
                connection.request('POST', self.path, body, {'Content-Type': 'application/json',
                                                             'User-Agent': 'domino-qualify-forwarder'})
                response = connection.getresponse()
                return response.status, response.read()
            except (http.client.HTTPException, OSError):
                connection.close()
                self.local.connection = None
                if not reused or attempt:
                    raise
        raise OSError('upstream_unavailable')


def handler_for(upstream):
    class Forward(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_POST(self):
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = -1
            if not 0 < length <= MAX_BODY_BYTES:
                return self.answer(413, b'{"error":"body_size"}')
            body = self.rfile.read(length)
            try:
                status, payload = upstream.post(body)
            except Exception:  # noqa: BLE001 - its text may name the URL
                return self.answer(502, UPSTREAM_FAILED)
            return self.answer(status, payload)

        def answer(self, status, payload):
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass
    return Forward


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    # Anvil opens a burst of connections when it forks (one per account and slot it loads); at socketserver's
    # default backlog of 5 the rest were reset (5 Oct 2026, "failed to create genesis").
    request_queue_size = 128

    def get_request(self):
        request, _ = super().get_request()
        return request, ('local', 0)  # BaseHTTPRequestHandler expects a (host, port) pair


def serve(url, socket_path, owner=None, *, upstream=None, ready=None):
    path = Path(socket_path)
    if path.exists() or path.is_symlink():
        path.unlink()
    old = os.umask(0o177)
    try:
        server = UnixServer(str(path), handler_for(upstream or Upstream(url)))
    finally:
        os.umask(old)
    if owner is not None:
        account = pwd.getpwnam(owner)
        os.chown(path, account.pw_uid, account.pw_gid)
    os.chmod(path, 0o600)
    if ready is not None:
        ready(server)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        path.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--credential', required=True, help='v2-rpc-<chain>-<name>, imported by the unit')
    parser.add_argument('--socket', required=True, help='the Unix socket to listen on')
    parser.add_argument('--owner', help="the account the socket belongs to (the operator's SSH login)")
    args = parser.parse_args(argv)
    try:
        url = credential_url(args.credential)
    except (OSError, ValueError) as error:
        print(str(error) if isinstance(error, ValueError) else 'credential_unreadable', file=sys.stderr)
        return 2
    serve(url, args.socket, args.owner)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
