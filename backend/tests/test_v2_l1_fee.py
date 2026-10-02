"""The L1 data fee of a V2 transaction per stack (v2_l1_fee): the priced transaction, both sources, and failure as `unavailable`."""
import json
from pathlib import Path
import random
import sys
import unittest

from eth_abi import decode, encode
import rlp as reference_rlp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import Block, DataError  # noqa: E402
from v2_chains import chain  # noqa: E402
import v2_l1_fee as l1  # noqa: E402

BASE, ROBINHOOD, ARBITRUM = chain('base-8453'), chain('robinhood-4663'), chain('arbitrum-42161')
BLOCK = Block(123, '0x' + 'ab' * 32, 1_790_000_000)
ZAP = '0x' + 'd0' * 20
# NodeInterface answers from real Nitro nodes for the recorded Robinhood plan's call
# (position_plan_contract_fixtures.py --record --robinhood-rpc ... --arbitrum-rpc ...).
ANSWERS = Path(__file__).resolve().parent / 'fixtures/position-plan/nitro-l1-answers.json'


class Rpc:
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def request(self, method, params):
        self.calls.append((method, params))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class TransactionTests(unittest.TestCase):
    def test_rlp_matches_the_reference_implementation(self):
        generator = random.Random(4663)
        for item in (0, 1, 127, 128, 255, 256, 2**64, b'', b'\x00', b'\x7f', b'\x80', b'x' * 55, b'x' * 56,
                     b'y' * 1024, [], [b''], [0, [1, [2]]], [b'z' * 60, [b'a' * 70]]):
            with self.subTest(item=repr(item)[:40]):
                self.assertEqual(l1.rlp(item), reference_rlp.encode(item))
        for _ in range(200):
            item = [generator.getrandbits(generator.randrange(1, 260)), bytes(generator.getrandbits(8)
                                                                             for _ in range(generator.randrange(80)))]
            self.assertEqual(l1.rlp(item), reference_rlp.encode(item))
        with self.assertRaises(ValueError):
            l1.rlp(-1)

    def test_the_unsigned_eip1559_transaction(self):
        data = '0x' + 'ab' * 300
        raw = l1.unsigned_transaction(8453, ZAP, 10**18, data)
        self.assertEqual(raw[0], 2)
        fields = reference_rlp.decode(raw[1:])
        self.assertEqual([int.from_bytes(field, 'big') for field in fields[:5]],
                         [8453, l1.NONCE_PLACEHOLDER, l1.PRIORITY_FEE_PLACEHOLDER, l1.MAX_FEE_PLACEHOLDER,
                          l1.GAS_PLACEHOLDER])
        self.assertEqual(('0x' + fields[5].hex(), int.from_bytes(fields[6], 'big'), fields[7], fields[8]),
                         (ZAP, 10**18, bytes.fromhex('ab' * 300), []))


