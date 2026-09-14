"""Authenticated loopback gateway for the fixed, versioned read bridge.

The production launcher is disabled by default and reachable only through a
separately configured Access/Tunnel ingress. No user sessions or transactions.
"""
import asyncio
from copy import deepcopy
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import time
from threading import Event

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge_identity import AccessVerifier
from bridge_state import ClientBudgets, OpaqueCursors, strict_json
from discovery import DataError
from read_api import (AssetsRequest, TokenRequest, PoolsRequest, PoolMarketRequest, NftPositionsRequest,
                      CatalogueRequest, ActivityRequest, MarketsSnapshotRequest, ReadGate)
from bridge_http import LocalReaderHTTP
from read_deadline import read_deadline
from read_contract import CONTRACT_VERSION, validate_response, sanitize_error, ERROR_STATUS_BY_CODE
from pool_apr_contract import (CONTRACT_VERSION as V2_CONTRACT_VERSION,
                               REQUEST_MODELS as V2_REQUEST_MODELS,
                               build_pool_market_estimate)

REQUEST_MODELS = {'token': TokenRequest, 'pools': PoolsRequest, 'pool-market': PoolMarketRequest,
                  'wallet-assets': AssetsRequest, 'nft-positions': NftPositionsRequest,
                  'catalogue': CatalogueRequest, 'pool-activity': ActivityRequest,
                  'pool-positions': ActivityRequest, 'pool-metrics': ActivityRequest,
                  'markets-snapshot': MarketsSnapshotRequest}
MAX_BODY = 8192
MAX_RESPONSE = 1024 * 1024


def safe_error(code):
    """Only the shared finite error contract reaches the edge."""
    return sanitize_error(code)[1]['error']


class Gateway:
    def __init__(self, *, verifier=None, upstream=None, enabled=False, enabled_reads=(),
                 enabled_v2=False, enabled_v2_reads=(), budgets=None, cursors=None,
                 gate=None, clock=time.monotonic, wall_clock=time.time):
        if (type(enabled) is not bool or not set(enabled_reads) <= set(REQUEST_MODELS) or
                type(enabled_v2) is not bool or not set(enabled_v2_reads) <= set(V2_REQUEST_MODELS)):
            raise DataError('invalid_gateway_config')
        if ((enabled and (verifier is None or not enabled_reads)) or
                (enabled_v2 and (verifier is None or not enabled_v2_reads))):
            raise DataError('invalid_gateway_config')
        self.enabled, self.enabled_reads = enabled, frozenset(enabled_reads)
        self.enabled_v2, self.enabled_v2_reads = enabled_v2, frozenset(enabled_v2_reads)
        self.verifier, self.upstream = verifier, upstream or LocalReaderHTTP()
        self.budgets, self.cursors = budgets or ClientBudgets(), cursors or OpaqueCursors()
        self.gate, self.clock, self.wall_clock = gate or ReadGate(), clock, wall_clock

    def execute(self, route, body, assertion, client, deadline, *, version='v1'):
        # Admission was acquired before thread dispatch, on the route's own slot;
        # kind routes the release below to the same slot.
        kind = self.gate.kind_of(route)
        try:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise DataError('upstream_timeout')
            with read_deadline(remaining, clock=self.clock):
                try:
                    self.verifier.verify(assertion)
                except DataError:
                    return 403, {'error': 'upstream_unavailable'}
            if not self.budgets.admit(client):
                return 429, {'error': 'read_capacity_busy'}
            deadline = min(deadline, self.clock() + 15)
            if self.clock() >= deadline:
                raise DataError('upstream_timeout')
            status, health, _ = self.upstream.request('health', deadline=deadline)
            if (status != 200 or not isinstance(health, dict) or
                    health.get('mode') != 'local_read_only' or health.get('status') != 'ok' or
                    type(health.get('readBudgetSeconds')) not in (int, float) or
                    not 0 < health['readBudgetSeconds'] <= 15 or type(health.get('busy')) is not bool):
                raise DataError('upstream_unavailable')
            # A previous HTTP timeout does not prove reader work ended. Reconcile
            # actual reader admission before submitting any new operation.
            if health['busy']:
                return 429, {'error': 'read_capacity_busy'}
            generation = health.get('generation')
            self.cursors.observe_generation(generation)
            sent = deepcopy(body)
            if version == 'v2':
                # One existing read supplies both the table data and estimate.
                # Never fetch a chart or accept metrics/a clock from the caller.
                sent = {'poolId': body['poolId'], 'includePriceHistory': False}
            if route == 'wallet-assets' and sent.get('cursor') is not None:
                sent['cursor'] = self.cursors.unwrap(sent['cursor'], body)
            status, data, metadata = self.upstream.request(route, sent, deadline=deadline)
            if metadata.get('generation') != generation:
                if metadata.get('generation'):
                    self.cursors.observe_generation(metadata['generation'])
                raise DataError('upstream_unavailable')
            if metadata.get('contract') != CONTRACT_VERSION:
                raise DataError('upstream_contract_mismatch')
            if status != 200:
                code = safe_error(data.get('error') if isinstance(data, dict) and set(data) == {'error'} else None)
                expected = ERROR_STATUS_BY_CODE.get(code, 503)
                if status != expected:
                    code, expected = 'upstream_unavailable', 503
                return expected, {'error': code}
            try:
                validate_response(route, data)
            except (ValidationError, ValueError, TypeError):
                raise DataError('upstream_contract_mismatch') from None
            output = deepcopy(data)
            if route == 'wallet-assets' and output['inventory']['nextCursor'] is not None:
                output['inventory']['nextCursor'] = self.cursors.wrap(output['inventory']['nextCursor'], body)
            # The declared cursor substitution is the only payload transformation.
            validate_response(route, output)
            if version == 'v2':
                now = self.wall_clock()
                if type(now) not in (int, float) or not math.isfinite(now):
                    raise DataError('upstream_unavailable')
                try:
                    output = build_pool_market_estimate(output, now=int(now),
                                                       requested_pool_id=body['poolId'])
                except (ValidationError, ValueError, TypeError, OverflowError):
                    raise DataError('upstream_contract_mismatch') from None
            if len(json.dumps(output, allow_nan=False).encode()) > MAX_RESPONSE:
                raise DataError('upstream_invalid_response')
            if self.clock() >= deadline:
                raise DataError('upstream_timeout')
            return 200, output
        except DataError as error:
            code = safe_error(str(error))
            return ERROR_STATUS_BY_CODE.get(code, 503), {'error': code}
        finally:
            # Entire synchronous operation runs in a shielded worker: disconnect is not completion.
            (self.gate.stored_slot if kind == self.gate.STORED else self.gate.slot).release()


