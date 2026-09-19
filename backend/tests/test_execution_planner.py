"""Synthetic E3 economics and strategy; no deployment settings or RPC."""
from fractions import Fraction
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from execution_cases import address, identity, position, scenario
import execution_models as m
import execution_planner as p
from v4_math import Q96, amount_delta, sqrt_at_tick

NOW = 1700000000


def replace(record, **changes):
    return type(record).model_validate({**record.model_dump(), **changes})


def settings(**changes):
    return p.PlannerSettings(version=identity(800), minimumSamples=3, minimumSampleSeconds=1200, maximumMeasurementSeconds=7200,
        maximumSampleAgeSeconds=120, maximumForecastSeconds=3600, forecastHaircutBps=0,
        minimumOwnerBenefitQuote=0, operatorCostBufferBps=1500, serviceRealizationBps=10000,
        overlapChoicesBps=(0, 500, 2000), liquidityFractionChoicesBps=(625, 1250, 2500, 5000, 10000), **changes)


def history(obs, *, increment=100):
    samples = tuple(p.FeeSample(sequence=obs.sequence.digest(), epoch=identity(900), blockNumber=1232+i,
        blockHash=obs.blockHash if i == 2 else identity(910+i), timestamp=NOW-1200+i*600,
        cumulativeFee0=i*increment, cumulativeFee1=i*increment, cumulativeLiquiditySeconds=i*600*100000,
        coverageComplete=True, qualified=True, evidenceId=identity(920+i)) for i in range(3))
    return p.MeasurementHistory(sequence=obs.sequence.digest(), waitingSince=NOW-3600,
        samples=samples, lastAttemptAt=NOW, lastReadFailed=False)


def setup(*, amounts=(1000, 1000), reverse=False, charged=False, trigger=0, tick=0):
    old, _, _ = scenario(reverse=reverse)
    root = position(old.sequence, lower=-120, upper=120)
    members = (m.CustodyObservation(position=root, holder=old.sequence.owner,
                                   individualApproval=old.sequence.vault, active=True),)
    pair = (old.sequence.poolKey.currency0, old.sequence.poolKey.currency1)
    balances = tuple(m.SourceBalance(source=m.FeeSourceIdentity(sequence=old.sequence.digest(),
        position=root.digest(), currency=currency), lotId=identity(300+i), currency=currency,
        convertedCharged=charged and i == 0, amountRaw=str(amounts[i]), reservedRaw='0',
        reconciliationId=identity(400+i)) for i, currency in enumerate(pair))
    policy = replace(old.policy, triggerDistanceBps=trigger,
        limits=replace(old.policy.limits, maxPriceImpactBps=5000, maxSlippageBps=100))
    obs = replace(old, positions=members, balances=balances, policy=policy, sqrtPriceX96=str(sqrt_at_tick(tick)))
    return obs, history(obs), settings()


def ratio(value):
    return p.Ratio(numerator=value.numerator, denominator=value.denominator)


def evidence(obs, cfg, *, gas=3, active=10000, exposure=0, max_liquidity=10**12, swaps=()):
    raw = Fraction(int(obs.sqrtPriceX96)**2, Q96**2)
    values = (raw, Fraction(1)) if obs.sequence.baseCurrency == obs.sequence.poolKey.currency0 else (Fraction(1), 1/raw)
    prices = tuple(p.PriceBand(lower=ratio(v), upper=ratio(v)) for v in values)
    destinations = {}
    for route in p.route_sources(obs, cfg):
        for dest in route.destinations:
            destinations[dest.digest()] = p.DestinationEvidence(destination=dest, evidenceId=identity(601),
                qualified=True, totalActiveLiquidity=100000, ownerActiveLiquidity=10000,
                minimumCompetingLiquidity=90000, maximumTotalLiquidity=100000,
                activeFractionBps=active, maxLiquidityIncrease=max_liquidity,
                exposureLossQuote=exposure, ownerPaidCostQuote=0, directGasWei=1000, directGasQuote=gas)
    return p.Evidence(observationHash=obs.digest(), evidenceId=identity(600), qualified=True,
        expiresAt=NOW+120, prices=prices, operationAdmissionId=identity(602),
        destinations=tuple(destinations.values()), swaps=swaps)


