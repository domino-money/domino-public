"""Bounded read-only Uniswap LP pool_info client; no transaction endpoints.

Request/response names verified against Uniswap/interface OpenAPI commit
da6d36f71c4d2fd665b0aae1a052a4ffda917b31, packages/api/src/clients/trading/api.json,
and useDerivedPositionInfo.tsx at that commit. PoolReferenceByProtocol has an
inconsistent required field, so this client deliberately uses poolParameters.
https://developers.uniswap.org/docs/api-reference/pool_info

PoolId hashing verifies the association of provider fields, not their truth at
an on-chain snapshot. Reserves are provider-reported fee-excluded core principal;
donations, uncollected fees and hook-held assets are excluded by this endpoint.
"""
from dataclasses import asdict
import math
import re
import time

from discovery import CHAIN_ID, DataError, PoolKey, ZERO, address, bytes32, json_http
from v4_math import MAX_SQRT, MIN_SQRT, sqrt_at_tick, tick_at_sqrt

ENDPOINT = 'https://liquidity.api.uniswap.org/lp/pool_info'
SOURCE = 'uniswap_liquidity_pool_info_v1'
MAX_POOLS = 20
TIMEOUT_SECONDS = 12
SCHEMA_COMMIT = 'da6d36f71c4d2fd665b0aae1a052a4ffda917b31'

# Public configuration probe only, never a runtime currency allowlist.
PROBE_POOL_ID = '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6'
PROBE_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
PROBE_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'


def checked_api_key(value):
    """Reject header injection without assuming a particular key vendor format."""
    if (not isinstance(value, str) or not 1 <= len(value) <= 512
            or any(not 33 <= ord(char) <= 126 for char in value)):
        raise DataError('invalid_uniswap_api_key')
    return value


def _integer(value, low, high, *, string=False):
    if string and isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value):
        value = int(value)
    if type(value) is not int or not low <= value <= high:
        raise DataError('invalid_uniswap_pool_number')
    return value


