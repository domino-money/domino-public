"""featured-policy v1 and v2: every rule on its own, the depth walk, and the list it composes."""
import copy
from decimal import Decimal
from fractions import Fraction
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from featured_pools import (MARKET, OPTIONAL_DECIMALS, OPTIONAL_INTEGERS, POLICY_PATH, SAFETY, band_bound,
                            check_policy, compose, depth_usd, eth_usd, evaluate, list_id, load_policy,
                            policy_version, reference_depth, reference_side, refill, symbol_reading, token_reasons)
from v4_math import Q96, amount_delta, sqrt_at_tick, tick_at_sqrt

ZERO='0x'+'0'*40
WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'
PONS='0x39dbed3a2bd333467115de45665cc57f813c4571'
OTHER='0x1111111111111111111111111111111111111111'
POOL='0x'+'4b'*32
NOW=1_790_380_000
DAY=86400
# featured-policy v1, as it ran until v2: every rule on, ranked by the lower of two days' APR.
V1_POLICY_PATH=Path(__file__).resolve().parent/'fixtures/featured_policy_v1.json'
POLICY=load_policy(V1_POLICY_PATH)
# featured-policy v2, shipped: today's APR ranks, above a 24 h volume and a liquidity floor.
V2=load_policy()


def good():
    """A candidate that passes every rule: each test below breaks exactly one."""
    key={'currency0':PONS,'currency1':USDG,'fee_pips':3000,'tick_spacing':60,'hooks':ZERO,'feeMode':'fixed'}
    return {
        'poolId':POOL,
        'market':{'currencies':[PONS,USDG],'baseToken':PONS,'quoteToken':USDG,'dexLabel':'uniswap-v4-robinhood',
                  'volume24hUsd':'1000000','reportedLiquidityUsd':'2000000'},
        'listing':{'transactions24h':{'buys':300,'sells':200,'buyers':120,'sellers':80},
                   'volume6hUsd':'100000','priceChange24hPercent':'-12.5'},
        'chain':{'pool':{'poolId':POOL,'currencies':[PONS,USDG],'poolKey':key,'currentLpFeePips':3000,
                         'protocolFeeRaw':0,'integrationClass':'hookless_fixed_fee'},'liquidity':10**20},
        'estimate':{'status':'available','feeAprEstimate24hPercent':'150.5'},
        'depth':{'status':'measured','usd':'10000'},
        'token':{'address':PONS,'code':True,'codeHash':'0xaa','decimals':18,'symbol':'PONS','proxy':None},
        'age':{'createdAt':NOW-72*3600},
        'providerPriceDeviation':'0.05',
    }


def judged(candidate,*,previous=None,relaxed=False,**kwargs):
    if previous is None:
        previous={POOL:{'eligibleExceptPersistence':True,'freshApr':'120'}}
    return evaluate(candidate,POLICY,now=NOW,previous=previous,relaxed=relaxed,**kwargs)


def changed(path_value_pairs):
    candidate=good()
    for path,value in path_value_pairs:
        target=candidate
        for name in path[:-1]:target=target[name]
        if value is KeyError:del target[path[-1]]
        else:target[path[-1]]=value
    return candidate


class SymbolReadingTests(unittest.TestCase):
    def test_the_site_s_own_examples_read_alike(self):
        # app/src/lib/walletHoldings.ts documents these four.
        self.assertEqual(symbol_reading('PO​NS'),'PONS')
        self.assertEqual(symbol_reading('P0NS'),'PONS')
        self.assertEqual(symbol_reading('ÜSDG'),'USDG')
        self.assertEqual(symbol_reading('USDĢ'),'USDG')
        self.assertEqual(symbol_reading('ЕТН'),'ETH')   # Cyrillic
        self.assertEqual(symbol_reading('w eth'),'WETH')
        self.assertEqual(symbol_reading('LIT'),'IIT')                  # 'L' maps to 'I', as on the site


class PolicyTests(unittest.TestCase):
    def test_the_shipped_policy_is_valid_and_versioned_with_its_overrides(self):
        policy=json.loads(POLICY_PATH.read_text())
        check_policy(policy)
        version=policy_version(policy,{'pins':[]})
        self.assertRegex(version,r'^featured-v1:[0-9a-f]{12}$')
        self.assertEqual(version,policy_version(copy.deepcopy(policy),{'pins':[]}))
        self.assertNotEqual(version,policy_version(policy,{'pins':[{'poolId':POOL,'slot':1}]}))

    def test_a_policy_the_rules_cannot_apply_is_refused(self):
        cases=[('size',0),('size',13),('selectionHourUtc',12.0),('selectionHourUtc',24),('maxPins',7),
               ('selectionRetryUntilMinutes',30),('listingProviderHeadroom',25),('minPublishable',0),
               ('referenceTokens',{'0xABC':{'symbol':'X','decimals':6}}),
               ('ethUsdPricePool','0x1234'),('reviewedTokens',['nope']),
               ('diversity',{'perNonReferenceToken':1,'keep':'best','maxMajorPairs':1}),
               ('persistenceLookbackHours',12)]
        for name,value in cases:
            policy=json.loads(POLICY_PATH.read_text());policy[name]=value
            with self.subTest(name=name,value=value),self.assertRaisesRegex(DataError,'invalid_featured_policy'):
                check_policy(policy)
        for name,value in (('minVolume24hUsd','-1'),('minPoolAgeHours','72'),('maxAprPercent','x')):
            policy=json.loads(POLICY_PATH.read_text());policy['thresholds'][name]=value
            with self.subTest(name=name),self.assertRaisesRegex(DataError,'invalid_featured_policy'):
                check_policy(policy)
        policy=json.loads(POLICY_PATH.read_text());del policy['hysteresis']
        with self.assertRaisesRegex(DataError,'invalid_featured_policy'):check_policy(policy)


