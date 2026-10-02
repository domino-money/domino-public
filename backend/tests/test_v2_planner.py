"""The V2 compound planner: the vault's arithmetic, the swap sizing, both economics gates and the plan."""
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from v2_plan import (ACTION_COMPOUND, LEG_UNIVERSAL_ROUTER, LEG_V3_POOL, LEG_V4_POOL, U128, SwapLeg, decode_plan,
                     twap_evidence)
from v2_planner import (BPS, MODE_DOMINO, MODE_SIMPLE, Budgeted, FeeGrowth, GasQuote, Limits, MemberState,
                        PlannerConfig, Policy, PoolQuoter, PoolState, PriceBook, SwapQuote, VaultState,
                        amounts_for_liquidity,
                        build_candidate, decide, economics, fee_of, gross_for, incremental_earnings,
                        liquidity_for_amounts, minimum_output, net_of, price_book, quote, remeasured, simulate_swap)
from v2_uniswap import PoolRef
from v4_math import Q96, Q128, sqrt_at_tick

ZERO = '0x' + '00' * 20
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'


def pool_leg_for(pool, amount_in):
    from v2_plan import pool_leg
    return pool_leg(pool, True, amount_in, 1)
TOKEN = '0x' + 'ee' * 20
POOL4 = PoolRef(4, ZERO, USDG, 3000, 60)
POOL3 = PoolRef(3, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG, 500, 10)
PRICE_ONE = Q96
ROOT = 77


def member(token_id=ROOT, *, lower=-600, upper=600, liquidity=10**18, fees=(10**16, 10**16), lots=((0, 0), (0, 0)),
           parent=0):
    return MemberState(token_id, lower, upper, liquidity, fees, lots, parent)


def vault_state(*members, pool=POOL4, price=PRICE_ONE, active=10**19, mode=MODE_SIMPLE, **changes):
    members = members or (member(),)
    state = VaultState(
        chain_id=4663, vault='0x' + 'aa' * 20, owner='0x' + 'bb' * 20, root_token_id=ROOT, members=members,
        policy=Policy(mode, 500, 2000, 3600, 1 if mode == MODE_SIMPLE else 4),
        limits=Limits(100, 100, 300, 1000),
        pool=PoolState(pool, price, active, (pool.fee, pool.fee)), state_nonce=5, last_execution_at=0,
        paused=False, root_armed=True, halted=False, swap_available=True, block_number=1000,
        block_timestamp=1_790_000_000)
    return replace(state, **changes)


