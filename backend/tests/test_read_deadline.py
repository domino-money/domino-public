from decimal import Decimal
import http.client
import io
from pathlib import Path
import socket
import sys
from threading import Event, Thread
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import (DataError, MAX_RESPONSE_BYTES, ReadRpc, _DeadlineHTTPResponse,
                       _deadline_connect, current_read_deadline, json_http)
from market_cache import MarketCache
from market_data import GeckoMarketData
from read_deadline import check_read_deadline, read_deadline
from read_service import ReadService, bounded_transport
from test_discovery import FakeRpc, POOL, TOKEN
from test_market_data import POOL as MARKET_POOL, pool_response
from test_pool_market import Provider


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class SlowSocket:
    """A deterministic recv stream; each part arrives before an idle timeout."""
    def __init__(self, clock, parts, step=1):
        self.clock, self.parts, self.step = clock, iter(parts), step
        self.timeouts = []
        self.reads = 0
        self.closed = False

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def makefile(self, mode, buffering):
        outer = self

        class Raw(io.RawIOBase):
            def readable(self):
                return True

            def readinto(self, buffer):
                outer.reads += 1
                outer.clock.advance(outer.step)
                part = next(outer.parts, b'')
                buffer[:len(part)] = part
                return len(part)

            def close(self):
                outer.closed = True
                super().close()

        return Raw()