def quote(obs, dest, amount_in, minimum, expected, *, impact=100, **changes):
    bounds = m.SwapBounds(enabled=True, adapterId=identity(700), adapterVersion='1',
        routeCommitment=identity(amount_in+1000), currencyIn=obs.sequence.poolKey.currency0,
        currencyOut=obs.sequence.poolKey.currency1, amountInRaw=str(amount_in), minAmountOutRaw=str(minimum))
    data = dict(destination=dest, bounds=bounds, evidenceId=identity(701), qualified=True,
        expiresAt=NOW+60, expectedAmountOutRaw=expected, priceImpactBps=impact,
        slippageBps=100, gasWei=2000, gasQuote=4)
    return p.SwapQuote(**{**data, **changes})


def _widen(amount, slippage_bps):
    return amount * (10000 + int(slippage_bps)) // 10000


def assert_e1_consistent(obs, candidate):
    """Test-only general-path translation checks the unchanged E1 boundary.
    It is not a production plan builder or execution qualification.
    """
    _, template, _ = scenario()
    plan = replace(template, sequence=obs.sequence, policyHash=obs.policy.digest(), observationHash=obs.digest(),
        action={'compound_self':1,'redirect_fees':2,'create_domino':3}[candidate.action],
        expectedPolicyVersion=obs.policy.version, expectedStateNonce=obs.stateNonce,
        expectedAuthorityGeneration=obs.authorityGeneration, sourceBlockNumber=obs.blockNumber,
        sourceBlockHash=obs.blockHash, allocations=candidate.allocations,collections=candidate.collections,
        destination=candidate.destination,liquidityIncrease=str(candidate.liquidityIncrease),
        maxGrossFee0=str(candidate.grossConsumed[0]),maxGrossFee1=str(candidate.grossConsumed[1]),
        maxChargedInput0=str(candidate.chargedConsumed[0]),maxChargedInput1=str(candidate.chargedConsumed[1]),
        minNetAdded0=str(candidate.netAdded[0]),minNetAdded1=str(candidate.netAdded[1]),
        # The ceiling is the simulated addition widened by the owner's own
        # maxSlippageBps - the same field that already sizes minAmountOut - so
        # the tolerance stays an owner setting rather than a constant anyone
        # picked. An operator who prefers liveness to tightness may sign
        # uint128 max instead; what it may not do is leave it unsaid.
        maxNetAdded0=str(_widen(candidate.netAdded[0],obs.policy.limits.maxSlippageBps)),
        maxNetAdded1=str(_widen(candidate.netAdded[1],obs.policy.limits.maxSlippageBps)),
        minSqrtPriceX96=obs.sqrtPriceX96,maxSqrtPriceX96=obs.sqrtPriceX96,
        swap=candidate.swap or template.swap)
    m.validate_candidate(plan,obs,now=NOW,actor=obs.operator)