# Both tokens worth 1 wei per unit: values read as amounts.
FLAT = PriceBook(Fraction(1), Fraction(1))
CHEAP_GAS = GasQuote(fee_per_gas=1, l1_fee_wei=0)
# A rich window: 1e-4 of each token per unit of liquidity per second at 1e19 active.
RICH = FeeGrowth(0, 0, 1_789_996_400, Q128 * 3600 // 10**4, Q128 * 3600 // 10**4, 1_790_000_000)


class ArithmeticTests(unittest.TestCase):
    def test_the_tariff_split_is_the_vaults(self):
        self.assertEqual((fee_of(10_000, 200), net_of(10_000, 200), fee_of(49, 200), net_of(49, 200)),
                         (200, 9_800, 0, 49))
        rng = random.Random(7)
        for _ in range(3000):
            bps = rng.choice((200, 400))
            prior, net = rng.randrange(0, 10**9), rng.randrange(0, 10**9)
            gross = gross_for(prior, net, bps)
            self.assertEqual(net_of(gross, bps), net_of(prior, bps) + net)
            if net:
                self.assertLess(net_of(gross - 1, bps), net_of(prior, bps) + net)  # the least such gross

    def test_splitting_consumption_pays_the_same_cut_as_one_piece(self):
        rng = random.Random(11)
        for _ in range(500):
            charged, uncharged = rng.randrange(0, 10**6), rng.randrange(0, 10**9)
            whole, split = Budgeted(charged, uncharged, charged + uncharged, 400), Budgeted(
                charged, uncharged, charged + uncharged, 400)
            total = rng.randrange(0, whole.capacity() + 1)
            first = rng.randrange(0, total + 1)
            self.assertEqual(whole.spend(total), total)
            self.assertEqual(split.spend(first) + split.spend(total - first), total)
            self.assertEqual((whole.fee, whole.uncharged, whole.charged), (split.fee, split.uncharged, split.charged))

    def test_the_quote_and_floor_are_dominoswapfloors(self):
        # DominoSwapFloor.t.sol's own vectors.
        self.assertEqual(quote(10**18, PRICE_ONE, True), 10**18)
        self.assertEqual(quote(10**18, PRICE_ONE * 2, True), 4 * 10**18)
        self.assertEqual(quote(10**18, PRICE_ONE * 2, False), 25 * 10**16)
        self.assertEqual(quote(1, 1 << 140, True), 1 << 88)
        self.assertEqual(quote(1 << 88, 1 << 140, False), 1)
        self.assertEqual(quote(1 << 130, (1 << 40) + (1 << 31), True), 263_169)
        self.assertEqual(minimum_output(100 * 10**6, PRICE_ONE, True, 20_000, 100), 97_020_000)
        self.assertEqual(minimum_output(100 * 10**6, PRICE_ONE, False, 3000, 50), 100 * 10**6 * 997_000 * 9_950 // 10**10)
        self.assertEqual(minimum_output(3, PRICE_ONE, True, 3000, 50), 2)
        for args in ((1, 0, True, 3000, 50), (1, PRICE_ONE, True, 10**6, 50), (1, PRICE_ONE, True, 3000, 10_000)):
            with self.assertRaises(DataError):
                minimum_output(*args)

    def test_liquidity_never_overcharges_and_rounding_up_adds_at_most_one_unit(self):
        rng = random.Random(3)
        for _ in range(400):
            lower = rng.randrange(-20000, 19000) // 60 * 60
            upper = lower + 60 * rng.randrange(1, 200)
            price = sqrt_at_tick(rng.randrange(lower - 600, upper + 600))
            amount0, amount1 = rng.randrange(0, 10**24), rng.randrange(0, 10**24)
            liquidity = liquidity_for_amounts(price, lower, upper, amount0, amount1)
            up = amounts_for_liquidity(price, lower, upper, liquidity, True)
            down = amounts_for_liquidity(price, lower, upper, liquidity, False)
            self.assertLessEqual(up[0], amount0)
            self.assertLessEqual(up[1], amount1)
            self.assertLessEqual(up[0] - down[0], 1)
            self.assertLessEqual(up[1] - down[1], 1)

    def test_a_swap_inside_the_range_follows_the_constant_liquidity_curve(self):
        after, out = simulate_swap(PRICE_ONE, 10**20, 3000, True, 10**16)
        self.assertLess(after, PRICE_ONE)
        # About 0.997e16, a little less for the impact.
        self.assertTrue(10**16 * 9969 // 10**4 < out < 10**16 * 997 // 1000)
        self.assertEqual(simulate_swap(PRICE_ONE, 10**20, 3000, True, 0), (PRICE_ONE, 0))


class PriceBookTests(unittest.TestCase):
    def test_a_token_without_a_reference_is_valued_through_the_pool(self):
        # ETH/USDG at a price of 4 USDG units per wei: USDG has no reference here.
        book = price_book(POOL4, PRICE_ONE * 2, {ZERO: 1})
        self.assertEqual((book.wei_per_unit0, book.wei_per_unit1), (Fraction(1), Fraction(1, 4)))
        book = price_book(POOL4, PRICE_ONE * 2, {USDG: Fraction(1, 4)})
        self.assertEqual(book.wei_per_unit0, Fraction(1))
        with self.assertRaisesRegex(DataError, '^v2_gas_price_source_missing$'):
            price_book(PoolRef(4, TOKEN, '0x' + 'ff' * 20, 3000, 60), PRICE_ONE, {ZERO: 1})


class CandidateTests(unittest.TestCase):
    config = PlannerConfig()

    def test_balanced_fees_compound_directly_with_the_exact_tariff(self):
        vault = vault_state()
        candidate, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        self.assertIsNone(refusal)
        self.assertTrue(candidate.swap.empty)
        self.assertEqual(candidate.budgets[0].token_id, ROOT)
        self.assertEqual((candidate.budgets[0].max0, candidate.budgets[0].max1), (10**16, 10**16))
        # At price 1 inside a symmetric range the add takes both tokens alike; the cut is 2% of the gross used.
        for index in (0, 1):
            gross = gross_for(0, candidate.consumed[index], 200)
            self.assertEqual(candidate.tariff[index], gross - candidate.consumed[index])
            self.assertLessEqual(gross, 10**16)
        self.assertEqual(candidate.min_liquidity, candidate.liquidity * 99 // 100)

    def test_one_sided_fees_swap_the_excess_and_leave_the_output_scarce(self):
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        direct, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        self.assertEqual((direct, refusal), (None, 'nothing_to_add'))
        candidate, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
        self.assertIsNone(refusal)
        swap = candidate.swap
        self.assertTrue(swap.zero_for_one)
        self.assertEqual(swap.source, ROOT)
        self.assertEqual(len(swap.legs), 1)
        leg = swap.legs[0]
        self.assertEqual((leg.kind, leg.token_in, leg.token_out, leg.amount_in, leg.min_amount_out),
                         (LEG_V4_POOL, ZERO, USDG, swap.amount_in, swap.min_amount_out))
        # The floor at the anchor, less the pool's whole fee, less the owner's slippage, is respected.
        floor = minimum_output(swap.amount_in, PRICE_ONE, True, 3000, 100)
        self.assertGreaterEqual(swap.min_amount_out, floor)
        self.assertGreaterEqual(candidate.swap_out_expected, swap.min_amount_out)
        # The budget leaves room for more output than simulated (A5).
        self.assertEqual(candidate.budgets[0].max1, 2 * candidate.swap_out_expected)
        # Nearly half the fees are swapped; what stays is the input token, never the output.
        self.assertTrue(17 * 10**15 < swap.amount_in < 2 * 10**16)
        self.assertEqual(candidate.leftover[1], 0)
        self.assertGreater(candidate.leftover[0], 0)

    def test_the_wider_the_range_the_less_input_waits(self):
        leftovers = []
        for lower, upper in ((-600, 600), (-6000, 6000), (-887220, 887220)):
            vault = vault_state(member(lower=lower, upper=upper, fees=(4 * 10**16, 0)))
            candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
            leftovers.append(candidate.leftover[0])
        self.assertEqual(leftovers, sorted(leftovers, reverse=True))
        self.assertLess(leftovers[-1] * 100, 4 * 10**16)  # under 1% of the fees on a full range

    def test_the_output_is_spent_when_the_price_moves_within_the_tolerance(self):
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
        swap = candidate.swap
        after, out = simulate_swap(PRICE_ONE, vault.pool.liquidity, 3000, True, swap.amount_in)
        left0 = net_of(4 * 10**16, 200) - swap.amount_in

        def unspent(move_bps):
            moved = after * (BPS - move_bps) // BPS  # a lower sqrt price at the add needs less token1
            liquidity = liquidity_for_amounts(moved, -600, 600, left0, out)
            return out - amounts_for_liquidity(moved, -600, 600, liquidity, True)[1]
        for move in (0, 10, self.config.swap_price_tolerance_bps):
            self.assertLessEqual(unspent(move), out // 100)  # what A5 lets the source keep
        # Beyond the tolerance a narrow range can leave too much: the presimulation refuses that plan.
        self.assertGreater(unspent(100), out // 100)

    def test_the_output_is_scarce_by_the_margin_at_the_price_itself(self):
        config = PlannerConfig(swap_price_tolerance_bps=0, swap_margin_bps=100)
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, config, swap_fraction_bps=BPS)
        after, out = simulate_swap(PRICE_ONE, vault.pool.liquidity, 3000, True, candidate.swap.amount_in)
        left0 = net_of(4 * 10**16, 200) - candidate.swap.amount_in
        l0 = liquidity_for_amounts(after, -600, 600, left0, 10**40)  # token0's side alone
        l1 = liquidity_for_amounts(after, -600, 600, 10**40, out)  # token1's side alone
        self.assertLessEqual(l1 * 10_000, l0 * 9_900)
        self.assertGreater(l1 * 10_000, l0 * 9_890)  # and no more than that

    def test_a_two_percent_pool_still_swaps_under_a_one_percent_limit(self):
        # #3409682: the floor excludes the pool's own fee.
        pool = PoolRef(4, ZERO, USDG, 20_000, 400)
        vault = vault_state(member(lower=-4000, upper=4000, fees=(4 * 10**16, 0)), pool=pool)
        candidate, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
        self.assertIsNone(refusal)
        v1_floor = quote(candidate.swap.amount_in, PRICE_ONE, True) * 9_900 // 10_000
        self.assertLess(candidate.swap_out_expected, v1_floor)

    def test_a_v3_pool_leg_and_a_twap_floor_taken_against_a_moving_anchor(self):
        vault = vault_state(member(lower=-600, upper=600, fees=(0, 4 * 10**16)), pool=POOL3)
        candidate, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
        self.assertIsNone(refusal)
        swap = candidate.swap
        self.assertFalse(swap.zero_for_one)
        self.assertEqual(swap.legs[0].kind, LEG_V3_POOL)
        drifted = PRICE_ONE * BPS // (BPS + self.config.twap_drift_bps)
        self.assertGreaterEqual(swap.min_amount_out, minimum_output(swap.amount_in, drifted, False, 500, 100))

    def test_a_swap_whose_output_would_miss_the_vaults_floor_is_not_planned(self):
        # No slippage allowed beyond the pool fee: the impact alone puts the output under the floor.
        vault = vault_state(member(fees=(4 * 10**16, 0)), limits=Limits(0, 100, 300, 1000))
        self.assertEqual(build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS),
                         (None, 'swap_below_floor'))

    def test_an_output_the_add_cannot_spend_is_not_planned(self):
        class Generous:
            """A quote far above what the pool's curve gives: more output than the add takes."""
            def quote(self, chain, pool, token_in, amount_in):
                return SwapQuote(amount_in * 3, pool_leg_for(pool, amount_in), None)
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        self.assertEqual(build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS,
                                         quoter=Generous()), (None, 'swap_output_unspent'))

    def test_a_v3_floor_is_taken_at_an_anchor_that_moved_against_the_swap_in_both_directions(self):
        for fees, zero_for_one in (((4 * 10**16, 0), True), ((0, 4 * 10**16), False)):
            found = None
            for slippage in range(0, 300):
                vault = vault_state(member(fees=fees), pool=POOL3, limits=Limits(slippage, 100, 300, 1000))
                still = PlannerConfig(twap_drift_bps=0)
                plain, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, still, swap_fraction_bps=BPS)
                drifted, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config,
                                                   swap_fraction_bps=BPS)
                if plain is not None and drifted is None:
                    found = (slippage, refusal)
                    break
            self.assertIsNotNone(found, zero_for_one)
            self.assertEqual(found[1], 'swap_below_floor')

    def test_a_vault_without_a_swap_module_never_swaps(self):
        vault = vault_state(member(fees=(4 * 10**16, 0)), swap_available=False)
        self.assertEqual(build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS),
                         (None, 'swap_unavailable'))

    def test_existing_lots_fund_the_add_charged_units_first(self):
        vault = vault_state(member(fees=(0, 0), lots=((5 * 10**15, 10**15), (6 * 10**15, 0))))
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        self.assertEqual((candidate.budgets[0].max0, candidate.budgets[0].max1), (6 * 10**15, 6 * 10**15))
        # 1e15 charged units of token0 are spent before any uncharged unit: no cut on them.
        consumed0 = candidate.consumed[0]
        self.assertEqual(candidate.tariff[0], gross_for(0, consumed0 - 10**15, 200) - (consumed0 - 10**15))

    def test_domino_routing_lets_a_member_the_price_left_fund_one_it_is_in(self):
        successor = member(91, lower=600, upper=1200, liquidity=10**18, fees=(3 * 10**15, 0), parent=ROOT)
        vault = vault_state(member(), successor, mode=MODE_DOMINO)
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        self.assertEqual(candidate.sources, (ROOT, 91))
        self.assertEqual([b.token_id for b in candidate.budgets], [ROOT, 91])
        # A disarmed root funds nothing; simple mode routes nothing.
        out_of_range_root = vault_state(member(lower=-1800, upper=-1200), member(91, lower=-600, upper=600),
                                        mode=MODE_DOMINO, root_armed=False)
        candidate, _ = build_candidate(out_of_range_root, out_of_range_root.member(91), PRICE_ONE, self.config)
        self.assertEqual(candidate.sources, (91,))
        simple = vault_state(member(), successor)
        self.assertEqual(build_candidate(simple, simple.member(ROOT), PRICE_ONE, self.config)[0].sources, (ROOT,))


