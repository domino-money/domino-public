"""v2_liquidity: sizing, prices and tick navigation. The swap itself is checked against the chain's
quoters on real pools in test_v2_position_plan_evm.py (test_the_local_swap_crosses_initialized_ticks_exactly)."""
from fractions import Fraction
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_liquidity as liq  # noqa: E402
from v4_math import MAX_SQRT, MIN_SQRT, Q96, amount_delta, next_price, sqrt_at_tick, tick_at_sqrt  # noqa: E402


class SizingTests(unittest.TestCase):
    def test_the_charge_for_the_sized_liquidity_never_exceeds_the_amounts(self):
        generator = random.Random(7)
        for _ in range(400):
            lower = generator.randrange(-80000, 80000) // 60 * 60
            upper = lower + 60 * generator.randrange(1, 2000)
            sqrt_a, sqrt_b = liq.range_prices(lower, upper)
            price = sqrt_at_tick(generator.randrange(lower - 3000, upper + 3000))
            amount0, amount1 = generator.randrange(1, 10**30), generator.randrange(1, 10**30)
            liquidity = liq.liquidity_for_amounts(price, sqrt_a, sqrt_b, amount0, amount1)
            charged = liq.amounts_for_liquidity(price, sqrt_a, sqrt_b, liquidity, True)
            self.assertLessEqual(charged[0], amount0)
            self.assertLessEqual(charged[1], amount1)
            paid = liq.amounts_for_liquidity(price, sqrt_a, sqrt_b, liquidity, False)
            self.assertTrue(0 <= charged[0] - paid[0] <= 1 and 0 <= charged[1] - paid[1] <= 1)

    def test_one_sided_ranges_use_one_token(self):
        sqrt_a, sqrt_b = liq.range_prices(600, 1200)
        below = sqrt_at_tick(0)
        self.assertEqual(liq.liquidity_for_amounts(below, sqrt_a, sqrt_b, 10**18, 0),
                         liq.liquidity_for_amount0(sqrt_a, sqrt_b, 10**18))
        self.assertEqual(liq.amounts_for_liquidity(below, sqrt_a, sqrt_b, 10**18, True)[1], 0)
        above = sqrt_at_tick(2000)
        self.assertEqual(liq.amounts_for_liquidity(above, sqrt_a, sqrt_b, 10**18, True)[0], 0)
        with self.assertRaisesRegex(liq.LiquidityError, 'pool_not_initialized'):
            liq.liquidity_for_amounts(0, sqrt_a, sqrt_b, 1, 1)

    def test_ranges(self):
        liq.check_range(-120, 60, 60)
        for lower, upper, spacing in ((-121, 60, 60), (60, 60, 60), (-887280, 0, 60), (0, 887280, 60), (0, 60, 0)):
            with self.subTest(lower=lower, upper=upper, spacing=spacing), self.assertRaises(liq.LiquidityError):
                liq.check_range(lower, upper, spacing)


