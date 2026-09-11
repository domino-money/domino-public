"""Method/source/checkpoint recovery against disposable PostgreSQL, no live RPC."""
import json
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import historical_capacity
import historical_work
import manage_fees
import manage_positions
from activity_indexer import ActivityIndexer
from discovery import DataError
from fee_store import FeeIndexer
from position_store import PositionIndexer
from test_discovery import POOL
import test_pool_activity as activity_tests
from test_position_accounting import PositionFixtureRpc, reference


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class HistoricalRecoveryTests(unittest.TestCase):
    settings = activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc = PositionFixtureRpc()
        activity = ActivityIndexer(self.store, self.rpc)
        activity.register(POOL, 10)
        activity.step(POOL, through=30)

    def ledger_worker(self, ledger):
        return {'fee': FeeIndexer, 'position': PositionIndexer}[ledger](self.store, self.rpc)

    def pending(self, ledger, proof=False):
        if ledger == 'position':
            self.finish('fee')
        with patch('historical_capacity.MAX_BATCH_EVENTS', 32 if proof else 2), \
                patch('position_store.MAX_BATCH_CHECKS', 1):
            result = self.ledger_worker(ledger).step(POOL)
        self.assertEqual(result['status'], ledger + '_chunk_in_progress')
        return self.work(ledger)['progress']

    def finish(self, ledger):
        for _ in range(40):
            result = self.ledger_worker(ledger).step(POOL)
            if result['status'] in (ledger + '_chunk_reconciled', 'caught_up_to_activity'):
                return
        self.fail('fixture did not finish in finite batches')

    def work(self, ledger):
        with self.catalogue.connection() as conn:
            return conn.execute('SELECT * FROM domino_activity.historical_work WHERE pool_id=%s AND ledger=%s',
                                (POOL, ledger)).fetchone()

    def write_progress(self, ledger, value):
        with self.catalogue.connection(writer=True, lock=True) as conn:
            conn.execute('UPDATE domino_activity.historical_work SET progress=%s WHERE pool_id=%s AND ledger=%s',
                         (Jsonb(value), POOL, ledger))

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.' + table).fetchone()['n']
                         for table in ('chunks', 'events', 'fee_chunks', 'fee_events',
                                       'position_chunks', 'position_settlements'))

    def assert_blocked(self, ledger, reason, progress):
        before = self.counts()
        with self.assertRaisesRegex(DataError, reason):
            self.ledger_worker(ledger).step(POOL)
        saved = self.work(ledger)
        self.assertEqual(saved['progress'], progress)
        self.assertEqual(saved['diagnostic']['action'], 'restart_unpublished_work_after_review')
        self.assertEqual(self.counts(), before)
        report = self.store.read(POOL)
        accounting = report['fees']['accounting'] if ledger == 'fee' else report['liquidity']['positionAccounting']
        self.assertEqual(accounting['status'], 'unavailable')
        self.assertIsNone(accounting['lpFeesRaw' if ledger == 'fee' else 'lpAssetsRaw'])

    def test_changed_method_blocks_fee_prefix_and_position_proof_without_rpc_proof_reuse(self):
        for ledger in ('fee', 'position'):
            with self.subTest(ledger=ledger):
                self.setUp()
                saved = self.pending(ledger, proof=ledger == 'position')
                with patch('historical_work.METHOD_DIGEST', 'new-code'), \
                        patch.object(PositionIndexer, 'check_positions') as checks:
                    self.assert_blocked(ledger, 'historical_work_method_mismatch', saved)
                checks.assert_not_called()

    def test_legacy_unbound_work_requires_explicit_restart(self):
        for ledger in ('fee', 'position'):
            self.setUp()
            saved = self.pending(ledger)
            for field in ('methodDigest', 'sourceDigest', 'checkpointDigest'):
                saved.pop(field)
            self.write_progress(ledger, saved)
            self.assert_blocked(ledger, 'historical_work_method_mismatch', saved)
            counts = self.counts()
            result = self.ledger_worker(ledger).restart(POOL)
            self.assertEqual(result['discardedCheckpointDigest'], historical_work.digest(saved))
            self.assertTrue(result['qualifiedHistoryRetained'])
            self.assertEqual(counts, self.counts())
            self.assertIsNone(self.work(ledger))
            self.finish(ledger)

    def test_changed_source_event_at_same_count_cannot_resume(self):
        for ledger in ('fee', 'position'):
            self.setUp()
            saved = self.pending(ledger)
            with self.catalogue.connection(writer=True, lock=True) as conn:
                conn.execute("UPDATE domino_activity.events SET payload=payload || '{\"reviewProbe\":true}'::jsonb WHERE kind='swap'")
            self.assert_blocked(ledger, 'historical_work_source_mismatch', saved)

    def test_changed_position_fee_source_cannot_reuse_proof(self):
        saved = self.pending('position', proof=True)
        with self.catalogue.connection(writer=True, lock=True) as conn:
            conn.execute("UPDATE domino_activity.fee_chunks SET model=model || '{\"reviewProbe\":true}'::jsonb")
        self.assert_blocked('position', 'historical_work_source_mismatch', saved)

    def test_changed_prefix_model_and_proof_offset_are_integrity_checked(self):
        for field, value in (('activity', {'changed': True}), ('checks', 2), ('rows', [])):
            self.setUp()
            saved = self.pending('position', proof=True)
            saved[field] = value
            self.write_progress('position', saved)
            self.assert_blocked('position', 'historical_work_checkpoint_mismatch', saved)

    def test_resealed_incomplete_journal_is_rejected(self):
        saved = self.pending('position', proof=True)
        saved['rows'] = saved['rows'][:-1]
        saved.pop('checkpointDigest')
        saved = historical_work.seal(saved, saved['sourceDigest'])
        self.write_progress('position', saved)
        self.assert_blocked('position', 'historical_work_checkpoint_mismatch', saved)

    def test_resealed_same_count_journal_cannot_substitute_source_identities(self):
        for ledger in ('fee', 'position'):
            for field in ('blockHash', 'logIndex', 'order'):
                with self.subTest(ledger=ledger, field=field):
                    self.setUp()
                    if ledger == 'position':
                        saved = self.pending(ledger, proof=True)
                        self.assertGreater(saved['checks'], 0)
                    else:
                        with patch('historical_capacity.MAX_BATCH_EVENTS', 16):
                            result = self.ledger_worker(ledger).step(POOL)
                        self.assertEqual(result['status'], 'fee_chunk_in_progress')
                        saved = self.work(ledger)['progress']
                    count = len(saved['rows'])
                    self.assertGreater(count, 1)
                    if field == 'order':
                        saved['rows'][0], saved['rows'][-1] = saved['rows'][-1], saved['rows'][0]
                    elif field == 'blockHash':
                        saved['rows'][0][field] = '0x' + 'ab' * 32
                    else:
                        saved['rows'][0][field] += 1
                    # Recompute the digest to exercise source-row identity guards,
                    # independently of the outer checkpoint integrity check.
                    saved.pop('checkpointDigest')
                    saved = historical_work.seal(saved, saved['sourceDigest'])
                    self.assertEqual(len(saved['rows']), count)
                    self.write_progress(ledger, saved)
                    with patch.object(PositionIndexer, 'check_positions') as proof:
                        self.assert_blocked(ledger, 'historical_work_checkpoint_mismatch', saved)
                    proof.assert_not_called()

    def test_restart_after_partial_proof_replays_every_settlement_exactly_once(self):
        self.pending('position', proof=True)
        before = self.counts()
        result = self.ledger_worker('position').restart(POOL)
        self.assertEqual(result['status'], 'position_work_restarted')
        self.assertEqual(self.counts(), before)
        self.assertIsNone(self.work('position'))
        self.assertEqual(self.ledger_worker('position').restart(POOL)['status'], 'no_position_work')
        self.finish('position')
        report = self.store.read(POOL)['liquidity']['positionAccounting']
        self.assertEqual(report['lpAssetsRaw'], reference()['sequence'][-1]['expectedAssetsRaw'])
        expected = sum(e['event']['kind'] == 'modify_liquidity' for e in reference()['sequence'])
        self.assertEqual(self.counts()[-1], expected)

    def test_restart_refuses_orphaned_source_and_preserves_checkpoint(self):
        for ledger in ('fee', 'position'):
            self.setUp()
            self.pending(ledger)
            saved = self.work(ledger)
            self.rpc.fork_at = 30
            with self.assertRaisesRegex(DataError, 'activity_reorg_requires_replay'):
                self.ledger_worker(ledger).restart(POOL)
            self.assertEqual(self.work(ledger), saved)

    def test_restart_network_failure_preserves_checkpoint(self):
        self.pending('position', proof=True)
        saved = self.work('position')
        worker = self.ledger_worker('position')
        with patch.object(worker.activity.chain, 'block', side_effect=DataError('network_unavailable')):
            with self.assertRaisesRegex(DataError, 'network_unavailable'):
                worker.restart(POOL)
        self.assertEqual(self.work('position'), saved)

    def test_operator_cli_records_reviewed_restart_and_replays_same_chunk(self):
        for ledger, module in (('fee', manage_fees), ('position', manage_positions)):
            self.setUp()
            saved = self.pending(ledger)
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'reviewed-restart.json'
                with patch.object(sys, 'argv', [module.__name__, '--pool-id', POOL,
                        '--restart-unpublished-work', '--max-steps', '1', '--output', str(output)]), \
                        patch.object(module, 'configured_catalogue', return_value=self.catalogue), \
                        patch.object(module, 'load_config', return_value={'rpcUrl': 'http://offline.invalid'}), \
                        patch.object(module, 'ReadRpc', return_value=self.rpc), \
                        patch.object(module, 'DiscoveryReader'), redirect_stdout(io.StringIO()):
                    self.assertEqual(module.main(), 0)
                report = json.loads(output.read_text())
                self.assertEqual(report['steps'][0]['status'], ledger + '_work_restarted')
                self.assertEqual(report['steps'][0]['discardedCheckpointDigest'], historical_work.digest(saved))
                self.assertEqual(report['steps'][1]['status'], ledger + '_chunk_reconciled')
                self.assertFalse(report['liveExecution'])
                self.assertIsNone(self.work(ledger))

    def test_jsonb_byte_budget_matches_database_normalization_exactly(self):
        with self.catalogue.connection(writer=True, lock=True) as conn:
            for value in ({'value': 1e100}, {'value': '\u00e9' * 30}):
                size = conn.execute('SELECT octet_length(%s::jsonb::text) AS size', (Jsonb(value),)).fetchone()['size']
                self.assertNotEqual(size, len(json.dumps(value).encode()))
                with patch('historical_capacity.MAX_PROGRESS_BYTES', size):
                    historical_capacity.check_work_size(value, conn)
                with patch('historical_capacity.MAX_PROGRESS_BYTES', size - 1):
                    with self.assertRaisesRegex(DataError, 'historical_work_byte_budget_exhausted'):
                        historical_capacity.check_work_size(value, conn)

    def test_maximum_proof_count_is_derived_from_trusted_profiles(self):
        with patch.dict(historical_capacity.PROFILES, {'review': historical_capacity.Capacity('review', 1200, 2400)}):
            self.assertEqual(historical_capacity.maximum_checks(), 4800)
            value = {'version': 1, 'offset': 0, 'totalEvents': 0, 'checks': 4800,
                     'rows': [], 'model': {'version': 1}, 'activity': {}}
            self.pending('fee')
            self.write_progress('fee', value)
            with self.catalogue.connection() as conn:
                self.assertEqual(historical_capacity.load_work(conn, POOL, 'fee', 10), value)
                value['checks'] = 4801
            self.write_progress('fee', value)
            with self.catalogue.connection() as conn:
                with self.assertRaisesRegex(DataError, 'historical_work_checkpoint_mismatch'):
                    historical_capacity.load_work(conn, POOL, 'fee', 10)

    def later_chunk(self, ledger):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc = PositionFixtureRpc()
        activity = ActivityIndexer(self.store, self.rpc)
        activity.register(POOL, 10)
        activity.step(POOL, through=18)
        self.finish('fee')
        self.finish('position')
        activity.step(POOL, through=30)
        return self.pending(ledger)

    def test_changed_previous_model_with_same_event_count_blocks_resume(self):
        for ledger, table in (('fee', 'fee_chunks'), ('position', 'position_chunks')):
            saved = self.later_chunk(ledger)
            with self.catalogue.connection(writer=True, lock=True) as conn:
                conn.execute('UPDATE domino_activity.' + table +
                             " SET model=model || '{\"reviewProbe\":true}'::jsonb WHERE chunk_start=10")
            self.assert_blocked(ledger, 'historical_work_source_mismatch', saved)

    def test_later_restart_preserves_prior_qualified_rows_and_journals(self):
        for ledger in ('fee', 'position'):
            self.later_chunk(ledger)
            def prior():
                with self.catalogue.connection() as conn:
                    return [conn.execute('SELECT * FROM domino_activity.' + table +
                                         ' WHERE chunk_start=10').fetchall() for table in
                            ('fee_chunks', 'fee_events', 'position_chunks', 'position_settlements')]
            before = prior()
            result = self.ledger_worker(ledger).restart(POOL)
            self.assertEqual(result['fromBlock'], 19)
            self.assertEqual(prior(), before)
            self.finish(ledger)
            self.assertEqual(prior(), before)

    def test_restart_refuses_work_attached_to_already_qualified_chunk(self):
        saved = self.pending('fee')
        self.finish('fee')
        with self.catalogue.connection(writer=True, lock=True) as conn:
            chunk = conn.execute('SELECT * FROM domino_activity.chunks WHERE pool_id=%s', (POOL,)).fetchone()
            historical_capacity.save_work(conn, POOL, 'fee', chunk, historical_capacity.PROFILES['standard'], saved)
        before = self.work('fee')
        counts = self.counts()
        with self.assertRaisesRegex(DataError, 'historical_work_already_qualified'):
            self.ledger_worker('fee').restart(POOL)
        self.assertEqual(self.work('fee'), before)
        self.assertEqual(self.counts(), counts)

    def test_actual_eight_mib_save_and_one_byte_overflow_preserve_checkpoint(self):
        value = self.pending('fee')
        value['sizeProbe'] = ''
        with self.catalogue.connection(writer=True, lock=True) as conn:
            chunk = conn.execute('SELECT * FROM domino_activity.chunks WHERE pool_id=%s', (POOL,)).fetchone()
            size = conn.execute('SELECT octet_length(%s::jsonb::text) AS size', (Jsonb(value),)).fetchone()['size']
            value['sizeProbe'] = 'x' * (historical_capacity.MAX_PROGRESS_BYTES - size)
            historical_capacity.save_work(conn, POOL, 'fee', chunk, historical_capacity.PROFILES['standard'], value)
        before = self.work('fee')
        counts = self.counts()
        value['sizeProbe'] += 'x'
        with self.assertRaisesRegex(DataError, 'historical_work_byte_budget_exhausted'):
            with self.catalogue.connection(writer=True, lock=True) as conn:
                historical_capacity.save_work(conn, POOL, 'fee', chunk, historical_capacity.PROFILES['standard'], value)
        self.assertEqual(self.work('fee'), before)
        self.assertEqual(self.counts(), counts)
        self.assertIsNone(self.store.read(POOL)['fees']['accounting']['lpFeesRaw'])


if __name__ == '__main__':
    unittest.main()