class RuleTests(unittest.TestCase):
    def test_the_baseline_passes_every_rule_and_ranks_by_the_lower_apr(self):
        result=judged(good())
        self.assertEqual(result['reasons'],[])
        self.assertTrue(result['eligible'] and result['safe'] and result['eligibleExceptPersistence'])
        self.assertEqual((result['freshApr'],result['prevApr'],result['rankApr']),('150.5','120','120'))
        self.assertEqual((result['reference'],result['token'],result['major']),(USDG,PONS,False))
        self.assertEqual(result['symbolReading'],'PONS')

    def test_each_rule_on_its_own(self):
        key=('chain','pool','poolKey')
        cases=[
            ('identity_unresolved',[(('chain',),{'error':'invalid_pool_key'})]),
            ('identity_unresolved',[(('chain',),None)]),
            ('provider_currency_or_pool_mismatch',[(('market','baseToken'),OTHER)]),
            ('provider_dex_unconfirmed',[(('market','dexLabel'),'uniswap-v3')]),
            ('hooked_pool_unsupported',[(key+('hooks',),'0x'+'22'*20)]),
            ('dynamic_fee_unsupported',[(key+('fee_pips',),0x800000)]),
            ('fixed_fee_mismatch',[(('chain','pool','currentLpFeePips'),2500)]),
            ('fee_out_of_range',[(key+('fee_pips',),1_000_000),(('chain','pool','currentLpFeePips'),1_000_000)]),
            # A zero fee costs its wash volume nothing: such pools ranked from 16 to 25 Oct 2026.
            ('fee_out_of_range',[(key+('fee_pips',),0),(('chain','pool','currentLpFeePips'),0)]),
            ('invalid_protocol_fee',[(('chain','pool','protocolFeeRaw'),1001|(1001<<12))]),
            ('invalid_protocol_fee',[(('chain','pool','protocolFeeRaw'),1001)]),
            ('invalid_protocol_fee',[(('chain','pool','protocolFeeRaw'),1001<<12)]),
            ('protocol_fee_directional_unsupported',[(('chain','pool','protocolFeeRaw'),100|(200<<12))]),
            ('token_metadata_unreadable',[(('token',),None)]),
            ('token_metadata_unreadable',[(('token','address'),OTHER)]),
            ('estimate_not_available',[(('estimate','status'),'stale')]),
            ('estimate_not_available',[(('estimate',),None)]),
            ('no_active_liquidity',[(('chain','liquidity'),0)]),
            ('volume_below_floor',[(('market','volume24hUsd'),'249999.99')]),
            ('volume_below_floor',[(('market','volume24hUsd'),None)]),
            ('tvl_below_floor',[(('market','reportedLiquidityUsd'),'249999.99')]),
            ('reference_depth_below_floor',[(('depth','usd'),'9999.99')]),
            ('reference_depth_unmeasurable',[(('depth',),{'status':'unmeasurable','reason':'too_many_ticks'})]),
            ('reference_depth_unmeasurable',[(('depth',),{'status':'unmeasurable','usd':'50000'})]),
            ('apr_above_ceiling',[(('estimate','feeAprEstimate24hPercent'),'1000.01')]),
            ('turnover_above_ceiling',[(('market','volume24hUsd'),'50000001'),(('listing','volume6hUsd'),'6000000')]),
            ('pool_too_young',[(('age','createdAt'),NOW-72*3600+1)]),
            ('age_unknown',[(('age',),{'createdAt':None})]),
            ('activity_below_floor',[(('listing','transactions24h','buyers'),119)]),
            ('activity_below_floor',[(('listing','transactions24h','sells'),199)]),
            ('activity_below_floor',[(('listing','transactions24h'),None)]),
            ('volume_faded',[(('listing','volume6hUsd'),'99999.99')]),
            ('volume_faded',[(('listing','volume6hUsd'),None)]),
            ('price_move_outlier',[(('listing','priceChange24hPercent'),'-300.01')]),
            ('provider_price_disagreement',[(('providerPriceDeviation',),'0.0501')]),
        ]
        for reason,changes in cases:
            with self.subTest(reason=reason,changes=changes):
                self.assertEqual(judged(changed(changes))['reasons'],[reason])

    def test_references_decide_which_side_is_measured(self):
        for currencies,problem in (([OTHER,PONS],'no_reference_side'),([ZERO,WETH],'same_asset_pair')):
            candidate=changed([(('chain','pool','currencies'),currencies),(('market','currencies'),currencies),
                               (('market','baseToken'),currencies[0]),(('market','quoteToken'),currencies[1])])
            with self.subTest(problem=problem):
                self.assertEqual(judged(candidate)['reasons'],[problem])
        self.assertEqual(reference_side([ZERO,USDG],POLICY),((USDG,ZERO,True),None))
        self.assertEqual(reference_side([WETH,PONS],POLICY),((WETH,PONS,False),None))
        self.assertEqual(reference_side([PONS,USDG],POLICY),((USDG,PONS,False),None))
        major=changed([(('chain','pool','currencies'),[ZERO,USDG]),(('market','currencies'),[ZERO,USDG]),
                       (('market','baseToken'),ZERO),(('market','quoteToken'),USDG),(('token',),None)])
        result=judged(major)
        self.assertEqual((result['reasons'],result['major'],result['token']),([],True,ZERO))

    def test_owner_exclusions_apply_to_pools_and_tokens(self):
        self.assertEqual(judged(good(),excluded_pools={POOL})['reasons'],['excluded_by_owner'])
        self.assertEqual(judged(good(),excluded_tokens={PONS})['reasons'],['excluded_by_owner'])

    def test_the_ceiling_reads_yesterday_too_and_boundaries_pass(self):
        previous={POOL:{'eligibleExceptPersistence':True,'freshApr':'1000.01'}}
        self.assertEqual(judged(good(),previous=previous)['reasons'],['apr_above_ceiling'])
        edge=changed([(('estimate','feeAprEstimate24hPercent'),'1000'),(('market','volume24hUsd'),'250000'),
                      (('market','reportedLiquidityUsd'),'250000'),(('listing','volume6hUsd'),'25000'),
                      (('listing','priceChange24hPercent'),'300'),(('listing','transactions24h'),
                       {'buys':250,'sells':250,'buyers':100,'sellers':100})])
        self.assertEqual(judged(edge)['reasons'],[])
        turnover=changed([(('market','volume24hUsd'),'50000000'),(('listing','volume6hUsd'),'5000000')])
        self.assertEqual(judged(turnover)['reasons'],[])

    def test_persistence_needs_the_previous_evaluation_and_is_the_only_gap_it_forgives(self):
        for previous in ({},{POOL:{'eligibleExceptPersistence':False,'freshApr':'120'}}):
            with self.subTest(previous=previous):
                result=judged(good(),previous=previous)
                self.assertEqual(result['reasons'],['not_persistent'])
                self.assertFalse(result['eligible'])
                self.assertTrue(result['eligibleExceptPersistence'])
        both=judged(changed([(('market','volume24hUsd'),'1')]),previous={})
        self.assertFalse(both['eligibleExceptPersistence'])
        self.assertIsNone(judged(good(),previous={})['rankApr'])

    def test_incumbents_meet_the_volume_liquidity_and_depth_floors_at_seventy_percent(self):
        for path,value in ((('market','volume24hUsd'),'175000'),(('market','reportedLiquidityUsd'),'175000'),
                           (('depth','usd'),'7000')):
            for below,amount in ((False,value),(True,str(float(value)-0.01))):
                candidate=changed([(path,amount)])
                with self.subTest(path=path,below=below):
                    self.assertEqual(judged(candidate,relaxed=True)['eligible'],not below)
                    self.assertFalse(judged(candidate)['eligible'])

    def test_safety_and_market_reasons_do_not_overlap_and_cover_every_code(self):
        self.assertFalse(set(SAFETY)&set(MARKET))
        self.assertEqual(judged(changed([(('chain','liquidity'),0)]))['safe'],False)
        self.assertEqual(judged(changed([(('market','volume24hUsd'),'1')]))['safe'],True)


