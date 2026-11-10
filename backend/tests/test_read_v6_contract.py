"""read-v6: the contract package, the reader's routes, the gateway and the bridge client.

The package is generated from the producer (scripts/export-read-v6-contract.py)
and must match it byte for byte; its fixtures are answers the producer builds
and answers with one defect each, which the producer and the hand-written
runtime (node) must accept and refuse alike. The routes serve the V2 index's
answers only for the wallet asked, only on the stored lane, only to local
clients, and the gateway serves them only under its own flag.
"""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge_http import LocalReaderHTTP  # noqa: E402
from discovery import DataError  # noqa: E402
from read_api import ReadGate, create_app  # noqa: E402
from read_gateway import Gateway, create_gateway  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_read_contract import (BALANCE_CHAIN_IDS, CHAIN_IDS, CONTRACT_VERSION, CONTRACT_VERSIONS,  # noqa: E402
                              MAX_FEE_POSITIONS, NEXT_ROUTES, NEXT_VERSION, REQUEST_MODELS, ROUTES, STORED_ROUTES,
                              V2_ERRORS, answered_version, cursor_key, error_of, validate_v6_request_response,
                              validate_v6_response)
import read_v6_contract_fixtures as fixtures  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'api-contracts/read-v6'
HEADER = {'Cf-Access-Jwt-Assertion': 'a.b.c', 'X-Domino-Client-Id': '192.0.2.1'}
_spec = importlib.util.spec_from_file_location('read_v6_exporter', ROOT / 'scripts/export-read-v6-contract.py')
exporter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(exporter)
WALLET = fixtures.WALLET


class Reader:
    """A V2 read service answering the shared fixtures, the way V2ReadService answers."""
    def __init__(self, change=None, fail=None):
        self.change, self.fail, self.calls = change, fail, []

    def _answer(self, name, wallet):
        if self.fail:
            raise DataError(self.fail)
        body = copy.deepcopy(fixtures.valid()[name])
        body['wallet'] = wallet if wallet == WALLET else body['wallet']
        return self.change(body) if self.change else body

    def portfolio(self, wallet):
        self.calls.append(('portfolio', wallet))
        return self._answer('portfolio', wallet)

    def activity(self, wallet, limit, cursor):
        self.calls.append(('activity', wallet, limit, cursor))
        return self._answer('activity-page' if limit == 3 else 'activity', wallet)

    def position_fees(self, chain_id, positions):
        self.calls.append(('position-fees', chain_id, positions))
        if self.fail:
            raise DataError(self.fail)
        body = copy.deepcopy(fixtures.next_valid()['position-fees'])
        return self.change(body) if self.change else body


def reader_client(v2_reader, chain_reads=None):
    return TestClient(create_app(object(), gate=ReadGate(interval=0), read_budget_seconds=15, v2_reader=v2_reader,
                                 chain_reads=chain_reads), base_url='http://127.0.0.1:8876')


class ChainReads:
    """The live reads answering the shared fixtures, the way v2_chain_reads.ChainReads answers."""
    def __init__(self, change=None, fail=None):
        self.change, self.fail, self.calls = change, fail, []

    def _answer(self, name):
        if self.fail:
            raise DataError(self.fail)
        body = copy.deepcopy(fixtures.valid()[name])
        return self.change(body) if self.change else body

    def pools(self, chain_id, token, paired):
        self.calls.append(('pools', chain_id, token, paired))
        return self._answer('chain-pools-paired' if paired else 'chain-pools')

    def balances(self, wallet, tokens):
        self.calls.append(('balances', wallet, tokens))
        return self._answer('chain-balances' if tokens is None else 'chain-balances-asked')

    def tokens(self, chain_id, query, limit):
        self.calls.append(('tokens', chain_id, query, limit))
        return self._answer('chain-tokens')


def gateway_client(reader, **enabled):
    return TestClient(create_gateway(Gateway(verifier=Mock(), upstream=LocalReaderHTTP(client=reader),
                                             gate=ReadGate(interval=0), **enabled)),
                      base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))