class DecisionTests(unittest.TestCase):
    config = PlannerConfig()

    def decide(self, vault, *, prices=FLAT, gas=CHEAP_GAS, growth=RICH, anchor=PRICE_ONE, **kwargs):
        growth_by_target = {m.token_id: growth for m in vault.members} if growth else None
        return decide(vault, anchor, prices, gas, self.config, growth_by_target=growth_by_target, **kwargs)

    def test_a_paying_compound_is_planned_and_encodes_for_the_vault(self):
        vault = vault_state()
        decision = self.decide(vault)
        self.assertTrue(decision.act, decision.considered)
        plan = decision.plan(vault, anchor_evidence=twap_evidence(600), deadline=vault.block_timestamp + 120)
        decoded = decode_plan(plan.encode())
        self.assertEqual((decoded.action, decoded.state_nonce, decoded.target, decoded.collect),
                         (ACTION_COMPOUND, 5, ROOT, (ROOT,)))
        self.assertEqual((decoded.amount0_max, decoded.amount1_max), (U128, U128))
        self.assertEqual((decoded.tick_lower, decoded.tick_upper), (0, 0))
        self.assertGreater(decoded.min_liquidity, 0)

    def test_the_swap_wins_when_it_reinvests_more_for_the_owner(self):
        vault = vault_state(member(fees=(4 * 10**16, 10**15)))
        decision = self.decide(vault)
        self.assertTrue(decision.act)
        self.assertEqual(decision.candidate.label, 'swap_10000')
        labels = dict(decision.considered)
        self.assertEqual(labels[f'{ROOT}:direct'], 'eligible')

    def test_preconditions_wait_without_planning(self):
        cases = {'automation_halted': {'halted': True}, 'vault_paused': {'paused': True},
                 'too_soon': {'last_execution_at': 1_790_000_000 - 3599}}
        for reason, change in cases.items():
            with self.subTest(reason):
                decision = self.decide(vault_state(**change))
                self.assertEqual((decision.act, decision.reason), (False, reason))
        self.assertTrue(self.decide(vault_state(last_execution_at=1_790_000_000 - 3600)).act)
        decision = self.decide(vault_state(root_armed=False))
        self.assertEqual((decision.act, decision.reason), (False, 'root_disarmed'))

    def test_the_tariff_must_cover_the_gas(self):
        # 2% of 2e16 is 4e14 wei of tariff; 450k units at 1 gwei is 4.5e14.
        decision = self.decide(vault_state(), gas=GasQuote(fee_per_gas=10**9))
        self.assertEqual((decision.act, decision.reason), (False, 'gas_not_covered'))
        self.assertTrue(self.decide(vault_state(), gas=GasQuote(fee_per_gas=10**8)).act)
        # The L1 data fee counts too.
        decision = self.decide(vault_state(), gas=GasQuote(fee_per_gas=10**8, l1_fee_wei=4 * 10**14))
        self.assertEqual(decision.reason, 'gas_not_covered')

    def test_the_buffer_counts_in_the_operator_gate(self):
        # The tariff 4e14 covers 3.6e14 of gas, but not with the 15% buffer (4.14e14).
        gas = GasQuote(fee_per_gas=8 * 10**8)  # 450k units: 3.6e14
        decision = self.decide(vault_state(), gas=gas)
        self.assertEqual((decision.act, decision.reason), (False, 'gas_not_covered'))
        self.assertTrue(self.decide(vault_state(), gas=GasQuote(fee_per_gas=7 * 10**8)).act)  # 3.15e14 × 1.15

    def test_the_haircut_counts_in_the_owner_gate(self):
        vault = vault_state()
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        rich = economics(vault, candidate, FLAT, CHEAP_GAS, self.config, growth=RICH)
        cost = rich.tariff_wei + rich.swap_cost_wei
        # A window whose earnings are 1.1 × the cost: enough without the 20% haircut, not with it.
        scale = Fraction(11, 10) * cost / rich.earnings_wei
        end = int(RICH.inside0_end * scale)
        growth = FeeGrowth(0, 0, RICH.start_timestamp, end, end, RICH.end_timestamp)
        self.assertFalse(economics(vault, candidate, FLAT, CHEAP_GAS, self.config, growth=growth).owner_ok)
        no_haircut = PlannerConfig(forecast_haircut_bps=0)
        self.assertTrue(economics(vault, candidate, FLAT, CHEAP_GAS, no_haircut, growth=growth).owner_ok)

    def test_a_swap_that_brings_little_into_play_is_not_considered(self):
        # Nearly balanced fees on a wide range: the swap would move under 10% of what is consumed.
        vault = vault_state(member(lower=-60000, upper=60000, fees=(13 * 10**15, 10**16)))
        decision = self.decide(vault)
        reasons = dict(decision.considered)
        self.assertEqual(reasons[f'{ROOT}:swap_10000'], 'swap_too_small')
        loose = decide(vault, PRICE_ONE, FLAT, CHEAP_GAS, PlannerConfig(min_swap_share_bps=0),
                       growth_by_target={ROOT: RICH})
        self.assertNotEqual(dict(loose.considered)[f'{ROOT}:swap_10000'], 'swap_too_small')

    def test_the_platform_earns_at_least_its_absolute_margin(self):
        # Tariff 4e14, gas 4.5e13 at 1e8: 3.55e14 of profit.
        gas = GasQuote(fee_per_gas=10**8)
        strict = PlannerConfig(platform_min_profit_wei=36 * 10**13)
        decision = decide(vault_state(), PRICE_ONE, FLAT, gas, strict, growth_by_target={ROOT: RICH})
        self.assertEqual((decision.act, decision.reason), (False, 'gas_not_covered'))
        loose = PlannerConfig(platform_min_profit_wei=35 * 10**13)
        self.assertTrue(decide(vault_state(), PRICE_ONE, FLAT, gas, loose, growth_by_target={ROOT: RICH}).act)

    def test_measured_gas_replaces_the_prior(self):
        vault = vault_state()
        gas = GasQuote(fee_per_gas=5 * 10**8)
        decision = self.decide(vault, gas=gas)
        self.assertTrue(decision.act)
        again = remeasured(decision, vault, FLAT, gas, self.config, 900_000, growth=RICH)
        self.assertEqual((again.act, again.reason), (False, 'gas_not_covered'))
        again = remeasured(decision, vault, FLAT, gas, self.config, 400_000, growth=RICH)
        self.assertTrue(again.act)
        self.assertEqual(again.economics.gas_units, 400_000)

    def test_missing_evidence_never_justifies_an_action(self):
        decision = self.decide(vault_state(), growth=None)
        self.assertEqual((decision.act, decision.reason), (False, 'earnings_evidence_missing'))

    def test_a_quiet_pool_does_not_pay_back_the_tariff_within_the_horizon(self):
        quiet = FeeGrowth(0, 0, 1_789_996_400, Q128 * 3600 // 10**12, Q128 * 3600 // 10**12, 1_790_000_000)
        decision = self.decide(vault_state(), growth=quiet)
        self.assertEqual((decision.act, decision.reason), (False, 'owner_benefit_insufficient'))

    def test_the_only_liquidity_earns_nothing_more_by_growing(self):
        vault = vault_state(active=10**18)  # the root is all the active liquidity
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        self.assertEqual(incremental_earnings(candidate, vault.member(ROOT), 10**18, RICH, 86400),
                         (Fraction(0), Fraction(0)))
        self.assertEqual(self.decide(vault).reason, 'owner_benefit_insufficient')

    def test_an_out_of_range_target_earns_nothing(self):
        vault = vault_state(member(lower=600, upper=1200, fees=(10**16, 0)))
        self.assertFalse(self.decide(vault).act)

    def test_earnings_follow_the_shared_fee_flow(self):
        vault = vault_state()
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config)
        e0, e1 = incremental_earnings(candidate, vault.member(ROOT), 10**19, RICH, 3600)
        rate = Fraction(10**-4).limit_denominator(10**6)
        added = candidate.liquidity
        expected = Fraction(3600, 10**4) * added * (10**19 - 10**18) / (10**19 + added)
        self.assertAlmostEqual(float(e0), float(expected), delta=float(expected) * 1e-9)
        self.assertEqual(e0, e1)
        self.assertGreater(rate, 0)

    def test_economics_value_the_swap_cost_at_the_anchor(self):
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        candidate, _ = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS)
        result = economics(vault, candidate, FLAT, CHEAP_GAS, self.config, growth=RICH)
        self.assertEqual(result.swap_cost_wei, candidate.swap.amount_in - candidate.swap_out_expected)
        self.assertEqual(result.gas_units, 620_000)
        self.assertEqual(result.tariff_wei, sum(candidate.tariff))


