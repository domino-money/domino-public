"""Offline read-v2 evidence from the real read service and market adapters."""
from copy import deepcopy

from eth_abi import encode
from eth_hash.auto import keccak

from discovery import KEY_TYPES, ZERO
from market_cache import MarketCache
from market_data import GeckoMarketData
from pool_apr_contract import (CONTRACT_VERSION, ERROR_STATUS_BY_CODE,
                               build_pool_market_estimate, validate_response)
from test_discovery import FakeRpc, KEY, OTHER
from test_read_contract import MarketTransport, service


class EstimateRpc(FakeRpc):
    def __init__(self, *, key=KEY, protocol=0):
        super().__init__()
        self.key, self.protocol = key, protocol

    def call(self, target, signature, *args, **kwargs):
        if signature == 'getSlot0(bytes32)':
            self.calls.append((target, signature))
            return (2**96, 0, self.protocol, 3000 if self.key[2] == 0x800000 else self.key[2])
        return super().call(target, signature, *args, **kwargs)


class EstimateTransport(MarketTransport):
    def __init__(self, pool_id, key):
        super().__init__()
        self.pool_id = pool_id
        self.base, self.quote = key[1], key[0]
        self.volume, self.liquidity = '1000', '10000'
        self.urls = []

    def __call__(self, url, **kwargs):
        self.urls.append(url)
        if '/ohlcv/' in url:
            raise AssertionError('read-v2 must never fetch charts')
        result = super().__call__(url, **kwargs)
        result['data']['id'] = 'robinhood_' + self.pool_id
        result['data']['attributes']['address'] = self.pool_id
        return result


def market_evidence(*, key=KEY, protocol=0, volume='1000', tvl='10000',
                    age=0, failure=None, base=None, dex='uniswap-v4-robinhood'):
    pool_id = '0x' + keccak(encode(KEY_TYPES, key)).hex()
    transport, monotonic = EstimateTransport(pool_id, key), [0]
    transport.volume, transport.liquidity, transport.dex = volume, tvl, dex
    if base is not None:
        transport.base = base
    cache = MarketCache(GeckoMarketData(transport=transport, clock=lambda: 1010),
                        clock=lambda: monotonic[0])
    reader = service(EstimateRpc(key=key, protocol=protocol), market=cache)
    if age:
        reader.pool_market(pool_id, include_price_history=False)
        monotonic[0] = age
    transport.failure = failure
    market = reader.pool_market(pool_id, include_price_history=False)
    if any('/ohlcv/' in url for url in transport.urls):
        raise AssertionError('chart request escaped the fixture boundary')
    return market


def response(*, now=1010, **kwargs):
    market = market_evidence(**kwargs)
    return build_pool_market_estimate(market, now=now, requested_pool_id=market['poolId'])


