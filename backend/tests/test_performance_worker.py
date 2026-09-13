"""Acquisition-to-journal recovery against this worktree's isolated PostgreSQL."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from dev_postgres import ADMIN, PORT, SOCKET
from performance_collection import CollectionError, ReorgDetected
from performance_store import PerformanceStore, PerformanceStoreError, COLLECTOR_ROLE
from performance_worker import PerformanceWorker
from test_performance_store import OWNER, OTHER, baseline, page, replace, h


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires task-local PostgreSQL')
class PerformanceWorkerTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_performance.epochs CASCADE')
        self.store = PerformanceStore(self.settings, role=COLLECTOR_ROLE)
        self.base = baseline()
        self.collector = Mock()
        self.collector.capture.return_value = self.base
        self.worker = PerformanceWorker(self.collector, self.store)
        self.opening = self.worker.capture(OWNER, self.base.vault, ['101'], self.base.vaultCodeHash)

    def test_forward_page_failure_and_process_restart_preserve_measurement(self):
        first = page(self.base)
        self.collector.collect.return_value = first
        saved = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(saved.outcome, 'advanced')
        self.collector.collect.side_effect = CollectionError('do_not_store_provider_secret')
        failed = self.worker.advance(OWNER, self.base.epochId)
        for key in ('baseline', 'cursor', 'eventCount', 'receiptCount'):
            self.assertEqual(saved.record[key], failed.record[key])
        self.assertEqual(failed.record['lastError'], 'collection_read_failed')
        self.collector.collect.side_effect = None
        self.collector.collect.return_value = page(self.base, start=first.throughCursor)
        restarted = PerformanceWorker(self.collector, PerformanceStore(self.settings, role=COLLECTOR_ROLE))
        recovered = restarted.advance(OWNER, self.base.epochId)
        self.assertEqual((recovered.outcome, recovered.record['eventCount']), ('advanced', 2))
        self.assertEqual(recovered.record['baseline'], self.opening.record['baseline'])
        self.assertEqual(recovered.record['status'], 'active')

    def test_reorg_replays_preserving_event_identity_then_changed_baseline_blocks(self):
        first = page(self.base)
        self.collector.collect.return_value = first
        self.worker.advance(OWNER, self.base.epochId)
        self.collector.collect.side_effect = ReorgDetected('changed', self.base.baseline)
        replay = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual((replay.outcome, replay.record['eventCount']), ('replaying', 0))
        self.collector.collect.side_effect = None
        self.collector.collect.return_value = page(self.base, block_hash=h(555), global_index=99)
        recovered = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(recovered.record['eventCount'], 1)
        rows = self.admin.execute('SELECT event_id,canonical FROM domino_performance.events').fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['event_id'], rows[1]['event_id'])
        self.assertEqual(sum(row['canonical'] for row in rows), 1)
        self.collector.collect.side_effect = ReorgDetected('changed', replace(self.base.baseline, blockHash=h(777)))
        blocked = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(blocked.outcome, 'baseline_reorged')
        self.collector.collect.reset_mock()
        self.assertEqual(self.worker.advance(OWNER, self.base.epochId).outcome, 'baseline_reorged')
        self.collector.collect.assert_not_called()

    def test_caught_up_or_unconfirmed_reorg_never_reset_or_invent_a_baseline(self):
        self.collector.collect.side_effect = ReorgDetected('unknown')
        failed = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(failed.outcome, 'read_failed')
        self.assertEqual(failed.record['baseline'], self.opening.record['baseline'])
        self.collector.collect.side_effect = None
        self.collector.collect.return_value = None
        unchanged = self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(unchanged.record, failed.record)

    def test_concurrent_newer_result_fences_slow_failure_and_foreign_epoch_has_no_rpc(self):
        def slow_failure(base, cursor):
            self.store.append_page(OWNER, base.epochId, 1, page(base))
            raise CollectionError('late')
        self.collector.collect.side_effect = slow_failure
        with self.assertRaises(PerformanceStoreError) as caught:
            self.worker.advance(OWNER, self.base.epochId)
        self.assertEqual(caught.exception.code, 'performance_version_conflict')
        self.assertEqual(self.store.read_epoch(OWNER, self.base.epochId)['status'], 'active')
        self.collector.collect.reset_mock()
        with self.assertRaises(PerformanceStoreError): self.worker.advance(OTHER, self.base.epochId)
        self.collector.collect.assert_not_called()
