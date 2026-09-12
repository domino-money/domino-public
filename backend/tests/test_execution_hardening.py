import copy
import itertools
import json
import unittest

from pydantic import ValidationError

import execution_models as m
from execution_receipts import PlanEffects, reconcile_plan_effects, validate_balance_lineage
from execution_cases import address, identity, position, scenario
from test_execution_models import bind, replace


def effect_fixture(*, collection=False, swap=False, actual=1000):
    obs, plan, credit = scenario(collection=collection, swap=swap)
    source = credit.source
    row = dict(sourceId=source, currency=obs.sequence.poolKey.currency0,
        originalBeforeRaw='0' if collection else '1300', chargedBeforeRaw='0',
        grossOriginalRaw='1000', chargedInputRaw='0', serviceFeeRaw='20',
        liquidityFromInputRaw='0' if swap else '980', liquidityFromSwapRaw='0',
        swapInRaw='980' if swap else '0', swapOutRaw='0',
        originalAfterRaw=str(actual-1000) if collection else '300', chargedAfterRaw='0')
    rows, swaps = [row], []
    if swap:
        rows.append(dict(sourceId=source, currency=obs.sequence.poolKey.currency1,
            originalBeforeRaw='0', chargedBeforeRaw='0', grossOriginalRaw='0', chargedInputRaw='0',
            serviceFeeRaw='0', liquidityFromInputRaw='0', liquidityFromSwapRaw='500',
            swapInRaw='0', swapOutRaw='550', originalAfterRaw='0', chargedAfterRaw='50'))
        swaps.append(dict(swapId=identity(901), currencyIn=obs.sequence.poolKey.currency0,
            currencyOut=obs.sequence.poolKey.currency1, amountOutRaw='550',
            inputs=[dict(sourceId=source, amountInRaw='980')]))
    tx, block_hash = identity(402), identity(302)
    collection_credit = replace(credit, transactionHash=tx, blockNumber='1235', blockHash=block_hash,
                               amountRaw=str(actual))
    effects = PlanEffects.model_validate_json(json.dumps(dict(intentId=plan.intent_id(),
        transactionHash=tx, blockNumber='1235', blockHash=block_hash, blockTimestamp='1700000030',
        canonical=True, serviceFeeRecipient=obs.sequence.serviceFeeRecipient,
        destinationTokenId=plan.destination.tokenId, tickLower=plan.destination.tickLower,
        tickUpper=plan.destination.tickUpper, liquidityIncrease=plan.liquidityIncrease,
        collections=[collection_credit.model_dump(mode='json')] if collection else [], balances=rows, swaps=swaps)))
    return obs, plan, effects


