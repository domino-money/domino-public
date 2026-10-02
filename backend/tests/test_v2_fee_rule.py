"""The Python fee rule against F1b's own vectors (contracts/test/v2/fees/DominoFeeRules.t.sol).

Every table row, place and tie of DominoFeeRulesTest is restated here with the
same tokens, ranks and expected (token, source); the swapped-amount, rounding
and terms cases too. The same rule is run against the deployed zap's bytecode
in test_v2_position_plan_evm.py (FeeRuleParityEvmTests), where a wrong token
makes the zap revert FeeMismatch.
"""
import random
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v2_chains import chain  # noqa: E402
from v2_fee_rule import (FEE_ASSISTED_SWAP_BPS, FROM_FALLBACK, FROM_HOP, FROM_INPUT, FROM_OUTPUT, ZERO,  # noqa: E402
                         FeeRuleError, LegTokens, assisted_swap_fee, assisted_swap_fee_token, assisted_swap_terms,
                         fee_of, ranks_from_mapping, ranks_from_profile, swapped_amount, terms_match)

# DominoFeeRulesTest's constants.
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
ETH = ZERO
USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'  # Base USDC
TSLA = '0x' + '00' * 18 + '7514'
MANY = '0x' + '00' * 18 + '3a27'
NVDA = '0x' + '00' * 18 + '47da'
ROBINHOOD = ranks_from_mapping({USDG: 1, ETH: 2, WETH: 2})


def legs(*pairs, amount=100):
    return [LegTokens(a, b, amount) for a, b in pairs]


class FeeTokenTableTests(unittest.TestCase):
    """DominoFeeRulesTest, test by test."""

    def check(self, route, token, source, ranks=ROBINHOOD):
        self.assertEqual(assisted_swap_fee_token(route, ranks), (token, source))

    def test_the_input_when_it_is_a_charge(self):
        self.check(legs((USDG, MANY)), USDG, FROM_INPUT)
        self.check(legs((ETH, MANY)), ETH, FROM_INPUT)
        self.check(legs((WETH, MANY)), WETH, FROM_INPUT)

    def test_the_output_when_only_it_is_a_charge(self):
        self.check(legs((MANY, USDG)), USDG, FROM_OUTPUT)
        self.check(legs((MANY, WETH)), WETH, FROM_OUTPUT)
        self.check(legs((MANY, ETH)), ETH, FROM_OUTPUT)

    def test_a_route_hop_when_neither_end_is_a_charge(self):
        self.check(legs((TSLA, USDG), (USDG, MANY)), USDG, FROM_HOP)
        self.check(legs((TSLA, WETH), (WETH, MANY)), WETH, FROM_HOP)

    def test_the_input_token_when_no_charge_currency_appears(self):
        self.check(legs((TSLA, MANY)), TSLA, FROM_FALLBACK)
        self.check(legs((TSLA, MANY), (NVDA, MANY)), TSLA, FROM_FALLBACK)
        self.check(legs((NVDA, TSLA), (TSLA, MANY)), NVDA, FROM_FALLBACK)

    def test_the_better_rank_wins_over_an_earlier_place(self):
        self.check(legs((WETH, USDG)), USDG, FROM_OUTPUT)
        self.check(legs((ETH, USDG)), USDG, FROM_OUTPUT)
        self.check(legs((WETH, USDG), (USDG, MANY)), USDG, FROM_HOP)

    def test_equal_ranks_go_to_the_earlier_place_then_the_earlier_leg(self):
        self.check(legs((ETH, WETH)), ETH, FROM_INPUT)
        self.check(legs((WETH, ETH)), WETH, FROM_INPUT)
        self.check(legs((TSLA, WETH), (WETH, MANY), (NVDA, ETH)), ETH, FROM_OUTPUT)
        self.check(legs((TSLA, WETH), (WETH, MANY), (NVDA, ETH), (ETH, MANY)), WETH, FROM_HOP)
        self.check(legs((TSLA, WETH), (NVDA, ETH)), WETH, FROM_OUTPUT)
        self.check(legs((TSLA, ETH), (NVDA, WETH)), ETH, FROM_OUTPUT)
        self.check(legs((WETH, MANY), (ETH, TSLA)), WETH, FROM_INPUT)

    def test_places_follow_the_leg_order(self):
        self.check(legs((USDG, MANY), (TSLA, USDG)), USDG, FROM_INPUT)
        self.check(legs((MANY, WETH), (WETH, TSLA)), WETH, FROM_HOP)
        self.check(legs((WETH, TSLA), (MANY, WETH)), WETH, FROM_INPUT)

    def test_base_and_arbitrum_charge_usdc_first(self):
        base = ranks_from_mapping({USDC: 1, ETH: 2, '0x4200000000000000000000000000000000000006': 2})
        self.check(legs((ETH, USDC)), USDC, FROM_OUTPUT, base)
        self.check(legs((USDG, MANY)), USDG, FROM_FALLBACK, base)

    def test_no_swap_has_no_fee_token(self):
        with self.assertRaisesRegex(FeeRuleError, 'fee_rule_empty_route'):
            assisted_swap_fee_token([], ROBINHOOD)

    def test_the_f7_app_vectors(self):
        """F7 §2.8's table, which is F1b's with Robinhood's ranks."""
        rows = [((('USDG', 'MANY'),), 'USDG', FROM_INPUT), ((('MANY', 'USDG'),), 'USDG', FROM_OUTPUT),
                ((('TSLA', 'USDG'), ('USDG', 'MANY')), 'USDG', FROM_HOP), ((('TSLA', 'MANY'),), 'TSLA', FROM_FALLBACK),
                ((('WETH', 'USDG'),), 'USDG', FROM_OUTPUT), ((('ETH', 'MANY'),), 'ETH', FROM_INPUT),
                ((('ETH', 'WETH'),), 'ETH', FROM_INPUT),
                ((('TSLA', 'WETH'), ('WETH', 'MANY'), ('NVDA', 'ETH')), 'ETH', FROM_OUTPUT)]
        names = {'USDG': USDG, 'MANY': MANY, 'TSLA': TSLA, 'WETH': WETH, 'ETH': ETH, 'NVDA': NVDA}
        for route, token, source in rows:
            with self.subTest(route=route):
                self.check(legs(*[(names[a], names[b]) for a, b in route]), names[token], source)


