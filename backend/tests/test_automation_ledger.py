"""The ledger's reader of vault fee events, offline: window arithmetic, log and
receipt checks, the classification of execution events, and what it records.
An in-memory reader and store stand in for the node and the database."""
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode

import automation_ledger as ledger
import execution_v4 as v4
from automation_config import validate_config
from automation_fixtures import address, identity, sample_config
from automation_observer import ObservationError

OWNER, VAULT, ENGINE = address(1), address(3), address(24)
SEQUENCE = identity(11)


def admission():
    return types.SimpleNamespace(sequence=types.SimpleNamespace(vault=VAULT, digest=lambda: SEQUENCE), executionEngine=ENGINE)


def topic_of(address_):
    return '0x' + '00' * 12 + address_[2:]


def withdrawal_log(number, log_index, tx, *, source=identity(41), currency=address(16), owner=OWNER, original=1200, charged=0, nonce=7):
    return {'removed': False, 'address': VAULT, 'topics': [ledger.WITHDRAWN, source, topic_of(currency), topic_of(owner)],
            'data': '0x' + encode(['uint128', 'uint128', 'uint64'], [original, charged, nonce]).hex(),
            'blockNumber': hex(number), 'blockHash': identity(number), 'transactionHash': tx, 'logIndex': hex(log_index), 'transactionIndex': '0x0'}


def execution_log(number, log_index, tx, *, topic=v4.REALIZED, intent=identity(77), subject=identity(5)):
    return {'removed': False, 'address': ENGINE, 'topics': [topic, topic_of(VAULT), intent, subject], 'data': '0x' + '00' * 64,
            'blockNumber': hex(number), 'blockHash': identity(number), 'transactionHash': tx, 'logIndex': hex(log_index), 'transactionIndex': '0x0'}


def other_log(number, log_index, tx):
    return {'removed': False, 'address': address(99), 'topics': [identity(1)], 'data': '0x', 'blockNumber': hex(number),
            'blockHash': identity(number), 'transactionHash': tx, 'logIndex': hex(log_index), 'transactionIndex': '0x0'}


class FakeReader:
    def __init__(self, *, finalized, logs=(), receipts=None, hashes=None):
        self.final, self.entries, self.receipts, self.hashes = finalized, list(logs), dict(receipts or {}), dict(hashes or {})
        self.queries = []

    def finalized(self):
        return {'number': self.final, 'hash': identity(self.final), 'timestamp': 1000 + self.final}

    def block(self, number):
        return {'number': number, 'hash': self.hashes.get(number, identity(number)), 'timestamp': 1000 + number}

    def logs(self, query, *, max_logs):
        self.queries.append(query)
        low, high = int(query['fromBlock'], 16), int(query['toBlock'], 16)
        topics = query['topics'][0] if isinstance(query['topics'][0], list) else [query['topics'][0]]
        chosen = [log for log in self.entries if log['address'] == query['address'] and log['topics'][0] in topics
                  and low <= int(log['blockNumber'], 16) <= high]
        if len(chosen) > max_logs:
            raise ObservationError('automation_log_budget')
        return chosen

    def receipt(self, tx):
        if tx not in self.receipts:
            # The receipt of every log the reader handed out, unless a test overrides it.
            logs = sorted((log for log in self.entries if log['transactionHash'] == tx), key=lambda log: int(log['logIndex'], 16))
            return {'status': '0x1', 'transactionHash': tx, 'blockHash': logs[0]['blockHash'], 'blockNumber': logs[0]['blockNumber'], 'logs': logs}
        return self.receipts[tx]


