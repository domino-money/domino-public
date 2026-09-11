"""Contract evidence from the real service and real adapters, entirely offline."""
import copy
from dataclasses import asdict
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'backend/tests'))
from bridge_state import OpaqueCursors
from discovery import DataError, PoolKey, ZERO, POOL_MANAGER
from inventory import AlchemyInventory, CursorCodec
from market_cache import MarketCache
from market_data import GeckoMarketData
from read_contract import (CONTRACT_VERSION, ERROR_STATUS_BY_CODE, RESPONSE_MODELS,
                           BridgeCapabilities, JS_MAX_SAFE_INTEGER, export_contract, sanitize_error, validate_response)
from read_service import ReadService
from test_discovery import FakeRpc, TOKEN, OTHER, OWNER, POOL, KEY, candidate
from test_inventory import ProviderTransport, page, URL
from test_nft_ownership import NftRpc


class MetadataRpc(FakeRpc):
    def __init__(self, *, decimals=6, symbol='TOKEN', code='0x6000', balance=2**255+123):
        super().__init__()
        self.decimals, self.text, self.code, self.balance = decimals, symbol, code, balance

    def request(self, method, params=()):
        if method == 'eth_getCode' and params[0] == TOKEN:
            if isinstance(self.code, Exception): raise self.code
            return self.code
        return super().request(method, params)

    def call(self, target, signature, *args, **kwargs):
        if target == TOKEN and signature == 'decimals()':
            if isinstance(self.decimals, Exception): raise self.decimals
            if self.decimals is None: raise DataError('rpc_error')
            return (self.decimals,)
        if target == TOKEN and signature == 'balanceOf(address)': return (self.balance,)
        return super().call(target, signature, *args, **kwargs)

    def symbol(self, target, *, block):
        return self.text if target == TOKEN else super().symbol(target, block=block)


def service(rpc=None, *, discovery=None, inventory=None, market=None, catalogue=None):
    rpc = rpc or FakeRpc()
    transport = discovery if discovery is not None else lambda url: [candidate()]
    return ReadService(rpc_factory=lambda: rpc, clock=lambda: 1010,
                       transport_factory=lambda: transport, inventory=inventory,
                       cursor_codec=CursorCodec(secret=b'fixture-key-is-not-a-secret-000000', clock=lambda: 1010),
                       market_cache=market, catalogue=catalogue)


class MarketTransport:
    """Fake HTTP; the production Gecko parser and MarketCache build every field."""
    def __init__(self):
        self.failure = None
        self.volume, self.liquidity = '0', '12345.670000000000000001'
        self.dex, self.base, self.quote = 'uniswap-v4-robinhood', TOKEN, ZERO
        self.rows = [[0, '1.000000000000000001', '1.1', '0.9', '1.05', '0']]

    def __call__(self, url, **kwargs):
        if self.failure: raise DataError(self.failure)
        if '/ohlcv/' in url:
            return {'data': {'type': 'ohlcv_request_response', 'attributes': {'ohlcv_list': self.rows}},
                    'meta': {'base': {'address': self.base}, 'quote': {'address': self.quote}}}
        return {'data': {'id': 'robinhood_'+POOL, 'type': 'pool',
                         'attributes': {'address': POOL, 'reserve_in_usd': self.liquidity,
                                        'volume_usd': {'h24': self.volume}},
                         'relationships': {
                             'base_token': {'data': {'id': 'robinhood_'+self.base, 'type': 'token'}},
                             'quote_token': {'data': {'id': 'robinhood_'+self.quote, 'type': 'token'}},
                             'dex': {'data': {'id': self.dex, 'type': 'dex'}}}}}


class CatalogueFixture:
    def lookup(self, token, **kwargs):
        return {'chainId': 4663, 'poolManager': POOL_MANAGER, 'revision': 2, 'startBlock': 10,
                'indexedThrough': 650, 'coverage': 'configured_interval_only',
                'completeHistory': False, 'liveExecution': False, 'hasMore': False,
                'nextAfterPoolId': None, 'items': [
                    {'poolId': POOL, 'poolKey': asdict(PoolKey(*KEY)), 'currencies': [ZERO, TOKEN],
                     'providerMetrics': None, 'catalogueSource': 'initialize_event',
                     'catalogueObservation': {'number': 500, 'hash': '0x'+'cd'*32},
                     'identityStatus': 'catalogue_candidate', 'executionAvailable': False}]}


