"""Mode authority and once-only revenue regressions, without network/signing."""
import unittest
from pydantic import ValidationError
from execution_cases import scenario, position, identity
from test_execution_models import bind
from test_execution_planner import setup, settings, replace
import execution_models as m
import execution_planner as planner
from execution_accounting import consume_allocations
from automation_tariff import valid_tariff


class AutomationTariffTests(unittest.TestCase):
    def test_strict_tariff_and_simple_capacity(self):
        obs, _, _ = scenario()
        for tariff in (0, 199, 201, 399, 401, True, 200.0):
            self.assertFalse(valid_tariff(tariff))
            with self.subTest(tariff=tariff), self.assertRaises(ValidationError):
                replace(obs.policy, serviceFeeBps=tariff)
        with self.assertRaisesRegex(ValidationError, 'invalid_automation_tariff'):
            replace(obs.policy, serviceFeeBps=200)
        self.assertEqual(replace(obs.policy, serviceFeeBps=200, maxPositions=1).serviceFeeBps, 200)
        self.assertEqual(replace(obs.policy, maxPositions=1).serviceFeeBps, 400)

    def test_domino_self_recipe_is_four_percent_and_simple_is_two(self):
        for simple, rate, fee in ((False,400,'40'), (True,200,'20')):
            obs, plan, _ = scenario(simple=simple)
            self.assertEqual(plan.action, 1)
            self.assertEqual(obs.policy.serviceFeeBps, rate)
            m.validate_candidate(plan, obs, now=1700000030, actor=obs.operator)
            lot=obs.balances[0]
            result=consume_allocations([dict(lotId=lot.lotId,sourceId=lot.source.digest(),currency=lot.currency,
                chargeStatus='original_uncharged',amountRaw=lot.amountRaw,reservedRaw=lot.reservedRaw)],
                [a.model_dump() for a in plan.allocations],service_fee_bps=rate)
            self.assertEqual(result['groups'][0]['serviceFeeRaw'],fee)

    def test_simple_refuses_successor_and_redirect_independent_of_selected_recipe(self):
        obs, plan, _ = scenario(simple=True)
        for action in (2,3):
            changed=replace(plan, action=action, destination=replace(plan.destination,createChild=action==3))
            with self.assertRaisesRegex(ValueError,'simple_root_only'):
                m.validate_candidate(changed,obs,now=1700000030,actor=obs.operator)

    def test_simple_does_not_redirect_near_ceiling_and_waits_outside_root(self):
        obs, _, cfg=setup(trigger=2000)
        simple=replace(obs, policy=replace(obs.policy,serviceFeeBps=200,maxPositions=1))
        direct=planner.route_sources(simple,cfg)
        self.assertTrue(direct)
        self.assertTrue(all(r.action=='compound_self' and all(not d.createChild for d in r.destinations) for r in direct))
        domino=planner.route_sources(obs,cfg)
        self.assertTrue(any(r.action=='create_domino' for r in domino))
        outside, _, _=setup(trigger=2000,tick=300)
        simple=replace(outside, policy=replace(outside.policy,serviceFeeBps=200,maxPositions=1))
        self.assertTrue(all(r.action=='wait' for r in planner.route_sources(simple,cfg)))

    def test_inactive_child_history_can_remain_but_cannot_supply_simple_fees(self):
        obs,plan,_=scenario(simple=True)
        root=obs.positions[0]
        child=m.CustodyObservation(position=position(obs.sequence,102,101),holder=obs.sequence.owner,
            individualApproval=m.ZERO,active=False)
        members=tuple(sorted((root,child),key=lambda p:p.position.digest()))
        history=replace(obs,positions=members)
        m.validate_candidate(bind(plan,history),history,now=1700000030,actor=history.operator)
        with self.assertRaises(ValidationError):replace(history,positions=tuple(replace(p,active=True) for p in members))
        foreign=replace(obs.balances[0],source=replace(obs.balances[0].source,position=child.position.digest()))
        history=replace(history,balances=(foreign,))
        with self.assertRaisesRegex(ValueError,'self_source_mismatch'):
            m.validate_candidate(bind(plan,history),history,now=1700000030,actor=history.operator)
        self.assertTrue(all(r.action=='wait' for r in planner.route_sources(history,settings())))

    def test_owner_mode_change_changes_commitment_and_does_not_recharge_prior_lots(self):
        obs,plan,_=scenario(simple=True,charged=True)
        changed=replace(obs,policy=replace(obs.policy,serviceFeeBps=400,version='2',maxPositions=4),stateNonce='8')
        self.assertNotEqual(obs.policy.digest(),changed.policy.digest())
        with self.assertRaisesRegex(ValueError,'candidate_snapshot_mismatch'):
            m.validate_candidate(plan,changed,now=1700000030,actor=changed.operator)
        plan=bind(plan,changed)
        m.validate_candidate(plan,changed,now=1700000030,actor=changed.operator)
        old=changed.balances[0]
        lots=[dict(lotId=old.lotId,sourceId=old.source.digest(),currency=old.currency,
                   chargeStatus='converted_charged',amountRaw='1000',reservedRaw='0'),
              dict(lotId=identity(700),sourceId=old.source.digest(),currency=old.currency,
                   chargeStatus='original_uncharged',amountRaw='1000',reservedRaw='0')]
        allocations=[dict(lotId=x['lotId'],amountRaw='1000') for x in lots]
        for rate,expected in ((400,'40'),(200,'20')):
            result=consume_allocations(lots,allocations,service_fee_bps=rate)
            self.assertEqual(result['groups'][0]['serviceFeeRaw'],expected)
            self.assertEqual(result['groups'][0]['chargedInputRaw'],'1000')

if __name__=='__main__':unittest.main()
