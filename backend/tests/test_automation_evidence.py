"""Evidence and observation arithmetic, offline: references, tick walk, gas, samples."""
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
from automation_config import price_bounds
from automation_evidence import (_next_initialized, build_evidence, engine_minimum_output, price_evidence, price_impact_bps,
                                 quote_per_wei, ratio_bps, ratio_ceil_bps, simulate_exact_input, swap_amounts)
from automation_fixtures import FakeChainReader, address, identity, sample_automation_config
from automation_observer import ObservationContext, ObservationError, PoolState, measurement_history, sample_pool
from execution_cases import identity as cid
from execution_v4_adapter import rebuild_v4
from v4_math import Q96, sqrt_at_tick, swap_step

C0, C1 = address(16), address(32)
FEEDS = {address(0x1001): (8, 'FIXTURE / USD', 7, 10**8, 1700000000), address(0x1002): (8, 'FIXTURE / USD', 7, 10**8, 1700000000),
         address(0x1003): (8, 'FIXTURE / USD', 7, 10**8, 1700000000)}


def changed(record, **values):
    return type(record).model_validate_json(json.dumps({**record.model_dump(mode='json'), **values}))


def v4_setup(**kwargs):
    original = cases.sequence
    with patch.object(cases, 'sequence', side_effect=lambda **kw: changed(original(**kw), implementationVersion='4')):
        return tp.setup(**kwargs)


def reader(**kwargs):
    defaults = dict(sqrt_price=2**96, tick=0, lp_fee=3000, spacing=60, ranges=[(-600, 600, 10**18)], feeds=FEEDS)
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
        limit = price_bounds(2**96, 25, 100)[0]
        result = simulate_exact_input(rd, address(20), self.key(), cid(1), pool, rd.head(), zero_for_one=True, amount_in=10**15, price_limit=limit, max_steps=8)
        end, amount_in, amount_out, charge = swap_step(2**96, max(sqrt_at_tick(-600), limit), 10**18, -10**15, 3000)
        self.assertEqual(amount_in + charge, 10**15)
        # Tick 0 sits on a spacing boundary without being initialized, so the
        # core's first iteration is an empty step to its own price; the walk
        # mirrors that and the amounts are the single real step's.
        self.assertEqual((result['amountOut'], result['afterPrice'], result['steps']), (amount_out, end, 2))
        # Selling the other way walks up to the upper tick's word instead.
        upper = price_bounds(2**96, 25, 100)[1]
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
        with self.assertRaisesRegex(ObservationError, 'pool_fee_unqualified'):
            simulate_exact_input(rd, address(20), self.key(), cid(1), PoolState(2**96, 0, 1000, 3000, 10**18, 0, 0), rd.head(),
                                 zero_for_one=True, amount_in=10**15, price_limit=sqrt_at_tick(-600), max_steps=8)

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


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.obs, self.hist, self.cfg = v4_setup()
        self.config = sample_automation_config()
        self.admission = admission_for(self.obs, self.config)

    def test_pool_spot_qualifies_only_beside_fresh_agreeing_references(self):
        rd = reader()
        prices, reasons, refs = price_evidence(rd, context(self.obs, rd), self.config.references, self.admission)
        self.assertEqual(reasons, ())
        quote_index = (C0, C1).index(self.obs.sequence.quoteCurrency)
        self.assertEqual(prices[quote_index].lower.fraction(), 1)
        base = prices[1 - quote_index]
        self.assertLessEqual(base.lower.fraction(), 1)
        self.assertGreaterEqual(base.upper.fraction(), 1)
        self.assertEqual(quote_per_wei(refs, self.obs.sequence.quoteCurrency, 0), 1)
        stale = reader(feeds={**FEEDS, address(0x1001): (8, 'FIXTURE / USD', 7, 10**8, 1700000000 - 90000)})
        self.assertEqual(price_evidence(stale, context(self.obs, stale), self.config.references, self.admission)[1], ('reference_stale',))
        divergent = reader(feeds={**FEEDS, address(0x1001): (8, 'FIXTURE / USD', 7, 2 * 10**8, 1700000000)})
        self.assertEqual(price_evidence(divergent, context(self.obs, divergent), self.config.references, self.admission)[1], ('reference_divergence',))
        wrong = reader(feeds={**FEEDS, address(0x1001): (6, 'FIXTURE / USD', 7, 10**8, 1700000000)})
        self.assertEqual(price_evidence(wrong, context(self.obs, wrong), self.config.references, self.admission)[1], ('reference_configuration',))
        missing = sample_automation_config(feeds={C0: address(0x1001)})
        self.assertEqual(price_evidence(rd, context(self.obs, rd), missing.references, self.admission)[1], ('reference_missing',))

    def test_gas_is_converted_through_the_native_reference_against_the_operator(self):
        refs = price_evidence(reader(), context(self.obs, reader()), self.config.references, self.admission)[2]
        self.assertEqual(quote_per_wei(refs, m.ZERO, 0), 1)
        self.assertEqual(quote_per_wei(refs, C1, 100), Fraction(101, 100))
        expensive = {**refs, m.ZERO: changed_ref(refs[m.ZERO], answer=3000 * 10**8)}
        self.assertEqual(quote_per_wei(expensive, C1, 0), 3000)

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


def changed_ref(ref, **values):
    from automation_evidence import Reference
    return Reference(**{**ref.__dict__, **values})


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