class PriceTests(unittest.TestCase):
    def test_the_initial_price_round_trips_in_both_orientations(self):
        sqrt_price, tick = liq.initial_sqrt_price(Fraction('1.25'), True, 18, 18)
        self.assertEqual(tick, tick_at_sqrt(sqrt_price))
        price0, price1 = liq.human_price(sqrt_price, 18, 18)
        self.assertTrue(price0.startswith('1.24999999999') or price0 == '1.25')
        self.assertTrue(price1.startswith('0.8') or price1.startswith('0.79999999'))
        # One ETH (18 decimals) worth 2,500 USDC (6 decimals), the base being currency0.
        sqrt_price, _ = liq.initial_sqrt_price(Fraction(2500), True, 18, 6)
        self.assertEqual(liq.human_price(sqrt_price, 18, 6)[0][:4], '2499')
        # The same price stated with the other token as base.
        other, _ = liq.initial_sqrt_price(Fraction(1, 2500), False, 18, 6)
        self.assertLessEqual(abs(other - sqrt_price), 1)

    def test_the_band_is_the_sdks_ratios_after_slippage(self):
        """At step ±2 encodeSqrtRatioX96(token0Price × (1 ± s)) of the v3/v4 SDK:
        floor(sqrt(price × (1 ± s) × 2^192)); the steps between are its halves."""
        from math import isqrt
        for sqrt_price in (Q96, sqrt_at_tick(-198080), sqrt_at_tick(76013), MIN_SQRT + 5, MAX_SQRT - 5):
            for slippage in (10, 50, 500):
                price = Fraction(sqrt_price * sqrt_price, 1 << 192)
                for step, factor in ((-2, Fraction(10_000 - slippage, 10_000)), (2, Fraction(10_000 + slippage, 10_000)),
                                     (-1, Fraction(20_000 - slippage, 20_000)), (0, Fraction(1))):
                    expected = isqrt(int(price * factor * (1 << 192)))
                    expected = min(max(expected, MIN_SQRT + 1), MAX_SQRT - 1)
                    with self.subTest(sqrt_price=sqrt_price, slippage=slippage, step=step):
                        self.assertEqual(liq.band_sqrt_price(sqrt_price, slippage, step), expected)
        self.assertEqual(liq.band_sqrt_price(MIN_SQRT, 500, -2), MIN_SQRT + 1)
        self.assertEqual(liq.band_sqrt_price(MAX_SQRT - 1, 500, 2), MAX_SQRT - 1)
        for bad in ((0, 50, 0), (Q96, -1, 0), (Q96, 50, 3)):
            with self.assertRaisesRegex(liq.LiquidityError, 'band_invalid'):
                liq.band_sqrt_price(*bad)

    def test_f7s_new_pool_example(self):
        """F7 §2.6.5: ETH/USDG v4 on Robinhood (18 and 6 decimals) at 2,500 USDG per ETH,
        stated either way, is initSqrtPriceX96 3961408125713216879677197 at tick -198080."""
        for price, base_is_currency0 in ((Fraction(2500), True), (Fraction('0.0004'), False)):
            self.assertEqual(liq.initial_sqrt_price(price, base_is_currency0, 18, 6),
                             (3961408125713216879677197, -198080))

    def test_the_floor_square_root_is_exact(self):
        sqrt_price = liq.sqrt_price_for_ratio(Fraction(1))
        self.assertEqual(sqrt_price, Q96)
        self.assertEqual(liq.sqrt_price_for_ratio(Fraction(4)), 2 * Q96)
        value = liq.sqrt_price_for_ratio(Fraction(2))
        self.assertTrue(value * value <= 2 * Q96 * Q96 < (value + 1) * (value + 1))
        for bad in (Fraction(0), Fraction(-1), Fraction(1, 10**40), Fraction(10**40)):
            with self.subTest(ratio=bad), self.assertRaises(liq.LiquidityError):
                liq.sqrt_price_for_ratio(bad)
        self.assertTrue(MIN_SQRT <= liq.sqrt_price_for_ratio(Fraction(1, 10**37)) < MAX_SQRT)

    def test_decimal_text(self):
        self.assertEqual(liq.decimal_text(Fraction(3500)), '3500')
        self.assertEqual(liq.decimal_text(Fraction(1, 3)), '0.333333333333333333')
        self.assertEqual(liq.decimal_text(Fraction(10**30)), '1' + '0' * 30)
        self.assertEqual(liq.decimal_text(Fraction(1, 8)), '0.125')


class TickNavigationTests(unittest.TestCase):
    """TickBitmap.nextInitializedTickWithinOneWord, on hand-built words."""

    def source(self, ticks, spacing):
        words = {}
        for tick in ticks:
            compressed = liq.compress(tick, spacing)
            words[compressed >> 8] = words.get(compressed >> 8, 0) | 1 << (compressed & 0xff)
        source = liq.TickSource(words, {tick: 0 for tick in ticks})
        source.load_words = lambda positions: source.words.update({p: 0 for p in positions})
        return source

    def test_compress_rounds_toward_negative_infinity(self):
        self.assertEqual([liq.compress(t, 60) for t in (-61, -60, -1, 0, 59, 60)], [-2, -1, -1, 0, 0, 1])

    def test_searching_left_includes_the_current_tick(self):
        source = self.source([-120, 0, 600], 60)
        self.assertEqual(source.next_initialized(0, 60, True), (0, True))
        self.assertEqual(source.next_initialized(-1, 60, True), (-120, True))
        self.assertEqual(source.next_initialized(599, 60, True), (0, True))

    def test_searching_right_starts_after_the_current_tick(self):
        source = self.source([-120, 0, 600], 60)
        self.assertEqual(source.next_initialized(0, 60, False), (600, True))
        # One word at a time: from -120 the search ends at the edge of word -1 (tick -60),
        # and the next search, from there, finds tick 0 in word 0.
        self.assertEqual(source.next_initialized(-120, 60, False), (-60, False))
        self.assertEqual(source.next_initialized(-60, 60, False), (0, True))
        self.assertEqual(source.next_initialized(-121, 60, False), (-120, True))

    def test_an_empty_word_returns_its_edge_uninitialized(self):
        source = self.source([], 1)
        self.assertEqual(source.next_initialized(10, 1, True), (0, False))
        self.assertEqual(source.next_initialized(10, 1, False), (255, False))
        self.assertEqual(source.next_initialized(-10, 1, True), (-256, False))