class DerivedRecordTests(unittest.TestCase):
    def test_copied_and_constructed_plans_cannot_skip_validation(self):
        obs, plan, _ = scenario()
        mutations = [dict(allocations=plan.allocations*2, maxGrossFee0='2000'),
            dict(expectedStateNonce=str(m.U64_MAX)), dict(liquidityIncrease='0'),
            dict(liquidityIncrease=str(2**127)), dict(expectedAuthorityGeneration=str(m.U64_MAX)),
            dict(maxGrossFee0=1000)]
        for change, construct in itertools.product(mutations, (False, True)):
            with self.subTest(change=change, construct=construct), self.assertRaises(ValueError):
                bad = (m.ExecutionPlan.model_construct(**{**plan.__dict__, **change}) if construct
                       else plan.model_copy(update=change))
                m.validate_candidate(bad, obs, now=1700000030, actor=obs.operator)

    def test_nested_foreign_source_cannot_cross_derived_observation_boundary(self):
        obs, plan, _ = scenario(2)
        foreign, _, _ = scenario(owner=2)
        bad_lot = obs.balances[0].model_copy(update={'source': foreign.balances[0].source})
        bad_obs = obs.model_copy(update={'balances': (bad_lot,)})
        bad_plan = plan.model_copy(update={'observationHash': bad_obs.digest()})
        with self.assertRaisesRegex(ValueError, 'foreign_fee_source'):
            m.validate_candidate(bad_plan, bad_obs, now=1700000030, actor=obs.operator)

    def test_duplicate_json_keys_at_top_nested_array_and_escaped_name(self):
        for payload in ['{"lotId":"'+identity(1)+'","amountRaw":"1","amountRaw":"999"}',
                        '{"a":{"x":1,"x":2}}', '{"a":[{"x":1,"x":2}]}',
                        '{"amountRaw":"1","amount\\u0052aw":"999"}']:
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, 'duplicate_json_key'):
                m.parse_execution_json(m.Allocation, payload)
        obs, plan, _ = scenario()
        self.assertEqual(m.parse_execution_json(m.ExecutionPlan, plan.model_dump_json()), plan)
        self.assertEqual(m.parse_execution_json(m.Observation, obs.model_dump_json().encode()), obs)
        with self.assertRaises(ValueError):
            m.parse_execution_json(m.Allocation, '{"lotId":NaN}')

    def test_zero_nft_ids_and_parent_sentinel(self):
        obs, plan, _ = scenario()
        with self.assertRaises(ValidationError):
            replace(obs.positions[0].position, tokenId='0')
        with self.assertRaises(ValidationError):
            replace(plan.destination, tokenId='0')
        self.assertEqual(obs.positions[0].position.parentTokenId, '0')

    def test_missing_ancestor_never_raises_stop_iteration_or_truncates_map(self):
        obs, _, _ = scenario()
        root = obs.positions[0]
        children = [m.CustodyObservation(position=position(obs.sequence, 102, 999),
            holder=obs.sequence.vault, individualApproval=m.ZERO, active=False),
            m.CustodyObservation(position=position(obs.sequence, 103, 102),
            holder=obs.sequence.vault, individualApproval=m.ZERO, active=False)]
        for members in itertools.permutations([root, *children]):
            data = {**obs.model_dump(mode='json'), 'positions':
                [p.model_dump(mode='json') for p in sorted(members, key=lambda p:p.position.digest())]}
            with self.assertRaisesRegex(ValidationError, 'unknown_parent'):
                list(map(lambda d: m.parse_execution_json(m.Observation, json.dumps(d)), [data, data]))

    def test_long_shared_lineage_and_cycle_are_iterative(self):
        obs, _, _ = scenario()
        members = list(obs.positions)
        for token in range(102, 1126):
            members.append(m.CustodyObservation(position=position(obs.sequence, token, token-1),
                holder=obs.sequence.vault, individualApproval=m.ZERO, active=False))
        data = {**obs.model_dump(mode='json'), 'positions':
            [p.model_dump(mode='json') for p in sorted(members, key=lambda p:p.position.digest())]}
        deep = m.parse_execution_json(m.Observation, json.dumps(data))
        self.assertEqual(len(deep.positions), 1025)
        last = members[-1]
        members[1] = replace(members[1], position=replace(members[1].position,
            parentTokenId=last.position.tokenId).model_dump())
        with self.assertRaisesRegex(ValidationError, 'membership_cycle'):
            replace(obs, positions=[p.model_dump() for p in sorted(members,key=lambda p:p.position.digest())])

    def test_exact_minimum_swap_output_budget_500_accepts_501_rejects(self):
        obs, plan, _ = scenario(collection=True, swap=True)
        m.validate_candidate(plan, obs, now=1700000030, actor=obs.operator)
        with self.assertRaisesRegex(ValueError, 'minimum_addition_exceeds_net_budget'):
            m.validate_candidate(replace(plan,minNetAdded1='501'), obs, now=1700000030, actor=obs.operator)


