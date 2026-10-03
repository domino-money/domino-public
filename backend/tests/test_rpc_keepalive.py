"""Kept provider connections: discovery's keep-alive opener against real local sockets."""
from collections import defaultdict, deque
import datetime
import http.client
import http.server
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import socketserver
import ssl
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import discovery
from discovery import (DataError, KEEPALIVE_IDLE_SECONDS, KEEPALIVE_MAX_IDLE, _KeepAlivePool,
                       json_http)
from read_deadline import read_deadline

ANSWER = {'jsonrpc': '2.0', 'id': 1, 'result': '0x1237'}
BODY = {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_blockNumber', 'params': []}


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def until(predicate, seconds=5):
    limit = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > limit:
            raise AssertionError('condition not reached')
        time.sleep(.01)


class Handler(http.server.BaseHTTPRequestHandler):
    """Answers JSON-RPC over HTTP/1.1 keep-alive, one scripted step per request."""
    protocol_version = 'HTTP/1.1'
    timeout = 5

    def answer(self):
        received = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        server = self.server
        with server.lock:
            step = server.script.pop(0) if server.script else {}
            record = {'port': self.client_address[1], 'method': self.command, 'path': self.path,
                      'headers': {name.lower(): value for name, value in self.headers.items()},
                      'body': received, 'started': time.monotonic()}
            server.requests.append(record)
        time.sleep(step.get('delay', 0))
        body = step.get('body', json.dumps(ANSWER).encode())
        try:
            self.send_response(step.get('status', 200))
            self.send_header('Content-Type', 'application/json')
            if step.get('chunked'):
                self.send_header('Transfer-Encoding', 'chunked')
            else:
                self.send_header('Content-Length', str(len(body)))
            if step.get('close'):
                self.send_header('Connection', 'close')
            self.end_headers()
            if step.get('chunked'):
                for start in range(0, len(body), 7):
                    part = body[start:start + 7]
                    self.wfile.write(b'%x\r\n%s\r\n' % (len(part), part))
                self.wfile.write(b'0\r\n\r\n')
            else:
                self.wfile.write(body)
            self.wfile.flush()
        finally:
            # Also when the client already left: on Linux a late answer to a closed
            # connection fails to write, and the request still ended here.
            record['ended'] = time.monotonic()
        # A server that drops a kept connection after answering, without saying so.
        if step.get('drop'):
            self.close_connection = True

    do_GET = do_POST = answer

    def log_message(self, *args):
        pass


class RpcServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, tls=None):
        super().__init__(('127.0.0.1', 0), Handler)
        self.lock, self.script, self.requests = threading.Lock(), [], []
        if tls is not None:
            self.socket = tls.wrap_socket(self.socket, server_side=True)
        self.thread = threading.Thread(target=self.serve_forever, kwargs={'poll_interval': .05}, daemon=True)

    def server_bind(self):
        # No reverse lookup of the loopback name.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = '127.0.0.1', self.server_address[1]

    def handle_error(self, request, client_address):
        # A client that drops a connection with an unread answer resets it; expected here.
        if not isinstance(sys.exc_info()[1], ConnectionError):
            super().handle_error(request, client_address)

    @property
    def key(self):
        return f'127.0.0.1:{self.server_address[1]}'

    @property
    def url(self):
        return f'https://{self.key}/private-token/'

    def ports(self):
        return [request['port'] for request in self.requests]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.shutdown()
        self.server_close()
        self.thread.join(5)


class KeptHTTPConnection(discovery._KeptConnection, discovery._DeadlineHTTPConnection):
    """The pooled connection without TLS, so the pool runs against a local server."""
    def connect(self):
        super().connect()
        self.opened = self.sock


class PeerClosed:
    """A kept connection whose peer closes it as the next request goes out."""
    def __init__(self, error=None):
        self.sock, self.peer = socket.socketpair()
        self.error = error or http.client.RemoteDisconnected('peer closed')
        self.requests = 0

    def lend(self, deadline):
        pass

    def request(self, *args):
        self.requests += 1
        raise self.error

    def close(self):
        if self.sock is not None:
            self.sock.close()
            self.peer.close()
        self.sock = None


