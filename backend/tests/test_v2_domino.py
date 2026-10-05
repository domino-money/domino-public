"""Domino-compound's geometry and routing against the vault's own Forge vectors (DominoV2VaultDomino.t.sol: root
[-6000, 6000), spacing 60, trigger 5%, overlap 20%, upside 50%) in both orientations, the owner's successor floor
(the anchor's cell), and every returned range against a brute force over aligned ticks."""
from collections import namedtuple
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_domino as domino  # noqa: E402
from v4_math import sqrt_at_tick, tick_at_sqrt  # noqa: E402

Member = namedtuple('Member', 'token_id tick_lower tick_upper successor', defaults=(0,))
ROOT = Member(1, -6000, 6000)
POLICY = {'trigger_bps': 500, 'overlap_bps': 2000, 'upside_bps': 5000, 'spacing': 60}


def at(tick):
    return sqrt_at_tick(tick)


def check(lower, upper, anchor_tick, *, inverse=False, parent=ROOT, **policy):
    return domino.check_successor(parent, lower, upper, at(anchor_tick), inverse=inverse, **{**POLICY, **policy})


def successor(anchor_tick, *, inverse=False, parent=ROOT, anchor=None, **policy):
    return domino.successor_range(parent, at(anchor_tick) if anchor is None else anchor, inverse=inverse,
                                  **{**POLICY, **policy})


class RatioTests(unittest.TestCase):
    def test_the_ratio_is_the_contracts_exactly(self):
        rng = random.Random(7)
        for _ in range(2000):
            a, b = rng.randrange(1, 2**160), rng.randrange(1, 2**160)
            num = rng.randrange(0, 1_010_001)
            # DominoV2VaultMath.ratioAtLeast: the shortcut, then floor(a * (a * 1e4) / b) >= b * num.
            expected = True if a // b >= 2**32 else (a * (a * 10_000)) // b >= b * num
            self.assertEqual(domino.ratio_at_least(a, b, num), expected)
        self.assertTrue(domino.ratio_at_least(at(100), at(100), 10_000))
        self.assertFalse(domino.ratio_at_least(at(99), at(100), 10_000))
        self.assertTrue(domino.oriented_at_least(at(99), at(100), 10_000, True))