class ReceiptIdentityTests(unittest.TestCase):
    def test_receipt_local_ordinal_survives_changed_block_log_index_including_native(self):
        for native in (False, True):
            _, _, credit = scenario(native=native)
            # All receipt logs count, including unrelated events before the fee event.
            logs_before = [{'logIndex':hex(10+i)} for i in range(5)]
            logs_after = [{'logIndex':hex(40+i)} for i in range(5)]
            first = replace(credit, eventIndex=next(i for i,log in enumerate(logs_before) if log['logIndex']=='0xd'))
            again = replace(credit, eventIndex=next(i for i,log in enumerate(logs_after) if log['logIndex']=='0x2b'),
                            blockNumber='1300', blockHash=identity(999))
            self.assertEqual(first.credit_id(), again.credit_id())
            self.assertNotEqual(first.digest(), again.digest())
            self.assertNotEqual(first.credit_id(), replace(again,eventIndex=43).credit_id())

    def test_one_credit_cannot_be_renamed_or_fragmented_into_two_balances(self):
        for charged in (False, True):
            obs, _, _ = scenario(charged=charged)
            first = obs.balances[0]
            second = replace(first, lotId=identity(210))
            with self.assertRaisesRegex(ValidationError, 'duplicate_reconciliation_reference'):
                replace(obs, balances=[first.model_dump(), second.model_dump()])
            # Different credit/allocation origins remain legitimate, same source.
            replace(obs, balances=[first.model_dump(), replace(second,reconciliationId=identity(211)).model_dump()])

    def test_original_credit_and_conversion_lineage_binding_and_reinclusion(self):
        obs, _, credit = scenario()
        original = replace(obs.balances[0], reconciliationId=credit.credit_id())
        bound = replace(obs, balances=[original.model_dump()])
        validate_balance_lineage(bound, [credit], [])
        with self.assertRaisesRegex(ValueError, 'duplicate_lineage_origin'):
            validate_balance_lineage(bound, [credit, replace(credit,blockHash=identity(999))], [])
        with self.assertRaisesRegex(ValueError, 'original_credit_lineage_mismatch'):
            validate_balance_lineage(bound, [replace(credit,amountRaw='1299')], [])
        lineage = m.ConvertedLotLineage(source=credit.source, transactionHash=identity(500), eventIndex=2,
            currency=obs.sequence.poolKey.currency1,
            inputAllocations=(m.Allocation(lotId=original.lotId, amountRaw='400'),))
        changed = replace(lineage,inputAllocations=[dict(lotId=original.lotId,amountRaw='401')])
        self.assertEqual(lineage.allocation_id(), changed.allocation_id())
        self.assertNotEqual(lineage.digest(), changed.digest())
        converted = replace(original, lotId=identity(220), convertedCharged=True,
            currency=lineage.currency, reconciliationId=lineage.allocation_id(),amountRaw='80',reservedRaw='0')
        bound = replace(obs,balances=[original.model_dump(),converted.model_dump()])
        validate_balance_lineage(bound,[credit],[lineage])
        with self.assertRaisesRegex(ValueError,'duplicate_lineage_origin'):
            validate_balance_lineage(bound,[credit],[lineage,changed])
        with self.assertRaisesRegex(ValueError,'converted_lineage_mismatch'):
            validate_balance_lineage(bound,[credit],[])
        with self.assertRaisesRegex(ValidationError,'duplicate_or_unsorted_records'):
            replace(lineage,inputAllocations=[lineage.inputAllocations[0].model_dump()]*2)


