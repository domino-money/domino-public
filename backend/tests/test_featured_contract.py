"""read-v5: the featured pools list on the wire (featured-pools v1 §10).

The shared fixtures under api-contracts/read-v5/fixtures are what the Worker's
and the app's validators are held to; the answer is the served revision as
stored, read through the public reader role, and the route runs through the
reader and the gateway exactly as the v4 snapshot does.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg import sql

from bridge_http import LocalReaderHTTP
from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import DataError
from featured_contract import (CONTRACT_VERSION, FeaturedReader, build_response, prune_withdrawn, rules_of,
                               validate_featured_response)
from featured_pools import load_policy
from featured_store import FeaturedStore
from public_observations import PgPublicData
from read_api import ReadGate, create_app
from read_gateway import Gateway, create_gateway
from read_service import ReadService

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'api-contracts/read-v5/fixtures'
_spec = importlib.util.spec_from_file_location('read_v5_fixtures', ROOT / 'scripts/export-read-v5-fixtures.py')
exporter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(exporter)
HEADER = {'Cf-Access-Jwt-Assertion': 'a.b.c', 'X-Domino-Client-Id': '192.0.2.1'}
WEEK = 7 * 86400


def load(kind):
    return {path.stem: json.loads(path.read_text()) for path in sorted((FIXTURES / kind).glob('*.json'))}


def recent(row):
    """A stored revision moved to the real clock: selected an hour ago, effective half an hour ago."""
    row, now = copy.deepcopy(row), int(time.time())
    shift = now - 3600 - row['generated_at']
    row.update(generated_at=row['generated_at'] + shift, effective_at=row['effective_at'] + shift,
               valid_until=row['valid_until'] + shift)
    for item in row['payload']['withdrawn']:
        item['at'] += shift
    return row


class Repository:
    """The public repository, answering the served-list query with one stored row."""
    def __init__(self, row):
        self.row, self.queries = row, []

    def connection(self):
        repository = self

        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *failure):
                return False

            def execute(self, query, params=None):
                repository.queries.append(query)
                return SimpleNamespace(fetchone=lambda: repository.row)
        return Connection()


class Tampered:
    """The reader over HTTP, with its featured-pools answer changed on the way to the gateway."""
    def __init__(self, http, change):
        self.http, self.change = http, change

    def request(self, route, body=None, **options):
        status, data, metadata = self.http.request(route, body, **options)
        return (status, self.change(data), metadata) if route == 'featured-pools' else (status, data, metadata)


class ContractTests(unittest.TestCase):
    def test_the_shared_fixtures_are_what_the_producer_serves(self):
        on_disk = {path.relative_to(FIXTURES).as_posix(): path.read_text() for path in FIXTURES.glob('*/*.json')}
        self.assertEqual(on_disk, exporter.files(), 'run scripts/export-read-v5-fixtures.py')

    def test_every_valid_fixture_passes_and_every_invalid_fixture_fails(self):
        valid, invalid = load('valid'), load('invalid')
        self.assertEqual(set(valid), {'current', 'current-policy-v1', 'repaired', 'manual', 'none',
                                      'none-with-withdrawn'})
        self.assertGreaterEqual(len(invalid), 57)
        for name, body in valid.items():
            with self.subTest(valid=name):
                self.assertIs(validate_featured_response('featured-pools', body), body)
        for name, body in invalid.items():
            with self.subTest(invalid=name), self.assertRaises(ValueError):
                validate_featured_response('featured-pools', body)
        with self.assertRaises(ValueError):
            validate_featured_response('sequence-snapshot', valid['current'])

    def test_either_policy_states_rules_the_contract_accepts(self):
        v1 = load_policy(Path(__file__).resolve().parent / 'fixtures/featured_policy_v1.json')
        for policy, rank_by, off in ((v1, 'min_fresh_and_previous_day_feeAprEstimate24hPercent', set()),
                                     (load_policy(), 'feeAprEstimate24hPercent',
                                      {'maxAprPercent', 'maxTurnover24h', 'minPoolAgeHours'})):
            row = exporter.stored()['current']
            row['payload']['rules'] = rules_of(policy)
            rules = build_response(row, now=exporter.SERVED_AT)['rules']
            with self.subTest(rank_by=rank_by):
                self.assertEqual(rules['rankBy'], rank_by)
                self.assertEqual({name for name, value in rules.items() if value is None}, off)
        self.assertEqual(CONTRACT_VERSION, '1.0.0-rc.2')

    def test_the_answer_is_the_stored_list_without_its_private_fields(self):
        row = exporter.stored()['current']
        body = build_response(row, now=exporter.SERVED_AT)
        self.assertEqual((body['status'], body['revision'], body['listId']), ('current', 41, row['list_id']))
        self.assertEqual([pool['poolId'] for pool in body['pools']], [entry['poolId'] for entry in row['payload']['pools']])
        # What health reads (the reference token, the price at selection) stays on the VM.
        for name in ('reference', 'selectionSqrtPriceX96'):
            self.assertNotIn(name, body['pools'][0])
        self.assertEqual(set(body['coverage']), {'source', 'pages', 'lastListedVolume24hUsd', 'truncated'})
        self.assertEqual((body['upcoming'], body['suggested'], body['executionAvailable']), (None, False, False))
        self.assertEqual(body['servedAt'], exporter.SERVED_AT)

    def test_nothing_served_and_mode_off_are_none_and_mode_off_keeps_the_week_s_removals(self):
        never = build_response(None, now=exporter.SERVED_AT)
        self.assertEqual((never['status'], never['pools'], never['withdrawn'], never['revision']), ('none', [], [], None))
        row = exporter.stored()['none-with-withdrawn']
        row['payload']['withdrawn'].insert(0, {'poolId': '0x' + '33' * 32, 'reason': 'price_fall',
                                               'at': exporter.SERVED_AT - WEEK - 1})
        off = build_response(row, now=exporter.SERVED_AT)
        self.assertEqual((off['status'], off['pools'], off['revision'], off['validUntil']), ('none', [], None, None))
        self.assertEqual(off['withdrawn'], exporter.stored()['none-with-withdrawn']['payload']['withdrawn'])

    def test_withdrawn_is_the_last_seven_days_newest_last_and_at_most_24(self):
        items = [{'poolId': '0x%064x' % n, 'reason': 'tvl_collapse', 'at': 1000 + n} for n in range(30)]
        self.assertEqual([item['at'] for item in prune_withdrawn(items, 1020 + WEEK)], list(range(1020, 1030)))
        self.assertEqual([item['at'] for item in prune_withdrawn(items, 1029)], list(range(1006, 1030)))
        row = exporter.stored()['current']
        row['payload']['withdrawn'] = [{**item, 'at': exporter.SERVED_AT - 1029 + item['at']} for item in items]
        self.assertEqual(len(build_response(row, now=exporter.SERVED_AT)['withdrawn']), 24)

    def test_a_list_recorded_before_initialize_block_existed_reads_null(self):
        row = exporter.stored()['current']
        for entry in row['payload']['pools']:
            entry.pop('initializeBlock')
        self.assertEqual([pool['initializeBlock'] for pool in build_response(row, now=exporter.SERVED_AT)['pools']],
                         [None, None])

    def test_a_stored_list_the_contract_refuses_is_a_mismatch_never_a_list(self):
        for change in (lambda row: row['payload']['pools'][1]['poolKey'].update(hooks='0x' + '11' * 20),
                       lambda row: row['payload']['pools'][1]['tokens'][1].update(symbol='TKN‮B'),
                       lambda row: row.update(status='carried_over', list_id=None)):
            row = exporter.stored()['current']
            change(row)
            with self.subTest(row=row['status']), self.assertRaises(DataError) as caught:
                FeaturedReader(Repository(row), clock=lambda: exporter.SERVED_AT).read()
            self.assertEqual(str(caught.exception), 'upstream_contract_mismatch')


class RouteTests(unittest.TestCase):
    def reader(self, row, *, public=True):
        service = ReadService(public_data=SimpleNamespace(repository=Repository(row)) if public else None)
        return TestClient(create_app(service, gate=ReadGate(interval=0), read_budget_seconds=15),
                          base_url='http://127.0.0.1:8876')

    def gateway(self, reader, **enabled):
        return TestClient(create_gateway(Gateway(verifier=Mock(), upstream=LocalReaderHTTP(client=reader),
                                                 gate=ReadGate(interval=0), **enabled)),
                          base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))

    def test_the_gateway_route_is_off_by_default_then_serves_only_the_typed_route(self):
        reader = self.reader(recent(exporter.stored()['current']))
        off = self.gateway(reader)
        self.assertEqual(off.post('/internal/read/v5/featured-pools', json={}, headers=HEADER).status_code, 404)
        client = self.gateway(reader, enabled_v5=True, enabled_v5_reads=('featured-pools',))
        response = client.post('/internal/read/v5/featured-pools', json={}, headers=HEADER)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
        body = validate_featured_response('featured-pools', response.json())
        self.assertEqual((body['status'], body['revision'], len(body['pools'])), ('current', 41, 2))
        self.assertEqual(client.post('/internal/read/v5/featured-pools', json={'poolIds': []},
                                     headers=HEADER).status_code, 422)
        self.assertEqual(client.post('/internal/read/v5/pools', json={}, headers=HEADER).status_code, 404)
        # The v5 flag opens v5 only.
        self.assertEqual(client.post('/internal/read/v4/sequence-snapshot', json={'owner': '0x' + '11' * 20,
                                     'tokenId': None}, headers=HEADER).status_code, 404)
        self.assertEqual(reader.post('/v5/read/featured-pools', json={},
                                     headers={'Origin': 'https://evil.invalid'}).status_code, 403)

    def test_the_gateway_checks_the_answer_itself_and_serves_only_under_its_exact_flag(self):
        reader = self.reader(recent(exporter.stored()['current']))

        def hooked(body):
            body['pools'][1]['poolKey']['hooks'] = '0x' + '11' * 20
            return body
        tampered = TestClient(create_gateway(Gateway(verifier=Mock(), upstream=Tampered(LocalReaderHTTP(client=reader), hooked),
                                                     enabled_v5=True, enabled_v5_reads=('featured-pools',),
                                                     gate=ReadGate(interval=0))),
                              base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        response = tampered.post('/internal/read/v5/featured-pools', json={}, headers=HEADER)
        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))
        listed = self.gateway(reader, enabled_v5_reads=('featured-pools',))
        self.assertEqual(listed.post('/internal/read/v5/featured-pools', json={}, headers=HEADER).status_code, 404)

    def test_the_gateway_refuses_a_v5_flag_without_its_route_or_its_verifier(self):
        for options in ({'enabled_v5': True, 'enabled_v5_reads': ()},
                        {'enabled_v5': True, 'enabled_v5_reads': ('pools',)},
                        {'enabled_v5': True, 'enabled_v5_reads': ('',)},
                        {'enabled_v5': 'true', 'enabled_v5_reads': ('featured-pools',)}):
            with self.subTest(options=options), self.assertRaises(DataError):
                Gateway(verifier=Mock(), **options)
        with self.assertRaises(DataError):
            Gateway(enabled_v5=True, enabled_v5_reads=('featured-pools',))
        stored = Gateway(verifier=Mock(), enabled_v5=True, enabled_v5_reads=('featured-pools',)).gate
        self.assertEqual((stored.stored_interval, stored.kind_of('featured-pools', {})), (0, stored.STORED))

    def test_the_reader_answers_none_a_mismatch_or_unavailable_never_a_guess(self):
        empty = self.reader(None).post('/v5/read/featured-pools', json={})
        self.assertEqual((empty.status_code, empty.json()['status'], empty.headers['x-domino-read-contract']),
                         (200, 'none', CONTRACT_VERSION))
        future = exporter.stored()['current']      # selected tomorrow: its times are out of order now
        future.update(generated_at=int(time.time()) + 3600)
        mismatch = self.reader(future).post('/v5/read/featured-pools', json={})
        self.assertEqual((mismatch.status_code, mismatch.json()), (502, {'error': 'upstream_contract_mismatch'}))
        unavailable = self.reader(None, public=False).post('/v5/read/featured-pools', json={})
        self.assertEqual((unavailable.status_code, unavailable.json()), (503, {'error': 'upstream_unavailable'}))

    def test_the_bridge_client_asks_only_for_the_typed_v5_route(self):
        reader = LocalReaderHTTP(client=self.reader(recent(exporter.stored()['current'])))
        status, data, metadata = reader.request('featured-pools', {}, deadline=time.monotonic() + 10, version='v5')
        self.assertEqual((status, data['status'], metadata['contract']), (200, 'current', CONTRACT_VERSION))
        for route, version in (('pools', 'v5'), ('featured-pools', 'v4'), ('featured-pools', 'v6'), ('health', 'v5')):
            with self.subTest(route=route, version=version), self.assertRaises(DataError):
                reader.request(route, {}, deadline=time.monotonic() + 10, version=version)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class ReaderRoleTests(unittest.TestCase):
    """The served list through the real reader role: lists only, never runs, overrides or health."""
    @classmethod
    def setUpClass(cls):
        cls.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_featured_contract_tests'}
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations = Path(__file__).resolve().parents[1] / 'migrations'
        with psycopg.connect(**cls.settings, user=ADMIN) as conn:
            for name in ('001_catalogue', '002_activity', '020_pool_requests', '023_pool_request_scheduling',
                         '024_public_observations', '025_public_history', '026_public_demand', '042_provider_priority',
                         '043_featured_pools', '044_demand_horizon', '045_featured_live','047_provider_ceiling'):
                conn.execute((migrations / (name + '.sql')).read_text())

    def setUp(self):
        with psycopg.connect(**self.settings, user=ADMIN) as conn:
            conn.execute('''TRUNCATE domino_public.featured_current,domino_public.featured_lists,
              domino_public.featured_runs,domino_public.featured_health''')
        self.catalogue = PgCatalogue(self.settings)
        self.store = FeaturedStore(self.catalogue)

    def serve(self, name):
        row = recent(exporter.stored()[name])
        return self.store.serve(status=row['status'], payload=row['payload'], day=row['selection_date'], run_id=None,
                                generated_at=row['generated_at'], effective_at=row['effective_at'],
                                valid_until=row['valid_until'])

    def test_the_reader_role_reads_the_served_revision_and_nothing_else(self):
        reader = FeaturedReader(PgPublicData(self.catalogue))
        self.assertEqual(reader.read()['status'], 'none')
        self.serve('current')
        revision = self.serve('repaired')
        body = reader.read()
        self.assertEqual((body['status'], body['revision'], [pool['source'] for pool in body['pools']]),
                         ('repaired', revision, ['pinned', 'fallback']))
        for table in ('featured_runs', 'featured_overrides', 'featured_health', 'featured_token_checks'):
            with psycopg.connect(**self.settings, user='domino_catalogue_reader') as conn, \
                    self.subTest(table=table), self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql.SQL('SELECT * FROM domino_public.{}').format(sql.Identifier(table)))

    def test_the_route_serves_the_list_the_live_service_stored(self):
        revision = self.serve('manual')
        service = ReadService(public_data=SimpleNamespace(repository=PgPublicData(self.catalogue)))
        reader = TestClient(create_app(service, gate=ReadGate(interval=0), read_budget_seconds=15),
                            base_url='http://127.0.0.1:8876')
        gateway = TestClient(create_gateway(Gateway(verifier=Mock(), upstream=LocalReaderHTTP(client=reader),
                                                    enabled_v5=True, enabled_v5_reads=('featured-pools',),
                                                    gate=ReadGate(interval=0))),
                             base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        response = gateway.post('/internal/read/v5/featured-pools', json={}, headers=HEADER)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body['status'], body['revision'], body['policyVersion'], body['rules']),
                         ('manual', revision, None, None))


if __name__ == '__main__':
    unittest.main()
