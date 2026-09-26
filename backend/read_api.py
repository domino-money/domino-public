"""Internal loopback API for public chain reads, not authenticated account data."""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import math
import os
import re
import secrets
from threading import BoundedSemaphore, Lock
import time

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints, model_validator
from typing import Annotated, Literal

from discovery import CHAIN_ID, RPC_URL, DataError
from local_config import load_config, configured_rpc_urls
from rpc_config import configured_history_rpc_urls
from catalogue import configured_catalogue
from pool_requests import configured_pool_requests
from read_service import ReadService
from sequence_snapshot import (CONTRACT_VERSION as V4_CONTRACT_VERSION,
                               SequenceSnapshotRequest, validate_snapshot_response)
from read_contract import CONTRACT_VERSION, RESPONSE_MODELS, ErrorResponse, validate_response, sanitize_error, unsigned_string_pattern
from featured_contract import (CONTRACT_VERSION as V5_CONTRACT_VERSION, FeaturedPoolsRequest,
                               FeaturedPoolsResponse, FeaturedReader, validate_featured_response)
from public_data_contract import (CONTRACT_VERSION as V3_CONTRACT_VERSION,
                                  REQUEST_MODELS as V3_REQUEST_MODELS,
                                  RESPONSE_MODELS as V3_RESPONSE_MODELS,
                                  OverviewRequest, HistoryRequest, SearchRequest,
                                  validate_response as validate_v3_response,
                                  validate_request_response as validate_v3_request_response)
import hop_log
from read_deadline import current_read_deadline, read_deadline, read_timeout

Address = Annotated[str, StringConstraints(strict=True, pattern=r'^0x[0-9a-fA-F]{40}$')]
PoolId = Annotated[str, StringConstraints(strict=True, pattern=r'^0x[0-9a-fA-F]{64}$')]


class AssetsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    wallet: Address
    tokens: list[Address] = Field(default_factory=list, max_length=10)
    autoDiscover: StrictBool = True
    cursor: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4096)] | None = None


class TokenRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: Address


class ActivityRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    poolId: PoolId


class PoolMarketRequest(ActivityRequest):
    includePriceHistory: StrictBool = False
    priceToken: Literal['base', 'quote'] = 'base'
    fromSnapshot: StrictBool = False


class MarketsSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    poolIds: list[PoolId] = Field(default_factory=list, max_length=24)


class NftPositionsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    # OpenAPI describes the uint256 bound and uniqueness enforced by valid_ids.
    # ECMAScript $ without m is strict; Python re.search can match before a
    # terminal LF. Keep the extra end guard in schema metadata, not Rust regex.
    tokenIds: list[Annotated[str, StringConstraints(strict=True, pattern=r'^(0|[1-9][0-9]{0,77})$'),
        Field(json_schema_extra={'pattern': unsigned_string_pattern(2**256-1) + r'(?![\s\S])',
                                 'maxLength': 78})]] = Field(min_length=1, max_length=10,
                                                           json_schema_extra={'uniqueItems': True})
    blockNumber: Annotated[StrictInt, Field(ge=0, le=2**53-1)] | None = None

    @model_validator(mode='after')
    def valid_ids(self):
        if len(set(self.tokenIds)) != len(self.tokenIds) or any(int(v) >= 2**256 for v in self.tokenIds):
            raise ValueError('unique uint256 token IDs required')
        return self


class PairRequest(TokenRequest):
    pairedToken: Address | None = None

    @model_validator(mode='after')
    def different_currencies(self):
        if self.pairedToken and self.pairedToken.lower()==self.token.lower():
            raise ValueError('pair currencies must differ')
        return self


class PoolsRequest(PairRequest):
    maxPools: Annotated[StrictInt, Field(ge=1, le=20)] = 12
    poolIds: list[PoolId] = Field(default_factory=list, max_length=10)

    @model_validator(mode='after')
    def ids_fit_budget(self):
        if len(self.poolIds) > self.maxPools:
            raise ValueError('pool IDs exceed request budget')
        return self