class SeamTests(unittest.TestCase):
    config = PlannerConfig()

    def test_the_default_quoter_is_the_vault_pools_own_curve(self):
        vault = vault_state()
        quote = PoolQuoter(vault.pool).quote(4663, POOL4, ZERO, 10**16)
        self.assertEqual((quote.amount_out, quote.sqrt_price_after),
                         simulate_swap(PRICE_ONE, vault.pool.liquidity, 3000, True, 10**16)[::-1])
        self.assertEqual((quote.leg.kind, quote.leg.token_in, quote.leg.token_out), (LEG_V4_POOL, ZERO, USDG))
        with self.assertRaisesRegex(DataError, '^v2_quote_unavailable$'):
            PoolQuoter(vault.pool).quote(4663, POOL3, ZERO, 1)

    def test_another_quoter_takes_its_place_with_one_call(self):
        calls = []

        class RouterQuoter:
            """What a quoter over the Universal Router (3c's v2_quotes) would answer."""
            def quote(self, chain, pool, token_in, amount_in):
                calls.append((chain, pool, token_in, amount_in))
                leg = SwapLeg(LEG_UNIVERSAL_ROUTER, '0x' + 'ab' * 20, token_in, USDG, amount_in, 1, b'\x01\x02')
                return SwapQuote(amount_in * 995 // 1000, leg, None)
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        candidate, refusal = build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config,
                                             swap_fraction_bps=BPS, quoter=RouterQuoter())
        self.assertIsNone(refusal)
        (chain_id, pool, token_in, amount_in), = calls
        self.assertEqual((chain_id, pool, token_in), (4663, POOL4, ZERO))
        leg, = candidate.swap.legs
        self.assertEqual((leg.kind, leg.data, leg.amount_in), (LEG_UNIVERSAL_ROUTER, b'\x01\x02', amount_in))
        # The planner sets the minimum, never below the vault's floor at the anchor.
        self.assertEqual(leg.min_amount_out, candidate.swap.min_amount_out)
        self.assertGreaterEqual(leg.min_amount_out, minimum_output(amount_in, PRICE_ONE, True, 3000, 100))
        self.assertEqual(candidate.swap_out_expected, amount_in * 995 // 1000)

    def test_a_quote_for_other_tokens_is_refused(self):
        class Wrong:
            def quote(self, chain, pool, token_in, amount_in):
                return SwapQuote(amount_in, SwapLeg(LEG_V4_POOL, ZERO, USDG, ZERO, amount_in, 1, b''), None)
        vault = vault_state(member(fees=(4 * 10**16, 0)))
        self.assertEqual(build_candidate(vault, vault.member(ROOT), PRICE_ONE, self.config, swap_fraction_bps=BPS,
                                         quoter=Wrong()), (None, 'quote_leg_mismatch'))

    def test_the_vaults_off_chain_gas_ceiling_holds_before_and_after_presimulation(self):
        vault = vault_state()
        gas = GasQuote(fee_per_gas=10**8)  # 450k units: 4.5e13 wei
        decision = decide(vault, PRICE_ONE, FLAT, gas, self.config, growth_by_target={ROOT: RICH},
                          max_gas_cost_wei=4 * 10**13)
        self.assertEqual((decision.act, decision.reason), (False, 'vault_gas_ceiling'))
        decision = decide(vault, PRICE_ONE, FLAT, gas, self.config, growth_by_target={ROOT: RICH},
                          max_gas_cost_wei=5 * 10**13)
        self.assertTrue(decision.act)
        again = remeasured(decision, vault, FLAT, gas, self.config, 800_000, growth=RICH, max_gas_cost_wei=5 * 10**13)
        self.assertEqual((again.act, again.reason), (False, 'vault_gas_ceiling'))


class ConfigTests(unittest.TestCase):
    def test_nonsense_is_refused(self):
        for change in ({'deadline_seconds': 0}, {'liquidity_slack_bps': 10_000}, {'gas_units_compound': 0},
                       {'forecast_haircut_bps': -1}, {'owner_horizon_seconds': 31 * 86400}, {'swap_margin_bps': True}):
            with self.subTest(change), self.assertRaises(DataError):
                PlannerConfig(**change)


if __name__ == '__main__':
    unittest.main()
