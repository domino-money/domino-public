import copy
from dataclasses import replace
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import psycopg
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capital_store import CapitalIndexer
from catalogue import PgCatalogue
from dev_postgres import ADMIN, BIN, PORT, SOCKET
from discovery import DataError, ZERO
from metrics_service import stored_metrics
from price_history import SOURCE, store_observations
from read_api import ReadGate, create_app
from read_service import ReadService
from test_discovery import POOL
import test_position_accounting as position_tests


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class CapitalPostgresTests(unittest.TestCase):
    settings = position_tests.PositionPostgresTests.settings

    def setUp(self):
        position_tests.PositionPostgresTests.setUp(self)
        self.positions.step(POOL)
        self.capital = CapitalIndexer(self.store, self.rpc)

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.'+table).fetchone()['n']
                         for table in ('capital_chunks', 'capital_events', 'price_observations'))

    def test_every_event_is_persisted_and_tail_assets_match(self):
        result = self.capital.step(POOL)
        report = stored_metrics(self.catalogue, POOL)
        self.assertGreater(result['capitalEvents'], 1)
        self.assertEqual(self.counts()[:2], (1, result['capitalEvents']))
        source = self.store.read(POOL)['liquidity']['positionAccounting']['lpAssetsRaw']
        self.assertEqual(report['capital']['current']['lpAssetsRaw'], source)
        self.assertEqual(report['valuation']['reason'], 'qualified_usd_prices_required')
        self.assertIsNone(report['valuation']['tvlUsd'])

    def test_missing_capital_or_position_qualification_cannot_be_promoted(self):
        with self.assertRaisesRegex(DataError, 'capital_ledger_not_caught_up'): stored_metrics(self.catalogue, POOL)
        with self.catalogue.connection(writer=True) as conn: conn.execute('DELETE FROM domino_activity.position_chunks')
        with self.assertRaisesRegex(DataError, 'reconciled_position_tail_required'): self.capital.step(POOL)
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_restart_lagging_history_and_empty_chunks(self):
        self.capital.step(POOL)
        self.worker.step(POOL, through=30);self.fees.step(POOL);self.positions.step(POOL)
        with self.assertRaisesRegex(DataError, 'not_caught_up'): stored_metrics(self.catalogue, POOL)
        CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.counts()
        self.worker.step(POOL, through=40);self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        self.assertEqual(self.counts(), (before[0]+1, before[1], 0))
        self.assertEqual(self.capital.step(POOL)['status'], 'caught_up_to_activity')
        self.assertEqual(stored_metrics(self.catalogue, POOL)['capital']['observedSeconds'], 30)

    def test_full_day_window_preserves_boundary_capital(self):
        self.capital.step(POOL)
        for through in list(range(10018, 86410, 10000))+[86410]:
            self.worker.step(POOL, through=through, span=10000)
            self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        report = stored_metrics(self.catalogue, POOL)
        self.assertTrue(report['capital']['complete24h'])
        self.assertEqual(report['capital']['observedSeconds'], 86400)
        self.assertFalse(report['executionAvailable'])

    def test_missing_empty_source_chunk_cannot_claim_continuous_history(self):
        self.capital.step(POOL)
        for end in (30, 40, 50):
            self.worker.step(POOL, through=end);self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute('DELETE FROM domino_activity.chunks WHERE pool_id=%s AND end_block=40', (POOL,))
        with self.assertRaisesRegex(DataError, 'source_history_gap'): stored_metrics(self.catalogue, POOL)

    def test_failed_reconciliation_or_reorg_rolls_back_whole_chunk(self):
        self.rpc.corrupt = 'position'
        with self.assertRaisesRegex(DataError, 'reconciliation_failed'): self.capital.step(POOL)
        self.assertEqual(self.counts(), (0, 0, 0));self.rpc.corrupt = None
        original = self.capital.positions.check_positions
        def changed(*args):
            result = original(*args);self.rpc.fork_at = 18;return result
        with patch.object(self.capital.positions, 'check_positions', side_effect=changed):
            with self.assertRaisesRegex(DataError, 'reorg_requires_replay'): self.capital.step(POOL)
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_rewind_cascades_source_history_and_replay_restores_it(self):
        self.capital.step(POOL);first = self.counts()
        self.worker.step(POOL, through=30);self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        before = stored_metrics(self.catalogue, POOL);full = self.counts()
        with self.catalogue.connection(writer=True, lock=True) as conn:
            self.store.rewind(conn, self.store.pool(conn, POOL), 18)
        self.assertEqual(self.counts(), first)
        self.worker.step(POOL, through=30);self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        self.assertEqual(self.counts(), full)
        self.assertEqual(stored_metrics(self.catalogue, POOL)['capital'], before['capital'])

    def test_missing_event_and_altered_end_capital_are_detected(self):
        self.capital.step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute("UPDATE domino_activity.capital_chunks SET end_capital=jsonb_set(end_capital,'{lpAssetsRaw,0}','\"0\"')")
        with self.assertRaisesRegex(DataError, 'capital_tail_mismatch'): stored_metrics(self.catalogue, POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute('DELETE FROM domino_activity.capital_chunks')
        self.capital.step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute('DELETE FROM domino_activity.capital_events WHERE log_index=(SELECT min(log_index) FROM domino_activity.capital_events)')
        with self.assertRaisesRegex(DataError, 'capital_events_incomplete'): stored_metrics(self.catalogue, POOL)

    def price(self):
        return {'chainId': 4663, 'currency': ZERO, 'source': SOURCE, 'timestamp': 1000, 'retrievedAt': 2000,
                'priceUsd': '2000', 'provenance': {'status': 'external_observation_unqualified'}}

    def test_prices_resume_idempotently_and_conflicts_preserve_original(self):
        store_observations(self.catalogue, [self.price()]);store_observations(self.catalogue, [self.price()])
        self.assertEqual(self.counts()[2], 1)
        with self.assertRaisesRegex(DataError, 'revision_requires_review'):
            store_observations(self.catalogue, [{**self.price(), 'priceUsd': '2500'}])
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT price_usd FROM domino_activity.price_observations').fetchone()['price_usd'], '2000')

    def test_observation_flags_cannot_self_qualify_and_writer_is_serialized(self):
        bad = self.price();bad['provenance']['status'] = 'qualified'
        with self.assertRaisesRegex(DataError, 'invalid_price_observation'): store_observations(self.catalogue, [bad])
        with self.catalogue.connection(writer=True, lock=True):
            with self.assertRaisesRegex(DataError, 'writer_busy'): store_observations(self.catalogue, [self.price()])
        store_observations(self.catalogue, [self.price()]);self.capital.step(POOL)
        report = stored_metrics(self.catalogue, POOL)
        self.assertEqual(report['prices'][0]['status'], 'observed_unqualified')
        self.assertIsNone(report['valuation']['tvlUsd'])

    def test_dump_restore_and_reader_grants_cover_both_histories(self):
        self.capital.step(POOL);store_observations(self.catalogue, [self.price()])
        before = stored_metrics(self.catalogue, POOL)
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder)/'capital.dump';common = ['-h', str(SOCKET), '-p', str(PORT), '-U', ADMIN]
            subprocess.run([str(BIN/'pg_dump'), *common, '-d', 'domino_catalogue_tests', '-n', 'domino_activity', '-Fc', '-f', str(archive)], check=True, capture_output=True)
            subprocess.run([str(BIN/'pg_restore'), *common, '-d', 'domino_catalogue_restore_tests', '--clean', '--if-exists', '--exit-on-error', str(archive)], check=True, capture_output=True)
        restored = PgCatalogue({**self.settings, 'dbname': 'domino_catalogue_restore_tests'})
        self.assertEqual(stored_metrics(restored, POOL), before)
        for table in ('capital_events', 'capital_chunks', 'price_observations'):
            with psycopg.connect(**self.settings, user='domino_catalogue_reader') as conn:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege): conn.execute('DELETE FROM domino_activity.'+table)

    def test_http_stale_metrics_and_reorg_gate(self):
        self.capital.step(POOL)
        rpc = position_tests.SnapshotRpc()
        client = TestClient(create_app(ReadService(catalogue=self.catalogue, rpc_factory=lambda: rpc, clock=lambda: 2000),
                                      gate=ReadGate(interval=0)), base_url='http://127.0.0.1')
        response = client.post('/v1/read/pool-metrics', json={'poolId': POOL})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['freshness']['status'], 'stale')
        self.assertFalse(response.json()['usableAsCurrent24h'])
        self.assertEqual(client.post('/v1/read/pool-metrics', json={'poolId': POOL, 'prices': []}).status_code, 422)
        rpc.orphan = True
        self.assertEqual(client.post('/v1/read/pool-metrics', json={'poolId': POOL}).status_code, 503)
