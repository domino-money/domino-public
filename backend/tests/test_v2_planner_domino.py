"""Domino-compound in the planner: the successor's MINT with the owner's decisions of 5 Oct 2026 (the anchor's cell,
only the newest member, near-ceiling fees serve the successor only and wait otherwise), rule 2, and the plan it
builds. The vault's own vectors: root [-6000, 6000), spacing 60, trigger 5%, overlap 20%, upside 50%."""
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from v2_plan import ACTION_COMPOUND, ACTION_MINT, decode_plan  # noqa: E402
from v2_planner import (MAX_SEQUENCE, MODE_DOMINO, MODE_SIMPLE, FeeGrowth, Limits, MemberState,  # noqa: E402
                        PlannerConfig, Policy, decide, economics, mint_earnings, newest_member)
from v2_uniswap import PoolRef  # noqa: E402
from v4_math import Q128, sqrt_at_tick  # noqa: E402
import v2_vaults  # noqa: E402
from test_v2_planner import CHEAP_GAS, FLAT, POOL4, RICH, ROOT, USDG, vault_state  # noqa: E402

DOMINO = Policy(MODE_DOMINO, 500, 2000, 600, 3)
LIMITS = Limits(100, 100, 300, 5000)
CHILD, GRANDCHILD = 88, 99
POOL3 = PoolRef(3, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG, 3000, 60)


def position(token_id, lower, upper, *, parent=0, successor=0, liquidity=10**18, fees=(10**16, 10**16)):
    return MemberState(token_id, lower, upper, liquidity, fees, ((0, 0), (0, 0)), parent, successor)


def domino_vault(*members, tick=5800, policy=DOMINO, pool=POOL4, inverse=False, **changes):
    members = members or (position(ROOT, -6000, 6000),)
    return vault_state(*members, pool=pool, price=sqrt_at_tick(tick), mode=MODE_DOMINO, policy=policy,
                       limits=LIMITS, inverse=inverse, **changes)


def run(vault, *, tick=5800, growth=None, mint_growth=RICH, config=PlannerConfig()):
    return decide(vault, sqrt_at_tick(tick), FLAT, CHEAP_GAS, config, growth_by_target=growth or {},
                  mint_growth=mint_growth)