class DeadlineTests(unittest.TestCase):
    def test_nested_context_never_renews_budget_and_restores_outer(self):
        clock = FakeClock()
        with read_deadline(15, clock=clock) as outer:
            clock.advance(5)
            with read_deadline(60) as inner:
                self.assertEqual(inner.remaining(), 10)
                clock.advance(2)
            self.assertIs(current_read_deadline(), outer)
            self.assertEqual(outer.remaining(), 8)
            with read_deadline(2) as shorter:
                self.assertEqual(shorter.remaining(), 2)
        self.assertIsNone(current_read_deadline())

    def test_expired_context_restores_state_and_rejects_late_success(self):
        clock = FakeClock()
        with self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
            with read_deadline(15, clock=clock):
                clock.advance(15)
        self.assertIsNone(current_read_deadline())
        with read_deadline(15, clock=clock):
            check_read_deadline()

    def test_multiple_transports_share_budget_and_do_not_retry(self):
        clock, calls = FakeClock(), []

        def http(url, body=None, *, timeout):
            calls.append(timeout)
            clock.advance(6)
            return {}

        with patch('read_service.json_http', side_effect=http):
            with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                with read_deadline(15, clock=clock):
                    first = bounded_transport()
                    first('https://example.test')
                    second = bounded_transport()
                    second('https://example.test')
                    with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                        first('https://example.test')
                    with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                        second('https://example.test')
        self.assertEqual(calls, [8, 8, 3])

    def test_preexisting_transport_obeys_new_context_and_default_is_sixty_seconds(self):
        clock = FakeClock()
        http = Mock(return_value={})
        with patch('read_deadline.time.monotonic', clock), patch('read_service.json_http', http):
            transport = bounded_transport()
            clock.advance(50)
            transport('https://example.test')
            self.assertEqual(http.call_args.kwargs['timeout'], 8)
            with read_deadline(2, clock=clock):
                transport('https://example.test')
                self.assertEqual(http.call_args.kwargs['timeout'], 2)
            clock.advance(10)
            with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                transport('https://example.test')
            self.assertEqual(http.call_count, 2)

    def test_rpc_timeout_counts_actual_attempt_only_and_stops_following_work(self):
        clock = FakeClock()

        def transport(url, body):
            clock.advance(15)
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x1237'}

        transport = Mock(side_effect=transport)
        rpc = ReadRpc(transport=transport, max_requests=2)
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(15, clock=clock):
                try:
                    rpc.request('eth_chainId')
                finally:
                    with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                        rpc.request('eth_chainId')
        self.assertEqual(rpc.count, 1)
        transport.assert_called_once()

    def test_existing_request_count_budget_is_preserved(self):
        transport = Mock(return_value={'jsonrpc': '2.0', 'id': 1, 'result': '0x1237'})
        with read_deadline(15):
            rpc = ReadRpc(transport=transport, max_requests=1)
            rpc.request('eth_chainId')
            with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
                rpc.request('eth_chainId')
        transport.assert_called_once()

    def test_existing_market_adapter_clamps_to_current_request_budget(self):
        clock = FakeClock()
        transport = Mock(return_value=pool_response())
        provider = GeckoMarketData(transport=transport, clock=lambda: 1010)
        with read_deadline(15, clock=clock):
            clock.advance(13)
            provider.pool(MARKET_POOL)
            self.assertEqual(transport.call_args.kwargs['timeout'], 2)

    def test_market_timeout_prevents_second_provider_call_even_after_stale_fallback(self):
        for prime in (False, True):
            with self.subTest(cached=prime):
                clock = FakeClock()
                provider = Provider()
                cache = MarketCache(provider, clock=clock)
                if prime:
                    cache.get('pool', POOL)
                    clock.advance(61)
                original = provider.pool

                def delayed(pool_id):
                    clock.advance(15)
                    original(pool_id)
                    raise DataError('http_503')

                provider.pool = delayed
                service = ReadService(rpc_factory=FakeRpc, clock=lambda: 1010, market_cache=cache)
                with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                    with read_deadline(15, clock=clock):
                        service.pool_market(POOL, include_price_history=True)
                self.assertEqual(provider.calls, ['pool', 'pool'] if prime else ['pool'])

    def test_fresh_cache_hit_does_not_create_a_new_provider_budget(self):
        clock, provider = FakeClock(), Provider()
        cache = MarketCache(provider, clock=clock)
        cache.get('pool', POOL)
        clock.advance(2)
        service = ReadService(rpc_factory=FakeRpc, clock=lambda: 1010, market_cache=cache)
        with read_deadline(15, clock=clock):
            result = service.pool_market(POOL)
            self.assertEqual(result['market']['cache']['status'], 'hit')
            self.assertEqual(provider.calls, ['pool'])

    def test_noncooperative_transport_holds_admission_until_worker_really_exits(self):
        from read_api import ReadGate
        gate = ReadGate(interval=0)
        entered, release, finished = Event(), Event(), Event()
        failures = []

        def transport(url, body):
            entered.set()
            if not release.wait(2):
                raise AssertionError('test coordination timed out')
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x1237'}

        def worker():
            self.assertTrue(gate.enter())
            try:
                with read_deadline(.03):
                    ReadRpc(transport=transport).request('eth_chainId')
            except DataError as error:
                failures.append(str(error))
            finally:
                gate.slot.release()
                finished.set()

        thread = Thread(target=worker)
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertFalse(finished.wait(.06))
            self.assertFalse(gate.enter())
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, ['read_deadline_exceeded'])
        self.assertTrue(gate.enter())
        gate.slot.release()


