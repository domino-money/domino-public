"""Auto-exit for the operator: the module's trigger rule, the band's removal minimums, the conversion leg and the log watch."""
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import Block, DataError
from v2_abi import event
from v2_autoexit import (Mandate, MandateWatcher, band_edges, conversion_legs, eligible, plan_exit, removal_minimums,
                         twap_exit_evidence, ModuleParameters)
from v2_chains import chain as profile
from v2_manifest import checked_deployment
from v2_observation import within_band
from v2_plan import LEG_V3_POOL, LEG_V4_POOL, twap_evidence
from v2_planner import amounts_for_liquidity
from v2_uniswap import PoolRef
from v4_math import Q96, sqrt_at_tick
from test_v2_manifest import manifest_document

ZERO = '0x' + '00' * 20
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
POOL4 = PoolRef(4, ZERO, USDG, 3000, 60)
POOL3 = PoolRef(3, WETH, USDG, 500, 10)
OWNER, VAULT = '0x' + '0b' * 20, '0x' + 'ca' * 20


def mandate(*, below=0, above=0, mode=1, convert_to=USDG, status=1, valid_until=2_000_000_000):
    return Mandate('0x' + '5a' * 32, OWNER, valid_until, 100, mode, status, VAULT, convert_to if mode else ZERO,
                   below, above, 3409682)


class TriggerTests(unittest.TestCase):
    def test_the_trigger_is_the_modules_comparison(self):
        # DominoAutoExit._authorize: TriggerNotReached when price > below and (above == 0 or price < above).
        below = mandate(below=Q96)
        self.assertTrue(below.triggered(Q96))
        self.assertTrue(below.triggered(Q96 - 1))
        self.assertFalse(below.triggered(Q96 + 1))
        above = mandate(above=2 * Q96)
        self.assertTrue(above.triggered(2 * Q96))
        self.assertFalse(above.triggered(2 * Q96 - 1))
        bracket = mandate(below=Q96, above=2 * Q96)
        self.assertEqual([bracket.triggered(p) for p in (Q96, Q96 + 1, 2 * Q96 - 1, 2 * Q96)], [True, False, False, True])
        self.assertFalse(mandate(below=Q96).triggered(0))
        self.assertFalse(mandate(above=0, below=0).triggered(Q96))

    def test_what_the_module_would_refuse_before_the_anchor(self):
        deployment = checked_deployment(manifest_document(), profile('base-8453'))
        module = deployment.auto_exit
        now = 1_900_000_000
        self.assertIsNone(eligible(mandate(), OWNER, module, deployment, now))
        self.assertEqual(eligible(mandate(status=2), OWNER, module, deployment, now), 'mandate_not_active')
        self.assertEqual(eligible(mandate(valid_until=now - 1), OWNER, module, deployment, now), 'mandate_expired')
        self.assertIsNone(eligible(mandate(valid_until=now), OWNER, module, deployment, now))  # still at validUntil
        self.assertEqual(eligible(mandate(), OWNER, ZERO, deployment, now), 'exit_module_not_enabled')
        self.assertEqual(eligible(mandate(), '0x' + 'ee' * 20, module, deployment, now), 'vault_owner_changed')


