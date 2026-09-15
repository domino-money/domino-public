"""Real PostgreSQL capital checkpoints with synthetic canonical/RPC failures."""
import copy
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import capital_work
from activity_indexer import ActivityIndexer
from capital_store import CapitalIndexer
from catalogue import PgCatalogue
from dev_postgres import ADMIN, BIN, PORT, ROOT, SOCKET, create_database
from discovery import DataError
from fee_store import FeeIndexer
from manage_metrics import run
from metrics_service import stored_metrics
from pool_activity import PROTOCOL
from position_store import PositionIndexer
from test_discovery import POOL
from test_catalogue import block_hash
from test_historical_capacity import ChurnRpc
import test_pool_activity as activity_tests
from test_pool_activity import event_log
from test_position_accounting import PositionFixtureRpc, reference


class CapitalWorkerUnitTests(unittest.TestCase):
    def test_diagnostic_failure_cannot_mask_capital_failure(self):
        for reason in ('catalogue_writer_busy', 'catalogue_database_unavailable'):
            store = MagicMock()
            worker = CapitalIndexer(store, None)
            original = DataError('capital_work_method_mismatch')
            store.catalogue.connection.side_effect = DataError(reason)
            with patch.object(worker, '_step', side_effect=original):
                with self.assertRaises(DataError) as caught:
                    worker.step(POOL)
            self.assertIs(caught.exception, original)

    def test_invocation_bounds_reject_before_configuration_or_network(self):
        for steps in (0, 51, True, '1'):
            with patch('manage_metrics.configured_writer_catalogue') as configuration:
                with self.assertRaisesRegex(DataError, 'invalid_metrics_bounds'):
                    run(POOL, steps, False)
                configuration.assert_not_called()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class CapitalResumePostgresTests(unittest.TestCase):
    settings = activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc = PositionFixtureRpc()
        self.source(30)

    def source(self, through):
        self.activity = ActivityIndexer(self.store, self.rpc)
        self.activity.register(POOL, 10)
        self.activity.step(POOL, through=through)
        self.finish(lambda: FeeIndexer(self.store, self.rpc))
        self.finish(lambda: PositionIndexer(self.store, self.rpc, capacity='extended'))

    def finish(self, factory, maximum=100):
        for _ in range(maximum):
            result = factory().step(POOL)
            if result['status'].endswith('_chunk_reconciled'):
                return result
        self.fail('synthetic work did not finish within a finite invocation count')

    def work(self):
        with self.catalogue.connection() as conn:
            return conn.execute("SELECT * FROM domino_activity.historical_work WHERE pool_id=%s AND ledger='capital'",
                                (POOL,)).fetchone()

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.' + table).fetchone()['n']
                         for table in ('capital_chunks', 'capital_events', 'chunks', 'position_chunks'))

    def assert_unpublished(self, expected_error=None):
        self.assertEqual(self.counts()[:2], (0, 0))
        if expected_error:
            with self.assertRaisesRegex(DataError, expected_error):
                stored_metrics(self.catalogue, POOL)
        else:
            report = stored_metrics(self.catalogue, POOL)
            self.assertEqual(report['capital']['reason'], 'capital_ledger_not_caught_up')
            self.assertIsNone(report['capital']['current'])
            self.assertIsNone(report['valuation']['feeAprPercent'])
        # Independently verified source accounting survives the capital delay.
        self.assertEqual(self.store.read(POOL)['liquidity']['positionAccounting']['status'], 'reconciled_as_of')

    def churn(self, count=129):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc = ChurnRpc(count)
        self.source(11)
        self.rpc.checked.clear()

    def test_event_resume_publishes_every_native_point_only_after_final_proof(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 2), patch('position_store.MAX_BATCH_CHECKS', 2):
            first = CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(first['processedEvents'], 2)
            self.assertEqual(len(self.work()['progress']['rows']), 2)
            self.assert_unpublished()
            self.finish(lambda: CapitalIndexer(self.store, self.rpc))
        self.assertIsNone(self.work())
        with self.catalogue.connection() as conn:
            points = conn.execute('''SELECT e.block_number,k.log_index,k.capital FROM domino_activity.capital_events k
              JOIN domino_activity.events e ON e.pool_id=k.pool_id AND e.block_hash=k.block_hash
              AND e.log_index=k.log_index''').fetchall()
        by_event = {(p['block_number'], p['log_index']): p['capital'] for p in points}
        expected = reference()['sequence']
        self.assertEqual(len(points), len(expected))
        for entry in expected:
            event = entry['event']
            self.assertEqual(by_event[(event['blockNumber'], event['logIndex'])]['lpAssetsRaw'], entry['expectedAssetsRaw'])
        self.assertIsNone(stored_metrics(self.catalogue, POOL)['valuation']['tvlUsd'])

    def test_129_identities_resume_516_distinct_proofs_with_finite_requests(self):
        self.churn()
        with self.assertRaisesRegex(DataError, 'core_position_budget_exhausted'):
            self.finish(lambda: CapitalIndexer(self.store, self.rpc))
        saved = self.work()
        self.assertEqual(saved['progress']['offset'], 256)
        self.assertEqual(saved['diagnostic']['action'], 'select_extended_profile_and_resume')
        self.assert_unpublished()
        total_requests = []
        original_request, original_call = self.rpc.request, self.rpc.call
        def request(*args, **kwargs):
            total_requests.append('request')
            return original_request(*args, **kwargs)
        def call(*args, **kwargs):
            total_requests.append('call')
            return original_call(*args, **kwargs)
        steps = 0
        with patch.object(self.rpc, 'request', side_effect=request), patch.object(self.rpc, 'call', side_effect=call):
            while True:
                before_calls = len(total_requests)
                before_checks = len(self.rpc.checked)
                result = CapitalIndexer(self.store, self.rpc, capacity='extended').step(POOL)
                self.assertLessEqual(len(total_requests) - before_calls, 160)
                self.assertLessEqual(len(self.rpc.checked) - before_checks, 128)
                steps += 1
                if result['status'] == 'capital_chunk_reconciled':
                    break
                self.assertLessEqual(steps, 6)
                self.assert_unpublished()
        self.assertEqual(steps, 5)
        self.assertEqual(len(self.rpc.checked), 516)
        self.assertEqual(len(set(self.rpc.checked)), 516)
        self.assertEqual(self.counts()[:2], (1, 259))
        self.assertIsNone(self.work())
        current = stored_metrics(self.catalogue, POOL)['capital']['current']
        self.assertEqual(current['lpAssetsRaw'], self.rpc.expected['lpAssetsRaw'])
        # The closed synthetic positions leave 129 observed rounding units;
        # zero liquidity is not permission to erase their capital evidence.
        self.assertEqual(current['roundingResidualRaw'], ['129', '0'])

    def test_128_threshold_succeeds_and_later_empty_and_nonempty_129_chunks_stay_bounded(self):
        self.churn(128)
        self.finish(lambda: CapitalIndexer(self.store, self.rpc))
        self.assertEqual(self.counts()[:2], (1, 257))
        self.churn(129)
        self.finish(lambda: CapitalIndexer(self.store, self.rpc, capacity='extended'))
        for through, new_event in ((12, False), (14, True)):
            if new_event:
                self.rpc.logs.append(event_log(PROTOCOL, [0], number=14, index=0))
            self.source(through)
            before = self.counts()
            with self.assertRaisesRegex(DataError, 'core_position_budget_exhausted'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(self.counts(), before)
            self.assertEqual(self.work()['diagnostic']['action'], 'select_extended_profile_and_resume')
            self.assertEqual(stored_metrics(self.catalogue, POOL)['capital']['reason'], 'capital_ledger_not_caught_up')
            self.rpc.checked.clear()
            first = CapitalIndexer(self.store, self.rpc, capacity='extended').step(POOL)
            self.assertEqual(first['completedChecks'], 128)
            checkpoint = self.work()['progress']
            with self.assertRaisesRegex(DataError, 'core_position_budget_exhausted'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(self.work()['progress'], checkpoint)
            self.finish(lambda: CapitalIndexer(self.store, self.rpc, capacity='extended'))
            self.assertEqual(len(self.rpc.checked), 516)
            self.assertEqual(self.counts()[:2], (before[0] + 1, before[1] + int(new_event)))

    def test_failed_proof_batch_keeps_last_prefix_and_late_mismatch_never_publishes(self):
        with patch('position_store.MAX_BATCH_CHECKS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
            before = self.work()['progress']
            self.rpc.fail_position = True
            with self.assertRaisesRegex(DataError, 'network_unavailable'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(self.work()['progress'], before)
            self.assertEqual(self.work()['diagnostic']['reason'], 'network_unavailable')
            self.rpc.fail_position = False
            while self.work()['progress']['checks'] < self.work()['progress']['requiredChecks'] - 1:
                CapitalIndexer(self.store, self.rpc).step(POOL)
            before = self.work()['progress']
            self.rpc.corrupt = 'tick'
            with self.assertRaisesRegex(DataError, 'core_tick_state_reconciliation_failed'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(self.work()['progress'], before)
            self.assert_unpublished('upstream_contract_mismatch')
            self.rpc.corrupt = None
            CapitalIndexer(self.store, self.rpc).step(POOL)
        self.assertIsNone(self.work())

    def test_shared_simulation_budget_checkpoints_only_complete_events(self):
        with patch('fee_accounting.MAX_CHUNK_STEPS', 100):
            first = CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(first['status'], 'capital_chunk_in_progress')
            progress = self.work()['progress']
            self.assertGreater(progress['offset'], 0)
            self.assertEqual(len(progress['rows']), progress['offset'])
            self.assert_unpublished()
            self.finish(lambda: CapitalIndexer(self.store, self.rpc))
        self.assertIsNone(self.work())

    def test_method_source_and_checkpoint_changes_require_explicit_reviewed_restart(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 2):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.work()['progress']
        for change in ('method', 'source', 'checkpoint'):
            with self.subTest(change=change):
                if change == 'method':
                    context = patch('capital_work.METHOD_DIGEST', 'new-implementation')
                elif change == 'source':
                    context = patch('capital_work.bind_source', return_value='changed-source')
                else:
                    tampered = copy.deepcopy(before)
                    tampered['model']['lpAssetsRaw'][0] = '1'
                    with self.catalogue.connection(writer=True) as conn:
                        conn.execute("UPDATE domino_activity.historical_work SET progress=%s WHERE ledger='capital'",
                                     (Jsonb(tampered),))
                    context = patch('capital_work.METHOD_DIGEST', capital_work.METHOD_DIGEST)
                with context:
                    with self.assertRaisesRegex(DataError, 'capital_work_' + change + '_mismatch'):
                        CapitalIndexer(self.store, self.rpc).step(POOL)
                self.assertEqual(self.work()['diagnostic']['action'], 'restart_capital_work_after_review')
                self.assert_unpublished('upstream_contract_mismatch')
                # This operator action replays from source and never edits source ledgers.
                counts = self.counts()
                restart = CapitalIndexer(self.store, self.rpc).restart(POOL)
                self.assertEqual(restart['status'], 'capital_work_restarted')
                self.assertEqual(self.counts(), counts)
                self.assertIsNone(self.work())
                with patch('historical_capacity.MAX_BATCH_EVENTS', 2):
                    CapitalIndexer(self.store, self.rpc).step(POOL)
                self.assertEqual(self.work()['progress'], before)
        self.finish(lambda: CapitalIndexer(self.store, self.rpc))

    def test_actual_stored_source_mutation_invalidates_saved_prefix(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 2):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute("UPDATE domino_activity.events SET payload=payload || '{\"sourceRevision\":1}'::jsonb WHERE block_number=10")
        with self.assertRaisesRegex(DataError, 'capital_work_source_mismatch'):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        self.assert_unpublished('upstream_contract_mismatch')

    def test_method_change_during_proof_cannot_reuse_completed_checks(self):
        with patch('position_store.MAX_BATCH_CHECKS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.work()['progress']
        self.assertEqual(before['offset'], before['totalEvents'])
        self.assertEqual(before['checks'], 1)
        with patch('capital_work.METHOD_DIGEST', 'changed-proof-implementation'):
            with self.assertRaisesRegex(DataError, 'capital_work_method_mismatch'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
        self.assertEqual(self.work()['progress'], before)
        self.assert_unpublished('upstream_contract_mismatch')

    def test_resealed_same_count_capital_points_cannot_change_source_identity(self):
        for field in ('blockHash', 'logIndex', 'order'):
            with self.subTest(field=field):
                self.setUp()
                with patch('position_store.MAX_BATCH_CHECKS', 1):
                    CapitalIndexer(self.store, self.rpc).step(POOL)
                saved = self.work()['progress']
                self.assertEqual(saved['checks'], 1)
                count = len(saved['rows'])
                self.assertGreater(count, 1)
                if field == 'order':
                    saved['rows'][0], saved['rows'][-1] = saved['rows'][-1], saved['rows'][0]
                elif field == 'blockHash':
                    saved['rows'][0][field] = '0x' + 'ab' * 32
                else:
                    saved['rows'][0][field] += 1
                saved.pop('checkpointDigest')
                saved = capital_work.seal(saved, saved['sourceDigest'])
                self.assertEqual(len(saved['rows']), count)
                with self.catalogue.connection(writer=True) as conn:
                    conn.execute("UPDATE domino_activity.historical_work SET progress=%s WHERE ledger='capital'",
                                 (Jsonb(saved),))
                before = self.counts()
                with patch.object(PositionIndexer, 'check_positions') as proof:
                    with self.assertRaisesRegex(DataError, 'capital_work_checkpoint_mismatch'):
                        CapitalIndexer(self.store, self.rpc).step(POOL)
                proof.assert_not_called()
                self.assertEqual(self.work()['progress'], saved)
                self.assertEqual(self.counts(), before)
                self.assert_unpublished('upstream_contract_mismatch')

    def test_database_failure_after_chunk_insert_rolls_back_all_points_and_keeps_saved_work(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.work()['progress']
        with psycopg.connect(**self.settings, user=ADMIN) as conn:
            # The first event at block10 is accepted; a subsequent event fails.
            conn.execute(sql.SQL('ALTER TABLE domino_activity.capital_events ADD CONSTRAINT capital_test_write_failure CHECK(block_hash={})')
                         .format(sql.Literal(block_hash(10))))
        try:
            with self.assertRaisesRegex(DataError, 'catalogue_database_unavailable'):
                CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assert_unpublished('catalogue_database_unavailable')
            self.assertEqual(self.work()['progress'], before)
        finally:
            with psycopg.connect(**self.settings, user=ADMIN) as conn:
                conn.execute('ALTER TABLE domino_activity.capital_events DROP CONSTRAINT capital_test_write_failure')
        CapitalIndexer(self.store, self.rpc).step(POOL)
        self.assertIsNone(self.work())

    def test_reorg_mid_batch_and_between_batches_preserves_then_cascades_unpublished_work(self):
        with patch('position_store.MAX_BATCH_CHECKS', 1):
            worker = CapitalIndexer(self.store, self.rpc)
            worker.step(POOL)
            before = self.work()['progress']
            check = worker.positions.check_positions
            def fork(*args):
                proof = check(*args)
                self.rpc.fork_at = 18
                return proof
            with patch.object(worker.positions, 'check_positions', side_effect=fork):
                with self.assertRaisesRegex(DataError, 'reorg_requires_replay'):
                    worker.step(POOL)
            self.assertEqual(self.work()['progress'], before)
            with self.assertRaisesRegex(DataError, 'reorg_requires_replay'):
                worker.step(POOL)
            with self.assertRaisesRegex(DataError, 'reorg_requires_replay'):
                worker.restart(POOL)
            self.assertEqual(self.work()['progress'], before)
            self.assertEqual(self.counts()[:2], (0, 0))
            self.activity.step(POOL, through=30)
            self.assertIsNone(self.work())
            self.assertEqual(self.counts(), (0, 0, 0, 0))

    def test_saved_source_failures_reach_reads_without_becoming_ordinary_lag(self):
        # Persist the actual record_failure diagnostic with no unpublished prefix.
        # Reads must preserve both the raw diagnostic and every committed table.
        before = self.counts()
        for reason in ('network_unavailable', 'rpc_error', 'read_deadline_exceeded',
                       'catalogue_database_unavailable', 'capital_work_source_mismatch'):
            worker = CapitalIndexer(self.store, self.rpc)
            with self.subTest(reason=reason), patch.object(worker, '_step', side_effect=DataError(reason)):
                with self.assertRaisesRegex(DataError, reason): worker.step(POOL)
                saved = self.work()
                self.assertEqual(saved['diagnostic']['reason'], reason)
                expected = 'upstream_contract_mismatch' if reason == 'capital_work_source_mismatch' else reason
                self.assert_unpublished(expected)
                self.assertEqual(self.work(), saved)
                self.assertEqual(self.counts(), before)

    def test_unavailable_verification_preserves_operator_restart_target(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.work()
        worker = CapitalIndexer(self.store, self.rpc)
        with patch.object(worker.activity.chain, 'block', side_effect=DataError('network_unavailable')):
            with self.assertRaisesRegex(DataError, 'network_unavailable'):
                worker.restart(POOL)
        self.assertEqual(self.work(), before)

    def test_progress_byte_failure_keeps_prefix_but_final_publication_has_no_sidecar_gate(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
            before = self.work()['progress']
            with patch('historical_capacity.MAX_PROGRESS_BYTES', 1):
                with self.assertRaisesRegex(DataError, 'historical_work_byte_budget_exhausted'):
                    CapitalIndexer(self.store, self.rpc).step(POOL)
            self.assertEqual(self.work()['progress'], before)
            # This fault injection persists a non-contract one-byte profile.
            # The read boundary must reject that shape, never normalize it away.
            self.assert_unpublished('upstream_contract_mismatch')
        with patch('historical_capacity.MAX_PROGRESS_BYTES', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        self.assertIsNone(self.work())

    def test_bounded_cli_reports_pending_without_valuation_or_price_acquisition(self):
        with patch('manage_metrics.configured_writer_catalogue', return_value=self.catalogue), \
                patch('manage_metrics.load_config', return_value={'rpcUrl': 'https://offline.invalid'}), \
                patch('manage_metrics.ReadRpc', return_value=self.rpc) as rpc, \
                patch('manage_metrics.stored_metrics') as metrics, \
                patch('manage_metrics.AlchemyHistorical') as prices, \
                patch('historical_capacity.MAX_BATCH_EVENTS', 1), redirect_stdout(io.StringIO()):
            result = run(POOL, 1, True, capacity='extended')
        self.assertEqual(len(result['steps']), 1)
        self.assertEqual(result['capitalLedger']['status'], 'in_progress')
        self.assertEqual(result['capitalLedger']['historicalWork']['processedEvents'], 1)
        self.assertIsNone(result['result'])
        self.assertEqual(result['priceIngestion'], [])
        self.assertEqual(rpc.call_args.kwargs['max_requests'], 160)
        metrics.assert_not_called(); prices.assert_not_called()

    def test_reader_grants_backup_restore_and_upgrade_preserve_pending_work(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS', 1):
            CapitalIndexer(self.store, self.rpc).step(POOL)
        before = self.work()
        with self.assertRaises(DataError):
            with self.catalogue.connection() as conn:
                conn.execute("DELETE FROM domino_activity.historical_work WHERE ledger='capital'")
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'capital-resume.dump'
            common = ['-h', str(SOCKET), '-p', str(PORT), '-U', ADMIN]
            subprocess.run([str(BIN / 'pg_dump'), *common, '-Fc', '-n', 'domino_activity', '-f', str(archive),
                            'domino_catalogue_tests'], check=True, capture_output=True)
            subprocess.run([str(BIN / 'pg_restore'), *common, '--clean', '--if-exists', '--exit-on-error',
                            '-d', 'domino_catalogue_restore_tests', str(archive)], check=True, capture_output=True)
        restored = PgCatalogue({**self.settings, 'dbname': 'domino_catalogue_restore_tests'})
        with restored.connection() as conn:
            self.assertEqual(conn.execute("SELECT * FROM domino_activity.historical_work WHERE ledger='capital'").fetchone(), before)
        from activity_store import PgActivity
        self.finish(lambda: CapitalIndexer(PgActivity(restored), self.rpc))
        with restored.connection() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM domino_activity.historical_work WHERE ledger='capital'").fetchone())
        # Simulate an upgraded 007 database with a durable fee checkpoint, then
        # reapply 007 -> 012 twice; data and SELECT-only grants survive both runs.
        with psycopg.connect(**{**self.settings, 'dbname': 'domino_catalogue_restore_tests'}, user=ADMIN) as conn:
            conn.execute("ALTER TABLE domino_activity.historical_work DROP CONSTRAINT historical_work_ledger_check")
            conn.execute("ALTER TABLE domino_activity.historical_work ADD CONSTRAINT historical_work_ledger_check CHECK(ledger IN ('fee','position'))")
            conn.execute("INSERT INTO domino_activity.historical_work VALUES(%s,'fee',%s,%s,%s)",
                         (POOL, before['chunk_start'], Jsonb(before['progress']), Jsonb(before['diagnostic'])))
            for _ in range(2):
                conn.execute((ROOT / 'migrations/007_historical_work.sql').read_text())
                conn.execute((ROOT / 'migrations/012_capital_work.sql').read_text())
            self.assertEqual(conn.execute("SELECT progress FROM domino_activity.historical_work WHERE ledger='fee'").fetchone()[0], before['progress'])
            conn.execute("INSERT INTO domino_activity.historical_work VALUES(%s,'capital',%s,%s,%s)",
                         (POOL, before['chunk_start'], Jsonb(before['progress']), Jsonb(before['diagnostic'])))
        with restored.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_activity.historical_work').fetchone()['n'], 2)

    def test_fresh_database_applies_capital_constraint_and_keeps_reader_select_only(self):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            conn.execute('DROP DATABASE domino_catalogue_restore_tests')
        create_database('domino_catalogue_restore_tests')
        with psycopg.connect(**{**self.settings, 'dbname': 'domino_catalogue_restore_tests'}, user=ADMIN) as conn:
            definition = conn.execute("""SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid='domino_activity.historical_work'::regclass
              AND conname='historical_work_ledger_check'""").fetchone()[0]
            self.assertIn('capital', definition)
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_activity.historical_work').fetchone()[0], 0)
            for role, privilege, expected in (('domino_catalogue_reader', 'SELECT', True),
                                              ('domino_catalogue_reader', 'INSERT', False),
                                              ('domino_catalogue_reader', 'DELETE', False),
                                              ('domino_catalogue_writer', 'INSERT', True)):
                self.assertEqual(conn.execute('SELECT has_table_privilege(%s,%s,%s)',
                    (role, 'domino_activity.historical_work', privilege)).fetchone()[0], expected)