class PlannerTests(unittest.TestCase):
    def selected(self, obs, hist, cfg, ev):
        decision = p.plan(obs, hist, cfg, ev, now=NOW)
        chosen = decision.candidates[decision.selected]
        if chosen.action != 'wait':
            assert_e1_consistent(obs, chosen)
        return decision, chosen

    def test_balanced_fees_use_maximum_integer_liquidity_and_no_growth_cap(self):
        obs, hist, cfg = setup()
        decision, candidate = self.selected(obs, hist, cfg, evidence(obs, cfg))
        self.assertEqual(decision.action, 'compound_self')
        # At the fee-floor plateau, 999-19 == 1000-20. Preserve the extra
        # original atom rather than charge it without increasing liquidity.
        self.assertEqual(candidate.grossConsumed, (999, 999))
        self.assertEqual(candidate.serviceCut, (19, 19))
        self.assertEqual(candidate.netAdded, (980, 980))
        self.assertEqual(tuple(w.amountRaw for w in decision.waiting), (1, 1))
        self.assertFalse(decision.executionAvailable)
        root = obs.positions[0].position
        for i, (a, b) in enumerate(((Q96, sqrt_at_tick(root.tickUpper)), (sqrt_at_tick(root.tickLower), Q96))):
            self.assertLessEqual(amount_delta(a, b, candidate.liquidityIncrease, i, True), 980)
        # Increasing one unit would overdraw at least one currency (independent boundary).
        self.assertTrue(amount_delta(Q96, sqrt_at_tick(root.tickUpper), candidate.liquidityIncrease+1, 0, True) > 980
                        or amount_delta(sqrt_at_tick(root.tickLower), Q96, candidate.liquidityIncrease+1, 1, True) > 980)

    def test_fee_flow_dilution_includes_incumbent_owner_and_never_exceeds_pool_budget(self):
        obs, _, cfg = setup()
        hist = history(obs, increment=2)
        ev = evidence(obs, cfg)
        decision = p.plan(obs, hist, cfg, ev, now=NOW)
        full = decision.candidates[1]
        # Each 600 s interval earns 2+2 quote atoms. One hour supplies 24
        # pool-wide, not a per-added-liquidity promise. Include owner dilution.
        n = full.liquidityIncrease
        bound = Fraction(24*n*90000, 100000*(100000+n))
        self.assertEqual(full.economics.incrementalEarningsQuote, int(bound))
        self.assertLess(full.economics.incrementalEarningsQuote, 24)
        self.assertLess(full.economics.ownerNetBenefitQuote, 0)
        self.assertFalse(full.economics.ownerPass)
        sole_owner = replace(ev, destinations=tuple(replace(d, ownerActiveLiquidity=100000,
            minimumCompetingLiquidity=0) for d in ev.destinations))
        decision = p.plan(obs, hist, cfg, sole_owner, now=NOW)
        self.assertEqual(decision.action, 'wait')
        self.assertTrue(all(c.economics.incrementalEarningsQuote == 0 for c in decision.candidates))
        with self.assertRaises(ValueError):
            replace(ev.destinations[0], minimumCompetingLiquidity=90001)
        with self.assertRaises(ValueError):
            replace(ev.destinations[0], maximumTotalLiquidity=99999)

    def test_profitable_partial_direct_action_beats_unprofitable_maximum(self):
        obs, _, cfg = setup(amounts=(10000, 10000))
        decision = p.plan(obs, history(obs, increment=10), cfg, evidence(obs, cfg), now=NOW)
        full = decision.candidates[1]
        chosen = decision.candidates[decision.selected]
        self.assertFalse(full.economics.ownerPass)
        self.assertLess(full.economics.ownerNetBenefitQuote, 0)
        self.assertEqual(decision.action, 'compound_self')
        self.assertTrue(chosen.economics.ownerPass and chosen.economics.operatorPass)
        self.assertGreater(chosen.economics.ownerNetBenefitQuote, 0)
        self.assertLess(chosen.liquidityIncrease, full.liquidityIncrease)
        self.assertGreater(sum(w.amountRaw for w in decision.waiting), 0)
        with self.assertRaises(ValueError):
            replace(cfg, liquidityFractionChoicesBps=(10000,))

    def test_swap_operator_budget_is_complete_path_cost(self):
        obs, hist, cfg = setup(amounts=(2000, 0))
        ev = evidence(obs, cfg, gas=100)
        swap = quote(obs, ev.destinations[0].destination, 900, 891, 891, gasQuote=200)
        decision = p.plan(obs, hist, cfg, replace(ev, swaps=(swap,)), now=NOW)
        actual = [c for c in decision.candidates if c.swap]
        self.assertTrue(actual)
        self.assertTrue(all(c.economics.operatorBufferedCostQuote == 230 for c in actual))
        self.assertTrue(all(not c.economics.operatorPass for c in actual))
        self.assertEqual(decision.action, 'wait')

    def test_separate_owner_and_operator_gates(self):
        obs, hist, cfg = setup()
        owner_fail = p.plan(obs, history(obs, increment=0), cfg, evidence(obs, cfg), now=NOW)
        c = owner_fail.candidates[1]
        self.assertTrue(c.economics.operatorPass)
        self.assertFalse(c.economics.ownerPass)
        self.assertEqual(owner_fail.action, 'wait')
        operator_fail = p.plan(obs, hist, cfg, evidence(obs, cfg, gas=1000), now=NOW)
        self.assertTrue(operator_fail.candidates[1].economics.ownerPass)
        self.assertFalse(operator_fail.candidates[1].economics.operatorPass)
        self.assertEqual(operator_fail.action, 'wait')

    def test_owner_fee_cut_is_not_charged_again_as_operator_gas(self):
        obs, hist, cfg = setup()
        _, c = self.selected(obs, hist, cfg, evidence(obs, cfg))
        self.assertEqual(c.economics.ownerNetBenefitQuote, c.economics.incrementalEarningsQuote-38)
        self.assertEqual(c.economics.operatorBufferedCostQuote, 4)

    def test_smaller_bounded_swap_beats_full_swap_and_direct(self):
        obs, hist, cfg = setup(amounts=(2000, 100))
        hist = history(obs, increment=20)
        ev = evidence(obs, cfg)
        dest = ev.destinations[0].destination
        small = quote(obs, dest, 400, 390, 392, impact=250)
        full = quote(obs, dest, 900, 600, 605, impact=3333)
        ev = replace(ev, swaps=(small, full))
        decision, chosen = self.selected(obs, hist, cfg, ev)
        self.assertEqual(chosen.swap.amountInRaw, '400')
        self.assertGreater(chosen.economics.ownerNetBenefitQuote, decision.candidates[1].economics.ownerNetBenefitQuote)
        self.assertEqual(chosen.economics.swapLossQuote, 10)
        # Loss is already reflected in min output; no extra slippage/service fee.
        self.assertEqual(chosen.economics.ownerNetBenefitQuote,
            chosen.economics.incrementalEarningsQuote-chosen.economics.serviceCostQuote-10)
        self.assertEqual(obs.balances[0].amountRaw, '2000')

    def test_direct_beats_unnecessary_swap_and_full_beneficial_swap_can_win(self):
        obs, hist, cfg = setup()
        ev = evidence(obs, cfg)
        ev = replace(ev, swaps=(quote(obs, ev.destinations[0].destination, 100, 90, 90, impact=1000),))
        _, direct = self.selected(obs, hist, cfg, ev)
        self.assertIsNone(direct.swap)
        obs, hist, cfg = setup(amounts=(2000, 100))
        ev = evidence(obs, cfg)
        ev = replace(ev, swaps=(quote(obs, ev.destinations[0].destination, 900, 891, 891),))
        _, best = self.selected(obs, hist, cfg, ev)
        self.assertIsNotNone(best.swap)

    def test_stale_unqualified_and_bounded_swap_quotes_never_selected(self):
        obs, hist, cfg = setup(amounts=(2000, 0))
        ev = evidence(obs, cfg)
        dest = ev.destinations[0].destination
        for changes in ({'expiresAt':NOW-1}, {'qualified':False}, {'priceImpactBps':5001}, {'slippageBps':101}):
            bad = quote(obs, dest, 900, 891, 891, **changes)
            decision = p.plan(obs, hist, cfg, replace(ev, swaps=(bad,)), now=NOW)
            self.assertEqual(decision.action, 'wait', changes)
        # A short output floor is rejected as a malformed quote before planning.
        with self.assertRaises(ValueError):
            quote(obs, dest, 900, 800, 900)

    def test_no_external_funding_and_converted_residual_not_recharged(self):
        obs, hist, cfg = setup(amounts=(1000, 1000), charged=True)
        _, c = self.selected(obs, hist, cfg, evidence(obs, cfg))
        self.assertEqual(c.serviceCut[0], 0)
        self.assertEqual(c.chargedConsumed[0], 980)
        self.assertEqual(c.grossConsumed[0], 0)
        self.assertEqual(c.serviceCut[1], 19)
        obs, hist, cfg = setup(amounts=(0, 0))
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW).action, 'wait')

    def test_unconsumed_fees_and_reservations_have_origin_and_reason(self):
        obs, hist, cfg = setup(amounts=(2000, 100))
        first = replace(obs.balances[0], reservedRaw='30')
        obs = replace(obs, balances=(first, obs.balances[1]))
        decision, _ = self.selected(obs, hist, cfg, evidence(obs, cfg, gas=1))
        self.assertEqual(sum(w.amountRaw for w in decision.waiting if w.currency == first.currency), 1901)
        self.assertEqual(next(w.amountRaw for w in decision.waiting if w.origin == 'reserved'), 30)
        self.assertTrue(all(w.source and w.reason for w in decision.waiting))

    def test_isolated_failure_preserves_history_wait_and_recovers_without_warmup_reset(self):
        obs, hist, cfg = setup()
        failed = p.observe(hist, None, now=NOW+10)
        self.assertEqual(failed.samples, hist.samples)
        self.assertEqual(failed.waitingSince, hist.waitingSince)
        d = p.plan(obs, failed, cfg, evidence(obs, cfg), now=NOW+10)
        self.assertEqual(d.action, 'wait')
        self.assertEqual(d.elapsedWaitSeconds, 3610)
        recovered = p.observe(failed, hist.samples[-1], now=NOW+11)
        self.assertEqual(len(recovered.samples), 3)
        self.assertEqual(p.plan(obs, recovered, cfg, evidence(obs, cfg), now=NOW+11).action, 'compound_self')

    def test_token_appreciation_without_earned_units_never_creates_accrual(self):
        obs, _, cfg = setup()
        hist = history(obs, increment=0)
        base = evidence(obs, cfg)
        self.assertEqual(p.plan(obs, hist, cfg, base, now=NOW).action, 'wait')
        # Reprice base upward and move pool consistently, without new earned tokens.
        moved = replace(obs, sqrtPriceX96=str(sqrt_at_tick(60)))
        changed = evidence(moved, cfg)
        self.assertEqual(p.plan(moved, hist, cfg, changed, now=NOW).action, 'wait')
        self.assertTrue(all(c.economics.incrementalEarningsQuote == 0 for c in p.plan(moved, hist, cfg, changed, now=NOW).candidates))

    def test_policy_price_depth_gas_inputs_all_recompute(self):
        obs, hist, cfg = setup()
        ev = evidence(obs, cfg)
        original = p.plan(obs, hist, cfg, ev, now=NOW)
        cases = [p.plan(obs, hist, cfg, evidence(obs, cfg, gas=1000), now=NOW),
                 p.plan(obs, hist, cfg, evidence(obs, cfg, active=0), now=NOW),
                 p.plan(replace(obs, policy=replace(obs.policy, version='2')), hist, cfg, ev, now=NOW),
                 p.plan(replace(obs, sqrtPriceX96=str(sqrt_at_tick(60))), hist, cfg, ev, now=NOW)]
        self.assertTrue(all(d.action == 'wait' for d in cases))
        self.assertTrue(all(d.inputFingerprint != original.inputFingerprint for d in cases))
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg, gas=1000), now=NOW).elapsedWaitSeconds,
                         p.plan(obs, hist, cfg, ev, now=NOW).elapsedWaitSeconds)

    def test_missing_stale_unqualified_pending_and_pause_fail_closed(self):
        obs, hist, cfg = setup()
        for ev in (None, replace(evidence(obs, cfg), qualified=False), replace(evidence(obs, cfg), expiresAt=NOW-1)):
            self.assertEqual(p.plan(obs, hist, cfg, ev, now=NOW).action, 'wait')
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW, pending_intent=True).action, 'wait')
        paused = replace(obs, policy=replace(obs.policy, paused=True))
        self.assertEqual(p.plan(paused, hist, cfg, evidence(paused, cfg), now=NOW).action, 'wait')
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW+121).action, 'wait')

    def test_measurement_epoch_reorg_and_unqualified_history(self):
        obs, hist, cfg = setup()
        sample = replace(hist.samples[-1], epoch=identity(999), timestamp=NOW+1, blockNumber=1235,
                         cumulativeFee0=0, cumulativeFee1=0, cumulativeLiquiditySeconds=0)
        reset = p.observe(hist, sample, now=NOW+1)
        self.assertEqual(len(reset.samples), 1)
        self.assertEqual(reset.waitingSince, hist.waitingSince)
        self.assertEqual(p.plan(obs, reset, cfg, evidence(obs, cfg), now=NOW+1).action, 'wait')
        with self.assertRaises(ValueError):
            p.observe(hist, replace(sample, epoch=hist.samples[-1].epoch), now=NOW+1)

    def test_horizon_and_sampling_are_explicit_and_bounded(self):
        obs, hist, cfg = setup()
        too_long = replace(obs, policy=replace(obs.policy, limits=replace(obs.policy.limits, forecastHorizonSeconds=3601)))
        self.assertIn('forecast_horizon_not_admitted', p.plan(too_long, hist, cfg, evidence(too_long, cfg), now=NOW).reasons)
        with self.assertRaises(ValueError):
            p.PlannerSettings.model_validate({})
        with self.assertRaises(ValueError):
            replace(cfg, maximumForecastSeconds=604801)

    def test_reversed_currency_order_has_same_self_economics(self):
        forward, hf, sf = setup()
        reverse, hr, sr = setup(reverse=True)
        df, cf = self.selected(forward, hf, sf, evidence(forward, sf))
        dr, cr = self.selected(reverse, hr, sr, evidence(reverse, sr))
        self.assertEqual(df.action, dr.action)
        self.assertEqual(cf.netAdded, cr.netAdded)
        self.assertEqual(cf.economics, cr.economics)

    def test_source_rounding_is_aggregate_and_collection_budget_is_separate(self):
        obs, hist, cfg = setup(amounts=(2000, 2000))
        original = obs.balances[0]
        extra = replace(original, lotId=identity(302), amountRaw='1000', reconciliationId=identity(402))
        obs = replace(obs, balances=(replace(original, amountRaw='1000'), obs.balances[1], extra))
        _, candidate = self.selected(obs, hist, cfg, evidence(obs, cfg))
        self.assertEqual(candidate.grossConsumed, (1999, 1999))
        self.assertEqual(candidate.serviceCut, (39, 39))
        amounts = {a.lotId:int(a.amountRaw) for a in candidate.allocations}
        self.assertEqual(amounts[identity(300)]+amounts[identity(302)], 1999)
        accrual = m.AccrualObservation(source=original.source, amountRaw='2000', checkpointId=identity(7000))
        obs = replace(obs, balances=(obs.balances[1],), accruals=(accrual,))
        _, collected = self.selected(obs, hist, cfg, evidence(obs, cfg))
        self.assertEqual(collected.collections[0].maxGrossRaw, '1999')
        self.assertEqual(collected.serviceCut, candidate.serviceCut)

    def test_insufficient_fee_funded_swap_and_inactive_forecast_wait(self):
        obs, hist, cfg = setup(amounts=(100, 0))
        ev = evidence(obs, cfg)
        bad = quote(obs, ev.destinations[0].destination, 101, 100, 100)
        d = p.plan(obs, hist, cfg, replace(ev, swaps=(bad,)), now=NOW)
        self.assertEqual(d.action, 'wait')
        self.assertTrue(all(c.swap is None for c in d.candidates))
        obs, hist, cfg = setup(trigger=500)
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg, active=0), now=NOW).action, 'wait')

    def test_independent_price_reference_depth_cost_and_exposure_can_each_block(self):
        obs, hist, cfg = setup()
        ev = evidence(obs, cfg)
        wrong = p.PriceBand(lower=ratio(Fraction(2)), upper=ratio(Fraction(2)))
        self.assertIn('price_reference_mismatch', p.plan(obs, hist, cfg, replace(ev, prices=(wrong, ev.prices[1])), now=NOW).reasons)
        no_depth = replace(ev, destinations=tuple(replace(d, qualified=False) for d in ev.destinations))
        self.assertEqual(p.plan(obs, hist, cfg, no_depth, now=NOW).action, 'wait')
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg, exposure=10000), now=NOW).action, 'wait')
        excessive_gas = replace(ev, destinations=tuple(replace(d, directGasWei=int(obs.policy.limits.maxGasCostWei)+1) for d in ev.destinations))
        self.assertEqual(p.plan(obs, hist, cfg, excessive_gas, now=NOW).action, 'wait')

    def test_measurement_uses_worst_sample_not_inflated_average_or_repeated_rpc(self):
        obs, hist, cfg = setup()
        last = replace(hist.samples[-1], cumulativeFee0=100000, cumulativeFee1=100000)
        spike = replace(hist, samples=(*hist.samples[:-1], last))
        a = p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW)
        b = p.plan(obs, spike, cfg, evidence(obs, cfg), now=NOW)
        self.assertEqual(a.candidates[a.selected].economics.incrementalEarningsQuote,
                         b.candidates[b.selected].economics.incrementalEarningsQuote)
        repeated = p.observe(hist, hist.samples[-1], now=NOW+1)
        self.assertEqual(repeated.samples, hist.samples)

    def test_reserved_fees_are_never_spent_and_tiny_growth_floor_has_no_minimum_toll(self):
        obs, hist, cfg = setup(amounts=(49, 49))
        ev = evidence(obs, cfg, gas=1)
        d = p.plan(obs, hist, cfg, ev, now=NOW)
        self.assertEqual(d.candidates[1].serviceCut, (0, 0))
        self.assertEqual(d.action, 'wait')  # no fabricated minimum fee to pay gas
        obs = replace(obs, balances=tuple(replace(b, reservedRaw=b.amountRaw) for b in obs.balances))
        d = p.plan(obs, hist, cfg, evidence(obs, cfg, gas=1), now=NOW)
        self.assertEqual(d.action, 'wait')
        self.assertEqual(sum(w.amountRaw for w in d.waiting), 98)

    def test_nonce_and_custody_revocation_stop_new_candidates(self):
        obs, hist, cfg = setup()
        exhausted = replace(obs, stateNonce=str(m.U64_MAX))
        self.assertIn('nonce_exhausted', p.plan(exhausted, hist, cfg, evidence(exhausted, cfg), now=NOW).reasons)
        revoked = replace(obs, positions=(replace(obs.positions[0], individualApproval=m.ZERO),))
        self.assertEqual(p.plan(revoked, hist, cfg, evidence(revoked, cfg), now=NOW).action, 'wait')
        with self.assertRaises(ValueError):
            p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW, pending_intent='yes')


