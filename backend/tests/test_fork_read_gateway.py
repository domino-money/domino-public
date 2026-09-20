"""Offline transport and loopback tests; no provider credentials or chain writes."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
from decimal import Decimal
from http.client import HTTPConnection, HTTPResponse
from io import BytesIO, StringIO
import json
import socket
from threading import Event, Lock, Timer
from types import SimpleNamespace
import time
import traceback
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import urlsplit

from discovery import DataError, json_http
from fork_read_gateway import (ForkReadError, ForkReadGateway, MAX_BATCH, MAX_BODY,
                               MAX_CALL_GAS, MAX_RESPONSE, METHODS, _Handler)


CANARY = 'SYNTHETIC_PRIVATE_CANARY'
ENDPOINT = 'https://robinhood-mainnet.g.alchemy.com/v2/'+CANARY
ADDRESS = '0x'+'12'*20
HASH = '0x'+'34'*32
LOCAL_TOKEN = 'SYNTHETIC_LOCAL_CANARY_0123456789'
LOCAL = 'https://rpc.domino.money/'+LOCAL_TOKEN+'/'
BLOCK = {'number': '0x123', 'hash': HASH, 'timestamp': '0x456'}
MISSING_STATE = {'code': -32000,
    'message': 'missing trie node '+'ab'*32+' (path ) state 0x123 is not available, not found'}


def envelope(method='eth_chainId', params=None, identifier=1):
    return {'jsonrpc': '2.0', 'id': identifier, 'method': method,
            'params': [] if params is None else params}


class Transport:
    def __init__(self, callback=None):
        self.calls, self.lock, self.callback = [], Lock(), callback

    def __call__(self, endpoint, request, **options):
        with self.lock:
            self.calls.append((endpoint, request, options))
        if self.callback:
            return self.callback(request)
        return {'jsonrpc': '2.0', 'id': request['id'], 'result': '0x1237'}


class RoutedTransport:
    def __init__(self, callback=None):
        self.calls, self.callback = [], callback

    def __call__(self, endpoint, request, **options):
        self.calls.append((endpoint, request, options))
        if self.callback:
            result = self.callback(endpoint, request)
            if result is not None:
                return result
        method = request['method']
        result = ('0x1237' if method == 'eth_chainId' else str(4663) if method == 'net_version' else
                  dict(BLOCK) if method in ('eth_getBlockByNumber', 'eth_getBlockByHash') else '0x1234')
        return {'jsonrpc': '2.0', 'id': request['id'], 'result': result}


class ForkReadGatewayTests(unittest.TestCase):
    def gateway(self, transport=None, **options):
        return ForkReadGateway(ENDPOINT, transport=transport or Transport(), **options)

    def post(self, gateway, value=None, *, body=None, headers=None, path='/', method='POST'):
        parsed = urlsplit(gateway.url)
        connection = HTTPConnection(parsed.hostname, parsed.port, timeout=2)
        if body is None:
            body = json.dumps(envelope() if value is None else value).encode()
        request_headers = {'Content-Type': 'application/json'}
        if headers:
            request_headers.update(headers)
        try:
            connection.request(method, path, body, request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assertSafe(self, value):
        self.assertNotIn(CANARY, str(value))
        self.assertNotIn(ENDPOINT, str(value))

    def assertError(self, code, operation):
        with self.assertRaises(ForkReadError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertSafe(''.join(traceback.format_exception(caught.exception)))

    def test_context_exposes_only_loopback_and_shuts_listener(self):
        transport = Transport()
        gateway = self.gateway(transport)
        self.assertError('fork_not_running', lambda: gateway.url)
        self.assertError('fork_not_running', lambda: gateway.request('eth_chainId'))
        with gateway:
            self.assertTrue(gateway.url.startswith('http://127.0.0.1:'))
            self.assertSafe(gateway.url)
            parsed = urlsplit(gateway.url)
            status, headers, body = self.post(gateway)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {'jsonrpc': '2.0', 'id': 1, 'result': '0x1237'})
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertEqual(headers['Connection'], 'close')
            self.assertEqual(gateway.request('eth_chainId'), '0x1237')
            self.assertEqual(gateway.stats['requests'], 2)
            self.assertEqual(gateway.stats['methods'], {'eth_chainId': 2})
        self.assertTrue(gateway.stats['closed'])
        self.assertSafe(gateway.stats)
        self.assertError('fork_not_running', lambda: gateway.request('eth_chainId'))
        self.assertError('fork_invalid_config', gateway.__enter__)
        with self.assertRaises(OSError):
            socket.create_connection((parsed.hostname, parsed.port), timeout=.2)
        self.assertEqual(len(transport.calls), 2)
        for endpoint, request, options in transport.calls:
            self.assertEqual(endpoint, ENDPOINT)
            self.assertEqual(set(options), {'timeout'})
            self.assertGreater(options['timeout'], 0)
            self.assertLessEqual(options['timeout'], 12)

    def test_all_admitted_methods_have_bounded_canonical_parameters(self):
        cases = {
            'eth_chainId': [], 'net_version': [], 'eth_blockNumber': [],
            'eth_gasPrice': [], 'eth_maxPriorityFeePerGas': [],
            'eth_getBlockByNumber': ['0x123', False],
            'eth_getBlockByHash': [HASH, True],
            'eth_getCode': [ADDRESS, {'blockHash': HASH, 'requireCanonical': True}],
            'eth_getBalance': [ADDRESS, 'latest'],
            'eth_getTransactionCount': [ADDRESS, {'blockNumber': '0x123'}],
            'eth_getStorageAt': [ADDRESS, '0x0', 'latest'],
            'eth_getTransactionByHash': [HASH], 'eth_getTransactionReceipt': [HASH],
            'eth_getProof': [ADDRESS, ['0x0', '0x01'], '0x123'],
            'eth_feeHistory': ['0x400', 'latest', [0, 25.5, 100]],
            'eth_call': [{'to': ADDRESS, 'data': '0x1234'}, 'latest'],
        }
        self.assertEqual(set(cases), METHODS)
        transport = Transport()
        with self.gateway(transport) as gateway:
            for method, params in cases.items():
                with self.subTest(method=method):
                    self.assertEqual(gateway.request(method, params), '0x1237')
            self.assertEqual(gateway.stats['methods'], {method: 1 for method in cases})
        sent_call = transport.calls[-1][1]['params'][0]
        self.assertEqual(sent_call['gas'], hex(MAX_CALL_GAS))
        self.assertNotIn('gas', cases['eth_call'][0], 'Do not mutate caller parameters.')

    def test_writes_signing_debug_and_namespace_extensions_never_forward(self):
        denied = ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction',
                  'personal_sign', 'personal_unlockAccount', 'wallet_sendCalls', 'anvil_setBalance',
                  'anvil_impersonateAccount', 'debug_traceCall', 'trace_call', 'evm_mine',
                  'miner_start', 'admin_addPeer', 'eth_newFilter', 'eth_subscribe',
                  'eth_getLogs', 'eth_estimateGas', 'alchemy_getAssetTransfers', CANARY]
        transport = Transport()
        with self.gateway(transport) as gateway, redirect_stderr(StringIO()) as logs:
            for method in denied:
                with self.subTest(method=method):
                    status, _, body = self.post(gateway, envelope(method))
                    self.assertEqual(status, 400)
                    self.assertEqual(json.loads(body)['error']['message'], 'fork_method_not_allowed')
                    self.assertSafe(body)
            self.assertEqual(gateway.stats['requests'], len(denied))
            self.assertEqual(gateway.stats['methods'], {})
            self.assertSafe(gateway.stats)
            self.assertEqual(logs.getvalue(), '')
        self.assertEqual(transport.calls, [])

    def test_batch_validates_every_item_before_any_forward(self):
        transport = Transport()
        with self.gateway(transport) as gateway:
            status, _, body = self.post(gateway, [envelope(), envelope('eth_sendRawTransaction', ['0x12'], 2)])
            self.assertEqual(status, 400)
            self.assertEqual(transport.calls, [])
            valid = [envelope(identifier=10), envelope('net_version', identifier='anvil_2')]
            status, _, body = self.post(gateway, valid)
            self.assertEqual(status, 200)
            self.assertEqual([result['id'] for result in json.loads(body)], [10, 'anvil_2'])
            self.assertEqual(len(transport.calls), 2)
            for invalid in ([], [envelope() for _ in range(MAX_BATCH+1)]):
                self.assertEqual(self.post(gateway, invalid)[0], 400)
            self.assertEqual(gateway.stats['requests'], 4)

    def test_rejects_ambiguous_envelopes_json_and_notifications(self):
        transport = Transport()
        with self.gateway(transport) as gateway:
            invalid = [envelope(identifier=None), envelope(identifier=True), envelope(identifier=2**53),
                       envelope(identifier='x'*65), envelope(identifier='secret\n'),
                       {**envelope(), 'jsonrpc': '1.0'}, {**envelope(), 'extra': True},
                       {key: value for key, value in envelope().items() if key != 'id'},
                       {**envelope(), 'params': {}}, None, 1, 'data']
            for value in invalid:
                with self.subTest(value=value):
                    status, _, _ = self.post(gateway, body=json.dumps(value).encode())
                    self.assertEqual(status, 400)
            for body in (b'{"jsonrpc":"2.0","id":1,"id":2,"method":"eth_chainId","params":[]}',
                         b'{"jsonrpc":"2.0","id":NaN,"method":"eth_chainId","params":[]}',
                         b'{"jsonrpc":"2.0","id":1e10000,"method":"eth_chainId","params":[]}',
                         b'\xff', b'{', b'['*1001):
                self.assertEqual(self.post(gateway, body=body)[0], 400)
        self.assertEqual(transport.calls, [])

    def test_read_parameters_cannot_request_unbounded_simulation_or_overrides(self):
        transport = Transport()
        invalid = [
            ('eth_chainId', [1]), ('eth_getBalance', [ADDRESS, 'latest', {}]),
            ('eth_getBalance', ['0x12', 'latest']), ('eth_getBlockByNumber', ['latest', 1]),
            ('eth_getStorageAt', [ADDRESS, '0x'+'0'*65, 'latest']),
            ('eth_getProof', [ADDRESS, ['0x0']*129, 'latest']),
            ('eth_feeHistory', ['0x401', 'latest', []]),
            ('eth_feeHistory', ['0x1', 'latest', [50, 1]]),
            ('eth_feeHistory', ['0x1', 'latest', [0]*101]),
            ('eth_feeHistory', ['0x1', 'latest', [True]]),
            ('eth_call', [{'to': ADDRESS}, 'latest', {}]),
            ('eth_call', [{'to': ADDRESS, 'gas': hex(MAX_CALL_GAS+1)}, 'latest']),
            ('eth_call', [{'to': ADDRESS, 'data': '0x1'}, 'latest']),
            ('eth_call', [{'to': ADDRESS, 'data': '0x'+'00'*16385}, 'latest']),
            ('eth_call', [{'to': ADDRESS, 'data': '0x', 'input': '0x'}, 'latest']),
            ('eth_call', [{'data': '0x'}, 'latest']),
            ('eth_call', [{'to': ADDRESS, 'authorizationList': []}, 'latest']),
            ('eth_call', [{'to': ADDRESS}, {'blockNumber': '0x1', 'blockHash': HASH}]),
        ]
        with self.gateway(transport) as gateway:
            for method, params in invalid:
                with self.subTest(method=method, params=str(params)[:150]):
                    self.assertError('fork_invalid_request', lambda: gateway.request(method, params))
        self.assertEqual(transport.calls, [])

    def test_header_path_origin_and_browser_credentials_rejected(self):
        transport = Transport()
        with self.gateway(transport) as gateway, redirect_stderr(StringIO()) as logs:
            for headers in ({'Origin': 'https://attacker.invalid'}, {'Cookie': 'session='+CANARY},
                            {'Authorization': 'Bearer '+CANARY}):
                status, _, body = self.post(gateway, headers=headers)
                self.assertEqual(status, 403)
                self.assertSafe(body)
            for headers in ({'Host': 'attacker.invalid'}, {'Content-Type': 'text/plain'},
                            {'Content-Encoding': 'gzip'}, {'Transfer-Encoding': 'chunked'},
                            {'Content-Length': '-1'}):
                status, _, body = self.post(gateway, headers=headers)
                self.assertEqual(status, 400)
                self.assertSafe(body)
            for path in ('/other', '/?key='+CANARY):
                self.assertEqual(self.post(gateway, path=path)[0], 400)
            for method in ('GET', 'OPTIONS', 'PUT', 'DELETE', CANARY):
                status, _, body = self.post(gateway, method=method)
                self.assertEqual(status, 501)
                self.assertSafe(body)
            self.assertEqual(logs.getvalue(), '')
        self.assertEqual(transport.calls, [])

    def test_duplicate_headers_and_oversized_bodies_reject_before_provider(self):
        transport = Transport()
        with self.gateway(transport) as gateway:
            parsed = urlsplit(gateway.url)
            connection = HTTPConnection(parsed.hostname, parsed.port, timeout=2)
            connection.putrequest('POST', '/')
            connection.putheader('Content-Type', 'application/json')
            connection.putheader('Content-Length', '0')
            connection.putheader('Content-Length', '1')
            connection.endheaders()
            try:
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
            finally:
                connection.close()
            self.assertEqual(self.post(gateway, headers={'Content-Length': str(MAX_BODY+1)})[0], 413)
            self.assertError('fork_body_too_large', lambda: gateway.request('eth_call', ['x'*MAX_BODY]))
        self.assertEqual(transport.calls, [])

    def test_request_budget_shared_between_http_direct_and_failed_calls(self):
        transport = Transport(lambda _: (_ for _ in ()).throw(RuntimeError(CANARY)))
        with self.gateway(transport, max_requests=3) as gateway:
            self.assertError('fork_method_not_allowed', lambda: gateway.request('eth_sendTransaction'))
            self.assertError('fork_upstream_unavailable', lambda: gateway.request('eth_chainId'))
            self.assertEqual(self.post(gateway)[0], 400)
            self.assertEqual(self.post(gateway)[0], 503)
            self.assertError('fork_request_limit', lambda: gateway.request('eth_chainId'))
            self.assertEqual(gateway.stats['requests'], 3)
            self.assertEqual(gateway.stats['methods'], {'eth_chainId': 2})
            self.assertSafe(gateway.stats)
        self.assertEqual(len(transport.calls), 2, 'Neither retries nor failed-call refunds are permitted.')

    def test_batch_quota_reserved_atomically(self):
        transport = Transport()
        with self.gateway(transport, max_requests=2) as gateway:
            self.assertEqual(self.post(gateway, [envelope(), envelope(identifier=2), envelope(identifier=3)])[0], 503)
            self.assertEqual(gateway.stats['requests'], 0)
            self.assertEqual(transport.calls, [])
            self.assertEqual(self.post(gateway, [envelope(), envelope(identifier=2)])[0], 200)
            self.assertEqual(gateway.stats['requests'], 2)

    def test_deadline_blocks_new_reads_and_late_delivery(self):
        now = [100.0]
        transport = Transport()
        with self.gateway(transport, clock=lambda: now[0], total_seconds=2) as gateway:
            gateway.request('eth_chainId')
            now[0] += 3
            self.assertError('fork_time_limit', lambda: gateway.request('eth_chainId'))
        self.assertEqual(len(transport.calls), 1)

        def delayed(request):
            now[0] += 3
            return {'jsonrpc': '2.0', 'id': request['id'], 'result': '0x1'}
        with self.gateway(Transport(delayed), clock=lambda: now[0], total_seconds=2) as gateway:
            self.assertError('fork_time_limit', lambda: gateway.request('eth_chainId'))

    def test_upstream_errors_redirects_and_secret_results_never_escape(self):
        def throwing(request):
            raise RuntimeError('provider diagnostic '+ENDPOINT)

        def redirect_opener(request, timeout):
            error = HTTPError(ENDPOINT, 302, CANARY, {'Location': 'https://attacker.invalid/'+CANARY}, None)
            error.close()
            raise error

        callbacks = [throwing,
            lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32000, 'message': ENDPOINT, 'data': CANARY}},
            lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'result': ENDPOINT},
            lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'result': {'nested': CANARY}},
        ]
        for callback in callbacks:
            transport = Transport(callback)
            with self.gateway(transport) as gateway, redirect_stderr(StringIO()) as logs:
                status, _, body = self.post(gateway)
                self.assertEqual(status, 400)
                self.assertSafe(body)
                self.assertSafe(gateway.stats)
                self.assertEqual(logs.getvalue(), '')
            self.assertEqual(len(transport.calls), 1)
        attempts = []

        def no_network_transport(endpoint, request, **options):
            attempts.append(1)
            return json_http(endpoint, request, opener=redirect_opener, **options)
        with self.gateway(no_network_transport) as gateway:
            self.assertError('fork_upstream_unavailable', lambda: gateway.request('eth_chainId'))
        self.assertEqual(len(attempts), 1)

    def test_wrong_envelope_oversized_and_nonfinite_upstream_are_not_delivered(self):
        responses = [None, [], {'jsonrpc': '1.0', 'id': 1, 'result': '0x1'},
                     {'jsonrpc': '2.0', 'id': True, 'result': '0x1'},
                     {'jsonrpc': '2.0', 'id': 2, 'result': '0x1'},
                     {'jsonrpc': '2.0', 'id': 1, 'result': '0x1', 'extra': True},
                     {'jsonrpc': '2.0', 'id': 1, 'result': float('nan')},
                     {'jsonrpc': '2.0', 'id': 1, 'result': 'x'*MAX_RESPONSE}]
        for result in responses:
            with self.subTest(shape=type(result).__name__):
                transport = Transport(lambda request: result)
                with self.gateway(transport) as gateway:
                    status, _, body = self.post(gateway)
                    self.assertEqual(status, 400)
                    self.assertNotIn(b'"result"', body)
                    self.assertSafe(body)

    def test_decimal_ratios_supported_and_total_batch_response_bounded(self):
        transport = Transport(lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'result': {'gasUsedRatio': [Decimal('.25')]}})
        with self.gateway(transport) as gateway:
            self.assertEqual(gateway.request('eth_feeHistory', ['0x1', 'latest', []]), {'gasUsedRatio': [.25]})
        transport = Transport(lambda request: {'jsonrpc': '2.0', 'id': request['id'], 'result': 'x'*1100000})
        with self.gateway(transport) as gateway:
            status, _, body = self.post(gateway, [envelope(identifier=n) for n in range(3)])
            self.assertEqual(status, 400)
            self.assertLess(len(body), 512)
        self.assertEqual(len(transport.calls), 2, 'Stop the batch as soon as its delivery bound is exhausted.')

    def test_inflight_reads_share_capacity_with_http_and_capacity_recovers(self):
        release, occupied = Event(), Event()
        count, lock = [0], Lock()

        def blocked(request):
            with lock:
                count[0] += 1
                if count[0] == 2:
                    occupied.set()
            if not release.wait(2):
                raise RuntimeError('test release timeout')
            return {'jsonrpc': '2.0', 'id': request['id'], 'result': '0x1'}

        transport = Transport(blocked)
        with self.gateway(transport, max_concurrency=2) as gateway, ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(gateway.request, 'eth_chainId') for _ in range(2)]
            try:
                self.assertTrue(occupied.wait(1))
                status, _, body = self.post(gateway)
                self.assertEqual(status, 503)
                self.assertEqual(json.loads(body)['error']['message'], 'fork_capacity_busy')
                self.assertEqual(len(transport.calls), 2)
            finally:
                release.set()
            self.assertEqual([future.result(timeout=1) for future in futures], ['0x1', '0x1'])
            self.assertEqual(gateway.request('eth_chainId'), '0x1')
            self.assertEqual(gateway.stats['requests'], 4)

    def test_upload_socket_timeout_emits_complete_safe_response(self):
        transport = Transport()
        with self.gateway(transport) as gateway:
            # Exercise the actual handler/reply without a competing hard-close
            # timer, so the complete timeout response is deterministic.
            handler = _Handler.__new__(_Handler)
            handler.server = SimpleNamespace(gateway=gateway)
            handler.path = '/'
            handler.headers = {'Host': urlsplit(gateway.url).netloc,
                'Content-Type': 'application/json', 'Content-Length': '100'}
            handler.rfile = Mock()
            handler.rfile.read.side_effect = TimeoutError
            handler.wfile = BytesIO()
            handler.connection = Mock()
            handler.request_version = 'HTTP/1.1'
            handler.requestline = 'POST / HTTP/1.1'
            handler.command = 'POST'
            handler.do_POST()
            head, body = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
            self.assertTrue(head.startswith(b'HTTP/1.1 408 Request Timeout\r\n'))
            self.assertIn(b'Cache-Control: no-store', head)
            self.assertIn(b'Connection: close', head)
            self.assertIn(f'Content-Length: {len(body)}'.encode(), head)
            self.assertEqual(json.loads(body), {'jsonrpc': '2.0', 'id': None,
                'error': {'code': -32000, 'message': 'fork_upload_timeout'}})
            self.assertTrue(handler.close_connection)
            self.assertSafe(body)
            self.assertEqual(transport.calls, [])
            self.assertEqual(gateway.stats['failures']['fork_upload_timeout'], 1)

    def test_absolute_upload_deadline_bounds_idle_connections_and_shutdown(self):
        transport = Transport()
        start = time.monotonic()
        with self.gateway(transport, upload_seconds=.15) as gateway:
            parsed = urlsplit(gateway.url)
            with socket.create_connection((parsed.hostname, parsed.port), timeout=1) as connection:
                # Declared body is never completed. A per-read timeout alone
                # would allow an attacker to reset the deadline by dripping.
                connection.sendall((f'POST / HTTP/1.1\r\nHost: {parsed.netloc}\r\n'
                    'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{').encode())
                received = b''
                while chunk := connection.recv(4096):
                    received += chunk
                    self.assertLess(len(received), 4096)
                # The hard timer can close the socket before, during or after
                # the socket-timeout reply. A partial reply is not a promise
                # of complete HTTP delivery; a complete reply must be exact.
                if received:
                    status = b'HTTP/1.1 408 Request Timeout\r\n'
                    self.assertTrue(status.startswith(received) or received.startswith(status))
                    head, separator, body = received.partition(b'\r\n\r\n')
                    if separator:
                        expected = json.dumps({'jsonrpc': '2.0', 'id': None,
                            'error': {'code': -32000, 'message': 'fork_upload_timeout'}},
                            separators=(',', ':')).encode()
                        self.assertIn(f'Content-Length: {len(expected)}'.encode(), head)
                        self.assertTrue(expected.startswith(body))
                        if len(body) == len(expected):
                            self.assertEqual(json.loads(body), json.loads(expected))
        self.assertLess(time.monotonic()-start, 1)
        self.assertEqual(transport.calls, [])
        self.assertGreaterEqual(gateway.stats['failures'].get('fork_upload_timeout', 0), 1)

    def test_connection_capacity_rejects_before_starting_unbounded_handlers(self):
        transport = Transport()
        with self.gateway(transport, max_concurrency=1, upload_seconds=5) as gateway:
            parsed = urlsplit(gateway.url)
            started = Event()
            process_request_thread = gateway._server.process_request_thread

            def start_handler(*args):
                started.set()
                return process_request_thread(*args)

            with patch.object(gateway._server, 'process_request_thread', side_effect=start_handler) as handlers:
                with socket.create_connection((parsed.hostname, parsed.port), timeout=1) as partial:
                    partial.sendall(b'POST / HTTP/1.1\r\n')
                    self.assertTrue(started.wait(1), 'The first connection must occupy a handler.')
                    # Admission rejects at accept, before reading any request.
                    # A POST upload can race that close and raise BrokenPipeError
                    # before the client reads the valid 503. Send no excess bytes.
                    with socket.create_connection((parsed.hostname, parsed.port), timeout=1) as excess:
                        with HTTPResponse(excess) as response:
                            response.begin()
                            self.assertEqual(response.status, 503)
                            self.assertEqual(response.getheader('Connection'), 'close')
                            self.assertEqual(response.getheader('Content-Length'), '0')
                            self.assertEqual(response.read(), b'')
                    handlers.assert_called_once()
                    self.assertEqual(gateway.stats['failures'].get('fork_capacity_busy'), 1)
                    self.assertEqual(gateway.stats['requests'], 0)
            self.assertEqual(transport.calls, [])

    def test_context_close_waits_for_started_read_then_rejects_further_work(self):
        entered, release = Event(), Event()

        def blocked(request):
            entered.set()
            release.wait(1)
            return {'jsonrpc': '2.0', 'id': request['id'], 'result': '0x1'}

        gateway = self.gateway(Transport(blocked))
        with ThreadPoolExecutor(max_workers=1) as executor:
            with gateway:
                future = executor.submit(self.post, gateway)
                self.assertTrue(entered.wait(1))
                timer = Timer(.1, release.set)
                timer.start()
            timer.join()
            self.assertEqual(future.result(timeout=1)[0], 200)
            self.assertTrue(gateway.stats['closed'])
            self.assertError('fork_not_running', lambda: gateway.request('eth_chainId'))

    def test_invalid_configuration_has_only_fixed_error(self):
        endpoints = ['http://robinhood-mainnet.g.alchemy.com/v2/'+CANARY,
                     ENDPOINT+'?token='+CANARY, ENDPOINT+'#'+CANARY,
                     'https://'+CANARY+'@robinhood-mainnet.g.alchemy.com/v2/key',
                     'https://attacker.invalid/'+CANARY, ENDPOINT+'\n', None]
        for endpoint in endpoints:
            self.assertError('fork_invalid_config', lambda: ForkReadGateway(endpoint, transport=Transport()))
        for options in ({'max_requests': 0}, {'max_requests': True}, {'max_requests': 50001},
                        {'max_concurrency': 9}, {'total_seconds': float('nan')},
                        {'total_seconds': 3601}, {'upload_seconds': 6}):
            self.assertError('fork_invalid_config', lambda: self.gateway(**options))

    def test_ordered_routes_keep_healthy_reads_on_local_and_charge_proofs(self):
        transport = RoutedTransport()
        with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
            self.assertEqual(gateway.request('eth_getStorageAt', [ADDRESS, '0x0', '0x123']), '0x1234')
            self.assertEqual(gateway.request('eth_getBalance', [ADDRESS, '0x123']), '0x1234')
            self.assertEqual([c[1]['method'] for c in transport.calls],
                             ['eth_chainId', 'eth_getBlockByNumber', 'eth_getStorageAt', 'eth_getBalance'])
            self.assertEqual({c[0] for c in transport.calls}, {LOCAL})
            self.assertEqual(gateway.stats['requests'], 4)
            self.assertEqual(sum(gateway.stats['methods'].values()), 4)

    def test_missing_state_fallback_proves_chain_and_exact_block_preserves_id(self):
        cases = [('eth_getCode', [ADDRESS, '0x123']), ('eth_getBalance', [ADDRESS, '0x123']),
                 ('eth_getTransactionCount', [ADDRESS, {'blockNumber': '0x123'}]),
                 ('eth_getStorageAt', [ADDRESS, '0x0', {'blockHash': HASH, 'requireCanonical': True}]),
                 ('eth_getProof', [ADDRESS, ['0x0'], '0x123']),
                 ('eth_call', [{'to': ADDRESS, 'data': '0x1234'}, 'latest'])]
        for method, params in cases:
            with self.subTest(method=method):
                def missing(endpoint, request):
                    if endpoint == LOCAL and request['method'] == method:
                        return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
                transport = RoutedTransport(missing)
                with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
                    response = gateway._handle(envelope(method, params, 'anvil_42'))
                    self.assertEqual(response, {'jsonrpc': '2.0', 'id': 'anvil_42', 'result': '0x1234'})
                    self.assertEqual(gateway.stats['requests'], 6)
                    self.assertEqual([c[1]['method'] for c in transport.calls[-3:]],
                                     ['eth_chainId', 'eth_getBlockByNumber', method])
                    self.assertEqual(transport.calls[-2][1]['params'], ['0x123', False])
                    self.assertEqual(transport.calls[-1][1]['id'], 'anvil_42')
                    expected_tag = params[-1] if type(params[-1]) is dict and 'blockHash' in params[-1] else '0x123'
                    self.assertEqual(transport.calls[-1][1]['params'][-1], expected_tag)
                    gateway.request('eth_getBlockByNumber', ['0x123', False])
                    self.assertEqual(transport.calls[-1][0], LOCAL, 'Fallback must not stick after one missing-state read.')
                    self.assertEqual(gateway.stats['requests'], 7)

    def test_transport_failures_can_fallback_but_other_errors_cannot(self):
        for reason in ('network_unavailable', 'http_429', 'http_503'):
            def unavailable(endpoint, request):
                if endpoint == LOCAL:
                    raise DataError(reason)
            transport = RoutedTransport(unavailable)
            with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
                self.assertEqual(gateway.request('eth_chainId'), '0x1237')
                self.assertEqual(gateway.stats['requests'], 3)
                self.assertEqual([c[0] for c in transport.calls], [LOCAL, ENDPOINT, ENDPOINT])
        for error in ({'code': 3, 'message': 'execution reverted'},
                      {'code': -32000, 'message': 'unrecognized provider refusal'},
                      {**MISSING_STATE, 'data': '0xdeadbeef'}):
            def refused(endpoint, request):
                if request['method'] == 'eth_getCode':
                    return {'jsonrpc': '2.0', 'id': request['id'], 'error': error}
            transport = RoutedTransport(refused)
            with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
                self.assertError('fork_upstream_rpc_error',
                                 lambda: gateway.request('eth_getCode', [ADDRESS, '0x123']))
                self.assertEqual({c[0] for c in transport.calls}, {LOCAL})

    def test_fallback_wrong_chain_or_block_poison_gateway_without_state_delivery(self):
        for mismatch in ('chain', 'block'):
            with self.subTest(mismatch=mismatch):
                def changed(endpoint, request):
                    if endpoint == LOCAL and request['method'] == 'eth_getCode':
                        return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
                    if endpoint == ENDPOINT:
                        if mismatch == 'chain' and request['method'] == 'eth_chainId':
                            return {'jsonrpc': '2.0', 'id': request['id'], 'result': '0x1'}
                        if mismatch == 'block' and request['method'] == 'eth_getBlockByNumber':
                            return {'jsonrpc': '2.0', 'id': request['id'],
                                    'result': {**BLOCK, 'hash': '0x'+'cd'*32}}
                transport = RoutedTransport(changed)
                with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
                    self.assertError('fork_upstream_invalid_response',
                                     lambda: gateway.request('eth_getCode', [ADDRESS, '0x123']))
                    before = len(transport.calls)
                    self.assertError('fork_upstream_invalid_response', lambda: gateway.request('eth_chainId'))
                    self.assertEqual(len(transport.calls), before)
                    self.assertNotIn((ENDPOINT, 'eth_getCode'), [(c[0], c[1]['method']) for c in transport.calls])

    def test_every_fallback_proof_and_attempt_spends_existing_budget(self):
        def missing(endpoint, request):
            if endpoint == LOCAL and request['method'] == 'eth_getCode':
                return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
        transport = RoutedTransport(missing)
        with ForkReadGateway((LOCAL, ENDPOINT), transport=transport, max_requests=5) as gateway:
            self.assertError('fork_request_limit', lambda: gateway.request('eth_getCode', [ADDRESS, '0x123']))
            self.assertEqual(len(transport.calls), 5)
            self.assertEqual(gateway.stats['requests'], 5)
            self.assertEqual(transport.calls[-1][1]['method'], 'eth_getBlockByNumber')

    def test_fallback_verifies_old_state_block_even_with_a_newer_continuity_anchor(self):
        newer = {**BLOCK, 'number': '0x124', 'hash': '0x'+'ab'*32}
        def changed_old_state(endpoint, request):
            method = request['method']
            if method == 'eth_getBlockByNumber' and request['params'][0] == '0x124':
                return {'jsonrpc': '2.0', 'id': request['id'], 'result': newer}
            if endpoint == LOCAL and method == 'eth_getStorageAt':
                return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
            if endpoint == ENDPOINT and method == 'eth_getBlockByNumber' and request['params'][0] == '0x123':
                return {'jsonrpc': '2.0', 'id': request['id'], 'result': {**BLOCK, 'hash': '0x'+'cd'*32}}
        transport = RoutedTransport(changed_old_state)
        with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
            gateway.request('eth_getBlockByNumber', ['0x124', False])
            self.assertError('fork_upstream_invalid_response',
                             lambda: gateway.request('eth_getStorageAt', [ADDRESS, '0x0', '0x123']))
            fallback = [c[1] for c in transport.calls if c[0] == ENDPOINT]
            self.assertEqual([c['method'] for c in fallback],
                             ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber'])
            self.assertEqual([c['params'][0] for c in fallback[1:]], ['0x124', '0x123'])

    def test_fallback_refuses_credential_echo_and_malformed_identity_envelopes(self):
        for value in (LOCAL_TOKEN, CANARY, LOCAL, ENDPOINT, {'malformed': True}):
            with self.subTest(shape=type(value).__name__):
                def fallback_echo(endpoint, request):
                    if endpoint == LOCAL and request['method'] == 'eth_getCode':
                        return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
                    if endpoint == ENDPOINT and request['method'] == 'eth_chainId':
                        return {'jsonrpc': '2.0', 'id': request['id'], 'result': value}
                transport = RoutedTransport(fallback_echo)
                with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway, redirect_stderr(StringIO()) as logs:
                    self.assertError('fork_upstream_invalid_response',
                                     lambda: gateway.request('eth_getCode', [ADDRESS, '0x123']))
                    self.assertEqual(len(transport.calls), 4)
                    self.assertEqual(logs.getvalue(), '')

    def test_fallback_shares_one_call_deadline(self):
        now = [100.0]
        def slow(endpoint, request):
            now[0] += 4
            if endpoint == LOCAL and request['method'] == 'eth_getCode':
                return {'jsonrpc': '2.0', 'id': request['id'], 'error': MISSING_STATE}
        transport = RoutedTransport(slow)
        with ForkReadGateway((LOCAL, ENDPOINT), transport=transport, clock=lambda: now[0]) as gateway:
            self.assertError('fork_time_limit', lambda: gateway.request('eth_getCode', [ADDRESS, '0x123']))
            self.assertEqual(len(transport.calls), 3)
            self.assertEqual({c[0] for c in transport.calls}, {LOCAL})

    def test_routed_malformed_envelopes_and_both_provider_credentials_never_escape(self):
        responses = [lambda r: {'jsonrpc': '2.0', 'id': True, 'result': '0x1237'},
                     lambda r: {'jsonrpc': '2.0', 'id': r['id'], 'result': '0x1237', 'extra': True},
                     lambda r: {'jsonrpc': '2.0', 'id': r['id'], 'result': {'nested': LOCAL_TOKEN}},
                     lambda r: {'jsonrpc': '2.0', 'id': r['id'], 'result': {'nested': CANARY}}]
        for make_response in responses:
            transport = RoutedTransport(lambda endpoint, request: make_response(request))
            with ForkReadGateway((LOCAL, ENDPOINT), transport=transport) as gateway:
                self.assertError('fork_upstream_invalid_response', lambda: gateway.request('eth_chainId'))
                self.assertEqual(len(transport.calls), 1)
                for secret in (LOCAL_TOKEN, CANARY, LOCAL, ENDPOINT):
                    self.assertNotIn(secret, json.dumps(gateway.stats))

    def test_routed_batch_cannot_send_mixed_write_or_exceed_admission_budget(self):
        transport = RoutedTransport()
        with ForkReadGateway((LOCAL, ENDPOINT), transport=transport, max_requests=2) as gateway:
            self.assertError('fork_method_not_allowed', lambda: gateway._handle(
                [envelope(), envelope('eth_sendRawTransaction', ['0x00'], 2)]))
            self.assertEqual(transport.calls, [])
            self.assertEqual(gateway.stats['requests'], 2)


if __name__ == '__main__':
    unittest.main()