class FakeStore:
    def __init__(self, executions=None):
        self.cursors, self.withdrawals, self.exceptions, self.executions = {}, [], [], dict(executions or {})

    def cursor(self, owner, seq):
        return self.cursors.get((owner, seq))

    def set_cursor(self, owner, seq, vault, number, block_hash):
        current = self.cursors.get((owner, seq))
        if current and number < current['blockNumber']:
            raise AssertionError('cursor regressed')
        self.cursors[(owner, seq)] = {'blockNumber': number, 'blockHash': block_hash, 'vault': vault}
        return dict(self.cursors[(owner, seq)])

    def execution_of(self, owner, tx):
        return self.executions.get(tx)

    def record_withdrawal(self, owner, seq, event):
        self.withdrawals.append((owner, seq, event))
        return {'withdrawalId': ledger.withdrawal_id(seq, event['transaction_hash'], event['event_index']), 'state': 'recorded'}

    def record_exception(self, owner, seq, exception):
        self.exceptions.append((owner, seq, exception))
        return {'exceptionId': ledger.exception_id(seq, exception['transaction_hash']), 'state': 'recorded'}


def indexer(reader, store, *, max_blocks=100, max_logs=64):
    return ledger.LedgerIndexer(reader, store, max_blocks=max_blocks, max_logs=max_logs)


