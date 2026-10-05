"""The qualification forwarder: the sealed URL only from the unit's credentials, an operator-only socket, bodies
passed through unchanged, and failures that never carry the URL. No network: the upstream is a stand-in."""
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qualify_rpc_forwarder as forwarder  # noqa: E402

URL = 'https://provider.invalid/secret-key-in-path'


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.unix_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(self.unix_path)


class FakeUpstream:
    def __init__(self, test):
        self.test = test

    def post(self, body):
        self.test.sent.append(body)
        return self.test.behaviour(body)


class FakeConnection:
    """http.client.HTTPSConnection's surface: answers from a script, or fails like a closed keep-alive."""
    opened = []

    def __init__(self, script):
        self.script, self.requests, self.closed = script, [], False
        FakeConnection.opened.append(self)

    def request(self, method, path, body, headers):
        self.requests.append((method, path, body, headers))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step

    def getresponse(self):
        return SimpleNamespace(status=200, read=lambda: b'{"result":"0x1"}')

    def close(self):
        self.closed = True


class UpstreamTests(unittest.TestCase):
    def test_one_kept_connection_per_thread_and_one_reconnect_when_the_provider_closed_it(self):
        upstream = forwarder.Upstream(URL)
        self.assertEqual((upstream.host, upstream.port, upstream.path), ('provider.invalid', 443, '/secret-key-in-path'))
        scripts = [[None, None, http.client.RemoteDisconnected('closed')], [None]]
        FakeConnection.opened = []
        upstream.connect = lambda: FakeConnection(scripts.pop(0))
        self.assertEqual(upstream.post(b'a'), (200, b'{"result":"0x1"}'))
        self.assertEqual(upstream.post(b'b'), (200, b'{"result":"0x1"}'))
        self.assertEqual(len(FakeConnection.opened), 1)
        # The provider closed the kept connection: a fresh one carries the same body.
        self.assertEqual(upstream.post(b'c'), (200, b'{"result":"0x1"}'))
        first, second = FakeConnection.opened
        self.assertTrue(first.closed)
        self.assertEqual([r[2] for r in second.requests], [b'c'])
        self.assertEqual(second.requests[0][:2], ('POST', '/secret-key-in-path'))

    def test_a_fresh_connection_that_fails_is_not_retried(self):
        upstream = forwarder.Upstream(URL)
        FakeConnection.opened = []
        upstream.connect = lambda: FakeConnection([ConnectionRefusedError('refused')])
        with self.assertRaises(OSError):
            upstream.post(b'a')
        self.assertEqual(len(FakeConnection.opened), 1)


class CredentialTests(unittest.TestCase):
    def test_the_url_comes_only_from_the_units_credentials_and_must_be_https(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'v2-rpc-base-8453-chainstack').write_text(URL + '\n')
            self.assertEqual(forwarder.credential_url('v2-rpc-base-8453-chainstack',
                                                      {'CREDENTIALS_DIRECTORY': directory}), URL)
            Path(directory, 'v2-rpc-base-8453-public').write_text('http://provider.invalid/\n')
            for name, environ, code in (('v2-rpc-base-8453-public', {'CREDENTIALS_DIRECTORY': directory},
                                         'credential_not_https'),
                                        ('v2-rpc-base-8453-chainstack', {}, 'credential_missing'),
                                        ('../etc/passwd', {'CREDENTIALS_DIRECTORY': directory}, 'invalid_credential_name'),
                                        ('uniswap-api-key', {'CREDENTIALS_DIRECTORY': directory},
                                         'invalid_credential_name')):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, code):
                    forwarder.credential_url(name, environ)


class ForwardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.addCleanup(lambda: os.path.isdir(self.directory) and os.rmdir(self.directory))
        self.path = os.path.join(self.directory, 'rpc.sock')
        self.sent = []
        self.behaviour = lambda body: (200, b'{"jsonrpc":"2.0","id":1,"result":"0x2105"}')
        servers = []
        ready = threading.Event()

        def keep(server):
            servers.append(server)
            ready.set()
        thread = threading.Thread(target=forwarder.serve, args=(URL, self.path),
                                  kwargs={'upstream': FakeUpstream(self), 'ready': keep}, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(10))
        self.addCleanup(thread.join, 10)
        self.addCleanup(servers[0].shutdown)

    def post(self, payload):
        connection = UnixConnection(self.path)
        try:
            connection.request('POST', '/', body=payload, headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_a_post_passes_through_unchanged_on_an_operator_only_socket(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []}).encode()
        self.assertEqual(self.post(body), (200, b'{"jsonrpc":"2.0","id":1,"result":"0x2105"}'))
        self.assertEqual(self.sent, [body])

    def test_a_burst_of_connections_is_served(self):
        # A fork's first moments: many connections at once, none reset.
        results, threads = [], []
        for index in range(40):
            thread = threading.Thread(target=lambda: results.append(self.post(b'{"jsonrpc":"2.0","id":1}')))
            threads.append(thread)
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(20)
        self.assertEqual([status for status, _ in results], [200] * 40)
        self.assertGreaterEqual(forwarder.UnixServer.request_queue_size, 64)

    def test_failures_never_carry_the_url_and_a_provider_status_passes_through(self):
        def broken(body):
            raise OSError(f'cannot reach {URL}')
        self.behaviour = broken
        status, payload = self.post(b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')
        self.assertEqual((status, payload), (502, forwarder.UPSTREAM_FAILED))
        self.assertNotIn(b'secret-key', payload)
        self.behaviour = lambda body: (429, b'{"error":"rate limited"}')
        self.assertEqual(self.post(b'{}'), (429, b'{"error":"rate limited"}'))

    def test_an_oversized_body_is_refused_before_it_is_read_or_sent(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as raw:
            raw.settimeout(10)
            raw.connect(self.path)
            raw.sendall(b'POST / HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\n'
                        b'Content-Length: %d\r\n\r\n' % (forwarder.MAX_BODY_BYTES + 1))
            head = raw.recv(64)
        self.assertTrue(head.startswith(b'HTTP/1.1 413 '), head)
        self.assertEqual(self.sent, [])


if __name__ == '__main__':
    unittest.main()
