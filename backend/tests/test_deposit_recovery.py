"""Real-PG liveness, capacity and audited retention regressions for #41."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deposit_archive import archive_terminal
from deposit_store import _Connection, DepositStoreError
from dev_postgres import ADMIN, ROOT
import test_deposit_store as store_tests
from test_deposit_store import OWNER, OTHER, OTHER_HASH, SELECTION, outcome


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires task-local PostgreSQL')
class DepositRecoveryTests(unittest.TestCase):
    setUp = store_tests.DepositStoreTests.setUp
    create = store_tests.DepositStoreTests.create
    issue = store_tests.DepositStoreTests.issue
    reconcile = store_tests.DepositStoreTests.reconcile
    error = store_tests.DepositStoreTests.error

    def foreign(self, **changes):
        value = outcome('mismatched', replacement=True, different_effect=True,
                        cancellation=False, tx_hash=OTHER_HASH, **changes)
        value['reason'] = 'transaction_mismatch'
        return value

    def supersede(self, record):
        original = _Connection.execute
        future = datetime.now(timezone.utc) + timedelta(seconds=61)
        def execute(conn, query, params=None):
            result = original(conn, query, params)
            return SimpleNamespace(fetchone=lambda: {'now': future}) if query == 'SELECT clock_timestamp() AS now' else result
        with patch.object(_Connection, 'execute', execute):
            return self.reconcile(record, self.foreign())

    def counts(self):
        return self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone()

    def test_foreign_finalized_nonce_frees_owner_without_claiming_cancel_or_mint(self):
        for kind in ('erc20_approval', 'mint'):
            with self.subTest(kind=kind):
                issued = self.issue(self.create(), kind=kind)
                final = self.supersede(issued)
                self.assertEqual(final['state'], 'superseded')
                self.assertFalse(final['outstanding'])
                self.assertEqual(final['history'][0]['artifact'], issued['issued'])
                self.assertEqual(final['history'][0]['initialFinalizedReceipt']['transactionHash'], OTHER_HASH)
                self.assertEqual(self.store.get(OWNER, final['id']), final)
                later = self.issue(self.create(), nonce=2)
                self.reconcile(later, outcome('reverted'))

    def test_expiry_without_finalized_foreign_effect_never_releases(self):
        issued = self.issue(self.create(), kind='erc20_approval')
        values = [self.foreign(finalized=False), outcome('not_found', finalized=False, receipt=False),
                  {**self.foreign(), 'differentEffect': False}, {**self.foreign(), 'reason': 'receipt_mismatch'}]
        for value in values:
            pending = self.reconcile(issued, value)
            self.assertTrue(pending['outstanding'])
            self.error('deposit_owner_busy', lambda: self.issue(self.create(), nonce=2))
            issued = pending
        # A finalized foreign transaction before handoff expiry is still held.
        self.assertNotEqual(self.reconcile(issued, self.foreign())['state'], 'superseded')

    def test_reorg_of_supersession_blocks_again_preserves_newer_nonce_and_recovers(self):
        final = self.supersede(self.issue(self.create()))
        newer = self.issue(self.create(), nonce=2)
        reorged = self.reconcile(final, outcome('reorged', finalized=False, receipt=False))
        self.assertEqual(reorged['state'], 'attention')
        self.assertFalse(reorged['outstanding'])
        self.assertTrue(self.store.get(OWNER, newer['id'])['outstanding'])
        self.assertEqual(reorged['history'][0]['initialFinalizedReceipt']['transactionHash'], OTHER_HASH)
        self.error('deposit_owner_busy', lambda: self.issue(self.create(), nonce=3))
        repaired = self.supersede(reorged)
        self.assertTrue(repaired['history'][0]['everReorged'])
        self.reconcile(newer)
        self.assertTrue(self.issue(self.create(), nonce=3)['outstanding'])

    def test_terminal_states_release_active_capacity_but_retain_evidence(self):
        self.store.cancel(OWNER, self.create()['id'], 1)
        self.reconcile(self.issue(self.create()), outcome('reverted'))
        self.reconcile(self.issue(self.create()))
        self.supersede(self.issue(self.create()))
        self.assertEqual(self.counts(), {'used': 0, 'retained': 4})
        self.assertEqual(len(self.store.list(OWNER)), 4)
        draft = self.create()
        pending = self.issue(draft)
        cancelled = self.store.cancel(OWNER, pending['id'], pending['version'])
        self.assertEqual(self.counts()['used'], 1)
        self.assertTrue(cancelled['outstanding'])

    def test_one_owner_cannot_fill_global_active_capacity_or_cancel_churn(self):
        rows = [self.create() for _ in range(16)]
        self.error('deposit_owner_capacity_busy', self.create)
        self.assertEqual(self.create(OTHER)['owner'], OTHER)
        for row in rows:
            self.store.cancel(OWNER, row['id'], row['version'])
        for _ in range(128-16):
            row = self.create()
            self.store.cancel(OWNER, row['id'], row['version'])
        self.error('deposit_owner_history_full', self.create)
        self.assertEqual(self.counts(), {'used': 1, 'retained': 129})
        self.assertEqual(self.create(OTHER)['owner'], OTHER)

    def test_concurrent_owner_quota_and_counters_are_atomic(self):
        for _ in range(15): self.create()
        def attempt(_):
            try: return self.create()['id']
            except DepositStoreError as error: return error.code
        with ThreadPoolExecutor(max_workers=4) as workers:
            values = list(workers.map(attempt, range(4)))
        self.assertEqual(values.count('deposit_owner_capacity_busy'), 3)
        self.assertEqual(self.counts(), {'used': 16, 'retained': 16})

    def old_row(self, *, issued=False, days=100, state='cancelled', outstanding=False):
        record = self.create()
        if issued:
            record = self.issue(record)
            record = self.reconcile(record)
        # Insert old immutable fixture rows instead of editing created_at through
        # the application. These are disposable test databases owned by this task.
        raw = self.admin.execute('SELECT * FROM domino_deposits.intents WHERE id=%s', (record['id'],)).fetchone()
        self.admin.execute('DELETE FROM domino_deposits.intents WHERE id=%s', (record['id'],))
        raw.update(state=state, outstanding=outstanding,
                   created_at=datetime.now(timezone.utc)-timedelta(days=days),
                   updated_at=datetime.now(timezone.utc)-timedelta(days=days))
        columns = list(raw)
        self.admin.execute('INSERT INTO domino_deposits.intents ('+','.join(columns)+') VALUES ('+
            ','.join(['%s']*len(columns))+')', tuple(Jsonb(raw[k]) if k in ('selection','history') else raw[k] for k in columns))
        # Insert admission counts one newly active draft; align this deliberately
        # old terminal fixture using the real idempotent migration.
        self.admin.execute((ROOT/'migrations/010_deposit_recovery.sql').read_text())
        self.admin.execute((ROOT/'migrations/014_deposit_draft_recovery.sql').read_text())
        return record

    def test_never_issued_expiry_is_bounded_and_does_not_delete_issued_evidence(self):
        issued = self.old_row(issued=True)
        recent = self.old_row(days=1)
        draft = self.old_row(days=8)
        self.create(OTHER)  # Expired never-issued work is reclaimed across owners.
        self.error('deposit_not_found', lambda: self.store.get(OWNER, draft['id']))
        self.create()
        self.error('deposit_not_found', lambda: self.store.get(OWNER, draft['id']))
        self.assertEqual(self.store.get(OWNER, issued['id'])['id'], issued['id'])
        self.assertEqual(self.store.get(OWNER, recent['id'])['id'], recent['id'])

    def test_operator_archive_keeps_exact_evidence_before_reclaim_and_retention(self):
        old = self.old_row(issued=True)
        recent = self.old_row(issued=True, days=1)
        pending = self.old_row(issued=True, state='attention', outstanding=True)
        retained = self.counts()['retained']
        original = self.store.get(OWNER, old['id'])
        with tempfile.TemporaryDirectory() as directory:
            result = archive_terminal(self.settings, directory, operator_role=ADMIN)
            self.assertEqual(result['archived'], 1)
            content = Path(result['path']).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), result['sha256'])
            evidence = json.loads(content)['records'][0]
            self.assertEqual(evidence['id'], old['id'])
            self.assertEqual(evidence['history'], original['history'])
            self.assertEqual(archive_terminal(self.settings, directory, operator_role=ADMIN)['archived'], 0)
        self.error('deposit_not_found', lambda: self.store.get(OWNER, old['id']))
        self.assertTrue(self.store.get(OWNER, pending['id'])['outstanding'])
        self.assertEqual(self.counts()['retained'], retained-1)

    def test_archive_write_failure_preserves_all_database_evidence(self):
        old = self.old_row(issued=True)
        before = self.store.get(OWNER, old['id'])
        with tempfile.TemporaryDirectory() as directory, patch('deposit_archive.os.fsync', side_effect=OSError('synthetic')):
            with self.assertRaises(OSError): archive_terminal(self.settings, directory, operator_role=ADMIN)
        self.assertEqual(self.store.get(OWNER, old['id']), before)

    def test_archive_requires_preprovisioned_directory_before_database_access(self):
        old = self.old_row(issued=True)
        before = self.store.get(OWNER, old['id'])
        counts = self.counts()
        def unexpected_connect(**kwargs):
            self.fail('unprovisioned archive directory must not access the database')
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / 'unprovisioned' / 'archive'
            with self.assertRaisesRegex(ValueError, 'private_archive_directory_required'):
                archive_terminal(self.settings, missing, operator_role=ADMIN, connect=unexpected_connect)
            self.assertFalse(missing.parent.exists())
        self.assertEqual(self.store.get(OWNER, old['id']), before)
        self.assertEqual(self.counts(), counts)

    def test_existing_archive_is_fsynced_before_deletion_and_retry_recovers(self):
        old = self.old_row(issued=True)
        before = self.store.get(OWNER, old['id'])
        with tempfile.TemporaryDirectory() as directory:
            # First attempt leaves identical bytes but fails before durable-write
            # acknowledgement. The retry takes the FileExistsError branch.
            with patch('deposit_archive.os.fsync', side_effect=OSError('first sync')):
                with self.assertRaises(OSError): archive_terminal(self.settings,directory,operator_role=ADMIN)
            self.assertEqual(len(list(Path(directory).glob('*.json'))),1)
            with patch('deposit_archive.os.fsync', side_effect=OSError('existing file sync')) as sync:
                with self.assertRaises(OSError): archive_terminal(self.settings,directory,operator_role=ADMIN)
                self.assertEqual(sync.call_count,1)
            self.assertEqual(self.store.get(OWNER,old['id']),before)
            self.assertEqual(archive_terminal(self.settings,directory,operator_role=ADMIN)['archived'],1)

    def test_archive_readback_and_directory_sync_failures_do_not_delete(self):
        old=self.old_row(issued=True)
        before=self.store.get(OWNER,old['id'])
        real_sync=os.fsync
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            def sync(fd):
                calls.append(fd)
                if len(calls)==3: raise OSError('directory sync')
                return real_sync(fd)
            with patch('deposit_archive.os.fsync',side_effect=sync):
                with self.assertRaises(OSError): archive_terminal(self.settings,directory,operator_role=ADMIN)
            self.assertEqual(self.store.get(OWNER,old['id']),before)
            path=next(Path(directory).glob('*.json'))
            path.write_bytes(b'corrupted evidence')
            with self.assertRaisesRegex(ValueError,'deposit_archive_verification_failed'):
                archive_terminal(self.settings,directory,operator_role=ADMIN)
            self.assertEqual(self.store.get(OWNER,old['id']),before)

    def test_terminal_archive_recovers_retained_capacity_without_touching_active_work(self):
        old=self.old_row(issued=True)
        for _ in range(127):
            row=self.create();self.store.cancel(OWNER,row['id'],row['version'])
        self.error('deposit_owner_history_full',self.create)
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(archive_terminal(self.settings,directory,operator_role=ADMIN)['archived'],1)
        row=self.create()
        self.assertNotEqual(row['id'],old['id'])
        self.assertEqual(self.counts(),{'used':1,'retained':128})
