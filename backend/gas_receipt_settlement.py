"""Read-only canonical receipt proof before settling the shared pilot gas cap.

The charged operand is receipt gasUsed * effectiveGasPrice: a conservative
gross fee on this Nitro chain, not an assertion of exact net wallet debit.
Publisher and operator claims share one Sao Paulo day in the budget database.
No method here signs, broadcasts, cancels, or invents a replacement transaction.
"""
from dataclasses import dataclass
import json
import re

import psycopg
from psycopg.rows import dict_row
from eth_abi import encode
from eth_hash.auto import keccak

import execution_models as m
import execution_v4 as v4
from automation_plan import observation_id, publish_calldata
import general_compound_receipts as g
from execution_signer import verify_signed
from execution_store import ExecutionStoreError, _model
from execution_v4_adapter import decode_plan
from gas_usd_budget import EthUsdReader, GasBudgetError, GasUsdBudget
from gas_budget_bridge import GasBudgetClient


class GasSettlementError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


_HASH = re.compile(r'0x[0-9a-f]{64}\Z')
_OWNER = re.compile(r'0x[0-9a-f]{40}\Z')
_DECIMAL = re.compile(r'(?:0|[1-9][0-9]*)\Z')


def _decimal(value):
    if type(value) is not str or not _DECIMAL.fullmatch(value):
        raise GasSettlementError('gas_receipt_invalid')
    return int(value)


@dataclass(frozen=True)
class ReceiptGasProof:
    transaction_hash: str
    signer: str
    status: int
    block: dict
    gas_used: int
    effective_gas_price: int
    gross_cost_wei: int
    envelope_cost_wei: int


class GasBudgetClaimReader:
    """Read only the claim needed to bind a receipt to its signer and ceiling."""

    def __init__(self, connection):
        self.connection = connection

    def read(self, cycle_id, leg):
        if (type(cycle_id) is not str or not _HASH.fullmatch(cycle_id)
                or leg not in ('publisher', 'operator')):
            raise GasSettlementError('gas_claim_invalid')
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT signer,max_cost_wei::text,state,spent_wei::text '
                    'FROM domino_gas_budget.claim_for_settlement(%s,%s)',
                    (cycle_id, leg)).fetchone()
        except psycopg.Error:
            raise GasSettlementError('gas_claim_unavailable') from None
        if row is None:
            raise GasSettlementError('gas_claim_missing')
        return {'signer': row[0], 'maxCostWei': int(row[1]),
                'state': row[2], 'spentWei': None if row[3] is None else int(row[3])}


class SettlementPublicationReader:
    """The settlement peer reads its witness without publisher write access."""

    def __init__(self, connection):
        self.connection = connection

    def settlement_record(self, identifier):
        if type(identifier) is not str or not _HASH.fullmatch(identifier):
            raise GasSettlementError('gas_publication_invalid')
        try:
            with self.connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute('SELECT * FROM domino_execution.gas_publication_witness(%s)',
                               (identifier,))
                row = cursor.fetchone()
        except psycopg.Error:
            raise GasSettlementError('gas_journal_unavailable') from None
        if row is None:
            raise ExecutionStoreError('execution_not_found')
        return row


class SettlementExecutionReader:
    """Read the exact intent and persisted attempts; no signer DB role."""

    def __init__(self, connection):
        self.connection = connection

    def read(self, owner, identifier):
        if (type(owner) is not str or not _OWNER.fullmatch(owner)
                or type(identifier) is not str or not _HASH.fullmatch(identifier)):
            raise GasSettlementError('gas_intent_invalid')
        try:
            with self.connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute('SELECT * FROM domino_execution.gas_intent_witness(%s,%s)',
                               (owner, identifier))
                intent = cursor.fetchone()
                if intent is None:
                    raise ExecutionStoreError('execution_not_found')
                cursor.execute('SELECT * FROM domino_execution.gas_journal_witness(%s,%s)',
                               (owner, identifier))
                journal = cursor.fetchone()
                cursor.execute('SELECT * FROM domino_execution.gas_attempt_witness(%s,%s) ORDER BY ordinal',
                               (owner, identifier))
                attempts = cursor.fetchall()
                cursor.execute('SELECT * FROM domino_execution.gas_effect_witness(%s,%s)',
                               (owner, identifier))
                effect = cursor.fetchone()
                cursor.execute('SELECT * FROM domino_execution.gas_reverted_witness(%s,%s)',
                               (owner, identifier))
                reverted = cursor.fetchone()
        except psycopg.Error:
            raise GasSettlementError('gas_journal_unavailable') from None
        return {'intent': intent, 'journal': journal, 'attempts': attempts,
                'effect': effect, 'reverted': reverted}