class PolicyV2Tests(unittest.TestCase):
    """The owner's choice of 28/09: the highest APR today, above US$ 1M of 24 h volume and
    US$ 100k of liquidity; every safety rule stays. On 04/10 the owner added one market rule
    back: US$ 10k of reference depth, after a dry run would have listed two pools with 0% APR
    and US$ 30 and US$ 265 of depth (one with US$ 68M of 24 h volume)."""
    def judged(self,candidate,*,previous=None,relaxed=False,policy=None):
        return evaluate(candidate,V2 if policy is None else policy,now=NOW,
                        previous={} if previous is None else previous,relaxed=relaxed)

    def test_the_shipped_policy_is_the_owner_s(self):
        thresholds=V2['thresholds']
        self.assertEqual((V2['rankBy'],V2['persistence'],V2['fill']),('fresh',False,['fallback']))
        self.assertEqual((thresholds['minVolume24hUsd'],thresholds['minTvlUsd'],thresholds['minReferenceDepthUsd']),
                         ('1000000','100000','10000'))
        self.assertEqual({name for name,value in thresholds.items() if value is None},
                         set(OPTIONAL_DECIMALS+OPTIONAL_INTEGERS)-{'minReferenceDepthUsd'})
        self.assertEqual(V2['hysteresis'],{'incumbentFloorFactor':'1','challengerMargin':'1',
                                           'maxRankedSwapsPerDay':V2['size']})
        self.assertTrue(V2['rejectUpgradeableTokens'])
        # 2 Nov 2026: a finished selection publishes with a single ranked pool (v1 waited for 3).
        self.assertEqual((V2['minPublishable'],POLICY['minPublishable']),(1,3))
        changed=('rankBy','persistence','fill','thresholds','hysteresis','minPublishable')
        self.assertEqual({key:value for key,value in V2.items() if key not in changed},
                         {key:value for key,value in POLICY.items() if key not in changed})
        # What the VM's runs report with no override in force (featured-v1:77cef48e336b until minPublishable 1).
        self.assertEqual(policy_version(V2,{'pins':[],'excludedPools':[],'excludedTokens':[]}),
                         'featured-v1:603500f6d873')

    def test_the_shipped_policy_holds_the_reference_depth_floor(self):
        # 04/10: under US$ 10k, or unmeasurable, is refused; exactly US$ 10k is not.
        for reason,changes in (('reference_depth_below_floor',[(('depth','usd'),'9999.99')]),
                               ('reference_depth_unmeasurable',[(('depth',),{'status':'unmeasurable',
                                                                              'reason':'too_many_ticks'})])):
            with self.subTest(reason=reason):
                result=self.judged(changed(changes))
                self.assertEqual(result['reasons'],[reason])
                self.assertFalse(result['eligible'])
        self.assertTrue(self.judged(changed([(('depth','usd'),'10000')]))['eligible'])

    def test_a_null_threshold_turns_its_rule_off(self):
        # Each change fails exactly its rule under v1 and none under v2 with every
        # optional threshold null (the shipped v2 keeps the depth floor, above).
        cases=[
            ('reference_depth_below_floor',[(('depth','usd'),'9999.99')]),
            ('reference_depth_unmeasurable',[(('depth',),{'status':'unmeasurable','reason':'too_many_ticks'})]),
            ('apr_above_ceiling',[(('estimate','feeAprEstimate24hPercent'),'1000.01')]),
            ('turnover_above_ceiling',[(('market','volume24hUsd'),'50000001'),(('listing','volume6hUsd'),'6000000')]),
            ('pool_too_young',[(('age','createdAt'),NOW-72*3600+1)]),
            ('age_unknown',[(('age',),{'createdAt':None})]),
            ('age_unknown',[(('age',),KeyError)]),
            ('activity_below_floor',[(('listing','transactions24h','buyers'),119)]),
            ('activity_below_floor',[(('listing','transactions24h','sells'),199)]),
            ('activity_below_floor',[(('listing','transactions24h'),None)]),
            ('volume_faded',[(('listing','volume6hUsd'),'99999.99')]),
            ('volume_faded',[(('listing','volume6hUsd'),None)]),
            ('price_move_outlier',[(('listing','priceChange24hPercent'),'-300.01')]),
            ('provider_price_disagreement',[(('providerPriceDeviation',),'0.0501')]),
        ]
        all_off={**V2,'thresholds':{**V2['thresholds'],'minReferenceDepthUsd':None}}
        for reason,changes in cases:
            with self.subTest(reason=reason,changes=changes):
                self.assertEqual(judged(changed(changes))['reasons'],[reason])
                result=self.judged(changed(changes),policy=all_off)
                self.assertEqual(result['reasons'],[])
                self.assertTrue(result['eligible'])
        # Every one of them at once.
        everything=changed([(('depth',),{'status':'unmeasurable','reason':'too_many_ticks'}),
                            (('estimate','feeAprEstimate24hPercent'),'5000'),(('market','volume24hUsd'),'50000001'),
                            (('listing','volume6hUsd'),None),(('age',),{'createdAt':None}),
                            (('listing','transactions24h'),None),(('listing','priceChange24hPercent'),'-900'),
                            (('providerPriceDeviation',),'0.5')])
        self.assertEqual(len(judged(everything)['reasons']),8)
        self.assertEqual(self.judged(everything,policy=all_off)['reasons'],[])
        # Without a previous evaluation, v1 waits a day; v2 does not.
        self.assertEqual(judged(good(),previous={})['reasons'],['not_persistent'])
        self.assertTrue(self.judged(good(),previous={})['eligible'])

    def test_each_activity_floor_is_off_on_its_own(self):
        for off,passes,fails in (('minTraders24h',(('buyers',119),),(('sells',199),)),
                                 ('minSwaps24h',(('sells',199),),(('buyers',119),))):
            policy=copy.deepcopy(POLICY);policy['thresholds'][off]=None
            for field,value in passes:
                with self.subTest(off=off,field=field):
                    candidate=changed([(('listing','transactions24h',field),value)])
                    self.assertEqual(evaluate(candidate,policy,now=NOW,previous={POOL:{'eligibleExceptPersistence':True,
                                                                                       'freshApr':'120'}})['reasons'],[])
            for field,value in fails:
                with self.subTest(off=off,field=field):
                    candidate=changed([(('listing','transactions24h',field),value)])
                    self.assertEqual(evaluate(candidate,policy,now=NOW,previous={POOL:{'eligibleExceptPersistence':True,
                                                                                       'freshApr':'120'}})['reasons'],
                                     ['activity_below_floor'])

    def test_the_two_floors_stay_even_for_incumbents(self):
        for path,floor in ((('market','volume24hUsd'),'1000000'),(('market','reportedLiquidityUsd'),'100000')):
            reason='volume_below_floor' if path[1]=='volume24hUsd' else 'tvl_below_floor'
            for relaxed in (False,True):
                with self.subTest(path=path,relaxed=relaxed):
                    self.assertTrue(self.judged(changed([(path,floor)]),relaxed=relaxed)['eligible'])
                    below=str(Decimal(floor)-Decimal('0.01'))
                    self.assertEqual(self.judged(changed([(path,below)]),relaxed=relaxed)['reasons'],[reason])
                    self.assertEqual(self.judged(changed([(path,None)]),relaxed=relaxed)['reasons'],[reason])

    def test_every_safety_rule_stays(self):
        key=('chain','pool','poolKey')
        for reason,changes in (('hooked_pool_unsupported',[(key+('hooks',),'0x'+'22'*20)]),
                               ('dynamic_fee_unsupported',[(key+('fee_pips',),0x800000)]),
                               ('fee_out_of_range',[(key+('fee_pips',),0),(('chain','pool','currentLpFeePips'),0)]),
                               ('token_upgradeable_unreviewed',[(('token','proxy'),'eip1967')]),
                               ('token_protected_unreviewed',[(('token','symbol'),'TSLA')]),
                               ('estimate_not_available',[(('estimate',),None)]),
                               ('no_active_liquidity',[(('chain','liquidity'),0)])):
            with self.subTest(reason=reason):
                result=self.judged(changed(changes))
                self.assertIn(reason,result['reasons'])
                self.assertFalse(result['eligible'])

    def test_today_s_apr_ranks_and_the_previous_one_is_only_reported(self):
        for previous,prior in (({POOL:{'eligibleExceptPersistence':True,'freshApr':'120'}},'120'),
                               ({POOL:{'eligibleExceptPersistence':False,'freshApr':'900'}},'900'),({},None)):
            with self.subTest(previous=previous):
                result=self.judged(good(),previous=previous)
                self.assertEqual((result['freshApr'],result['prevApr'],result['rankApr'],result['eligible']),
                                 ('150.5',prior,'150.5',True))
        self.assertEqual(judged(good())['rankApr'],'120')

    def test_a_policy_v2_cannot_state_is_refused(self):
        def refused(change):
            policy=copy.deepcopy(V2);change(policy)
            with self.assertRaisesRegex(DataError,'invalid_featured_policy'):check_policy(policy)
        def accepted(change):
            policy=copy.deepcopy(V2);change(policy);check_policy(policy)
        # Ranking by two days needs every eligible pool to have been evaluated the day before.
        refused(lambda p:p.update(rankBy='min_fresh_and_previous'))
        accepted(lambda p:p.update(rankBy='min_fresh_and_previous',persistence=True))
        accepted(lambda p:p.update(persistence=True))
        for rank_by in ('volume','min',None):
            with self.subTest(rank_by=rank_by):
                refused(lambda p:p.update(rankBy=rank_by,persistence=True))
        for name,value in (('rankBy','volume'),('rankBy',None),('persistence',1),('persistence','false'),
                           ('persistence',None),('fill','fallback'),('fill',''),('fill',{'fallback':1}),
                           ('fill',['fallback','fallback']),('fill',['pinned']),('fill',['fallback',None]),
                           ('fill',[['carried']])):
            with self.subTest(name=name,value=value):
                refused(lambda p:p.update({name:value}))
        for fill in ([],['carried'],['fallback'],['carried','fallback'],['fallback','carried']):
            with self.subTest(fill=fill):
                accepted(lambda p:p.update(fill=fill))
        for name in ('rankBy','persistence','fill'):
            with self.subTest(missing=name):
                refused(lambda p:p.pop(name))
        # The floors are required, and every threshold is what the list will state (a decimal string).
        for name,value in (('minVolume24hUsd',None),('minTvlUsd',None),('minTvlUsd',100000),('minTvlUsd','1e5'),
                           ('minTvlUsd','-1'),('minTvlUsd',' 100000'),('minTvlUsd','100000.'),('minTvlUsd',''),
                           ('minVolume24hUsd','1'*225),('maxAprPercent','x'),('maxAprPercent',1000),
                           ('maxTurnover24h',True),('minPoolAgeHours','72'),('minPoolAgeHours',True),
                           ('minPoolAgeHours',-1),('minPoolAgeHours',72.0),('minSwaps24h','500')):
            with self.subTest(name=name,value=value):
                refused(lambda p:p['thresholds'].update({name:value}))
        for name in OPTIONAL_DECIMALS+OPTIONAL_INTEGERS+('minVolume24hUsd','minTvlUsd'):
            with self.subTest(missing=name):
                refused(lambda p:p['thresholds'].pop(name))
        accepted(lambda p:p['thresholds'].update(minTvlUsd='0',minVolume24hUsd='0.5',minPoolAgeHours=0,
                                                 maxAprPercent='1'*224))