class SwapTests(unittest.TestCase):
    def pool(self, liquidity=10**24, ticks=None):
        source = liq.TickSource({w: 0 for w in range(-3500, 3500)}, {})
        source.load_words = lambda positions: source.words.update({p: 0 for p in positions})
        return liq.PoolSnapshot(Q96, 0, liquidity, 60, (3000, 3000), ticks or source)

    def test_a_swap_inside_one_range_follows_the_price_formula(self):
        pool = self.pool()
        out = liq.simulate_exact_in(pool, True, 10**18)
        net = 10**18 * (10**6 - 3000) // 10**6
        after = next_price(Q96, 10**24, net, True, True)
        self.assertEqual(out.sqrt_price, after)
        self.assertEqual(out.amount_out, amount_delta(after, Q96, 10**24, 1, False))
        self.assertLess(out.sqrt_price, Q96)
        self.assertEqual(out.ticks_crossed, 0)
        self.assertLess(out.amount_out, 10**18)

    def test_a_pool_that_cannot_take_the_input_is_refused(self):
        with self.assertRaisesRegex(liq.LiquidityError, 'swap_exceeds_pool|swap_too_many_steps'):
            liq.simulate_exact_in(self.pool(liquidity=10), True, 10**30)

    def test_removing_a_position_thins_the_active_liquidity(self):
        pool = self.pool()
        thinner = pool.without_position(-600, 600, 10**23)
        self.assertEqual(thinner.liquidity, 10**24 - 10**23)
        self.assertEqual(pool.without_position(600, 1200, 10**23).liquidity, 10**24)
        self.assertLess(liq.simulate_exact_in(thinner, True, 10**20).amount_out,
                        liq.simulate_exact_in(pool, True, 10**20).amount_out)
        with self.assertRaisesRegex(liq.LiquidityError, 'pool_liquidity_inconsistent'):
            pool.without_position(-600, 600, 10**25)

    def test_the_fee_growth_a_swap_adds_inside_a_range(self):
        """v4-core Pool.swap: the protocol's part of the step's fee first
        ((amountIn + fee) * protocol / 1e6), then lpFee * 2**128 / liquidity."""
        amount, fee = 10**18, 10**18 * 3000 // 10**6
        lp = self.pool()
        lp.protocol_pips = (0, 0)
        out = liq.simulate_exact_in(lp, True, amount, track=(-600, 600))
        self.assertEqual((out.zero_for_one, out.fee_growth_in_range), (True, fee * liq.Q128 // 10**24))
        self.assertEqual(liq.simulate_exact_in(lp, True, amount, track=(600, 1200)).fee_growth_in_range, 0)
        self.assertEqual(liq.simulate_exact_in(lp, True, amount).fee_growth_in_range, 0)
        # A 0.1% protocol fee zeroForOne makes the total 3000 + 1000 - 3 = 3997 pips.
        shared = liq.PoolSnapshot(Q96, 0, 10**24, 60, (3997, 3000), lp.ticks, (1000, 0))
        total = 10**18 * 3997 // 10**6 + (1 if 10**18 * 3997 % 10**6 else 0)
        to_protocol = 10**18 * 1000 // 10**6
        out = liq.simulate_exact_in(shared, True, amount, track=(-600, 600))
        self.assertEqual(out.fee_growth_in_range, (total - to_protocol) * liq.Q128 // 10**24)
        with self.assertRaisesRegex(liq.LiquidityError, 'fee_growth_unsupported'):
            liq.simulate_exact_in(self.pool(), True, amount, track=(-600, 600))  # v3: no protocol split


if __name__ == '__main__':
    unittest.main()
