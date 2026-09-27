"""Candidate to ExecutionPlan: proved offline and against the V4 wire."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_hash.auto import keccak

import execution_cases as cases
import execution_models as m
import execution_planner as p
import execution_v4 as v4
import test_execution_planner as tp
from automation_config import PlanPolicy, impact_bounds
from automation_evidence import price_impact_bps
from automation_observer import ObservationContext, PoolState
from automation_plan import (ACTIONS, PlanError, addition_amounts, build_execution_plan, exact_floors, observation_id,
                             observation_point, publish_calldata, PLACEHOLDER_OBSERVATION)
from execution_cases import identity
from execution_v4_adapter import decode_plan, rebuild_v4

POLICY = PlanPolicy(deadlineSeconds=60, maxGasCostWei=10**15, preferNetPath=True, liquiditySlackBps=25)
EXACT = PlanPolicy(deadlineSeconds=60, maxGasCostWei=10**15, preferNetPath=True, liquiditySlackBps=0)
# The production pilot's slack (automation-pilot-v1.json).
PILOT = PlanPolicy(deadlineSeconds=60, maxGasCostWei=10**15, preferNetPath=True, liquiditySlackBps=50)


def changed(record, **values):
    return type(record).model_validate_json(json.dumps({**record.model_dump(mode='json'), **values}))


def v4_setup(**kwargs):
    original = cases.sequence
    with patch.object(cases, 'sequence', side_effect=lambda **kw: changed(original(**kw), implementationVersion='4')):
        return tp.setup(**kwargs)


def context(obs):
    # The observer records the stored checkpoint of every member; an accrual
    # it produced names that same commitment, so the fixture keeps them equal.
    points = {c.position.tokenId: identity(701 + i) for i, c in enumerate(obs.positions)}
    for accrual in obs.accruals:
        points[next(c.position.tokenId for c in obs.positions if c.position.digest() == accrual.source.position)] = accrual.checkpointId
    return ObservationContext(observation=obs, checkpoints=points,
        member_liquidity={}, last_execution_at=0, pool=PoolState(int(obs.sqrtPriceX96), 0, 0, 3000, 10**18, 0, 0),
        block={'number': int(obs.blockNumber), 'hash': obs.blockHash, 'timestamp': int(obs.blockTimestamp), 'baseFeePerGas': 1}, diagnostics=())


def chosen(obs, hist, cfg, ev):
    decision = p.plan(obs, hist, cfg, ev, now=tp.NOW)
    return decision, decision.candidates[decision.selected]


class PlanBuilderTests(unittest.TestCase):
    def test_direct_candidate_becomes_a_verified_general_plan(self):
        obs, hist, cfg = v4_setup()
        decision, candidate = chosen(obs, hist, cfg, tp.evidence(obs, cfg))
        self.assertEqual(candidate.action, 'compound_self')
        plan = build_execution_plan(context(obs), candidate, plan_policy=EXACT, gas_cap_wei=10**14)
        self.assertEqual((plan.action, plan.path), (1, 0))  # lots are allocations: no netting
        self.assertEqual(plan.allocations, candidate.allocations)
        self.assertEqual(plan.liquidityIncrease, str(candidate.liquidityIncrease))
        # Old lots fund this addition alone, and each is an exact floor the
        # engine spends before anything else: there is nothing to take the
        # slack from. The addition cut by it would not absorb them.
        slack = build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**14)
        floors = exact_floors(obs, candidate.allocations)
        spot = int(obs.sqrtPriceX96)
        cut = addition_amounts(candidate.destination, spot, candidate.liquidityIncrease * 9975 // 10000)
        self.assertTrue(cut[0] < floors[0] or cut[1] < floors[1])
        self.assertEqual(addition_amounts(candidate.destination, spot, int(slack.liquidityIncrease)),
                         addition_amounts(candidate.destination, spot, int(plan.liquidityIncrease)))
        self.assertEqual((slack.minNetAdded0, slack.maxNetAdded0, slack.minNetAdded1, slack.maxNetAdded1),
                         (plan.minNetAdded0, plan.maxNetAdded0, plan.minNetAdded1, plan.maxNetAdded1))
        self.assertEqual(int(plan.deadline), tp.NOW + 60)
        self.assertEqual(plan.maxGasCostWei, str(10**14))
        # The plan's band is the owner's impact limit, exactly as the engine checks it.
        lower, upper = impact_bounds(int(obs.sqrtPriceX96), obs.policy.limits.maxPriceImpactBps)
        self.assertEqual((plan.minSqrtPriceX96, plan.maxSqrtPriceX96), (str(lower), str(upper)))
        self.assertLessEqual(price_impact_bps(upper, int(obs.sqrtPriceX96)), obs.policy.limits.maxPriceImpactBps)
        self.assertGreater(price_impact_bps(upper + 1, int(obs.sqrtPriceX96)), obs.policy.limits.maxPriceImpactBps)
        slippage = obs.policy.limits.maxSlippageBps
        for i in (0, 1):
            self.assertEqual(int(getattr(plan, f'minNetAdded{i}')), candidate.netAdded[i] * (10000 - slippage) // 10000)
            self.assertEqual(int(getattr(plan, f'maxNetAdded{i}')), candidate.netAdded[i] * (10000 + slippage) // 10000)
        m.validate_candidate(plan, obs, now=tp.NOW, actor=obs.operator)
        typed = rebuild_v4(plan, obs, {plan.destination.tokenId: identity(701)}, price_observation_id=PLACEHOLDER_OBSERVATION)
        self.assertEqual(decode_plan(typed.calldata()), typed)

    def test_fresh_collections_prefer_the_netting_path(self):
        obs, hist, cfg = v4_setup()
        accruals = tuple(sorted((m.AccrualObservation(source=b.source, amountRaw=b.amountRaw, checkpointId=identity(701))
                                 for b in obs.balances), key=lambda a: a.source.digest()))
        obs = tp.replace(obs, balances=(), accruals=accruals)
        hist = tp.history(obs)
        _, candidate = chosen(obs, hist, cfg, tp.evidence(obs, cfg))
        self.assertTrue(candidate.collections and not candidate.allocations)
        plan = build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**15)
        self.assertEqual((plan.action, plan.path), (1, 1))
        typed = rebuild_v4(plan, obs, {plan.destination.tokenId: identity(701)}, price_observation_id=PLACEHOLDER_OBSERVATION)
        self.assertEqual(typed.action, 1)
        general = build_execution_plan(context(obs), candidate, plan_policy=tp.replace(POLICY, preferNetPath=False), gas_cap_wei=10**15)
        self.assertEqual(general.path, 0)

    def test_the_slack_never_shrinks_an_addition_below_its_exact_lots(self):
        # 27 September 2026: a vault's USDG came only from old lots while its
        # other currency came from fresh fees. The pilot's 50 bps slack cut the
        # addition below those lots, and every execution reverted InvalidAmount.
        obs, _, cfg = v4_setup(amounts=(1000, 5000))
        lot, fresh = obs.balances
        obs = tp.replace(obs, balances=(lot,), accruals=(
            m.AccrualObservation(source=fresh.source, amountRaw=fresh.amountRaw, checkpointId=identity(701)),))
        _, candidate = chosen(obs, tp.history(obs), cfg, tp.evidence(obs, cfg))
        self.assertTrue(candidate.allocations and candidate.collections and candidate.swap is None)
        floors = exact_floors(obs, candidate.allocations)
        fee = obs.policy.serviceFeeBps
        self.assertEqual(floors, (1000 - 1000 * fee // 10000, 0))
        plan = build_execution_plan(context(obs), candidate, plan_policy=PILOT, gas_cap_wei=10**15)
        spot = int(obs.sqrtPriceX96)
        needs = addition_amounts(candidate.destination, spot, int(plan.liquidityIncrease))
        self.assertGreaterEqual(needs[0], floors[0])
        self.assertLessEqual(int(plan.liquidityIncrease), candidate.liquidityIncrease)
        # The smallest addition that absorbs the lots, not the whole candidate:
        # one unit less would leave part of them unspent.
        short = addition_amounts(candidate.destination, spot, int(plan.liquidityIncrease) - 1)
        self.assertLess(short[0], floors[0])
        # The plain cut is what reverted on chain.
        cut = addition_amounts(candidate.destination, spot, candidate.liquidityIncrease * 9950 // 10000)
        self.assertLess(cut[0], floors[0])

    def test_the_slack_still_comes_out_of_fresh_fees(self):
        obs, _, cfg = v4_setup(amounts=(1000, 1000))
        accruals = tuple(sorted((m.AccrualObservation(source=b.source, amountRaw=b.amountRaw, checkpointId=identity(701))
                                 for b in obs.balances), key=lambda a: a.source.digest()))
        obs = tp.replace(obs, accruals=accruals)
        _, candidate = chosen(obs, tp.history(obs), cfg, tp.evidence(obs, cfg))
        self.assertTrue(candidate.allocations and candidate.collections)
        plan = build_execution_plan(context(obs), candidate, plan_policy=PILOT, gas_cap_wei=10**15)
        self.assertEqual(int(plan.liquidityIncrease), candidate.liquidityIncrease * 9950 // 10000)
        needs = addition_amounts(candidate.destination, int(obs.sqrtPriceX96), int(plan.liquidityIncrease))
        floors = exact_floors(obs, candidate.allocations)
        self.assertTrue(needs[0] >= floors[0] and needs[1] >= floors[1])

    def test_exact_floors_charge_one_service_cut_per_source_budget(self):
        # The three USDG lots of 27 September 2026 share one source: the engine
        # cuts its fee once on their sum, not once per lot.
        obs, _, _ = v4_setup()
        lot = obs.balances[0]
        amounts = (3381676, 26188, 36723)
        lots = tuple(tp.replace(lot, lotId=identity(310 + i), reconciliationId=identity(410 + i), amountRaw=str(amount))
                     for i, amount in enumerate(amounts))
        charged = tp.replace(lot, lotId=identity(320), reconciliationId=identity(420), amountRaw='5000', convertedCharged=True)
        obs = tp.replace(obs, balances=(*lots, charged))
        allocations = tuple(m.Allocation(lotId=b.lotId, amountRaw=b.amountRaw) for b in (*lots, charged))
        fee = obs.policy.serviceFeeBps
        whole = sum(amounts) - sum(amounts) * fee // 10000
        self.assertEqual(exact_floors(obs, allocations[:3]), (whole, 0))
        self.assertEqual(sum(a - a * fee // 10000 for a in amounts), whole + 1)
        # A charged residual is already net: it is added whole.
        self.assertEqual(exact_floors(obs, allocations), (whole + 5000, 0))

    def test_swap_candidate_carries_the_wire_route_commitment(self):
        obs, hist, cfg = v4_setup(amounts=(2000, 100))
        output = obs.balances[1]
        obs = tp.replace(obs, balances=(obs.balances[0],), accruals=(m.AccrualObservation(source=output.source, amountRaw=output.amountRaw, checkpointId=identity(7000)),))
        hist = tp.history(obs, increment=20)
        ev = tp.evidence(obs, cfg)
        dest = ev.destinations[0].destination
        lower, _ = impact_bounds(int(obs.sqrtPriceX96), obs.policy.limits.maxPriceImpactBps)
        route = v4.SwapPlan(sourceId=identity(1), currencyIn=obs.sequence.poolKey.currency0, amountIn='400', maxOriginal='1', maxCharged='0',
                            minAmountOut='390', sqrtPriceLimitX96=str(lower), priceObservationId=identity(2))
        bounds = m.SwapBounds(enabled=True, adapterId=v4.ADAPTER_ID, adapterVersion=v4.ADAPTER_VERSION,
                              routeCommitment=v4.route_commitment(route, obs.sequence.poolId), currencyIn=obs.sequence.poolKey.currency0,
                              currencyOut=obs.sequence.poolKey.currency1, amountInRaw='400', minAmountOutRaw='390')
        quote = p.SwapQuote(destination=dest, bounds=bounds, evidenceId=identity(701), qualified=True, expiresAt=tp.NOW + 60,
                            expectedAmountOutRaw=392, priceImpactBps=250, slippageBps=100, gasWei=2000, gasQuote=4)
        decision, candidate = chosen(obs, hist, cfg, tp.replace(ev, swaps=(quote,)))
        self.assertIsNotNone(candidate.swap)
        plan = build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**15)
        self.assertTrue(plan.swap.enabled)
        typed = rebuild_v4(plan, obs, context(obs).checkpoints, price_observation_id=PLACEHOLDER_OBSERVATION)
        self.assertEqual((typed.swap.amountIn, typed.swap.minAmountOut, typed.swap.sqrtPriceLimitX96), ('400', '390', str(lower)))
        # A commitment made for another limit cannot be represented on the wire.
        wrong = tp.replace(quote, bounds=tp.replace(bounds, routeCommitment=identity(999)))
        _, candidate = chosen(obs, hist, cfg, tp.replace(ev, swaps=(wrong,)))
        with self.assertRaises(PlanError):
            build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**15)

    def test_successor_candidate_becomes_a_mint_plan(self):
        obs, hist, cfg = v4_setup(trigger=2000, tick=100)
        decision, candidate = chosen(obs, hist, cfg, tp.evidence(obs, cfg))
        self.assertEqual(candidate.action, 'create_domino')
        plan = build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**15)
        self.assertEqual((plan.action, plan.destination.createChild), (3, True))
        typed = rebuild_v4(plan, obs, {plan.destination.tokenId: identity(701)}, price_observation_id=PLACEHOLDER_OBSERVATION)
        self.assertEqual((typed.action, typed.destinationTokenId), (3, '0'))

    def test_waiting_candidate_and_missing_checkpoint_are_refused(self):
        obs, hist, cfg = v4_setup()
        decision = p.plan(obs, hist, cfg, None, now=tp.NOW)
        with self.assertRaisesRegex(PlanError, 'candidate_not_executable'):
            build_execution_plan(context(obs), decision.candidates[0], plan_policy=POLICY, gas_cap_wei=10**15)
        _, candidate = chosen(obs, hist, cfg, tp.evidence(obs, cfg))
        ctx = context(obs)
        bare = ObservationContext(observation=obs, checkpoints={}, member_liquidity={}, last_execution_at=0, pool=ctx.pool, block=ctx.block, diagnostics=())
        with self.assertRaisesRegex(PlanError, 'plan_unrepresentable'):
            build_execution_plan(bare, candidate, plan_policy=POLICY, gas_cap_wei=10**15)

    def test_observation_point_and_id_follow_the_guard_preimage(self):
        obs, hist, cfg = v4_setup()
        _, candidate = chosen(obs, hist, cfg, tp.evidence(obs, cfg))
        plan = build_execution_plan(context(obs), candidate, plan_policy=POLICY, gas_cap_wei=10**15)
        point = observation_point(context(obs), plan)
        self.assertEqual(point, (bytes.fromhex(obs.sequence.poolId[2:]), int(obs.blockNumber), bytes.fromhex(obs.blockHash[2:]),
                                 int(obs.blockTimestamp), int(plan.deadline), int(obs.sqrtPriceX96)))
        guard = cases.address(23)
        expected = '0x' + keccak(encode(['string', 'uint256', 'address', '(bytes32,uint64,bytes32,uint64,uint64,uint160)'],
                                        ['DominoPriceObservationV1', 4663, guard, point])).hex()
        self.assertEqual(observation_id(guard, point), expected)
        self.assertNotEqual(observation_id(cases.address(24), point), expected)
        data = publish_calldata(point)
        self.assertEqual(data[:10], '0x' + keccak(b'publish((bytes32,uint64,bytes32,uint64,uint64,uint160))')[:4].hex())
        self.assertEqual(len(bytes.fromhex(data[2:])), 4 + 6 * 32)
        other = tp.replace(context(obs).observation, blockHash=identity(9))
        with self.assertRaises(PlanError):
            observation_point(ObservationContext(observation=other, checkpoints={}, member_liquidity={}, last_execution_at=0,
                                                 pool=context(obs).pool, block=context(obs).block, diagnostics=()), plan)


if __name__ == '__main__':
    unittest.main()