class TokenRuleTests(unittest.TestCase):
    base={'address':PONS,'code':True,'codeHash':'0xaa','decimals':18,'symbol':'PONS','proxy':None}

    def reasons(self,policy=POLICY,readings=None,excluded=(),**changes):
        return token_reasons({**self.base,**changes},policy,published_readings=readings or {},excluded_tokens=excluded)

    def test_each_token_rule(self):
        self.assertEqual(self.reasons(),[])
        self.assertEqual(self.reasons(code=False),['token_no_code'])
        for change in ({'decimals':None},{'decimals':37},{'decimals':True},{'symbol':None},{'symbol':''}):
            with self.subTest(change=change):
                self.assertEqual(self.reasons(**change),['token_metadata_unreadable'])
        for symbol in ('A'*33,'PON S','PO​NS','CLAIM','X.COM','WWWX','HTTPX','A/B','A:B','A\x07'):
            with self.subTest(symbol=symbol):
                self.assertIn('token_symbol_unsafe',self.reasons(symbol=symbol))
        self.assertEqual(self.reasons(symbol='A'*32),[])
        for symbol in ('USDG','U5DG','WETH','ETH'):
            with self.subTest(symbol=symbol):
                self.assertEqual(self.reasons(symbol=symbol),['token_lookalike'])
        self.assertEqual(self.reasons(readings={'PONS':OTHER}),['token_lookalike'])
        self.assertEqual(self.reasons(readings={'PONS':PONS}),[])
        self.assertEqual(self.reasons(symbol='DOMINO'),['token_symbol_forbidden'])
        self.assertEqual(self.reasons(symbol='TSLA'),['token_protected_unreviewed'])
        self.assertEqual(self.reasons(symbol='T5LA'),['token_protected_unreviewed'])
        self.assertEqual(self.reasons(proxy='eip1967'),['token_upgradeable_unreviewed'])
        self.assertEqual(self.reasons(baselineCodeHash='0xbb'),['token_code_changed'])
        self.assertEqual(self.reasons(baselineCodeHash='0xaa'),[])
        self.assertEqual(self.reasons(excluded={PONS}),['excluded_by_owner'])

    def test_review_lifts_protection_and_upgradeability_but_not_forbidden_or_lookalike(self):
        reviewed={**POLICY,'reviewedTokens':[PONS]}
        self.assertEqual(self.reasons(policy=reviewed,symbol='TSLA',proxy='eip1967'),[])
        self.assertEqual(self.reasons(policy=reviewed,symbol='DOMINO'),['token_symbol_forbidden'])
        self.assertEqual(self.reasons(policy=reviewed,symbol='USDG'),['token_lookalike'])
        permissive={**POLICY,'rejectUpgradeableTokens':False}
        self.assertEqual(self.reasons(policy=permissive,proxy='eip1967'),[])

    def test_requiring_review_admits_only_reviewed_tokens(self):
        strict={**POLICY,'requireReviewedTokens':True}
        self.assertEqual(self.reasons(policy=strict),['token_unreviewed'])
        self.assertEqual(self.reasons(policy={**strict,'reviewedTokens':[PONS]}),[])


