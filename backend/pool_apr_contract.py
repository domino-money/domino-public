"""Opt-in read-v2 pool listing contract; the deployed read-v1 remains intact."""
from typing import Annotated, Literal

from pydantic import Field, model_validator

from pool_apr import PoolAprEstimate, estimate_pool_apr
from read_contract import (ERROR_STATUS_BY_CODE, ErrorResponse, FalseFlag, Hash,
                           PoolMarketResponse, WireModel, sanitize_error)

CONTRACT_VERSION = '2.0.0-rc.1'
ENABLED_READS = ('pool-market',)


class PoolMarketEstimateRequest(WireModel):
    poolId: Hash


class PoolMarketEstimateResponse(WireModel):
    schemaVersion: Literal[1]
    chainId: Literal[4663]
    poolId: Hash
    market: PoolMarketResponse
    estimate: PoolAprEstimate
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def same_observation(self):
        market = self.market.model_dump(mode='json', exclude_unset=True)
        estimate = self.estimate.model_dump(mode='json', exclude_unset=True)
        if (self.poolId != market['poolId'] or self.poolId != estimate['poolId'] or
                market['priceHistory']['status'] != 'not_requested' or
                estimate != estimate_pool_apr(market, now=estimate['provenance']['evaluatedAt'])):
            raise ValueError('pool_estimate_evidence_mismatch')
        return self


class BridgeCapabilities(WireModel):
    contractVersion: Literal['2.0.0-rc.1']
    dataMode: Literal['disabled', 'live_read_only']
    chainId: Literal[4663]
    enabledReads: Annotated[list[Literal['pool-market']], Field(max_length=1)]
    walletAuthentication: FalseFlag
    privateAccounts: FalseFlag
    ownerTransactions: FalseFlag
    automation: FalseFlag

    @model_validator(mode='after')
    def enabled_mode(self):
        if bool(self.enabledReads) != (self.dataMode == 'live_read_only'):
            raise ValueError('invalid_capability_mode')
        return self


REQUEST_MODELS = {'pool-market': PoolMarketEstimateRequest}
RESPONSE_MODELS = {'pool-market': PoolMarketEstimateResponse}


def validate_request(route, payload):
    REQUEST_MODELS[route].model_validate(payload, strict=True)
    return payload


def validate_response(route, payload):
    model = BridgeCapabilities if route == 'capabilities' else RESPONSE_MODELS[route]
    model.model_validate(payload, strict=True)
    return payload


def build_pool_market_estimate(market, *, now, requested_pool_id):
    """Derive from the one completed read, never from browser-supplied metrics."""
    if not isinstance(market, dict) or market.get('poolId') != requested_pool_id:
        raise ValueError('pool_estimate_request_mismatch')
    result = {'schemaVersion': 1, 'chainId': 4663, 'poolId': requested_pool_id,
              'market': market, 'estimate': estimate_pool_apr(market, now=now),
              'executionAvailable': False}
    return validate_response('pool-market', result)


def export_contract():
    result = {}
    for route, model in {**RESPONSE_MODELS, 'capabilities': BridgeCapabilities,
                         'error': ErrorResponse}.items():
        schema = model.model_json_schema()

        def remove_defaults(value):
            if isinstance(value, dict):
                value.pop('default', None)
                for child in value.values():
                    remove_defaults(child)
            elif isinstance(value, list):
                for child in value:
                    remove_defaults(child)

        remove_defaults(schema)
        schema.update({'$schema': 'https://json-schema.org/draft/2020-12/schema',
                       '$id': f'https://domino.invalid/contracts/read-v2/{route}.response.schema.json',
                       'x-contract-version': CONTRACT_VERSION})
        result[f'{route}.response.schema.json'] = schema
    return result
