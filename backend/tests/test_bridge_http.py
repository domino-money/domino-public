from contextlib import contextmanager
import http.client
import io
import json
import os
from pathlib import Path
import socket
import sys
from threading import Event, Thread
import time
import unittest
from unittest.mock import Mock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge_http import LocalReaderHTTP, MAX_RESPONSE, READ_ROUTES, _Budget
from discovery import DataError, _DeadlineHTTPResponse
from test_read_deadline import FakeClock, SlowSocket


@contextmanager
def loopback_server(sender):
    """One local socket exchange; no DNS, external providers, retries or daemon."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    listener.settimeout(2)
    stop, received, failures = Event(), [], []

    def serve():
        try:
            with listener.accept()[0] as connection:
                connection.settimeout(1)
                request = bytearray()
                while b'\r\n\r\n' not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        return
                    request.extend(chunk)
                received.append(bytes(request))
                sender(connection, stop)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The deadline intentionally closes the client mid-response.
        except OSError as error:
            if not stop.is_set():
                failures.append(type(error).__name__)
        except Exception as error:
            failures.append(type(error).__name__)

    worker = Thread(target=serve)
    worker.start()
    try:
        yield listener.getsockname()[1], received
    finally:
        stop.set()
        listener.close()
        worker.join(3)
        if worker.is_alive() or failures:
            raise AssertionError('local server did not finish cleanly: ' + repr(failures))


class BridgeHTTPTests(unittest.TestCase):
    def injected(self, handler, *, clock=None):
        client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
        self.addCleanup(client.close)
        return LocalReaderHTTP(client=client, clock=clock or time.monotonic)

    @staticmethod
    def response(raw=b'{}', *, status=200, headers=()):
        return httpx.Response(status, content=raw, headers=[('Content-Type', 'application/json'), *headers])

    def test_exact_routes_and_fixed_port_reject_invalid_configuration_before_network(self):
        client = Mock()
        for port in (True, 80, 8765, 65536, '8876'):
            with self.subTest(port=port), self.assertRaisesRegex(DataError, '^invalid_reader_port$'):
                LocalReaderHTTP(port, client=client)
        reader = LocalReaderHTTP(client=client)
        for route in ('../token', 'token?url=https://private.invalid', 'token/extra', 'health?x=1', [], 'execute'):
            with self.subTest(route=route), self.assertRaisesRegex(DataError, '^route_not_available$'):
                reader.request(route, deadline=time.monotonic() + 1)
        client.stream.assert_not_called()

    def test_route_mapping_budget_header_and_only_selected_metadata(self):
        seen = []

        def handler(request):
            seen.append(request)
            return self.response(b'{"zero":0,"absent":null}', headers=[
                ('X-Domino-Reader-Generation', 'a' * 32), ('X-Domino-Read-Contract', '1.0.0'),
                ('Set-Cookie', 'private-value'), ('Location', 'https://private.invalid')])

        clock = FakeClock()
        reader = self.injected(handler, clock=clock)
        for route in sorted(READ_ROUTES):
            result = reader.request(route, {'value': 'exact'}, deadline=110)
            self.assertEqual(result, (200, {'zero': 0, 'absent': None},
                                     {'generation': 'a' * 32, 'contract': '1.0.0'}))
            request = seen[-1]
            self.assertEqual(str(request.url), 'http://127.0.0.1:8876/v1/read/' + route)
            self.assertEqual(request.method, 'POST')
            self.assertEqual(request.headers['X-Domino-Read-Budget-Ms'], '9950')
            self.assertEqual(request.headers['Accept-Encoding'], 'identity')
            self.assertEqual(json.loads(request.content), {'value': 'exact'})
        reader.request('health', deadline=110)
        self.assertEqual(seen[-1].method, 'GET')
        self.assertEqual(seen[-1].url.path, '/health')
        self.assertNotIn('X-Domino-Read-Budget-Ms', seen[-1].headers)

    def test_repeated_reads_use_same_absolute_deadline_without_a_retry(self):
        clock, budgets = FakeClock(), []

        def handler(request):
            budgets.append(request.headers.get('X-Domino-Read-Budget-Ms'))
            clock.advance(6)
            return self.response()

        reader = self.injected(handler, clock=clock)
        reader.request('health', deadline=115)
        reader.request('token', {}, deadline=115)
        with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
            reader.request('token', {}, deadline=115)
        with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
            reader.request('token', {}, deadline=115)
        self.assertEqual(budgets, [None, '8950', '2950'])

    def test_budget_header_has_one_millisecond_floor_and_reader_limit_ceiling(self):
        seen, clock = [], FakeClock()

        def handler(request):
            seen.append(request.headers['X-Domino-Read-Budget-Ms'])
            return self.response()

        reader = self.injected(handler, clock=clock)
        reader.request('token', {}, deadline=100.01)
        reader.request('token', {}, deadline=200)
        self.assertEqual(seen, ['1', '15000'])

    def test_late_eof_and_late_parse_are_rejected(self):
        clock = FakeClock()

        class LateEOF(httpx.SyncByteStream):
            def __iter__(self):
                yield b'{}'
                clock.advance(16)

        reader = self.injected(lambda request: httpx.Response(200, headers={'Content-Type': 'application/json'},
                                                              stream=LateEOF()), clock=clock)
        with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
            reader.request('health', deadline=115)
        reader = self.injected(lambda request: self.response(), clock=clock)

        def late_parse(raw):
            clock.advance(16)
            return {}

        with patch('bridge_http.strict_json', side_effect=late_parse):
            with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
                reader.request('health', deadline=clock() + 15)

    def test_duplicate_nonfinite_malformed_and_encoded_responses_are_sanitized(self):
        for raw in (b'{"x":1,"x":2}', b'{"outer":{"x":NaN}}', b'{"x":1e309}',
                    b'[-Infinity]', b'not-json', b'"\xff"'):
            with self.subTest(raw=raw):
                reader = self.injected(lambda request: self.response(raw))
                with self.assertRaisesRegex(DataError, '^upstream_invalid_response$'):
                    reader.request('health', deadline=time.monotonic() + 1)
        reader = self.injected(lambda request: httpx.Response(200, stream=httpx.ByteStream(b'{}'),
                                headers={'Content-Type': 'application/json', 'Content-Encoding': 'gzip'}))
        with self.assertRaisesRegex(DataError, '^upstream_invalid_response$'):
            reader.request('health', deadline=time.monotonic() + 1)

    def test_response_size_limit_and_ambiguous_headers_fail_closed(self):
        reader = self.injected(lambda request: self.response(b'{}' + b' ' * (MAX_RESPONSE - 2)))
        self.assertEqual(reader.request('health', deadline=time.monotonic() + 2)[1], {})

        class Oversized(httpx.SyncByteStream):
            def __iter__(self):
                yield b' ' * MAX_RESPONSE
                yield b' '

        reader = self.injected(lambda request: httpx.Response(200, headers={'Content-Type': 'application/json'},
                                                              stream=Oversized()))
        with self.assertRaisesRegex(DataError, '^upstream_invalid_response$'):
            reader.request('health', deadline=time.monotonic() + 2)
        for headers in ([('Content-Type', 'text/html')], [('X-Domino-Reader-Generation', 'a'),
                        ('X-Domino-Reader-Generation', 'b')], [('Content-Length', str(MAX_RESPONSE + 1))],
                        [('Transfer-Encoding', 'chunked')]):
            reader = self.injected(lambda request: self.response(headers=headers))
            with self.subTest(headers=headers), self.assertRaisesRegex(DataError, '^upstream_invalid_response$'):
                reader.request('health', deadline=time.monotonic() + 1)

    def test_injected_client_cannot_follow_redirect_even_if_configured_to(self):
        calls = []

        def handler(request):
            calls.append(str(request.url))
            return self.response(status=302, headers=[('Location', 'https://external.invalid')])

        reader = self.injected(handler)
        with self.assertRaisesRegex(DataError, '^upstream_invalid_response$'):
            reader.request('health', deadline=time.monotonic() + 1)
        self.assertEqual(calls, ['http://127.0.0.1:8876/health'])

    def test_errors_and_invalid_outgoing_json_do_not_expose_private_details(self):
        for error, code in ((httpx.ReadTimeout('private credential'), 'upstream_timeout'),
                            (httpx.ConnectError('private credential'), 'upstream_unavailable')):
            def handler(request):
                raise error
            reader = self.injected(handler)
            with self.assertRaisesRegex(DataError, '^' + code + '$'):
                reader.request('health', deadline=time.monotonic() + 1)
        client = Mock()
        reader = LocalReaderHTTP(client=client)
        for body in ({'x': float('nan')}, {'x': 'a' * 8193}):
            with self.assertRaisesRegex(DataError, '^invalid_request$'):
                reader.request('token', body, deadline=time.monotonic() + 1)
        client.stream.assert_not_called()

    def test_real_loopback_sends_fresh_headers_without_dns_or_environment_proxies(self):
        def sender(connection, stop):
            connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                               b'Content-Length: 2\r\nX-Domino-Reader-Generation: aaaa\r\n\r\n{}')

        with loopback_server(sender) as (port, received):
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://external.invalid:1', 'ALL_PROXY': 'http://external.invalid:1'}), \
                    patch('bridge_http.socket.getaddrinfo', side_effect=AssertionError('unexpected DNS')):
                reader = LocalReaderHTTP(port)
                result = reader.request('token', {'token': 'requested-address'}, deadline=time.monotonic() + 2)
                reader.close()
        self.assertEqual(result, (200, {}, {'generation': 'aaaa', 'contract': None}))
        self.assertTrue(received[0].startswith(b'POST /v1/read/token HTTP/1.1\r\n'))
        headers = http.client.parse_headers(io.BytesIO(received[0].split(b'\r\n', 1)[1]))
        self.assertEqual(headers['Host'], f'127.0.0.1:{port}')
        self.assertTrue(1 <= int(headers['X-Domino-Read-Budget-Ms']) <= 1950)
        for forbidden in ('Cookie', 'Origin', 'Authorization', 'Cf-Access-Jwt-Assertion', 'X-Domino-Client-Id'):
            self.assertIsNone(headers[forbidden])

    def test_slow_header_reads_recompute_remaining_socket_timeout(self):
        clock = FakeClock()
        socket_fixture = SlowSocket(clock, (bytes([value]) for value in b'HTTP/1.1 200 OK\r\n\r\n{}'))
        response = _DeadlineHTTPResponse(socket_fixture, deadline=_Budget(104, clock))
        try:
            with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
                response.begin()
        finally:
            response.close()
        self.assertEqual(socket_fixture.timeouts, [4, 3, 2, 1])
        self.assertTrue(socket_fixture.closed)

    def test_real_slow_headers_and_body_cannot_renew_the_request_deadline(self):
        def body(connection, stop):
            connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
                               b'Transfer-Encoding: chunked\r\n\r\n')
            for _ in range(100):
                if stop.wait(.02):
                    return
                connection.sendall(b'1\r\n \r\n')

        def headers(connection, stop):
            for byte in b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}':
                if stop.wait(.02):
                    return
                connection.sendall(bytes([byte]))

        for sender in (headers, body):
            with self.subTest(phase=sender.__name__), loopback_server(sender) as (port, _):
                started = time.monotonic()
                with self.assertRaisesRegex(DataError, '^upstream_timeout$'):
                    LocalReaderHTTP(port).request('health', deadline=started + .1)
                self.assertLess(time.monotonic() - started, 1)


if __name__ == '__main__':
    unittest.main()
