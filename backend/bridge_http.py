"""Fixed loopback reader transport with a deadline on every socket operation.

The optional client is for in-process/synthetic tests. Its blocking operations
are cooperative: late returns are rejected, but cannot be forcibly interrupted.
Production always uses the bounded socket path and creates no worker or queue.
"""
from functools import partial
import http.client
import json
import math
import socket
import time

import httpx

from bridge_state import strict_json
from discovery import DataError, _DeadlineHTTPResponse


from read_contract import ENABLED_READS
from public_data_contract import ENABLED_READS as V3_ENABLED_READS

READ_ROUTES = frozenset(ENABLED_READS)
MAX_RESPONSE = 1024 * 1024
MAX_BODY = 8192
_SENSITIVE_HEADERS = frozenset({'content-type', 'content-encoding', 'content-length',
                                'transfer-encoding', 'x-domino-reader-generation',
                                'x-domino-read-contract'})


class _Budget:
    def __init__(self, deadline, clock):
        if type(deadline) not in (int, float) or not math.isfinite(deadline):
            raise DataError('upstream_timeout')
        self.deadline, self.clock = deadline, clock

    def remaining(self):
        now = self.clock()
        if type(now) not in (int, float) or not math.isfinite(now) or now >= self.deadline:
            raise DataError('upstream_timeout')
        return self.deadline - now


class _LoopbackConnection(http.client.HTTPConnection):
    def __init__(self, port, budget):
        self.budget = budget
        super().__init__('127.0.0.1', port, timeout=min(2, budget.remaining()))
        self.response_class = partial(_DeadlineHTTPResponse, deadline=budget)

    def connect(self):
        remaining = self.budget.remaining()
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            connection.settimeout(min(2, remaining))
            # Numeric AF_INET destination avoids resolver and environment-proxy work.
            connection.connect(('127.0.0.1', self.port))
            connection.settimeout(self.budget.remaining())
            self.sock = connection
        except BaseException:
            connection.close()
            raise

    def send(self, data):
        remaining = self.budget.remaining()
        if self.sock is not None:
            self.sock.settimeout(remaining)
        super().send(data)
        self.budget.remaining()


def _response_headers(items, status):
    headers = {}
    for name, value in items:
        name = name.lower()
        if name in _SENSITIVE_HEADERS and name in headers:
            raise DataError('upstream_invalid_response')
        headers[name] = value
    if (headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json' or
            headers.get('content-encoding', 'identity').strip().lower() != 'identity' or
            300 <= status < 400):
        raise DataError('upstream_invalid_response')
    length = headers.get('content-length')
    encoding = headers.get('transfer-encoding')
    if (length is not None and (not length.isascii() or not length.isdigit() or
                               len(length) > 10 or int(length) > MAX_RESPONSE)):
        raise DataError('upstream_invalid_response')
    if encoding is not None and (encoding.strip().lower() != 'chunked' or length is not None):
        raise DataError('upstream_invalid_response')
    return headers


class LocalReaderHTTP:
    def __init__(self, port=8876, *, client=None, clock=time.monotonic):
        if type(port) is not int or not 1024 <= port <= 65535 or port == 8765:
            raise DataError('invalid_reader_port')
        self.port, self.origin = port, f'http://127.0.0.1:{port}'
        self.client, self.clock = client, clock

    def close(self):
        if self.client is not None:
            self.client.close()

    @staticmethod
    def _request_headers(method, budget, request_id=None):
        headers = {'Accept': 'application/json', 'Accept-Encoding': 'identity', 'Connection': 'close'}
        if request_id is not None:
            # Correlation only: the hop that mints it decides its shape, and the
            # reader re-checks it before recording. Never an identity or a grant.
            headers['X-Domino-Request-Id'] = request_id
        if method == 'POST':
            headers['Content-Type'] = 'application/json'
            headers['X-Domino-Read-Budget-Ms'] = str(
                max(1, min(15000, math.floor(budget.remaining() * 1000) - 50)))
        return headers

    @staticmethod
    def _collect(chunks, budget):
        raw = bytearray()
        iterator = iter(chunks)
        while True:
            budget.remaining()
            try:
                chunk = next(iterator)
            except StopIteration:
                budget.remaining()
                break
            budget.remaining()
            if not isinstance(chunk, bytes) or len(chunk) > MAX_RESPONSE - len(raw):
                raise DataError('upstream_invalid_response')
            raw.extend(chunk)
        return raw

    def _network(self, method, path, payload, budget, request_id=None):
        connection = _LoopbackConnection(self.port, budget)
        try:
            connection.connect()
            headers = self._request_headers(method, budget, request_id)
            connection.request(method, path, body=payload, headers=headers)
            with connection.getresponse() as response:
                budget.remaining()
                received = _response_headers(response.getheaders(), response.status)

                def chunks():
                    size = 0
                    while True:
                        budget.remaining()
                        chunk = response.read1(min(64 * 1024, MAX_RESPONSE + 1 - size))
                        budget.remaining()
                        if not chunk:
                            return
                        size += len(chunk)
                        yield chunk

                return response.status, self._collect(chunks(), budget), received
        finally:
            connection.close()

    def _injected(self, method, path, payload, budget, request_id=None):
        remaining = budget.remaining()
        with self.client.stream(method, self.origin + path, content=payload,
                                headers=self._request_headers(method, budget, request_id), follow_redirects=False,
                                timeout=httpx.Timeout(remaining, connect=min(2, remaining))) as response:
            budget.remaining()
            received = _response_headers(response.headers.multi_items(), response.status_code)
            chunks = (response.content,) if response.is_stream_consumed else response.iter_raw()
            return response.status_code, self._collect(chunks, budget), received

    def request(self, route, body=None, *, deadline, request_id=None, version='v1'):
        routes = READ_ROUTES if version == 'v1' else V3_ENABLED_READS if version == 'v3' else ('sequence-snapshot',) if version == 'v4' else ()
        if (version not in ('v1', 'v3', 'v4') or not isinstance(route, str)
                or (route != 'health' and route not in routes) or route == 'health' and version != 'v1'):
            raise DataError('route_not_available')
        budget = _Budget(deadline, self.clock)
        budget.remaining()
        method = 'GET' if route == 'health' else 'POST'
        path = '/health' if route == 'health' else '/' + version + '/read/' + route
        try:
            payload = None if body is None else json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
            if payload is not None and len(payload) > MAX_BODY:
                raise DataError('invalid_request')
            operation = self._network if self.client is None else self._injected
            status, raw, headers = operation(method, path, payload, budget, request_id)
            budget.remaining()
            try:
                data = strict_json(raw)
            except DataError:
                raise DataError('upstream_invalid_response') from None
            budget.remaining()
            metadata = {'generation': headers.get('x-domino-reader-generation'),
                        'contract': headers.get('x-domino-read-contract')}
            # Only when the reader actually sent one: the gateway relays its
            # number on a 429 and falls back to its own gate otherwise.
            if headers.get('retry-after') is not None:
                metadata['retryAfter'] = headers['retry-after']
            return status, data, metadata
        except (httpx.TimeoutException, TimeoutError):
            raise DataError('upstream_timeout') from None
        except (httpx.HTTPError, OSError, http.client.HTTPException):
            budget.remaining()
            raise DataError('upstream_unavailable') from None
        except DataError:
            raise
        except (ValueError, TypeError):
            raise DataError('invalid_request') from None