class BandTests(unittest.TestCase):
    def test_the_edges_cover_every_spot_the_band_admits(self):
        rng = random.Random(5)
        for _ in range(200):
            anchor = rng.randrange(2**80, 2**110)
            band = rng.choice((1, 50, 100, 1000))
            low, high = band_edges(anchor, band)
            self.assertTrue(low < anchor < high)
            # Just inside the true band on either side: within the edges.
            step = max(1, anchor // 10**7)
            for spot in (low + step, high - step):
                if within_band(anchor, spot, band):
                    self.assertTrue(low <= spot <= high)
            # Just outside the edges: refused by the band.
            self.assertFalse(within_band(anchor, low - step * 10, band))
            self.assertFalse(within_band(anchor, high + step * 10, band))

    def test_the_principal_meets_the_minimums_anywhere_in_the_band(self):
        liquidity, lower, upper = 10**20, -600, 600
        anchor = sqrt_at_tick(-60)
        band = 100
        min0, min1 = removal_minimums(liquidity, lower, upper, anchor, band)
        low, high = band_edges(anchor, band)
        self.assertGreater(min0, 0)
        self.assertGreater(min1, 0)
        for step in range(0, 101):
            spot = low + (high - low) * step // 100
            if not within_band(anchor, spot, band):
                continue
            amount0, amount1 = amounts_for_liquidity(spot, lower, upper, liquidity, False)
            self.assertGreaterEqual(amount0, min0)
            self.assertGreaterEqual(amount1, min1)
        self.assertEqual(removal_minimums(0, lower, upper, anchor, band), (0, 0))


class ExecutionTests(unittest.TestCase):
    def test_receiving_both_tokens_converts_nothing(self):
        self.assertEqual(conversion_legs(mandate(mode=0), POOL4), ())

    def test_a_conversion_sells_the_other_token_through_the_vaults_pool_filled_at_execution(self):
        leg, = conversion_legs(mandate(convert_to=USDG), POOL4)
        self.assertEqual((leg.kind, leg.token_in, leg.token_out, leg.amount_in, leg.min_amount_out),
                         (LEG_V4_POOL, ZERO, USDG, 0, 1))
        leg, = conversion_legs(mandate(convert_to=WETH), POOL3)
        self.assertEqual((leg.kind, leg.token_in, leg.token_out, leg.amount_in), (LEG_V3_POOL, USDG, WETH, 0))
        self.assertEqual(leg.data.hex(), USDG[2:] + '0001f4' + WETH[2:])
        with self.assertRaisesRegex(DataError, '^v2_mandate_invalid$'):
            conversion_legs(mandate(convert_to='0x' + 'ee' * 20), POOL4)

    def test_an_execution_is_planned_only_once_the_anchor_crossed(self):
        position = type('Position', (), {'liquidity': 10**18, 'tick_lower': -600, 'tick_upper': 600})()
        armed = mandate(below=Q96)
        self.assertIsNone(plan_exit(armed, POOL4, position, Q96 + 1, b'\x01', 10))
        plan = plan_exit(armed, POOL4, position, Q96, twap_evidence(600), 10)
        selector = '0x' + keccak(b'execute(bytes32,(bytes,(uint8,address,address,address,uint128,uint128,bytes)[],'
                                 b'uint128,uint128))')[:4].hex()
        self.assertEqual(plan.calldata[:10], selector)
        mandate_hash, execution = decode(['bytes32', '(bytes,(uint8,address,address,address,uint128,uint128,bytes)[],'
                                          'uint128,uint128)'], bytes.fromhex(plan.calldata[10:]))
        self.assertEqual('0x' + mandate_hash.hex(), armed.hash)
        self.assertEqual(execution[2:], removal_minimums(10**18, -600, 600, Q96, 100))

    def test_a_v3_exit_window_is_at_least_the_modules_minimum(self):
        self.assertEqual(twap_exit_evidence(ModuleParameters(300, 600), 120), (600, twap_evidence(600)))
        self.assertEqual(twap_exit_evidence(ModuleParameters(300, 600), 900), (900, twap_evidence(900)))


class WatchTests(unittest.TestCase):
    def test_registered_mandates_are_read_from_the_modules_deployment_block_on(self):
        deployment = checked_deployment(manifest_document(), profile('base-8453'))
        registered = event('IDominoAutoExit', 'MandateRegistered')
        start = deployment.start_block('autoExit')
        reads = []

        class Index:
            def request(self, method, params):
                reads.append(params[0])
                query = params[0]
                logs = []
                if int(query['fromBlock'], 16) <= start + 5 <= int(query['toBlock'], 16):
                    logs.append({'address': deployment.auto_exit, 'blockNumber': hex(start + 5),
                                 'topics': [registered.topic, '0x' + '5a' * 32, '0x' + encode(['address'], [OWNER]).hex(),
                                            '0x' + encode(['address'], [VAULT]).hex()],
                                 'data': '0x' + encode(['uint256', 'uint64'], [7, 2_000_000_000]).hex()})
                return logs
        watcher = MandateWatcher(deployment, max_blocks_per_read=4)
        hashes = watcher.scan(Index(), Block(start + 9, '0x' + '11' * 32, 1))
        self.assertEqual(hashes, ['0x' + '5a' * 32])
        self.assertEqual([(int(r['fromBlock'], 16), int(r['toBlock'], 16)) for r in reads],
                         [(start, start + 3), (start + 4, start + 7), (start + 8, start + 9)])
        self.assertTrue(all(r['address'] == deployment.auto_exit and r['topics'] == [registered.topic] for r in reads))
        # The next scan starts where this one ended.
        reads.clear()
        self.assertEqual(watcher.scan(Index(), Block(start + 10, '0x' + '12' * 32, 2)), hashes)
        self.assertEqual([(int(r['fromBlock'], 16), int(r['toBlock'], 16)) for r in reads], [(start + 10, start + 10)])
        # A mandate that can never execute again is not read again.
        watcher.forget('0x' + '5a' * 32)
        self.assertEqual(watcher.scan(Index(), Block(start + 11, '0x' + '13' * 32, 3)), [])

    def test_a_log_from_another_address_is_refused(self):
        deployment = checked_deployment(manifest_document(), profile('base-8453'))
        registered = event('IDominoAutoExit', 'MandateRegistered')

        class Index:
            def request(self, method, params):
                return [{'address': '0x' + 'ee' * 20, 'blockNumber': params[0]['fromBlock'],
                         'topics': [registered.topic, '0x' + '5a' * 32, '0x' + '00' * 32, '0x' + '00' * 32],
                         'data': '0x' + encode(['uint256', 'uint64'], [7, 1]).hex()}]
        start = deployment.start_block('autoExit')
        with self.assertRaisesRegex(DataError, '^v2_log_address_mismatch$'):
            MandateWatcher(deployment).scan(Index(), Block(start, '0x' + '11' * 32, 1))


if __name__ == '__main__':
    unittest.main()
