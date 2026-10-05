"""Offline checks of the S1 plan fork qualification: its source guard, its ranges, and the receipt-to-plan check."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qualify_position_plan_fork as q  # noqa: E402
import v2_fee_rule as fee_rule  # noqa: E402

OWNER = '0x' + '11' * 20
USD = '0x' + '22' * 20
TKA = '0x' + '33' * 20
INTENT = '0x' + 'ab' * 32


def topic(value):
    return '0x' + value.removeprefix('0x').rjust(64, '0')


def log(name, topics, types, values):
    return {'topics': [q.TOPICS[name], *topics], 'data': '0x' + encode(types, values).hex()}


def body_and_receipt():
    """A create with one leg: 10**6 USD sold for 2 * 10**6 TKA, the fee on the input."""
    leg = {'tokenIn': USD, 'tokenOut': TKA, 'amountInRaw': str(10**6), 'expectedOutRaw': str(2 * 10**6),
           'minAmountOutRaw': str(19 * 10**5)}
    fee = fee_rule.fee_of(fee_rule.swapped_amount([fee_rule.LegTokens(USD, TKA, 10**6)], [2 * 10**6], USD), 65)
    body = {'action': 'create', 'owner': OWNER, 'intentHash': INTENT, 'legs': [leg],
            'fee': {'token': USD, 'amountRaw': str(fee)}, 'minimums': {'liquidity': '900'},
            'expected': {'liquidity': '1000', 'returned': [{'token': TKA, 'amountRaw': '5'}]}}
    receipt = {'status': '0x1', 'logs': [
        log('SwapLegExecuted', [topic('0x4'), topic(USD), topic(TKA)], ['address', 'uint256', 'uint256'],
            [q.ZERO, 10**6, 2 * 10**6]),
        log('FeeCharged', [topic('0x1'), topic(USD), topic(OWNER)], ['uint256', 'bytes32'],
            [fee, bytes.fromhex(INTENT[2:])]),
        log('Refunded', [topic(OWNER), topic(TKA)], ['uint256'], [5]),
        log('PositionActionExecuted', [topic('0x1'), topic(OWNER), topic(hex(77))], ['uint256', 'uint128', 'bytes32'],
            [0, 1000, bytes.fromhex(INTENT[2:])])]}
    return body, receipt


class SourceGuardTests(unittest.TestCase):
    def test_only_a_loopback_port_is_an_upstream(self):
        for url in ('http://127.0.0.1:18547', 'http://127.0.0.1:18547/'):
            self.assertEqual(q.loopback(url), 'http://127.0.0.1:18547')
        for url in ('https://127.0.0.1:18547', 'http://localhost:18547', 'http://10.0.0.1:8545',
                    'http://user:pass@127.0.0.1:18547', 'http://127.0.0.1:18547/token/', 'http://127.0.0.1',
                    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'https://rpc.domino.money/abc/', '', None):
            with self.subTest(url=url), self.assertRaisesRegex(q.QualificationError, 'upstream_must_be_loopback'):
                q.loopback(url)

    def test_the_command_refuses_a_remote_upstream_before_anything_starts(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()) as out:
            code = q.main(['--upstream', 'https://rpc.domino.money/token/', '--out', str(Path(folder) / 'r.json')])
        self.assertEqual((code, json.loads(out.getvalue())['reason']), (2, 'upstream_must_be_loopback'))

    def test_a_report_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()) as out:
            report = Path(folder) / 'r.json'
            report.write_text('{}')
            code = q.main(['--upstream', 'http://127.0.0.1:18547', '--out', str(report)])
            self.assertEqual(report.read_text(), '{}')
        self.assertEqual((code, json.loads(out.getvalue())['reason']), (2, 'report_exists'))


class ChainTableTests(unittest.TestCase):
    def test_each_chains_pools_belong_to_its_profile_and_manifest(self):
        from v2_chains import default_registry
        self.assertEqual(set(q.CHAINS), {'robinhood-4663', 'base-8453', 'arbitrum-42161'})
        for key, pools in q.CHAINS.items():
            with self.subTest(chain=key):
                profile = default_registry().chain(key)
                self.assertTrue(pools.manifest.is_file())
                self.assertIn(key, pools.manifest.parent.name)
                self.assertEqual(pools.wrapped, profile.wrappedNative.address.lower())
                self.assertIn(pools.stable, [c.address.lower() for c in profile.chargeCurrencies])
                for pool in (pools.weth_pool, pools.eth_pool, pools.outside_pool):
                    self.assertLess(int(pool['currency0'], 16), int(pool['currency1'], 16))
                    self.assertEqual((pool['dex'], pool['hooks']), (4, q.ZERO))
                self.assertEqual(pools.eth_pool['currency0'], q.ZERO)
                self.assertEqual({pools.weth_pool['currency0'], pools.weth_pool['currency1']}, {pools.wrapped, pools.stable})
                self.assertEqual({pools.outside_pool['currency0'], pools.outside_pool['currency1']},
                                 {pools.outside, pools.stable})
        # The ids read on each chain: PONS/USDG, Base's USDC/cbBTC and ETH/USDC, Arbitrum's ARB/USDC and WETH/USDC.
        self.assertEqual(q.pool_id(q.CHAINS['robinhood-4663'].outside_pool),
                         '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a')
        self.assertEqual(q.pool_id(q.CHAINS['base-8453'].outside_pool),
                         '0x12d76c5c8ec8edffd3c143995b0aa43fe44a6d71eb9113796272909e54b8e078')
        self.assertEqual(q.pool_id(q.CHAINS['base-8453'].eth_pool),
                         '0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9')
        self.assertEqual(q.pool_id(q.CHAINS['arbitrum-42161'].outside_pool),
                         '0xb2aec80e582cec4ffceacfcd01eef7dc31d4d0f3d8241843ffafbc4623d2d517')
        self.assertEqual(q.pool_id(q.CHAINS['arbitrum-42161'].weth_pool),
                         '0xfc7b3ad139daaf1e9c3637ed921c154d1b04286f8a82b805a6c352da57028653')


class WarmRetryTests(unittest.TestCase):
    class Planner:
        def __init__(self, *answers):
            self.answers, self.asked = list(answers), 0

        def plan(self, request, owner):
            self.asked += 1
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

    def test_an_expired_first_plan_is_asked_once_more_and_recorded(self):
        planner, entry = self.Planner(q.PlanError('preview_expired'), {'plan': 2}), {}
        self.assertEqual(q.warm_plan(planner, {}, OWNER, entry), {'plan': 2})
        self.assertEqual((planner.asked, set(entry['warmRetry'])), (2, {'firstAttemptSeconds'}))

    def test_any_other_refusal_or_a_second_expiry_stands(self):
        for answers in ((q.PlanError('position_plan_no_route'),),
                        (q.PlanError('preview_expired'), q.PlanError('preview_expired'))):
            with self.subTest(answers=answers):
                planner = self.Planner(*answers)
                with self.assertRaises(q.PlanError):
                    q.warm_plan(planner, {}, OWNER, {})
                self.assertEqual(planner.asked, len(answers))
        planner, entry = self.Planner({'plan': 1}), {}
        q.warm_plan(planner, {}, OWNER, entry)
        self.assertEqual((planner.asked, entry), (1, {}))


class RangeTests(unittest.TestCase):
    def test_a_range_is_on_the_spacing_and_holds_the_tick(self):
        for tick, spacing, width in ((-197304, 4, 2000), (0, 1, 10), (75001, 60, 1800), (-5, 200, 1)):
            lower, upper = q.around(tick, spacing, width)
            with self.subTest(tick=tick, spacing=spacing):
                self.assertEqual((lower % spacing, upper % spacing), (0, 0))
                self.assertLessEqual(lower, tick - width)
                self.assertGreaterEqual(upper, tick + width)
                self.assertLess(upper - lower, 2 * width + 2 * spacing)


class ReceiptCheckTests(unittest.TestCase):
    def test_a_receipt_that_is_the_plan_passes_and_names_its_position(self):
        body, receipt = body_and_receipt()
        self.assertEqual(q.check_receipt(body, receipt), ([], 77))

    def test_each_departure_from_the_plan_is_named(self):
        cases = {
            'reverted': lambda b, r: r.update(status='0x0'),
            'intent_hash': lambda b, r: b.update(intentHash='0x' + 'cd' * 32),
            'leg_output_as_planned': lambda b, r: b['legs'][0].update(expectedOutRaw=str(2 * 10**6 + 1)),
            'leg_input': lambda b, r: b['legs'][0].update(amountInRaw=str(10**6 - 1)),
            'fee_as_planned': lambda b, r: b['fee'].update(amountRaw='1'),
            'liquidity_as_planned': lambda b, r: b['expected'].update(liquidity='999'),
            'liquidity_minimum': lambda b, r: b['minimums'].update(liquidity='1001'),
            'returned_as_planned': lambda b, r: b['expected'].update(returned=[]),
            'owner': lambda b, r: b.update(owner='0x' + '44' * 20),
            'action': lambda b, r: b.update(action='increase'),
        }
        for name, change in cases.items():
            body, receipt = body_and_receipt()
            change(body, receipt)
            with self.subTest(check=name):
                self.assertIn(name, q.check_receipt(body, receipt)[0])

    def test_what_the_receipt_delivered_is_recorded_beside_the_plan(self):
        body, receipt = body_and_receipt()
        self.assertEqual(q.observed(receipt), {'legOutputsRaw': [str(2 * 10**6)], 'feeRaw': body['fee']['amountRaw'],
                                               'liquidity': '1000', 'returned': {TKA: '5'}})
        # A leg that delivered less than quoted: its output, the liquidity and the refund are the receipt's own.
        short = {**receipt, 'logs': [
            log('SwapLegExecuted', [topic('0x4'), topic(USD), topic(TKA)], ['address', 'uint256', 'uint256'],
                [q.ZERO, 10**6, 195 * 10**4]),
            receipt['logs'][1], log('Refunded', [topic(OWNER), topic(TKA)], ['uint256'], [3]),
            log('PositionActionExecuted', [topic('0x1'), topic(OWNER), topic(hex(77))],
                ['uint256', 'uint128', 'bytes32'], [0, 990, bytes.fromhex(INTENT[2:])])]}
        failed, _ = q.check_receipt(body, short)
        self.assertEqual(failed, ['leg_output_as_planned', 'liquidity_as_planned', 'returned_as_planned'])
        self.assertEqual(q.observed(short), {'legOutputsRaw': [str(195 * 10**4)], 'feeRaw': body['fee']['amountRaw'],
                                             'liquidity': '990', 'returned': {TKA: '3'}})

    def test_an_exit_without_legs_charges_nothing_and_the_manager_pays(self):
        body, receipt = body_and_receipt()
        body.update(action='exit', legs=[], fee={'token': q.ZERO, 'amountRaw': '0'})
        receipt['logs'] = [entry for entry in receipt['logs'] if entry['topics'][0] == q.TOPICS['PositionActionExecuted']]
        receipt['logs'][0]['topics'][1] = topic('0x4')
        self.assertEqual(q.check_receipt(body, receipt), ([], 77))
        receipt['logs'].append(log('Refunded', [topic(OWNER), topic(TKA)], ['uint256'], [5]))
        self.assertIn('exit_paid_by_the_manager', q.check_receipt(body, receipt)[0])


if __name__ == '__main__':
    unittest.main()
