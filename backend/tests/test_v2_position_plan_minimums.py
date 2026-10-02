"""The plan's minimums at the worst price within ±s (contract 1.0.0-rc.2, owner 2 Oct 2026), as properties.

v2_position_plan_rules.plan_minimums is the one definition: the planner sets
the minimums with it and the answer's checks (and runtime.mjs's port)
recompute them. The EVM tests execute plans at the band's points on the zap.
"""
from fractions import Fraction
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_fee_rule as fee_rule  # noqa: E402
import v2_liquidity as liq  # noqa: E402
from v2_position_plan_rules import plan_minimums  # noqa: E402
from v4_math import Q96, sqrt_at_tick  # noqa: E402

ZERO = '0x' + '00' * 20
A, B, WETH = '0x' + 'aa' * 20, '0x' + 'bb' * 20, '0x' + '42' * 20
RANKS = fee_rule.ranks_from_mapping({B: 1})


def minimums(action='create', *, slippage=50, inputs=(), legs=(), ticks=(-100, 100), mint=Q96, **kwargs):
    return plan_minimums(action=action, slippage=slippage, currencies=(A, B), wrapped=WETH, wraps=False,
                         inputs=list(inputs), legs=list(legs), ranks=RANKS, ticks=ticks, mint_sqrt=mint, **kwargs)


class MintTests(unittest.TestCase):
    def test_the_minimum_is_what_the_amounts_buy_at_the_worse_edge(self):
        generator = random.Random(283)
        for _ in range(200):
            width = generator.choice((10, 100, 1000, 10000))
            center = sqrt_at_tick(generator.randrange(-width + 1, width))
            amounts = generator.randrange(1, 10**24), generator.randrange(1, 10**24)
            slippage = generator.choice((10, 50, 200, 500))
            result = minimums(slippage=slippage, inputs=[{'token': A, 'amount': str(amounts[0])},
                                                         {'token': B, 'amount': str(amounts[1])}],
                              ticks=(-width, width), mint=center)
            sqrt_a, sqrt_b = liq.range_prices(-width, width)
            buys = lambda price: liq.liquidity_for_amounts(price, sqrt_a, sqrt_b, *amounts)  # noqa: E731
            edges = [liq.band_sqrt_price(center, slippage, step) for step in (-2, 2)]
            self.assertEqual(result['liquidity'], min(buys(price) for price in edges))
            self.assertEqual(result['mintBand'], tuple(edges))
            # Anywhere inside the band the same amounts buy at least the minimum.
            for _ in range(5):
                inside = generator.randrange(edges[0], edges[1] + 1)
                self.assertGreaterEqual(buys(inside), result['liquidity'])

    def test_legs_count_at_their_minimum_and_the_fee_at_those_outputs(self):
        leg = {'tokenIn': A, 'tokenOut': B, 'amountIn': str(4 * 10**20), 'minAmountOut': str(3 * 10**20)}
        result = minimums(inputs=[{'token': A, 'amount': str(10**21)}], legs=[leg])
        held = (10**21 - 4 * 10**20, 3 * 10**20 - fee_rule.fee_of(3 * 10**20, 65))  # B ranks: an output fee
        sqrt_a, sqrt_b = liq.range_prices(-100, 100)
        self.assertEqual(result['liquidity'], min(liq.liquidity_for_amounts(liq.band_sqrt_price(Q96, 50, step), sqrt_a,
                                                                            sqrt_b, *held) for step in (-2, 2)))

    def test_native_eth_counts_as_weth_on_a_v3_weth_pool(self):
        common = dict(action='create', slippage=50, currencies=(WETH, B), wrapped=WETH, legs=[], ranks=RANKS,
                      ticks=(-100, 100), mint_sqrt=Q96)
        native = plan_minimums(wraps=True, inputs=[{'token': ZERO, 'amount': '1000000'},
                                                   {'token': B, 'amount': '1000000'}], **common)
        wrapped = plan_minimums(wraps=False, inputs=[{'token': WETH, 'amount': '1000000'},
                                                     {'token': B, 'amount': '1000000'}], **common)
        self.assertEqual(native['liquidity'], wrapped['liquidity'])
        self.assertGreater(native['liquidity'], 0)

    def test_a_narrow_range_now_tolerates_the_slippage_as_a_price_move(self):
        """rc.1 took floor(L × (1 − s)): a ±1% range reverted on a 0.005% move.
        Now a move of the full s executes, whatever the range."""
        for width in (10, 100, 1000):
            sqrt_a, sqrt_b = liq.range_prices(-width, width)
            amounts = liq.amounts_for_liquidity(Q96, sqrt_a, sqrt_b, 10**24, True)
            result = minimums(inputs=[{'token': A, 'amount': str(amounts[0])}, {'token': B, 'amount': str(amounts[1])}],
                              ticks=(-width, width))
            for step in (-2, 2):
                price = liq.band_sqrt_price(Q96, 50, step)
                self.assertGreaterEqual(liq.liquidity_for_amounts(price, sqrt_a, sqrt_b, *amounts), result['liquidity'])
            self.assertLess(result['liquidity'], 10**24 * (10_000 - 50) // 10_000)


class RemovalTests(unittest.TestCase):
    def test_each_token_at_the_edge_where_it_is_smallest(self):
        generator = random.Random(301)
        for _ in range(200):
            width = generator.choice((10, 100, 1000))
            center = sqrt_at_tick(generator.randrange(-2 * width, 2 * width))
            remove, slippage = generator.randrange(1, 10**24), generator.choice((10, 50, 500))
            result = plan_minimums(action='exit', slippage=slippage, currencies=(A, B), wrapped=WETH, wraps=False,
                                   inputs=[], legs=[], ranks=RANKS, ticks=(-width, width), pool_sqrt=center,
                                   old_ticks=(-width, width), remove=remove, fees=(5, 7))
            sqrt_a, sqrt_b = liq.range_prices(-width, width)
            lower, upper = (liq.band_sqrt_price(center, slippage, step) for step in (-2, 2))
            self.assertEqual(result['amount0Removed'], liq.amounts_for_liquidity(upper, sqrt_a, sqrt_b, remove, False)[0])
            self.assertEqual(result['amount1Removed'], liq.amounts_for_liquidity(lower, sqrt_a, sqrt_b, remove, False)[1])
            self.assertEqual((result['liquidity'], result['removalBand'], result['mintBand']), (remove, (lower, upper), None))
            for _ in range(5):
                paid = liq.amounts_for_liquidity(generator.randrange(lower, upper + 1), sqrt_a, sqrt_b, remove, False)
                self.assertGreaterEqual(paid[0], result['amount0Removed'])
                self.assertGreaterEqual(paid[1], result['amount1Removed'])

    def test_a_change_of_range_to_the_same_range_keeps_its_liquidity(self):
        """The withdrawal shifts with the price: the same range is re-minted at
        each point of the band from what it paid there, so the bound stays at
        the liquidity removed (less rounding), not at a worst case of both tokens."""
        for width in (10, 100, 1000):
            remove = 10**24
            result = plan_minimums(action='changeRange', slippage=50, currencies=(A, B), wrapped=WETH, wraps=False,
                                   inputs=[], legs=[], ranks=RANKS, ticks=(-width, width), mint_sqrt=Q96,
                                   pool_sqrt=Q96, old_ticks=(-width, width), remove=remove, fees=(0, 0))
            self.assertLessEqual(result['liquidity'], remove)
            self.assertGreater(Fraction(result['liquidity'], remove), Fraction(999_999, 1_000_000))


if __name__ == '__main__':
    unittest.main()