class SourceTests(unittest.TestCase):
    def test_op_stack_asks_the_oracle_in_the_planners_multicall(self):
        class Reads:
            def __init__(self):
                self.calls = []

            def add(self, target, fn, *args):
                self.calls.append((target, fn.calldata(*args)))
                return len(self.calls) - 1
        reads, transaction = Reads(), l1.unsigned_transaction(8453, ZAP, 0, '0x1234')
        slots = l1.op_reads(reads, transaction)
        self.assertEqual(reads.calls, [(l1.OP_GAS_PRICE_ORACLE, '0x49948e0e' + encode(['bytes'], [transaction]).hex()),
                                       (l1.OP_GAS_PRICE_ORACLE, '0xf1c7a58b' + encode(['uint256'],
                                                                                      [len(transaction)]).hex())])
        report = l1.op_result(BASE, BLOCK, [(7,), (11,)], slots, transaction)
        self.assertEqual(report, {'status': 'ok', 'source': 'op_gas_price_oracle', 'block': '123', 'weiRaw': '7',
                                  'upperBoundWeiRaw': '11', 'l1GasUnits': None, 'l2BaseFeeWei': None,
                                  'transactionBytes': len(transaction)})
        self.assertEqual(l1.op_result(BASE, BLOCK, [None, (11,)], slots, transaction)['status'], 'unavailable')

    def test_nitro_asks_node_interface_once(self):
        answer = '0x' + encode(['uint64', 'uint256', 'uint256'], [1000, 10**7, 3 * 10**10]).hex()
        for profile in (ROBINHOOD, ARBITRUM):
            rpc = Rpc(answer)
            report = l1.nitro_estimate(profile, rpc, BLOCK, ZAP, '0xabcd')
            self.assertEqual(report, {'status': 'ok', 'source': 'nitro_node_interface', 'block': '123',
                                      'weiRaw': str(1000 * 10**7), 'upperBoundWeiRaw': None, 'l1GasUnits': '1000',
                                      'l2BaseFeeWei': str(10**7), 'transactionBytes': None})
            (method, (call, tag)), = rpc.calls
            self.assertEqual((method, call['to'], tag), ('eth_call', l1.NODE_INTERFACE, BLOCK.tag))
            self.assertEqual(call['data'], '0x77d488a2' + encode(['address', 'bool', 'bytes'],
                                                                 [ZAP, False, b'\xab\xcd']).hex())

    def test_a_zero_answer_is_a_fee_of_zero_not_a_missing_one(self):
        """Robinhood prices no L1 data today: NodeInterface answers 0 L1 gas. That is
        evidence of a zero fee, reported as such with its source and block."""
        answer = '0x' + encode(['uint64', 'uint256', 'uint256'], [0, 32_224_000, 0]).hex()
        report = l1.nitro_estimate(ROBINHOOD, Rpc(answer), BLOCK, ZAP, '0x' + 'ab' * 600)
        self.assertEqual(report, {'status': 'ok', 'source': 'nitro_node_interface', 'block': '123', 'weiRaw': '0',
                                  'upperBoundWeiRaw': None, 'l1GasUnits': '0', 'l2BaseFeeWei': '32224000',
                                  'transactionBytes': None})
        self.assertEqual(l1.op_result(BASE, BLOCK, [(0,), (0,)], (0, 1), b'\x02'), {
            'status': 'ok', 'source': 'op_gas_price_oracle', 'block': '123', 'weiRaw': '0', 'upperBoundWeiRaw': '0',
            'l1GasUnits': None, 'l2BaseFeeWei': None, 'transactionBytes': 1})

    def test_a_node_that_cannot_answer_leaves_it_unavailable(self):
        for answer in ('0x', '0x1234', DataError('rpc_error'), DataError('http_503')):
            with self.subTest(answer=answer):
                report = l1.nitro_estimate(ROBINHOOD, Rpc(answer), BLOCK, ZAP, '0xabcd')
                self.assertEqual(report, l1.unavailable(ROBINHOOD, BLOCK))
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            l1.nitro_estimate(ROBINHOOD, Rpc(DataError('read_deadline_exceeded')), BLOCK, ZAP, '0xabcd')

    def test_selectors_are_the_published_ones(self):
        self.assertEqual((l1.GET_L1_FEE.selector, l1.GET_L1_FEE_UPPER_BOUND.selector,
                          l1.GAS_ESTIMATE_L1_COMPONENT.selector), ('0x49948e0e', '0xf1c7a58b', '0x77d488a2'))
        self.assertEqual(l1.SOURCES, {'op-stack': 'op_gas_price_oracle', 'arbitrum-nitro': 'nitro_node_interface'})
        self.assertEqual((BASE.stack, ROBINHOOD.stack, ARBITRUM.stack), ('op-stack', 'arbitrum-nitro', 'arbitrum-nitro'))


class RealNodeTests(unittest.TestCase):
    """The recorded Robinhood plan's own call, priced by real Nitro nodes at pinned blocks."""

    def replay(self, key, profile):
        answer = json.loads(ANSWERS.read_text())[key]
        call = answer['request']
        self.assertEqual((call['to'], call['data'][:10]), (l1.NODE_INTERFACE, l1.GAS_ESTIMATE_L1_COMPONENT.selector))
        to, creation, data = decode(['address', 'bool', 'bytes'], bytes.fromhex(call['data'][10:]))
        rpc = Rpc(answer['result'])
        report = l1.nitro_estimate(profile, rpc, BLOCK, to.lower(), '0x' + data.hex())
        (_, (sent, _)), = rpc.calls
        self.assertEqual((creation, sent['data']), (False, call['data']))  # the planner's call is the one priced
        gas, base_fee, _ = decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(answer['result'][2:]))
        return answer, report, gas, base_fee

    def test_the_own_robinhood_node_prices_no_l1_data_today(self):
        answer, report, gas, base_fee = self.replay('robinhood-4663', ROBINHOOD)
        self.assertEqual((answer['source'], answer['chainId']), ('the own Robinhood node', 4663))
        self.assertEqual((gas, report['status'], report['weiRaw'], report['l1GasUnits']), (0, 'ok', '0', '0'))
        self.assertGreater(base_fee, 0)
        self.assertEqual(report['l2BaseFeeWei'], str(base_fee))

    def test_arbitrum_one_prices_the_same_call(self):
        answer, report, gas, base_fee = self.replay('arbitrum-42161', ARBITRUM)
        self.assertEqual(answer['chainId'], 42161)
        self.assertGreater(gas, 0)
        self.assertGreater(base_fee, 0)
        self.assertEqual((report['status'], report['l1GasUnits'], report['l2BaseFeeWei'], report['weiRaw']),
                         ('ok', str(gas), str(base_fee), str(gas * base_fee)))


if __name__ == '__main__':
    unittest.main()