class GeometryVectorTests(unittest.TestCase):
    def test_the_trigger_starts_at_tick_5488(self):
        # 95% of the ceiling price is tick 5487.04: 5487 is short, 5488 is in.
        self.assertFalse(domino.near_ceiling(ROOT, at(5487), 500, False))
        self.assertTrue(domino.near_ceiling(ROOT, at(5488), 500, False))
        self.assertTrue(domino.near_ceiling(ROOT, at(9000), 500, False))  # past the ceiling counts
        self.assertEqual(successor(5487), (None, 'successor_not_due'))

    def test_the_vaults_accepted_and_refused_successors(self):
        self.assertTrue(check(5400, 10080, 5800))
        self.assertTrue(check(3780, 10080, 5800))  # the widest overlap
        self.assertFalse(check(6060, 10080, 5800))  # floor above the ceiling
        self.assertFalse(check(3720, 10080, 5800))  # floor more than 20% below
        self.assertFalse(check(5400, 10020, 5800))  # ceiling short of +50%
        self.assertFalse(check(5400, 10140, 5800))  # not the first such tick
        self.assertFalse(check(5400, 10080, 5400))  # below the trigger, whatever the range
        # Past the ceiling the geometry is measured from the anchor.
        self.assertFalse(check(5400, 10080, 7000))
        self.assertTrue(check(6960, 11100, 7000))

    def test_quote_in_currency0_ladders_toward_lower_ticks(self):
        self.assertTrue(check(-10080, -5400, -5800, inverse=True))
        self.assertFalse(check(-10020, -5400, -5800, inverse=True))
        self.assertFalse(check(5400, 10080, -5800, inverse=True))
        self.assertFalse(domino.near_ceiling(ROOT, at(-5487), 500, True))
        self.assertTrue(domino.near_ceiling(ROOT, at(-5488), 500, True))

    def test_the_owners_successor_starts_at_the_anchors_cell(self):
        self.assertEqual(successor(5800), ((5760, 10080), None))
        self.assertEqual(successor(5788), ((5760, 10080), None))  # within the cell [5760, 5820)
        self.assertEqual(successor(5820), ((5820, 10080), None))  # exactly on an aligned tick
        self.assertEqual(successor(7000), ((6960, 11100), None))  # the vault's own vector past the ceiling
        self.assertEqual(successor(-5800, inverse=True), ((-10080, -5760), None))
        self.assertEqual(successor(-5760, inverse=True), ((-10080, -5700), None))
        # Between two ticks the cell is the one below the price, whose top holds it.
        between = (at(5801) + at(5802)) // 2
        self.assertEqual(successor(None, anchor=between), ((5760, 10080), None))
        for anchor_tick, inverse in ((5800, False), (7000, False), (-5800, True)):
            (lower, upper), _ = successor(anchor_tick, inverse=inverse)
            self.assertTrue(domino.in_range(Member(0, lower, upper), at(anchor_tick)))

    def test_below_the_ceiling_the_basis_is_the_ceiling_even_a_tick_away(self):
        # One tick below the ceiling the anchor is not past it: the top is measured from the ceiling (6000 + 4055),
        # not from the anchor (5999 + 4055), which only a spacing of 1 can tell apart.
        self.assertEqual(successor(5999, spacing=1), ((5999, 10055), None))
        self.assertEqual(successor(6000, spacing=1), ((6000, 10055), None))

    def test_without_overlap_reaching_the_anchors_cell_there_is_no_successor(self):
        self.assertEqual(successor(5800, overlap_bps=0), (None, 'successor_range_unavailable'))
        # Past the ceiling, with no overlap, only an anchor exactly on an aligned tick has a floor at the basis.
        self.assertEqual(successor(7020, overlap_bps=0), ((7020, 11100), None))
        self.assertEqual(successor(7000, overlap_bps=0), (None, 'successor_range_unavailable'))
        # A trigger wider than the overlap: near the ceiling, but the cell is too far below it.
        self.assertEqual(successor(5000, trigger_bps=2000, overlap_bps=500), (None, 'successor_range_unavailable'))

    def test_a_top_beyond_the_tick_range_is_no_successor(self):
        high = Member(1, 880000, 886000)
        self.assertEqual(successor(885900, parent=high), (None, 'successor_range_unavailable'))
        low = Member(1, -886000, -880000)
        self.assertEqual(successor(-885900, parent=low, inverse=True), (None, 'successor_range_unavailable'))