class PlanEffectTests(unittest.TestCase):
    def check(self, obs, plan, effects):
        return reconcile_plan_effects(plan,obs,effects,actor=obs.operator)

    def test_direct_and_fee_collection_and_swap_independent_effects(self):
        for collection, swap, amount in [(False,False,1000),(True,False,1000),(True,True,1000),(True,True,1100)]:
            obs,plan,effects=effect_fixture(collection=collection,swap=swap,actual=amount)
            before=copy.deepcopy(effects.model_dump())
            result=self.check(obs,plan,effects)
            self.assertEqual(effects.model_dump(),before)
            self.assertEqual(sum(int(r['serviceFeeRaw']) for r in result['balances']),20)
            if amount==1100:
                self.assertEqual(result['balances'][0]['originalAfterRaw'],'100')

    def test_independent_after_balance_and_fee_mutations_fail(self):
        obs,plan,effects=effect_fixture()
        for field in ('originalBeforeRaw','chargedBeforeRaw','grossOriginalRaw','chargedInputRaw',
                      'serviceFeeRaw','swapInRaw','swapOutRaw','originalAfterRaw','chargedAfterRaw'):
            row=effects.balances[0]
            bad=replace(row,**{field:str(int(getattr(row,field))+1)})
            with self.subTest(field=field),self.assertRaises(ValueError):
                self.check(obs,plan,replace(effects,balances=[bad.model_dump()]))

    def test_swap_only_receipt_fails_plan_minimum_even_if_arithmetic_conserves(self):
        obs,plan,effects=effect_fixture(collection=True,swap=True)
        rows=[b.model_dump() for b in effects.balances]
        rows[1].update(liquidityFromSwapRaw='0',chargedAfterRaw='550')
        with self.assertRaisesRegex(ValueError,'receipt_minimum_addition_shortfall'):
            self.check(obs,plan,replace(effects,balances=rows))

    def test_actual_minimum_500_accepts_499_rejects(self):
        obs,plan,effects=effect_fixture(collection=True,swap=True)
        self.check(obs,plan,effects)
        rows=[b.model_dump() for b in effects.balances]
        rows[1].update(liquidityFromSwapRaw='499',chargedAfterRaw='51')
        with self.assertRaisesRegex(ValueError,'receipt_minimum_addition_shortfall'):
            self.check(obs,plan,replace(effects,balances=rows))

    def test_realized_shortfall_never_tops_up_exact_swap_or_direct_minimum(self):
        for swapping in (False,True):
            obs,plan,effects=effect_fixture(collection=True,swap=swapping)
            small=replace(effects.collections[0],amountRaw='999')
            with self.assertRaisesRegex(ValueError,'realized_collection_shortfall_or_cap'):
                self.check(obs,plan,replace(effects,collections=[small.model_dump()]))
            # Lower consumption does not evade the exact swap/minimum guards.
            rows=[b.model_dump() for b in effects.balances]
            rows[0].update(grossOriginalRaw='999',serviceFeeRaw='19')
            # 999 - floor(999*2%) = 980, so 999 remains economically sufficient.
            self.check(obs,plan,replace(effects,collections=[small.model_dump()],balances=rows))
            smaller=replace(small,amountRaw='998')
            rows[0].update(grossOriginalRaw='998')
            if not swapping: rows[0]['liquidityFromInputRaw']='979'
            with self.assertRaises(ValueError):
                self.check(obs,plan,replace(effects,collections=[smaller.model_dump()],balances=rows))

    def test_exact_swap_input_output_and_extra_currencies_are_bound(self):
        obs,plan,effects=effect_fixture(collection=True,swap=True)
        for change in [dict(amountOutRaw='499'),dict(currencyIn=address(999)),
                       dict(inputs=[dict(sourceId=effects.collections[0].source,amountInRaw='979')])]:
            bad=replace(effects.swaps[0],**change)
            with self.assertRaisesRegex(ValueError,'receipt_swap_bounds_mismatch'):
                self.check(obs,plan,replace(effects,swaps=[bad.model_dump()]))

    def test_duplicate_credit_reorg_noncanonical_and_changed_receipt_identity(self):
        obs,plan,effects=effect_fixture(collection=True)
        for change in [dict(collections=[effects.collections[0].model_dump()]*2),dict(canonical=False),
                       dict(intentId=identity(998)),dict(serviceFeeRecipient=address(998)),
                       dict(destinationTokenId='0'),dict(liquidityIncrease='2'),dict(tickUpper=240)]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.check(obs,plan,replace(effects,**change))
        wrong=replace(effects.collections[0],blockHash=identity(998))
        with self.assertRaisesRegex(ValueError,'realized_collection_identity_mismatch'):
            self.check(obs,plan,replace(effects,collections=[wrong.model_dump()]))


if __name__=='__main__':
    unittest.main()