def model(ranks, route):
    """DominoFeeRulesTest._model: every (place, leg, side) in scan order, the
    first with the lowest nonzero rank."""
    best, best_place, best_rank = None, None, 0
    rows = [(leg.token_in, leg.token_out) for leg in route]
    for place in (1, 2, 3):
        for i, (tin, tout) in enumerate(rows):
            for side in (0, 1):
                token = tin if side == 0 else tout
                hop = (any(rows[j][1] == token for j in range(i)) if side == 0
                       else any(rows[j][0] == token for j in range(i + 1, len(rows))))
                at = 3 if hop else (1 if side == 0 else 2)
                rank = ranks(token)
                if at == place and rank != 0 and (best_rank == 0 or rank < best_rank):
                    best, best_place, best_rank = token, place, rank
    if best_rank == 0:
        best, best_place = rows[0][0], 4
    return best, best_place


class FeeTokenModelTests(unittest.TestCase):
    def test_the_rule_matches_f1b_reference_model_over_random_routes(self):
        tokens = [USDG, ETH, WETH, TSLA, MANY, NVDA]
        generator = random.Random(20261002)
        for _ in range(2000):
            ranks = ranks_from_mapping({token: generator.randrange(4) for token in tokens})
            count = 1 + generator.randrange(5)
            route = []
            for _ in range(count):
                a, b = generator.sample(tokens, 2)
                route.append(LegTokens(a, b, 100))
            self.assertEqual(assisted_swap_fee_token(route, ranks), model(ranks, route))