class CatalogueRequest(PairRequest):
    limit: Annotated[StrictInt, Field(ge=1,le=100)] = 20
    afterPoolId: PoolId | None = None
    revision: Annotated[StrictInt, Field(ge=0,le=2**53-1)] | None = None

    @model_validator(mode='after')
    def page_has_revision(self):
        if self.afterPoolId and self.revision is None:
            raise ValueError('revision required for pagination')
        return self


class ReadGate:
    """One provider-touching read at a time, plus one stored-data slot.

    Provider reads (chain RPC or market providers) keep the single slot and
    start-interval they always had: their ceilings and the shared deadline
    are per operation, so concurrent expensive reads are not admitted.
    Stored catalogue/snapshot reads get their own bounded slot so a slow
    provider read cannot serialise them. Pool metrics still verify canonicality
    through RPC and therefore belong to the provider lane.
    """

    PROVIDER, STORED = 'provider', 'stored'
    STORED_ROUTES = frozenset({'catalogue', 'markets-snapshot', *V3_REQUEST_MODELS, 'featured-pools'})
    # Admission stays fail-fast with a client backoff, the reviewed design of
    # #157. What it never did was tell the truth about the wait: a constant one
    # second against a slot a six-second read owns sent three visitors opening
    # Home back five times each. A refusal now reports the delay the gate can
    # actually see, so one honest answer replaces a run of hopeful ones.
    MIN_RETRY_AFTER, MAX_RETRY_AFTER = 1, 10
    # The start interval paces a caller and must not punish one pacing itself
    # correctly: a client spacing 1.1 s against a 1 s rule loses to scheduling
    # jitter alone without this tolerance.
    INTERVAL_TOLERANCE = 0.05

    def __init__(self, interval=1, clock=time.monotonic, *, stored_capacity=1, stored_interval=None):
        if type(stored_capacity) is not int or not 1 <= stored_capacity <= 8:
            raise ValueError('invalid_stored_capacity')
        self.slot, self.lock = BoundedSemaphore(1), Lock()
        self.interval, self.clock, self.last = interval, clock, float('-inf')
        self.stored_interval = interval if stored_interval is None else stored_interval
        if type(self.stored_interval) not in (int,float) or not math.isfinite(self.stored_interval) or self.stored_interval < 0:
            raise ValueError('invalid_stored_interval')
        self.stored_capacity,self.stored_inflight = stored_capacity,0
        self.stored_slot, self.stored_last = BoundedSemaphore(stored_capacity), float('-inf')
        self.held = {self.PROVIDER: None, self.STORED: None}

    def kind_of(self, route, body=None):
        """Classify actual work only after the route's request was validated.

        Unknown/new routes conservatively use provider capacity until their
        implementation is proven cache-only. The explicit snapshot variant of
        pool-market never falls back to provider work on a cache miss.
        """
        snapshot = (route == 'pool-market' and isinstance(body, dict)
                    and body.get('fromSnapshot') is True)
        return self.STORED if route in self.STORED_ROUTES or snapshot else self.PROVIDER

    def retry_after(self, kind=PROVIDER):
        """The delay this gate can actually justify, never a hopeful constant.

        Two things can refuse a caller: the slot a read still holds, and the
        start interval. The wait is whichever is further away, and the holder's
        own remaining budget is what bounds the first — an admitted read cannot
        outlive it.
        """
        with self.lock:
            last = self.stored_last if kind == self.STORED else self.last
            started = self.held[kind]
            interval = self.stored_interval if kind == self.STORED else self.interval
            interval_left = interval - (self.clock() - last)
            slot_left = 0.0 if started is None else started[1] - (self.clock() - started[0])
            if kind == self.STORED and self.stored_capacity > 1:
                slot_left = 1 if self.stored_inflight else 0
        return max(self.MIN_RETRY_AFTER,
                   min(self.MAX_RETRY_AFTER, math.ceil(max(interval_left, slot_left))))

    def enter(self, kind=PROVIDER):
        slot = self.stored_slot if kind == self.STORED else self.slot
        if not slot.acquire(blocking=False):
            return False
        with self.lock:
            interval = self.stored_interval if kind == self.STORED else self.interval
            if self.clock() - (self.stored_last if kind == self.STORED
                               else self.last) < interval - self.INTERVAL_TOLERANCE:
                slot.release()
                return False
            if kind == self.STORED:
                self.stored_last = self.clock()
                self.stored_inflight += 1
            else:
                self.last = self.clock()
            # Record when this read started and what it may still spend, so a
            # refused caller is told how long the slot is plausibly taken.
            budget = self.MAX_RETRY_AFTER
            if current_read_deadline() is not None:
                try:
                    budget = read_timeout(self.MAX_RETRY_AFTER)
                except DataError:
                    budget = 0.0
            if self.held[kind] is None:
                self.held[kind] = (self.clock(), budget)
        return True

    def leave(self, kind=PROVIDER):
        with self.lock:
            if kind == self.STORED:
                if self.stored_inflight < 1:
                    raise ValueError('stored_admission_not_held')
                self.stored_inflight -= 1
                if self.stored_inflight == 0:
                    self.held[kind] = None
            else:
                self.held[kind] = None
        (self.stored_slot if kind == self.STORED else self.slot).release()


