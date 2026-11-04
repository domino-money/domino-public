"""Additive stored public reads. V1/V2 observations and validators are reused."""
from typing import Annotated, Literal
from decimal import Decimal
from pydantic import Field, StrictInt, StrictStr, model_validator

from discovery import POOL_MANAGER
from pool_apr_contract import PoolMarketEstimateResponse
from read_contract import (Address, Hash, UInt, FalseFlag, WireModel, TokenResponse,
                           Snapshot, ErrorResponse)

CONTRACT_VERSION = '3.0.0-rc.1'
ENABLED_READS = ('overview', 'history', 'search')
Reason = Annotated[StrictStr, Field(pattern=r'^[a-z][a-z0-9_]{0,95}$')] | None


class OverviewRequest(WireModel):
    token: Address | None = None
    poolIds: Annotated[list[Hash], Field(max_length=24)] = []
    afterPoolId: Hash | None = None
    revision: UInt | None = None
    limit: Annotated[StrictInt, Field(ge=1, le=24)] = 24

    @model_validator(mode='after')
    def selection(self):
        if ((self.token is None and not self.poolIds) or
                (self.token is not None and self.poolIds) or
                len(self.poolIds) > self.limit or
                len(set(self.poolIds)) != len(self.poolIds) or
                (self.afterPoolId is not None and (self.token is None or self.revision is None))):
            raise ValueError('invalid_selection')
        return self


class Acquisition(WireModel):
    status: Literal['pending','ready','rejected']
    refreshing: bool
    reason: Reason
    nextAttemptAt: UInt | None


class StoredToken(WireModel):
    address: Address
    value: TokenResponse | None
    observedAt: UInt | None
    acquisition: Acquisition

    @model_validator(mode='after')
    def evidence(self):
        if (self.value is None) != (self.observedAt is None):
            raise ValueError('observation_required')
        if self.value is not None and self.value.asset.address != self.address:
            raise ValueError('token_identity_mismatch')
        return self


class StoredPool(WireModel):
    poolId: Hash
    value: PoolMarketEstimateResponse | None
    observedAt: UInt | None
    acquisition: Acquisition

    @model_validator(mode='after')
    def evidence(self):
        if (self.value is None) != (self.observedAt is None):
            raise ValueError('observation_required')
        if self.value is not None and self.value.poolId != self.poolId:
            raise ValueError('pool_identity_mismatch')
        return self


class OverviewResponse(WireModel):
    schemaVersion: Literal[1]
    chainId: Literal[4663]
    mode: Literal['stored_public_overview']
    generatedAt: UInt
    selectedToken: Address | None
    requestedPoolIds: Annotated[list[Hash], Field(max_length=24)]
    acquisitionAccepted: bool
    revision: UInt
    hasMore: bool
    nextAfterPoolId: Hash | None
    discoveryCoverage: Literal['known_verified_pools_only']
    completeHistory: FalseFlag
    tokens: Annotated[list[StoredToken], Field(max_length=49)]
    pools: Annotated[list[StoredPool], Field(max_length=24)]
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def identities(self):
        if (len({x.address for x in self.tokens}) != len(self.tokens) or
                len({x.poolId for x in self.pools}) != len(self.pools) or
                self.hasMore != (self.nextAfterPoolId is not None)):
            raise ValueError('invalid_overview_identity')
        if self.selectedToken is None and any(x.poolId not in self.requestedPoolIds for x in self.pools):
            raise ValueError('unrequested_pool')
        return self


class SearchRequest(WireModel):
    query: Annotated[StrictStr, Field(min_length=1, max_length=96)]
    limit: Annotated[StrictInt, Field(ge=1, le=24)] = 20

    @model_validator(mode='after')
    def storable(self):
        # F-18 (21 Oct 2026 pentest, fixed 3 Nov 2026): PostgreSQL text cannot hold U+0000, so a NUL in the query
        # reached the database and came back 503 catalogue_database_unavailable. A bad request, refused by each hop.
        if '\x00' in self.query:
            raise ValueError('query')
        return self


class SearchResponse(WireModel):
    schemaVersion: Literal[1]
    chainId: Literal[4663]
    query: Annotated[StrictStr, Field(min_length=1, max_length=96)]
    coverage: Literal['known_verified_tokens_only']
    tokens: Annotated[list[StoredToken], Field(max_length=24)]
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def known_unique(self):
        if (len({x.address for x in self.tokens}) != len(self.tokens) or any(
                x.value is None or x.value.asset.kind == 'unknown' for x in self.tokens)):
            raise ValueError('invalid_search_identity')
        return self


class HistoryRequest(WireModel):
    poolId: Hash
    currency: Address
    windowSeconds: Literal[86400,604800,2592000] = 86400
    resolutionSeconds: Literal[60,3600,86400] = 3600

    @model_validator(mode='after')
    def bounded_points(self):
        if self.windowSeconds // self.resolutionSeconds > 600:
            raise ValueError('history_resolution_too_fine')
        return self


class Interval(WireModel):
    startTimestamp: UInt
    endTimestamp: UInt

    @model_validator(mode='after')
    def order(self):
        if self.endTimestamp < self.startTimestamp:
            raise ValueError('invalid_interval')
        return self


Price = Annotated[StrictStr, Field(pattern=r'^[0-9]+(?:\.[0-9]+)?$', max_length=224)]


class RatioCandle(WireModel):
    startTimestamp: UInt
    open: Price
    high: Price
    low: Price
    close: Price
    swapCount: Annotated[StrictInt, Field(ge=1)]
    complete: bool

    @model_validator(mode='after')
    def prices(self):
        low,high = Decimal(self.low),Decimal(self.high)
        if low <= 0 or not low <= Decimal(self.open) <= high or not low <= Decimal(self.close) <= high:
            raise ValueError('invalid_candle_prices')
        return self