class FeeAmountTests(unittest.TestCase):
    def test_the_swapped_amount_is_what_entered_or_what_came_out(self):
        route = legs((USDG, MANY), (USDG, TSLA))
        route[1] = LegTokens(USDG, TSLA, 50)
        self.assertEqual(swapped_amount(route, [7, 9], USDG), 150)
        self.assertEqual(swapped_amount(legs((MANY, USDG), (TSLA, USDG)), [70, 30], USDG), 100)
        hop = [LegTokens(TSLA, USDG, 100), LegTokens(USDG, MANY, 1)]
        self.assertEqual(swapped_amount(hop, [1000, 5], USDG), 1000)
        hop[1] = LegTokens(USDG, MANY, 1400)
        self.assertEqual(swapped_amount(hop, [1000, 5], USDG), 1400)

    def test_the_swapped_amount_needs_one_amount_per_leg(self):
        with self.assertRaisesRegex(FeeRuleError, 'fee_rule_amounts_mismatch'):
            swapped_amount(legs((USDG, MANY)), [1, 2], USDG)

    def test_fees_round_down_in_the_payers_favour(self):
        self.assertEqual(fee_of(10_000, 65), 65)
        self.assertEqual(fee_of(9_999, 65), 64)
        self.assertEqual(fee_of(153, 65), 0)
        self.assertEqual(fee_of(10**6, 400), 40_000)
        self.assertEqual(fee_of((2**128 - 1) * 8, 65), (2**128 - 1) * 8 * 65 // 10_000)

    def test_the_f7_worked_examples(self):
        # 1: create ETH/USDG with 1,000 USDG, leg USDG -> ETH spends 500 USDG: 3.25 USDG on top.
        token, source, swapped, fee = assisted_swap_fee([LegTokens(USDG, ETH, 500_000000)], [123], ROBINHOOD)
        self.assertEqual((token, source, swapped, fee), (USDG, FROM_INPUT, 500_000000, 3_250000))
        # 3: TSLA -> 1,000 USDG, USDG -> MANY spends 990: charged on 1,000 at the hop.
        route = [LegTokens(TSLA, USDG, 10**18), LegTokens(USDG, MANY, 990_000000)]
        self.assertEqual(assisted_swap_fee(route, [1_000_000000, 5], ROBINHOOD), (USDG, FROM_HOP, 1_000_000000, 6_500000))

    def test_the_terms(self):
        self.assertEqual(assisted_swap_terms([], ROBINHOOD), (0, ZERO, None))
        hop = legs((TSLA, USDG), (USDG, MANY))
        self.assertEqual(assisted_swap_terms(hop, ROBINHOOD), (FEE_ASSISTED_SWAP_BPS, USDG, FROM_HOP))
        self.assertTrue(terms_match(hop, ROBINHOOD, 65, USDG))
        for bps, token in ((64, USDG), (66, USDG), (65, TSLA), (0, ZERO)):
            self.assertFalse(terms_match(hop, ROBINHOOD, bps, token))
        self.assertTrue(terms_match([], ROBINHOOD, 0, ZERO))
        self.assertFalse(terms_match([], ROBINHOOD, 65, ZERO))
        self.assertFalse(terms_match([], ROBINHOOD, 0, USDG))
        self.assertTrue(terms_match(legs((ETH, MANY)), ROBINHOOD, 65, ETH))
        self.assertFalse(terms_match(legs((ETH, MANY)), ROBINHOOD, 65, WETH))

    def test_the_profile_ranks_are_the_registry_ranks_of_the_deployment_plan(self):
        robinhood = ranks_from_profile(chain('robinhood-4663'))
        self.assertEqual((robinhood(USDG), robinhood(ETH), robinhood(WETH), robinhood(TSLA)), (1, 2, 2, 0))
        base = ranks_from_profile(chain('base-8453'))
        self.assertEqual(base(USDC), 1)
        self.assertEqual(base('0x4200000000000000000000000000000000000006'), 2)

    def test_dict_legs_are_read_like_swap_legs(self):
        route = [{'kind': 1, 'router': ZERO, 'tokenIn': TSLA, 'tokenOut': USDG, 'amountIn': '7', 'minAmountOut': '1',
                  'data': '0x'}]
        self.assertEqual(assisted_swap_fee_token(route, ROBINHOOD), (USDG, FROM_OUTPUT))


if __name__ == '__main__':
    unittest.main()