class MintTests(unittest.TestCase):
    def test_near_the_ceiling_the_newest_member_mints_its_successor_at_the_anchors_cell(self):
        vault = domino_vault()
        decision = run(vault)
        self.assertTrue(decision.act, decision.considered)
        c = decision.candidate
        self.assertEqual((c.action, c.target, c.tick_lower, c.tick_upper, c.sources),
                         (ACTION_MINT, ROOT, 5760, 10080, (ROOT,)))
        considered = dict(decision.considered)
        # Near its ceiling the root never compounds itself (the owner's rule, as V1).
        self.assertEqual(considered[f'{ROOT}:all'], 'awaiting_successor')
        self.assertEqual(considered[f'{ROOT}:mint'], 'eligible')
        plan = decode_plan(decision.plan(vault, anchor_evidence=b'', deadline=vault.block_timestamp + 60).encode())
        self.assertEqual((plan.action, plan.target, plan.tick_lower, plan.tick_upper, plan.collect),
                         (ACTION_MINT, ROOT, 5760, 10080, (ROOT,)))
        # A successor mostly above the price takes mostly token0: the balancing swap's candidate won here.
        config = PlannerConfig()
        self.assertEqual(decision.economics.gas_units,
                         config.gas_units_mint + (config.gas_units_swap if c.has_swap else 0))

    def test_below_the_trigger_the_root_compounds_itself_and_nothing_mints(self):
        decision = run(domino_vault(), tick=5400, growth={ROOT: RICH})
        self.assertTrue(decision.act, decision.considered)
        self.assertEqual((decision.candidate.action, decision.candidate.target), (ACTION_COMPOUND, ROOT))
        self.assertFalse(any(label.endswith(':mint') for label, _ in decision.considered))

    def test_at_the_cap_the_fees_wait_and_the_reason_says_so(self):
        members = (position(ROOT, -6000, 6000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT,
                                                                           successor=GRANDCHILD),
                   position(GRANDCHILD, 13000, 13980, parent=CHILD))
        decision = run(domino_vault(*members), tick=13900, growth={m.token_id: RICH for m in members})
        considered = dict(decision.considered)
        self.assertEqual(considered[f'{GRANDCHILD}:mint'], 'max_positions_reached')
        self.assertEqual(considered[f'{GRANDCHILD}:all'], 'awaiting_successor')
        self.assertFalse(decision.act)
        self.assertEqual(decision.reason, 'max_positions_reached')
        # The reader's own limit bounds the sequence too.
        self.assertEqual(MAX_SEQUENCE, v2_vaults.MAX_MEMBERS)
        wide = domino_vault(*members, tick=13900, policy=replace(DOMINO, max_positions=255))
        self.assertNotEqual(dict(run(wide, tick=13900).considered).get(f'{GRANDCHILD}:mint'), 'max_positions_reached')

    def test_a_parent_near_its_ceiling_funds_its_successor_and_not_itself(self):
        members = (position(ROOT, -6000, 6000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT))
        decision = run(domino_vault(*members), growth={CHILD: RICH, ROOT: RICH})
        self.assertTrue(decision.act, decision.considered)
        c = decision.candidate
        self.assertEqual((c.action, c.target, c.sources), (ACTION_COMPOUND, CHILD, (ROOT, CHILD)))
        self.assertEqual(dict(decision.considered)[f'{ROOT}:all'], 'awaiting_successor')
        # Far from its ceiling, the parent funds only itself again.
        far = run(domino_vault(*members, tick=0), tick=0, growth={CHILD: RICH, ROOT: RICH})
        self.assertTrue(all(ROOT not in cand.sources or cand.target == ROOT for cand in [far.candidate] if cand))

    def test_only_the_newest_member_mints(self):
        # The root lost its successor (withdrawn); a newer member without one is the sequence's end.
        members = (position(ROOT, -6000, 6000), position(GRANDCHILD, 20000, 26000, parent=CHILD))
        self.assertEqual(newest_member(domino_vault(*members)).token_id, GRANDCHILD)
        decision = run(domino_vault(*members), growth={GRANDCHILD: RICH})
        considered = dict(decision.considered)
        self.assertEqual(considered[f'{ROOT}:all'], 'awaiting_successor')
        self.assertNotIn(f'{ROOT}:mint', considered)
        self.assertFalse(decision.act and decision.candidate.action == ACTION_MINT)

    def test_simple_mode_never_mints_and_compounds_near_the_ceiling(self):
        vault = domino_vault(policy=Policy(MODE_SIMPLE, 500, 2000, 600, 1))
        decision = run(vault, growth={ROOT: RICH})
        self.assertTrue(decision.act, decision.considered)
        self.assertEqual((decision.candidate.action, decision.candidate.target), (ACTION_COMPOUND, ROOT))
        self.assertNotIn('awaiting_successor', dict(decision.considered).values())

    def test_without_overlap_reaching_the_anchors_cell_there_is_no_successor(self):
        decision = run(domino_vault(policy=replace(DOMINO, max_overlap_bps=0)))
        self.assertEqual(dict(decision.considered)[f'{ROOT}:mint'], 'successor_range_unavailable')
        self.assertEqual((decision.act, decision.reason), (False, 'successor_range_unavailable'))

    def test_quote_in_currency0_mints_toward_lower_ticks(self):
        decision = run(domino_vault(tick=-5800, inverse=True), tick=-5800)
        self.assertTrue(decision.act, decision.considered)
        self.assertEqual((decision.candidate.tick_lower, decision.candidate.tick_upper), (-10080, -5760))

    def test_a_mint_without_evidence_waits_for_it(self):
        decision = run(domino_vault(), mint_growth=None)
        self.assertEqual(dict(decision.considered)[f'{ROOT}:mint'], 'earnings_evidence_missing')
        self.assertFalse(decision.act)

    def test_members_the_price_left_fund_a_successor_minted_past_the_ceiling(self):
        members = (position(ROOT, -6000, 6000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT))
        decision = run(domino_vault(*members, tick=11000), tick=11000)
        self.assertTrue(decision.act, decision.considered)
        c = decision.candidate
        self.assertEqual((c.action, c.target, c.tick_lower, c.tick_upper, c.sources),
                         (ACTION_MINT, CHILD, 10980, 15060, (ROOT, CHILD)))

    def test_on_v3_a_mint_holds_when_its_routes_survive_the_twap_drift(self):
        # The parent alone funds it: in range and near its ceiling at either drifted anchor.
        decision = run(domino_vault(pool=POOL3))
        self.assertTrue(decision.act, decision.considered)
        self.assertEqual(decision.candidate.action, ACTION_MINT)
        # A member the price left funds it only while the successor holds the anchor; on the cell's floor a drift
        # down would leave it out, and the vault would refuse that budget.
        members = (position(ROOT, -6000, 6000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT))
        edge = run(domino_vault(*members, tick=10980, pool=POOL3), tick=10980)
        self.assertEqual(dict(edge.considered)[f'{CHILD}:mint'], 'successor_anchor_unstable')
        # The parent still funds the MINT alone: the member the price left drops out, routable only while the
        # successor holds the anchor, which a drift down from the cell's edge would leave.
        left = position(55, -30000, -24000, successor=ROOT)
        members = (left, position(ROOT, -6000, 6000, parent=55))
        on_v4 = run(domino_vault(*members, tick=5820), tick=5820)
        self.assertEqual((on_v4.candidate.action, on_v4.candidate.sources), (ACTION_MINT, (55, ROOT)))
        on_v3 = run(domino_vault(*members, tick=5820, pool=POOL3), tick=5820)
        self.assertTrue(on_v3.act, on_v3.considered)
        self.assertEqual((on_v3.candidate.action, on_v3.candidate.sources), (ACTION_MINT, (ROOT,)))

    def test_on_v3_a_geometry_a_drift_would_break_is_unstable(self):
        # Just past the ceiling the basis is the anchor: a TWAP drifting up raises it, and the top planned now
        # (10080) would no longer reach it by the upside, though the parent would still route. Not planned.
        assert run(domino_vault(tick=6010), tick=6010).act  # on v4 the anchor is the signed spot: no drift
        decision = run(domino_vault(tick=6010, pool=POOL3), tick=6010)
        self.assertEqual(dict(decision.considered)[f'{ROOT}:mint'], 'successor_anchor_unstable')

    def test_the_readers_limit_caps_the_sequence_too(self):
        older = tuple(position(100 + i, -60000, -59000, successor=101 + i) for i in range(63))
        newest = position(5000, -6000, 6000, parent=162)
        vault = domino_vault(*older, newest, policy=replace(DOMINO, max_positions=255))
        self.assertEqual(len(vault.members), MAX_SEQUENCE)
        self.assertEqual(dict(run(vault).considered)['5000:mint'], 'max_positions_reached')

    def test_a_member_with_a_successor_is_never_the_newest(self):
        # Managers number mints upward, so the newest member has no successor; a read that says otherwise is not
        # a sequence's end, and the vault would refuse its MINT (parent.successor != 0).
        members = (position(ROOT, -6000, 6000), position(GRANDCHILD, 20000, 26000, successor=CHILD))
        self.assertEqual(newest_member(domino_vault(*members)).token_id, ROOT)

    def test_a_member_the_price_is_in_funds_no_mint_but_its_own(self):
        members = (position(ROOT, -6000, 12000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT))
        decision = run(domino_vault(*members, tick=9800), tick=9800, growth={ROOT: RICH})
        mint = next(c for c in [decision.candidate] if c is not None and c.action == ACTION_MINT)
        self.assertEqual(mint.sources, (CHILD,))

    def test_at_the_cap_the_successors_reason_wins_over_other_members_refusals(self):
        quiet = FeeGrowth(0, 0, 1_789_996_400, 0, 0, 1_790_000_000)
        members = (position(ROOT, -6000, 12000, successor=CHILD), position(CHILD, 5760, 10080, parent=ROOT))
        decision = run(domino_vault(*members, tick=9800, policy=replace(DOMINO, max_positions=2)), tick=9800,
                       growth={ROOT: quiet})
        considered = dict(decision.considered)
        self.assertEqual(considered[f'{CHILD}:mint'], 'max_positions_reached')
        self.assertIn('owner_benefit_insufficient', considered.values())
        self.assertEqual((decision.act, decision.reason), (False, 'max_positions_reached'))

    def test_a_disarmed_root_mints_nothing(self):
        decision = run(domino_vault(root_armed=False))
        self.assertEqual(dict(decision.considered)[f'{ROOT}:all'], 'root_disarmed')
        self.assertNotIn(f'{ROOT}:mint', dict(decision.considered))


