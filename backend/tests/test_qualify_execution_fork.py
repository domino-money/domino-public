"""Offline checks of the fork sandwich tool's arithmetic and its source guard."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError
import qualify_execution_fork as q


class LiquidityMathTests(unittest.TestCase):
    def test_amounts_and_liquidity_round_trip_inside_the_range(self):
        lower, upper = q.sqrt_at_tick(-193_600), q.sqrt_at_tick(-193_200)
        price = q.sqrt_at_tick(-193_400)
        liquidity = 10**15
        amount0, amount1 = q.amounts_for_liquidity(liquidity, price, lower, upper)
        self.assertGreater(amount0, 0)
        self.assertGreater(amount1, 0)
        back = q.liquidity_for_amounts(amount0, amount1, price, lower, upper)
        # Floors on both directions: never more liquidity than the amounts fund.
        self.assertLessEqual(back, liquidity)
        self.assertGreater(back, liquidity * 999_999 // 1_000_000)

    def test_outside_the_range_the_position_is_single_sided(self):
        lower, upper = q.sqrt_at_tick(-100), q.sqrt_at_tick(100)
        below = q.amounts_for_liquidity(10**12, q.sqrt_at_tick(-500), lower, upper)
        above = q.amounts_for_liquidity(10**12, q.sqrt_at_tick(500), lower, upper)
        self.assertEqual(below[1], 0)
        self.assertGreater(below[0], 0)
        self.assertEqual(above[0], 0)
        self.assertGreater(above[1], 0)

    def test_sqrt_price_is_monotone_in_the_tick(self):
        ticks = (-887_000, -193_400, -1, 0, 1, 193_400, 887_000)
        prices = [q.sqrt_at_tick(t) for t in ticks]
        self.assertEqual(prices, sorted(prices))
        self.assertEqual(q.sqrt_at_tick(0), q.Q96)

    def test_quote_value_prices_currency0_by_the_squared_sqrt_price(self):
        # sqrt price of 2 * 2**96 means one unit of currency0 is worth four of currency1.
        self.assertEqual(q.quote_value(10, 3, 2 * q.Q96), 43)
        self.assertEqual(q.quote_value(0, 7, 5 * q.Q96), 7)


class SourceGuardTests(unittest.TestCase):
    def test_only_a_loopback_http_port_is_accepted_as_a_source(self):
        q.Loopback('http://127.0.0.1:18547')
        for url in ('https://127.0.0.1:18547', 'http://localhost:18547', 'http://127.0.0.1',
                    'http://10.0.0.5:8547', 'https://rpc.domino.money/token/'):
            with self.assertRaises(DataError, msg=url):
                q.Loopback(url)

    def test_the_error_map_names_the_vault_and_helper_refusals(self):
        for name in ('InvalidPrice()', 'InvalidAmount()', 'InvalidExecution()', 'InvalidObservation()'):
            self.assertIn(name, q.ERRORS.values())
        self.assertEqual(len(q.ERRORS), len(set(q.ERRORS.values())))


if __name__ == '__main__':
    unittest.main()