def build_fixtures():
    """Regeneration is deterministic: fixed fake clocks, keys and upstream data."""
    files, index = {}, []

    def add(route, name, payload, *, kind='producer', status=200, valid=True):
        path = f'fixtures/{kind}/{route}.{name}.json'
        if valid and status == 200: validate_response(route, payload)
        files[path] = copy.deepcopy(payload)
        index.append({'file': path, 'route': route, 'kind': kind, 'status': status, 'valid': valid})

    add('token', 'success', service().token(TOKEN))
    add('token', 'native', service().token(ZERO))
    add('token', 'missing-decimals', service(MetadataRpc(decimals=None)).token(TOKEN))
    add('token', 'call-gas-limit', service(MetadataRpc(decimals=DataError('rpc_call_gas_limit'))).token(TOKEN))
    add('token', 'metadata-reverted', service(MetadataRpc(decimals=DataError('rpc_call_reverted'))).token(TOKEN))
    add('token', 'zero-decimals', service(MetadataRpc(decimals=0)).token(TOKEN))
    add('token', 'missing-contract', service(MetadataRpc(code='0x')).token(TOKEN))
    add('token', 'unavailable', service(MetadataRpc(code=DataError('rpc_error'))).token(TOKEN))
    add('token', 'untrusted-symbol', service(MetadataRpc(symbol='<img src=x onerror=alert(1)>')).token(TOKEN))

    add('pools', 'success', service().pools(TOKEN))
    add('pools', 'missing', service(discovery=lambda url: []).pools(TOKEN))
    add('pools', 'partial-metadata', service(MetadataRpc(decimals=None)).pools(TOKEN))
    def unavailable(url): raise DataError('network_unavailable')
    add('pools', 'provider-unavailable', service(discovery=unavailable).pools(TOKEN, pool_ids=[POOL]))
    raw = candidate(); raw['volume']['h24'] = '0'; raw['liquidity']['usd'] = None
    add('pools', 'zero-and-missing-metrics', service(discovery=lambda url: [raw]).pools(TOKEN))
    bad = candidate(); bad['quoteToken']['address'] = OTHER
    add('pools', 'rejected-candidate', service(discovery=lambda url: [bad]).pools(TOKEN))
    add('pools', 'catalogue', service(catalogue=CatalogueFixture()).pools(TOKEN, pool_ids=[POOL]))

    add('wallet-assets', 'fallback', service().wallet_assets(OWNER, [TOKEN]))
    add('wallet-assets', 'zero', service(MetadataRpc(balance=0)).wallet_assets(OWNER, [TOKEN]))
    add('wallet-assets', 'partial-metadata', service(MetadataRpc(decimals=None)).wallet_assets(OWNER, [TOKEN]))
    add('wallet-assets', 'call-gas-limit', service(MetadataRpc(decimals=DataError('rpc_call_gas_limit'))).wallet_assets(OWNER, [TOKEN]))
    add('wallet-assets', 'missing-contract', service(MetadataRpc(code='0x')).wallet_assets(OWNER, [TOKEN]))
    add('wallet-assets', 'not-requested', service().wallet_assets(OWNER, [TOKEN], auto_discover=False))
    provider = AlchemyInventory(URL, transport=ProviderTransport([page([TOKEN], 'internal-provider-page-2'), page([])]), clock=lambda: 1010)
    paged = service(inventory=provider)
    first = paged.wallet_assets(OWNER, [TOKEN])
    add('wallet-assets', 'page', first)
    browser = copy.deepcopy(first)
    cursors = OpaqueCursors(clock=lambda: 1010)
    cursors.observe_generation('12'*16)
    context = {'wallet': OWNER, 'tokens': [TOKEN], 'autoDiscover': True}
    with patch('bridge_state.secrets.token_hex', return_value='ab'*32) as random_handle:
        browser['inventory']['nextCursor'] = cursors.wrap(first['inventory']['nextCursor'], context)
        random_handle.assert_called_once_with(32)
    add('wallet-assets', 'opaque-page', browser, kind='gateway')
    # Exercise the actual gateway exchange before the production service fetches
    # page two. The only stub is handle randomness, so exported bytes are stable.
    restored = cursors.unwrap(browser['inventory']['nextCursor'], context)
    if restored != first['inventory']['nextCursor']:
        raise AssertionError('gateway cursor did not preserve producer pagination')
    add('wallet-assets', 'last-page', paged.wallet_assets(OWNER, [TOKEN], cursor=restored))
    def failed_inventory(*args): raise DataError('http_503')
    add('wallet-assets', 'provider-unavailable', service(inventory=AlchemyInventory(URL, transport=failed_inventory)).wallet_assets(OWNER, [TOKEN]))

    def market_setup():
        transport, now = MarketTransport(), [0]
        cache = MarketCache(GeckoMarketData(transport=transport, clock=lambda: 1010), clock=lambda: now[0])
        return service(market=cache), transport, now
    market_service, transport, now = market_setup()
    add('pool-market', 'success', market_service.pool_market(POOL, include_price_history=True))
    add('pool-market', 'not-requested', market_service.pool_market(POOL))
    now[0] = 61; transport.failure = 'http_503'
    add('pool-market', 'stale', market_service.pool_market(POOL, include_price_history=True))
    now[0] = 301
    add('pool-market', 'expired', market_service.pool_market(POOL, include_price_history=True))
    for name, updates in [('missing', {'volume': None, 'liquidity': None, 'rows': []}),
                          ('zero', {'volume': '0', 'liquidity': '0'}),
                          ('rejected', {'dex': 'another-dex'}),
                          ('rejected-currencies', {'base': OTHER}),
                          ('provider-rate-limited', {'failure': 'http_429'}),
                          ('provider-timeout', {'failure': 'network_unavailable'})]:
        current, transport, now = market_setup()
        for key, value in updates.items(): setattr(transport, key, value)
        add('pool-market', name, current.pool_market(POOL, include_price_history=True, price_token='quote'))

    rpc = NftRpc(); rpc.liquidity = 2**100
    add('nft-positions', 'success', service(rpc).nft_positions(['1', str(2**255+1)]))
    rpc = NftRpc(); rpc.empty = True
    add('nft-positions', 'empty', service(rpc).nft_positions(['1']))
    rpc = NftRpc(); rpc.liquidity = 0
    add('nft-positions', 'zero', service(rpc).nft_positions(['1']))
    class HistoricalRpc(NftRpc):
        def request(self, method, params=()):
            result = super().request(method, params)
            if method == 'eth_getBlockByNumber' and params[0] == hex(650):
                result['timestamp'] = hex(800)
            return result
    add('nft-positions', 'stale', service(HistoricalRpc()).nft_positions(['1'], 650))

    add('catalogue', 'success', service(catalogue=CatalogueFixture()).catalogue_page(TOKEN))
    class EmptyCatalogue(CatalogueFixture):
        def lookup(self, token, **kwargs):
            return {**super().lookup(token, **kwargs), 'items': []}
    add('catalogue', 'empty', service(catalogue=EmptyCatalogue()).catalogue_page(TOKEN))
    from read_history_fixtures import historical_fixtures
    for route, name, payload in historical_fixtures(): add(route, name, payload)

    # Full gateway transformation of real producer results, not a handwritten mock.
    from read_gateway import Gateway
    from read_api import ReadGate
    class Verifier:
        def verify(self, value):
            if value != 'fixture_assertion': raise AssertionError('wrong fixture assertion')
    class Upstream:
        def __init__(self, payload): self.payload = payload
        def request(self, route, body=None, **kwargs):
            if route == 'health':
                return 200, {'mode':'local_read_only','status':'ok','readBudgetSeconds':15,
                             'busy':False,'generation':'12'*16}, {}
            return 200, self.payload, {'contract':CONTRACT_VERSION,'generation':'12'*16}
    for entry in list(index):
        if entry['kind'] != 'producer': continue
        payload = files[entry['file']]
        gate = ReadGate(interval=0)
        gateway = Gateway(verifier=Verifier(), upstream=Upstream(payload), gate=gate, cursors=OpaqueCursors(clock=lambda:1010))
        if not gate.enter(): raise AssertionError('fixture gate unavailable')
        body = {'wallet':OWNER,'tokens':[TOKEN],'autoDiscover':True} if entry['route']=='wallet-assets' else {}
        with patch('bridge_state.secrets.token_hex', return_value='ab'*32):
            status, browser = gateway.execute(entry['route'], body, 'fixture_assertion', '192.0.2.10', gateway.clock()+20)
        if status != 200: raise AssertionError((entry['file'], status, browser))
        add(entry['route'], entry['file'].split('.',1)[1].removesuffix('.json'), browser, kind='gateway')

    for mode in ('disabled', 'live_read_only'):
        add('capabilities', mode, {'contractVersion': CONTRACT_VERSION, 'dataMode': mode, 'chainId': 4663,
                                  'enabledReads': [] if mode == 'disabled' else list(RESPONSE_MODELS),
                                  'walletAuthentication': False, 'privateAccounts': False,
                                  'ownerTransactions': False, 'automation': False}, kind='gateway')
    for route in RESPONSE_MODELS:
        for code in ('invalid_request', 'read_capacity_busy', 'upstream_timeout',
                     'upstream_unavailable', 'upstream_contract_mismatch', 'stale_or_future_block',
                     'rpc_call_gas_limit', 'rpc_call_reverted'):
            status, body = sanitize_error(code)
            add(route, code, body, kind='error', status=status)
        source = next(item['file'] for item in index if item['route'] == route and item['kind'] == 'producer')
        incompatible = copy.deepcopy(files[source]); incompatible['schemaVersion'] = 999
        add(route, 'incompatible-version', incompatible, kind='invalid', valid=False)
    for route, code in [('wallet-assets', 'invalid_or_expired_cursor'), ('pools', 'catalogue_revision_changed')]:
        status, body = sanitize_error(code)
        add(route, code, body, kind='error', status=status)
    reference_as_current = copy.deepcopy(files['fixtures/producer/pool-metrics.reference-analytics.json'])
    reference_as_current['usableAsCurrent24h'] = True
    add('pool-metrics', 'reference-claimed-current', reference_as_current, kind='invalid', valid=False)
    requests = []
    for route, payload in {
        'token': {'token': TOKEN},
        'pools': {'token': TOKEN, 'pairedToken': ZERO, 'maxPools': 1, 'poolIds': [POOL]},
        'pool-market': {'poolId': POOL, 'includePriceHistory': True, 'priceToken': 'base'},
        'wallet-assets': {'wallet': OWNER, 'tokens': [TOKEN], 'autoDiscover': True},
        'nft-positions': {'tokenIds': ['1', str(2**255+1)], 'blockNumber': 700},
        'catalogue': {'token':TOKEN, 'pairedToken':ZERO, 'limit':20},
        'pool-activity': {'poolId':POOL}, 'pool-positions': {'poolId':POOL}, 'pool-metrics': {'poolId':POOL},
    }.items():
        path = f'fixtures/requests/{route}.json'
        files[path] = payload
        requests.append({'file': path, 'route': route})
    files['fixtures/index.json'] = {'contractVersion': CONTRACT_VERSION, 'fixtures': index, 'requests': requests}
    return files


class ReadContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = build_fixtures()

    def fixture(self, route, name='success'):
        return copy.deepcopy(self.fixtures[f'fixtures/producer/{route}.{name}.json'])

    def test_production_responses_roundtrip_unchanged(self):
        for entry in self.fixtures['fixtures/index.json']['fixtures']:
            if entry['status'] != 200: continue
            payload = self.fixtures[entry['file']]
            if not entry['valid']:
                with self.subTest(file=entry['file']), self.assertRaises(ValueError):
                    validate_response(entry['route'], payload)
                continue
            with self.subTest(file=entry['file']):
                before = json.dumps(payload, sort_keys=True)
                self.assertIs(validate_response(entry['route'], payload), payload)
                self.assertEqual(json.dumps(payload, sort_keys=True), before)

    def test_every_required_nested_field_and_unknown_field_are_rejected(self):
        for route, name in [('token', 'success'), ('pools', 'catalogue'), ('pool-market', 'success'),
                            ('wallet-assets', 'page'), ('nft-positions', 'success')]:
            original = self.fixture(route, name)
            def walk(value, path=()):
                if isinstance(value, dict):
                    for key, child in value.items():
                        yield path+(key,)
                        yield from walk(child, path+(key,))
                elif isinstance(value, list):
                    for i, child in enumerate(value): yield from walk(child, path+(i,))
            optional = {'requestedById', 'catalogueSource', 'catalogueObservation', 'providerCurrencyConflict'}
            for path in walk(original):
                if path[-1] in optional: continue
                broken = copy.deepcopy(original); cursor = broken
                for key in path[:-1]: cursor = cursor[key]
                cursor['renamed_'+str(path[-1])] = cursor.pop(path[-1])
                with self.subTest(route=route, path=path), self.assertRaises(ValueError):
                    validate_response(route, broken)
            for path in [('snapshot',), ()]:
                broken = copy.deepcopy(original); cursor = broken
                for key in path: cursor = cursor[key]
                cursor['unexpected'] = 'untrusted'
                with self.subTest(route=route, path=path), self.assertRaises(ValueError):
                    validate_response(route, broken)

    def test_required_nested_omission_fails_without_model_default_repair(self):
        for route, path in [('token', ('asset', 'decimals')),
                            ('pools', ('pools', 0, 'providerMetrics', 'volume24hUsd')),
                            ('pool-market', ('priceHistory', 'data', 'coverage', 'closedCandles')),
                            ('pool-market', ('market', 'data', 'reportedLiquidityUsd')),
                            ('wallet-assets', ('inventory', 'rowsReceived')),
                            ('nft-positions', ('items', 0, 'unsettledFeesRaw'))]:
            payload = self.fixture(route, 'page' if route == 'wallet-assets' else 'success')
            node = payload
            for key in path[:-1]: node = node[key]
            del node[path[-1]]
            with self.subTest(route=route, path=path), self.assertRaises(ValueError): validate_response(route, payload)

    def test_no_numeric_string_boolean_or_unknown_enum_coercion(self):
        cases = [('token', 'success', ('schemaVersion',), True),
                 ('token', 'success', ('liveExecution',), 0),
                 ('token', 'success', ('snapshot', 'number'), '700'),
                 ('token', 'success', ('asset', 'decimals'), '6'),
                 ('token', 'success', ('asset', 'readStatus'), 'new_undocumented_state'),
                 ('wallet-assets', 'fallback', ('items', 1, 'amountRaw'), 2**255+123),
                 ('wallet-assets', 'fallback', ('items', 1, 'amountRaw'), '1e30'),
                 ('wallet-assets', 'fallback', ('items', 1, 'amountRaw'), str(2**256)),
                 ('pool-market', 'success', ('market', 'data', 'volume24hUsd'), 0),
                 ('pool-market', 'success', ('market', 'cache', 'ageSeconds'), '0'),
                 ('pool-market', 'success', ('market', 'status'), 'live'),
                 ('pool-market', 'success', ('pool', 'poolKey', 'fee_pips'), 8388608.0),
                 ('pool-market', 'success', ('priceHistory', 'data', 'candles', 0, 'openUsd'), 'NaN'),
                 ('nft-positions', 'success', ('items', 0, 'tokenId'), 1)]
        for route, name, path, replacement in cases:
            value = self.fixture(route, name); node = value
            for key in path[:-1]: node = node[key]
            node[path[-1]] = replacement
            with self.subTest(route=route, path=path), self.assertRaises(ValueError): validate_response(route, value)

    def test_null_decimals_zero_and_untrusted_symbol_preserve_meaning(self):
        self.assertIsNone(self.fixture('token', 'missing-decimals')['asset']['decimals'])
        self.assertEqual(self.fixture('token', 'zero-decimals')['asset']['decimals'], 0)
        xss = self.fixture('token', 'untrusted-symbol')
        validate_response('token', xss)
        self.assertEqual(xss['asset']['symbol'], '<img src=x onerror=alert(1)>')
        wallet = self.fixture('wallet-assets', 'fallback')
        self.assertEqual(wallet['items'][0]['amountRaw'], '0')
        self.assertEqual(wallet['items'][1]['amountRaw'], str(2**255+123))
        self.assertIsNone(self.fixture('pool-market', 'missing')['market']['data']['volume24hUsd'])
        self.assertEqual(self.fixture('pool-market', 'zero')['market']['data']['volume24hUsd'], '0')

    def test_gateway_cursor_substitution_preserves_every_other_field_and_type(self):
        producer = self.fixture('wallet-assets', 'page')
        gateway = copy.deepcopy(self.fixtures['fixtures/gateway/wallet-assets.opaque-page.json'])
        local, opaque = producer['inventory']['nextCursor'], gateway['inventory']['nextCursor']
        self.assertIs(type(local), str); self.assertIs(type(opaque), str)
        self.assertNotEqual(local, opaque)
        self.assertRegex(opaque, r'^[0-9a-f]{64}$')
        cursors = OpaqueCursors(clock=lambda: 1010)
        cursors.observe_generation('12'*16)
        context = {'wallet': OWNER, 'tokens': [TOKEN], 'autoDiscover': True}
        with patch('bridge_state.secrets.token_hex', return_value=opaque) as random_handle:
            self.assertEqual(cursors.wrap(local, context), opaque)
            random_handle.assert_called_once_with(32)
        self.assertEqual(cursors.unwrap(opaque, context), local)
        for rejected in ('A'*43, opaque.upper()):
            with self.assertRaisesRegex(DataError, 'invalid_or_expired_cursor'):
                cursors.unwrap(rejected, context)
        with self.assertRaisesRegex(DataError, 'invalid_or_expired_cursor'):
            cursors.unwrap(opaque, {**context, 'wallet': OTHER})
        last_page = self.fixture('wallet-assets', 'last-page')
        self.assertFalse(last_page['inventory']['hasMore'])
        self.assertIsNone(last_page['inventory']['nextCursor'])
        self.assertNotIn('internal-provider-page-2', opaque)
        gateway['inventory']['nextCursor'] = local
        self.assertEqual(gateway, producer)

    def test_finite_errors_sanitize_arbitrary_provider_details(self):
        for code, expected in ERROR_STATUS_BY_CODE.items():
            self.assertEqual(sanitize_error(code), (expected, {'error': code}))
        for unknown in ('https://secret.invalid/key', '<html>login</html>', 'some_new_error', None):
            self.assertEqual(sanitize_error(unknown), (503, {'error': 'upstream_unavailable'}))
        self.assertEqual(sanitize_error('invalid_request'), (422, {'error': 'invalid_request'}))

    def test_http_producer_validates_all_five_routes_and_documents_safe_422(self):
        from fastapi.testclient import TestClient
        from read_api import ReadGate, create_app
        transport = MarketTransport()
        cache = MarketCache(GeckoMarketData(transport=transport, clock=lambda: 1010))
        actual = service(NftRpc(), market=cache, catalogue=CatalogueFixture())
        client = TestClient(create_app(actual, gate=ReadGate(interval=0)), base_url='http://127.0.0.1')
        for entry in self.fixtures['fixtures/index.json']['requests']:
            route = entry['route']
            if route in ('pool-activity', 'pool-positions', 'pool-metrics'): continue  # exercised end-to-end below
            response = client.post('/v1/read/'+route, json=self.fixtures[entry['file']])
            with self.subTest(route=route):
                self.assertEqual(response.status_code, 200, response.text)
                validate_response(route, response.json())
                self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
                rejected = client.post('/v1/read/'+route, json={'unknown': 'sensitive-input'})
                self.assertEqual(rejected.status_code, 422)
                self.assertEqual(rejected.json(), {'error': 'invalid_request'})
        openapi = client.get('/openapi.json').json()
        for route in RESPONSE_MODELS:
            responses = openapi['paths']['/v1/read/'+route]['post']['responses']
            self.assertIn('$ref', responses['200']['content']['application/json']['schema'])
            self.assertTrue(responses['422']['content']['application/json']['schema']['$ref'].endswith('/ErrorResponse'))

    def test_http_producer_rejects_nested_drift_and_sanitizes_unknown_errors(self):
        from fastapi.testclient import TestClient
        from read_api import ReadGate, create_app
        actual = service()
        original = actual.token
        def incomplete(token):
            payload = original(token)
            del payload['asset']['decimals']
            return payload
        actual.token = incomplete
        client = TestClient(create_app(actual, gate=ReadGate(interval=0)), base_url='http://127.0.0.1')
        rejected = client.post('/v1/read/token', json={'token': TOKEN})
        self.assertEqual(rejected.status_code, 502)
        self.assertEqual(rejected.json(), {'error': 'upstream_contract_mismatch'})
        def unsafe(token): raise DataError('private-provider-detail-must-not-leak')
        actual.token = unsafe
        rejected = client.post('/v1/read/token', json={'token': TOKEN})
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(rejected.json(), {'error': 'upstream_unavailable'})

    def test_all_response_objects_are_closed_and_have_real_properties(self):
        def visit(node):
            if isinstance(node, dict):
                if node.get('type') == 'object':
                    self.assertIs(node['additionalProperties'], False)
                    self.assertIn('properties', node)
                for value in node.values(): visit(value)
            elif isinstance(node, list):
                for value in node: visit(value)
        for schema in export_contract().values(): visit(schema)

    def test_every_response_integer_schema_is_javascript_safe(self):
        def visit(node):
            if isinstance(node, dict):
                if node.get('type') == 'integer':
                    if 'const' in node:
                        self.assertLessEqual(abs(node['const']), JS_MAX_SAFE_INTEGER)
                    elif 'enum' in node:
                        self.assertTrue(all(abs(v) <= JS_MAX_SAFE_INTEGER for v in node['enum']))
                    else:
                        self.assertGreaterEqual(node['minimum'], -JS_MAX_SAFE_INTEGER)
                        self.assertLessEqual(node['maximum'], JS_MAX_SAFE_INTEGER)
                for child in node.values(): visit(child)
            elif isinstance(node, list):
                for child in node: visit(child)
        for schema in export_contract().values(): visit(schema)

    def test_response_integer_boundaries_and_raw_amounts_preserve_exactness(self):
        cases = [
            ('token', 'success', ('snapshot', 'number')),
            ('pools', 'success', ('discovery', 'returned')),
            ('pool-market', 'success', ('market', 'data', 'retrievedAt')),
            ('wallet-assets', 'fallback', ('snapshot', 'timestamp')),
            ('nft-positions', 'success', ('freshness', 'ageSeconds')),
            ('catalogue', 'success', ('revision',)),
            ('catalogue', 'success', ('startBlock',)),
            ('catalogue', 'success', ('indexedThrough',)),
            ('pool-activity', 'success', ('storedEventCount',)),
            ('pool-activity', 'success', ('window24h', 'fromTimestampExclusive')),
            ('pool-positions', 'success', ('positionAccounting', 'onchainReconciliation', 'blockNumber')),
            ('pool-metrics', 'qualified', ('capital', 'sourceEventCount')),
        ]
        for route, name, path in cases:
            for value, valid in [(JS_MAX_SAFE_INTEGER, True), (JS_MAX_SAFE_INTEGER+1, False),
                                 (True, False), (float(JS_MAX_SAFE_INTEGER), False)]:
                payload = self.fixture(route, name); node = payload
                for segment in path[:-1]: node = node[segment]
                node[path[-1]] = value
                with self.subTest(route=route, path=path, value=value):
                    if valid: self.assertIs(validate_response(route, payload), payload)
                    else:
                        with self.assertRaises(ValueError): validate_response(route, payload)
        for value, valid in [(-JS_MAX_SAFE_INTEGER, True), (-JS_MAX_SAFE_INTEGER-1, False)]:
            payload = self.fixture('pool-activity', 'success')
            payload['window24h']['fromTimestampExclusive'] = value
            if valid: validate_response('pool-activity', payload)
            else:
                with self.assertRaises(ValueError): validate_response('pool-activity', payload)
        payload = self.fixture('wallet-assets', 'fallback')
        payload['items'][1]['amountRaw'] = str(2**256-1)
        self.assertIs(validate_response('wallet-assets', payload), payload)
        payload['items'][1]['amountRaw'] = str(2**256)
        with self.assertRaises(ValueError): validate_response('wallet-assets', payload)

    def test_checked_in_contract_package_is_reproducible(self):
        result = subprocess.run([sys.executable, str(ROOT/'scripts/export-read-contract.py'), '--check'],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