class GasReceiptSettlement:
    def __init__(self, rpc, quote_reader, gas_budget, publisher_journal,
                 execution_journal, *, claim_reader=None, quote_attester=None):
        if getattr(gas_budget, 'reader', quote_reader) is not quote_reader:
            raise GasSettlementError('gas_quote_reader_mismatch')
        self.rpc = rpc
        self.quote_reader = quote_reader
        self.budget = gas_budget
        self.publisher_journal = publisher_journal
        self.execution_journal = execution_journal
        self.claim_reader = claim_reader or GasBudgetClaimReader(gas_budget.connection)
        self.quote_attester = quote_attester

    def _rpc(self, method, params):
        try:
            return self.rpc.request(method, params)
        except Exception:
            raise GasSettlementError('gas_receipt_rpc_unavailable') from None

    @staticmethod
    def _envelope(envelope, signer):
        if (type(envelope) is not dict or type(signer) is not str
                or not _OWNER.fullmatch(signer) or set(envelope) not in ({
                    'chainId', 'nonce', 'type', 'to', 'value', 'data', 'gas',
                    'maxFeePerGas', 'maxPriorityFeePerGas'}, {
                    'chainId', 'nonce', 'type', 'to', 'value', 'data', 'gas',
                    'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList'})
                or envelope['chainId'] != 4663 or envelope['type'] != 2
                or envelope['value'] != 0 or envelope.get('accessList', []) != []
                or type(envelope['nonce']) is not int or envelope['nonce'] < 0
                or type(envelope['gas']) is not int or not 0 < envelope['gas'] < 2**128
                or type(envelope['maxFeePerGas']) is not int
                or not 0 <= envelope['maxFeePerGas'] < 2**128
                or type(envelope['maxPriorityFeePerGas']) is not int
                or not 0 <= envelope['maxPriorityFeePerGas'] <= envelope['maxFeePerGas']
                or type(envelope['data']) is not str
                or not _OWNER.fullmatch(envelope['to'])):
            raise GasSettlementError('gas_receipt_envelope_invalid')
        try:
            g._hex(envelope['data'])
        except ValueError:
            raise GasSettlementError('gas_receipt_envelope_invalid') from None
        maximum = envelope['gas'] * envelope['maxFeePerGas']
        if not 0 < maximum < 2**128:
            raise GasSettlementError('gas_receipt_envelope_invalid')
        return maximum

    def _proof(self, tx_hash, signer, envelope, signed_bytes):
        """Prove one hash, its canonical inclusion, finality, and exact gas."""
        maximum = self._envelope(envelope, signer)
        try:
            tx_hash = g._hash(tx_hash)
            if type(signed_bytes) not in (bytes, bytearray, memoryview):
                raise ValueError()
            verify_signed(bytes(signed_bytes), envelope, signer, tx_hash)
            if g._quantity(self._rpc('eth_chainId', [])) != 4663:
                raise GasSettlementError('gas_receipt_wrong_chain')
            receipt = self._rpc('eth_getTransactionReceipt', [tx_hash])
            if receipt is None:
                raise GasSettlementError('gas_receipt_pending')
            tx = self._rpc('eth_getTransactionByHash', [tx_hash])
            if type(receipt) is not dict or type(tx) is not dict:
                raise GasSettlementError('gas_receipt_invalid')
            if len(json.dumps(receipt, allow_nan=False).encode()) > g.MAX_RECEIPT_BYTES:
                raise GasSettlementError('gas_receipt_invalid')
            number = g._quantity(receipt.get('blockNumber'))
            index = g._quantity(receipt.get('transactionIndex'))
            raw_block = self._rpc('eth_getBlockByNumber', [hex(number), False])
            block = g._header(raw_block)
            final = g._header(self._rpc('eth_getBlockByNumber', ['finalized', False]))
            transactions = raw_block.get('transactions')
            if (block['number'] != number or final['number'] < number
                    or final['timestamp'] < block['timestamp']
                    or final['number'] == number and final != block):
                raise GasSettlementError('gas_receipt_not_final')
            if (type(transactions) is not list or len(transactions) > g.MAX_TRANSACTIONS
                    or index >= len(transactions) or g._hash(transactions[index]) != tx_hash):
                raise GasSettlementError('gas_receipt_location_invalid')
            for obj, hash_field in ((tx, 'hash'), (receipt, 'transactionHash')):
                if (g._hash(obj.get(hash_field)) != tx_hash
                        or g._hash(obj.get('blockHash')) != block['hash']
                        or g._quantity(obj.get('blockNumber')) != number
                        or g._quantity(obj.get('transactionIndex')) != index
                        or g._address(obj.get('from')) != signer
                        or g._address(obj.get('to')) != envelope['to']):
                    raise GasSettlementError('gas_receipt_identity')
            if (g._quantity(tx.get('chainId')) != 4663
                    or g._quantity(tx.get('type')) != 2
                    or g._quantity(tx.get('nonce')) != envelope['nonce']
                    or g._quantity(tx.get('value')) != 0
                    or g._quantity(tx.get('gas')) != envelope['gas']
                    or g._quantity(tx.get('maxFeePerGas')) != envelope['maxFeePerGas']
                    or g._quantity(tx.get('maxPriorityFeePerGas')) != envelope['maxPriorityFeePerGas']
                    or '0x' + g._hex(tx.get('input')).hex() != envelope['data']
                    or tx.get('accessList', []) != []):
                raise GasSettlementError('gas_receipt_identity')
            status = g._quantity(receipt.get('status'))
            gas = g._quantity(receipt.get('gasUsed'))
            fee = g._quantity(receipt.get('effectiveGasPrice'))
            if (status not in (0, 1) or not 0 < gas <= envelope['gas']
                    or not 0 < fee <= envelope['maxFeePerGas'] or gas * fee >= 2**128):
                raise GasSettlementError('gas_receipt_cost_invalid')
            return ReceiptGasProof(tx_hash, signer, status, block, gas, fee,
                                   gas * fee, maximum)
        except GasSettlementError:
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            raise GasSettlementError('gas_receipt_invalid') from None

    def _still_canonical(self, proof):
        try:
            reread = g._header(self._rpc('eth_getBlockByNumber',
                                         [hex(proof.block['number']), False]))
            final = g._header(self._rpc('eth_getBlockByNumber', ['finalized', False]))
            if (reread != proof.block or final['number'] < reread['number']
                    or final['number'] == reread['number'] and final != reread
                    or g._quantity(self._rpc('eth_chainId', [])) != 4663):
                raise GasSettlementError('gas_receipt_reorganized')
        except GasSettlementError:
            raise
        except (ValueError, TypeError, KeyError):
            raise GasSettlementError('gas_receipt_reorganized') from None

    def _settle(self, cycle_id, leg, proof):
        claim = self.claim_reader.read(cycle_id, leg)
        if (claim['signer'] != proof.signer or claim['maxCostWei'] < proof.envelope_cost_wei
                or claim['state'] not in ('reserved', 'settled')
                or claim['state'] == 'settled' and claim['spentWei'] != proof.gross_cost_wei):
            raise GasSettlementError('gas_claim_mismatch')
        quote = self.quote_reader.quote()
        if quote.block_number < proof.block['number']:
            raise GasSettlementError('gas_quote_before_receipt')
        self._still_canonical(proof)
        if self.quote_attester is None:
            settled = self.budget.settle(cycle_id, leg, proof.gross_cost_wei, quote)
        else:
            witnessed_quote = self.quote_attester.attest_settlement_quote(cycle_id, leg)
            if witnessed_quote['blockNumber'] < proof.block['number']:
                raise GasSettlementError('gas_quote_before_receipt')
            settled = self.budget.settle(cycle_id, leg, proof.gross_cost_wei, quote,
                                         witnessed_quote=witnessed_quote)
        return {'cycleId': cycle_id, 'leg': leg, 'transactionHash': proof.transaction_hash,
                'grossCostWei': str(proof.gross_cost_wei), 'grossCostBasis': 'receipt_gas_product',
                'budgetDay': settled['day'], 'spentUsdMicros': settled['spentUsdMicros'],
                'state': settled['state']}

    def publisher(self, identifier):
        if type(identifier) is not str or not _HASH.fullmatch(identifier):
            raise GasSettlementError('gas_publication_invalid')
        try:
            row = self.publisher_journal.settlement_record(identifier)
            point = (bytes.fromhex(row['pool_id'][2:]), int(row['block_number']),
                     bytes.fromhex(row['block_hash'][2:]), int(row['block_timestamp']),
                     int(row['expires_at']), int(row['sqrt_price']))
            if row['state'] in ('signed', 'submitted', 'broadcast_unknown', 'included', 'expired'):
                raise GasSettlementError('gas_publication_not_confirmed')
            if (row['observation_id'] != identifier
                    or observation_id(row['guard'], point) != identifier
                    or row['envelope']['to'] != row['guard']
                    or row['envelope']['data'] != publish_calldata(point)
                    or row['state'] not in ('confirmed', 'reverted')):
                raise GasSettlementError('gas_publication_identity')
            proof = self._proof(row['transaction_hash'], row['signer'],
                                row['envelope'], row['signed_bytes'])
            if (row['state'] != ('confirmed' if proof.status else 'reverted')
                    or int(row['included_block_number']) != proof.block['number']
                    or row['included_block_hash'] != proof.block['hash']
                    or int(row['gas_used']) != proof.gas_used
                    or int(row['effective_gas_price']) != proof.effective_gas_price):
                raise GasSettlementError('gas_publication_receipt_mismatch')
        except GasSettlementError:
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            raise GasSettlementError('gas_publication_identity') from None
        return self._settle(identifier, 'publisher', proof)

    def operator(self, owner, identifier):
        if (type(owner) is not str or not _OWNER.fullmatch(owner)
                or type(identifier) is not str or not _HASH.fullmatch(identifier)):
            raise GasSettlementError('gas_intent_invalid')
        try:
            data = self.execution_journal.read(owner, identifier)
            intent, journal = data['intent'], data['journal']
            if journal is None or not data['attempts']:
                raise GasSettlementError('gas_intent_unsigned')
            if journal['state'] in ('signing', 'signed', 'submitted', 'broadcast_unknown', 'included'):
                raise GasSettlementError('gas_intent_not_reconciled')
            plan = m.ExecutionPlan.model_validate_json(json.dumps(intent['plan']))
            obs = m.Observation.model_validate_json(json.dumps(intent['observation']))
            admission = _model(v4.Admission, journal['admission'])
            point = (bytes.fromhex(plan.sequence.poolId[2:]), int(plan.sourceBlockNumber),
                     bytes.fromhex(plan.sourceBlockHash[2:]), int(obs.blockTimestamp),
                     int(plan.deadline), int(obs.sqrtPriceX96))
            anchor = observation_id(admission.priceGuard, point)
            if (intent['owner'] != owner or intent['intent_id'] != identifier
                    or plan.intent_id() != identifier or plan.sequence != admission.sequence
                    or obs.sequence != plan.sequence or obs.operator != journal['signer']
                    or intent['commitments'].get('priceObservationId') != anchor
                    or journal['owner'] != owner or journal['intent_id'] != identifier
                    or journal['action'] != 'typed_fee_execution_v4'
                    or journal['state'] not in ('reconciled', 'reverted')):
                raise GasSettlementError('gas_intent_identity')
            attempts = data['attempts']
            if type(attempts) is not list or not 1 <= len(attempts) <= 4:
                raise GasSettlementError('gas_intent_ambiguous')
            included = []
            for attempt in attempts:
                if (attempt['owner'] != owner or attempt['intent_id'] != identifier
                        or attempt['envelope']['to'] != plan.sequence.vault
                        or attempt['envelope']['nonce'] != int(journal['nonce'])):
                    raise GasSettlementError('gas_intent_identity')
                typed = decode_plan(attempt['envelope']['data'])
                authority = typed.authority
                if (authority.intentId != identifier
                        or authority.tokenId != plan.destination.tokenId
                        or authority.policyVersion != plan.expectedPolicyVersion
                        or authority.limitsVersion != obs.policy.limits.version
                        or authority.stateNonce != plan.expectedStateNonce
                        or authority.authorityGeneration != plan.expectedAuthorityGeneration
                        or authority.observedAtBlock != plan.sourceBlockNumber
                        or authority.observedBlockHash != plan.sourceBlockHash
                        or authority.observedAtTimestamp != obs.blockTimestamp
                        or authority.deadline != plan.deadline
                        or authority.liquidityIncrease != plan.liquidityIncrease
                        or authority.minAdded0 != plan.minNetAdded0
                        or authority.minAdded1 != plan.minNetAdded1
                        or authority.minSqrtPriceX96 != plan.minSqrtPriceX96
                        or authority.maxSqrtPriceX96 != plan.maxSqrtPriceX96
                        or typed.action != (plan.path if plan.action == 1 else plan.action)
                        or typed.destinationTokenId != (
                            '0' if plan.action == 3 else plan.destination.tokenId)
                        or typed.maxAdded0 != plan.maxNetAdded0
                        or typed.maxAdded1 != plan.maxNetAdded1
                        or typed.swap.priceObservationId != anchor):
                    raise GasSettlementError('gas_intent_identity')
                try:
                    proof = self._proof(attempt['transaction_hash'], journal['signer'],
                                        attempt['envelope'], attempt['signed_bytes'])
                except GasSettlementError as error:
                    if error.code == 'gas_receipt_pending':
                        continue
                    raise
                included.append(proof)
            if len(included) != 1:
                raise GasSettlementError('gas_intent_ambiguous')
            proof = included[0]
            effect = data['effect']
            if proof.status:
                if (journal['state'] != 'reconciled' or type(effect) is not dict
                        or effect.get('canonical') is not True
                        or effect.get('transaction_hash') != proof.transaction_hash
                        or int(effect.get('block_number')) != proof.block['number']
                        or effect.get('block_hash') != proof.block['hash']):
                    raise GasSettlementError('gas_intent_effect_mismatch')
                result = effect['receipt']
                gas_result = result['gas']
                if (result.get('intentId') != identifier or result.get('finalized') is not True
                        or result.get('canonical') is not True or result.get('block') != proof.block
                        or _decimal(gas_result.get('gasUsedRaw')) != proof.gas_used
                        or _decimal(gas_result.get('effectiveGasPriceRaw')) != proof.effective_gas_price
                        or _decimal(gas_result.get('receiptGasProductWei')) != proof.gross_cost_wei
                        or gas_result.get('payer') != proof.signer):
                    raise GasSettlementError('gas_intent_effect_mismatch')
            else:
                reverted = data.get('reverted')
                if (journal['state'] != 'reverted' or effect and effect.get('canonical')
                        or type(reverted) is not dict or reverted.get('owner') != owner
                        or reverted.get('intent_id') != identifier
                        or reverted.get('transaction_hash') != proof.transaction_hash
                        or int(reverted.get('block_number')) != proof.block['number']
                        or reverted.get('block_hash') != proof.block['hash']
                        or int(reverted.get('gas_used')) != proof.gas_used
                        or int(reverted.get('effective_gas_price')) != proof.effective_gas_price):
                    raise GasSettlementError('gas_intent_effect_mismatch')
        except GasSettlementError:
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            raise GasSettlementError('gas_intent_identity') from None
        return self._settle(identifier, 'operator', proof)


