"""Evidence and observation arithmetic, offline: pool-spot prices, tick walk, swap cap, gas, samples."""
from fractions import Fraction
import json
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import execution_cases as cases
import execution_models as m
import execution_planner as p
import test_execution_planner as tp
from automation_config import GasPoolKey, impact_bounds, validate_config
from automation_evidence import (PPM, _next_initialized, build_evidence, engine_minimum_output, exposure_ppm, price_evidence,
                                 price_impact_bps, quote_per_wei, ratio_bps, ratio_ceil_bps, simulate_exact_input, swap_amounts,
                                 swap_cap, swap_fee_pips)
from automation_fixtures import FakeChainReader, address, gas_pool, identity, sample_automation_config, sample_config
from automation_observer import ObservationContext, ObservationError, PoolState, measurement_history, sample_pool
from execution_cases import identity as cid
from execution_v4_adapter import rebuild_v4
from v4_math import MAX_SQRT, MIN_SQRT, Q96, sqrt_at_tick, swap_step

C0, C1 = address(16), address(32)


def changed(record, **values):
    return type(record).model_validate_json(json.dumps({**record.model_dump(mode='json'), **values}))


def v4_setup(**kwargs):
    original = cases.sequence
    with patch.object(cases, 'sequence', side_effect=lambda **kw: changed(original(**kw), implementationVersion='4')):
        return tp.setup(**kwargs)


def reader(**kwargs):
    defaults = dict(sqrt_price=2**96, tick=0, lp_fee=3000, spacing=60, ranges=[(-600, 600, 10**18)])
    return FakeChainReader(**{**defaults, **kwargs})


def context(obs, rd, member_liquidity=10**17):
    pool = PoolState(rd.sqrt_price, rd.tick, rd.protocol_fee, rd.lp_fee, rd.liquidity, *rd.fee_growth)
    return ObservationContext(observation=obs, checkpoints={c.position.tokenId: cid(701) for c in obs.positions},
        member_liquidity={c.position.tokenId: member_liquidity for c in obs.positions}, last_execution_at=0, pool=pool, block=rd.head(), diagnostics=())


def admission_for(obs, config):
    import execution_v4 as v4
    import general_compound_receipts as g
    d = config.deployment
    pins = tuple(g.RuntimePin(address=a, codeHash=cid(900 + i)) for i, a in enumerate((obs.sequence.vault, d.factory, d.implementation, d.poolManager,
        d.positionManager, d.stateView, d.readHelper, d.engine, d.routing, d.priceGuard)))
    return v4.Admission(sequence=obs.sequence, stateView=d.stateView, readHelper=d.readHelper, executionEngine=d.engine,
                        routingHelper=d.routing, priceGuard=d.priceGuard, pricePublisher=d.pricePublisher, runtimePins=pins)