def bitmaps(ticks,spacing):
    words={}
    for tick in ticks:
        compressed=tick//spacing
        words[compressed>>8]=words.get(compressed>>8,0)|(1<<(compressed&255))
    return lambda word:words.get(word,0)


class DepthTests(unittest.TestCase):
    band=Fraction(1,10)

    def walk(self,*,ticks=None,liquidity=10**18,spacing=60,price=None,currency1=True,steps=300):
        price=price or sqrt_at_tick(12345)+12345
        ticks=ticks or {}
        return reference_depth(bitmaps(ticks,spacing),lambda tick:ticks[tick],sqrt_price=price,
                               tick=tick_at_sqrt(price),liquidity=liquidity,tick_spacing=spacing,
                               reference_is_currency1=currency1,band=self.band,max_steps=steps)

    def test_constant_liquidity_releases_the_closed_form_amount(self):
        price=sqrt_at_tick(12345)+12345
        for currency1 in (True,False):
            with self.subTest(currency1=currency1):
                bound=band_bound(price,self.band,zero_for_one=currency1)
                exact=amount_delta(price,bound,10**18,1 if currency1 else 0,False)
                walked=self.walk(price=price,currency1=currency1)
                # One floor per segment between word boundaries.
                self.assertLessEqual(exact-walked,8)
                self.assertGreaterEqual(exact,walked)

    def test_the_band_is_the_same_share_of_either_side(self):
        """A full-range position holds the same share of its value on either side."""
        price=sqrt_at_tick(0)
        up=Fraction(self.walk(price=price,currency1=True),10**18)
        down=Fraction(self.walk(price=price,currency1=False),10**18)
        self.assertAlmostEqual(float(up),float(down),places=6)
        self.assertAlmostEqual(float(up),1-0.9**0.5,places=6)

    def test_a_narrow_position_counts_only_for_its_width(self):
        """The constant-L formula read this pool as a thousand times deeper."""
        spacing=1
        price=sqrt_at_tick(12345)+1
        tick=tick_at_sqrt(price)
        narrow=10**24
        # The only liquidity: one tick wide, from tick to tick+1.
        ticks={tick:narrow,tick+1:-narrow}
        walked=reference_depth(bitmaps(ticks,spacing),lambda t:ticks[t],sqrt_price=price,tick=tick,
                               liquidity=narrow,tick_spacing=spacing,reference_is_currency1=True,
                               band=self.band,max_steps=300)
        only=amount_delta(sqrt_at_tick(tick),price,narrow,1,False)
        self.assertEqual(walked,only)
        constant=amount_delta(price,band_bound(price,self.band,zero_for_one=True),narrow,1,False)
        self.assertGreater(constant,walked*1000)

    def test_liquidity_changes_at_each_initialized_tick_on_the_way(self):
        spacing=60
        price=sqrt_at_tick(6000)+5
        tick=tick_at_sqrt(price)
        # A second position below the price adds liquidity once crossed.
        ticks={5400:-(10**18),4800:10**18}
        total=reference_depth(bitmaps(ticks,spacing),lambda t:ticks[t],sqrt_price=price,tick=tick,
                              liquidity=10**18,tick_spacing=spacing,reference_is_currency1=True,
                              band=self.band,max_steps=300)
        bound=band_bound(price,self.band,zero_for_one=True)
        expected=(amount_delta(sqrt_at_tick(5400),price,10**18,1,False)+
                  amount_delta(max(bound,sqrt_at_tick(4800)),sqrt_at_tick(5400),2*10**18,1,False)+
                  (amount_delta(bound,sqrt_at_tick(4800),10**18,1,False) if bound<sqrt_at_tick(4800) else 0))
        self.assertLessEqual(abs(total-expected),4)

    def test_a_walk_longer_than_allowed_is_unmeasured(self):
        spacing=1
        price=sqrt_at_tick(0)
        ticks={tick:(1 if tick%2 else -1) for tick in range(-1000,0)}
        self.assertIsNone(reference_depth(bitmaps(ticks,spacing),lambda t:ticks[t],sqrt_price=price,tick=0,
                                          liquidity=10**18,tick_spacing=spacing,reference_is_currency1=True,
                                          band=self.band,max_steps=50))

    def test_dollar_value_of_the_depth(self):
        eth=eth_usd(Q96*2)   # (2)^2 * 10^12 USDG per ETH
        self.assertEqual(eth,4*10**12)
        self.assertEqual(depth_usd(5*10**6,USDG,POLICY,None),5)
        self.assertEqual(depth_usd(10**18,ZERO,POLICY,Fraction(2500)),2500)
        self.assertIsNone(depth_usd(10**18,WETH,POLICY,None))


