"""Ledger completeness: the vault's finalized fee events read into the E5 ledger.

The executor's reconciliation records what its own transactions credited and
spent. The vault's fee balances also move when the owner withdraws reserves,
and they can move through an execution that is not ours. This module reads the
vault's and the engine's fee events from finalized blocks, one sequence at a
time, from a durable cursor: an owner withdrawal becomes a debit attributed to
the ledger's lots (the oldest available lot first, quarantined lots after, the
remainder recorded as unattributed); a fee event of one of our reconciled
effects is verified and passed over; a fee event of an execution we did not
reconcile is recorded as an exception that suspends the sequence until an
operator acknowledges it. Nothing here creates a credit, signs, or reads a key.
"""
import re

from eth_abi import encode
from eth_hash.auto import keccak
from psycopg.types.json import Jsonb

import execution_v4 as v4
import general_compound_receipts as g
from automation_observer import ObservationError
from execution_store import ADDRESS, LEDGER_ROLE, ExecutionStoreError, _Store, _hash, _invalid, _owner

WITHDRAWN = '0x' + keccak(b'FeeReservesWithdrawn(bytes32,address,address,uint128,uint128,uint64)').hex()
EXECUTION_EVENTS = {v4.REALIZED: 'FeesRealized', v4.APPLIED: 'BudgetApplied', v4.CONVERTED: 'FeesConverted'}
# Our own transaction, signed but not yet reconciled: the reader stops before
# its block and lets the executor's journal settle it first.
HOLD_STATES = frozenset(('signing', 'signed', 'submitted', 'broadcast_unknown', 'included'))
WITHDRAWAL_ID_TYPE = 'DominoLedgerWithdrawalV1'
EXCEPTION_ID_TYPE = 'DominoLedgerExceptionV1'
MAX_RECEIPT_LOGS = 256
MAX_INDEX_PASSES = 256
WITHDRAWAL_IDENTITY = ('sequence_hash', 'source_id', 'currency', 'transaction_hash', 'event_index', 'block_number',
                       'block_hash', 'state_nonce', 'original_raw', 'charged_raw')
EXCEPTION_IDENTITY = ('sequence_hash', 'kind', 'transaction_hash', 'block_number', 'block_hash', 'intent_id')
REASON = re.compile(r'[a-z0-9_]{1,100}\Z')


# ------------------------------------------------------------------ identity
def withdrawal_id(sequence_hash, transaction_hash, event_index):
    return '0x' + keccak(encode(['bytes32', 'bytes32', 'bytes32', 'uint32'], [keccak(WITHDRAWAL_ID_TYPE.encode()),
        bytes.fromhex(sequence_hash[2:]), bytes.fromhex(transaction_hash[2:]), int(event_index)])).hex()


def exception_id(sequence_hash, transaction_hash):
    return '0x' + keccak(encode(['bytes32', 'bytes32', 'bytes32'], [keccak(EXCEPTION_ID_TYPE.encode()),
        bytes.fromhex(sequence_hash[2:]), bytes.fromhex(transaction_hash[2:])])).hex()


# ---------------------------------------------------------------- log reading
def validate_log(raw):
    """One log as the node reports it, every field checked, normalized to lowercase hex."""
    if type(raw) is not dict or raw.get('removed') is not False:
        raise ObservationError('automation_invalid_log')
    topics = raw.get('topics')
    if type(topics) is not list or not 1 <= len(topics) <= 4:
        raise ObservationError('automation_invalid_log')
    try:
        return {'address': g._address(raw.get('address')), 'topics': [g._hash(t) for t in topics], 'data': '0x' + g._hex(raw.get('data')).hex(),
                'blockNumber': g._quantity(raw.get('blockNumber')), 'blockHash': g._hash(raw.get('blockHash')),
                'transactionHash': g._hash(raw.get('transactionHash')), 'logIndex': g._quantity(raw.get('logIndex')),
                'transactionIndex': g._quantity(raw.get('transactionIndex'))}
    except ValueError:
        raise ObservationError('automation_invalid_log') from None