class PackageTests(unittest.TestCase):
    def test_the_package_is_what_the_producer_exports(self):
        expected = exporter.build()
        for name, value in expected.items():
            with self.subTest(file=name):
                self.assertEqual((PACKAGE / name).read_text(), value)
        on_disk = {path.relative_to(PACKAGE).as_posix() for path in PACKAGE.glob('fixtures/**/*.json')}
        self.assertEqual(on_disk, {name for name in expected if name.startswith('fixtures/')})

    def test_the_price_profiles_are_the_chain_profiles(self):
        # Qualified USD checks each chain's stable, wrapped token and feed from this table: it is the profiles', the
        # balance chains' (chain-balances' Ethereum and OP Mainnet) included, and every chain chain-balances reads has one.
        from v2_chains import default_balance_registry, default_registry
        from v2_read_contract import PRICE_PROFILES
        # Changed on purpose 2026-11-09 (Elysium's services): a chain without Chainlink (Elysium) has its native pool
        # instead of a feed, so each entry is held to v2_chain_reads.price_profile, the producer's own shape.
        from v2_chain_reads import price_profile
        registry, balances = default_registry(), default_balance_registry()
        self.assertEqual(sorted(PRICE_PROFILES), list(BALANCE_CHAIN_IDS))
        for chain_id, profile in PRICE_PROFILES.items():
            chain = (registry if chain_id in CHAIN_IDS else balances).chain(chain_id)
            stable = min(chain.chargeCurrencies, key=lambda currency: (currency.rank, currency.address))
            with self.subTest(chain=chain_id):
                self.assertEqual(profile, price_profile(chain))
                self.assertEqual((profile['stable'], profile['wrapped']),
                                 (stable.address.lower(), chain.wrappedNative.address.lower()))
                self.assertEqual('nativePool' in profile, chain_id == 99901)

    def test_the_chains_are_the_enabled_profiles_with_a_deployment(self):
        # Changed on purpose 2026-11-09 (Elysium's mainnet): a profile is enabled to deploy V2 on its chain, and read-v6
        # serves the chain once that deployment's record is in the repository (docs/deployments/v2-<slug>-<id>-<date>).
        # Between the two, Elysium (99901) is the only chain allowed to wait; its record and read-v6 move together.
        # Changed on purpose 2026-11-09 (Elysium's services): read-v6 names Elysium (99901), deployed that day.
        def deployed(profile):
            return any((ROOT / 'docs/deployments').glob(f'v2-{profile.slug}-{profile.chainId}-*/deployment.json'))
        chains = default_registry().chains
        self.assertEqual(CHAIN_IDS, tuple(profile.chainId for profile in chains if deployed(profile)))
        self.assertEqual(CHAIN_IDS, tuple(profile.chainId for profile in chains))

    def test_chain_balances_reads_the_domino_chains_and_the_balance_chains(self):
        import v2_chain_reads
        from v2_chains import default_balance_registry
        balances = tuple(profile.chainId for profile in default_balance_registry().chains)
        self.assertEqual((balances, v2_chain_reads.BALANCE_CHAINS), ((1, 10), (1, 10)))
        self.assertEqual(BALANCE_CHAIN_IDS, tuple(sorted(CHAIN_IDS + balances)))

    def test_the_error_names_are_those_the_v2_sources_declare(self):
        # A waiting reason names a contract error only when V2 declares it; the
        # automation's code is the name in snake case, which maps back one to one.
        import re
        declared = set()
        for path in (ROOT / 'contracts/src/v2').rglob('*.sol'):
            declared |= set(re.findall(r'^\s*error\s+([A-Za-z0-9_]+)\s*\(', path.read_text(), re.M))
        self.assertEqual(V2_ERRORS, tuple(sorted(declared)))
        self.assertEqual(error_of('reverted_spot_outside_band'), 'SpotOutsideBand')
        self.assertEqual(error_of('reverted_twap_window_too_short'), 'TwapWindowTooShort')
        self.assertEqual(error_of('reverted_twap_window_too_long'), 'TwapWindowTooLong')
        self.assertEqual(len({error_of('reverted_' + re.sub(r'(?<!^)(?=[A-Z])', '_', n).lower()) for n in V2_ERRORS}),
                         len(V2_ERRORS))
        for code in ('trigger_not_reached', 'reverted_unknown_12345678', 'reverted_panic', 'reverted_error_string'):
            self.assertIsNone(error_of(code))

    def test_valid_fixtures_pass_and_each_defect_fails_in_the_producer(self):
        fixtures.check()
        for name in fixtures.valid():
            body = json.loads((PACKAGE / f'fixtures/valid/{name}.json').read_text())
            validate_v6_response(fixtures.route_of(name), body)
        for name, (route, _) in fixtures.invalid().items():
            body = json.loads((PACKAGE / f'fixtures/invalid/{name}.json').read_text())
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_v6_response(route, body)

    def test_the_runtime_accepts_and_refuses_the_same_answers(self):
        if shutil.which('node') is None:
            self.skipTest('node is not installed')
        result = subprocess.run(['node', '--test', 'api-contracts/read-v6/consumer.test.mjs'], cwd=ROOT,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_requests_are_a_lower_case_wallet_a_bounded_page_and_a_cursor(self):
        REQUEST_MODELS['portfolio'].model_validate({'wallet': WALLET})
        REQUEST_MODELS['activity'].model_validate({'wallet': WALLET, 'limit': 50, 'cursor': None})
        for body in ({'wallet': WALLET.upper().replace('0X', '0x')}, {'wallet': WALLET, 'chainId': 4663}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                REQUEST_MODELS['portfolio'].model_validate(body)
        for body in ({'wallet': WALLET, 'limit': 51}, {'wallet': WALLET, 'limit': '5'}, {'wallet': WALLET, 'cursor': 'x'}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                REQUEST_MODELS['activity'].model_validate(body)
        self.assertEqual(cursor_key('1790425234.4663.73391000.4'), (1790425234, 4663, 73391000, 4))
        for cursor in ('1.1.1.1', '1.4663.1.' + str(2**31), str(2**63) + '.4663.1.1'):
            with self.subTest(cursor=cursor), self.assertRaises(ValueError):
                cursor_key(cursor)

    def test_an_answer_about_another_wallet_or_too_long_a_page_is_refused(self):
        body = fixtures.valid()['activity-page']
        validate_v6_request_response('activity', {'wallet': WALLET, 'limit': 3}, body)
        with self.assertRaises(ValueError):
            validate_v6_request_response('activity', {'wallet': fixtures.OTHER, 'limit': 3}, body)
        with self.assertRaises(ValueError):
            validate_v6_request_response('activity', {'wallet': WALLET, 'limit': 2}, body)


class ChainReadContractTests(unittest.TestCase):
    TOKEN = fixtures.LIVE_TOKEN

    def test_requests_are_well_formed_and_never_ask_twice(self):
        REQUEST_MODELS['chain-pools'].model_validate({'chainId': 8453, 'token': self.TOKEN})
        REQUEST_MODELS['chain-balances'].model_validate({'wallet': WALLET})
        REQUEST_MODELS['chain-tokens'].model_validate({'chainId': 42161, 'query': ' usd '})
        # Ethereum and OP Mainnet are chain-balances' alone, and only when named.
        REQUEST_MODELS['chain-balances'].model_validate({'wallet': WALLET, 'tokens': [
            {'chainId': chain_id, 'address': self.TOKEN} for chain_id in BALANCE_CHAIN_IDS]})
        many = [{'chainId': 8453, 'address': '0x' + f'{index:040x}'} for index in range(25)]
        for route, body in (('chain-pools', {'chainId': 8453, 'token': self.TOKEN, 'pairedToken': self.TOKEN}),
                            ('chain-pools', {'chainId': 8453, 'token': self.TOKEN.upper().replace('0X', '0x')}),
                            ('chain-balances', {'wallet': WALLET, 'tokens': []}),
                            ('chain-balances', {'wallet': WALLET, 'tokens': many}),
                            ('chain-balances', {'wallet': WALLET, 'tokens': [{'chainId': 8453, 'address': self.TOKEN}] * 2}),
                            ('chain-balances', {'wallet': WALLET, 'tokens': [{'chainId': 137, 'address': self.TOKEN}]}),
                            ('chain-pools', {'chainId': 1, 'token': self.TOKEN}),
                            ('chain-pools', {'chainId': 10, 'token': self.TOKEN}),
                            ('chain-tokens', {'chainId': 10, 'query': 'usd'}),
                            ('chain-tokens', {'chainId': 4663, 'query': 'usd'}),
                            ('chain-tokens', {'chainId': 8453, 'query': '   '}),
                            ('chain-tokens', {'chainId': 8453, 'query': 'a\u0000b'}),
                            ('chain-tokens', {'chainId': 8453, 'query': 'usd', 'limit': 25}),
                            ('chain-tokens', {'chainId': 8453, 'query': 'x' * 97})):
            with self.subTest(route=route, body=str(body)[:60]), self.assertRaises(ValueError):
                REQUEST_MODELS[route].model_validate(body)

    def test_an_answer_about_another_chain_token_query_wallet_or_token_list_is_refused(self):
        valid = fixtures.valid()
        pools = valid['chain-pools']
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': self.TOKEN, 'pairedToken': None}, pools)
        for request in ({'chainId': 42161, 'token': self.TOKEN}, {'chainId': 8453, 'token': fixtures.BASE_USDC},
                        {'chainId': 8453, 'token': self.TOKEN, 'pairedToken': fixtures.BASE_WETH}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                validate_v6_request_response('chain-pools', request, pools)
        tokens = valid['chain-tokens']
        validate_v6_request_response('chain-tokens', {'chainId': 8453, 'query': 'aero', 'limit': 2}, tokens)
        for request in ({'chainId': 42161, 'query': 'aero'}, {'chainId': 8453, 'query': 'AERO'},
                        {'chainId': 8453, 'query': 'aero', 'limit': 1}):
            with self.subTest(request=request), self.assertRaises(ValueError):
                validate_v6_request_response('chain-tokens', request, tokens)
        every, asked = valid['chain-balances'], valid['chain-balances-asked']
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': None}, every)
        request = fixtures.REQUESTS['chain-balances']
        validate_v6_request_response('chain-balances', request, asked)
        for name, ask, body in (('default answers every chain', {'wallet': WALLET, 'tokens': None}, asked),
                                ('another wallet', {**request, 'wallet': fixtures.OTHER}, asked),
                                ('one token less', {**request, 'tokens': request['tokens'][:1]}, asked),
                                ('another order', {**request, 'tokens': request['tokens'][::-1]}, asked),
                                ('another chain', {**request, 'tokens': [{**t, 'chainId': 42161} for t in request['tokens']]},
                                 asked)):
            with self.subTest(case=name), self.assertRaises(ValueError):
                validate_v6_request_response('chain-balances', ask, body)
        # The balance chains answer when named, and never as the default answer, beside Domino's or alone.
        elsewhere = valid['chain-balances-asked-balance-chains']
        named = {'wallet': WALLET, 'tokens': [
            {'chainId': 1, 'address': fixtures.ETHEREUM_USDC}, {'chainId': 1, 'address': fixtures.ZERO},
            {'chainId': 10, 'address': fixtures.OPTIMISM_USDC}, {'chainId': 10, 'address': fixtures.ZERO}]}
        validate_v6_request_response('chain-balances', named, elsewhere)
        with_ethereum = copy.deepcopy(every)
        with_ethereum['chains'].insert(0, copy.deepcopy(elsewhere['chains'][0]))
        validate_v6_response('chain-balances', with_ethereum)
        for name, ask, body in (('default', {'wallet': WALLET, 'tokens': None}, elsewhere),
                                ('default beside the three', {'wallet': WALLET, 'tokens': None}, with_ethereum),
                                ('one chain less', {**named, 'tokens': named['tokens'][:2]}, elsewhere)):
            with self.subTest(case=name), self.assertRaises(ValueError):
                validate_v6_request_response('chain-balances', ask, body)

    def test_the_stored_routes_price_with_the_chain_reads_pricer_when_they_are_on(self):
        import read_api
        catalogue = type('Catalogue', (), {'settings': {'host': '/nonexistent', 'dbname': 'x'}})()
        pricer = type('Pricer', (), {'prices': lambda self, tokens: {}})()
        reads = type('ChainReads', (), {'pricer': pricer})()
        self.assertEqual(read_api.configured_v2_reader(catalogue, reads).prices, pricer.prices)
        self.assertIsNone(read_api.configured_v2_reader(catalogue, None).prices)

    def test_the_reader_names_the_balance_chain_file_from_its_own_variable(self):
        import os
        from unittest.mock import patch
        import read_api
        files = {'DOMINO_V2_CHAIN_RPC_FILE': '/run/domino-read-config/chain-rpc.json',
                 'DOMINO_V2_BALANCE_CHAIN_RPC_FILE': '/run/domino-read-config/balance-chain-rpc.json'}
        for environ, expected in ((files, files['DOMINO_V2_BALANCE_CHAIN_RPC_FILE']),
                                  ({**files, 'DOMINO_V2_BALANCE_CHAIN_RPC_FILE': ''}, None),
                                  ({'DOMINO_V2_CHAIN_RPC_FILE': files['DOMINO_V2_CHAIN_RPC_FILE']}, None)):
            with self.subTest(environ=sorted(environ)), patch.dict(os.environ, environ, clear=True), \
                    patch('v2_chain_reads.build_chain_reads', return_value='built') as built:
                self.assertEqual(read_api.configured_chain_reads(None, None), 'built')
            options = built.call_args.kwargs
            self.assertEqual((options['chain_rpc_file'], options['balance_chain_rpc_file']),
                             (files['DOMINO_V2_CHAIN_RPC_FILE'], expected))

    def test_a_fault_in_the_chain_reads_configuration_leaves_the_read_path_up(self):
        import io
        import os
        from contextlib import redirect_stderr
        from unittest.mock import patch
        import read_api
        stderr = io.StringIO()
        with patch.dict(os.environ, {'DOMINO_V2_CHAIN_RPC_FILE': '/nonexistent/chain-rpc.json'}), redirect_stderr(stderr):
            self.assertIsNone(read_api.configured_chain_reads(None, None))
        record = json.loads(stderr.getvalue().strip().splitlines()[-1])
        self.assertEqual((record['mode'], record['reason']), ('chain_reads_unavailable', 'v2_chain_rpc_config_unreadable'))
        self.assertNotIn('nonexistent', stderr.getvalue())
        # Any other fault is named by a fixed code: its text may carry a path.
        stderr = io.StringIO()
        with patch('v2_chain_reads.build_chain_reads', side_effect=OSError('/srv/private/chain-rpc.json: denied')), \
                redirect_stderr(stderr):
            self.assertIsNone(read_api.configured_chain_reads(None, None))
        record = json.loads(stderr.getvalue().strip().splitlines()[-1])
        self.assertEqual((record['mode'], record['reason']), ('chain_reads_unavailable', 'chain_reads_unconfigured'))
        self.assertNotIn('private', stderr.getvalue())


class RouteTests(unittest.TestCase):
    def test_the_reader_serves_both_routes_with_the_contract_header(self):
        reader = Reader()
        client = reader_client(reader)
        response = client.post('/v6/read/portfolio', json={'wallet': WALLET})
        self.assertEqual((response.status_code, response.headers['x-domino-read-contract']), (200, CONTRACT_VERSION))
        self.assertEqual(response.json(), fixtures.valid()['portfolio'])
        response = client.post('/v6/read/activity', json={'wallet': WALLET, 'limit': 3,
                                                          'cursor': '1790425234.4663.73391000.4'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['items']), 3)
        self.assertEqual(reader.calls[-1], ('activity', WALLET, 3, '1790425234.4663.73391000.4'))
        client.post('/v6/read/activity', json={'wallet': WALLET})
        self.assertEqual(reader.calls[-1], ('activity', WALLET, 20, None))

    def test_the_reader_refuses_bad_requests_browsers_and_answers_that_drift(self):
        client = reader_client(Reader())
        for body in ({'wallet': WALLET.upper().replace('0X', '0x')}, {'wallet': WALLET, 'extra': 1}, {}):
            with self.subTest(body=body):
                self.assertEqual(client.post('/v6/read/portfolio', json=body).status_code, 422)
        self.assertEqual(client.post('/v6/read/portfolio', json={'wallet': WALLET},
                                     headers={'Origin': 'https://app.invalid'}).status_code, 403)
        other = client.post('/v6/read/portfolio', json={'wallet': fixtures.OTHER})
        self.assertEqual((other.status_code, other.json()), (502, {'error': 'upstream_contract_mismatch'}))

        def priced(body):
            body['tokens'][0]['price'] = '1.00'
            return body
        drifted = reader_client(Reader(change=priced)).post('/v6/read/portfolio', json={'wallet': WALLET})
        self.assertEqual((drifted.status_code, drifted.json()), (502, {'error': 'upstream_contract_mismatch'}))

    def test_an_index_that_cannot_be_read_is_unavailable_never_partial(self):
        off = reader_client(None).post('/v6/read/portfolio', json={'wallet': WALLET})
        self.assertEqual((off.status_code, off.json()), (503, {'error': 'upstream_unavailable'}))
        down = reader_client(Reader(fail='catalogue_database_unavailable')).post('/v6/read/activity',
                                                                                 json={'wallet': WALLET})
        self.assertEqual((down.status_code, down.json()), (503, {'error': 'catalogue_database_unavailable'}))
        broken = reader_client(Reader(fail='v2_receipt_unanchored')).post('/v6/read/activity', json={'wallet': WALLET})
        self.assertEqual((broken.status_code, broken.json()), (503, {'error': 'upstream_unavailable'}))

    def test_stored_v6_reads_take_the_stored_lane_and_chain_reads_the_provider_lane(self):
        gate = ReadGate(interval=0)
        for route in ROUTES:
            with self.subTest(route=route):
                self.assertEqual(gate.kind_of(route, {}), gate.STORED if route in STORED_ROUTES else gate.PROVIDER)
        self.assertEqual(set(ROUTES) - set(STORED_ROUTES), {'chain-pools', 'chain-balances'})
        # A v1 route keeps its own lane: the v6 names never shadow pools, token or wallet-assets.
        for route in ('pools', 'token', 'wallet-assets'):
            self.assertEqual(gate.kind_of(route, {}), gate.PROVIDER)

    def test_the_reader_serves_the_chain_reads_with_the_contract_header(self):
        reads = ChainReads()
        client = reader_client(Reader(), reads)
        cases = (('chain-pools', fixtures.REQUESTS['chain-pools'], 'chain-pools'),
                 ('chain-pools', {**fixtures.REQUESTS['chain-pools'], 'pairedToken': fixtures.BASE_WETH}, 'chain-pools-paired'),
                 ('chain-balances', {'wallet': WALLET}, 'chain-balances'),
                 ('chain-balances', fixtures.REQUESTS['chain-balances'], 'chain-balances-asked'),
                 ('chain-tokens', fixtures.REQUESTS['chain-tokens'], 'chain-tokens'),
                 ('chain-tokens', {'chainId': 8453, 'query': 'aero'}, 'chain-tokens'),
                 ('chain-tokens', {**fixtures.REQUESTS['chain-tokens'], 'limit': 5}, 'chain-tokens'))
        for route, request, name in cases:
            with self.subTest(route=route, name=name):
                response = client.post(f'/v6/read/{route}', json=request)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
                self.assertEqual(response.json(), fixtures.valid()[name])
        self.assertEqual(reads.calls, [
            ('pools', 8453, fixtures.LIVE_TOKEN, None), ('pools', 8453, fixtures.LIVE_TOKEN, fixtures.BASE_WETH),
            ('balances', WALLET, None), ('balances', WALLET, [(8453, fixtures.LIVE_TOKEN), (8453, fixtures.ZERO),
                                                             (8453, fixtures.ZERO_BALANCE)]),
            ('tokens', 8453, 'aero', 20), ('tokens', 8453, 'aero', 20), ('tokens', 8453, 'aero', 5)])

    def test_chain_reads_refuse_bad_requests_unconfigured_reads_and_answers_about_something_else(self):
        for route, request in (('chain-pools', {'chainId': 1, 'token': fixtures.LIVE_TOKEN}),
                               ('chain-pools', {'chainId': 8453, 'token': fixtures.LIVE_TOKEN, 'pairedToken': fixtures.LIVE_TOKEN}),
                               ('chain-tokens', {'chainId': 4663, 'query': 'usd'}),
                               ('chain-balances', {'wallet': WALLET, 'tokens': []})):
            with self.subTest(route=route, request=request):
                response = reader_client(Reader(), ChainReads()).post(f'/v6/read/{route}', json=request)
                self.assertEqual((response.status_code, response.json()), (422, {'error': 'invalid_request'}))
        off = reader_client(Reader()).post('/v6/read/chain-tokens', json=fixtures.REQUESTS['chain-tokens'])
        self.assertEqual((off.status_code, off.json()), (503, {'error': 'upstream_unavailable'}))
        cooling = reader_client(Reader(), ChainReads(fail='v2_rpc_endpoints_cooling')).post(
            '/v6/read/chain-pools', json=fixtures.REQUESTS['chain-pools'])
        self.assertEqual((cooling.status_code, cooling.json()), (503, {'error': 'upstream_unavailable'}))
        drifted = reader_client(Reader(), ChainReads()).post(
            '/v6/read/chain-pools', json={**fixtures.REQUESTS['chain-pools'], 'chainId': 42161})
        self.assertEqual((drifted.status_code, drifted.json()), (502, {'error': 'upstream_contract_mismatch'}))

    def test_the_balance_chains_are_served_when_named_through_the_reader_and_the_gateway(self):
        class Reads(ChainReads):
            def balances(self, wallet, tokens):
                self.calls.append(('balances', wallet, tokens))
                return self._answer('chain-balances-asked-balance-chains')
        asked = [(1, fixtures.ETHEREUM_USDC), (1, fixtures.ZERO), (10, fixtures.OPTIMISM_USDC), (10, fixtures.ZERO)]
        request = {'wallet': WALLET, 'tokens': [{'chainId': chain_id, 'address': token} for chain_id, token in asked]}
        reads = Reads()
        reader = reader_client(Reader(), reads)
        response = reader.post('/v6/read/chain-balances', json=request)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), fixtures.valid()['chain-balances-asked-balance-chains'])
        self.assertEqual(reads.calls, [('balances', WALLET, asked)])
        gateway = gateway_client(reader, enabled_v6=True, enabled_v6_reads=('chain-balances',))
        through = gateway.post('/internal/read/v6/chain-balances', json=request, headers=HEADER)
        self.assertEqual((through.status_code, through.json()['chains'][1]['chainId']), (200, 10), through.text)
        # Without tokens, an answer about them is about chains nobody asked: refused, never relayed.
        drifted = reader.post('/v6/read/chain-balances', json={'wallet': WALLET})
        self.assertEqual((drifted.status_code, drifted.json()), (502, {'error': 'upstream_contract_mismatch'}))

    def test_the_gateway_serves_chain_reads_only_when_named(self):
        reader = reader_client(Reader(), ChainReads())
        client = gateway_client(reader, enabled_v6=True, enabled_v6_reads=('portfolio', 'chain-pools'))
        response = client.post('/internal/read/v6/chain-pools', json=fixtures.REQUESTS['chain-pools'], headers=HEADER)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['token'], fixtures.LIVE_TOKEN)
        self.assertEqual(client.post('/internal/read/v6/chain-tokens', json=fixtures.REQUESTS['chain-tokens'],
                                     headers=HEADER).status_code, 404)

    def test_the_gateway_serves_v6_only_under_its_flag(self):
        reader = reader_client(Reader())
        off = gateway_client(reader)
        self.assertEqual(off.post('/internal/read/v6/portfolio', json={'wallet': WALLET}, headers=HEADER).status_code,
                         404)
        client = gateway_client(reader, enabled_v6=True, enabled_v6_reads=('portfolio',))
        response = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET}, headers=HEADER)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
        self.assertEqual(response.json()['wallet'], WALLET)
        # Only the routes named are open, and the v6 flag opens v6 only.
        self.assertEqual(client.post('/internal/read/v6/activity', json={'wallet': WALLET},
                                     headers=HEADER).status_code, 404)
        self.assertEqual(client.post('/internal/read/v5/featured-pools', json={}, headers=HEADER).status_code, 404)
        self.assertEqual(client.post('/internal/read/v6/portfolio', json={'wallet': 'x'}, headers=HEADER).status_code,
                         422)

    def test_the_gateway_checks_the_answer_is_about_the_wallet_asked(self):
        def swapped(body):
            body['wallet'] = fixtures.OTHER
            body['vaults'] = []
            body['mandates'] = []
            return body
        reader = reader_client(Reader(change=swapped))
        client = gateway_client(reader, enabled_v6=True, enabled_v6_reads=ROUTES)
        response = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET}, headers=HEADER)
        # The reader itself refuses it first; the gateway would too.
        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))

    def test_the_gateway_refuses_a_v6_flag_without_its_route_or_its_verifier(self):
        for options in ({'enabled_v6': True, 'enabled_v6_reads': ()},
                        {'enabled_v6': True, 'enabled_v6_reads': ('featured-pools',)},
                        {'enabled_v6': 'true', 'enabled_v6_reads': ('portfolio',)}):
            with self.subTest(options=options), self.assertRaises(DataError):
                Gateway(verifier=Mock(), **options)
        with self.assertRaises(DataError):
            Gateway(enabled_v6=True, enabled_v6_reads=('portfolio',))
        stored = Gateway(verifier=Mock(), enabled_v6=True, enabled_v6_reads=ROUTES).gate
        self.assertEqual((stored.stored_capacity, stored.kind_of('activity', {})), (8, stored.STORED))

    def test_the_bridge_client_asks_only_for_typed_v6_routes(self):
        http = LocalReaderHTTP(client=reader_client(Reader()))
        status, data, metadata = http.request('portfolio', {'wallet': WALLET}, deadline=time.monotonic() + 10,
                                              version='v6')
        self.assertEqual((status, data['wallet'], metadata['contract']), (200, WALLET, CONTRACT_VERSION))
        for route, version in (('portfolio', 'v5'), ('featured-pools', 'v6'), ('health', 'v6'), ('pools', 'v6')):
            with self.subTest(route=route, version=version), self.assertRaises(DataError):
                http.request(route, {}, deadline=time.monotonic() + 10, version=version)