def ev(pool_id,token,rank,*,tvl='1000000',volume='1000000',eligible=True,safe=True,major=False,reading=None):
    return {'poolId':pool_id,'token':token,'rankApr':str(rank),'volume24hUsd':volume,'reportedLiquidityUsd':tvl,
            'eligible':eligible,'safe':safe,'major':major,'symbolReading':reading}


def pid(name):
    return '0x'+name.encode().hex().ljust(64,'0')[:64]


def tok(name):
    return '0x'+name.encode().hex().ljust(40,'0')[:40]


class ComposeTests(unittest.TestCase):
    def names(self,result):
        return [(entry['slot'],NAMES[entry['poolId']],entry['source']) for entry in result['pools']]

    def spec_example(self):
        """FEATURED_POOLS_AUTO.md §5.4, as the owner's list of 25/09 meets the GT sample."""
        pools=[ev(pid('ORBIO'),tok('ORBIO'),546),ev(pid('SHROOM'),tok('SHROOM'),456),
               ev(pid('NOTE'),tok('NOTE'),259),ev(pid('LIT'),tok('LIT'),229),ev(pid('AI'),tok('AI'),191),
               ev(pid('CASHCAT'),tok('CASHCAT'),107),ev(pid('MEME'),tok('MEME'),106),
               ev(pid('ETHUSDG'),ZERO,41,major=True),ev(pid('PONS'),tok('PONS'),48,tvl='6760000'),
               ev(pid('PONS25'),tok('PONS'),124,tvl='500000'),
               ev(pid('DELTA'),tok('DELTA'),529,eligible=False),ev(pid('UFG'),tok('UFG'),529,eligible=False),
               ev(pid('GOOGL'),tok('GOOGL'),191,eligible=False,safe=False)]
        owner=[{'poolId':pid(name)} for name in ('PONS','CASHCAT','AI','SHROOM','DELTA','UFG')]
        return pools,owner

    def test_the_spec_s_worked_example(self):
        pools,owner=self.spec_example()
        result=compose(pools,POLICY,previous_list=owner,pins=[{'poolId':pid('PONS'),'slot':1}],
                       embedded=[entry['poolId'] for entry in owner])
        self.assertEqual(self.names(result),[(1,'PONS','pinned'),(2,'ORBIO','ranked'),(3,'SHROOM','ranked'),
                                             (4,'NOTE','ranked'),(5,'LIT','ranked'),(6,'AI','ranked')])
        self.assertEqual((result['status'],result['rankedSwaps']),('current',1))
        reasons={NAMES[item['poolId']]:item['reason'] for item in result['dropped']}
        self.assertEqual(reasons,{'PONS25':'diversity_same_token','CASHCAT':'replaced_by_challenger',
                                  'MEME':'below_hysteresis','ETHUSDG':'below_hysteresis'})

    def test_the_same_inputs_give_the_same_list_in_any_order(self):
        pools,owner=self.spec_example()
        expected=compose(pools,POLICY,previous_list=owner,pins=[{'poolId':pid('PONS'),'slot':1}])
        for seed in range(5):
            shuffled=pools[:];random.Random(seed).shuffle(shuffled)
            with self.subTest(seed=seed):
                self.assertEqual(compose(shuffled,POLICY,previous_list=owner,
                                         pins=[{'poolId':pid('PONS'),'slot':1}]),expected)

    def test_a_challenger_needs_strictly_more_than_the_margin(self):
        incumbents=[ev(pid(f'I{n}'),tok(f'I{n}'),100+n) for n in range(6)]
        for rank,swaps in (('120',0),('120.0000000001',1)):
            challenger=ev(pid('NEW'),tok('NEW'),rank)
            with self.subTest(rank=rank):
                result=compose(incumbents+[challenger],POLICY,previous_list=[{'poolId':i['poolId']} for i in incumbents])
                self.assertEqual(result['rankedSwaps'],swaps)
        challengers=[ev(pid(f'N{n}'),tok(f'N{n}'),1000+n) for n in range(4)]
        result=compose(incumbents+challengers,POLICY,previous_list=[{'poolId':i['poolId']} for i in incumbents])
        self.assertEqual(result['rankedSwaps'],2)
        self.assertEqual(sorted(NAMES.get(e['poolId'],e['poolId']) for e in result['pools']
                                if e['poolId'] in {c['poolId'] for c in challengers}),['N2','N3'])

    def test_open_slots_fill_without_counting_as_swaps(self):
        pools=[ev(pid(f'N{n}'),tok(f'N{n}'),100+n) for n in range(6)]
        result=compose(pools,POLICY,previous_list=[])
        self.assertEqual((len(result['pools']),result['rankedSwaps'],result['status']),(6,0,'current'))
        self.assertEqual([entry['source'] for entry in result['pools']],['ranked']*6)

    def test_diversity_keeps_the_deepest_pool_of_a_token_and_one_major_pair(self):
        pools=[ev(pid('A1'),tok('A'),500,tvl='400000'),ev(pid('A2'),tok('A'),100,tvl='900000'),
               ev(pid('M1'),ZERO,50,tvl='300000',major=True),ev(pid('M2'),WETH,60,tvl='200000',major=True)]
        result=compose(pools,POLICY,previous_list=[])
        self.assertEqual({NAMES[entry['poolId']] for entry in result['pools']},{'A2','M1'})
        self.assertEqual({NAMES[item['poolId']]:item['reason'] for item in result['dropped']},
                         {'A1':'diversity_same_token','M2':'diversity_major_pair'})

    def test_two_tokens_that_read_alike_cannot_both_show(self):
        pools=[ev(pid('S1'),tok('S1'),300,tvl='900000',reading='SHROOM'),
               ev(pid('S2'),tok('S2'),900,tvl='100000',reading='SHROOM')]
        result=compose(pools,POLICY,previous_list=[])
        self.assertEqual([NAMES[entry['poolId']] for entry in result['pools']],['S1'])
        self.assertEqual(result['dropped'],[{'poolId':pid('S2'),'reason':'token_symbol_duplicate'}])

    def test_a_pin_keeps_its_slot_and_its_token_and_needs_safety_only(self):
        pools=[ev(pid(f'N{n}'),tok(f'N{n}'),100+n) for n in range(6)]
        pin=ev(pid('P'),tok('N5'),1,eligible=False,tvl='1')
        result=compose(pools+[pin],POLICY,previous_list=[],pins=[{'poolId':pid('P'),'slot':3}])
        self.assertEqual(result['pools'][2],{'slot':3,'poolId':pid('P'),'source':'pinned'})
        self.assertNotIn(pid('N5'),[entry['poolId'] for entry in result['pools']])
        unsafe=ev(pid('P'),tok('P'),1,eligible=False,safe=False)
        result=compose(pools+[unsafe],POLICY,previous_list=[],pins=[{'poolId':pid('P'),'slot':1}])
        self.assertNotIn(pid('P'),[entry['poolId'] for entry in result['pools']])
        self.assertIn({'poolId':pid('P'),'reason':'pin_failed_safety'},result['dropped'])

    def test_pins_beyond_the_policy_are_refused(self):
        for pins in ([{'poolId':pid('A'),'slot':1},{'poolId':pid('B'),'slot':2},{'poolId':pid('C'),'slot':3}],
                     [{'poolId':pid('A'),'slot':1},{'poolId':pid('B'),'slot':1}],
                     [{'poolId':pid('A'),'slot':1},{'poolId':pid('A'),'slot':2}],
                     [{'poolId':pid('A'),'slot':7}],[{'poolId':pid('A'),'slot':True}]):
            with self.subTest(pins=pins),self.assertRaisesRegex(DataError,'invalid_featured_pins'):
                compose([],POLICY,previous_list=[],pins=pins)

    def test_short_lists_carry_safe_incumbents_then_safe_fallbacks(self):
        ranked=[ev(pid('R1'),tok('R1'),300),ev(pid('R2'),tok('R2'),200),ev(pid('R3'),tok('R3'),100)]
        carried=ev(pid('C1'),tok('C1'),5,eligible=False)
        unsafe=ev(pid('C2'),tok('C2'),5,eligible=False,safe=False)
        fallback=ev(pid('F1'),tok('F1'),5,eligible=False)
        clash=ev(pid('F2'),tok('R1'),5,eligible=False)
        result=compose(ranked+[carried,unsafe,fallback,clash],POLICY,
                       previous_list=[{'poolId':pid('C2')},{'poolId':pid('C1')}],
                       embedded=[pid('F2'),pid('F1'),pid('MISSING')])
        self.assertEqual(self.names(result),[(1,'R1','ranked'),(2,'R2','ranked'),(3,'R3','ranked'),
                                             (4,'C1','carried'),(5,'F1','fallback')])
        self.assertEqual(result['status'],'current')

    def test_fill_names_what_completes_a_short_list_and_in_which_order(self):
        ranked=[ev(pid('R1'),tok('R1'),300),ev(pid('R2'),tok('R2'),200),ev(pid('R3'),tok('R3'),100)]
        carried=ev(pid('C1'),tok('C1'),5,eligible=False)
        fallback=ev(pid('F1'),tok('F1'),5,eligible=False)
        clash=ev(pid('F2'),tok('R1'),5,eligible=False)
        for fill,rest in (([],[]),(['fallback'],[('F1','fallback')]),(['carried'],[('C1','carried')]),
                          (['fallback','carried'],[('F1','fallback'),('C1','carried')]),
                          (['carried','fallback'],[('C1','carried'),('F1','fallback')])):
            with self.subTest(fill=fill):
                result=compose(ranked+[carried,fallback,clash],{**POLICY,'fill':fill},previous_list=[{'poolId':pid('C1')}],
                               embedded=[pid('F2'),pid('F1')])
                self.assertEqual(self.names(result),[(1,'R1','ranked'),(2,'R2','ranked'),(3,'R3','ranked')]
                                 +[(slot,name,source) for slot,(name,source) in enumerate(rest,start=4)])
        # Only a list's free slots are completed.
        full=[ev(pid(f'N{n}'),tok(f'N{n}'),100+n) for n in range(6)]
        result=compose(full+[fallback],{**POLICY,'fill':['fallback']},previous_list=[],embedded=[pid('F1')])
        self.assertEqual([entry['source'] for entry in result['pools']],['ranked']*6)

    def test_v2_lists_the_best_today_whatever_was_listed_yesterday(self):
        incumbents=[ev(pid(f'I{n}'),tok(f'I{n}'),100+n) for n in range(6)]
        challengers=[ev(pid(f'N{n}'),tok(f'N{n}'),1000+n) for n in range(6)]
        result=compose(incumbents+challengers,V2,previous_list=[{'poolId':i['poolId']} for i in incumbents])
        self.assertEqual([NAMES[entry['poolId']] for entry in result['pools']],['N5','N4','N3','N2','N1','N0'])
        self.assertEqual(result['rankedSwaps'],6)
        # A tie keeps the incumbent; anything above the weakest replaces it.
        for rank,swaps in (('100',0),('100.0000000001',1)):
            with self.subTest(rank=rank):
                result=compose(incumbents+[ev(pid('NEW'),tok('NEW'),rank)],V2,
                               previous_list=[{'poolId':i['poolId']} for i in incumbents])
                self.assertEqual(result['rankedSwaps'],swaps)
        # The embedded list completes it; yesterday's pools that fell out do not.
        ranked=[ev(pid('R1'),tok('R1'),300),ev(pid('R2'),tok('R2'),200),ev(pid('R3'),tok('R3'),100)]
        result=compose(ranked+[ev(pid('C1'),tok('C1'),5,eligible=False),ev(pid('F1'),tok('F1'),5,eligible=False)],V2,
                       previous_list=[{'poolId':pid('C1')}],embedded=[pid('F1')])
        self.assertEqual(self.names(result),[(1,'R1','ranked'),(2,'R2','ranked'),(3,'R3','ranked'),
                                             (4,'F1','fallback')])

    def test_the_embedded_list_completes_a_list_only_with_pools_the_health_check_keeps(self):
        # From 30/10, UBIK, ORBIO and VIRTUAL completed lists and the health check withdrew them 3 h later
        # (volume_collapse). v2's floors: US$ 1M of volume (a tenth: 100k) and US$ 100k of TVL (half: 50k).
        ranked=[ev(pid('R1'),tok('R1'),300),ev(pid('R2'),tok('R2'),200),ev(pid('R3'),tok('R3'),100)]
        fallbacks=[ev(pid('THIN'),tok('THIN'),5,eligible=False,volume='99999.99'),
                   ev(pid('SHALLOW'),tok('SHALLOW'),5,eligible=False,tvl='49999.99'),
                   ev(pid('UNKNOWN'),tok('UNKNOWN'),5,eligible=False,volume=None),
                   ev(pid('EDGE'),tok('EDGE'),5,eligible=False,volume='100000',tvl='50000')]
        embedded=[pid(name) for name in ('THIN','SHALLOW','UNKNOWN','EDGE')]
        result=compose(ranked+fallbacks,V2,previous_list=[],embedded=embedded)
        self.assertEqual(self.names(result),[(1,'R1','ranked'),(2,'R2','ranked'),(3,'R3','ranked'),
                                             (4,'EDGE','fallback')])
        # The same pools complete a repaired list, and no others.
        added=refill([pid('R1'),pid('R2'),pid('R3')],ranked+fallbacks,V2,embedded=embedded)
        self.assertEqual(added,[{'poolId':pid('EDGE'),'source':'fallback'}])

    def test_fewer_than_three_ranked_or_pinned_keeps_yesterday_s_list(self):
        ranked=[ev(pid('R1'),tok('R1'),300),ev(pid('R2'),tok('R2'),200)]
        result=compose(ranked,POLICY,previous_list=[])
        self.assertEqual(result['status'],'carried_over')
        pinned=ev(pid('P'),tok('P'),1,eligible=False)
        result=compose(ranked+[pinned],POLICY,previous_list=[],pins=[{'poolId':pid('P'),'slot':1}])
        self.assertEqual(result['status'],'current')

    def test_v2_publishes_one_ranked_pool_completed_by_the_embedded_list_but_never_none(self):
        # 5 Oct to 2 Nov 2026: on 9 days fewer than 3 pools ranked, and the old list stayed.
        fallbacks=[ev(pid(name),tok(name),5,eligible=False) for name in ('F1','F2')]
        embedded=[pid('F1'),pid('F2')]
        result=compose([ev(pid('R1'),tok('R1'),300)]+fallbacks,V2,previous_list=[],embedded=embedded)
        self.assertEqual((result['status'],self.names(result)),
                         ('current',[(1,'R1','ranked'),(2,'F1','fallback'),(3,'F2','fallback')]))
        # The embedded list alone is no selection: yesterday's list stays.
        result=compose([ev(pid('R1'),tok('R1'),300,eligible=False)]+fallbacks,V2,previous_list=[],embedded=embedded)
        self.assertEqual((result['status'],[entry['source'] for entry in result['pools']]),
                         ('carried_over',['fallback','fallback']))

    def test_list_id_names_the_pools_not_the_figures(self):
        entries=[{'slot':1,'source':'ranked','poolId':POOL,'rankInputs':{'rankApr':'1'},'poolKey':{'fee_pips':3000},
                  'tokens':[],'integrationClass':'hookless_fixed_fee'}]
        other=copy.deepcopy(entries);other[0]['rankInputs']={'rankApr':'2'}
        self.assertEqual(list_id(entries),list_id(other))
        self.assertRegex(list_id(entries),r'^0x[0-9a-f]{64}$')
        other[0]['source']='pinned'
        self.assertNotEqual(list_id(entries),list_id(other))


