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
from bridge_state import ClientBudgets, ClientShares, OpaqueCursors, strict_json
from discovery import DataError
from read_api import (CONNECTION_LIMIT, public_gate, AssetsRequest, TokenRequest, PoolsRequest, PoolMarketRequest, NftPositionsRequest,
                      CatalogueRequest, ActivityRequest, MarketsSnapshotRequest, ReadGate)
from bridge_http import LocalReaderHTTP
from read_deadline import read_deadline
from read_contract import CONTRACT_VERSION, validate_response, sanitize_error, ERROR_STATUS_BY_CODE
import hop_log
from pool_apr_contract import (CONTRACT_VERSION as V2_CONTRACT_VERSION,
                               REQUEST_MODELS as V2_REQUEST_MODELS,
                               build_pool_market_estimate)
from public_data_contract import (CONTRACT_VERSION as V3_CONTRACT_VERSION,
                                  REQUEST_MODELS as V3_REQUEST_MODELS,
                                  validate_response as validate_v3_response,
                                  validate_request_response as validate_v3_request_response)
from sequence_snapshot import (CONTRACT_VERSION as V4_CONTRACT_VERSION,
                               SequenceSnapshotRequest, validate_snapshot_response)
from featured_contract import (CONTRACT_VERSION as V5_CONTRACT_VERSION, FeaturedPoolsRequest,
                               validate_featured_response)
from v2_read_contract import (CONTRACT_VERSION as V6_CONTRACT_VERSION, REQUEST_MODELS as V6_REQUEST_MODELS,
                              validate_v6_request_response, validate_v6_response)

REQUEST_MODELS = {'token': TokenRequest, 'pools': PoolsRequest, 'pool-market': PoolMarketRequest,
                  'wallet-assets': AssetsRequest, 'nft-positions': NftPositionsRequest,
                  'catalogue': CatalogueRequest, 'pool-activity': ActivityRequest,
                  'pool-positions': ActivityRequest, 'pool-metrics': ActivityRequest,
                  'markets-snapshot': MarketsSnapshotRequest}
MAX_BODY = 8192
MAX_RESPONSE = 1024 * 1024
# What one visitor address may ask, per lane of the reader: (burst, reads a minute). 6 Oct 2026: one visitor opening New
# position on the V2 app asked 9 reads within 2 s and 34 within a minute, and the single budget it then shared across
# every route (5, then 30 a minute) refused 18 of his 82 reads. A stored read answers from the reader's own data in
# milliseconds; a provider read pays a node or a market provider, and the reader's provider lane and caches bound what
# it may cost, so it gets less. 2 Nov 2026, public launch: 7 to 10 people on New position behind one shared IPv4 would
# spend a provider budget of 12, then 60 a minute, so it is 30, then 300 a minute.
VISITOR_BUDGETS = {ReadGate.STORED: (30, 240), ReadGate.PROVIDER: (30, 300)}
# How often a read waiting for a stored lane looks again (3 Nov 2026): the gateway's event loop must not block on the
# lane, and a stored read holds one for milliseconds.
LANE_POLL_SECONDS = 0.01