def receipt_position(receipt, log):
    """The event's index among ALL logs of its receipt, the E5 credit convention;
    the receipt must carry the identical log at the same block-scoped index."""
    logs = receipt.get('logs')
    if type(logs) is not list or len(logs) > MAX_RECEIPT_LOGS:
        raise ObservationError('automation_receipt_log_budget')
    for position, raw in enumerate(logs):
        entry = validate_log(raw)
        if entry['logIndex'] == log['logIndex']:
            if entry != log:
                raise ObservationError('automation_receipt_log_mismatch')
            return position
    raise ObservationError('automation_receipt_log_mismatch')


def topic_address(topic):
    if topic[2:26] != '0' * 24:
        raise ObservationError('automation_invalid_log')
    return '0x' + topic[26:]


def decode_withdrawal(log):
    """FeeReservesWithdrawn(bytes32 indexed sourceId, address indexed currency,
    address indexed owner, uint128 originalAmount, uint128 chargedAmount, uint64 stateNonce)."""
    if log['topics'][0] != WITHDRAWN or len(log['topics']) != 4:
        raise ObservationError('automation_invalid_log')
    try:
        original, charged, nonce = g._abi(['uint128', 'uint128', 'uint64'], log['data'])
    except ValueError:
        raise ObservationError('automation_invalid_log') from None
    return {'source_id': log['topics'][1], 'currency': topic_address(log['topics'][2]), 'owner': topic_address(log['topics'][3]),
            'original_raw': original, 'charged_raw': charged, 'state_nonce': nonce}


def check_receipt(receipt, transaction_hash, block):
    try:
        if (g._quantity(receipt.get('status')) != 1 or g._hash(receipt.get('transactionHash')) != transaction_hash
                or g._hash(receipt.get('blockHash')) != block['hash'] or g._quantity(receipt.get('blockNumber')) != block['number']):
            raise ValueError()
    except (ValueError, AttributeError):
        raise ObservationError('automation_receipt_mismatch') from None


# --------------------------------------------------------------------- store
def _currency(value):
    if type(value) is not str or not ADDRESS.fullmatch(value):
        _invalid()
    return value


def _number(value, maximum=2**64 - 1):
    if type(value) is not int or not 0 <= value <= maximum:
        _invalid()
    return value


def _kind(value):
    if value not in ('foreign_execution', 'unreconciled_execution'):
        _invalid()
    return value


