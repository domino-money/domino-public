"""Opt-in ephemeral read-only RPC boundary for a local Anvil qualification fork.

The credential-bearing upstream stays inside this process. Only the ephemeral
loopback URL is given to Anvil. This is neither a product listener nor a signing
proxy; methods, parameters, attempts, time, bytes and concurrent work are bounded.
"""
from copy import deepcopy
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import re
import socket
from threading import BoundedSemaphore, Event, Lock, Thread, Timer
import time
from urllib.parse import urlsplit

from bridge_state import strict_json
from discovery import DataError, json_http
from read_deadline import read_deadline
from rpc_config import DEFAULT_RPC_HOSTS, rpc_endpoint

MAX_BODY = 65536
MAX_RESPONSE = 2000000
MAX_BATCH = 32
CALL_SECONDS = 12
MAX_CALL_GAS = 500000
ZERO_PARAMS = frozenset(('eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas'))
METHODS = ZERO_PARAMS | frozenset(('eth_getBlockByNumber', 'eth_getBlockByHash',
    'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getStorageAt',
    'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'eth_feeHistory', 'eth_getProof'))
ERRORS = frozenset(('fork_invalid_config', 'fork_not_running', 'fork_request_limit', 'fork_time_limit',
    'fork_capacity_busy', 'fork_method_not_allowed', 'fork_invalid_request', 'fork_body_too_large',
    'fork_origin_not_allowed', 'fork_upload_timeout', 'fork_upstream_unavailable',
    'fork_upstream_invalid_response', 'fork_upstream_rpc_error'))
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}\Z')
HASH = re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEX = re.compile(r'0x[0-9a-fA-F]{1,64}\Z')


class ForkReadError(Exception):
    def __init__(self, code):
        self.code = code if code in ERRORS else 'fork_upstream_unavailable'
        super().__init__(self.code)


def _block(value, *, objects=True):
    if isinstance(value, str):
        return value in ('latest', 'earliest', 'pending', 'safe', 'finalized') or bool(HEX.fullmatch(value))
    if objects and type(value) is dict:
        if set(value) == {'blockNumber'}:
            return isinstance(value['blockNumber'], str) and bool(HEX.fullmatch(value['blockNumber']))
        if set(value) in ({'blockHash'}, {'blockHash', 'requireCanonical'}):
            return (isinstance(value['blockHash'], str) and bool(HASH.fullmatch(value['blockHash']))
                    and ('requireCanonical' not in value or type(value['requireCanonical']) is bool))
    return False


def _parameters(method, params):
    try:
        if type(params) is not list:
            raise ValueError()
        if method in ZERO_PARAMS:
            valid = not params
        elif method in ('eth_getTransactionByHash', 'eth_getTransactionReceipt'):
            valid = len(params) == 1 and isinstance(params[0], str) and bool(HASH.fullmatch(params[0]))
        elif method in ('eth_getBlockByNumber', 'eth_getBlockByHash'):
            valid = (len(params) == 2 and type(params[1]) is bool and
                     (_block(params[0], objects=False) if method.endswith('Number') else
                      isinstance(params[0], str) and bool(HASH.fullmatch(params[0]))))
        elif method in ('eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getProof'):
            length = 3 if method in ('eth_getStorageAt', 'eth_getProof') else 2
            valid = (len(params) == length and isinstance(params[0], str) and bool(ADDRESS.fullmatch(params[0]))
                     and _block(params[-1]))
            if valid and method == 'eth_getStorageAt':
                valid = isinstance(params[1], str) and bool(HEX.fullmatch(params[1]))
            if valid and method == 'eth_getProof':
                valid = (type(params[1]) is list and len(params[1]) <= 128 and
                         all(isinstance(key, str) and HEX.fullmatch(key) for key in params[1]))
        elif method == 'eth_feeHistory':
            valid = (len(params) == 3 and isinstance(params[0], str) and bool(HEX.fullmatch(params[0]))
                     and 1 <= int(params[0], 16) <= 1024 and _block(params[1], objects=False)
                     and type(params[2]) is list and len(params[2]) <= 100
                     and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 100 for n in params[2])
                     and params[2] == sorted(params[2]))
        elif method == 'eth_call':
            valid = len(params) == 2 and type(params[0]) is dict and _block(params[1])
            if valid:
                call = params[0]
                allowed = {'to', 'from', 'data', 'input', 'gas', 'value', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'}
                valid = (set(call) <= allowed and isinstance(call.get('to'), str) and ADDRESS.fullmatch(call['to'])
                         and not {'data', 'input'} <= set(call))
                if 'from' in call:
                    valid = valid and isinstance(call['from'], str) and bool(ADDRESS.fullmatch(call['from']))
                for key in ('data', 'input'):
                    if key in call:
                        valid = valid and isinstance(call[key], str) and len(call[key]) <= 32770 and bool(re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', call[key]))
                for key in ('gas', 'value', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas'):
                    if key in call:
                        valid = valid and isinstance(call[key], str) and bool(HEX.fullmatch(call[key]))
                if valid and 'gas' in call:
                    valid = int(call['gas'], 16) <= MAX_CALL_GAS
                if valid:
                    params = deepcopy(params)
                    params[0].setdefault('gas', hex(MAX_CALL_GAS))
        else:
            valid = False
        if not valid:
            raise ValueError()
        return deepcopy(params)
    except (ValueError, TypeError, OverflowError):
        raise ForkReadError('fork_invalid_request') from None


def _envelope(value):
    if type(value) is not dict or set(value) != {'jsonrpc', 'id', 'method', 'params'} or value['jsonrpc'] != '2.0':
        raise ForkReadError('fork_invalid_request')
    identifier = value['id']
    if not (type(identifier) is int and 0 <= identifier < 2**53 or
            type(identifier) is str and bool(re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', identifier))):
        raise ForkReadError('fork_invalid_request')
    if type(value['method']) is not str or value['method'] not in METHODS:
        raise ForkReadError('fork_method_not_allowed')
    return {**value, 'params': _parameters(value['method'], value['params'])}


def _json_default(value):
    if isinstance(value, Decimal) and value.is_finite() and math.isfinite(float(value)):
        return float(value)
    raise ValueError()


class _Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    request_queue_size = 16

    def __init__(self, gateway):
        self.gateway = gateway
        super().__init__(('127.0.0.1', 0), _Handler)

    def process_request(self, request, client_address):
        if not self.gateway._connections.acquire(blocking=False):
            self.gateway._failure('fork_capacity_busy')
            try:
                request.settimeout(.1)
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.gateway._connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.gateway._connections.release()

    def handle_error(self, request, client_address):
        # Socket/provider diagnostics must never enter Anvil's output or logs.
        self.gateway._failure('fork_upstream_unavailable')


class _Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self._uploaded = Event()
        self._upload_expired = Event()
        seconds = min(self.server.gateway.upload_seconds, max(.001, self.server.gateway._remaining()))
        self.connection.settimeout(seconds)
        self._timer = Timer(seconds, self._expire_upload)
        self._timer.daemon = True
        self._timer.start()

    def _expire_upload(self):
        if self._uploaded.is_set():
            return
        self._upload_expired.set()
        self.server.gateway._failure('fork_upload_timeout')
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self._uploaded.set()
        self._timer.cancel()
        try:
            super().finish()
        except OSError:
            pass

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self._reply(code, {'jsonrpc': '2.0', 'id': None,
                           'error': {'code': -32600, 'message': 'fork_invalid_request'}})

    def _reply(self, status, value):
        body = json.dumps(value, allow_nan=False, separators=(',', ':'), default=_json_default).encode()
        self.close_connection = True
        try:
            self.connection.settimeout(1)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def do_POST(self):
        gateway = self.server.gateway
        try:
            if self.path != '/' or self.headers.get('Host') != urlsplit(gateway.url).netloc:
                raise ForkReadError('fork_invalid_request')
            pairs = list(self.headers.items())
            names = [name.lower() for name, _ in pairs]
            if len(names) != len(set(names)) or sum(len(k)+len(v) for k, v in pairs) > 16384:
                raise ForkReadError('fork_invalid_request')
            if any(name in names for name in ('origin', 'cookie', 'authorization')):
                raise ForkReadError('fork_origin_not_allowed')
            if (self.headers.get('Content-Type', '').lower() not in ('application/json', 'application/json; charset=utf-8')
                    or self.headers.get('Content-Encoding', 'identity') != 'identity'
                    or self.headers.get('Transfer-Encoding') is not None):
                raise ForkReadError('fork_invalid_request')
            length = self.headers.get('Content-Length', '')
            if not re.fullmatch(r'(0|[1-9][0-9]{0,9})', length):
                raise ForkReadError('fork_invalid_request')
            if int(length) > MAX_BODY:
                raise ForkReadError('fork_body_too_large')
            raw = self.rfile.read(int(length))
            if len(raw) != int(length):
                raise ForkReadError('fork_upload_timeout' if self._upload_expired.is_set() else 'fork_invalid_request')
            self._uploaded.set()
            self._timer.cancel()
            value = strict_json(raw)
            result = gateway._handle(value)
            self._reply(200, result)
        except TimeoutError:
            gateway._failure('fork_upload_timeout')
            self._reply(408, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32000, 'message': 'fork_upload_timeout'}})
        except (DataError, ValueError, TypeError, RecursionError):
            gateway._failure('fork_invalid_request')
            self._reply(400, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'fork_invalid_request'}})
        except ForkReadError as error:
            gateway._failure(error.code)
            status = 403 if error.code == 'fork_origin_not_allowed' else 408 if error.code == 'fork_upload_timeout' else 413 if error.code == 'fork_body_too_large' else 503 if error.code in ('fork_capacity_busy', 'fork_request_limit', 'fork_not_running') else 504 if error.code == 'fork_time_limit' else 400
            self._reply(status, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32000, 'message': error.code}})
        except Exception:
            gateway._failure('fork_upstream_unavailable')
            self._reply(503, {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32000, 'message': 'fork_upstream_unavailable'}})