def create_gateway(gateway=None):
    gateway = gateway or Gateway()
    app = FastAPI(title='Domino internal read gateway', docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def boundary(request: Request, call_next):
        deadline = gateway.clock() + 20
        request_id = secrets.token_hex(16)
        path = request.scope.get('raw_path', b'').decode('ascii', errors='replace')
        version = 'v2' if path.startswith('/internal/read/v2/') else 'v1'
        def result(status, data):
            headers = {'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
                       'X-Domino-Read-Contract': V2_CONTRACT_VERSION if version == 'v2' else CONTRACT_VERSION,
                       'X-Domino-Request-Id': request_id,
                       'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"}
            if status == 429:
                headers['Retry-After'] = '2'
            return JSONResponse(data, status_code=status, headers=headers)
        models = V2_REQUEST_MODELS if version == 'v2' else REQUEST_MODELS
        match = re.fullmatch(r'/internal/read/' + version + r'/(' + '|'.join(models) + r')', path)
        if not match or request.scope.get('query_string'):
            return result(404, {'error': 'route_not_available'})
        if request.method != 'POST':
            return result(405, {'error': 'method_not_allowed'})
        enabled = gateway.enabled_v2 if version == 'v2' else gateway.enabled
        enabled_reads = gateway.enabled_v2_reads if version == 'v2' else gateway.enabled_reads
        if not enabled or match[1] not in enabled_reads:
            return result(404, {'error': 'route_not_available'})
        headers = {}
        for name, value in request.scope['headers']:
            if name in headers:
                return result(422, {'error': 'invalid_request'})
            headers[name] = value
        if any(name in headers for name in (b'origin', b'authorization')):
            return result(403, {'error': 'origin_not_allowed'})
        cookie = headers.get(b'cookie')
        assertion_header = headers.get(b'cf-access-jwt-assertion', b'')
        # Access can duplicate its service assertion in CF_Authorization. It is
        # transport metadata only: accept exactly that one identical value,
        # never cookie-based authentication or an additional browser cookie.
        # The unchanged verifier below still authenticates the signed header.
        if cookie is not None and (not assertion_header or len(assertion_header) > 8192 or
                not re.fullmatch(rb'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', assertion_header) or
                not hmac.compare_digest(cookie.strip(b' \t'), b'CF_Authorization=' + assertion_header)):
            return result(403, {'error': 'origin_not_allowed'})
        try:
            remote = ipaddress.ip_address(request.client.host)
            if not remote.is_loopback:
                return result(403, {'error': 'origin_not_allowed'})
        except (ValueError, AttributeError):
            return result(403, {'error': 'origin_not_allowed'})
        if headers.get(b'content-type', b'').split(b';')[0].strip().lower() != b'application/json':
            return result(415, {'error': 'json_required'})
        if headers.get(b'content-encoding', b'identity') != b'identity':
            return result(415, {'error': 'json_required'})
        try:
            assertion = headers[b'cf-access-jwt-assertion'].decode('ascii')
            client = headers[b'x-domino-client-id'].decode('ascii')
            if len(assertion) > 8192 or len(client) > 45:
                raise ValueError()
            ipaddress.ip_address(client)
        except (KeyError, ValueError, UnicodeError):
            return result(403, {'error': 'upstream_unavailable'})
        raw = bytearray()
        try:
            async with asyncio.timeout(5):
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw) > MAX_BODY:
                        return result(413, {'error': 'request_too_large'})
            body = strict_json(raw)
            models[match[1]].model_validate(body)
        except TimeoutError:
            return result(408, {'error': 'request_timeout'})
        except (DataError, ValidationError, ValueError, TypeError):
            return result(422, {'error': 'invalid_request'})
        kind = gateway.gate.kind_of(match[1])
        if not gateway.gate.enter(kind):
            return result(429, {'error': 'read_capacity_busy'})
        started = Event()
        def execute():
            started.set()
            if version == 'v2':
                return gateway.execute(match[1], body, assertion, client, deadline, version=version)
            return gateway.execute(match[1], body, assertion, client, deadline)
        try:
            # Only an admitted operation can enter the pool; no pending read queue.
            with anyio.CancelScope(shield=True):
                status, data = await anyio.to_thread.run_sync(execute,
                                                            abandon_on_cancel=False, limiter=app.state.worker_limiter)
            return result(status, data)
        except Exception:
            return result(503, {'error': 'upstream_unavailable'})
        finally:
            # Dispatch failure must release admission; a started worker owns its release.
            if not started.is_set():
                (gateway.gate.stored_slot if kind == gateway.gate.STORED
                 else gateway.gate.slot).release()

    app.state.gateway = gateway
    app.state.worker_limiter = anyio.CapacityLimiter(2)
    return app


def main():
    import argparse
    import fcntl
    from pathlib import Path
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8878)
    parser.add_argument('--reader-port', type=int, default=8876)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--enable-v2', action='store_true', help='Opt in to the separate pool estimate candidate')
    args = parser.parse_args()
    try:
        if args.port in (8765, args.reader_port) or not 1024 <= args.port <= 65535:
            raise DataError('invalid_gateway_port')
        if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY','UVICORN_WORKERS')):
            raise DataError('single_gateway_process_required')
        lock_path = Path(__file__).resolve().parent / 'runtime' / 'read-gateway.lock'
        lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verifier = None
        reads = ()
        v2_reads = ()
        if args.enable or args.enable_v2:
            verifier = AccessVerifier(os.environ.get('DOMINO_ACCESS_ISSUER'),
                                      os.environ.get('DOMINO_ACCESS_AUDIENCE'),
                                      os.environ.get('DOMINO_ACCESS_SERVICE_ID'))
        if args.enable:
            reads = tuple(os.environ.get('DOMINO_BRIDGE_READS', '').split(','))
        if args.enable_v2:
            v2_reads = tuple(os.environ.get('DOMINO_BRIDGE_V2_READS', '').split(','))
        gateway = Gateway(enabled=args.enable, enabled_reads=reads, verifier=verifier,
                          enabled_v2=args.enable_v2, enabled_v2_reads=v2_reads,
                          upstream=LocalReaderHTTP(args.reader_port))
    except (DataError, OSError):
        parser.exit(2, 'Gateway configuration invalid or process already running.\n')
    uvicorn.run(create_gateway(gateway), host='127.0.0.1', port=args.port, workers=1,
                proxy_headers=False, access_log=False, server_header=False, limit_concurrency=16)


if __name__ == '__main__':
    main()