def build_fixtures():
    files, index = {}, []

    def add(path, value, *, route='pool-market', valid=True):
        if valid:
            validate_response(route, value)
        files[path] = deepcopy(value)
        index.append({'file': path, 'route': route, 'valid': valid})

    variants = {
        'available': {}, 'zero-volume': {'volume': '0'},
        'zero-tvl': {'tvl': '0'}, 'missing-volume': {'volume': None},
        'missing-tvl': {'tvl': None}, 'precise': {'volume': '9007199254740993.125'},
        'below-precision': {'volume': '0.000000000000000001', 'tvl': '1000000'},
        'out-of-bounds': {'volume': '1e60', 'tvl': '1e-96'},
        'protocol-fee': {'protocol': 1000 | (1000 << 12)},
        'invalid-protocol-fee': {'protocol': 1001},
        'dynamic': {'key': (*KEY[:2], 0x800000, KEY[3], KEY[4])},
        'hooked': {'key': (*KEY[:4], OTHER)},
        'cache-59': {'age': 59},
        'stale': {'age': 60, 'failure': 'http_503'},
        'cache-300': {'age': 300, 'failure': 'http_503'},
        'expired': {'age': 301, 'failure': 'http_503'},
        'snapshot-120': {'now': 1120}, 'snapshot-121': {'now': 1121},
        'snapshot-300': {'now': 1300}, 'snapshot-expired': {'now': 1301},
        'future-retrieval': {'now': 1009},
        'rejected-currencies': {'base': OTHER}, 'rejected-dex': {'dex': 'other-dex'},
        'provider-unavailable': {'failure': 'http_503'},
        'provider-rate-limited': {'failure': 'http_429'},
    }
    for name, arguments in variants.items():
        add(f'fixtures/producer/pool-market.{name}.json', response(**arguments))
    available = files['fixtures/producer/pool-market.available.json']
    add('fixtures/responses/pool-market.json', available)
    files['fixtures/requests/pool-market.json'] = {'poolId': available['poolId']}
    for mode in ('disabled', 'live_read_only'):
        add('fixtures/capabilities.' + ('disabled' if mode == 'disabled' else 'enabled') + '.json', {
            'contractVersion': CONTRACT_VERSION, 'dataMode': mode, 'chainId': 4663,
            'enabledReads': [] if mode == 'disabled' else ['pool-market'],
            'walletAuthentication': False, 'privateAccounts': False,
            'ownerTransactions': False, 'automation': False}, route='capabilities')

    mutations = {
        'outer-pool': (('poolId',), '0x' + 'f' * 64),
        'estimate-pool': (('estimate', 'poolId'), '0x' + 'f' * 64),
        'market-pool': (('market', 'poolId'), '0x' + 'f' * 64),
        'apr-tampered': (('estimate', 'feeAprEstimate24hPercent'), '10.950000000000000001'),
        'apr-float': (('estimate', 'feeAprEstimate24hPercent'), 10.95),
        'apr-null-current': (('estimate', 'feeAprEstimate24hPercent'), None),
        'inputs-volume': (('estimate', 'inputs', 'volume24hUsd'), '1001'),
        'inputs-protocol': (('estimate', 'inputs', 'protocolFeeRaw'), 1),
        'source-url': (('estimate', 'provenance', 'sourceUrl'), 'https://wrong.invalid/'),
        'retrieval-reset': (('estimate', 'provenance', 'retrievedAt'), 1011),
        'snapshot-hash': (('estimate', 'provenance', 'snapshot', 'hash'), '0x' + 'f' * 64),
        'cache-age': (('estimate', 'provenance', 'effectiveMarketAgeSeconds'), 1),
        'limitation-removed': (('estimate', 'limitations'), []),
        'execution': (('executionAvailable',), True),
        'version': (('schemaVersion',), 2),
    }
    for name, (path, value) in mutations.items():
        changed = deepcopy(available)
        parent = changed
        for part in path[:-1]:
            parent = parent[part]
        parent[path[-1]] = value
        add(f'fixtures/invalid/pool-market.{name}.json', changed, valid=False)
    stale = deepcopy(files['fixtures/producer/pool-market.stale.json'])
    stale['estimate'].update(status='available', reasons=[])
    add('fixtures/invalid/pool-market.stale-promoted.json', stale, valid=False)
    blocked = deepcopy(files['fixtures/producer/pool-market.protocol-fee.json'])
    blocked['estimate'].update(status='available', reasons=[], feeAprEstimate24hPercent='10.95')
    add('fixtures/invalid/pool-market.protocol-promoted.json', blocked, valid=False)

    request = files['fixtures/requests/pool-market.json']
    requests = [{'name': 'valid', 'route': 'pool-market', 'payload': request, 'valid': True}]
    for name, payload in (
            ('uppercase', {'poolId': '0x' + request['poolId'][2:].upper()}),
            ('short', {'poolId': '0x123'}), ('missing', {}),
            ('array', [request]), ('null', None),
            ('newline', {'poolId': request['poolId'] + '\n'}),
            ('chart', {**request, 'includePriceHistory': True}),
            ('clock', {**request, 'now': 1010}), ('volume', {**request, 'volume24hUsd': '1'})):
        requests.append({'name': name, 'route': 'pool-market', 'payload': payload, 'valid': False})
    requests.append({'name': 'wrong-route', 'route': 'token', 'payload': request, 'valid': False})
    files['fixtures/request-boundaries.json'] = requests
    files['fixtures/errors.json'] = [{'status': status, 'payload': {'error': code}}
                                   for code, status in sorted(ERROR_STATUS_BY_CODE.items())]
    files['fixtures/index.json'] = {'contractVersion': CONTRACT_VERSION, 'fixtures': index}
    return files
