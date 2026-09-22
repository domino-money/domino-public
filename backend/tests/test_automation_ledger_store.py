"""Actual role, immutability and attribution semantics of the ledger's reader
tables: withdrawals debited from the oldest lot first, the planner's view
following, exceptions acknowledged once, cursors that only move forward, and
the claim and spend guards counting the debits."""
import json
import os
from pathlib import Path
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import psycopg
from psycopg.types.json import Jsonb

import execution_models as m
from automation_fixtures import address, identity
from automation_ledger import LedgerIndexStore, exception_id, withdrawal_id
from automation_store import CycleStore
from execution_pg import ExecutionPostgres
from execution_store import ExecutionLedgerStore, ExecutionStoreError, LEDGER_ROLE, UnsignedExecutionStore, WORKER_ROLE
from test_execution_store import fresh_case

SIGNER_ROLE = 'domino_execution_signer'


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'set DOMINO_TEST_POSTGRES=1 for actual private PostgreSQL roles')
class LedgerIndexStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            for name in ('019_execution_journal', '028_automation_cycle', '029_ledger_index', '030_swap_exposure'):
                conn.execute((Path(__file__).resolve().parents[1] / f'migrations/{name}.sql').read_text())
            for role in ('domino_execution_signer', 'domino_execution_publisher'):
                conn.execute(f'ALTER ROLE {role} LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.origins,domino_execution.withdrawals,domino_execution.withdrawal_debits,'
                         'domino_execution.ledger_exceptions,domino_execution.ledger_cursors,domino_execution.cycles,domino_execution.sequence_state CASCADE')
        settings = self.pg.settings
        self.index, self.ledger, self.store, self.worker_store = LedgerIndexStore(settings), ExecutionLedgerStore(settings), UnsignedExecutionStore(settings), CycleStore(settings)
        self.obs, self.plan, self.base, self.source = fresh_case()
        self.seq = self.obs.sequence
        self.owner, self.seq_hash = self.seq.owner, self.seq.digest()
        self.worker = str(uuid.uuid4())

    # ------------------------------------------------------------ helpers
    def credit(self, tx_number, amount):
        raw = self.base.model_dump(mode='json')
        raw.update(transactionHash=identity(tx_number), eventIndex=0, amountRaw=str(amount))
        credit = m.FeeCredit.model_validate_json(json.dumps(raw))
        self.ledger.record_credit(self.owner, self.seq, self.source, credit.credit_id(), credit)
        return credit.credit_id()

    def event(self, tx_number, *, original=0, charged=0, index=0, block=100, nonce=5):
        return {'source_id': self.source.digest(), 'currency': self.source.currency, 'transaction_hash': identity(tx_number), 'event_index': index,
                'block_number': block, 'block_hash': identity(block), 'state_nonce': nonce, 'original_raw': original, 'charged_raw': charged,
                'evidence': {'test': True}}

    def remaining(self):
        return {row['lot_id']: int(row['remaining']) for row in self.worker_store.available_lots(self.owner, self.seq_hash)}

    def error(self, code, call):
        with self.assertRaises(ExecutionStoreError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def sql(self, role, statements, *, owner=None, worker=None, fence=None):
        """Direct statements as one role inside one transaction, the way a
        service would, returning the last statement's rows."""
        conn = psycopg.connect(**self.pg.settings, user=role, options='-c search_path=domino_execution')
        try:
            with conn:
                conn.execute("SELECT set_config('domino.execution_owner',%s,true)", (owner or self.owner,))
                if worker is not None:
                    conn.execute("SELECT set_config('domino.execution_worker',%s,true),set_config('domino.execution_fence',%s,true)", (worker, str(fence)))
                result = None
                for statement, args in statements:
                    result = conn.execute(statement, args)
                return result.fetchall() if result is not None and result.description else None
        finally:
            conn.close()

    def admin_refusal(self, statement, args):
        """The guard's own refusal, from a connection that no privilege stops."""
        conn = self.pg.admin(options='-c search_path=domino_execution')
        try:
            with self.assertRaises(psycopg.errors.CheckViolation) as refused:
                with conn:
                    conn.execute(statement, args)
        finally:
            conn.close()
        return refused.exception.diag.message_primary

    # -------------------------------------------------------------- tests
    def test_withdrawal_debits_the_oldest_lot_first_and_the_planner_view_follows(self):
        first, second = self.credit(901, 1000), self.credit(902, 500)
        self.assertEqual(self.remaining(), {first: 1000, second: 500})
        recorded = self.index.record_withdrawal(self.owner, self.seq_hash, self.event(950, original=1200))
        self.assertEqual(recorded['state'], 'recorded')
        self.assertEqual({d['lotId']: d['amountRaw'] for d in recorded['debits']}, {first: '1000', second: '200'})
        self.assertEqual((recorded['unattributedOriginalRaw'], recorded['unattributedChargedRaw'], recorded['withdrawalId']),
                         ('0', '0', withdrawal_id(self.seq_hash, identity(950), 0)))
        self.assertEqual(self.remaining(), {first: 0, second: 300})
        # The same event again is the same row; a changed amount is a conflict, not a second debit.
        again = self.index.record_withdrawal(self.owner, self.seq_hash, self.event(950, original=1200))
        self.assertEqual((again['state'], again['debits'], again['withdrawalId']), ('existing', recorded['debits'], recorded['withdrawalId']))
        self.error('execution_identity_conflict', lambda: self.index.record_withdrawal(self.owner, self.seq_hash, self.event(950, original=1100)))
        self.error('execution_invalid_record', lambda: self.index.record_withdrawal(self.owner, self.seq_hash, self.event(951)))
        # More than the lots hold stays unattributed; a charged amount finds no converted lot here.
        more = self.index.record_withdrawal(self.owner, self.seq_hash, self.event(951, original=500, charged=40, index=2))
        self.assertEqual(({d['lotId']: d['amountRaw'] for d in more['debits']}, more['unattributedOriginalRaw'], more['unattributedChargedRaw']),
                         ({second: '300'}, '200', '40'))
        self.assertEqual(self.remaining(), {first: 0, second: 0})
        listed = self.index.withdrawals(self.owner, self.seq_hash)
        self.assertEqual([w['withdrawalId'] for w in listed], [more['withdrawalId'], recorded['withdrawalId']])
        summary = self.worker_store.ledger_summary(self.owner, self.seq_hash)
        self.assertEqual((summary['cursor'], [w['withdrawalId'] for w in summary['withdrawals']], summary['exceptions']),
                         (None, [more['withdrawalId'], recorded['withdrawalId']], []))
        # Another tenant sees none of it and its own withdrawal finds no lots.
        self.assertEqual(self.index.withdrawals(address(2), self.seq_hash), [])
        stranger = self.index.record_withdrawal(address(2), self.seq_hash, self.event(952, original=7))
        self.assertEqual((stranger['debits'], stranger['unattributedOriginalRaw']), ([], '7'))
        self.assertEqual(self.remaining(), {first: 0, second: 0})

    def test_claim_and_spend_guards_count_the_debits(self):
        lot = self.base.credit_id()
        self.ledger.record_credit(self.owner, self.seq, self.source, lot, self.base)
        item = self.store.persist(self.owner, self.plan, self.obs, actor=self.obs.operator)
        # The plan allocates 1000 of the lot; a withdrawal leaving 999 is one unit too many.
        self.index.record_withdrawal(self.owner, self.seq_hash, self.event(960, original=int(self.base.amountRaw) - 999))
        self.assertEqual(self.remaining(), {lot: 999})
        lease = self.store.acquire(self.owner, item['intentId'], self.worker)
        self.error('execution_balance_reserved', lambda: self.store.reserve(self.owner, item['intentId'], self.worker, lease['fence']))
        # The signer's spend against a canonical effect meets the same arithmetic.
        effect = [("INSERT INTO effects(owner,intent_id,transaction_hash,block_number,block_hash,canonical,receipt) VALUES(%s,%s,%s,7,%s,true,%s)",
                   (self.owner, item['intentId'], identity(961), identity(7), Jsonb({})))]
        with self.assertRaises(psycopg.errors.CheckViolation) as refused:
            self.sql(SIGNER_ROLE, effect + [("INSERT INTO spends(owner,intent_id,lot_id,amount_raw) VALUES(%s,%s,%s,1000)", (self.owner, item['intentId'], lot))],
                     worker=self.worker, fence=lease['fence'])
        self.assertEqual(refused.exception.diag.message_primary, 'execution_balance_reserved')
        self.sql(SIGNER_ROLE, effect + [("INSERT INTO spends(owner,intent_id,lot_id,amount_raw) VALUES(%s,%s,%s,999)", (self.owner, item['intentId'], lot))],
                 worker=self.worker, fence=lease['fence'])
        self.assertEqual(self.remaining(), {lot: 0})

    def test_withdrawals_and_debits_are_immutable_and_complete(self):
        lot = self.credit(970, 1000)
        recorded = self.index.record_withdrawal(self.owner, self.seq_hash, self.event(971, original=400))
        # The reconciliation role holds no UPDATE or DELETE on either table, and
        # the guards refuse the same statements from a role that does.
        for statement in ('UPDATE withdrawals SET original_raw=1 WHERE withdrawal_id=%s', 'DELETE FROM withdrawals WHERE withdrawal_id=%s',
                          'UPDATE withdrawal_debits SET amount_raw=1 WHERE withdrawal_id=%s', 'DELETE FROM withdrawal_debits WHERE withdrawal_id=%s'):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.sql(LEDGER_ROLE, [(statement, (recorded['withdrawalId'],))])
            self.assertEqual(self.admin_refusal(statement, (recorded['withdrawalId'],)), 'execution_withdrawal_immutable')
        # A debit past what the lot holds, and a withdrawal whose debits do not account for it, are refused.
        with self.assertRaises(psycopg.errors.CheckViolation) as refused:
            self.sql(LEDGER_ROLE, [("INSERT INTO withdrawal_debits(owner,withdrawal_id,lot_id,amount_raw) VALUES(%s,%s,%s,601)", (self.owner, recorded['withdrawalId'], lot))])
        self.assertEqual(refused.exception.diag.message_primary, 'execution_balance_reserved')
        with self.assertRaises(psycopg.errors.CheckViolation) as refused:
            self.sql(LEDGER_ROLE, [("INSERT INTO withdrawals(withdrawal_id,owner,sequence_hash,source_id,currency,transaction_hash,event_index,block_number,block_hash,"
                                    "state_nonce,original_raw,charged_raw,unattributed_original_raw,unattributed_charged_raw,evidence) "
                                    "VALUES(%s,%s,%s,%s,%s,%s,0,100,%s,5,300,0,0,0,'{}'::jsonb)",
                                    (identity(972), self.owner, self.seq_hash, self.source.digest(), self.source.currency, identity(972), identity(100)))])
        self.assertEqual(refused.exception.diag.message_primary, 'execution_withdrawal_incomplete')
        self.assertEqual(len(self.index.withdrawals(self.owner, self.seq_hash)), 1)
        # The worker reads and never writes.
        self.assertEqual(self.worker_store.ledger_summary(self.owner, self.seq_hash)['withdrawals'][0]['withdrawalId'], recorded['withdrawalId'])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.sql(WORKER_ROLE, [("INSERT INTO withdrawal_debits(owner,withdrawal_id,lot_id,amount_raw) VALUES(%s,%s,%s,1)", (self.owner, recorded['withdrawalId'], lot))])
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.sql(WORKER_ROLE, [("INSERT INTO ledger_cursors(owner,sequence_hash,vault,block_number,block_hash) VALUES(%s,%s,%s,1,%s)",
                                    (self.owner, self.seq_hash, address(3), identity(1)))])

    def test_exceptions_are_recorded_once_and_acknowledged_once(self):
        exception = {'kind': 'foreign_execution', 'transaction_hash': identity(980), 'block_number': 120, 'block_hash': identity(120),
                     'intent_id': identity(77), 'evidence': {'events': []}}
        recorded = self.index.record_exception(self.owner, self.seq_hash, exception)
        self.assertEqual((recorded['state'], recorded['acknowledged'], recorded['exceptionId']), ('recorded', False, exception_id(self.seq_hash, identity(980))))
        self.assertEqual(self.index.record_exception(self.owner, self.seq_hash, exception)['state'], 'existing')
        self.error('execution_identity_conflict', lambda: self.index.record_exception(self.owner, self.seq_hash, {**exception, 'kind': 'unreconciled_execution'}))
        self.error('execution_invalid_record', lambda: self.index.record_exception(self.owner, self.seq_hash, {**exception, 'kind': 'other'}))
        self.assertEqual([e['exceptionId'] for e in self.worker_store.unacknowledged_exceptions(self.owner, self.seq_hash)], [recorded['exceptionId']])
        self.assertEqual(self.worker_store.unacknowledged_exceptions(address(2), self.seq_hash), [])
        self.error('execution_invalid_record', lambda: self.index.acknowledge(self.owner, recorded['exceptionId'], 'Not A Reason'))
        self.error('execution_not_found', lambda: self.index.acknowledge(address(2), recorded['exceptionId'], 'operator'))
        acknowledged = self.index.acknowledge(self.owner, recorded['exceptionId'], 'recorded_by_hand')
        self.assertEqual((acknowledged['acknowledged'], acknowledged['acknowledgement']), (True, 'recorded_by_hand'))
        # Once: a second acknowledgement changes nothing, and nothing else changes at all.
        self.assertEqual(self.index.acknowledge(self.owner, recorded['exceptionId'], 'again')['acknowledgement'], 'recorded_by_hand')
        self.assertEqual(self.worker_store.unacknowledged_exceptions(self.owner, self.seq_hash), [])
        self.assertEqual([e['acknowledged'] for e in self.index.exceptions(self.owner, self.seq_hash)], [True])
        self.assertEqual(self.index.exceptions(self.owner, self.seq_hash, acknowledged=False), [])
        with self.assertRaises(psycopg.errors.CheckViolation) as refused:
            self.sql(LEDGER_ROLE, [("UPDATE ledger_exceptions SET acknowledged=false,acknowledgement='' WHERE exception_id=%s", (recorded['exceptionId'],))])
        self.assertEqual(refused.exception.diag.message_primary, 'execution_exception_immutable')
        for statement, args in (('UPDATE ledger_exceptions SET kind=%s WHERE exception_id=%s', ('unreconciled_execution', recorded['exceptionId'])),
                                ('DELETE FROM ledger_exceptions WHERE exception_id=%s', (recorded['exceptionId'],))):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.sql(LEDGER_ROLE, [(statement, args)])
            self.assertEqual(self.admin_refusal(statement, args), 'execution_exception_immutable')

    def test_cursor_moves_forward_only_and_is_tenant_scoped(self):
        self.assertIsNone(self.index.cursor(self.owner, self.seq_hash))
        self.assertEqual(self.index.set_cursor(self.owner, self.seq_hash, address(3), 10, identity(10))['blockNumber'], 10)
        self.assertEqual(self.index.set_cursor(self.owner, self.seq_hash, address(3), 12, identity(12))['blockNumber'], 12)
        self.error('execution_cursor_regressed', lambda: self.index.set_cursor(self.owner, self.seq_hash, address(3), 11, identity(11)))
        self.error('execution_cursor_regressed', lambda: self.index.set_cursor(self.owner, self.seq_hash, address(3), 12, identity(13)))
        self.assertEqual(self.index.cursor(self.owner, self.seq_hash)['blockNumber'], 12)
        self.assertIsNone(self.index.cursor(address(2), self.seq_hash))
        self.error('execution_invalid_record', lambda: self.index.set_cursor(self.owner, self.seq_hash, address(3), -1, identity(1)))
        self.assertEqual(self.worker_store.ledger_summary(self.owner, self.seq_hash)['cursor']['blockNumber'], 12)
        # The reconciliation role sees the identity and state of our own transactions, never their bytes.
        self.assertIsNone(self.index.execution_of(self.owner, identity(1)))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.sql(LEDGER_ROLE, [('SELECT signed_bytes FROM attempts', ())])


if __name__ == '__main__':
    unittest.main()