class RefillTests(unittest.TestCase):
    """What completes a repaired list (featured_live._replacements): the day's eligible pools in the
    order compose chooses them, then the embedded list's pools the health check would keep."""
    def names(self,added):
        return [(NAMES[entry['poolId']],entry['source']) for entry in added]

    def october_30(self):
        """15:00 UTC: USDG/PRIORS, CASHCAT/USDG and PONS/USDG listed; the 0.05% ETH/USDG pool has left,
        and two ETH/USDG pools are eligible: 0.01% (APR 74.0%, US$ 250k) and 0.046% (68.1%, US$ 719k)."""
        kept=[ev(pid(name),tok(name),rank,tvl=tvl) for name,rank,tvl in
              (('PRIORS','120','278000'),('CASHCAT','90','401000'),('PONS','60','1100000'))]
        majors=[ev(pid('ETH001'),ZERO,'74.0',tvl='250000',major=True),
                ev(pid('ETH046'),ZERO,'68.1',tvl='719000',major=True)]
        return [item['poolId'] for item in kept],kept+majors

    def test_a_repair_keeps_the_deepest_major_pair_as_the_selection_does(self):
        kept,evaluations=self.october_30()
        # The embedded list's major pair is the 0.01% too: it does not complete the list instead.
        added=refill(kept,evaluations,V2,embedded=[pid('ETH001')])
        self.assertEqual(self.names(added),[('ETH046','ranked')])
        chosen=[entry['poolId'] for entry in compose(evaluations,V2,previous_list=[])['pools']]
        self.assertIn(pid('ETH046'),chosen)
        self.assertNotIn(pid('ETH001'),chosen)

    def test_the_deepest_pool_not_ready_yet_keeps_its_place_from_a_shallower_one(self):
        # It is kept warm as a candidate and completes the list once ready; the 0.01% never does.
        kept,evaluations=self.october_30()
        asked=[]

        def ready(pool_id):
            asked.append(pool_id)
            return pool_id!=pid('ETH046')
        self.assertEqual(refill(kept,evaluations,V2,embedded=[pid('ETH001')],ready=ready),[])
        self.assertNotIn(pid('ETH001'),asked)

    def test_the_deepest_pool_of_each_token_then_the_best_apr(self):
        evaluations=[ev(pid('A1'),tok('A'),500,tvl='400000'),ev(pid('A2'),tok('A'),100,tvl='900000'),
                     ev(pid('B'),tok('B'),200,tvl='300000'),ev(pid('S1'),tok('S1'),900,eligible=False)]
        policy={**V2,'size':2}
        self.assertEqual(self.names(refill([],evaluations,policy)),[('B','ranked'),('A2','ranked')])
        self.assertEqual(self.names(refill([pid('S1')],evaluations,policy)),[('B','ranked')])
        # A full list asks no pool whether it is ready.
        self.assertEqual(refill([pid('S1'),pid('B')],evaluations,policy,ready=lambda pool_id:1/0),[])


NAMES={pid(name):name for name in ('ORBIO','SHROOM','NOTE','LIT','AI','CASHCAT','MEME','ETHUSDG','PONS','PONS25',
                                    'DELTA','UFG','GOOGL','NEW','A1','A2','M1','M2','S1','S2','P','R1','R2','R3',
                                    'C1','C2','F1','F2','THIN','SHALLOW','UNKNOWN','EDGE','PRIORS','ETH001','ETH046',
                                    'B')}
NAMES.update({pid(f'I{n}'):f'I{n}' for n in range(6)})
NAMES.update({pid(f'N{n}'):f'N{n}' for n in range(6)})


if __name__=='__main__':unittest.main()
