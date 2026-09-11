"""Internal loopback API for public chain reads, not authenticated account data."""
import asyncio
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
from local_config import load_config
from catalogue import configured_catalogue
from read_service import ReadService
from read_contract import CONTRACT_VERSION, RESPONSE_MODELS, ErrorResponse, validate_response, sanitize_error
from read_deadline import read_deadline

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


class NftPositionsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tokenIds: list[Annotated[str, StringConstraints(strict=True, pattern=r'^(0|[1-9][0-9]{0,77})$')]] = Field(min_length=1, max_length=10)
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
    def __init__(self, interval=1, clock=time.monotonic):
        self.slot, self.lock = BoundedSemaphore(1), Lock()
        self.interval, self.clock, self.last = interval, clock, float('-inf')

    def enter(self):
        if not self.slot.acquire(blocking=False):
            return False
        with self.lock:
            if self.clock() - self.last < self.interval:
                self.slot.release()
                return False
            self.last = self.clock()
        return True


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


def create_app(service=None, *, gate=None, read_budget_seconds=60):
    if type(read_budget_seconds) not in (int, float) or not 0 < read_budget_seconds <= 60:
        raise ValueError('invalid_read_budget')
    generation = secrets.token_hex(16)
    if service is None:
        config = load_config()
        service = ReadService(rpc_url=os.environ.get('DOMINO_DISCOVERY_RPC_URL') or config.get('rpcUrl', RPC_URL),
                              inventory_url=os.environ.get('DOMINO_INVENTORY_RPC_URL') or config.get('inventoryUrl'),
                              catalogue=configured_catalogue())
    gate = gate or ReadGate()
    app = FastAPI(title='Domino internal read API', version='0.8.0', docs_url=None, redoc_url=None)
    app.add_middleware(LocalReadBoundary)

    @app.middleware('http')
    async def contract_headers(request, call_next):
        budget = read_budget_seconds
        if 'x-domino-read-budget-ms' in request.headers:
            value = request.headers['x-domino-read-budget-ms']
            if (len(request.headers.getlist('x-domino-read-budget-ms')) != 1 or
                    not re.fullmatch(r'[1-9][0-9]{0,4}', value) or int(value) > 15000):
                response = JSONResponse({'error': 'invalid_request'}, status_code=422)
            else:
                budget = min(budget, int(value) / 1000)
                response = None
        else:
            response = None
        if response is None:
            try:
                with read_deadline(budget):
                    response = await call_next(request)
            except DataError:
                response = JSONResponse({'error': 'read_deadline_exceeded'}, status_code=504)
        response.headers['X-Domino-Read-Contract'] = CONTRACT_VERSION
        response.headers['X-Domino-Reader-Generation'] = generation
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({'error': 'invalid_request'}, status_code=422)

    @app.get('/health')
    def health():
        idle = gate.slot.acquire(blocking=False)
        if idle:
            gate.slot.release()
        return {'status': 'ok', 'mode': 'local_read_only', 'generation': generation,
                'readBudgetSeconds': read_budget_seconds, 'busy': not idle}

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

    def run_read(operation, route):
        if not gate.enter():
            return JSONResponse({'error': 'read_capacity_busy'}, status_code=429, headers={'Retry-After': '1'})
        try:
            with read_deadline(read_budget_seconds):
                result = operation()
                try:
                    validate_response(route, result)
                except (ValueError, TypeError):
                    return JSONResponse({'error': 'upstream_contract_mismatch'}, status_code=502)
                return result
        except DataError as error:
            status, data = sanitize_error(str(error))
            return JSONResponse(data, status_code=status)
        finally:
            gate.slot.release()

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
                        include_price_history=body.includePriceHistory, price_token=body.priceToken), 'pool-market')

    return app


def main():
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--read-budget', type=int, default=60, choices=range(1,61))
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    if any(os.environ.get(name, '1') != '1' for name in ('WEB_CONCURRENCY', 'UVICORN_WORKERS')):
        parser.error('single reader process required')
    # Explicit loopback only. No proxy-trust or request-body/access logging.
    uvicorn.run(create_app(read_budget_seconds=args.read_budget), host='127.0.0.1', port=args.port, access_log=False,
                proxy_headers=False, server_header=False, limit_concurrency=8, workers=1)


if __name__ == '__main__':
    main()
