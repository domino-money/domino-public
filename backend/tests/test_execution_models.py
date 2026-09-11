import copy
import json
from pathlib import Path
import unittest

from execution_cases import address, identity, position, scenario, serialized
import execution_models as m
from execution_accounting import consume_allocations
from pydantic import ValidationError


def replace(record, **changes):
    return type(record).model_validate_json(json.dumps({**record.model_dump(mode='json'), **changes}))


def bind(plan, observation, **changes):
    return replace(plan, observationHash=observation.digest(), policyHash=observation.policy.digest(),
        expectedPolicyVersion=observation.policy.version, expectedStateNonce=observation.stateNonce,
        expectedAuthorityGeneration=observation.authorityGeneration, **changes)


class ExecutionIdentityTests(unittest.TestCase):
    def test_static_vectors_and_all_positive_actions(self):
        path = Path(__file__).parent/'fixtures/execution/e1-vectors.json'
        self.assertEqual(path.read_text(), serialized())
        for row in json.loads(path.read_text())['cases']:
            with self.subTest(row['name']):
                obs = m.Observation.model_validate_json(json.dumps(row['observation']))
                plan = m.ExecutionPlan.model_validate_json(json.dumps(row['plan']))
                self.assertIsNone(m.validate_candidate(plan, obs, now=1700000030, actor=obs.operator))
                self.assertEqual(plan.intent_id(), row['intentId'])

    def test_raw_types_reject_coercion_overflow_and_noncanonical_values(self):
        for raw in [1, True, 1.0, '-1', '+1', '01', '1.0', '1e2', ' 1', str(2**128), '9'*79]:
            with self.subTest(raw=raw), self.assertRaises(ValidationError):
                m.Allocation(lotId=identity(1), amountRaw=raw)
        m.Allocation(lotId=identity(1), amountRaw=str(2**128-1))
        for raw in ['0', False]:
            with self.assertRaises(ValidationError):
                m.Allocation(lotId=identity(1), amountRaw=raw)

    def test_closed_fields_and_boolean_types(self):
        obs, plan, _ = scenario()
        for field, value in [('deadline', str(2**64)), ('action', True), ('router', address(40)),
                             ('recipient', address(40)), ('calldata','0x'), ('transactionNonce', '7')]:
            with self.subTest(field=field), self.assertRaises(ValidationError):
                replace(plan, **{field:value})
        with self.assertRaises(ValidationError):
            replace(obs, canonical=1)
        with self.assertRaises(ValidationError):
            replace(obs.sequence, vault=m.ZERO)
        with self.assertRaises(ValidationError):
            replace(obs.sequence, chainId=1)
        for raw in ['0', str(2**127)]:
            with self.assertRaises(ValidationError): replace(plan,liquidityIncrease=raw)

    def test_identity_domains_and_source_cross_links(self):
        obs, plan, _ = scenario()
        for kwargs in [{'owner':2}, {'number':12}, {'manager':10}, {'native':True}, {'reverse':True}]:
            other, otherplan, _ = scenario(**kwargs)
            self.assertNotEqual(plan.intent_id(), otherplan.intent_id())
            self.assertNotEqual(obs.balances[0].source.digest(), other.balances[0].source.digest())
            with self.assertRaises(ValueError):
                m.validate_candidate(plan, other, now=1700000030, actor=other.operator)
            with self.assertRaises(ValidationError):
                replace(obs, balances=[other.balances[0].model_dump(mode='json')])

    def test_core_identity_parent_and_baseline(self):
        obs, _, _ = scenario()
        root = obs.positions[0]
        for changes in [{'corePositionId':identity(999)}, {'generation':'0'}, {'parentTokenId':'101'}]:
            with self.assertRaises(ValidationError):
                member = replace(root, position={**root.position.model_dump(mode='json'), **changes})
                replace(obs, positions=[member.model_dump(mode='json')])
        second = replace(root.position, registrationBaselineId=identity(909))
        self.assertNotEqual(second.digest(), root.position.digest())
        a, b = position(obs.sequence, 102, 103), position(obs.sequence, 103, 102)
        members = [root, m.CustodyObservation(position=a, holder=obs.sequence.vault, individualApproval=m.ZERO, active=True),
                   m.CustodyObservation(position=b, holder=obs.sequence.vault, individualApproval=m.ZERO, active=True)]
        with self.assertRaisesRegex(ValidationError, 'membership_cycle'):
            replace(obs, positions=[p.model_dump(mode='json') for p in sorted(members,key=lambda p:p.position.digest())])

    def test_pool_identity_order_orientation_and_hook_scope(self):
        obs, _, _ = scenario()
        key = obs.sequence.poolKey
        for changes in [{'currency0':key.currency1}, {'hooks':address(33)}, {'fee_pips':8388608}, {'tick_spacing':0}]:
            with self.assertRaises(ValidationError):
                replace(key, **changes)
        with self.assertRaises(ValidationError):
            replace(obs.sequence, poolId=identity(8))
        with self.assertRaises(ValidationError):
            limits = replace(obs.policy.limits, baseCurrency=obs.sequence.quoteCurrency, quoteCurrency=obs.sequence.baseCurrency)
            replace(obs, policy=replace(obs.policy, limits=limits.model_dump()).model_dump())

    def test_credit_dedup_survives_reinclusion_but_evidence_changes(self):
        _, _, credit = scenario()
        again = replace(credit, blockNumber='1240', blockHash=identity(900), amountRaw='1400')
        self.assertEqual(again.credit_id(), credit.credit_id())
        self.assertNotEqual(again.digest(), credit.digest())
        self.assertNotEqual(replace(credit, eventIndex=4).credit_id(), credit.credit_id())
        with self.assertRaises(ValidationError):
            replace(credit, finalized=True, canonical=False)

    def test_source_balance_duplicates_currency_and_overflow(self):
        obs, _, _ = scenario()
        lot = obs.balances[0]
        for changes in [{'reservedRaw':'1301'}, {'currency':obs.sequence.poolKey.currency1}, {'amountRaw':str(2**128)}]:
            with self.assertRaises(ValidationError):
                replace(lot, **changes)
        with self.assertRaises(ValidationError):
            replace(obs, balances=[lot.model_dump(),lot.model_dump()])
        large = replace(lot, amountRaw=str(2**128-1))
        additional = replace(lot, lotId=identity(202), amountRaw='1',reservedRaw='0')
        with self.assertRaises(ValidationError):
            replace(obs, balances=[large.model_dump(),additional.model_dump()])

    def test_every_model_field_is_in_encoding_and_scalar_binding(self):
        obs, plan, _ = scenario()
        for kind in vars(m).values():
            if isinstance(kind,type) and issubclass(kind,m.Record) and kind is not m.Record:
                self.assertEqual(set(kind.model_fields), {name for name,_ in kind.ABI})
        for field,value in [('deadline','1700000059'), ('maxGasCostWei','999'), ('minNetAdded0','979'),
                            ('expectedStateNonce','8'), ('sourceBlockHash',identity(99))]:
            self.assertNotEqual(replace(plan, **{field:value}).intent_id(), plan.intent_id())
        self.assertNotEqual(replace(obs.sequence, serviceFeeRecipient=address(22)).digest(), obs.sequence.digest())
        with self.assertRaises(ValidationError):
            plan.deadline='5'