def visitor_share(capacity):
    """The most of a lane one visitor holds at once (bridge_state.ClientShares, F-02): half, so the other half is
    always someone else's. 8 provider and 4 stored reads at once, against a burst of 30 that used to take them all."""
    return max(1, capacity // 2)


def safe_error(code):
    """Only the shared finite error contract reaches the edge."""
    return sanitize_error(code)[1]['error']


def checked_retry_after(value):
    """A whole number of seconds between one and ten, or None: never a guess."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    return value if isinstance(value, int) and 1 <= value <= 10 else None


class Gateway:
    def __init__(self, *, verifier=None, upstream=None, enabled=False, enabled_reads=(),
                 enabled_v2=False, enabled_v2_reads=(), enabled_v3=False, enabled_v3_reads=(), budgets=None, cursors=None,
                 enabled_v4=False, enabled_v4_reads=(), enabled_v5=False, enabled_v5_reads=(), gate=None,
                 enabled_v6=False, enabled_v6_reads=(), clock=time.monotonic, wall_clock=time.time):
        if (type(enabled) is not bool or not set(enabled_reads) <= set(REQUEST_MODELS) or
                type(enabled_v2) is not bool or not set(enabled_v2_reads) <= set(V2_REQUEST_MODELS) or
                type(enabled_v3) is not bool or not set(enabled_v3_reads) <= set(V3_REQUEST_MODELS) or
                type(enabled_v4) is not bool or not set(enabled_v4_reads) <= {'sequence-snapshot'} or
                type(enabled_v5) is not bool or not set(enabled_v5_reads) <= {'featured-pools'} or
                type(enabled_v6) is not bool or not set(enabled_v6_reads) <= set(V6_REQUEST_MODELS)):
            raise DataError('invalid_gateway_config')
        if ((enabled and (verifier is None or not enabled_reads)) or
                (enabled_v2 and (verifier is None or not enabled_v2_reads)) or
                (enabled_v3 and (verifier is None or not enabled_v3_reads)) or
                (enabled_v4 and (verifier is None or not enabled_v4_reads)) or
                (enabled_v5 and (verifier is None or not enabled_v5_reads)) or
                (enabled_v6 and (verifier is None or not enabled_v6_reads))):
            raise DataError('invalid_gateway_config')
        self.enabled, self.enabled_reads = enabled, frozenset(enabled_reads)
        self.enabled_v2, self.enabled_v2_reads = enabled_v2, frozenset(enabled_v2_reads)
        self.enabled_v3, self.enabled_v3_reads = enabled_v3, frozenset(enabled_v3_reads)
        self.enabled_v4, self.enabled_v4_reads = enabled_v4, frozenset(enabled_v4_reads)
        self.enabled_v5, self.enabled_v5_reads = enabled_v5, frozenset(enabled_v5_reads)
        self.enabled_v6, self.enabled_v6_reads = enabled_v6, frozenset(enabled_v6_reads)
        self.verifier, self.upstream = verifier, upstream or LocalReaderHTTP()
        # One budget for every lane when given (the tests' and development's), else a visitor's own per lane.
        self.budgets = budgets or {kind: ClientBudgets(burst=burst, per_minute=per_minute, clock=clock)
                                   for kind, (burst, per_minute) in VISITOR_BUDGETS.items()}
        self.cursors = cursors or OpaqueCursors()
        # The reader's own lanes: the provider lane's capacity and the stored lane
        # (v3, the featured list, the V2 index).
        self.gate = gate or (public_gate() if enabled_v3 or enabled_v5 or enabled_v6 else ReadGate())
        self.shares = {kind: ClientShares(visitor_share(capacity)) for kind, capacity in (
            (ReadGate.PROVIDER, self.gate.provider_capacity), (ReadGate.STORED, self.gate.stored_capacity))}
        self.clock, self.wall_clock = clock, wall_clock

    async def admit(self, kind, client):
        """Take one of this visitor's share of the lane, then the lane: 'admitted', or what refused it.

        A stored read that finds either taken waits for both, up to the gate's
        wait (3 Nov 2026, launch), in the gate's waiting room, holding neither
        meanwhile. A provider read is refused at once, as before. The wait is
        real time, whatever clock the gateway was given.
        """
        shares, waiting = self.shares[kind], False
        until = time.monotonic() + self.gate.wait_seconds(kind)
        try:
            while True:
                if not shares.take(client):
                    refusal = 'visitor_share'
                elif self.gate.enter(kind, wait=False):
                    return 'admitted'
                else:
                    shares.give(client)
                    refusal = 'lane'
                if time.monotonic() >= until or not (waiting or self.gate.queue(kind)):
                    return refusal
                waiting = True
                await anyio.sleep(LANE_POLL_SECONDS)
        finally:
            if waiting:
                self.gate.unqueue(kind)

    def execute(self, route, body, assertion, client, deadline, *, version='v1', request_id=None):
        status, data, _ = self.execute_with_hints(route, body, assertion, client, deadline,
                                                  version=version, request_id=request_id)
        return status, data

    def execute_with_hints(self, route, body, assertion, client, deadline, *, version='v1', request_id=None,
                           acquired_kind=None):
        """Like execute, plus hints the boundary needs for headers: a 429's honest Retry-After."""
        # Admission was acquired before thread dispatch, on the route's own slot;
        # kind routes the release below to the same slot.
        reader_kind = self.gate.kind_of(route, body)
        # Development has one shared worker irrespective of the reader's lane.
        # Release the admission actually acquired, not a newly inferred slot.
        kind = reader_kind if acquired_kind is None else acquired_kind
        try:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise DataError('upstream_timeout')
            with read_deadline(remaining, clock=self.clock):
                try:
                    self.verifier.verify(assertion)
                except DataError:
                    return 403, {'error': 'upstream_unavailable'}, {}
            budget = self.budgets[reader_kind] if isinstance(self.budgets, dict) else self.budgets
            if not budget.admit(client):
                # The budget knows when a token returns; a budget that cannot say
                # (the development lane's principal budget) defers to the gate.
                wait = getattr(budget, 'retry_after', None)
                return 429, {'error': 'read_capacity_busy'}, {
                    'retryAfter': (wait(client) if callable(wait) else None) or self.gate.retry_after(kind)}
            deadline = min(deadline, self.clock() + 15)
            if self.clock() >= deadline:
                raise DataError('upstream_timeout')
            status, health, _ = self.upstream.request('health', deadline=deadline, request_id=request_id)
            if (status != 200 or not isinstance(health, dict) or
                    health.get('mode') != 'local_read_only' or health.get('status') != 'ok' or
                    type(health.get('readBudgetSeconds')) not in (int, float) or
                    not 0 < health['readBudgetSeconds'] <= 15 or type(health.get('busy')) is not bool):
                raise DataError('upstream_unavailable')
            # A previous HTTP timeout does not prove reader work ended. Reconcile
            # the lane this request actually uses; provider work cannot veto a
            # cached response. Older readers omit storedBusy: their own route
            # admission still bounds the operation after this gateway's slot.
            busy_key = 'storedBusy' if reader_kind == self.gate.STORED else 'busy'
            wait_key = 'storedRetryAfterSeconds' if reader_kind == self.gate.STORED else 'retryAfterSeconds'
            reader_busy = health.get(busy_key, False)
            if type(reader_busy) is not bool:
                raise DataError('upstream_unavailable')
            if reader_busy:
                # The reader's own number, or this gate's if the reader gave none.
                return 429, {'error': 'read_capacity_busy'}, {
                    'retryAfter': checked_retry_after(health.get(wait_key)) or self.gate.retry_after(kind)}
            generation = health.get('generation')
            self.cursors.observe_generation(generation)
            sent = deepcopy(body)
            if version == 'v2':
                # One existing read supplies both the table data and estimate.
                # Never fetch a chart or accept metrics/a clock from the caller.
                sent = {'poolId': body['poolId'], 'includePriceHistory': False}
            if route == 'wallet-assets' and sent.get('cursor') is not None:
                sent['cursor'] = self.cursors.unwrap(sent['cursor'], body)
            protocol = {'version': version} if version in ('v3', 'v4', 'v5', 'v6') else {}
            status, data, metadata = self.upstream.request(route, sent, deadline=deadline, request_id=request_id, **protocol)
            if metadata.get('generation') != generation:
                if metadata.get('generation'):
                    self.cursors.observe_generation(metadata['generation'])
                raise DataError('upstream_unavailable')
            producer_contract = {'v6': V6_CONTRACT_VERSION, 'v5': V5_CONTRACT_VERSION, 'v4': V4_CONTRACT_VERSION,
                                 'v3': V3_CONTRACT_VERSION}.get(version, CONTRACT_VERSION)
            validator = {'v6': validate_v6_response, 'v5': validate_featured_response,
                         'v4': validate_snapshot_response, 'v3': validate_v3_response}.get(version, validate_response)
            if metadata.get('contract') != producer_contract:
                raise DataError('upstream_contract_mismatch')
            if status != 200:
                code = safe_error(data.get('error') if isinstance(data, dict) and set(data) == {'error'} else None)
                expected = ERROR_STATUS_BY_CODE.get(code, 503)
                if status != expected:
                    code, expected = 'upstream_unavailable', 503
                hints = {}
                if expected == 429:
                    hints['retryAfter'] = (checked_retry_after(metadata.get('retryAfter'))
                                           or self.gate.retry_after(kind))
                return expected, {'error': code}, hints
            try:
                validator(route, data)
                if version == 'v3':
                    validate_v3_request_response(route, body, data)
                if version == 'v6':
                    validate_v6_request_response(route, body, data)
                if version == 'v4' and (data['owner'] != body['owner'] or data['tokenId'] != body['tokenId']):
                    raise ValueError('snapshot request mismatch')
            except (ValidationError, ValueError, TypeError):
                raise DataError('upstream_contract_mismatch') from None
            output = deepcopy(data)
            if route == 'wallet-assets' and output['inventory']['nextCursor'] is not None:
                output['inventory']['nextCursor'] = self.cursors.wrap(output['inventory']['nextCursor'], body)
            # The declared cursor substitution is the only payload transformation.
            validator(route, output)
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
            return 200, output, {}
        except DataError as error:
            code = safe_error(str(error))
            status = ERROR_STATUS_BY_CODE.get(code, 503)
            hints = {}
            if status == 429:
                # A refusal raised deeper down may know its own wait (the
                # development reader reports one); otherwise this gate's.
                hints['retryAfter'] = (checked_retry_after(getattr(error, 'retry_after', None))
                                       or self.gate.retry_after(kind))
            return status, {'error': code}, hints
        finally:
            # Entire synchronous operation runs in a shielded worker: disconnect is not completion.
            self.gate.leave(kind)


def create_gateway(gateway=None):
    gateway = gateway or Gateway()
    app = FastAPI(title='Domino internal read gateway', docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def boundary(request: Request, call_next):
        try:
            opened = gateway.clock()
            deadline = opened + 20
            request_id = secrets.token_hex(16)
            path = request.scope.get('raw_path', b'').decode('ascii', errors='replace')
            version = ('v6' if path.startswith('/internal/read/v6/') else
                       'v5' if path.startswith('/internal/read/v5/') else
                       'v4' if path.startswith('/internal/read/v4/') else
                       'v3' if path.startswith('/internal/read/v3/') else
                       'v2' if path.startswith('/internal/read/v2/') else 'v1')
            contract_version = {'v1': CONTRACT_VERSION, 'v2': V2_CONTRACT_VERSION, 'v3': V3_CONTRACT_VERSION,
                                'v4': V4_CONTRACT_VERSION, 'v5': V5_CONTRACT_VERSION,
                                'v6': V6_CONTRACT_VERSION}[version]
            route_name = 'unmatched'
            notes = hop_log.open_notes()
            recorded = []
            def record(status, reason=None):
                # The raw path never reaches the record: only a declared route name.
                if recorded:
                    return
                recorded.append(status)
                hop_log.emit(service='read-gateway', requestId=request_id, route=route_name,
                             contractVersion=contract_version,
                             method=request.method, status=status, reason=reason,
                             durationMs=int((gateway.clock() - opened) * 1000),
                             **hop_log.close_notes(notes))
            def result(status, data, retry_after=None):
                record(status, data.get('error') if isinstance(data, dict) else None)
                headers = {'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
                           'X-Domino-Read-Contract': contract_version,
                           'X-Domino-Request-Id': request_id,
                           'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"}
                if status == 429:
                    # The wait a refusal can actually justify: the reader's own,
                    # the client budget's, or this gate's — never a constant.
                    headers['Retry-After'] = str(retry_after or gateway.gate.retry_after(gateway.gate.PROVIDER))
                return JSONResponse(data, status_code=status, headers=headers)
            models = {'v1': REQUEST_MODELS, 'v2': V2_REQUEST_MODELS, 'v3': V3_REQUEST_MODELS,
                      'v4': {'sequence-snapshot': SequenceSnapshotRequest},
                      'v5': {'featured-pools': FeaturedPoolsRequest}, 'v6': V6_REQUEST_MODELS}[version]
            match = re.fullmatch(r'/internal/read/' + version + r'/(' + '|'.join(models) + r')', path)
            if match:
                route_name = match[1]
            if not match or request.scope.get('query_string'):
                return result(404, {'error': 'route_not_available'})
            if request.method != 'POST':
                return result(405, {'error': 'method_not_allowed'})
            enabled = {'v1': gateway.enabled, 'v2': gateway.enabled_v2, 'v3': gateway.enabled_v3,
                       'v4': gateway.enabled_v4, 'v5': gateway.enabled_v5, 'v6': gateway.enabled_v6}[version]
            enabled_reads = {'v1': gateway.enabled_reads, 'v2': gateway.enabled_v2_reads,
                             'v3': gateway.enabled_v3_reads, 'v4': gateway.enabled_v4_reads,
                             'v5': gateway.enabled_v5_reads, 'v6': gateway.enabled_v6_reads}[version]
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
            kind = gateway.gate.kind_of(match[1], body)
            admission = await gateway.admit(kind, client)
            if admission != 'admitted':
                # The record says which refused it: the lane, or this visitor's share of it.
                hop_log.note(gate=kind, admitted=False, limiter=admission)
                return result(429, {'error': 'read_capacity_busy'}, retry_after=gateway.gate.retry_after(kind))
            hop_log.note(gate=kind, admitted=True)
            started = Event()
            def execute():
                started.set()
                if version != 'v1':
                    return gateway.execute_with_hints(match[1], body, assertion, client, deadline,
                                                      version=version, request_id=request_id)
                return gateway.execute_with_hints(match[1], body, assertion, client, deadline, request_id=request_id)
            try:
                # Only an admitted operation can enter the pool; a read waits for a lane before it, never in it.
                with anyio.CancelScope(shield=True):
                    status, data, hints = await anyio.to_thread.run_sync(execute,
                                                                       abandon_on_cancel=False, limiter=app.state.worker_limiter)
                return result(status, data, retry_after=hints.get('retryAfter'))
            except Exception:
                return result(503, {'error': 'upstream_unavailable'})
            finally:
                # Dispatch failure must release admission; a started worker owns its release.
                if not started.is_set():
                    gateway.gate.leave(kind)
                # The share is the visitor's until the work it admitted is over: the shielded worker has returned.
                gateway.shares[kind].give(client)

        except BaseException:
            # A client that vanishes mid-body must still leave a record.
            record(499, "client_disconnected")
            raise
    app.state.gateway = gateway
    # One worker per lane the gate admits, so an admitted read never waits for
    # a worker: 2 matched the one provider and one stored lane of #157, but
    # #238 gave this gateway the reader's 16 + 4 (8 since #432) and left the
    # pool at 2, so 18 admitted reads queued here while the reader had lanes free.
    app.state.worker_limiter = anyio.CapacityLimiter(gateway.gate.provider_capacity
                                                     + gateway.gate.stored_capacity)
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
    parser.add_argument('--enable-v3', action='store_true', help='Opt in to the durable stored public read contract')
    parser.add_argument('--enable-v4', action='store_true', help='Opt in to the fixed sequence snapshot read')
    parser.add_argument('--enable-v5', action='store_true', help='Opt in to the stored featured pools list')
    parser.add_argument('--enable-v6', action='store_true', help='Opt in to the stored Domino V2 wallet reads')
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
        v3_reads = ()
        if args.enable or args.enable_v2 or args.enable_v3 or args.enable_v4 or args.enable_v5 or args.enable_v6:
            verifier = AccessVerifier(os.environ.get('DOMINO_ACCESS_ISSUER'),
                                      os.environ.get('DOMINO_ACCESS_AUDIENCE'),
                                      os.environ.get('DOMINO_ACCESS_SERVICE_ID'))
        if args.enable:
            reads = tuple(os.environ.get('DOMINO_BRIDGE_READS', '').split(','))
        if args.enable_v2:
            v2_reads = tuple(os.environ.get('DOMINO_BRIDGE_V2_READS', '').split(','))
        if args.enable_v3:
            v3_reads = tuple(os.environ.get('DOMINO_BRIDGE_V3_READS', '').split(','))
        v4_reads = tuple(os.environ.get('DOMINO_BRIDGE_V4_READS', '').split(',')) if args.enable_v4 else ()
        v5_reads = tuple(os.environ.get('DOMINO_BRIDGE_V5_READS', '').split(',')) if args.enable_v5 else ()
        v6_reads = tuple(os.environ.get('DOMINO_BRIDGE_V6_READS', '').split(',')) if args.enable_v6 else ()
        gateway = Gateway(enabled=args.enable, enabled_reads=reads, verifier=verifier,
                          enabled_v2=args.enable_v2, enabled_v2_reads=v2_reads,
                          enabled_v3=args.enable_v3, enabled_v3_reads=v3_reads,
                          enabled_v4=args.enable_v4, enabled_v4_reads=v4_reads,
                          enabled_v5=args.enable_v5, enabled_v5_reads=v5_reads,
                          enabled_v6=args.enable_v6, enabled_v6_reads=v6_reads,
                          upstream=LocalReaderHTTP(args.reader_port))
    except (DataError, OSError):
        parser.exit(2, 'Gateway configuration invalid or process already running.\n')
    uvicorn.run(create_gateway(gateway), host='127.0.0.1', port=args.port, workers=1,
                proxy_headers=False, access_log=False, server_header=False, limit_concurrency=CONNECTION_LIMIT)


if __name__ == '__main__':
    main()