class BitmapTests(unittest.TestCase):
    def test_next_initialized_matches_a_brute_force_search(self):
        rng = random.Random(7)
        for _ in range(200):
            spacing = rng.choice((1, 10, 60, 200))
            ticks = {rng.randrange(-4000, 4000) // spacing * spacing for _ in range(rng.randrange(0, 12))}
            def bitmap(word):
                bits = 0
                for t in ticks:
                    c = t // spacing
                    if c >> 8 == word:
                        bits |= 1 << (c & 255)
                return bits
            tick = rng.randrange(-4000, 4000)
            for zero_for_one in (True, False):
                found, initialized = _next_initialized(bitmap, tick, spacing, zero_for_one)
                compressed = tick // spacing
                if zero_for_one:
                    word_low = (compressed >> 8) << 8
                    candidates = [t for t in ticks if word_low * spacing <= t <= compressed * spacing]
                    expected = (max(candidates), True) if candidates else (word_low * spacing, False)
                else:
                    word_high = ((compressed + 1) >> 8 << 8) + 255
                    candidates = [t for t in ticks if (compressed + 1) * spacing <= t <= word_high * spacing]
                    expected = (min(candidates), True) if candidates else (word_high * spacing, False)
                self.assertEqual((found, initialized), expected, (ticks, tick, spacing, zero_for_one))


class SimulatorTests(unittest.TestCase):
    def key(self):
        return m.PoolKey(currency0=C0, currency1=C1, fee_pips=3000, tick_spacing=60, hooks=m.ZERO)

    def test_single_range_step_equals_the_core_step_math(self):
        rd = reader()
        pool = PoolState(rd.sqrt_price, rd.tick, 0, 3000, rd.liquidity, 0, 0)
        limit = impact_bounds(2**96, 50)[0]
        result = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=True, amount_in=10**15, price_limit=limit, max_steps=8)
        end, amount_in, amount_out, charge = swap_step(2**96, max(sqrt_at_tick(-600), limit), 10**18, -10**15, 3000)
        self.assertEqual(amount_in + charge, 10**15)
        # Tick 0 sits on a spacing boundary without being initialized, so the
        # core's first iteration is an empty step to its own price; the walk
        # mirrors that and the amounts are the single real step's.
        self.assertEqual((result['amountOut'], result['afterPrice'], result['steps']), (amount_out, end, 2))
        # Selling the other way walks up to the upper tick's word instead.
        upper = impact_bounds(2**96, 50)[1]
        other = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=False, amount_in=10**15, price_limit=upper, max_steps=8)
        self.assertGreater(other['amountOut'], 0)
        self.assertGreater(other['afterPrice'], 2**96)

    def test_crossing_a_range_boundary_changes_liquidity_and_the_limit_refuses_partial_fills(self):
        rd = reader(ranges=[(-600, 600, 10**18), (-1200, 1200, 5 * 10**17)])
        pool = PoolState(rd.sqrt_price, rd.tick, 0, 3000, rd.liquidity, 0, 0)
        self.assertEqual(pool.liquidity, 15 * 10**17)
        # Enough input to push below tick -600 where only the wide range remains.
        big = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=True, amount_in=5 * 10**16, price_limit=sqrt_at_tick(-1100), max_steps=8)
        self.assertIsNotNone(big)
        self.assertGreaterEqual(big['steps'], 2)
        self.assertLess(big['afterPrice'], sqrt_at_tick(-600))
        tight = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=True, amount_in=10**17, price_limit=sqrt_at_tick(-60), max_steps=8)
        self.assertIsNone(tight)
        # A dynamic-fee pool (the LP fee is not the key's static fee) and an
        # invalid protocol fee are refused; a valid protocol fee is not.
        for protocol_fee, lp_fee in ((0, 500), (1001, 3000), (1001 << 12, 3000)):
            with self.assertRaisesRegex(ObservationError, 'pool_fee_unqualified'):
                simulate_exact_input(rd, address(20), self.key(), cid(1), PoolState(2**96, 0, protocol_fee, lp_fee, 10**18, 0, 0), rd.head(),
                                     zero_for_one=True, amount_in=10**15, price_limit=sqrt_at_tick(-600), max_steps=8)

    def test_a_protocol_fee_composes_into_the_swap_fee_as_the_core_does(self):
        # ProtocolFeeLibrary.calculateSwapFee: protocol + lp - protocol * lp / 1e6, per direction.
        self.assertEqual(swap_fee_pips(0, 3000, True), 3000)
        self.assertEqual(swap_fee_pips(52 | (52 << 12), 200, True), 252)          # the WETH/USDG pool on 4663
        self.assertEqual(swap_fee_pips(52 | (52 << 12), 200, False), 252)
        self.assertEqual(swap_fee_pips(1000 | (30 << 12), 3000, True), 1000 + 3000 - 3)
        self.assertEqual(swap_fee_pips(1000 | (30 << 12), 3000, False), 30 + 3000 - 0)
        for bad in ((1001, 3000, True), (1001 << 12, 3000, False), (52, 10**6, True), (1 << 24, 3000, True), (-1, 3000, True)):
            with self.assertRaisesRegex(ObservationError, 'pool_fee_unqualified'):
                swap_fee_pips(*bad)
        # The walk with a protocol fee is the core's step with the composed fee, in both directions.
        rd = reader(ranges=[(-600, 600, 10**18)])
        packed = 52 | (30 << 12)
        for zero_for_one, fee in ((True, 52 + 3000 - 0), (False, 30 + 3000 - 0)):
            pool = PoolState(rd.sqrt_price, rd.tick, packed, 3000, rd.liquidity, 0, 0)
            lower, upper = impact_bounds(2**96, 50)
            limit = lower if zero_for_one else upper
            result = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=zero_for_one,
                                          amount_in=10**15, price_limit=limit, max_steps=8)
            target = max(sqrt_at_tick(-600), limit) if zero_for_one else min(sqrt_at_tick(600), upper)
            end, amount_in, amount_out, charge = swap_step(2**96, target, 10**18, -10**15, fee)
            self.assertEqual(amount_in + charge, 10**15)
            self.assertEqual((result['amountOut'], result['afterPrice']), (amount_out, end))
            plain = simulate_exact_input(rd, address(20), self.key(), cid(1), PoolState(rd.sqrt_price, rd.tick, 0, 3000, rd.liquidity, 0, 0), rd.head(),
                                         zero_for_one=zero_for_one, amount_in=10**15, price_limit=limit, max_steps=8)
            self.assertLess(result['amountOut'], plain['amountOut'])

    def test_ratio_and_minimum_output_replicate_the_contract_arithmetic(self):
        anchor = 2**96
        for after in (anchor, anchor * 9995 // 10000, anchor * 10007 // 10000):
            with self.subTest(after=after):
                exact = Fraction(after * after * 10000, anchor * anchor)
                self.assertEqual(ratio_bps(after, anchor), exact.numerator // exact.denominator)
                self.assertEqual(ratio_ceil_bps(after, anchor), -(-exact.numerator // exact.denominator))
        self.assertEqual(price_impact_bps(anchor, anchor), 0)
        self.assertEqual(price_impact_bps(anchor * 9995 // 10000, anchor), 10000 - ratio_bps(anchor * 9995 // 10000, anchor))
        for price in (2**96, 2**90, 2**130):
            for zero_for_one in (True, False):
                exact = Fraction(price * price, 1 << 192)
                quote = (exact if zero_for_one else 1 / exact) * 10**12
                expected = int(quote) * 9900 // 10000 if price <= 2**128 - 1 else None
                got = engine_minimum_output(10**12, price, zero_for_one, 100)
                if expected is not None:
                    self.assertEqual(got, expected, (price, zero_for_one))
                else:
                    self.assertLessEqual(got, int(quote) * 9900 // 10000)
                    self.assertGreater(got, int(quote) * 9899 // 10000 - 2)


class PricingTests(unittest.TestCase):
    def setUp(self):
        self.obs, self.hist, self.cfg = v4_setup()
        self.config = sample_automation_config()
        self.admission = admission_for(self.obs, self.config)

    def test_the_pool_spot_is_the_anchor_with_no_reference_and_no_gate(self):
        rd = reader()
        prices, reasons = price_evidence(context(self.obs, rd), self.admission, 10)
        self.assertEqual(reasons, ())
        self.assertEqual(self.obs.sequence.quoteCurrency, C1)
        self.assertEqual((prices[1].lower.fraction(), prices[1].upper.fraction()), (1, 1))
        self.assertEqual((prices[0].lower.fraction(), prices[0].upper.fraction()), (Fraction(9990, 10000), Fraction(10010, 10000)))
        # A pool that moved 21% since the last sample is priced where it is:
        # no average, no external reference, no calm-market condition.
        moved = reader(sqrt_price=2**96 * 11 // 10)
        spot = Fraction((2**96 * 11 // 10) ** 2, 2**192)
        prices, reasons = price_evidence(context(self.obs, moved), self.admission, 10)
        self.assertEqual(reasons, ())
        self.assertEqual((prices[0].lower.fraction(), prices[0].upper.fraction()), (spot * Fraction(9990, 10000), spot * Fraction(10010, 10000)))
        self.assertEqual(price_evidence(context(self.obs, moved), self.admission, 0)[0][0].lower.fraction(), spot)
        # A pool with no price (never initialized) or outside the core's domain has none to anchor on.
        for sqrt_price in (0, MIN_SQRT - 1, MAX_SQRT):
            self.assertEqual(price_evidence(context(self.obs, reader(sqrt_price=sqrt_price)), self.admission, 10), (None, ('price_unqualified',)))
        # Quoted in currency0, the other side is the inverted band.
        obs, _, _ = v4_setup(reverse=True)
        prices, _ = price_evidence(context(obs, moved), admission_for(obs, self.config), 10)
        self.assertEqual((prices[0].lower.fraction(), prices[0].upper.fraction()), (1, 1))
        self.assertEqual((prices[1].lower.fraction(), prices[1].upper.fraction()), (1 / (spot * Fraction(10010, 10000)), 1 / (spot * Fraction(9990, 10000))))

    def test_gas_is_one_to_one_in_the_native_asset_and_its_wrapper_else_priced_through_the_admitted_pool(self):
        pricing = self.config.pricing
        ctx = context(self.obs, reader())
        self.assertEqual(quote_per_wei(reader(), ctx, pricing, m.ZERO, address(20)), 1)
        self.assertEqual(quote_per_wei(reader(), ctx, pricing, pricing.wrappedNative, address(20)), 1)
        pool = GasPoolKey(**gas_pool(C1)).pool_id()
        # 50**2 = 2500 atoms of C1 per wei, rounded against the operator by the buffer.
        rd = reader(pools={pool: (2**96 * 50, 10**20)})
        self.assertEqual(quote_per_wei(rd, ctx, pricing, C1, address(20)), 2500)
        buffered = sample_automation_config(pricing={'gasPriceBufferBps': 100}).pricing
        self.assertEqual(quote_per_wei(rd, ctx, buffered, C1, address(20)), 2525)
        # The wrapper as currency1: the quote is currency0 and the spot inverts.
        high = address(0xFFFF)
        inverted = sample_automation_config(pricing={'wrappedNative': high, 'gasPools': {
            C0: {'currency0': C0, 'currency1': high, 'fee': 500, 'tickSpacing': 10, 'hooks': m.ZERO}}}).pricing
        key = GasPoolKey(currency0=C0, currency1=high, fee=500, tickSpacing=10, hooks=m.ZERO).pool_id()
        self.assertEqual(quote_per_wei(reader(pools={key: (2**96 // 4, 10**20)}), ctx, inverted, C0, address(20)), 16)
        with self.assertRaisesRegex(ObservationError, 'gas_price_source_missing'):
            quote_per_wei(rd, ctx, pricing, address(0x5555), address(20))
        for empty in ((2**96 * 50, 0), (0, 10**20)):
            with self.subTest(empty=empty), self.assertRaisesRegex(ObservationError, 'gas_price_unavailable'):
                quote_per_wei(reader(pools={pool: empty}), ctx, pricing, C1, address(20))
        # In the evidence, an unpriceable quote leaves it unqualified with the reason.
        raw = sample_config()
        raw['pricing']['gasPools'] = {}
        self.assertEqual(build_evidence(rd, ctx, self.admission, [], validate_config(raw), self.cfg), (None, ('gas_price_source_missing',)))

    def test_full_evidence_lets_the_planner_choose_and_the_wire_rebuild(self):
        # A pool whose liquidity is comparable to the sequence's fees, so the
        # share of fee flow the addition earns is not vanishing, and gas at a
        # zero base fee: the same scale the planner's own tests use.
        rd = reader(ranges=[(-120, 120, 10**5)], base_fee=0)
        cheap = sample_automation_config(gas={'priorityFeePerGasWei': 0})
        ctx = context(self.obs, rd, member_liquidity=10**4)
        samples = [{'block_number': 1200 + i, 'block_timestamp': 1700000000 - 600 + i * 100, 'liquidity': 10**5, 'tick': 0, 'qualified': True} for i in range(6)]
        evidence, reasons = build_evidence(rd, ctx, self.admission, samples, cheap, self.cfg)
        self.assertEqual(reasons, ())
        self.assertTrue(evidence.qualified and evidence.destinations)
        depth = evidence.destinations[0]
        self.assertEqual((depth.totalActiveLiquidity, depth.ownerActiveLiquidity, depth.activeFractionBps), (10**5, 10**4, 10000))
        self.assertEqual(depth.minimumCompetingLiquidity, (10**5 - 10**4) * 9000 // 10000)
        self.assertEqual(depth.maximumTotalLiquidity, 10**5 * 11000 // 10000)
        self.assertEqual((depth.directGasWei, depth.directGasQuote), (1, 1))
        decision = p.plan(self.obs, self.hist, self.cfg, evidence, now=tp.NOW)
        self.assertEqual(decision.action, 'compound_self', decision.reasons)
        for quote in evidence.swaps:
            self.assertEqual(quote.slippageBps, 50)
            self.assertLessEqual(quote.priceImpactBps, self.obs.policy.limits.maxPriceImpactBps)
            self.assertLessEqual(int(quote.bounds.minAmountOutRaw), quote.expectedAmountOutRaw)
        # Gas is the whole path at the buffered base fee, plus the data component when the node reports one.
        priced = reader(ranges=[(-120, 120, 10**5)])
        evidence, _ = build_evidence(priced, context(self.obs, priced, 10**4), self.admission, samples, self.config, self.cfg)
        self.assertEqual(evidence.destinations[0].directGasWei, (160000 + 1200000) * 8)
        self.assertEqual(evidence.destinations[0].directGasQuote, (160000 + 1200000) * 8)
        # Three publications expected per completed cycle: the operator's cost
        # carries the two failed ones; the per-transaction gas does not.
        evidence, _ = build_evidence(priced, context(self.obs, priced, 10**4), self.admission, samples, self.config, self.cfg, attempts=Fraction(3))
        self.assertEqual(evidence.destinations[0].directGasWei, (160000 + 1200000) * 8)
        self.assertEqual(evidence.destinations[0].directGasQuote, (3 * 160000 + 1200000) * 8)
        self.assertEqual(build_evidence(priced, context(self.obs, priced, 10**4), self.admission, samples, self.config, self.cfg,
                                        attempts=Fraction(1, 2)), (None, ('swap_exposure_unavailable',)))
        node = reader(ranges=[(-120, 120, 10**5)], node_interface=False)
        strict = sample_automation_config(gas={'l1DataComponent': 'node_interface'})
        evidence, reasons = build_evidence(node, context(self.obs, node, 10**4), self.admission, samples, strict, self.cfg)
        self.assertIsNone(evidence)
        self.assertEqual(reasons, ('gas_unavailable',))
        with_node = reader(ranges=[(-120, 120, 10**5)])
        evidence, _ = build_evidence(with_node, context(self.obs, with_node, 10**4), self.admission, samples, strict, self.cfg)
        self.assertEqual(evidence.destinations[0].directGasWei, (160000 + 1200000 + (196 + 2048) * 16) * 8)

    def test_swap_amounts_follow_the_surplus_side(self):
        dest = m.Destination(createChild=False, tokenId='101', tickLower=-120, tickUpper=120)
        balanced = self.obs
        surplus, amounts = swap_amounts(balanced, dest, 2**96, (5000, 10000), 100)
        self.assertEqual(amounts, ())  # one idle atom is below the quoting floor
        lopsided = tp.replace(balanced, balances=(balanced.balances[0],))
        surplus, amounts = swap_amounts(lopsided, dest, 2**96, (5000, 10000), 100)
        self.assertEqual(surplus, 0)
        self.assertEqual(amounts, (480, 960))  # 1000 gross at 4% = 960 net, halves


class SwapCapTests(unittest.TestCase):
    def cap(self, rd, zero_for_one, *, impact=100, multiplier=10000, max_steps=64, protocol_fee=0):
        key = m.PoolKey(currency0=C0, currency1=C1, fee_pips=3000, tick_spacing=rd.spacing, hooks=m.ZERO)
        pool = PoolState(rd.sqrt_price, rd.tick, protocol_fee, 3000, rd.liquidity, 0, 0)
        lower, upper = impact_bounds(rd.sqrt_price, impact)
        return swap_cap(rd, address(20), key, cid(1), pool, rd.head(), zero_for_one=zero_for_one,
                        bound=lower if zero_for_one else upper, multiplier_bps=multiplier, max_steps=max_steps)

    def test_the_cap_is_fee_times_depth_in_the_input_currency(self):
        # One range across the band, price one: L x fee in either currency.
        rd = reader(ranges=[(-600, 600, 10**18)])
        self.assertEqual((self.cap(rd, True), self.cap(rd, False)), (3 * 10**15, 3 * 10**15))
        self.assertEqual(self.cap(rd, True, multiplier=2500), 75 * 10**13)
        # At price four (square root two) a currency0 atom is worth four of
        # currency1: the same depth caps currency0 at L x fee / 2 and
        # currency1 at L x fee x 2.
        two = reader(sqrt_price=2 * 2**96, tick=13863, ranges=[(13200, 14400, 10**18)])
        self.assertEqual((self.cap(two, True), self.cap(two, False)), (15 * 10**14, 6 * 10**15))
        # The protocol fee counts, the lower direction's: 52 + 3000 against 30 + 3000.
        self.assertEqual(self.cap(rd, True, protocol_fee=52 | (30 << 12)), 3030 * 10**12)

    def test_depth_is_the_least_running_average_inside_the_owner_band(self):
        # A second range adds depth above tick -60 only. Selling currency0
        # walks out of it inside a 1% band: the push to the band's edge pays
        # 1.5 L down to tick -60 and L beyond, and that average is the least.
        rd = reader(ranges=[(-600, 600, 10**18), (-60, 600, 5 * 10**17)])
        spot, edge, mid = 2**96, impact_bounds(2**96, 100)[0], sqrt_at_tick(-60)
        self.assertTrue(edge < mid < spot)
        average = Fraction(15 * 10**17 * (spot - mid) + 10**18 * (mid - edge), spot - edge)
        self.assertEqual(self.cap(rd, True), int(average * 3000 / 10**6))
        self.assertLess(self.cap(rd, True), 45 * 10**14)
        self.assertGreater(self.cap(rd, True), 3 * 10**15)
        # Buying never leaves the deeper range inside the band; a narrower
        # band never reaches tick -60 either.
        self.assertEqual(self.cap(rd, False), 45 * 10**14)
        self.assertLess(mid, impact_bounds(2**96, 50)[0])
        self.assertEqual(self.cap(rd, True, impact=50), 45 * 10**14)
        # A gap right below the spot: the first push is free, so no swap that
        # way; the other direction keeps its depth.
        gap = reader(ranges=[(-600, -60, 10**18), (0, 600, 10**18)])
        self.assertEqual((self.cap(gap, True), self.cap(gap, False)), (0, 3 * 10**15))
        # A gap farther out lowers the cap in proportion instead of zeroing it.
        far = reader(ranges=[(-60, 600, 10**18)])
        average = Fraction(10**18 * (spot - mid), spot - edge)
        self.assertEqual(self.cap(far, True), int(average * 3000 / 10**6))
        # A walk longer than admitted leaves the cap unmeasured, not assumed.
        dense = reader(spacing=1, ranges=[(-t, t, 10**15) for t in range(1, 80)])
        self.assertIsNone(self.cap(dense, True, max_steps=10))
        self.assertGreater(self.cap(dense, True, max_steps=200), 0)
        # A spot on the band's edge (no impact admitted) leaves nothing to cap.
        self.assertEqual(self.cap(rd, True, impact=0), 0)

    def test_exposure_is_a_share_of_the_cap_rounded_up(self):
        self.assertEqual(exposure_ppm(1, 3 * 10**6), 1)
        self.assertEqual(exposure_ppm(3 * 10**6, 3 * 10**6), PPM)
        self.assertEqual(exposure_ppm(3 * 10**6 + 1, 3 * 10**6), PPM + 1)
        self.assertEqual(exposure_ppm(480, 3 * 10**6), 160)
        self.assertIsNone(exposure_ppm(1, 0))
        self.assertIsNone(exposure_ppm(1, None))

    def test_quotes_stay_inside_what_the_pool_cap_has_left(self):
        obs, hist, cfg = v4_setup()
        # Fees in currency0 only, and the app's default impact limit of 1%.
        limits = tp.replace(obs.policy.limits, maxPriceImpactBps=100)
        lopsided = tp.replace(obs, balances=(obs.balances[0],), policy=tp.replace(obs.policy, limits=limits))
        config = sample_automation_config()
        admission = admission_for(lopsided, config)
        rd = reader(ranges=[(-120, 120, 10**9)], base_fee=0)
        ctx = context(lopsided, rd, member_liquidity=10**8)
        samples = [{'block_number': 1200 + i, 'block_timestamp': 1700000000 - 600 + i * 100, 'liquidity': 10**9, 'tick': 0, 'qualified': True} for i in range(6)]
        def quoted(used):
            notes = {}
            evidence, reasons = build_evidence(rd, ctx, admission, samples, config, cfg, used_ppm=used, notes=notes)
            self.assertEqual(reasons, ())
            self.assertTrue(evidence.destinations)
            return sorted({int(q.bounds.amountInRaw) for q in evidence.swaps}), notes
        amounts, notes = quoted(0)
        self.assertEqual(amounts, [240, 480, 720, 960])
        # fee 3000 pips x depth 10**9 at price one: 3,000,000 atoms of currency0.
        self.assertEqual(notes['swapCap'], {'windowBlocks': 256, 'usedPpm': 0, 'directions': {'zeroForOne': str(3 * 10**6)}})
        self.assertEqual(notes['caps'], {True: 3 * 10**6})
        self.assertEqual([exposure_ppm(a, 3 * 10**6) for a in amounts], [80, 160, 240, 320])
        # Other vaults hold all but 200 ppm: the two smaller swaps still fit;
        # with nothing left none does, and the direct addition stays open.
        self.assertEqual(quoted(PPM - 200)[0], [240, 480])
        self.assertEqual(quoted(PPM)[0], [])
        self.assertEqual(build_evidence(rd, ctx, admission, samples, config, cfg, used_ppm=PPM + 1), (None, ('swap_exposure_unavailable',)))
        # The act path re-quotes only the destinations it names.
        full, _ = build_evidence(rd, ctx, admission, samples, config, cfg)
        first = full.destinations[0].destination.digest()
        only, _ = build_evidence(rd, ctx, admission, samples, config, cfg, only=frozenset({first}))
        self.assertEqual([d.destination.digest() for d in only.destinations], [first])
        self.assertTrue(all(q.destination.digest() == first for q in only.swaps))
        self.assertEqual(build_evidence(rd, ctx, admission, samples, config, cfg, only=frozenset())[0].destinations, ())
        self.assertNotEqual(only.evidenceId, full.evidenceId)


class SamplerTests(unittest.TestCase):
    def test_samples_accumulate_inside_an_epoch_and_restart_on_gaps_or_empty_pools(self):
        rd = reader(fee_growth=(1 << 128, 2 << 128))
        first = sample_pool(rd, address(20), cid(1), rd.head(), None, max_gap_seconds=600, sampler_version='pool-fee-sampler-1')
        self.assertEqual((first['cumulative_fee0'], first['cumulative_liquidity_seconds'], first['coverage_complete'], first['qualified']), (0, 0, True, True))
        rd.fee_growth = [3 << 128, 2 << 128]
        rd.block = {**rd.block, 'number': 1240, 'hash': identity(1240), 'timestamp': 1700000010}
        second = sample_pool(rd, address(20), cid(1), rd.head(), first, max_gap_seconds=600, sampler_version='pool-fee-sampler-1')
        self.assertEqual(second['epoch'], first['epoch'])
        self.assertEqual(second['cumulative_fee0'], 2 * 10**18)
        self.assertEqual(second['cumulative_fee1'], 0)
        self.assertEqual(second['cumulative_liquidity_seconds'], 10 * 10**18)
        rd.block = {**rd.block, 'number': 1300, 'hash': identity(1300), 'timestamp': 1700000700}
        gap = sample_pool(rd, address(20), cid(1), rd.head(), second, max_gap_seconds=600, sampler_version='pool-fee-sampler-1')
        self.assertNotEqual(gap['epoch'], second['epoch'])
        self.assertEqual(gap['cumulative_fee0'], 0)
        rd.block = {**rd.block, 'number': 1301, 'hash': identity(1301), 'timestamp': 1700000700}
        self.assertIsNone(sample_pool(rd, address(20), cid(1), rd.head(), gap, max_gap_seconds=600, sampler_version='pool-fee-sampler-1'))
        rd.ranges = []
        rd.block = {**rd.block, 'number': 1310, 'hash': identity(1310), 'timestamp': 1700000710}
        empty = sample_pool(rd, address(20), cid(1), rd.head(), gap, max_gap_seconds=600, sampler_version='pool-fee-sampler-1')
        self.assertFalse(empty['qualified'])
        rd.block = {**rd.block, 'number': 1200, 'hash': identity(1200), 'timestamp': 1700000720}
        with self.assertRaisesRegex(ObservationError, 'sample_order'):
            sample_pool(rd, address(20), cid(1), rd.head(), empty, max_gap_seconds=600, sampler_version='pool-fee-sampler-1')

    def test_history_keeps_one_epoch_of_coherent_samples(self):
        rows = []
        for i in range(5):
            rows.append({'epoch': cid(1 if i < 2 else 2), 'block_number': 1000 + i, 'block_hash': identity(1000 + i), 'block_timestamp': 1700000000 + 10 * i,
                         'cumulative_fee0': 100 * i, 'cumulative_fee1': 0, 'cumulative_liquidity_seconds': 10**18 * (i + 1),
                         'coverage_complete': True, 'qualified': i != 3, 'evidence_id': identity(2000 + i)})
        history = measurement_history(cid(11), rows, waiting_since=1699999000, last_attempt_at=1700000100, last_read_failed=False)
        self.assertEqual([s.blockNumber for s in history.samples], [1002, 1004])
        self.assertTrue(all(s.epoch == cid(2) for s in history.samples))
        empty = measurement_history(cid(11), [], waiting_since=1, last_attempt_at=2, last_read_failed=True)
        self.assertEqual(empty.samples, ())


if __name__ == '__main__':
    unittest.main()