class WindowTests(unittest.TestCase):
    """read-v6 1.2.0-rc.1's window: each answer in the version its request names, position-fees in 1.2.0-rc.1
    alone, through the reader and the gateway (launch round P3, 4 Nov 2026)."""
    FEES = fixtures.NEXT_REQUESTS['position-fees']

    def test_a_request_is_answered_in_the_version_it_names_else_its_route_s_first(self):
        self.assertEqual(CONTRACT_VERSIONS, ('1.1.0-rc.1', '1.2.0-rc.1'))
        self.assertEqual((NEXT_ROUTES, set(NEXT_ROUTES) & set(ROUTES)), (('position-fees',), set()))
        self.assertIn('position-fees', STORED_ROUTES)
        self.assertEqual(answered_version('portfolio', None), CONTRACT_VERSION)
        self.assertEqual(answered_version('portfolio', NEXT_VERSION), NEXT_VERSION)
        self.assertEqual(answered_version('position-fees', None), NEXT_VERSION)
        for route, named, code in (('portfolio', '1.0.0-rc.1', 'invalid_request'),
                                   ('position-fees', CONTRACT_VERSION, 'route_not_available'),
                                   ('position-fees', '1.3.0-rc.1', 'invalid_request')):
            with self.subTest(route=route, named=named), self.assertRaisesRegex(ValueError, code):
                answered_version(route, named)

    def test_the_reader_answers_each_version_asked(self):
        reader = Reader()
        client = reader_client(reader)
        for named, answered in ((None, CONTRACT_VERSION), (CONTRACT_VERSION, CONTRACT_VERSION),
                                (NEXT_VERSION, NEXT_VERSION)):
            headers = {} if named is None else {'X-Domino-Read-Contract': named}
            response = client.post('/v6/read/portfolio', json={'wallet': WALLET}, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual((response.headers['x-domino-read-contract'], response.json()['contractVersion']),
                             (answered, answered))
            self.assertEqual({**response.json(), 'contractVersion': CONTRACT_VERSION}, fixtures.valid()['portfolio'])
        refused = client.post('/v6/read/portfolio', json={'wallet': WALLET},
                              headers={'X-Domino-Read-Contract': '1.0.0-rc.1'})
        self.assertEqual((refused.status_code, refused.json()), (422, {'error': 'invalid_request'}))
        twice = client.post('/v6/read/portfolio', json={'wallet': WALLET},
                            headers=[('X-Domino-Read-Contract', CONTRACT_VERSION), ('X-Domino-Read-Contract', NEXT_VERSION)])
        self.assertEqual(twice.status_code, 422)

    def test_the_reader_serves_position_fees_in_1_2_0_rc_1_alone(self):
        reader = Reader()
        client = reader_client(reader)
        response = client.post('/v6/read/position-fees', json=self.FEES)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.headers['x-domino-read-contract'], response.json()),
                         (NEXT_VERSION, fixtures.next_valid()['position-fees']))
        self.assertEqual(reader.calls[-1], ('position-fees', 8453, [(4, 41), (3, 31)]))
        old = client.post('/v6/read/position-fees', json=self.FEES, headers={'X-Domino-Read-Contract': CONTRACT_VERSION})
        self.assertEqual((old.status_code, old.json(), old.headers['x-domino-read-contract']),
                         (404, {'error': 'route_not_available'}, CONTRACT_VERSION))
        self.assertEqual(len(reader.calls), 1)
        for body in ({**self.FEES, 'positions': []}, {**self.FEES, 'positions': self.FEES['positions'] * 2},
                     {**self.FEES, 'positions': [{'dex': 4, 'tokenId': str(i + 1)} for i in range(MAX_FEE_POSITIONS + 1)]},
                     {**self.FEES, 'chainId': 1}):
            self.assertEqual(client.post('/v6/read/position-fees', json=body).status_code, 422)
        # An answer about other positions, or in their wrong order, never leaves the reader.
        swapped = reader_client(Reader(change=lambda b: {**b, 'positions': b['positions'][::-1]}))
        self.assertEqual(swapped.post('/v6/read/position-fees', json=self.FEES).status_code, 502)
        down = reader_client(Reader(fail='catalogue_database_unavailable'))
        self.assertEqual(down.post('/v6/read/position-fees', json=self.FEES).status_code, 503)

    def test_the_gateway_relays_the_version_asked_and_holds_the_answer_to_it(self):
        reader = reader_client(Reader())
        client = gateway_client(reader, enabled_v6=True, enabled_v6_reads=('portfolio', 'position-fees'))
        for named, answered in ((None, CONTRACT_VERSION), (CONTRACT_VERSION, CONTRACT_VERSION),
                                (NEXT_VERSION, NEXT_VERSION)):
            headers = HEADER if named is None else {**HEADER, 'X-Domino-Read-Contract': named}
            response = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET}, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual((response.headers['x-domino-read-contract'], response.json()['contractVersion']),
                             (answered, answered))
        fees = client.post('/internal/read/v6/position-fees', json=self.FEES,
                           headers={**HEADER, 'X-Domino-Read-Contract': NEXT_VERSION})
        self.assertEqual((fees.status_code, fees.headers['x-domino-read-contract']), (200, NEXT_VERSION), fees.text)
        self.assertEqual(fees.json(), fixtures.next_valid()['position-fees'])
        # Today's read Worker names 1.1.0-rc.1: position-fees is not one of its routes.
        old = client.post('/internal/read/v6/position-fees', json=self.FEES,
                          headers={**HEADER, 'X-Domino-Read-Contract': CONTRACT_VERSION})
        self.assertEqual((old.status_code, old.json()), (404, {'error': 'route_not_available'}))
        self.assertEqual(client.post('/internal/read/v6/portfolio', json={'wallet': WALLET},
                                     headers={**HEADER, 'X-Domino-Read-Contract': 'one'}).status_code, 422)

    def test_the_gateway_refuses_a_reader_that_answers_another_version(self):
        # A reader from before the window never hears the version asked: it answers 1.1.0-rc.1.
        upstream = LocalReaderHTTP(client=reader_client(Reader()))
        upstream._request_headers = staticmethod(lambda method, budget, request_id=None, contract=None:
                                                 LocalReaderHTTP._request_headers(method, budget, request_id))
        client = TestClient(create_gateway(Gateway(verifier=Mock(), upstream=upstream, gate=ReadGate(interval=0),
                                                   enabled_v6=True, enabled_v6_reads=('portfolio',))),
                            base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        response = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET},
                               headers={**HEADER, 'X-Domino-Read-Contract': NEXT_VERSION})
        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))
        same = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET},
                           headers={**HEADER, 'X-Domino-Read-Contract': CONTRACT_VERSION})
        self.assertEqual(same.status_code, 200, same.text)

    def test_the_gateway_refuses_an_answer_whose_body_is_another_version_than_its_header(self):
        class Upstream:
            """A reader whose header names the version asked and whose body does not."""
            def request(self, route, body=None, *, deadline, request_id=None, version='v1', contract=None):
                if route == 'health':
                    return 200, {'status': 'ok', 'mode': 'local_read_only', 'readBudgetSeconds': 15, 'busy': False,
                                 'storedBusy': False, 'generation': 'a' * 32}, {}
                answer = {**fixtures.valid()['portfolio'], 'contractVersion': CONTRACT_VERSION}
                return 200, answer, {'generation': 'a' * 32, 'contract': contract}
        client = TestClient(create_gateway(Gateway(verifier=Mock(), upstream=Upstream(), gate=ReadGate(interval=0),
                                                   enabled_v6=True, enabled_v6_reads=('portfolio',))),
                            base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        response = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET},
                               headers={**HEADER, 'X-Domino-Read-Contract': NEXT_VERSION})
        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))
        same = client.post('/internal/read/v6/portfolio', json={'wallet': WALLET},
                           headers={**HEADER, 'X-Domino-Read-Contract': CONTRACT_VERSION})
        self.assertEqual(same.status_code, 200, same.text)

    def test_a_position_is_a_positive_token_id(self):
        client = reader_client(Reader())
        for token in ('0', '07', '-1', 7):
            body = {**self.FEES, 'positions': [{'dex': 4, 'tokenId': token}]}
            self.assertEqual(client.post('/v6/read/position-fees', json=body).status_code, 422, token)

    def test_an_answer_splits_its_events_and_points_between_its_positions(self):
        many = [fixtures.fee_settlement(fixtures.FEE_FLOOR + 20_000 + i, 'collect', 0, 1, (1, 0), (i + 1, 0),
                                        label=f'many{i}') for i in range(600)]
        found = {(4, token): fixtures.fee_found(fixtures.fee_row(fixtures.FEE_V4_POOL), many, [], [], None)
                 for token in (41, 42)}
        body = fixtures.position_fees(found, [(4, 41), (4, 42)])
        self.assertEqual([len(p['events']) for p in body['positions']], [500, 500])
        self.assertTrue(all(p['truncated'] for p in body['positions']))

    def test_position_fees_stays_closed_at_the_gateway_until_named(self):
        client = gateway_client(reader_client(Reader()), enabled_v6=True, enabled_v6_reads=ROUTES)
        response = client.post('/internal/read/v6/position-fees', json=self.FEES,
                               headers={**HEADER, 'X-Domino-Read-Contract': NEXT_VERSION})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'route_not_available'}))

    def test_the_bridge_client_names_the_version_only_on_v6(self):
        http = LocalReaderHTTP(client=reader_client(Reader()))
        status, data, metadata = http.request('position-fees', self.FEES, deadline=time.monotonic() + 10, version='v6',
                                              contract=NEXT_VERSION)
        self.assertEqual((status, metadata['contract'], data['contractVersion']), (200, NEXT_VERSION, NEXT_VERSION))
        for route, version, contract in (('portfolio', 'v5', NEXT_VERSION), ('portfolio', 'v6', '1.0.0-rc.1')):
            with self.subTest(contract=contract), self.assertRaises(DataError):
                http.request(route, {'wallet': WALLET}, deadline=time.monotonic() + 10, version=version,
                             contract=contract)

    def test_the_largest_answer_fits_the_read_worker(self):
        from read_gateway import MAX_RESPONSE
        from v2_read_service import FEE_ANSWER_BYTES
        big = 2**256 - 1
        settlement = fixtures.fee_settlement(fixtures.FEE_FLOOR + 30_000, 'decrease', -(2**255 - 1), big, (big, big),
                                             (big, big), indexes=(1, 2, 3, 4), auto=(big, big))
        point = fixtures.fee_point(fixtures.FEE_FLOOR + 30_000, 1_790_380_800, (big, big), (big, big))
        found, keys = {}, []
        for index in range(MAX_FEE_POSITIONS):
            key = (4, 10**30 + index)
            events = [{**settlement, 'block_number': settlement['block_number'] + i} for i in range(200)]
            points = [{**point, 'block_number': point['block_number'] + i, 'hour': point['hour'] + 3600 * i,
                       'kind': 'day' if (point['hour'] + 3600 * i) % 86400 == 0 else 'hour'} for i in range(1, 300)]
            found[key] = fixtures.fee_found(fixtures.fee_row(fixtures.FEE_V4_POOL), events,
                                            [fixtures.fee_transfer(fixtures.FEE_FLOOR + 20_000 + i, fixtures.WALLET,
                                                                   fixtures.VAULT, i) for i in range(16)], points,
                                            fixtures.fee_v4_history()[3])
            keys.append(key)
        body = fixtures.position_fees(found, keys)
        size = len(json.dumps(body, separators=(',', ':')).encode())
        self.assertLessEqual(size, FEE_ANSWER_BYTES)
        self.assertLess(FEE_ANSWER_BYTES, MAX_RESPONSE)
        self.assertTrue(all(p['truncated'] for p in body['positions']))
        # The newest stay: a chart loses its oldest points, never its last.
        self.assertEqual(body['positions'][0]['points'][-1]['block'], point['block_number'] + 299)
        self.assertEqual(body['positions'][0]['events'][-1]['block']['number'], settlement['block_number'] + 199)