class LocalReadBoundary:
    """No browser origins, DNS-rebinding hosts, oversized bodies or URL relays."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        host = headers.get(b'host', b'').decode('latin1')
        if (not re.fullmatch(r'(127\.0\.0\.1|localhost)(:[0-9]{1,5})?', host)
                or b'origin' in headers or headers.get(b'sec-fetch-site', b'none') != b'none'):
            return await JSONResponse({'error': 'local_client_required'}, status_code=403)(scope, receive, send)
        if scope['method'] == 'POST':
            if headers.get(b'content-type', b'').split(b';')[0].strip().lower() != b'application/json':
                return await JSONResponse({'error': 'json_required'}, status_code=415)(scope, receive, send)
            body = b''
            deadline = time.monotonic() + 5
            while True:
                try:
                    message = await asyncio.wait_for(receive(), timeout=max(0, deadline - time.monotonic()))
                except TimeoutError:
                    return await JSONResponse({'error': 'request_timeout'}, status_code=408)(scope, receive, send)
                if message['type'] == 'http.disconnect':
                    return
                body += message.get('body', b'')
                if len(body) > 8192:
                    return await JSONResponse({'error': 'request_too_large'}, status_code=413)(scope, receive, send)
                if not message.get('more_body', False):
                    break
            consumed = False

            async def body_receive():
                nonlocal consumed
                if consumed:
                    return {'type': 'http.disconnect'}
                consumed = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            receive = body_receive

        async def secured_send(message):
            if message['type'] == 'http.response.start':
                message['headers'] = list(message['headers']) + [
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff'),
                    (b'content-security-policy', b"default-src 'none'; frame-ancestors 'none'")]
            await send(message)
        await self.app(scope, receive, secured_send)


SNAPSHOT_STORE = Path(__file__).resolve().parent / 'runtime' / 'markets-snapshot.json'

# A probe is not a read. Neither route touches the chain, the store or the
# provider, so the read budget - the caller's patience for a *read* - has no
# claim on it. They keep the contract's own ceiling instead of no bound at all,
# so a wedged process still fails rather than hanging its caller.
PROBE_PATHS = ('/health', '/v1/capabilities')
PROBE_BUDGET_SECONDS = 15


def checked_refresh_interval(value):
    """0 disables the refresher; otherwise a bounded whole number of seconds."""
    from markets_snapshot import MAX_REFRESH_SECONDS, MIN_REFRESH_SECONDS
    if type(value) is not int or not (value == 0 or MIN_REFRESH_SECONDS <= value <= MAX_REFRESH_SECONDS):
        raise ValueError('invalid_snapshot_refresh_interval')
    return value


def create_app(service=None, *, gate=None, read_budget_seconds=60,
               snapshot_refresh_seconds=None):
    from markets_snapshot import DEFAULT_REFRESH_SECONDS, MarketsSnapshot, SnapshotRefresher
    if type(read_budget_seconds) not in (int, float) or not 0 < read_budget_seconds <= 60:
        raise ValueError('invalid_read_budget')
    refresh_seconds = checked_refresh_interval(
        DEFAULT_REFRESH_SECONDS if snapshot_refresh_seconds is None else snapshot_refresh_seconds)
    generation = secrets.token_hex(16)
    if service is None:
        config = load_config()
        catalogue = configured_catalogue()
        public_data = None
        if catalogue is not None and os.environ.get('DOMINO_PUBLIC_DATA') == '1':
            from public_observations import PgPublicData
            from public_data_service import PublicDataService
            public_data = PublicDataService(PgPublicData(catalogue))
        service = ReadService(rpc_urls=configured_rpc_urls(config, os.environ.get('DOMINO_DISCOVERY_RPC_URL')),
                              snapshot_rpc_version=config.get('version'),
                              snapshot_loopback=config.get('sequenceSnapshotLoopback', False),
                              historical_rpc_urls=(configured_history_rpc_urls(config)
                                                   if config.get('version') in (3,4) else None),
                              inventory_url=os.environ.get('DOMINO_INVENTORY_RPC_URL') or config.get('inventoryUrl'),
                              catalogue=catalogue,
                              requests=configured_pool_requests(catalogue),
                              public_data=public_data,
                              # The store lives beside the reader's other private
                              # runtime files; a restart serves it with its real age.
                              snapshot=MarketsSnapshot(clock=time.time, wall_clock=time.time,
                                                       path=SNAPSHOT_STORE))
        if public_data is not None:
            service.market_cache.reserve_provider = public_data.repository.reserve_provider
    # The featured list lives beside the public observations, read through the same reader role.
    repository = getattr(getattr(service, 'public_data', None), 'repository', None)
    featured = FeaturedReader(repository) if repository is not None else None
    gate = gate or (ReadGate(stored_capacity=4,stored_interval=0)
                   if getattr(service,'public_data',None) is not None else ReadGate())
    # A schema export or a test double may hand in a service with no store;
    # the refresher exists only for a service that can feed one.
    snapshot = getattr(service, 'snapshot', None)
    refresher = None
    if (refresh_seconds and snapshot is not None and hasattr(service, 'pool_market')
            and getattr(service, 'public_data', None) is None):
        refresher = SnapshotRefresher(snapshot, read=lambda pool_id: service.pool_market(pool_id),
                                      gate=gate, interval=refresh_seconds, budget_seconds=read_budget_seconds)
    # The refresher starts with the server, not with the app object: a test
    # client that never enters the app's lifespan never spawns the thread.
    @asynccontextmanager
    async def lifespan(_app):
        if refresher is not None:
            refresher.start()
        try:
            yield
        finally:
            if refresher is not None:
                refresher.stop()

    app = FastAPI(title='Domino internal read API', version='0.8.0', docs_url=None, redoc_url=None,
                  lifespan=lifespan)
    app.add_middleware(LocalReadBoundary)
    app.state.snapshot_refresher = refresher

    @app.middleware('http')
    async def contract_headers(request, call_next):
        opened = time.monotonic()
        notes = hop_log.open_notes()
        request_id = (hop_log.checked_request_id(request.headers.get('x-domino-request-id'))
                      or secrets.token_hex(16))
        v3 = request.url.path.startswith('/v3/read/')
        v4 = request.url.path.startswith('/v4/read/')
        v5 = request.url.path.startswith('/v5/read/')
        contract_version = (V5_CONTRACT_VERSION if v5 else V4_CONTRACT_VERSION if v4 else
                            V3_CONTRACT_VERSION if v3 else CONTRACT_VERSION)
        # Bounding a liveness answer by the read budget lets a reader that is
        # only slow to warm up report 504, which the gateway reads as the whole
        # upstream being unavailable. A probe answers on its own bound.
        probe = request.url.path in PROBE_PATHS
        budget = PROBE_BUDGET_SECONDS if probe else read_budget_seconds
        if 'x-domino-read-budget-ms' in request.headers:
            value = request.headers['x-domino-read-budget-ms']
            if (len(request.headers.getlist('x-domino-read-budget-ms')) != 1 or
                    not re.fullmatch(r'[1-9][0-9]{0,4}', value) or int(value) > 15000):
                response = JSONResponse({'error': 'invalid_request'}, status_code=422)
            else:
                # Still rejected above when malformed: a bad header is a bad
                # request on any route. It only narrows an actual read.
                if not probe:
                    budget = min(budget, int(value) / 1000)
                response = None
        else:
            response = None
        if response is None:
            try:
                with read_deadline(budget):
                    response = await call_next(request)
            except DataError:
                hop_log.note(reason='read_deadline_exceeded')
                response = JSONResponse({'error': 'read_deadline_exceeded'}, status_code=504)
            except Exception:
                # No hop may answer without the contract header (T1.3): an
                # unexpected mid-hop failure is an upstream unavailability.
                hop_log.note(reason='upstream_unavailable')
                response = JSONResponse({'error': 'upstream_unavailable'}, status_code=503)
        response.headers['X-Domino-Read-Contract'] = contract_version
        response.headers['X-Domino-Reader-Generation'] = generation
        # The path never reaches the record: only a declared route name does.
        tail = request.url.path.rsplit('/', 1)[-1]
        route = (tail if (request.url.path == '/v1/read/' + tail and tail in RESPONSE_MODELS
                         or request.url.path == '/v3/read/' + tail and tail in V3_RESPONSE_MODELS
                         or request.url.path == '/v4/read/sequence-snapshot' and tail == 'sequence-snapshot'
                         or request.url.path == '/v5/read/featured-pools' and tail == 'featured-pools')
                 else {'/health': 'health', '/v1/capabilities': 'capabilities'}.get(
                     request.url.path, 'unmatched'))
        hop_log.emit(service='read-api', requestId=request_id, route=route,
                     contractVersion=contract_version, method=request.method,
                     status=response.status_code,
                     durationMs=int((time.monotonic() - opened) * 1000),
                     **hop_log.close_notes(notes))
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({'error': 'invalid_request'}, status_code=422)

    @app.get('/health')
    def health():
        idle = gate.slot.acquire(blocking=False)
        if idle:
            gate.slot.release()
        stored_idle = gate.stored_slot.acquire(blocking=False)
        if stored_idle:
            gate.stored_slot.release()
        return {'status': 'ok', 'mode': 'local_read_only', 'generation': generation,
                'readBudgetSeconds': read_budget_seconds, 'busy': not idle,
                'storedBusy': not stored_idle,
                # The wait the gate can justify while its provider slot is held;
                # the gateway relays it instead of guessing.
                'retryAfterSeconds': None if idle else gate.retry_after(gate.PROVIDER),
                'storedRetryAfterSeconds': None if stored_idle else gate.retry_after(gate.STORED),
                'snapshotRefresh': None if refresher is None else refresher.describe(),
                'snapshotStoreFailures': None if snapshot is None else snapshot.store_failures}

    @app.get('/v1/capabilities')
    def capabilities():
        return {'chainId': CHAIN_ID, 'deployment': 'local_development', 'publicChainReads': True,
                'inventoryConfigured': service.inventory_configured, 'inventoryCoverageQualified': False,
                'tokenAddressLookup': True, 'explicitPoolLookup': True,
                'catalogueConfigured': service.catalogue is not None,
                'corePoolActivity': service.catalogue is not None,
                'coreTradingFees': {'available':service.catalogue is not None,
                                    'scope':'hookless_fixed_fee_reconciled_pools_only','methodologyVersion':1},
                'corePositionAccounting': {'available':service.catalogue is not None,
                                          'scope':'hookless_fixed_fee_reconciled_pools_only',
                                          'methodologyVersion':1,'nftOwnershipResolved':False},
                'nftOwnershipReads': {'available': True, 'scope': 'official_position_manager_at_pinned_block',
                                     'walletAuthentication': False},
                'eventTimeCapital': service.catalogue is not None,
                'historicalValuationEngine': True, 'productionPriceSourcesQualified': False,
                'onDemandPoolMarket': {'available': True, 'requiresLocalHistory': False,
                                      'source': 'geckoterminal', 'providerReported': True,
                                      'priceHistory': 'up_to_24_hourly_candles'},
                'walletAuthentication': False, 'privateAccounts': False, 'feeApr': False,
                'suggestions': False, 'ownerTransactions': False, 'automation': False, 'feeCollection': False}

    def run_read(operation, route, body=None, *, validator=validate_response):
        kind = gate.kind_of(route, body)
        if not gate.enter(kind):
            hop_log.note(gate=kind, admitted=False, reason='read_capacity_busy')
            return JSONResponse({'error': 'read_capacity_busy'}, status_code=429,
                                headers={'Retry-After': str(gate.retry_after(kind))})
        hop_log.note(gate=kind, admitted=True)
        try:
            with read_deadline(read_budget_seconds):
                result = operation()
                try:
                    validator(route, result)
                except (ValueError, TypeError):
                    hop_log.note(reason='upstream_contract_mismatch')
                    return JSONResponse({'error': 'upstream_contract_mismatch'}, status_code=502)
                return result
        except DataError as error:
            status, data = sanitize_error(str(error))
            hop_log.note(reason=data.get('error'))
            return JSONResponse(data, status_code=status)
        finally:
            gate.leave(kind)

    error_responses = {code: {'model': ErrorResponse} for code in (400,403,408,409,413,415,422,429,502,503,504)}

    @app.post('/v1/read/wallet-assets', responses={200: {'model': RESPONSE_MODELS['wallet-assets']}, **error_responses})
    def wallet_assets(body: AssetsRequest):
        return run_read(lambda: service.wallet_assets(body.wallet, body.tokens,
                        auto_discover=body.autoDiscover, cursor=body.cursor), 'wallet-assets')

    @app.post('/v1/read/token', responses={200: {'model': RESPONSE_MODELS['token']}, **error_responses})
    def token(body: TokenRequest):
        return run_read(lambda: service.token(body.token), 'token')

    @app.post('/v1/read/catalogue', responses={200: {'model': RESPONSE_MODELS['catalogue']}, **error_responses})
    def catalogue(body: CatalogueRequest):
        return run_read(lambda: service.catalogue_page(body.token,limit=body.limit,after=body.afterPoolId,
                        revision=body.revision,paired_token=body.pairedToken), 'catalogue')

    @app.post('/v1/read/pools', responses={200: {'model': RESPONSE_MODELS['pools']}, **error_responses})
    def pools(body: PoolsRequest):
        return run_read(lambda: service.pools(body.token, body.maxPools, body.poolIds, paired_token=body.pairedToken), 'pools')

    @app.post('/v1/read/pool-activity', responses={200: {'model': RESPONSE_MODELS['pool-activity']}, **error_responses})
    def pool_activity(body: ActivityRequest):
        return run_read(lambda: service.pool_activity(body.poolId), 'pool-activity')

    @app.post('/v1/read/pool-positions', responses={200: {'model': RESPONSE_MODELS['pool-positions']}, **error_responses})
    def pool_positions(body: ActivityRequest):
        return run_read(lambda: service.pool_positions(body.poolId), 'pool-positions')

    @app.post('/v1/read/nft-positions', responses={200: {'model': RESPONSE_MODELS['nft-positions']}, **error_responses})
    def nft_positions(body: NftPositionsRequest):
        return run_read(lambda: service.nft_positions(body.tokenIds, body.blockNumber), 'nft-positions')

    @app.post('/v1/read/pool-metrics', responses={200: {'model': RESPONSE_MODELS['pool-metrics']}, **error_responses})
    def pool_metrics(body: ActivityRequest):
        return run_read(lambda: service.pool_metrics(body.poolId), 'pool-metrics')

    @app.post('/v1/read/pool-market', responses={200: {'model': RESPONSE_MODELS['pool-market']}, **error_responses})
    def pool_market(body: PoolMarketRequest):
        return run_read(lambda: service.pool_market(body.poolId,
                        include_price_history=body.includePriceHistory, price_token=body.priceToken,
                        from_snapshot=body.fromSnapshot), 'pool-market', body.model_dump())

    @app.post('/v1/read/markets-snapshot', responses={200: {'model': RESPONSE_MODELS['markets-snapshot']}, **error_responses})
    def markets_snapshot(body: MarketsSnapshotRequest):
        # This lane remains available during provider work, but its own slot
        # bounds concurrent store reads and response validation.
        return run_read(lambda: service.markets_snapshot(body.poolIds), 'markets-snapshot')

    def stored_public(route, body):
        def operation():
            public_data = getattr(service, 'public_data', None)
            if public_data is None:
                raise DataError('upstream_unavailable')
            result = getattr(public_data, route)(**body.model_dump())
            try:
                validate_v3_request_response(route, body.model_dump(), result)
            except (ValueError, TypeError):
                raise DataError('upstream_contract_mismatch') from None
            return result
        return run_read(operation, route, body.model_dump(), validator=validate_v3_response)

    @app.post('/v3/read/overview', responses={200: {'model': V3_RESPONSE_MODELS['overview']}, **error_responses})
    def overview(body: OverviewRequest):
        return stored_public('overview', body)

    @app.post('/v3/read/history', responses={200: {'model': V3_RESPONSE_MODELS['history']}, **error_responses})
    def history(body: HistoryRequest):
        return stored_public('history', body)

    @app.post('/v3/read/search', responses={200: {'model': V3_RESPONSE_MODELS['search']}, **error_responses})
    def search(body: SearchRequest):
        return stored_public('search', body)

    @app.post('/v5/read/featured-pools', responses={200: {'model': FeaturedPoolsResponse}, **error_responses})
    def featured_pools(body: FeaturedPoolsRequest):
        # The served list only: one stored read, the same answer for everyone.
        def operation():
            if featured is None:
                raise DataError('upstream_unavailable')
            return featured.read()
        return run_read(operation, 'featured-pools', body.model_dump(), validator=validate_featured_response)

    @app.post('/v4/read/sequence-snapshot')
    def owner_sequence_snapshot(body: SequenceSnapshotRequest):
        return run_read(lambda: service.sequence_snapshot(body.owner, body.tokenId),
                        'sequence-snapshot', body.model_dump(), validator=validate_snapshot_response)

    return app


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--read-budget', type=int, default=60, choices=range(1,61))
    parser.add_argument('--snapshot-refresh', type=int, default=None, metavar='SECONDS',
                        help='re-read one stored pool per period so every entry stays inside the '
                             'consumer window; 0 disables (default 240)')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    try:
        checked_refresh_interval(args.snapshot_refresh if args.snapshot_refresh is not None else 0)
    except ValueError:
        parser.error('snapshot refresh must be 0 or between 30 and 3600 seconds')
    if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
        parser.error('single reader process required')
    # Explicit loopback only. No proxy-trust or request-body/access logging.
    uvicorn.run(create_app(read_budget_seconds=args.read_budget, snapshot_refresh_seconds=args.snapshot_refresh),
                host='127.0.0.1', port=args.port, access_log=False,
                proxy_headers=False, server_header=False, limit_concurrency=8, workers=1)


if __name__ == '__main__':
    main()
