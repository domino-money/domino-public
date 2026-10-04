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
from v2_read_contract import (CHAIN_IDS, CONTRACT_VERSION, REQUEST_MODELS, ROUTES, V2_ERRORS,  # noqa: E402
                              cursor_key, error_of, validate_v6_request_response, validate_v6_response)
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


def reader_client(v2_reader):
    return TestClient(create_app(object(), gate=ReadGate(interval=0), read_budget_seconds=15, v2_reader=v2_reader),
                      base_url='http://127.0.0.1:8876')


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

    def test_the_chains_are_the_enabled_profiles(self):
        self.assertEqual(CHAIN_IDS, tuple(profile.chainId for profile in default_registry().chains))

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
            validate_v6_response('portfolio' if name.startswith('portfolio') else 'activity', body)
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

    def test_v6_reads_are_stored_lane_reads(self):
        gate = ReadGate(interval=0)
        for route in ROUTES:
            self.assertEqual(gate.kind_of(route, {}), gate.STORED)

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
        self.assertEqual((stored.stored_capacity, stored.kind_of('activity', {})), (4, stored.STORED))

    def test_the_bridge_client_asks_only_for_typed_v6_routes(self):
        http = LocalReaderHTTP(client=reader_client(Reader()))
        status, data, metadata = http.request('portfolio', {'wallet': WALLET}, deadline=time.monotonic() + 10,
                                              version='v6')
        self.assertEqual((status, data['wallet'], metadata['contract']), (200, WALLET, CONTRACT_VERSION))
        for route, version in (('portfolio', 'v5'), ('featured-pools', 'v6'), ('health', 'v6'), ('pools', 'v6')):
            with self.subTest(route=route, version=version), self.assertRaises(DataError):
                http.request(route, {}, deadline=time.monotonic() + 10, version=version)


if __name__ == '__main__':
    unittest.main()