class ForkReadGateway:
    def __init__(self, endpoint, *, allowed_hosts=DEFAULT_RPC_HOSTS, transport=json_http,
                 max_requests=5000, total_seconds=1200, max_concurrency=8,
                 upload_seconds=5, clock=time.monotonic):
        try:
            self._endpoint = rpc_endpoint(endpoint, allowed_hosts)
            if (type(max_requests) is not int or not 1 <= max_requests <= 50000
                    or type(max_concurrency) is not int or not 1 <= max_concurrency <= 8
                    or any(type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= maximum
                           for value, maximum in ((total_seconds, 3600), (upload_seconds, 5)))):
                raise ValueError()
        except (DataError, ValueError, TypeError):
            raise ForkReadError('fork_invalid_config') from None
        self._transport, self._clock = transport, clock
        self.max_requests, self.total_seconds, self.upload_seconds = max_requests, total_seconds, upload_seconds
        self._connections, self._reads = BoundedSemaphore(max_concurrency), BoundedSemaphore(max_concurrency)
        self._lock, self._requests, self._methods, self._failures = Lock(), 0, {}, {}
        self._server, self._thread, self._expires, self._closed, self._entered = None, None, None, False, False
        parsed = urlsplit(self._endpoint)
        self._private_markers = (self._endpoint,) + ((parsed.path.rsplit('/', 1)[-1],)
            if parsed.hostname == 'robinhood-mainnet.g.alchemy.com' else ())

    @property
    def url(self):
        if self._server is None:
            raise ForkReadError('fork_not_running')
        return f'http://127.0.0.1:{self._server.server_port}/'

    @property
    def stats(self):
        with self._lock:
            return {'requests': self._requests, 'methods': dict(self._methods),
                    'failures': dict(self._failures), 'closed': self._closed}

    def _failure(self, code):
        code = code if code in ERRORS else 'fork_upstream_unavailable'
        with self._lock:
            self._failures[code] = self._failures.get(code, 0)+1

    def _remaining(self):
        if self._expires is None:
            return 0
        return self._expires-self._clock()

    def _reserve(self, count):
        with self._lock:
            if not self._entered or self._closed:
                raise ForkReadError('fork_not_running')
            if self._remaining() <= 0:
                raise ForkReadError('fork_time_limit')
            if self._requests+count > self.max_requests:
                raise ForkReadError('fork_request_limit')
            self._requests += count

    def _forward(self, request):
        if not self._reads.acquire(blocking=False):
            raise ForkReadError('fork_capacity_busy')
        try:
            with self._lock:
                self._methods[request['method']] = self._methods.get(request['method'], 0)+1
            remaining = min(CALL_SECONDS, self._remaining())
            if remaining <= 0:
                raise ForkReadError('fork_time_limit')
            try:
                with read_deadline(remaining, clock=self._clock):
                    response = self._transport(self._endpoint, request, timeout=remaining)
                    if (type(response) is not dict or response.get('jsonrpc') != '2.0'
                            or type(response.get('id')) is not type(request['id']) or response.get('id') != request['id']
                            or set(response) not in ({'jsonrpc', 'id', 'result'}, {'jsonrpc', 'id', 'error'})):
                        raise ForkReadError('fork_upstream_invalid_response')
                    if 'error' in response:
                        raise ForkReadError('fork_upstream_rpc_error')
                    encoded = json.dumps(response, allow_nan=False, separators=(',', ':'), default=_json_default)
                    if len(encoded.encode()) > MAX_RESPONSE or any(marker in encoded for marker in self._private_markers):
                        raise ForkReadError('fork_upstream_invalid_response')
                    return json.loads(encoded)
            except ForkReadError:
                raise
            except Exception:
                raise ForkReadError('fork_time_limit' if self._remaining() <= 0 else 'fork_upstream_unavailable') from None
        finally:
            self._reads.release()

    def _handle(self, value):
        try:
            raw = json.dumps(value, allow_nan=False, separators=(',', ':')).encode()
        except (ValueError, TypeError, OverflowError, RecursionError):
            raise ForkReadError('fork_invalid_request') from None
        if len(raw) > MAX_BODY:
            raise ForkReadError('fork_body_too_large')
        batch = type(value) is list
        values = value if batch else [value]
        if not 1 <= len(values) <= MAX_BATCH:
            raise ForkReadError('fork_invalid_request')
        self._reserve(len(values))
        requests = [_envelope(item) for item in values]
        # Validate the whole batch before any upstream call; no write is ever
        # forwarded even if mixed with legitimate reads.
        responses, response_bytes = [], 2
        for item in requests:
            response = self._forward(item)
            response_bytes += len(json.dumps(response, separators=(',', ':')).encode())+1
            if response_bytes > MAX_RESPONSE:
                raise ForkReadError('fork_upstream_invalid_response')
            responses.append(response)
        return responses if batch else responses[0]

    def request(self, method, params=None):
        try:
            response = self._handle({'jsonrpc': '2.0', 'id': 1, 'method': method,
                                     'params': [] if params is None else params})
            return response['result']
        except ForkReadError as error:
            self._failure(error.code)
            raise

    def __enter__(self):
        if self._entered:
            raise ForkReadError('fork_invalid_config')
        try:
            self._expires = self._clock()+self.total_seconds
            self._server = _Server(self)
            self._thread = Thread(target=self._server.serve_forever, kwargs={'poll_interval': .05}, daemon=True,
                                  name='domino-fork-read')
            self._entered = True
            self._thread.start()
            return self
        except Exception:
            if self._server is not None:
                self._server.server_close()
            self._closed = True
            raise ForkReadError('fork_invalid_config') from None

    def __exit__(self, *args):
        with self._lock:
            self._closed = True
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1)
        return False