class GeometryPropertyTests(unittest.TestCase):
    def brute_top(self, floor_tick, basis, upside, spacing, inverse):
        """The first aligned tick past the floor whose price reaches the basis by the upside, walking one by one."""
        step = -spacing if inverse else spacing
        tick = floor_tick + step
        while domino.MIN_TICK <= tick <= domino.MAX_TICK:
            if domino.oriented_at_least(at(tick), basis, 10_000 + upside, inverse):
                return tick
            tick += step
        return None

    def test_every_range_returned_is_the_vaults_and_the_first_one(self):
        rng = random.Random(2026)
        checked = refused = 0
        for _ in range(400):
            spacing = rng.choice((1, 10, 60, 200))
            inverse = rng.random() < 0.5
            width = spacing * rng.randrange(1, 300)
            lower = spacing * rng.randrange(-2000, 2000)
            parent = Member(1, lower, lower + width)
            policy = {'trigger_bps': rng.randrange(0, 2001), 'overlap_bps': rng.choice((0, rng.randrange(0, 2001))),
                      'upside_bps': rng.randrange(1, 30_001), 'spacing': spacing}
            ceiling = parent.tick_lower if inverse else parent.tick_upper
            offset = rng.randrange(-width, 3 * spacing + 200)
            anchor = at(ceiling - offset if inverse else ceiling + offset) + rng.randrange(0, 2**60)
            found, reason = domino.successor_range(parent, anchor, inverse=inverse, **policy)
            cell = (tick_at_sqrt(anchor) // spacing) * spacing
            if not domino.near_ceiling(parent, anchor, policy['trigger_bps'], inverse):
                self.assertEqual((found, reason), (None, 'successor_not_due'))
                continue
            basis = anchor if domino.past_ceiling(parent, anchor, inverse) else at(ceiling)
            floor_tick = cell + spacing if inverse else cell
            top = self.brute_top(floor_tick, basis, policy['upside_bps'], spacing, inverse)
            expected = None if top is None else ((top, floor_tick) if inverse else (floor_tick, top))
            if expected is not None and not domino.check_successor(parent, *expected, anchor, inverse=inverse, **policy):
                expected = None
            if expected is None:
                refused += 1
                self.assertEqual((found, reason), (None, 'successor_range_unavailable'))
            else:
                checked += 1
                self.assertEqual(found, expected)
                lower, upper = found
                self.assertTrue(domino.MIN_TICK <= lower < upper <= domino.MAX_TICK)
                self.assertEqual((lower % spacing, upper % spacing), (0, 0))
                self.assertTrue(domino.in_range(Member(0, *found), anchor))
        self.assertGreater(checked, 50)
        self.assertGreater(refused, 10)


class HelperTests(unittest.TestCase):
    def test_the_searches_return_the_extreme_that_holds_or_nothing(self):
        self.assertEqual(domino._first(lambda k: k >= 7, 0, 10), 7)
        self.assertEqual(domino._first(lambda k: k >= 0, 0, 10), 0)
        self.assertIsNone(domino._first(lambda k: k >= 11, 0, 10))
        self.assertIsNone(domino._first(lambda k: True, 5, 4))
        self.assertEqual(domino._last(lambda k: k <= 7, 0, 10), 7)
        self.assertEqual(domino._last(lambda k: k <= 10, 0, 10), 10)
        self.assertIsNone(domino._last(lambda k: k < 0, 0, 10))
        self.assertIsNone(domino._last(lambda k: True, 5, 4))

    def test_the_full_range_is_the_widest_aligned_one(self):
        self.assertEqual(domino.full_range(60), (-887220, 887220))
        self.assertEqual(domino.full_range(1), (-887272, 887272))
        self.assertEqual(domino.full_range(10), (-887270, 887270))


class RoutingVectorTests(unittest.TestCase):
    CHILD = Member(2, 5400, 10080)
    PARENT = ROOT._replace(successor=2)

    def routable(self, source, destination, anchor_tick, *, mint=False, target=1):
        return domino.routable(source, destination, mint=mint, target=target, anchor=at(anchor_tick),
                               trigger_bps=500, inverse=False)

    def test_the_vaults_routing_cases(self):
        # A parent near its ceiling funds its successor; far from it, it does not.
        self.assertTrue(self.routable(self.PARENT, self.CHILD, 5800, target=2))
        self.assertFalse(self.routable(self.PARENT, self.CHILD, 0, target=2))
        # Fees return to their own position, whatever the price.
        self.assertTrue(self.routable(self.CHILD, self.CHILD, 20000, target=2))
        # A position the price left funds one the price is in.
        self.assertTrue(self.routable(self.CHILD, self.PARENT, 0, target=1))
        # A position the price is in funds nothing else.
        self.assertFalse(self.routable(self.CHILD, self.PARENT, 5800, target=1))
        # Near its own ceiling a position funds only its successor (the child has none).
        self.assertFalse(self.routable(self.CHILD, self.PARENT, 9800, target=1))
        # Nothing funds a position the price is not in.
        self.assertFalse(self.routable(self.CHILD, self.PARENT, 20000, target=1))

    def test_a_mint_is_funded_by_its_parent_near_the_ceiling_and_by_members_the_price_left(self):
        new = Member(0, 5760, 10080)
        self.assertTrue(self.routable(ROOT, new, 5800, mint=True, target=1))
        self.assertFalse(self.routable(ROOT, new, 5400, mint=True, target=1))  # below the trigger
        other = Member(3, -12000, -6000)  # a member the price has left
        self.assertTrue(self.routable(other, new, 5800, mint=True, target=1))
        self.assertFalse(self.routable(other, Member(0, 6000, 10080), 5800, mint=True, target=1))
        # An in-range member that is not the parent funds no mint, not even the parent's own parent.
        self.assertFalse(self.routable(Member(4, 5000, 6600), new, 5800, mint=True, target=1))
        grandparent = Member(5, 5000, 6100, successor=1)  # in range at 5800 and near its ceiling
        self.assertFalse(self.routable(grandparent, new, 5800, mint=True, target=1))


if __name__ == '__main__':
    unittest.main()