def _raw(value, bits, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise DataError('invalid_uniswap_raw_amount')
    return str(_integer(value, 0, (1 << bits) - 1, string=True))


def _fee(value):
    fee = _integer(value, 0, 0x800000, string=True)
    if fee > 1_000_000 and fee != 0x800000:
        raise DataError('invalid_uniswap_pool_fee')
    return fee


def _safe_transport_code(error):
    # A custom transport can raise messages containing headers or provider text.
    # Only exact known codes are allowed out; never return raw error bodies.
    code = str(error)
    if isinstance(error, DataError) and (
        code in {'network_unavailable', 'response_too_large', 'invalid_json',
                 'incomplete_rpc_response', 'invalid_compressed_response',
                 'unsupported_content_encoding'}
        or re.fullmatch(r'http_[1-5][0-9]{2}', code)
    ):
        return code
    return 'uniswap_transport_unavailable'


def _pool(raw, pair, requested_fee, requested_spacing, requested_hooks):
    if not isinstance(raw, dict):
        raise DataError('invalid_uniswap_pool')
    if type(raw.get('chainId')) is not int or raw['chainId'] != CHAIN_ID:
        raise DataError('uniswap_chain_mismatch')
    if raw.get('poolProtocol') != 'V4':
        raise DataError('uniswap_protocol_mismatch')
    pool_id = bytes32(raw.get('poolReferenceIdentifier'))
    a, b = address(raw.get('tokenAddressA')), address(raw.get('tokenAddressB'))
    if a == b or sorted((a, b)) != list(pair):
        raise DataError('uniswap_currency_mismatch')
    fee = _fee(raw.get('fee'))
    spacing = _integer(raw.get('tickSpacing'), 1, 32767)
    hooks = address(raw.get('hookAddress'))
    if (fee != requested_fee or spacing != requested_spacing
            or requested_hooks is not None and hooks != requested_hooks):
        raise DataError('uniswap_pool_parameters_mismatch')
    key = PoolKey.checked((*pair, fee, spacing, hooks), pool_id)
    liquidity = _raw(raw.get('poolLiquidity'), 128)
    sqrt = int(_raw(raw.get('sqrtRatioX96'), 160))
    tick = _integer(raw.get('currentTick'), -887272, 887272)
    if not MIN_SQRT <= sqrt < MAX_SQRT:
        raise DataError('invalid_uniswap_pool_state')
    implied_tick = tick_at_sqrt(sqrt)
    # A zero-for-one swap exactly on a boundary stores the crossed tick minus 1.
    if tick != implied_tick and not (tick == implied_tick - 1 and sqrt == sqrt_at_tick(implied_tick)):
        raise DataError('inconsistent_uniswap_price_tick')
    decimals = {}
    amounts = {}
    for suffix, currency in (('A', a), ('B', b)):
        value = raw.get('tokenDecimals' + suffix)
        # Live pool_info responses use decimal strings despite the numeric
        # OpenAPI type. Normalize exact integers only; never infer missing data.
        decimals[currency] = None if value is None else _integer(value, 0, 255, string=True)
        amounts[currency] = _raw(raw.get('tokenAmount' + suffix), 256, optional=True)
    reserves = [_raw(raw.get('token0Reserves'), 256, optional=True),
                _raw(raw.get('token1Reserves'), 256, optional=True)]
    return {
        'poolId': pool_id, 'chainId': CHAIN_ID, 'protocol': 'V4',
        'poolKey': asdict(key), 'currencies': list(pair),
        'identityStatus': 'provider_key_hash_checked',
        'liquidityRaw': liquidity, 'sqrtPriceX96': str(sqrt), 'tick': tick,
        'tokens': [{'address': currency, 'decimals': decimals[currency],
                    'providerAmountRaw': amounts[currency]} for currency in pair],
        'reserves': {
            'amount0Raw': reserves[0], 'amount1Raw': reserves[1],
            'status': ('available' if all(x is not None for x in reserves)
                       else 'unavailable' if all(x is None for x in reserves) else 'partial'),
            'method': 'provider_fee_excluded_core_principal',
        },
    }


class UniswapLiquidity:
    """One fixed HTTPS endpoint, one request per invocation, no implicit retry."""

    def __init__(self, api_key, *, transport=json_http, clock=time.time):
        self._api_key = checked_api_key(api_key)
        self._transport = transport
        self._clock = clock

    def by_pair(self, token_a, token_b, *, fee, tick_spacing, hooks=None):
        pair = tuple(sorted((address(token_a), address(token_b))))
        if pair[0] == pair[1]:
            raise DataError('uniswap_currency_mismatch')
        fee = _fee(fee)
        spacing = _integer(tick_spacing, 1, 32767)
        hooks = address(hooks) if hooks is not None else None
        parameters = {'tokenAddressA': pair[0], 'tokenAddressB': pair[1],
                      'fee': fee, 'tickSpacing': spacing}
        if hooks is not None:
            parameters['hookAddress'] = hooks
        body = {'chainId': CHAIN_ID, 'protocol': 'V4', 'poolParameters': parameters,
                'pageSize': MAX_POOLS}
        try:
            payload = self._transport(ENDPOINT, body, timeout=TIMEOUT_SECONDS,
                                      headers={'x-api-key': self._api_key})
        except Exception as error:
            raise DataError(_safe_transport_code(error)) from None
        if (not isinstance(payload, dict) or 'error' in payload or 'code' in payload
                or not isinstance(payload.get('pools'), list) or len(payload['pools']) > MAX_POOLS):
            raise DataError('invalid_uniswap_response')
        pools = [_pool(row, pair, fee, spacing, hooks) for row in payload['pools']]
        if len({row['poolId'] for row in pools}) != len(pools):
            raise DataError('duplicate_uniswap_pool')
        retrieved = self._clock()
        if type(retrieved) not in (float, int) or not math.isfinite(retrieved) or not 0 <= retrieved < 1 << 53:
            raise DataError('invalid_uniswap_retrieval_time')
        pagination = {}
        for field in ('pageSize', 'currentPage'):
            value = payload.get(field)
            pagination[field] = None if value is None else _integer(value, 0, 1_000_000)
        return {
            'schemaVersion': 1, 'source': SOURCE, 'chainId': CHAIN_ID,
            'retrievedAt': int(retrieved), 'status': 'external_observation_unqualified',
            'asOfBlock': None, 'asOfTimestamp': None, 'pools': pools,
            'coverage': {'scope': 'one_provider_pair_page', 'complete': False,
                         'returned': len(pools), **pagination},
            'provenance': {'endpoint': ENDPOINT, 'schemaCommit': SCHEMA_COMMIT,
                           'onchainSnapshotVerified': False},
        }


def probe(api_key, *, transport=json_http, clock=time.time):
    """Read one public sample; a successful read is not proof of key validity."""
    report = UniswapLiquidity(api_key, transport=transport, clock=clock).by_pair(
        PROBE_WETH, PROBE_USDG, fee=200, tick_spacing=4, hooks=ZERO)
    if len(report['pools']) != 1 or report['pools'][0]['poolId'] != PROBE_POOL_ID:
        raise DataError('uniswap_probe_pool_missing')
    report['probeStatus'] = 'known_pool_readable'
    return report