class LedgerIndexerTests(unittest.TestCase):
    def test_first_pass_starts_the_cursor_at_the_finalized_head_and_reads_nothing(self):
        reader, store = FakeReader(finalized=50, logs=[withdrawal_log(40, 0, identity(900))]), FakeStore()
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['started'], summary['cursor'], summary['from']), (50, 50, None))
        self.assertEqual((reader.queries, store.withdrawals), ([], []))
        # Nothing new: no query, no cursor change.
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['from'], summary['caughtUp'], reader.queries), (None, True, []))

    def test_withdrawal_in_a_finalized_block_is_recorded_at_its_receipt_position(self):
        tx = identity(900)
        # An unrelated log sits first in the receipt, so the E5 event index is 1 while the block-scoped log index is 5.
        reader = FakeReader(finalized=60, logs=[other_log(55, 4, tx), withdrawal_log(55, 5, tx, original=1200, charged=30, nonce=9),
                                                withdrawal_log(61, 0, identity(901))])
        store = FakeStore()
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['from'], summary['to'], summary['caughtUp'], summary['cursor']), (51, 60, True, 60))
        self.assertEqual(len(store.withdrawals), 1)
        owner, seq, event = store.withdrawals[0]
        self.assertEqual((owner, seq), (OWNER, SEQUENCE))
        self.assertEqual({k: event[k] for k in ('source_id', 'currency', 'transaction_hash', 'event_index', 'block_number', 'block_hash', 'state_nonce', 'original_raw', 'charged_raw')},
                         {'source_id': identity(41), 'currency': address(16), 'transaction_hash': tx, 'event_index': 1, 'block_number': 55,
                          'block_hash': identity(55), 'state_nonce': 9, 'original_raw': 1200, 'charged_raw': 30})
        self.assertEqual(event['evidence']['log']['logIndex'], 5)
        self.assertEqual(event['evidence']['finalized'], {'number': 60, 'hash': identity(60)})
        self.assertEqual(summary['withdrawals'][0]['withdrawalId'], ledger.withdrawal_id(SEQUENCE, tx, 1))
        # The block past finality is not read; it is read once finality reaches it.
        reader.final = 61
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['from'], summary['to'], len(store.withdrawals)), (61, 61, 2))
        self.assertEqual(reader.queries[-1]['topics'], [[v4.REALIZED, v4.APPLIED, v4.CONVERTED], topic_of(VAULT)])

    def test_the_window_is_bounded_and_catch_up_repeats_it(self):
        reader = FakeReader(finalized=100, logs=[withdrawal_log(n, 0, identity(1000 + n)) for n in (52, 75, 99)])
        store = FakeStore()
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        first = indexer(reader, store, max_blocks=20).index(OWNER, admission())
        self.assertEqual((first['from'], first['to'], first['caughtUp'], len(store.withdrawals)), (51, 70, False, 1))
        passes = ledger.catch_up(indexer(reader, store, max_blocks=20), OWNER, admission())
        self.assertEqual([(p['from'], p['to']) for p in passes], [(71, 90), (91, 100)])
        self.assertEqual((len(store.withdrawals), store.cursor(OWNER, SEQUENCE)['blockNumber']), (3, 100))
        # An operator's rescan from an earlier block re-finds the same events and never moves the cursor back.
        again = ledger.catch_up(indexer(reader, store, max_blocks=100), OWNER, admission(), from_block=60)
        self.assertEqual([(p['from'], p['to']) for p in again], [(60, 100)])
        self.assertEqual((len(store.withdrawals), store.cursor(OWNER, SEQUENCE)['blockNumber']), (5, 100))

    def test_own_reconciled_execution_is_verified_and_a_pending_one_holds_the_cursor(self):
        ours, pending = identity(910), identity(911)
        reader = FakeReader(finalized=80, logs=[execution_log(55, 0, ours), execution_log(55, 1, ours, topic=v4.APPLIED),
                                                execution_log(70, 0, pending, intent=identity(78)), withdrawal_log(72, 0, identity(912))])
        store = FakeStore(executions={ours: {'intentId': identity(77), 'journalState': 'reconciled', 'canonical': True},
                                      pending: {'intentId': identity(78), 'journalState': 'submitted', 'canonical': None}})
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['verified'], summary['held'], summary['to'], summary['caughtUp']), ([ours], pending, 69, False))
        self.assertEqual((store.exceptions, store.withdrawals, store.cursor(OWNER, SEQUENCE)['blockNumber']), ([], [], 69))
        # Reconciled since: the next pass verifies it and reads on to the withdrawal.
        store.executions[pending] = {'intentId': identity(78), 'journalState': 'reconciled', 'canonical': True}
        summary = indexer(reader, store).index(OWNER, admission())
        self.assertEqual((summary['verified'], summary['held'], len(store.withdrawals), summary['cursor']), ([pending], None, 1, 80))

    def test_executions_the_journal_did_not_reconcile_become_exceptions(self):
        foreign, attention, wrong = identity(920), identity(921), identity(922)
        reader = FakeReader(finalized=80, logs=[execution_log(55, 0, foreign, intent=identity(70)), execution_log(60, 0, attention, intent=identity(71)),
                                                execution_log(65, 0, wrong, intent=identity(72))])
        store = FakeStore(executions={attention: {'intentId': identity(71), 'journalState': 'attention', 'canonical': None},
                                      wrong: {'intentId': identity(73), 'journalState': 'reconciled', 'canonical': True}})
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        summary = indexer(reader, store).index(OWNER, admission())
        kinds = [(e['kind'], e['intent_id'], e['transaction_hash']) for _, _, e in store.exceptions]
        self.assertEqual(kinds, [('foreign_execution', identity(70), foreign), ('unreconciled_execution', identity(71), attention),
                                 ('unreconciled_execution', identity(72), wrong)])
        self.assertEqual(store.exceptions[0][2]['evidence'], {'events': [{'eventIndex': 0, 'name': 'FeesRealized', 'subject': identity(5)}],
                                                              'journalState': None, 'signedIntentId': None})
        self.assertEqual(store.exceptions[1][2]['evidence']['journalState'], 'attention')
        self.assertEqual((summary['exceptions'], summary['cursor']), ([ledger.exception_id(SEQUENCE, tx) for tx in (foreign, attention, wrong)], 80))

    def test_off_canonical_logs_and_disagreeing_receipts_are_refused(self):
        tx = identity(930)
        store = FakeStore()
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        reader = FakeReader(finalized=60, logs=[withdrawal_log(55, 0, tx)], hashes={55: identity(5555)})
        with self.assertRaisesRegex(ObservationError, 'automation_log_not_canonical'):
            indexer(reader, store).index(OWNER, admission())
        reverted = FakeReader(finalized=60, logs=[withdrawal_log(55, 0, tx)],
                              receipts={tx: {'status': '0x0', 'transactionHash': tx, 'blockHash': identity(55), 'blockNumber': hex(55), 'logs': []}})
        with self.assertRaisesRegex(ObservationError, 'automation_receipt_mismatch'):
            indexer(reverted, store).index(OWNER, admission())
        missing = FakeReader(finalized=60, logs=[withdrawal_log(55, 0, tx)],
                             receipts={tx: {'status': '0x1', 'transactionHash': tx, 'blockHash': identity(55), 'blockNumber': hex(55), 'logs': [other_log(55, 0, tx)]}})
        with self.assertRaisesRegex(ObservationError, 'automation_receipt_log_mismatch'):
            indexer(missing, store).index(OWNER, admission())
        stranger = FakeReader(finalized=60, logs=[withdrawal_log(55, 0, tx, owner=address(2))])
        with self.assertRaisesRegex(ObservationError, 'automation_withdrawal_owner_mismatch'):
            indexer(stranger, store).index(OWNER, admission())
        crowded = FakeReader(finalized=60, logs=[withdrawal_log(55, i, identity(940 + i)) for i in range(3)])
        with self.assertRaisesRegex(ObservationError, 'automation_log_budget'):
            indexer(crowded, store, max_logs=2).index(OWNER, admission())
        self.assertEqual((store.withdrawals, store.cursor(OWNER, SEQUENCE)['blockNumber']), ([], 50))

    def test_finality_that_moves_back_refuses_the_pass(self):
        class Regressing(FakeReader):
            def finalized(self):
                self.final -= 5
                return super().finalized()
        store = FakeStore()
        store.set_cursor(OWNER, SEQUENCE, VAULT, 50, identity(50))
        with self.assertRaisesRegex(ObservationError, 'automation_finality_changed'):
            indexer(Regressing(finalized=70, logs=[withdrawal_log(55, 0, identity(950))]), store).index(OWNER, admission())
        self.assertEqual(store.cursor(OWNER, SEQUENCE)['blockNumber'], 50)

    def test_identities_and_decoding(self):
        self.assertNotEqual(ledger.withdrawal_id(SEQUENCE, identity(1), 0), ledger.withdrawal_id(SEQUENCE, identity(1), 1))
        self.assertNotEqual(ledger.withdrawal_id(SEQUENCE, identity(1), 0), ledger.exception_id(SEQUENCE, identity(1)))
        self.assertEqual(ledger.exception_id(SEQUENCE, identity(1)), ledger.exception_id(SEQUENCE, identity(1)))
        log = ledger.validate_log(withdrawal_log(5, 0, identity(1), original=3, charged=4, nonce=5))
        self.assertEqual(ledger.decode_withdrawal(log), {'source_id': identity(41), 'currency': address(16), 'owner': OWNER,
                                                         'original_raw': 3, 'charged_raw': 4, 'state_nonce': 5})
        with self.assertRaisesRegex(ObservationError, 'automation_invalid_log'):
            ledger.decode_withdrawal({**log, 'topics': log['topics'][:3]})
        with self.assertRaisesRegex(ObservationError, 'automation_invalid_log'):
            ledger.topic_address('0x' + 'ff' * 32)
        with self.assertRaisesRegex(ObservationError, 'automation_invalid_log'):
            ledger.validate_log({**withdrawal_log(5, 0, identity(1)), 'removed': True})
        with self.assertRaises(ValueError):
            ledger.LedgerIndexer(FakeReader(finalized=1), FakeStore(), max_blocks=0, max_logs=1)

    def test_the_configuration_names_the_reader_explicitly(self):
        raw = sample_config()
        self.assertEqual(validate_config(raw).ledger.indexer, 'inline')
        del raw['ledger']
        with self.assertRaises(ValueError):
            validate_config(raw)
        with self.assertRaises(ValueError):
            validate_config(sample_config(ledger={'indexer': 'automatic', 'maxBlocksPerPass': 10, 'maxLogsPerPass': 10}))


if __name__ == '__main__':
    unittest.main()