class JsonTransportTests(unittest.TestCase):
    def parse(self, raw, **kwargs):
        return json_http('https://example.test/private-value',
                         opener=lambda *args, **ignored: io.BytesIO(raw), **kwargs)

    def test_strict_json_preserves_decimal_precision_and_measured_zero(self):
        result = self.parse(b'{"price":0.123456789012345678901,"zero":0,"absent":null}')
        self.assertEqual(result, {'price': Decimal('0.123456789012345678901'), 'zero': 0, 'absent': None})
        self.assertIs(type(result['price']), Decimal)

    def test_nonfinite_duplicate_nested_and_escaped_keys_are_safe_invalid_json(self):
        for raw in (b'NaN', b'{"x":Infinity}', b'[-Infinity]', b'{"x":1,"x":2}',
                    b'{"outer":{"x":1,"x":2}}', b'{"x":1,"\\u0078":2}', b'"\xff"'):
            with self.subTest(raw=raw), self.assertRaisesRegex(DataError, '^invalid_json$'):
                self.parse(raw)

    def test_nonfinite_outgoing_body_is_rejected_before_network(self):
        opener = Mock()
        with self.assertRaisesRegex(DataError, '^invalid_json$'):
            json_http('https://example.test', {'value': float('nan')}, opener=opener)
        opener.assert_not_called()

    def test_credential_header_validation_remains_strict(self):
        for headers in ({'Authorization': 'secret'}, {'x-api-key': 'secret\nvalue'},
                        {'x-api-key': ''}, {'x-api-key': 'a' * 513}):
            opener = Mock()
            with self.subTest(headers=headers), self.assertRaisesRegex(DataError, '^invalid_private_api_header$'):
                json_http('https://example.test', headers=headers, opener=opener)
            opener.assert_not_called()
        opener = Mock(return_value=io.BytesIO(b'{}'))
        json_http('https://example.test', headers={'x-api-key': 'private-secret'}, opener=opener)
        self.assertEqual(opener.call_args.args[0].get_header('X-api-key'), 'private-secret')

    def test_response_byte_bound_is_inclusive_and_read_incrementally(self):
        self.assertEqual(self.parse(b'{}' + b' ' * (MAX_RESPONSE_BYTES - 2)), {})
        with self.assertRaisesRegex(DataError, '^response_too_large$'):
            self.parse(b'{}' + b' ' * (MAX_RESPONSE_BYTES - 1))

    def test_slow_header_bytes_do_not_reset_underlying_socket_timeout(self):
        clock = FakeClock()
        sock = SlowSocket(clock, (bytes([byte]) for byte in b'HTTP/1.1 200 OK\r\n\r\n{}'))

        def opener(*args, **kwargs):
            response = _DeadlineHTTPResponse(sock, deadline=current_read_deadline())
            try:
                response.begin()
                return response
            except Exception:
                response.close()
                raise

        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(4, clock=clock):
                json_http('https://example.test', opener=opener)
        self.assertEqual(sock.timeouts, [4, 3, 2, 1])
        self.assertEqual(sock.reads, 4)
        self.assertTrue(sock.closed)

    def test_slow_chunk_framing_and_body_share_header_deadline(self):
        clock = FakeClock()
        sock = SlowSocket(clock, [b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
                                  b'1\r\n', b'{', b'\r\n', b'1\r\n', b'}', b'\r\n0\r\n\r\n'])

        def opener(*args, **kwargs):
            response = _DeadlineHTTPResponse(sock, deadline=current_read_deadline())
            response.begin()
            return response

        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(5, clock=clock):
                json_http('https://example.test', opener=opener)
        self.assertEqual(sock.timeouts, [5, 4, 3, 2, 1])
        self.assertTrue(sock.closed)

    def test_real_socket_body_wait_is_clamped_and_closed_without_background_worker(self):
        client, server = socket.socketpair()
        server.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n')

        def opener(*args, **kwargs):
            response = _DeadlineHTTPResponse(client, deadline=current_read_deadline())
            response.begin()
            client.close()  # urllib releases the connection while its file remains open.
            return response

        started = time.monotonic()
        try:
            with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                with read_deadline(.04):
                    json_http('https://example.test', opener=opener)
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(client.fileno(), -1)
        finally:
            client.close()
            server.close()

    def test_resolved_addresses_share_one_connect_budget_and_close_failed_sockets(self):
        clock, timeouts = FakeClock(), []
        connections = []

        def make_socket(*args):
            connection = Mock()
            connection.settimeout.side_effect = timeouts.append

            def connect(target):
                clock.advance(3)
                raise TimeoutError('private address')

            connection.connect.side_effect = connect
            connections.append(connection)
            return connection

        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('127.0.0.1', 443))] * 3
        with patch('discovery.socket.getaddrinfo', return_value=addresses), \
                patch('discovery.socket.socket', side_effect=make_socket):
            with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                with read_deadline(5, clock=clock) as deadline:
                    _deadline_connect(('example.test', 443), 12, deadline=deadline)
        self.assertEqual(timeouts, [5, 2])
        self.assertEqual(len(connections), 2)
        for connection in connections:
            connection.close.assert_called_once()

    def test_malformed_http_status_does_not_leak_upstream_text(self):
        def opener(*args, **kwargs):
            raise http.client.BadStatusLine('private provider URL and credential')
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            json_http('https://example.test', opener=opener)


if __name__ == '__main__':
    unittest.main()