class GeometryTests(unittest.TestCase):
    def test_inward_rounding_in_both_fixed_orientations(self):
        for reverse in (False, True):
            obs, _, cfg = setup(reverse=reverse)
            parent = obs.positions[0].position
            base0 = not reverse
            old = p.price_range(parent, base0)[1]
            for overlap in (0, 500, 2000):
                d = p.successor_range(obs, parent, overlap)
                floor, ceiling = p.price_range(d, base0)
                self.assertGreaterEqual(floor, old*Fraction(10000-overlap,10000))
                self.assertLessEqual(ceiling, old*Fraction(15000,10000))
                self.assertGreater(ceiling, old)
                self.assertEqual(d.tickLower % 60, 0)
                self.assertEqual(d.tickUpper % 60, 0)
                self.assertTrue(d.tickLower >= parent.tickUpper if reverse is False and overlap == 0 else True)
            self.assertEqual(p.route_sources(obs, cfg)[0].action, 'compound_self')

    def test_trigger_distance_is_of_ceiling_and_independent_of_overlap(self):
        obs, _, cfg = setup(trigger=500, tick=0)
        parent = obs.positions[0].position
        self.assertGreaterEqual(p.quote_price(Q96, True), p.price_range(parent, True)[1]*Fraction(95,100))
        self.assertEqual(p.route_sources(obs, cfg)[0].action, 'create_domino')
        low_overlap = replace(obs, policy=replace(obs.policy, maxOverlapBps=500))
        self.assertEqual(p.route_sources(low_overlap, cfg)[0].action, 'create_domino')
        no_trigger = replace(obs, policy=replace(obs.policy, triggerDistanceBps=0))
        self.assertEqual(p.route_sources(no_trigger, cfg)[0].action, 'compound_self')

    def test_infeasible_tick_extremes_are_rejected(self):
        obs, _, _ = setup()
        parent = position(obs.sequence, lower=887100, upper=887220)
        with self.assertRaises(ValueError):
            p.successor_range(obs, parent, 0)

    def test_create_pending_and_sequence_cap(self):
        obs, hist, cfg = setup(trigger=500)
        # A much wider successor earns less per unit of deposited capital;
        # this explicit high-fee synthetic scenario clears its owner gate.
        hist = history(obs, increment=1000)
        result = p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW)
        self.assertEqual(result.action, 'create_domino')
        pending = p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW, pending_parents=frozenset({'101'}))
        self.assertEqual(pending.action, 'wait')
        capped = replace(obs, policy=replace(obs.policy, maxPositions=1))
        self.assertEqual(p.plan(capped, hist, cfg, evidence(capped, cfg), now=NOW).action, 'wait')

    def test_nonrecursive_source_routing_and_existing_successor_reuse(self):
        obs, _, cfg = setup(trigger=2000)
        seq = obs.sequence
        root = position(seq, lower=-6000, upper=0)
        child = position(seq, 102, 101, lower=-1980, upper=1980)
        members = (m.CustodyObservation(position=root, holder=seq.owner, individualApproval=seq.vault, active=True),
                   m.CustodyObservation(position=child, holder=seq.vault, individualApproval=m.ZERO, active=True))
        lots = []
        for index, member in enumerate((root, child)):
            for j, currency in enumerate((seq.poolKey.currency0, seq.poolKey.currency1)):
                lots.append(m.SourceBalance(source=m.FeeSourceIdentity(sequence=seq.digest(), position=member.digest(), currency=currency),
                    lotId=identity(300+index*2+j), currency=currency, convertedCharged=False, amountRaw='1000',
                    reservedRaw='0', reconciliationId=identity(400+index*2+j)))
        obs = replace(obs, positions=tuple(sorted(members, key=lambda p:p.position.digest())), balances=tuple(lots))
        routes = {r.sourcePosition:r for r in p.route_sources(obs, cfg)}
        self.assertEqual(routes[root.digest()].action, 'redirect_fees')
        self.assertEqual(routes[root.digest()].destinations[0].tokenId, '102')
        self.assertEqual(routes[child.digest()].action, 'create_domino')
        d = p.plan(obs, history(obs), cfg, evidence(obs, cfg), now=NOW)
        for c in d.candidates[1:]:
            self.assertEqual(c.sources, (root.digest(),) if not c.destination.createChild else (child.digest(),))

    def test_half_open_floor_and_ceiling_in_both_orientations(self):
        # v4 [tickLower, tickUpper) reverses to (human floor, human ceiling].
        for reverse, tick, expected in ((False,-120,'compound_self'), (False,120,'create_domino'),
                                        (True,120,'wait'), (True,-120,'create_domino')):
            obs, _, cfg = setup(reverse=reverse, tick=tick, trigger=0)
            route = p.route_sources(obs, cfg)[0]
            self.assertEqual(route.action, expected, (reverse, tick))
        obs, _, cfg = setup(reverse=True, tick=120, trigger=0)
        child = position(obs.sequence, 102, 101, lower=60, upper=180)
        custody = m.CustodyObservation(position=child, holder=obs.sequence.vault,
                                      individualApproval=m.ZERO, active=True)
        obs = replace(obs, positions=tuple(sorted((*obs.positions,custody), key=lambda p:p.position.digest())))
        route = p.route_sources(obs, cfg)[0]
        self.assertEqual(route.action, 'redirect_fees')
        self.assertEqual(route.destinations[0].tokenId, '102')

    def test_only_consumed_sources_determine_self_action(self):
        for reserved in (False, True):
            obs, _, cfg = setup(amounts=(0,0), trigger=0)
            seq = obs.sequence
            root = position(seq, lower=-6000, upper=0)
            child = position(seq, 102, 101, lower=-120, upper=120)
            members = (m.CustodyObservation(position=root, holder=seq.owner, individualApproval=seq.vault, active=True),
                       m.CustodyObservation(position=child, holder=seq.vault, individualApproval=m.ZERO, active=True))
            lots = []
            for index, member in enumerate((root,child)):
                for j, currency in enumerate((seq.poolKey.currency0, seq.poolKey.currency1)):
                    amount = 1000 if index or reserved else 0
                    lots.append(m.SourceBalance(source=m.FeeSourceIdentity(sequence=seq.digest(),position=member.digest(),currency=currency),
                        lotId=identity(300+index*2+j),currency=currency,convertedCharged=False,amountRaw=str(amount),
                        reservedRaw=str(amount if index == 0 and reserved else 0),reconciliationId=identity(400+index*2+j)))
            obs = replace(obs,positions=tuple(sorted(members,key=lambda p:p.position.digest())),balances=tuple(lots))
            decision = p.plan(obs,history(obs),cfg,evidence(obs,cfg),now=NOW)
            chosen = decision.candidates[decision.selected]
            self.assertEqual(decision.action,'compound_self')
            self.assertEqual(chosen.sources,(child.digest(),))
            self.assertEqual(chosen.destination.tokenId,'102')
            assert_e1_consistent(obs,chosen)
            self.assertTrue(all(a.lotId in (identity(302),identity(303)) for a in chosen.allocations))

    def test_below_range_wait_has_no_downward_mint(self):
        obs, hist, cfg = setup(tick=-180, trigger=2000)
        self.assertEqual(p.route_sources(obs, cfg)[0].reason, 'no_in_range_destination')
        self.assertEqual(p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW).action, 'wait')

    def test_below_and_above_range_use_an_existing_eligible_position(self):
        for tick, lower, upper in ((-180, -600, -120), (180, 120, 600)):
            obs, hist, cfg = setup(tick=tick)
            child = position(obs.sequence, 102, 101, lower=lower, upper=upper)
            members = (*obs.positions, m.CustodyObservation(position=child, holder=obs.sequence.vault,
                       individualApproval=m.ZERO, active=True))
            obs = replace(obs, positions=tuple(sorted(members, key=lambda p:p.position.digest())))
            route = p.route_sources(obs, cfg)[0]
            self.assertEqual(route.action, 'redirect_fees')
            self.assertEqual(route.destinations[0].tokenId, '102')
            self.assertFalse(route.destinations[0].createChild)

    def test_inactive_historical_child_reserve_can_redirect_but_not_collect(self):
        obs, hist, cfg = setup()
        root = obs.positions[0].position
        child = position(obs.sequence, 102, 101, lower=-120, upper=120)
        historical = m.CustodyObservation(position=child, holder=address(42), individualApproval=m.ZERO, active=False)
        source = replace(obs.balances[0].source, position=child.digest())
        lot = replace(obs.balances[0], source=source)
        accrual = m.AccrualObservation(source=source, amountRaw='1000', checkpointId=identity(8000))
        obs = replace(obs, positions=tuple(sorted((*obs.positions, historical), key=lambda p:p.position.digest())),
                      balances=(lot, obs.balances[1]), accruals=(accrual,))
        decision = p.plan(obs, hist, cfg, evidence(obs, cfg), now=NOW)
        self.assertEqual(decision.action, 'redirect_fees')
        selected = decision.candidates[decision.selected]
        self.assertEqual(selected.destination.tokenId, root.tokenId)
        self.assertEqual(selected.collections, ())

    def test_foreign_sequence_and_bypassed_records_rejected(self):
        obs, hist, cfg = setup()
        foreign = replace(hist, sequence=identity(1200), samples=())
        with self.assertRaises(ValueError):
            p.plan(obs, foreign, cfg, evidence(obs, cfg), now=NOW)
        malformed = obs.model_copy(update={'sqrtPriceX96':'0'})
        with self.assertRaises(ValueError):
            p.plan(malformed, hist, cfg, None, now=NOW)


if __name__ == '__main__':
    unittest.main()