class GasSettlementService:
    """Receipt reconciliation uses a separate role with no reserve permission."""

    def __init__(self, settings, rpc, *, connect=psycopg.connect, queue=None):
        if type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}:
            raise GasSettlementError('gas_settlement_configuration')
        self.settings, self.rpc, self.connect = dict(settings), rpc, connect
        self.queue = queue if queue is not None else GasSettlementQueue(settings, connect=connect)

    def _settler(self):
        try:
            conn = self.connect(**self.settings, user='domino_gas_settlement_login',
                connect_timeout=2, options='-c statement_timeout=5000 -c lock_timeout=2000 '
                '-c search_path=pg_catalog -c TimeZone=UTC')
        except psycopg.Error:
            raise GasSettlementError('gas_settlement_unavailable') from None
        reader = EthUsdReader(self.rpc, finalized=True)
        budget = GasUsdBudget(conn, reader=reader)
        return conn, GasReceiptSettlement(self.rpc, reader, budget,
            SettlementPublicationReader(conn), SettlementExecutionReader(conn),
            quote_attester=GasBudgetClient())

    def publisher(self, identifier):
        conn, settler = self._settler()
        with conn:
            return settler.publisher(identifier)

    def operator(self, owner, identifier):
        conn, settler = self._settler()
        with conn:
            return settler.operator(owner, identifier)

    def cancel_unsigned(self, identifier, leg):
        """Ask PostgreSQL to prove terminal no-sign status under signer locks.

        Journal absence in Python is only a hint. The definer function checks
        terminal intent/cycle state, signed journals and the same lock used at
        the key boundary before it releases any reservation.
        """
        if (type(identifier) is not str or not _HASH.fullmatch(identifier)
                or leg not in ('publisher', 'operator')):
            raise GasSettlementError('gas_cancellation_invalid')
        conn, _ = self._settler()
        try:
            with conn:
                row = conn.execute('SELECT cancelled,released_usd_micros::text,reason '
                    'FROM domino_gas_budget.cancel_unsigned(%s,%s)',
                    (identifier, leg)).fetchone()
        except psycopg.Error:
            raise GasSettlementError('gas_cancellation_unavailable') from None
        if row is None or type(row[0]) is not bool or type(row[1]) is not str:
            raise GasSettlementError('gas_cancellation_unavailable')
        return {'cancelled': row[0], 'releasedUsdMicros': int(row[1]),
                'reason': row[2]}

    def sweep(self, *, limit=8):
        """One finite pass over durable claims; no wallet keys or broadcasts.

        The queue advances independently of receipt settlement. A failed read,
        reorg, unsigned journal or ambiguous receipt leaves the claim reserved
        and is revisited when the queue wraps on a later pass.
        """
        targets = self.queue.next_pending(limit)
        results = []
        for target in targets:
            identifier, leg, owner = target['cycleId'], target['leg'], target['owner']
            try:
                if leg == 'publisher':
                    result = self.publisher(identifier)
                elif leg == 'operator' and owner is not None:
                    result = self.operator(owner, identifier)
                elif leg == 'operator':
                    raise GasSettlementError('gas_intent_owner_missing')
                else:
                    raise GasSettlementError('gas_claim_invalid')
                results.append({'cycleId': identifier, 'leg': leg, 'state': 'settled',
                                'grossCostWei': result['grossCostWei'],
                                'spentUsdMicros': result['spentUsdMicros']})
            except ExecutionStoreError as error:
                code = ('gas_publication_unsigned' if leg == 'publisher' and error.code == 'execution_not_found'
                        else 'gas_journal_unavailable')
                if code == 'gas_publication_unsigned':
                    try:
                        cancelled = self.cancel_unsigned(identifier, leg)
                    except GasSettlementError as failure:
                        code = failure.code
                    else:
                        if cancelled['cancelled']:
                            results.append({'cycleId': identifier, 'leg': leg,
                                'state': 'cancelled',
                                'releasedUsdMicros': cancelled['releasedUsdMicros'],
                                'reason': cancelled['reason']})
                            continue
                results.append({'cycleId': identifier, 'leg': leg,
                                'state': 'attention', 'reason': code})
            except (GasSettlementError, GasBudgetError) as error:
                if error.code == 'gas_intent_unsigned':
                    try:
                        cancelled = self.cancel_unsigned(identifier, leg)
                    except GasSettlementError as failure:
                        error = failure
                    else:
                        if cancelled['cancelled']:
                            results.append({'cycleId': identifier, 'leg': leg,
                                'state': 'cancelled',
                                'releasedUsdMicros': cancelled['releasedUsdMicros'],
                                'reason': cancelled['reason']})
                            continue
                pending = error.code in {
                    'gas_receipt_pending', 'gas_receipt_not_final',
                    'gas_quote_before_receipt', 'gas_receipt_rpc_unavailable',
                    'gas_quote_rpc_unavailable', 'gas_quote_head_stale',
                    'gas_quote_block_stale', 'gas_quote_answer_stale',
                    'gas_budget_unavailable', 'gas_publication_not_confirmed',
                    'gas_settlement_finality_missing',
                    'gas_intent_not_reconciled',
                }
                results.append({'cycleId': identifier, 'leg': leg,
                                'state': 'pending' if pending else 'attention',
                                'reason': error.code})
        return {'scanned': len(results), 'settled': sum(r['state'] == 'settled' for r in results),
                'cancelled': sum(r['state'] == 'cancelled' for r in results),
                'attention': sum(r['state'] == 'attention' for r in results), 'results': results}


class GasSettlementQueue:
    """Rotating claim scan; only the restricted settlement role can invoke it."""

    def __init__(self, settings, *, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}:
            raise GasSettlementError('gas_settlement_configuration')
        self.settings, self.connect = dict(settings), connect

    def next_pending(self, limit):
        if type(limit) is not int or not 1 <= limit <= 32:
            raise GasSettlementError('gas_settlement_limit_invalid')
        try:
            with self.connect(**self.settings, user='domino_gas_settlement_login',
                    connect_timeout=2, options='-c statement_timeout=5000 -c lock_timeout=2000 '
                    '-c search_path=pg_catalog -c TimeZone=UTC') as conn:
                rows = conn.execute('SELECT cycle_id,leg,owner FROM domino_gas_budget.next_pending(%s)',
                                    (limit,)).fetchall()
        except psycopg.Error:
            raise GasSettlementError('gas_settlement_queue_unavailable') from None
        return [{'cycleId': row[0], 'leg': row[1], 'owner': row[2]} for row in rows]