class MintEconomicsTests(unittest.TestCase):
    def test_a_successors_earnings_count_the_vaults_own_liquidity_in_range(self):
        vault = domino_vault()
        decision = run(vault)
        c = decision.candidate
        active, own = vault.pool.liquidity, vault.member(ROOT).liquidity
        share = Fraction(c.liquidity * (active - own), active + c.liquidity)
        horizon = PlannerConfig().owner_horizon_seconds
        expected = RICH.rate()[0] * share * horizon / Q128
        self.assertEqual(mint_earnings(c, vault, RICH, horizon), (expected, expected))
        # Sole liquidity in the pool: nothing to gain from more of it.
        alone = replace(vault, pool=replace(vault.pool, liquidity=own))
        self.assertEqual(mint_earnings(c, alone, RICH, horizon), (0, 0))
        quiet = FeeGrowth(0, 0, 1_789_996_400, 0, 0, 1_790_000_000)
        self.assertFalse(economics(vault, c, FLAT, CHEAP_GAS, PlannerConfig(), growth=quiet).owner_ok)

    def test_the_mint_gas_prior_is_used_until_presimulation_measures(self):
        vault = domino_vault()
        c = run(vault).candidate
        config = PlannerConfig(gas_units_mint=777_000)
        self.assertEqual(economics(vault, c, FLAT, CHEAP_GAS, config, growth=RICH).gas_units,
                         777_000 + (config.gas_units_swap if c.has_swap else 0))
        direct = replace(c, swap=type(c.swap)())
        self.assertEqual(economics(vault, direct, FLAT, CHEAP_GAS, config, growth=RICH).gas_units, 777_000)
        self.assertEqual(economics(vault, c, FLAT, CHEAP_GAS, config, growth=RICH, gas_units=500_000).gas_units,
                         500_000)
        with self.assertRaises(Exception):
            PlannerConfig(gas_units_mint=0)


if __name__ == '__main__':
    unittest.main()