class HistoryResponse(WireModel):
    schemaVersion: Literal[1]
    chainId: Literal[4663]
    poolManager: Literal[POOL_MANAGER]
    poolId: Hash
    currency: Address
    quoteCurrency: Address | None
    source: Literal['robinhood_pool_swap_logs']
    methodology: Literal['pool_ratio_v1']
    unit: Literal['quote_per_base']
    status: Literal['available','stale','partial','not_built','unavailable']
    reason: Reason
    requestedWindow: Interval
    resolutionSeconds: Literal[60,3600,86400]
    snapshot: Snapshot | None
    covered: Annotated[list[Interval], Field(max_length=128)]
    gaps: Annotated[list[Interval], Field(max_length=129)]
    candles: Annotated[list[RatioCandle], Field(max_length=600)]
    acquisitionAccepted: bool
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def series(self):
        times = [x.startTimestamp for x in self.candles]
        if times != sorted(set(times)) or (self.candles and (self.quoteCurrency is None or self.snapshot is None)):
            raise ValueError('invalid_history_series')
        if self.quoteCurrency == self.currency:
            raise ValueError('invalid_history_denomination')
        start,end = self.requestedWindow.startTimestamp,self.requestedWindow.endTimestamp
        for intervals in (self.covered,self.gaps):
            previous = start
            for interval in intervals:
                if not previous <= interval.startTimestamp < interval.endTimestamp <= end:
                    raise ValueError('invalid_history_coverage')
                previous = interval.endTimestamp
        for candle in self.candles:
            if (candle.startTimestamp % self.resolutionSeconds or
                    not start//self.resolutionSeconds*self.resolutionSeconds <= candle.startTimestamp < end or
                    (candle.complete and not start <= candle.startTimestamp < candle.startTimestamp+self.resolutionSeconds <= end)):
                raise ValueError('invalid_candle_window')
        if self.status == 'available':
            if (self.gaps or not self.covered or self.snapshot is None or
                    self.covered[0].startTimestamp != start or self.covered[-1].endTimestamp != end or
                    any(a.endTimestamp != b.startTimestamp for a,b in zip(self.covered,self.covered[1:]))):
                raise ValueError('incomplete_history_claim')
        if any(c.complete and not any(i.startTimestamp <= c.startTimestamp and
                c.startTimestamp+self.resolutionSeconds <= i.endTimestamp for i in self.covered)
               for c in self.candles):
            raise ValueError('uncovered_complete_candle')
        return self


class BridgeCapabilities(WireModel):
    contractVersion: Literal['3.0.0-rc.1']
    dataMode: Literal['disabled','live_read_only']
    chainId: Literal[4663]
    enabledReads: Annotated[list[Literal['overview','history','search']], Field(max_length=3)]
    walletAuthentication: FalseFlag
    privateAccounts: FalseFlag
    ownerTransactions: FalseFlag
    automation: FalseFlag

    @model_validator(mode='after')
    def enabled_mode(self):
        if bool(self.enabledReads) != (self.dataMode == 'live_read_only') or len(set(self.enabledReads)) != len(self.enabledReads):
            raise ValueError('invalid_capability_mode')
        return self


REQUEST_MODELS = {'overview': OverviewRequest, 'history': HistoryRequest, 'search': SearchRequest}
RESPONSE_MODELS = {'overview': OverviewResponse, 'history': HistoryResponse, 'search': SearchResponse}


def validate_request(route, payload):
    REQUEST_MODELS[route].model_validate(payload, strict=True)
    return payload


def validate_response(route, payload):
    model = BridgeCapabilities if route == 'capabilities' else RESPONSE_MODELS[route]
    model.model_validate(payload, strict=True)
    return payload


def validate_request_response(route, request, response):
    body = REQUEST_MODELS[route].model_validate(request, strict=True)
    validate_response(route,response)
    if route == 'overview':
        if (response['selectedToken'] != body.token or response['requestedPoolIds'] != body.poolIds or
                len(response['pools']) > body.limit or
                (body.revision is not None and response['revision'] != body.revision)):
            raise ValueError('overview_request_mismatch')
        if body.afterPoolId is not None and any(row['poolId'] <= body.afterPoolId for row in response['pools']):
            raise ValueError('overview_cursor_mismatch')
        if body.token is not None and any(row['value'] is not None and body.token not in
                row['value']['market']['pool']['currencies'] for row in response['pools']):
            raise ValueError('overview_token_mismatch')
        if response['hasMore'] and (not response['pools'] or response['nextAfterPoolId'] != response['pools'][-1]['poolId']):
            raise ValueError('overview_cursor_mismatch')
    elif route == 'history':
        window = response['requestedWindow']
        if (response['poolId'] != body.poolId or response['currency'] != body.currency or
                response['resolutionSeconds'] != body.resolutionSeconds or
                window['endTimestamp'] - window['startTimestamp'] != body.windowSeconds):
            raise ValueError('history_request_mismatch')
    elif response['query'] != body.query or len(response['tokens']) > body.limit:
        raise ValueError('search_request_mismatch')
    return response


def export_contract():
    result = {}
    for direction, models in (('request',REQUEST_MODELS),('response',{
            **RESPONSE_MODELS,'capabilities':BridgeCapabilities,'error':ErrorResponse})):
        for route, model in models.items():
            schema = model.model_json_schema()
            schema.update({'$schema':'https://json-schema.org/draft/2020-12/schema',
                           '$id':f'https://domino.invalid/contracts/read-v3/{route}.{direction}.schema.json',
                           'x-contract-version':CONTRACT_VERSION})
            result[f'{route}.{direction}.schema.json'] = schema
    return result