class FeedlessPriceProfileTests(unittest.TestCase):
    """A chain without Chainlink: a PRICE_PROFILES entry with `nativePool` (no chain of this version has one). The
    producer's rule, which runtime.mjs keeps on the same answers (consumer.test.mjs): the native currency and its
    wrapped token at that pool alone, and no price there with a feed's round."""

    ZERO = '0x' + '0' * 40

    def feedless(self, name, profile):
        body = copy.deepcopy(json.loads((PACKAGE / f'fixtures/valid/{name}.json').read_text()))
        for entry in next(chain for chain in body['chains'] if chain['chainId'] == 8453)['balances']:
            if entry['price'] is None:
                continue
            if entry['address'] in (self.ZERO, profile['wrapped']):
                entry['price'] = {**entry['price'], 'source': 'pool', 'ethUsd': None,
                                  'pool': dict(profile['nativePool']), 'depthUsd': '25000.000000'}
            else:
                entry['price']['ethUsd'] = None
        return body

    def test_the_native_currency_at_its_profile_pool_and_no_round_anywhere(self):
        from unittest import mock
        import v2_read_contract as contract
        base = contract.PRICE_PROFILES[8453]
        pool = {'dex': 3, 'currency0': base['wrapped'], 'currency1': base['stable'], 'fee': 500, 'tickSpacing': 10,
                'hooks': self.ZERO}
        profile = {'stable': base['stable'], 'wrapped': base['wrapped'], 'feed': None, 'heartbeatSeconds': None,
                   'nativePool': pool}
        original = {name: json.loads((PACKAGE / f'fixtures/valid/{name}.json').read_text())
                    for name in ('chain-balances', 'chain-balances-asked')}
        with mock.patch.dict(contract.PRICE_PROFILES, {8453: profile}):
            for name in original:
                with self.subTest(name=name):
                    validate_v6_response('chain-balances', self.feedless(name, profile))
                    with self.assertRaises(ValueError):
                        validate_v6_response('chain-balances', original[name])  # ETH at a feed this chain lacks
            for case, change in (
                    ('another pool', lambda body: body['chains'][1]['balances'][1]['price']['pool'].update(fee=3000)),
                    ('the native price with a round', lambda body: body['chains'][1]['balances'][1]['price'].update(
                        ethUsd=original['chain-balances']['chains'][1]['balances'][1]['price']['ethUsd']))):
                body = self.feedless('chain-balances', profile)
                change(body)
                with self.subTest(case=case), self.assertRaises(ValueError):
                    validate_v6_response('chain-balances', body)
            body = self.feedless('chain-balances-asked', profile)
            body['chains'][0]['balances'][0]['price']['ethUsd'] = (
                original['chain-balances-asked']['chains'][0]['balances'][0]['price']['ethUsd'])
            with self.assertRaises(ValueError):
                validate_v6_response('chain-balances', body)  # a price against WETH with a round
        for name, body in original.items():
            validate_v6_response('chain-balances', body)

    def test_every_price_profile_is_its_chains_by_one_rule(self):
        # The rule a chain without Chainlink takes too (v2_chain_reads.price_profile), so its entry is its profile's.
        import v2_chain_reads
        from v2_chains import default_balance_registry
        from v2_read_contract import PRICE_PROFILES
        chains = (*default_registry().chains, *default_balance_registry().chains)
        self.assertEqual(PRICE_PROFILES, {chain.chainId: v2_chain_reads.price_profile(chain)
                                          for chain in chains if chain.chainId in BALANCE_CHAIN_IDS})


if __name__ == '__main__':
    unittest.main()
