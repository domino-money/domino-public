"""A finalized canonical receipt is required before gas can leave pending."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1]),
                str(Path(__file__).resolve().parent)]
from eth_account import Account
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

from automation_plan import observation_id, publish_calldata, build_execution_plan
from execution_v4_adapter import rebuild_v4
import execution_v4 as v4
import general_compound_receipts as g
import test_automation_plan as plans
import test_execution_planner as planner
from execution_cases import address, identity
from execution_store import ExecutionStoreError
from gas_receipt_settlement import GasReceiptSettlement, GasSettlementError, GasSettlementService
from gas_usd_budget import GasBudgetError

GUARD = '0x' + '23' * 20
POINT = (bytes.fromhex('11' * 32), 98, bytes.fromhex('12' * 32),
         1700000000, 1700000600, 2**96)


class FinalizedRpc:
    def __init__(self):
        self.block = {'number': '0x64', 'hash': '0x' + 'a1' * 32,
                      'timestamp': '0x70'}
        self.final = {'number': '0x66', 'hash': '0x' + 'a3' * 32,
                      'timestamp': '0x72'}
        self.transactions = {}
        self.receipts = {}
        self.reorg = False

    def add(self, account, envelope, *, status=1):
        signed = account.sign_transaction({**envelope,
            'to': to_checksum_address(envelope['to'])})
        raw = bytes(signed.raw_transaction)
        digest = '0x' + keccak(raw).hex()
        index = len(self.transactions)
        self.transactions[digest] = {
            'hash': digest, 'blockHash': self.block['hash'],
            'blockNumber': self.block['number'], 'transactionIndex': hex(index),
            'from': account.address.lower(), 'to': envelope['to'],
            'chainId': '0x1237', 'type': '0x2', 'nonce': hex(envelope['nonce']),
            'value': '0x0', 'gas': hex(envelope['gas']),
            'maxFeePerGas': hex(envelope['maxFeePerGas']),
            'maxPriorityFeePerGas': hex(envelope['maxPriorityFeePerGas']),
            'input': envelope['data'], 'accessList': []}
        self.receipts[digest] = {
            'transactionHash': digest, 'blockHash': self.block['hash'],
            'blockNumber': self.block['number'], 'transactionIndex': hex(index),
            'from': account.address.lower(), 'to': envelope['to'],
            'status': hex(status), 'gasUsed': hex(25000),
            'effectiveGasPrice': hex(500_000_000), 'logs': []}
        return raw, digest

    def request(self, method, params):
        if method == 'eth_chainId':
            return '0x1237'
        if method == 'eth_getTransactionByHash':
            return self.transactions.get(params[0])
        if method == 'eth_getTransactionReceipt':
            return self.receipts.get(params[0])
        if method == 'eth_getBlockByNumber':
            if params[0] == 'finalized':
                return self.final
            if int(params[0], 16) == 100:
                block = dict(self.block)
                if self.reorg:
                    block['hash'] = '0x' + 'cc' * 32
                block['transactions'] = list(self.transactions)
                return block
        raise AssertionError(method)


class Budget:
    def __init__(self, quote_reader):
        self.reader = quote_reader
        self.calls = []
        self.witnesses = []

    def settle(self, cycle_id, leg, spent, quote, *, witnessed_quote=None):
        self.calls.append((cycle_id, leg, spent))
        self.witnesses.append(witnessed_quote)
        return {'day': '2026-09-22', 'spentUsdMicros': spent, 'state': 'settled'}


class SettlementTests(unittest.TestCase):
    def setUp(self):
        self.account = Account.from_key(bytes.fromhex('34' * 32))
        self.rpc = FinalizedRpc()
        self.identifier = observation_id(GUARD, POINT)
        self.envelope = {'chainId': 4663, 'nonce': 0, 'type': 2, 'to': GUARD,
            'value': 0, 'data': publish_calldata(POINT), 'gas': 100000,
            'maxFeePerGas': 1_000_000_000, 'maxPriorityFeePerGas': 1_000_000,
            'accessList': []}
        raw, digest = self.rpc.add(self.account, self.envelope)
        self.row = {
            'observation_id': self.identifier, 'guard': GUARD,
            'pool_id': '0x' + POINT[0].hex(), 'block_number': POINT[1],
            'block_hash': '0x' + POINT[2].hex(), 'block_timestamp': POINT[3],
            'expires_at': POINT[4], 'sqrt_price': POINT[5],
            'signer': self.account.address.lower(), 'envelope': self.envelope,
            'signed_bytes': raw, 'transaction_hash': digest, 'state': 'confirmed',
            'included_block_number': 100, 'included_block_hash': self.rpc.block['hash'],
            'gas_used': 25000, 'effective_gas_price': 500_000_000}
        self.pub_journal = Mock()
        self.pub_journal.settlement_record.return_value = self.row
        self.operator_journal = Mock()
        self.quote_reader = Mock()
        self.quote_reader.quote.return_value = Mock(block_number=110)
        self.budget = Budget(self.quote_reader)
        self.claim_reader = Mock()
        self.claim_reader.read.return_value = {
            'signer': self.account.address.lower(), 'maxCostWei': 100_000_000_000_000,
            'state': 'reserved', 'spentWei': None}
        self.settler = GasReceiptSettlement(self.rpc, self.quote_reader, self.budget,
            self.pub_journal, self.operator_journal, claim_reader=self.claim_reader)

    def test_finalized_publication_settles_receipt_gas_product(self):
        result = self.settler.publisher(self.identifier)
        self.assertEqual(result['grossCostWei'], '12500000000000')
        self.assertEqual(self.budget.calls,
                         [(self.identifier, 'publisher', 12_500_000_000_000)])

    def test_finalized_receipt_requests_independent_quote_before_settlement(self):
        attester = Mock()
        witness = {'answerRaw': 4000 * 10**8, 'roundId': (1 << 64) + 17,
                   'answerUpdatedAt': 1, 'blockNumber': 110,
                   'blockHash': '0x' + 'a1' * 32, 'blockTimestamp': 2}
        attester.attest_settlement_quote.return_value = witness
        self.settler.quote_attester = attester
        self.settler.publisher(self.identifier)
        attester.attest_settlement_quote.assert_called_once_with(self.identifier, 'publisher')
        self.assertEqual(self.budget.witnesses, [witness])
        self.budget.calls.clear()
        attester.attest_settlement_quote.return_value = {**witness, 'blockNumber': 99}
        with self.assertRaisesRegex(GasSettlementError, 'gas_quote_before_receipt'):
            self.settler.publisher(self.identifier)
        self.assertEqual(self.budget.calls, [])

    def test_pending_reorg_and_foreign_receipt_keep_claim(self):
        self.rpc.final['number'] = '0x63'
        with self.assertRaisesRegex(GasSettlementError, 'gas_receipt_not_final'):
            self.settler.publisher(self.identifier)
        self.rpc.final['number'] = '0x66'
        self.rpc.reorg = True
        with self.assertRaises(GasSettlementError):
            self.settler.publisher(self.identifier)
        self.rpc.reorg = False
        self.rpc.receipts[self.row['transaction_hash']]['from'] = GUARD
        with self.assertRaisesRegex(GasSettlementError, 'gas_receipt_identity'):
            self.settler.publisher(self.identifier)
        self.assertEqual(self.budget.calls, [])

    def test_wrong_claim_or_journal_receipt_never_releases(self):
        self.claim_reader.read.return_value['maxCostWei'] = 1
        with self.assertRaisesRegex(GasSettlementError, 'gas_claim_mismatch'):
            self.settler.publisher(self.identifier)
        self.claim_reader.read.return_value['maxCostWei'] = 100_000_000_000_000
        self.row['gas_used'] = 1
        with self.assertRaisesRegex(GasSettlementError, 'gas_publication_receipt_mismatch'):
            self.settler.publisher(self.identifier)
        self.assertEqual(self.budget.calls, [])

    def test_operator_journal_binds_final_receipt_to_intent(self):
        obs, history, settings = plans.v4_setup()
        decision, candidate = plans.chosen(obs, history, settings,
                                           planner.evidence(obs, settings))
        plan = build_execution_plan(plans.context(obs), candidate,
                                    plan_policy=plans.EXACT, gas_cap_wei=10**14)
        operator = Account.from_key(bytes.fromhex('12' * 32))
        obs = obs.model_copy(update={'operator': operator.address.lower()})
        plan = plan.model_copy(update={'observationHash': obs.digest()})
        pin_addresses = (obs.sequence.vault, obs.sequence.implementation,
            obs.sequence.factory, obs.sequence.poolManager,
            obs.sequence.positionManager, address(10), address(11),
            address(12), address(13), GUARD)
        admission = v4.Admission(sequence=obs.sequence, stateView=address(10),
            readHelper=address(11), executionEngine=address(12),
            routingHelper=address(13), priceGuard=GUARD,
            pricePublisher=address(15),
            runtimePins=tuple(g.RuntimePin(address=a, codeHash=identity(900 + i))
                              for i, a in enumerate(pin_addresses)))
        point = (bytes.fromhex(obs.sequence.poolId[2:]), int(plan.sourceBlockNumber),
            bytes.fromhex(plan.sourceBlockHash[2:]), int(obs.blockTimestamp),
            int(plan.deadline), int(obs.sqrtPriceX96))
        anchor = observation_id(GUARD, point)
        typed = rebuild_v4(plan, obs, plans.context(obs).checkpoints,
                           price_observation_id=anchor)
        intent = plan.intent_id()
        envelope = {**self.envelope, 'to': plan.sequence.vault,
                    'data': typed.calldata()}
        raw, digest = self.rpc.add(operator, envelope)
        block = {'number': 100, 'hash': self.rpc.block['hash'], 'timestamp': 112}
        effect = {'canonical': True, 'transaction_hash': digest,
            'block_number': 100, 'block_hash': self.rpc.block['hash'],
            'receipt': {'intentId': intent, 'transactionHash': digest,
                'finalized': True, 'canonical': True, 'block': block,
                'gas': {'gasUsedRaw': '25000', 'effectiveGasPriceRaw': '500000000',
                        'receiptGasProductWei': '12500000000000',
                        'payer': operator.address.lower()}}}
        data = {'intent': {'owner': plan.sequence.owner, 'intent_id': intent,
                'plan': plan.model_dump(mode='json'), 'observation': obs.model_dump(mode='json'),
                'commitments': {'priceObservationId': anchor}},
            'journal': {'owner': plan.sequence.owner, 'intent_id': intent,
                'signer': operator.address.lower(), 'nonce': 0,
                'admission': admission.model_dump(mode='json'),
                'action': 'typed_fee_execution_v4', 'state': 'reconciled'},
            'attempts': [{'owner': plan.sequence.owner, 'intent_id': intent,
                'envelope': envelope, 'signed_bytes': raw,
                'transaction_hash': digest}],
            'effect': effect}
        self.operator_journal.read.return_value = data
        self.claim_reader.read.return_value = {
            'signer': operator.address.lower(),
            'maxCostWei': 100_000_000_000_000,
            'state': 'reserved', 'spentWei': None}
        result = self.settler.operator(plan.sequence.owner, intent)
        self.assertEqual(result['grossCostWei'], '12500000000000')
        self.assertEqual(self.budget.calls[-1], (intent, 'operator', 12_500_000_000_000))
        self.rpc.receipts[digest]['status'] = '0x0'
        data['journal']['state'] = 'reverted'
        data['effect'] = None
        data['reverted'] = {'owner': plan.sequence.owner, 'intent_id': intent,
            'transaction_hash': digest, 'block_number': 100,
            'block_hash': self.rpc.block['hash'], 'gas_used': 25000,
            'effective_gas_price': 500_000_000}
        self.assertEqual(self.settler.operator(plan.sequence.owner, intent)['grossCostWei'],
                         '12500000000000')
        data['reverted']['gas_used'] = 1
        with self.assertRaisesRegex(GasSettlementError, 'gas_intent_effect_mismatch'):
            self.settler.operator(plan.sequence.owner, intent)
        data['reverted']['gas_used'] = 25000
        data['intent']['commitments']['priceObservationId'] = identity(999)
        with self.assertRaisesRegex(GasSettlementError, 'gas_intent_identity'):
            self.settler.operator(plan.sequence.owner, intent)


class SweepTests(unittest.TestCase):
    def test_only_unsigned_journals_ask_database_for_cancellation_proof(self):
        identifier = '0x' + '11' * 32
        owner = '0x' + '22' * 20
        class Queue:
            def next_pending(self, limit):
                return [{'cycleId': identifier, 'leg': 'publisher', 'owner': None},
                        {'cycleId': identifier, 'leg': 'operator', 'owner': owner}]

        service = GasSettlementService({'host': '/tmp', 'port': 1, 'dbname': 'unused'},
                                       Mock(), queue=Queue())
        service.publisher = Mock(side_effect=ExecutionStoreError('execution_not_found'))
        service.operator = Mock(side_effect=GasSettlementError('gas_intent_unsigned'))
        service.cancel_unsigned = Mock(return_value={'cancelled': True,
            'releasedUsdMicros': 12000000, 'reason': 'unsigned_cancelled_intent'})
        result = service.sweep(limit=2)
        self.assertEqual((result['settled'], result['cancelled'], result['attention']),
                         (0, 2, 0))
        self.assertEqual([row['state'] for row in result['results']],
                         ['cancelled', 'cancelled'])
        self.assertEqual(service.cancel_unsigned.call_count, 2)
        service.operator = Mock(side_effect=GasSettlementError('gas_intent_not_reconciled'))
        service.publisher = Mock(side_effect=GasSettlementError('gas_receipt_pending'))
        service.cancel_unsigned.reset_mock()
        result = service.sweep(limit=2)
        self.assertEqual(result['cancelled'], 0)
        service.cancel_unsigned.assert_not_called()

    def test_bounded_claims_settle_or_remain_reserved_for_later_passes(self):
        class Queue:
            def next_pending(self, limit):
                assert limit == 3
                return [
                    {'cycleId': '0x' + '11' * 32, 'leg': 'publisher', 'owner': None},
                    {'cycleId': '0x' + '22' * 32, 'leg': 'operator', 'owner': '0x' + '33' * 20},
                    {'cycleId': '0x' + '44' * 32, 'leg': 'operator', 'owner': None},
                ]

        service = GasSettlementService({'host': '/tmp', 'port': 1, 'dbname': 'unused'},
                                       Mock(), queue=Queue())
        service.publisher = Mock(return_value={'grossCostWei': '5', 'spentUsdMicros': 1})
        service.operator = Mock(side_effect=GasSettlementError('gas_receipt_not_final'))
        result = service.sweep(limit=3)
        self.assertEqual((result['scanned'], result['settled'], result['attention']), (3, 1, 1))
        self.assertEqual([r['state'] for r in result['results']],
                         ['settled', 'pending', 'attention'])
        self.assertEqual(result['results'][1]['reason'], 'gas_receipt_not_final')
        self.assertEqual(result['results'][2]['reason'], 'gas_intent_owner_missing')
        service.publisher.assert_called_once()
        service.operator.assert_called_once()

    def test_ambiguous_or_reorged_receipt_never_counts_as_settled(self):
        class Queue:
            def next_pending(self, limit):
                return [{'cycleId': '0x' + '11' * 32, 'leg': 'publisher', 'owner': None}]

        service = GasSettlementService({'host': '/tmp', 'port': 1, 'dbname': 'unused'},
                                       Mock(), queue=Queue())
        for code in ('gas_receipt_reorganized', 'gas_intent_ambiguous',
                     'gas_publication_receipt_mismatch'):
            service.publisher = Mock(side_effect=GasSettlementError(code))
            result = service.sweep(limit=1)
            self.assertEqual(result['settled'], 0)
            self.assertEqual(result['results'][0]['state'], 'attention')
            self.assertEqual(result['results'][0]['reason'], code)

    def test_publisher_finality_witness_pending_keeps_full_claim(self):
        class Queue:
            def next_pending(self, limit):
                return [{'cycleId': '0x' + '11' * 32, 'leg': 'publisher', 'owner': None}]
        service = GasSettlementService({'host': '/tmp', 'port': 1, 'dbname': 'unused'},
                                       Mock(), queue=Queue())
        service.publisher = Mock(side_effect=GasBudgetError('gas_settlement_finality_missing'))
        result = service.sweep(limit=1)
        self.assertEqual((result['settled'], result['results'][0]['state']), (0, 'pending'))


if __name__ == '__main__':
    unittest.main()