class Closable:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def make_pool(**kwargs):
    created = []

    def factory(host, timeout):
        created.append(KeptHTTPConnection(host, timeout=timeout))
        return created[-1]
    pool = _KeepAlivePool(factory, proxies={}, **kwargs)
    pool.created = created
    return pool


def failure(call):
    """The DataError a call raised, with its traceback: the frames' locals stay alive.

    assertRaises clears those frames, which would let garbage collection close a
    socket the code itself left open.
    """
    try:
        call()
    except DataError as error:
        return error
    raise AssertionError('no DataError')


def drain(pool):
    for connections in pool.idle.values():
        for connection, _ in connections:
            connection.close()


def tls_contexts(directory):
    """A throwaway CA and a 127.0.0.1 leaf it signed, as the test's only trust anchor."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    now = datetime.datetime.now(datetime.timezone.utc)

    def certificate(subject, key, issuer, issuer_key, *, ca):
        builder = (x509.CertificateBuilder()
                   .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
                   .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer)]))
                   .public_key(key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - datetime.timedelta(minutes=5))
                   .not_valid_after(now + datetime.timedelta(hours=1))
                   .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
                   .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
                   .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()),
                                  critical=False))
        if ca:
            builder = builder.add_extension(x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False,
                decipher_only=False), critical=True)
        else:
            builder = (builder.add_extension(x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False))
        return builder.sign(issuer_key, hashes.SHA256())

    ca_key, leaf_key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca = certificate('keep-alive test CA', ca_key, 'keep-alive test CA', ca_key, ca=True)
    leaf = certificate('127.0.0.1', leaf_key, 'keep-alive test CA', ca_key, ca=False)
    chain, key = Path(directory) / 'leaf.pem', Path(directory) / 'leaf.key'
    chain.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(chain, key)
    server.set_alpn_protocols(['h2', 'http/1.1'])
    # Production's own context, trusting only this CA instead of the system store.
    client = discovery._keepalive_tls(cadata=ca.public_bytes(serialization.Encoding.PEM).decode())
    return server, client


class KeepAliveTests(unittest.TestCase):
    def pool(self, **kwargs):
        pool = make_pool(**kwargs)
        self.addCleanup(drain, pool)
        return pool

    def test_calls_share_one_connection_and_never_ask_to_close_it(self):
        with RpcServer() as server:
            server.script = [{}, {'chunked': True}, {}, {}]
            pool = self.pool()
            for _ in range(3):
                self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertEqual(json_http(server.url, opener=pool.open), ANSWER)
            self.assertEqual(len(pool.created), 1)
            self.assertEqual(len(set(server.ports())), 1)
            self.assertEqual([r['method'] for r in server.requests], ['POST'] * 3 + ['GET'])
            for request in server.requests:
                self.assertEqual(request['path'], '/private-token/')
                self.assertNotIn('connection', request['headers'])
                self.assertEqual(request['headers']['host'], server.key)
                self.assertEqual(request['headers']['user-agent'], 'DominoReadOnlyDiscovery/0.1')
            self.assertEqual(server.requests[0]['body'], json.dumps(BODY).encode())
            self.assertEqual(server.requests[0]['headers']['content-type'], 'application/json')
            self.assertEqual(server.requests[3]['body'], b'')
            self.assertEqual(len(pool.idle[server.key]), 1)
            json_http(server.url, BODY, headers={'x-api-key': 'private-secret'}, opener=pool.open)
            self.assertEqual(server.requests[4]['headers']['x-api-key'], 'private-secret')

    def test_connection_the_server_closed_while_idle_is_dropped_before_use(self):
        with RpcServer() as server:
            server.script = [{'drop': True}]
            pool = self.pool()
            json_http(server.url, BODY, opener=pool.open)
            kept = pool.idle[server.key][-1][0]
            until(lambda: discovery._readable(kept.sock))
            self.assertEqual(pool.checkout(server.key), (None, False))
            self.assertEqual(kept.opened.fileno(), -1)
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertEqual(len(server.requests), 2)
            self.assertEqual(len(set(server.ports())), 2)

    def test_peer_closing_a_kept_connection_costs_one_new_connection(self):
        for error in (http.client.RemoteDisconnected('closed'), ConnectionResetError('reset'),
                      BrokenPipeError('pipe'), ssl.SSLEOFError('eof'), ssl.SSLZeroReturnError('zero')):
            with self.subTest(error=type(error).__name__), RpcServer() as server:
                pool = self.pool()
                stale = PeerClosed(error)
                pool.checkin(server.key, stale)
                self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
                self.assertEqual(stale.requests, 1)
                self.assertIsNone(stale.sock)
                self.assertEqual(len(pool.created), 1)
                self.assertEqual(len(server.requests), 1)
                self.assertIs(pool.idle[server.key][-1][0], pool.created[0])

    def test_retry_is_once_and_never_on_another_kept_connection(self):
        pool = self.pool()
        key = '127.0.0.1:9'
        first, second = PeerClosed(), PeerClosed()
        pool.checkin(key, second)
        pool.checkin(key, first)
        fresh = PeerClosed(ConnectionResetError('reset'))
        pool.factory = Mock(side_effect=[fresh, AssertionError('a second new connection')])
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            json_http(f'https://{key}/private-token/', BODY, opener=pool.open)
        self.assertEqual((first.requests, fresh.requests, second.requests), (1, 1, 0))
        self.assertIsNone(fresh.sock)
        self.assertEqual([connection for connection, _ in pool.idle[key]], [second])
        second.close()

    def test_failure_other_than_a_closed_peer_is_never_retried(self):
        pool = self.pool()
        key = '127.0.0.1:9'
        kept = PeerClosed(TimeoutError('slow'))
        pool.checkin(key, kept)
        pool.factory = Mock(side_effect=AssertionError('a new connection'))
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            json_http(f'https://{key}/private-token/', BODY, opener=pool.open)
        self.assertEqual(kept.requests, 1)
        self.assertIsNone(kept.sock)
        pool.factory.assert_not_called()

    def test_kept_connection_carries_no_budget_from_its_previous_call(self):
        with RpcServer() as server:
            pool = self.pool()
            with read_deadline(.3):
                json_http(server.url, BODY, opener=pool.open)
            time.sleep(.4)
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertEqual(len(pool.created), 1)

    def test_kept_connection_obeys_a_shorter_budget_and_is_closed_when_it_expires(self):
        with RpcServer() as server:
            server.script = [{}, {'delay': 1}]
            pool = self.pool()
            json_http(server.url, BODY, opener=pool.open)
            started = time.monotonic()
            with self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
                with read_deadline(.2):
                    json_http(server.url, BODY, opener=pool.open)
            self.assertLess(time.monotonic() - started, .9)
            self.assertEqual(pool.created[0].opened.fileno(), -1)
            self.assertFalse(pool.idle[server.key])
            until(lambda: len(server.requests) == 2 and 'ended' in server.requests[1])
            self.assertEqual(len(pool.created), 1)

    def test_error_status_closes_the_connection_and_names_only_the_status(self):
        with RpcServer() as server:
            server.script = [{}, {'status': 503, 'body': b'private provider detail'}]
            pool = self.pool()
            json_http(server.url, BODY, opener=pool.open)
            with self.assertRaisesRegex(DataError, '^http_503$'):
                json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(pool.created[0].opened.fileno(), -1)
            self.assertFalse(pool.idle[server.key])
            json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(pool.created), 2)

    def test_error_status_the_server_closes_releases_its_socket_at_once(self):
        with RpcServer() as server:
            server.script = [{'status': 429, 'close': True}]
            pool = self.pool()
            error = failure(lambda: json_http(server.url, BODY, opener=pool.open))
            self.assertEqual(str(error), 'http_429')
            self.assertEqual(pool.created[0].opened.fileno(), -1)

    def test_redirect_is_an_error_status_never_followed(self):
        with RpcServer() as server:
            server.script = [{'status': 307}]
            pool = self.pool()
            with self.assertRaisesRegex(DataError, '^http_307$'):
                json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(server.requests), 1)

    def test_oversized_answer_closes_the_connection(self):
        with RpcServer() as server:
            server.script = [{'body': b'{"result":"' + b'1' * 64 + b'"}'}, {}]
            pool = self.pool()
            with self.assertRaisesRegex(DataError, '^response_too_large$'):
                json_http(server.url, BODY, opener=pool.open, max_bytes=16)
            self.assertEqual(pool.created[0].opened.fileno(), -1)
            self.assertFalse(pool.idle.get(server.key))
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)

    def test_oversized_answer_the_server_closes_releases_its_socket_at_once(self):
        with RpcServer() as server:
            server.script = [{'body': b'{"result":"' + b'1' * 64 + b'"}', 'close': True}]
            pool = self.pool()
            error = failure(lambda: json_http(server.url, BODY, opener=pool.open, max_bytes=16))
            self.assertEqual(str(error), 'response_too_large')
            self.assertEqual(pool.created[0].opened.fileno(), -1)

    def test_invalid_json_still_returns_a_complete_exchange_to_the_pool(self):
        with RpcServer() as server:
            server.script = [{'body': b'{"x":1,"x":2}'}]
            pool = self.pool()
            with self.assertRaisesRegex(DataError, '^invalid_json$'):
                json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertEqual(len(pool.created), 1)

    def test_connection_the_server_closes_is_not_kept(self):
        with RpcServer() as server:
            server.script = [{'close': True}]
            pool = self.pool()
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertFalse(pool.idle.get(server.key))
            json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(set(server.ports())), 2)

    def test_idle_connection_expires(self):
        clock = FakeClock()
        with RpcServer() as server:
            pool = self.pool(clock=clock)
            json_http(server.url, BODY, opener=pool.open)
            clock.advance(KEEPALIVE_IDLE_SECONDS)
            json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(pool.created), 1)
            clock.advance(KEEPALIVE_IDLE_SECONDS + .5)
            json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(pool.created), 2)
            self.assertEqual(pool.created[0].opened.fileno(), -1)

    def test_pool_keeps_only_the_newest_connections_within_its_bounds(self):
        clock = FakeClock()
        pool = _KeepAlivePool(proxies={}, clock=clock)
        connections = [Closable() for _ in range(KEEPALIVE_MAX_IDLE + 2)]
        for connection in connections:
            pool.checkin('host', connection)
        self.assertEqual([c.closed for c in connections], [True, True] + [False] * KEEPALIVE_MAX_IDLE)
        self.assertEqual([c for c, _ in pool.idle['host']], connections[2:])
        clock.advance(KEEPALIVE_IDLE_SECONDS + .5)
        late = Closable()
        pool.checkin('host', late)
        self.assertEqual([c for c, _ in pool.idle['host']], [late])
        self.assertTrue(all(c.closed for c in connections))
        self.assertFalse(late.closed)

    def test_concurrent_calls_never_share_a_connection(self):
        with RpcServer() as server:
            server.script = [{'delay': .02}] * 48
            pool = self.pool()
            errors = []

            def worker():
                try:
                    for _ in range(6):
                        json_http(server.url, BODY, opener=pool.open)
                except Exception as error:
                    errors.append(error)
            threads = [threading.Thread(target=worker) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(30)
            self.assertEqual(errors, [])
            self.assertEqual(len(server.requests), 48)
            spans = defaultdict(list)
            for request in server.requests:
                spans[request['port']].append((request['started'], request['ended']))
            for port_spans in spans.values():
                port_spans.sort()
                for (_, ended), (started, _) in zip(port_spans, port_spans[1:]):
                    self.assertLessEqual(ended, started)
            self.assertLessEqual(len(pool.created), 8)

    def test_configured_proxy_keeps_the_urllib_path_unless_the_host_bypasses_it(self):
        fallback = Mock(return_value=io.BytesIO(b'{"via":"proxy"}'))
        with RpcServer() as server, patch.dict(os.environ, {'https_proxy': 'http://proxy.invalid:3128',
                                                            'no_proxy': 'bypass.invalid'}):
            pool = self.pool()
            pool.proxies, pool.fallback = {'https': 'http://proxy.invalid:3128'}, fallback
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), {'via': 'proxy'})
            self.assertEqual(fallback.call_args.args[0].full_url, server.url)
            self.assertEqual(pool.created, [])
            with patch.dict(os.environ, {'no_proxy': '127.0.0.1'}):
                self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            fallback.assert_called_once()
            self.assertEqual(len(server.requests), 1)

    def test_only_https_and_only_inside_a_read_budget(self):
        pool = self.pool()
        with self.assertRaisesRegex(DataError, '^https_endpoint_required$'):
            with read_deadline(1):
                pool.open(urllib.request.Request('http://127.0.0.1:9/'), timeout=1)
        with self.assertRaisesRegex(DataError, '^read_deadline_required$'):
            pool.open(urllib.request.Request('https://127.0.0.1:9/'), timeout=1)
        self.assertEqual(pool.created, [])

    def test_production_opener_keeps_verified_tls_connections(self):
        self.assertIs(discovery.KEEPALIVE_OPENER.__self__, discovery._KEEPALIVE)
        self.assertIs(discovery._KEEPALIVE.fallback, discovery._JSON_OPENER)
        connection = discovery._KEEPALIVE.factory('rpc.domino.money', 1)
        self.assertIsInstance(connection, discovery._KeptHTTPSConnection)
        self.assertIs(connection._context, discovery._KEEPALIVE_TLS)
        self.assertEqual(discovery._KEEPALIVE_TLS.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(discovery._KEEPALIVE_TLS.check_hostname)
        self.assertEqual((discovery._KEEPALIVE.idle_seconds, discovery._KEEPALIVE.max_idle),
                         (KEEPALIVE_IDLE_SECONDS, KEEPALIVE_MAX_IDLE))

    def test_kept_tls_connection_is_reused_and_dropped_once_the_server_closes_it(self):
        try:
            import cryptography  # noqa: F401  (in requirements-api.lock)
        except ImportError:
            self.skipTest('cryptography is not installed')
        with tempfile.TemporaryDirectory() as directory:
            server_tls, client_tls = tls_contexts(directory)
        created = []

        def factory(host, timeout):
            created.append(discovery._KeptHTTPSConnection(host, timeout=timeout, context=client_tls))
            return created[-1]
        pool = _KeepAlivePool(factory, proxies={})
        self.addCleanup(drain, pool)
        with RpcServer(tls=server_tls) as server:
            server.script = [{}, {'drop': True}, {}]
            json_http(server.url, BODY, opener=pool.open)
            json_http(server.url, BODY, opener=pool.open)
            self.assertEqual(len(created), 1)
            self.assertIsInstance(created[0].sock, ssl.SSLSocket)
            self.assertEqual(created[0].sock.selected_alpn_protocol(), 'http/1.1')
            until(lambda: discovery._readable(created[0].sock))
            self.assertEqual(json_http(server.url, BODY, opener=pool.open), ANSWER)
            self.assertEqual(len(created), 2)
            self.assertEqual(len(server.requests), 3)

    @unittest.skipUnless(hasattr(os, 'fork'), 'needs fork')
    def test_forked_child_starts_without_the_parent_connections(self):
        kept, saved = Closable(), discovery._KEEPALIVE.idle
        discovery._KEEPALIVE.idle = {'host': deque([(kept, time.monotonic())])}
        try:
            pid = os.fork()
            if pid == 0:
                os._exit(0 if discovery._KEEPALIVE.idle == {} and kept.closed else 1)
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertIn('host', discovery._KEEPALIVE.idle)
            self.assertFalse(kept.closed)
        finally:
            discovery._KEEPALIVE.idle = saved


if __name__ == '__main__':
    unittest.main()