class LedgerIndexStore(_Store):
    """The reconciliation role's view: cursors, withdrawals with their debits,
    exceptions, and the identity of our own transactions. Never a credit."""
    role = LEDGER_ROLE

    # ------------------------------------------------------------- cursors
    @staticmethod
    def _cursor_row(row):
        return {'sequenceHash': row['sequence_hash'], 'owner': row['owner'], 'vault': row['vault'],
                'blockNumber': int(row['block_number']), 'blockHash': row['block_hash'], 'updatedAt': row['updated_at'].isoformat()}

    def cursor(self, owner, sequence_hash):
        sequence_hash = _hash(sequence_hash)
        row = self._transaction(owner, lambda conn, owner: conn.execute(
            'SELECT * FROM ledger_cursors WHERE owner=%s AND sequence_hash=%s', (owner, sequence_hash)).fetchone())
        return None if row is None else self._cursor_row(row)

    def set_cursor(self, owner, sequence_hash, vault, block_number, block_hash):
        sequence_hash, block_hash, vault = _hash(sequence_hash), _hash(block_hash), _owner(vault)
        _number(block_number)
        def operation(conn, owner):
            row = conn.execute('INSERT INTO ledger_cursors(owner,sequence_hash,vault,block_number,block_hash) VALUES(%s,%s,%s,%s,%s) '
                               'ON CONFLICT(sequence_hash) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,'
                               'updated_at=clock_timestamp() WHERE ledger_cursors.owner=EXCLUDED.owner AND ledger_cursors.vault=EXCLUDED.vault RETURNING *',
                               (owner, sequence_hash, vault, block_number, block_hash)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_identity_conflict')
            return self._cursor_row(row)
        return self._transaction(owner, operation)

    # ------------------------------------------------------- own executions
    def execution_of(self, owner, transaction_hash):
        """What the journal knows about a transaction that emitted execution
        events: the intent it was signed for, its journal state and whether
        its effect is canonical. None for a transaction we never signed."""
        transaction_hash = _hash(transaction_hash)
        def operation(conn, owner):
            row = conn.execute('SELECT a.intent_id,j.state AS journal_state,e.canonical FROM attempts a '
                               'JOIN journal j ON j.owner=a.owner AND j.intent_id=a.intent_id '
                               'LEFT JOIN effects e ON e.owner=a.owner AND e.intent_id=a.intent_id AND e.transaction_hash=a.transaction_hash '
                               'WHERE a.owner=%s AND a.transaction_hash=%s', (owner, transaction_hash)).fetchone()
            return None if row is None else {'intentId': row['intent_id'], 'journalState': row['journal_state'], 'canonical': row['canonical']}
        return self._transaction(owner, operation)

    # ---------------------------------------------------------- withdrawals
    @staticmethod
    def _withdrawal_row(row, debits):
        return {'withdrawalId': row['withdrawal_id'], 'sequenceHash': row['sequence_hash'], 'sourceId': row['source_id'], 'currency': row['currency'],
                'transactionHash': row['transaction_hash'], 'eventIndex': int(row['event_index']), 'blockNumber': int(row['block_number']),
                'blockHash': row['block_hash'], 'stateNonce': str(row['state_nonce']), 'originalRaw': str(row['original_raw']),
                'chargedRaw': str(row['charged_raw']), 'unattributedOriginalRaw': str(row['unattributed_original_raw']),
                'unattributedChargedRaw': str(row['unattributed_charged_raw']),
                'debits': [{'lotId': d['lot_id'], 'amountRaw': str(d['amount_raw'])} for d in debits], 'createdAt': row['created_at'].isoformat()}

    @staticmethod
    def _withdrawal_values(sequence_hash, event):
        if type(event) is not dict or type(event.get('evidence')) is not dict:
            _invalid()
        values = {'sequence_hash': _hash(sequence_hash), 'source_id': _hash(event.get('source_id')), 'currency': _currency(event.get('currency')),
                  'transaction_hash': _hash(event.get('transaction_hash')), 'event_index': _number(event.get('event_index'), 2**32 - 1),
                  'block_number': _number(event.get('block_number')), 'block_hash': _hash(event.get('block_hash')),
                  'state_nonce': _number(event.get('state_nonce')), 'original_raw': _number(event.get('original_raw'), 2**128 - 1),
                  'charged_raw': _number(event.get('charged_raw'), 2**128 - 1)}
        if values['original_raw'] + values['charged_raw'] == 0:
            _invalid()
        values['withdrawal_id'] = withdrawal_id(values['sequence_hash'], values['transaction_hash'], values['event_index'])
        return values, event['evidence']

    def record_withdrawal(self, owner, sequence_hash, event):
        """Record one finalized withdrawal once, attributing it to the lots of
        its source and currency: original amount to original lots, charged
        amount to converted lots, the oldest available lot first and quarantined
        lots after, never more than a lot still holds. The remainder the
        ledger's lots cannot absorb is kept on the row as unattributed."""
        values, evidence = self._withdrawal_values(sequence_hash, event)
        def operation(conn, owner):
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (values['withdrawal_id'],))
            old = conn.execute('SELECT * FROM withdrawals WHERE owner=%s AND withdrawal_id=%s', (owner, values['withdrawal_id'])).fetchone()
            if old:
                if any(old[key] != values[key] for key in WITHDRAWAL_IDENTITY):
                    raise ExecutionStoreError('execution_identity_conflict')
                debits = conn.execute('SELECT lot_id,amount_raw FROM withdrawal_debits WHERE withdrawal_id=%s ORDER BY lot_id', (old['withdrawal_id'],)).fetchall()
                return {**self._withdrawal_row(old, debits), 'state': 'existing'}
            debits, unattributed = [], {}
            for kind, field in (('original', 'original_raw'), ('converted', 'charged_raw')):
                required = values[field]
                lots = conn.execute(
                    'SELECT o.lot_id,o.amount_raw-coalesce((SELECT sum(s.amount_raw) FROM spends s WHERE s.owner=o.owner AND s.lot_id=o.lot_id),0)'
                    '-coalesce((SELECT sum(d.amount_raw) FROM withdrawal_debits d WHERE d.owner=o.owner AND d.lot_id=o.lot_id),0) AS remaining '
                    'FROM origins o WHERE o.owner=%s AND o.sequence_hash=%s AND o.source_id=%s AND o.currency=%s AND o.kind=%s '
                    "ORDER BY (o.state='available') DESC,o.created_at,o.lot_id FOR UPDATE OF o",
                    (owner, values['sequence_hash'], values['source_id'], values['currency'], kind)).fetchall() if required else []
                for lot in lots:
                    if not required:
                        break
                    portion = min(required, max(0, int(lot['remaining'])))
                    if portion:
                        debits.append((lot['lot_id'], portion))
                        required -= portion
                unattributed[field] = required
            row = conn.execute('INSERT INTO withdrawals(withdrawal_id,owner,sequence_hash,source_id,currency,transaction_hash,event_index,block_number,'
                               'block_hash,state_nonce,original_raw,charged_raw,unattributed_original_raw,unattributed_charged_raw,evidence) '
                               'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                               (values['withdrawal_id'], owner, *(values[key] for key in WITHDRAWAL_IDENTITY),
                                unattributed['original_raw'], unattributed['charged_raw'], Jsonb(evidence))).fetchone()
            for lot_id, amount in debits:
                conn.execute('INSERT INTO withdrawal_debits(owner,withdrawal_id,lot_id,amount_raw) VALUES(%s,%s,%s,%s)', (owner, values['withdrawal_id'], lot_id, amount))
            rows = conn.execute('SELECT lot_id,amount_raw FROM withdrawal_debits WHERE withdrawal_id=%s ORDER BY lot_id', (values['withdrawal_id'],)).fetchall()
            return {**self._withdrawal_row(row, rows), 'state': 'recorded'}
        return self._transaction(owner, operation)

    def withdrawals(self, owner, sequence_hash, *, limit=20):
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            rows = conn.execute('SELECT * FROM withdrawals WHERE owner=%s AND sequence_hash=%s ORDER BY block_number DESC,event_index DESC LIMIT %s',
                                (owner, sequence_hash, int(limit))).fetchall()
            return [self._withdrawal_row(row, conn.execute('SELECT lot_id,amount_raw FROM withdrawal_debits WHERE withdrawal_id=%s ORDER BY lot_id',
                                                           (row['withdrawal_id'],)).fetchall()) for row in rows]
        return self._transaction(owner, operation)

    # ----------------------------------------------------------- exceptions
    @staticmethod
    def _exception_row(row):
        return {'exceptionId': row['exception_id'], 'sequenceHash': row['sequence_hash'], 'kind': row['kind'], 'transactionHash': row['transaction_hash'],
                'blockNumber': int(row['block_number']), 'blockHash': row['block_hash'], 'intentId': row['intent_id'], 'evidence': row['evidence'],
                'acknowledged': row['acknowledged'], 'acknowledgement': row['acknowledgement'], 'createdAt': row['created_at'].isoformat()}

    def record_exception(self, owner, sequence_hash, exception):
        if type(exception) is not dict or type(exception.get('evidence')) is not dict:
            _invalid()
        values = {'sequence_hash': _hash(sequence_hash), 'kind': _kind(exception.get('kind')), 'transaction_hash': _hash(exception.get('transaction_hash')),
                  'block_number': _number(exception.get('block_number')), 'block_hash': _hash(exception.get('block_hash')),
                  'intent_id': _hash(exception.get('intent_id'))}
        values['exception_id'] = exception_id(values['sequence_hash'], values['transaction_hash'])
        def operation(conn, owner):
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (values['exception_id'],))
            old = conn.execute('SELECT * FROM ledger_exceptions WHERE owner=%s AND exception_id=%s', (owner, values['exception_id'])).fetchone()
            if old:
                if any(old[key] != values[key] for key in EXCEPTION_IDENTITY):
                    raise ExecutionStoreError('execution_identity_conflict')
                return {**self._exception_row(old), 'state': 'existing'}
            row = conn.execute('INSERT INTO ledger_exceptions(exception_id,owner,sequence_hash,kind,transaction_hash,block_number,block_hash,intent_id,evidence) '
                               'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                               (values['exception_id'], owner, *(values[key] for key in EXCEPTION_IDENTITY), Jsonb(exception['evidence']))).fetchone()
            return {**self._exception_row(row), 'state': 'recorded'}
        return self._transaction(owner, operation)

    def exceptions(self, owner, sequence_hash, *, acknowledged=None, limit=50):
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            rows = conn.execute('SELECT * FROM ledger_exceptions WHERE owner=%s AND sequence_hash=%s AND (%s::boolean IS NULL OR acknowledged=%s) '
                                'ORDER BY block_number,transaction_hash LIMIT %s', (owner, sequence_hash, acknowledged, acknowledged, int(limit))).fetchall()
            return [self._exception_row(row) for row in rows]
        return self._transaction(owner, operation)

    def acknowledge(self, owner, exception_id_, reason):
        """An operator's acknowledgement, once, with a reason on record. It does
        not change the ledger: what the evidence supported was recorded first."""
        exception_id_ = _hash(exception_id_)
        if type(reason) is not str or not REASON.fullmatch(reason):
            _invalid()
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM ledger_exceptions WHERE owner=%s AND exception_id=%s FOR UPDATE', (owner, exception_id_)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            if not row['acknowledged']:
                row = conn.execute('UPDATE ledger_exceptions SET acknowledged=true,acknowledgement=%s,updated_at=clock_timestamp() WHERE exception_id=%s RETURNING *',
                                   (reason, exception_id_)).fetchone()
            return self._exception_row(row)
        return self._transaction(owner, operation)


# ------------------------------------------------------------------- indexer
class LedgerIndexer:
    """Read one sequence's fee events from finalized blocks past its cursor."""
    def __init__(self, reader, store, *, max_blocks, max_logs):
        if type(max_blocks) is not int or max_blocks < 1 or type(max_logs) is not int or max_logs < 1:
            raise ValueError('invalid_indexer_bounds')
        self.reader, self.store, self.max_blocks, self.max_logs = reader, store, max_blocks, max_logs

    def index(self, owner, admission, *, from_block=None):
        """One bounded pass: at most `max_blocks` finalized blocks past the
        cursor (or past `from_block`, an operator's explicit rescan). Records are
        idempotent, so a pass interrupted after some of them repeats safely."""
        owner = _owner(owner)
        seq = admission.sequence
        seq_hash, vault, engine = seq.digest(), seq.vault, admission.executionEngine
        final = self.reader.finalized()
        cursor = self.store.cursor(owner, seq_hash)
        summary = {'sequenceHash': seq_hash, 'finalized': final['number'], 'cursor': cursor['blockNumber'] if cursor else None,
                   'from': None, 'to': None, 'withdrawals': [], 'verified': [], 'exceptions': [], 'held': None, 'caughtUp': True}
        if from_block is not None:
            start = _number(from_block)
        elif cursor is None:
            # Reading starts at admission: the finalized head becomes the cursor.
            # Earlier blocks are read only on an operator's explicit request.
            self.store.set_cursor(owner, seq_hash, vault, final['number'], final['hash'])
            summary.update(cursor=final['number'], started=final['number'])
            return summary
        else:
            start = cursor['blockNumber'] + 1
        if start > final['number']:
            return summary
        end = min(final['number'], start + self.max_blocks - 1)
        summary.update({'from': start, 'to': end, 'caughtUp': end == final['number']})
        window = {'fromBlock': hex(start), 'toBlock': hex(end)}
        logs = [validate_log(raw) for raw in
                self.reader.logs({'address': vault, 'topics': [WITHDRAWN], **window}, max_logs=self.max_logs)
                + self.reader.logs({'address': engine, 'topics': [list(EXECUTION_EVENTS), '0x' + '00' * 12 + vault[2:]], **window}, max_logs=self.max_logs)]
        headers = {}
        for log in logs:
            if not start <= log['blockNumber'] <= end:
                raise ObservationError('automation_log_outside_window')
            if log['blockNumber'] not in headers:
                headers[log['blockNumber']] = self.reader.block(log['blockNumber'])
            if headers[log['blockNumber']]['hash'] != log['blockHash']:
                raise ObservationError('automation_log_not_canonical')
        transactions = {}
        for log in sorted(logs, key=lambda entry: (entry['blockNumber'], entry['logIndex'])):
            transactions.setdefault(log['transactionHash'], []).append(log)
        for tx_hash, tx_logs in transactions.items():
            block = headers[tx_logs[0]['blockNumber']]
            receipt = self.reader.receipt(tx_hash)
            check_receipt(receipt, tx_hash, block)
            events = [(receipt_position(receipt, log), log) for log in tx_logs]
            execution = [(index, log) for index, log in events if log['address'] == engine]
            if execution:
                outcome = self._classify(owner, seq_hash, tx_hash, block, execution)
                if outcome == 'held':
                    # Our own transaction, not yet reconciled: stop before its
                    # block so the executor's journal settles it first.
                    end = block['number'] - 1
                    summary.update(held=tx_hash, to=end, caughtUp=False)
                    break
                if outcome == 'verified':
                    summary['verified'].append(tx_hash)
                else:
                    summary['exceptions'].append(outcome)
            for index, log in events:
                if log['address'] == vault:
                    summary['withdrawals'].append(self._withdrawal(owner, seq_hash, tx_hash, block, index, log, final))
        again = self.reader.finalized()
        if again['number'] < final['number'] or (again['number'] == final['number'] and again['hash'] != final['hash']):
            raise ObservationError('automation_finality_changed')
        if end >= start and (cursor is None or end > cursor['blockNumber']):
            tail = headers.get(end) or self.reader.block(end)
            summary['cursor'] = self.store.set_cursor(owner, seq_hash, vault, end, tail['hash'])['blockNumber']
        return summary

    def _classify(self, owner, seq_hash, tx_hash, block, events):
        intents = {log['topics'][2] for _, log in events if len(log['topics']) > 2}
        if len(intents) != 1:
            raise ObservationError('automation_execution_events_mixed')
        intent = intents.pop()
        known = self.store.execution_of(owner, tx_hash)
        if known is not None and known['intentId'] == intent:
            if known['journalState'] == 'reconciled' and known['canonical'] is True:
                return 'verified'
            if known['journalState'] in HOLD_STATES:
                return 'held'
        evidence = {'events': [{'eventIndex': index, 'name': EXECUTION_EVENTS[log['topics'][0]],
                                'subject': log['topics'][3] if len(log['topics']) > 3 else None} for index, log in events],
                    'journalState': known['journalState'] if known else None, 'signedIntentId': known['intentId'] if known else None}
        record = self.store.record_exception(owner, seq_hash, {
            'kind': 'unreconciled_execution' if known is not None else 'foreign_execution', 'transaction_hash': tx_hash,
            'block_number': block['number'], 'block_hash': block['hash'], 'intent_id': intent, 'evidence': evidence})
        return record['exceptionId']

    def _withdrawal(self, owner, seq_hash, tx_hash, block, index, log, final):
        fields = decode_withdrawal(log)
        if fields['owner'] != owner:
            raise ObservationError('automation_withdrawal_owner_mismatch')
        event = {'source_id': fields['source_id'], 'currency': fields['currency'], 'transaction_hash': tx_hash, 'event_index': index,
                 'block_number': block['number'], 'block_hash': block['hash'], 'state_nonce': fields['state_nonce'],
                 'original_raw': fields['original_raw'], 'charged_raw': fields['charged_raw'],
                 'evidence': {'log': {'logIndex': log['logIndex'], 'transactionIndex': log['transactionIndex'], 'topics': log['topics'], 'data': log['data']},
                              'finalized': {'number': final['number'], 'hash': final['hash']}}}
        return self.store.record_withdrawal(owner, seq_hash, event)


def catch_up(indexer, owner, admission, *, from_block=None, max_passes=MAX_INDEX_PASSES):
    """Repeat bounded passes until the cursor reaches the finalized head, a
    held transaction stops it, or the pass budget is spent."""
    passes = []
    for _ in range(max_passes):
        summary = indexer.index(owner, admission, from_block=from_block)
        from_block = None
        passes.append(summary)
        if summary['caughtUp'] or summary['held'] is not None:
            break
    return passes