class ExecutionCandidateTests(unittest.TestCase):
    def setUp(self):
        self.obs, self.plan, _ = scenario()

    def validate(self, plan=None, obs=None, **kwargs):
        return m.validate_candidate(plan or self.plan, obs or self.obs, now=kwargs.get('now',1700000030),
            actor=kwargs.get('actor',self.obs.operator), unresolved_successors=kwargs.get('unresolved_successors',frozenset()))

    def test_policy_state_generation_and_fork_invalidations(self):
        for changes in [{'stateNonce':'8'}, {'authorityGeneration':'2'}, {'blockHash':identity(9)},
                        {'canonical':False}, {'coverageComplete':False}]:
            obs=replace(self.obs, **changes)
            with self.assertRaises(ValueError):
                self.validate(obs=obs)
        for field,value in [('expectedPolicyVersion','2'), ('expectedStateNonce','8'), ('expectedAuthorityGeneration','2')]:
            with self.assertRaises(ValueError):
                self.validate(plan=replace(self.plan, **{field:value}))
        with self.assertRaises(ValidationError):
            replace(self.plan, expectedStateNonce=str(m.U64_MAX))
        with self.assertRaises(ValueError):
            self.validate(obs=replace(self.obs, stateNonce=str(m.U64_MAX)))

    def test_pause_revocation_owner_and_custody(self):
        paused=replace(self.obs, policy=replace(self.obs.policy, paused=True).model_dump())
        with self.assertRaises(ValueError):
            self.validate(plan=bind(self.plan,paused),obs=paused,actor=self.obs.sequence.owner)
        revoked=replace(self.obs, operatorEnabled=False)
        with self.assertRaises(ValueError):
            self.validate(plan=bind(self.plan,revoked),obs=revoked)
        self.validate(plan=bind(self.plan,revoked),obs=revoked,actor=self.obs.sequence.owner)
        unconfigured=replace(revoked, operator=m.ZERO)
        self.validate(plan=bind(self.plan,unconfigured),obs=unconfigured,actor=self.obs.sequence.owner)
        with self.assertRaises(ValidationError): replace(unconfigured,operatorEnabled=True)
        with self.assertRaises(ValueError):
            self.validate(actor=address(999))
        for changes in [{'holder':address(2)}, {'individualApproval':m.ZERO}, {'active':False}]:
            member=replace(self.obs.positions[0], **changes)
            obs=replace(self.obs, positions=[member.model_dump()])
            with self.assertRaises(ValueError):
                self.validate(plan=bind(self.plan,obs),obs=obs)

    def test_clock_expiration_price_and_gas(self):
        for now in [True,-1,1700000000-1,1700000061]:
            with self.assertRaises(ValueError): self.validate(now=now)
        for changes in [{'deadline':'1700000130'}, {'minSqrtPriceX96':str(2**96+1)}, {'maxGasCostWei':'1000000000000001'}]:
            with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,**changes))
        for value in ['0',str(m.MAX_SQRT_RATIO)]:
            with self.assertRaises(ValidationError): replace(self.obs,sqrtPriceX96=value)

    def test_allocation_overreserve_duplicates_and_cap_mismatch(self):
        for rows in [[{'lotId':identity(201),'amountRaw':'1201'}],
                     [{'lotId':identity(202),'amountRaw':'1000'}],
                     [self.plan.allocations[0].model_dump()]*2]:
            with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,allocations=rows))
        with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,maxGrossFee0='999'))
        with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,minNetAdded0='981'))

    def test_live_accrual_is_separate_and_grouped_with_original_reserve(self):
        lot=replace(self.obs.balances[0],amountRaw='49',reservedRaw='0')
        accrual=m.AccrualObservation(source=lot.source,amountRaw='49',checkpointId=identity(700))
        obs=replace(self.obs, balances=[lot.model_dump()],accruals=[accrual.model_dump()])
        plan=bind(self.plan,obs,allocations=[{'lotId':lot.lotId,'amountRaw':'49'}],
            collections=[{'sourceId':lot.source.digest(),'maxGrossRaw':'49'}],maxGrossFee0='98',minNetAdded0='97')
        self.validate(plan=plan,obs=obs)
        with self.assertRaises(ValueError): self.validate(plan=replace(plan,minNetAdded0='98'),obs=obs)
        with self.assertRaises(ValueError): self.validate(plan=replace(plan,collections=[{'sourceId':lot.source.digest(),'maxGrossRaw':'50'}]),obs=obs)
        self.assertFalse(hasattr(accrual,'credit_id'))

    def test_net_path_only_new_collections_self_no_swap(self):
        lot=self.obs.balances[0]
        accrual=m.AccrualObservation(source=lot.source,amountRaw='1000',checkpointId=identity(701))
        obs=replace(self.obs,balances=[],accruals=[accrual.model_dump()])
        plan=bind(self.plan,obs,path=1,allocations=[],collections=[{'sourceId':lot.source.digest(),'maxGrossRaw':'1000'}])
        self.validate(plan=plan,obs=obs)
        with self.assertRaises(ValidationError): replace(self.plan,path=1)
        with self.assertRaises(ValidationError): replace(plan,action=2)

    def test_domino_reservation_survives_changed_range_and_policy(self):
        obs,plan,_=scenario(3)
        changed=replace(plan,destination=replace(plan.destination,tickUpper=660).model_dump())
        self.assertNotEqual(changed.intent_id(),plan.intent_id())
        self.assertEqual(changed.successor_id(),plan.successor_id())
        with self.assertRaises(ValueError): self.validate(plan=changed,obs=obs,unresolved_successors=frozenset([plan.successor_id()]))
        capped=replace(obs,policy=replace(obs.policy,maxPositions=1).model_dump())
        with self.assertRaises(ValueError): self.validate(plan=bind(plan,capped),obs=capped)
        with self.assertRaises(ValueError): self.validate(plan=replace(plan,destination=replace(plan.destination,tickLower=1).model_dump()),obs=obs)

    def test_self_redirect_and_existing_child(self):
        obs,plan,_=scenario(2)
        self.validate(plan=plan,obs=obs)
        with self.assertRaises(ValidationError): replace(obs,policy=replace(obs.policy,maxPositions=1).model_dump())
        with self.assertRaises(ValueError): self.validate(plan=replace(plan,action=1),obs=obs)
        with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,action=2))
        members=[replace(p,holder=address(2)) if not p.position.isRoot else p for p in obs.positions]
        bad=replace(obs,positions=[p.model_dump() for p in members])
        with self.assertRaises(ValueError): self.validate(plan=bind(plan,bad),obs=bad)

    def test_swap_input_is_net_and_typed_pair_only(self):
        swap=m.SwapBounds(enabled=True,adapterId=identity(800),adapterVersion='1',routeCommitment=identity(801),
            currencyIn=self.obs.sequence.poolKey.currency0,currencyOut=self.obs.sequence.poolKey.currency1,
            amountInRaw='980',minAmountOutRaw='1')
        swappable=replace(self.plan,minNetAdded0='0',minNetAdded1='1')
        self.validate(plan=replace(swappable,swap=swap.model_dump()))
        for changes in [{'amountInRaw':'981'}, {'currencyOut':address(999)}]:
            with self.assertRaises(ValueError): self.validate(plan=replace(swappable,swap=replace(swap,**changes).model_dump()))
        with self.assertRaises(ValueError): self.validate(plan=replace(self.plan,swap=swap.model_dump()))
        with self.assertRaises(ValidationError): replace(self.plan.swap,adapterVersion='1')
        obs,plan,_=scenario(charged=True)
        self.validate(plan=replace(plan,minNetAdded0='0',minNetAdded1='1',swap=replace(swap,amountInRaw='1000').model_dump()),obs=obs)

    def test_accounting_boundary_preserves_source_and_converted_charge_status(self):
        for charged in [False,True]:
            obs,plan,_=scenario(charged=charged)
            lots=[{'lotId':b.lotId,'sourceId':b.source.digest(),'currency':b.currency,
                   'chargeStatus':'converted_charged' if b.convertedCharged else 'original_uncharged',
                   'amountRaw':b.amountRaw,'reservedRaw':b.reservedRaw} for b in obs.balances]
            result=consume_allocations(lots,[a.model_dump() for a in plan.allocations],service_fee_bps=obs.policy.serviceFeeBps)
            self.assertEqual(result['groups'][0]['serviceFeeRaw'],'0' if charged else '20')
            self.assertEqual(result['groups'][0]['sourceId'],obs.balances[0].source.digest())
            self.assertEqual(result['remainingLots'][0]['amountRaw'],'300')

    def test_wait_cannot_be_signed_and_failed_read_does_not_mutate_history(self):
        snapshot=copy.deepcopy(self.obs.model_dump())
        wait=m.WaitDecision(action='wait',observationHash=self.obs.digest(),reason='unavailable')
        self.assertFalse(hasattr(wait,'intent_id'))
        with self.assertRaises(ValidationError): replace(self.plan,action=0)
        with self.assertRaises(ValueError): self.validate(obs=replace(self.obs,coverageComplete=False))
        self.assertEqual(snapshot,self.obs.model_dump())


if __name__=='__main__':
    unittest.main()
