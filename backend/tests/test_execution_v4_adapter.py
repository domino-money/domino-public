"""Independent wire reconstruction: actual E1 models, no key or network."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import execution_cases as cases
import execution_models as m
import execution_v4 as v4
from execution_v4_adapter import rebuild_v4,decode_plan,qualify_price,selected_positions

# Every action carries a published observation; these offline rebuilds
# assert the plan's shape, not the publisher record, so one id serves.
OBSERVATION = '0x'+'a7'*32


def changed(record,**values):
    return type(record).model_validate_json(json.dumps({**record.model_dump(mode='json'),**values}))


def fixture(**kwargs):
    original=cases.sequence
    with patch.object(cases,'sequence',side_effect=lambda **kw:changed(original(**kw),implementationVersion='4')):
        observation,plan,credit=cases.scenario(**kwargs)
    points={token:cases.identity(701) for token in selected_positions(plan,observation)}
    return observation,plan,points


class V4AdapterTests(unittest.TestCase):
    def test_rebuild_actions_destinations_budgets_and_canonical_calldata(self):
        for action in (1,2,3):
            for charged in (False,True):
                observation,plan,points=fixture(action=action,charged=charged)
                typed=rebuild_v4(plan,observation,points,price_observation_id=OBSERVATION)
                self.assertEqual(typed.action,0 if action==1 else action)
                self.assertEqual(typed.authority.intentId,plan.intent_id())
                self.assertEqual(typed.destinationTokenId,'0' if action==3 else plan.destination.tokenId)
                self.assertEqual((typed.tickLower,typed.tickUpper),
                    (plan.destination.tickLower,plan.destination.tickUpper) if action==3 else (0,0))
                self.assertEqual(typed.budgets[0].maxOriginal,'0' if charged else '1000')
                self.assertEqual(typed.budgets[0].maxCharged,'1000' if charged else '0')
                self.assertEqual(typed.budgets[0].minOriginal,typed.budgets[0].maxOriginal)
                self.assertEqual(typed.budgets[0].minCharged,typed.budgets[0].maxCharged)
                self.assertEqual(typed.collect,())
                self.assertTrue(all(getattr(typed.authority,key)=='0' for key in ('maxOriginal0','maxOriginal1','maxCharged0','maxCharged1')))
                self.assertEqual(decode_plan(typed.calldata()),typed)
                for data in ('0x00000000'+typed.calldata()[10:],typed.calldata()+'00',typed.calldata()[:-2]):
                    with self.assertRaises(ValueError):decode_plan(data)

    def test_collection_binding_rejects_wrong_or_extra_checkpoint(self):
        observation,plan,points=fixture(collection=True)
        typed=rebuild_v4(plan,observation,points,price_observation_id=OBSERVATION)
        self.assertEqual(len(typed.collect),1)
        self.assertEqual(typed.budgets[0].minOriginal,'0')
        self.assertEqual(typed.collect[0].positionIdentity,observation.positions[0].position.digest())
        for wrong in ({},{**points,'999':cases.identity(701)},{k:cases.identity(702) for k in points}):
            with self.assertRaises(ValueError):rebuild_v4(plan,observation,wrong,price_observation_id=OBSERVATION)
        with self.assertRaises(ValueError):rebuild_v4(plan,changed(observation,canonical=False),points,price_observation_id=OBSERVATION)

    def swap_fixture(self):
        observation,plan,points=fixture(collection=True,swap=True)
        source=observation.accruals[0].source.digest()
        swap=v4.SwapPlan(sourceId=source,currencyIn=plan.swap.currencyIn,amountIn=plan.swap.amountInRaw,
            maxOriginal='1000',maxCharged='0',minAmountOut=plan.swap.minAmountOutRaw,
            sqrtPriceLimitX96=plan.minSqrtPriceX96,priceObservationId=cases.identity(900))
        bounds=changed(plan.swap,adapterId=v4.ADAPTER_ID,adapterVersion=v4.ADAPTER_VERSION,
            routeCommitment=v4.route_commitment(swap,plan.sequence.poolId))
        return observation,changed(plan,swap=bounds.model_dump(mode='json')),points

    def test_swap_uses_fixed_route_and_separate_trusted_price_record(self):
        observation,plan,points=self.swap_fixture()
        typed=rebuild_v4(plan,observation,points,price_observation_id=cases.identity(900))
        self.assertEqual(typed.swap.priceObservationId,cases.identity(900))
        self.assertNotEqual(typed.swap.priceObservationId,plan.swap.routeCommitment)
        self.assertEqual(typed.swap.sqrtPriceLimitX96,plan.minSqrtPriceX96)
        output=next(b for b in typed.budgets if b.currency==plan.swap.currencyOut)
        self.assertEqual((output.sourceId,output.maxOriginal,output.maxCharged,output.minOriginal,output.minCharged),
            (typed.swap.sourceId,'0','0','0','0'))
        self.assertEqual(decode_plan(typed.calldata()),typed)
        # A swap-shaped plan with no observation, and one whose id is not a
        # hash, are both refused before anything is signed.
        with self.assertRaises(ValueError):rebuild_v4(plan,observation,points)
        for bad_id in ('0x'+'0'*64,'not-a-hash',None):
            with self.assertRaises(ValueError):rebuild_v4(plan,observation,points,price_observation_id=bad_id)
        for name,value in (('routeCommitment',cases.identity(999)),('adapterId',cases.identity(888)),('adapterVersion','2')):
            bad=changed(plan,swap=changed(plan.swap,**{name:value}).model_dump(mode='json'))
            with self.assertRaises(ValueError):rebuild_v4(bad,observation,points,price_observation_id=cases.identity(900))

    def test_native_and_orientation_do_not_change_currency_identity(self):
        for native in (True,False):
            for reverse in (True,False):
                observation,plan,points=fixture(native=native,reverse=reverse,collection=True)
                typed=rebuild_v4(plan,observation,points,price_observation_id=OBSERVATION)
                self.assertEqual(typed.budgets[0].currency,plan.sequence.poolKey.currency0)
                self.assertEqual(typed.budgets[0].sourceId,observation.accruals[0].source.digest())

    def test_converted_lot_keeps_original_source_id_and_actual_output_currency(self):
        observation,plan,points=fixture(charged=True)
        lot=changed(observation.balances[0],currency=plan.sequence.poolKey.currency1)
        observation=changed(observation,balances=[lot.model_dump(mode='json')])
        plan=changed(plan,observationHash=observation.digest(),maxChargedInput0='0',maxChargedInput1='1000',minNetAdded0='0',minNetAdded1='980')
        typed=rebuild_v4(plan,observation,points,price_observation_id=OBSERVATION)
        self.assertEqual(typed.budgets[0].sourceId,lot.source.digest())
        self.assertEqual(typed.budgets[0].currency,plan.sequence.poolKey.currency1)
        self.assertNotEqual(typed.budgets[0].currency,lot.source.currency)
        self.assertEqual((typed.budgets[0].maxOriginal,typed.budgets[0].minOriginal,typed.budgets[0].maxCharged,typed.budgets[0].minCharged),('0','0','1000','1000'))

    def test_price_binding_checks_block_pool_timestamp_price_expiry_revocation(self):
        from types import SimpleNamespace
        observation,plan,_=self.swap_fixture()
        head={'timestamp':1700000030,'number':1236,'hash':cases.identity(302)}
        expected=(bytes.fromhex(plan.sequence.poolId[2:]),1234,bytes.fromhex(plan.sourceBlockHash[2:]),1700000000,1700000060,2**96)
        state={'point':expected,'revoked':False,'reference':2**96}
        calls=[]
        def call(target,signature,outputs,block,inputs,values):
            calls.append((signature,block))
            if signature.startswith('observations'):return state['point']
            if signature.startswith('revoked'):return (state['revoked'],)
            return (state['reference'],)
        verifier=SimpleNamespace(_call=call);admission=SimpleNamespace(priceGuard=cases.address(50))
        qualify_price(verifier,admission,plan,observation,head,cases.identity(900))
        self.assertEqual(len(calls),3);self.assertTrue(all(block==head for _,block in calls))
        for index,value in ((0,b'\0'*32),(1,1235),(2,b'\0'*32),(3,1699999999),(4,1700000029),(5,2**96+1)):
            state['point']=tuple(value if i==index else v for i,v in enumerate(expected))
            with self.assertRaises(ValueError):qualify_price(verifier,admission,plan,observation,head,cases.identity(900))
        state['point']=expected
        for key,value in (('revoked',True),('reference',2**96+1)):
            before=state[key];state[key]=value
            with self.assertRaises(ValueError):qualify_price(verifier,admission,plan,observation,head,cases.identity(900))
            state[key]=before
