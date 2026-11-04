"""Featured pools on Base and Arbitrum One, in shadow, end to end against real PostgreSQL.

GeckoTerminal is scripted per network and the chain is a scripted hosted provider behind v2_rpc's own transport
(test_featured_chains); everything between them is the code that runs in production. Robinhood's rows share the
tables, and no chain's selection, store or health check may reach another's.
"""
from datetime import date, timedelta
from decimal import Decimal
from fractions import Fraction
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from eth_abi import encode

from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import DataError, ZERO
from featured_chain_selector import HEALTH_SECONDS, ChainSelector
from featured_chains import load_chain_policy, network_of
from featured_live import window
import featured_pools as rules
from featured_store import FeaturedStore, utc_date
from gt_listing import GeckoListing
from manage_featured_chain import tick
from selected_pools import CHAIN_SELECTED_POOLS
from v2_uniswap import v3_pool_address
from test_featured_chains import (ALCHEMY, BASE, CBBTC, CHAINSTACK, DAY, ETH_TOKEN_SQRT, FAKE_USDC, NOW, POLICY, PROXY,
                                  TOKEN, USDC, WETH, WETH_USDC_SQRT, Chain, Provider, endpoints, feed, gt_pool, sel,
                                  sqrt_of, token, v3_pool, v4_pool)

V3_LABEL,V4_LABEL='uniswap-v3-base','uniswap-v4-base'
WETH_USDC=v3_pool_address(BASE,WETH,USDC,500)
CBBTC_USDC=v3_pool_address(BASE,USDC,CBBTC,500)
CBBTC_SQRT=sqrt_of(Fraction(1,1000))       # 100,000 USDC (6 decimals) per cbBTC (8)
MIGRATIONS=('001_catalogue','002_activity','020_pool_requests','023_pool_request_scheduling','024_public_observations',
            '025_public_history','026_public_demand','042_provider_priority','043_featured_pools','044_demand_horizon',
            '045_featured_live','047_provider_ceiling','055_featured_chains')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class ChainSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_featured_chain_tests'}
        with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations=Path(__file__).resolve().parents[1]/'migrations'
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            for name in MIGRATIONS:
                conn.execute((migrations/(name+'.sql')).read_text())

    def setUp(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''TRUNCATE domino_public.featured_current,domino_public.featured_lists,
              domino_public.featured_runs,domino_public.featured_overrides,domino_public.featured_token_checks,
              domino_public.featured_health,domino_public.provider_requests''')
        self.catalogue=PgCatalogue(self.settings)
        self.store=FeaturedStore(self.catalogue,8453)
        self.robinhood=FeaturedStore(self.catalogue)
        self.clock=[NOW]
        self.monotonic,self.waits=[0.0],[]
        self.fake=Chain()
        token(self.fake,CBBTC,'cbBTC',8,PROXY)
        token(self.fake,TOKEN,'TOKEN')
        v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18)
        v3_pool(self.fake,USDC,CBBTC,500,10,sqrt=CBBTC_SQRT,liquidity=10**11)
        self.eth_token=v4_pool(self.fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23)
        self.rows={WETH_USDC:gt_pool(WETH_USDC,WETH,USDC,dex=V3_LABEL,volume='50000000',tvl='20000000'),
                   CBBTC_USDC:gt_pool(CBBTC_USDC,CBBTC,USDC,dex=V3_LABEL,volume='5000000',tvl='3000000'),
                   self.eth_token:gt_pool(self.eth_token,TOKEN,ZERO,dex=V4_LABEL,volume='2000000',tvl='1000000')}
        thin=gt_pool('0x'+'71'*20,TOKEN,USDC,dex=V3_LABEL,tvl='50000')
        self.provider=Provider({V3_LABEL:[[self.rows[WETH_USDC],self.rows[CBBTC_USDC],thin]],
                                V4_LABEL:[[self.rows[self.eth_token]]]},multi=list(self.rows.values()))

    def selector(self,**changes):
        options=dict(store=self.store,policy=POLICY,chain=BASE,endpoints=endpoints(self.fake),
                     listing=GeckoListing(transport=self.provider,clock=lambda:self.clock[0],reserve=lambda:True,
                                          network=network_of(POLICY)),
                     clock=lambda:self.clock[0],sleep=self.wait,monotonic=lambda:self.monotonic[0])
        return ChainSelector(**{**options,**changes})

    def wait(self,seconds):
        self.waits.append(seconds)
        self.monotonic[0]+=seconds

    def at(self,now):
        """The clocks at `now`: the selection's, and the chain's head and Chainlink round a little before it."""
        self.clock[0]=now
        self.fake.head['timestamp']=hex(now-5)
        feed(self.fake)

    def payload(self,revision):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            return conn.execute('SELECT chain_id,phase,status,payload FROM domino_public.featured_lists WHERE revision=%s',
                                (revision,)).fetchone()

    def count(self,table,where='true'):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            return conn.execute(sql.SQL('SELECT count(*) FROM {} WHERE {}').format(sql.SQL(table),sql.SQL(where))).fetchone()[0]

    # ---------------------------------------------------------------- selection
    def test_a_shadow_list_of_verified_v3_and_v4_pools_read_through_the_v2_endpoints(self):
        result=self.selector().select(now=NOW)
        self.assertEqual(result['outcome'],'selected',result)
        self.assertEqual((result['chainId'],result['candidates'],result['screened'],result['evaluated'],result['eligible']),
                         (8453,4,1,3,3))
        self.assertEqual(result['rejectedByReason'],{'tvl_below_floor':1})
        # Two listing pages, v3 then v4, and five billed calls: the head, the identity round, two eth_getCode
        # (cbBTC, TOKEN) in one envelope, the bitmap round. No tick sits in any band.
        self.assertEqual(result['providerCalls'],2)
        self.assertEqual([url.split('/dexes/')[1].split('/')[0] for url in self.provider.urls],[V3_LABEL,V4_LABEL])
        self.assertEqual(result['rpcItems'],len(self.fake.log))
        self.assertEqual(self.fake.methods(),['eth_getBlockByNumber','eth_call','eth_getCode','eth_getCode','eth_call'])
        self.assertTrue(all(url==CHAINSTACK for url,_,_ in self.fake.log))
        chain_id,phase,status,payload=self.payload(result['revision'])
        self.assertEqual((chain_id,phase,status,payload['chainId'],payload['phase']),(8453,'shadow','shadow',8453,'shadow'))
        self.assertEqual(payload['policyVersion'],rules.policy_version(POLICY,{'pins':[],'excludedPools':[],
                                                                               'excludedTokens':[]}))
        # The site's estimate ranks them: ETH/TOKEN 219%, WETH/USDC 45.625%, cbBTC/USDC 30.42%.
        pools=payload['pools']
        self.assertEqual([(entry['slot'],entry['poolId'],entry['source'],entry['dex']) for entry in pools],
                         [(1,self.eth_token,'ranked',4),(2,WETH_USDC,'ranked',3),(3,CBBTC_USDC,'ranked',3)])
        self.assertEqual([Decimal(entry['rankInputs']['rankApr']) for entry in pools[:2]],[Decimal('219'),Decimal('45.625')])
        v3,v4=pools[1],pools[0]
        self.assertEqual((v3['address'],v3['identitySource'],v3['chainId'],v3['reference']),
                         (WETH_USDC,'v3_factory_address',8453,USDC))
        self.assertEqual(v3['poolKey'],{'currency0':WETH,'currency1':USDC,'fee_pips':500,'tick_spacing':10,'hooks':ZERO,
                                        'feeMode':'fixed'})
        self.assertEqual((v4['address'],v4['identitySource'],v4['reference']),(None,'position_manager',ZERO))
        self.assertEqual(v4['tokens'],[{'address':ZERO,'symbol':'ETH','decimals':18},
                                       {'address':TOKEN,'symbol':'TOKEN','decimals':18}])
        self.assertEqual(v4['verifiedAt'],{'number':30_000_000,'hash':'0x'+'ab'*32})
        # The depth is the policy's floor's to judge: ETH counted at the profile's Chainlink price.
        self.assertGreater(Decimal(v4['rankInputs']['referenceDepthUsd']),Decimal('10000'))
        self.assertEqual(payload['coverage']['dexes'][V3_LABEL]['pages'],1)
        # Only Base's rows: Robinhood's store reads nothing of it, its tokens are Base's.
        self.assertIsNone(self.robinhood.previous_list('shadow'))
        self.assertIsNone(self.robinhood.latest_run(within_hours=48,now=NOW))
        self.assertEqual(self.robinhood.token_baselines(),{})
        self.assertEqual(sorted(self.store.token_baselines()),sorted([CBBTC,TOKEN]))
        self.assertEqual(self.count('domino_public.featured_current'),0)
        self.assertEqual(self.selector().select(now=NOW+60)['outcome'],'already_done')

    def test_the_canonical_tokens_pass_by_address_and_their_look_alikes_stay_out(self):
        fake_cbbtc='0x'+'cb'*20
        token(self.fake,FAKE_USDC,'USDC',6)
        token(self.fake,fake_cbbtc,'cbBTC',8,PROXY)
        look=v4_pool(self.fake,(ZERO,FAKE_USDC,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23)
        alike=v3_pool(self.fake,USDC,fake_cbbtc,500,10,sqrt=CBBTC_SQRT,liquidity=10**11)
        self.provider.pages[V4_LABEL][0].append(gt_pool(look,FAKE_USDC,ZERO,dex=V4_LABEL,volume='2000000',tvl='1000000'))
        self.provider.pages[V3_LABEL][0].append(gt_pool(alike,fake_cbbtc,USDC,dex=V3_LABEL,volume='5000000',tvl='3000000'))
        result=self.selector().select(now=NOW)
        evaluations={item['poolId']:item for item in
                     self.store.previous_evaluation('shadow',NOW+60,48)['pools'].values()}
        self.assertEqual(evaluations[CBBTC_USDC]['reasons'],[])
        # It reads as the chain's stable, and USDC is a protected symbol: only the stable's address is USDC.
        self.assertEqual(evaluations[look]['reasons'],['token_lookalike','token_protected_unreviewed'])
        self.assertEqual(evaluations[alike]['reasons'],['token_upgradeable_unreviewed','token_protected_unreviewed'])
        self.assertEqual(result['eligible'],3)

    def test_identity_and_the_provider_s_label_are_safety_rules_on_a_chain(self):
        impostor='0x'+'1d'*20                 # WETH/USDC's immutables, at an address its factory never used
        v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,at=impostor)
        unrecorded=v4_pool(self.fake,(ZERO,TOKEN,500,10,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23,recorded=False)
        hooked=v4_pool(self.fake,(ZERO,TOKEN,10000,200,'0x'+'44'*20),sqrt=ETH_TOKEN_SQRT,liquidity=10**23)
        # A real v3 pool the provider lists under its v4 label.
        mislabelled=v3_pool(self.fake,TOKEN,USDC,3000,60,sqrt=CBBTC_SQRT,liquidity=10**15)
        self.provider.pages[V3_LABEL][0][2:]=[gt_pool(impostor,WETH,USDC,dex=V3_LABEL)]
        self.provider.pages[V4_LABEL][0]+=[gt_pool(pool_id,TOKEN,other,dex=V4_LABEL) for pool_id,other in
                                            ((unrecorded,ZERO),(hooked,ZERO),(mislabelled,USDC))]
        self.selector().select(now=NOW)
        reasons={pool_id:item['reasons'] for pool_id,item in
                 self.store.previous_evaluation('shadow',NOW+60,48)['pools'].items()}
        # Unresolved, a pool has no estimate and no depth either, as on Robinhood.
        for pool_id in (impostor,unrecorded):
            self.assertEqual(reasons[pool_id],['identity_unresolved','estimate_not_available',
                                               'reference_depth_unmeasurable'])
        self.assertEqual(reasons[hooked],['hooked_pool_unsupported','estimate_not_available'])
        self.assertEqual(reasons[mislabelled],['provider_dex_unconfirmed'])

    def test_a_listing_cut_short_reads_no_chain_and_bills_nothing(self):
        self.provider.fail_once={V4_LABEL+'/pools':'http_404'}
        result=self.selector().select(now=NOW,final=False)
        self.assertEqual(result['outcome'],'incomplete')
        self.assertEqual((self.fake.log,result['rpcItems'],result['evaluated']),([],0,0))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            coverage=conn.execute('SELECT evaluation->%s FROM domino_public.featured_runs WHERE id=%s',
                                  ('coverage',result['runId'])).fetchone()[0]
        # A wrong DEX id answers 404: the listing stops there, and nothing is selected from half of it.
        self.assertEqual((coverage['stoppedBy'],coverage['dexes'][V3_LABEL]['pages']),('http_404',1))
        self.provider.fail='http_429'
        last=self.selector().select(now=NOW+60,final=True)
        self.assertEqual((last['outcome'],last['revision'],self.fake.log),('carried_over',None,[]))
        # Nor are the pools already shown read through /pools/multi for a run that is incomplete anyway.
        self.assertFalse([url for url in self.provider.urls if '/pools/multi/' in url])
        self.assertTrue(self.store.selection_done('shadow',utc_date(NOW)))
        self.assertFalse(self.robinhood.selection_done('shadow',utc_date(NOW)))

    def test_a_listing_stopped_early_reads_no_shown_pool_either(self):
        self.provider.fail_once={V3_LABEL+'/pools':'http_404'}
        result=self.selector().select(now=NOW,final=False)
        self.assertEqual((result['outcome'],result['providerCalls']),('incomplete',1))
        self.assertEqual([url for url in self.provider.urls if '/pools/multi/' in url],[])

    def test_shown_pools_the_provider_could_not_read_make_the_run_incomplete(self):
        self.provider.pages={V3_LABEL:[[]],V4_LABEL:[[self.rows[self.eth_token]]]}
        self.provider.fail_multi='http_429'
        result=self.selector().select(now=NOW,final=False)
        self.assertEqual((result['outcome'],self.fake.log),('incomplete',[]))

    def test_yesterday_s_pools_meet_the_floors_at_the_incumbent_factor(self):
        # The chains ship Robinhood's factor 1; a policy that relaxes it relaxes yesterday's pools alone.
        policy={**POLICY,'hysteresis':{**POLICY['hysteresis'],'incumbentFloorFactor':'0.7'}}
        self.assertEqual(self.selector(policy=policy).select(now=NOW)['outcome'],'selected')
        self.rows[CBBTC_USDC]['attributes']['volume_usd']['h24']='800000'
        self.provider.multi_rows=list(self.rows.values())
        self.provider.pages={V3_LABEL:[[]],V4_LABEL:[[]]}
        self.at(NOW+DAY)
        self.selector(policy=policy).select(now=NOW+DAY)
        item=self.store.previous_evaluation('shadow',NOW+DAY+60,48)['pools'][CBBTC_USDC]
        self.assertEqual((item['relaxed'],item['eligible']),(True,True))

    def test_a_listed_token_s_code_and_symbol_hold_on_the_next_day(self):
        self.selector().select(now=NOW)
        # TA-5: TOKEN's code changed since it was first listed; TA-3: another token now reads as TOKEN.
        self.fake.codes[TOKEN]='0x6001600055'
        impostor='0x'+'7b'*20
        token(self.fake,impostor,'T0KEN')
        other=v4_pool(self.fake,(ZERO,impostor,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23)
        self.provider.pages[V4_LABEL][0].append(gt_pool(other,impostor,ZERO,dex=V4_LABEL,volume='2000000',tvl='1000000'))
        self.at(NOW+DAY)
        self.selector().select(now=NOW+DAY)
        pools=self.store.previous_evaluation('shadow',NOW+DAY+60,48)['pools']
        self.assertEqual(pools[self.eth_token]['reasons'],['token_code_changed'])
        self.assertEqual(pools[other]['reasons'],['token_lookalike'])

    def test_without_the_feed_an_eth_side_is_unmeasured_and_the_stable_s_is_not(self):
        # The profile's ETH/USD older than its heartbeat (Base: 1200 s) prices no ETH.
        feed(self.fake,age=BASE.gasPrice.chainlinkEthUsd.heartbeatSeconds+1)
        self.selector().select(now=NOW)
        pools=self.store.previous_evaluation('shadow',NOW+60,48)['pools']
        self.assertEqual(pools[self.eth_token]['depth'],{'status':'unmeasurable','reason':'eth_price_unavailable',
                                                         'raw':pools[self.eth_token]['depth']['raw']})
        self.assertIn('reference_depth_unmeasurable',pools[self.eth_token]['reasons'])
        self.assertEqual(pools[CBBTC_USDC]['depth']['status'],'measured')

    def test_a_chain_read_that_failed_is_tried_again_never_judged(self):
        self.fake.fail={(CHAINSTACK,'eth_call'):'http_503',(ALCHEMY,'eth_call'):'http_503'}
        result=self.selector().select(now=NOW,final=False)
        self.assertEqual((result['outcome'],result['evaluated']),('incomplete',0))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            coverage=conn.execute('SELECT evaluation->%s FROM domino_public.featured_runs WHERE id=%s',
                                  ('coverage',result['runId'])).fetchone()[0]
        self.assertEqual(coverage['chainStoppedBy'],'http_503')
        self.fake.fail={}
        self.assertEqual(self.selector().select(now=NOW+60,final=False)['outcome'],'selected')
        # A head far behind is no head: the run is tried again.
        self.setUp()
        self.fake.head['timestamp']=hex(NOW-600)
        self.assertEqual(self.selector().select(now=NOW,final=False)['outcome'],'incomplete')

    def test_the_billed_calls_of_a_selection_are_bounded(self):
        # The head and the identity round fit; the two tokens' eth_getCode would pass three, and are never sent.
        result=self.selector(max_rpc_calls=3).select(now=NOW,final=False)
        self.assertEqual(result['outcome'],'incomplete')
        self.assertEqual(self.fake.methods(),['eth_getBlockByNumber','eth_call'])

    def test_the_embedded_pool_completes_a_short_list(self):
        # Base's embedded list is the profile's WETH/USDC 0.05% pool. Unlisted today and below the volume floor,
        # it is read through /pools/multi and completes the list while the health check would keep it.
        self.assertEqual(CHAIN_SELECTED_POOLS[8453],(WETH_USDC,))
        self.provider.pages={V3_LABEL:[[]],V4_LABEL:[[self.rows[self.eth_token]]]}
        self.provider.multi_rows=[gt_pool(WETH_USDC,WETH,USDC,dex=V3_LABEL,volume='500000',tvl='20000000')]
        result=self.selector().select(now=NOW)
        self.assertEqual(result['outcome'],'selected',result)
        _,_,_,payload=self.payload(result['revision'])
        self.assertEqual([(entry['poolId'],entry['source']) for entry in payload['pools']],
                         [(self.eth_token,'ranked'),(WETH_USDC,'fallback')])
        self.assertTrue(any('/pools/multi/'+WETH_USDC in url for url in self.provider.urls))

    def test_pins_and_exclusions_belong_to_their_chain(self):
        self.store.add_override('exclude_pool',WETH_USDC,reason='owner')
        self.store.add_override('pin',CBBTC_USDC,reason='owner',value={'slot':1})
        # Robinhood names pools by their v4 id alone; its overrides are its own.
        with self.assertRaisesRegex(DataError,'invalid_bytes32'):
            self.robinhood.add_override('exclude_pool',WETH_USDC,reason='owner')
        self.robinhood.add_override('exclude_token',TOKEN,reason='owner')
        self.assertEqual(self.robinhood.overrides(NOW)['excludedPools'],[])
        result=self.selector().select(now=NOW)
        _,_,_,payload=self.payload(result['revision'])
        self.assertEqual([(entry['poolId'],entry['source']) for entry in payload['pools']],
                         [(CBBTC_USDC,'pinned'),(self.eth_token,'ranked')])
        self.assertIn('excluded_by_owner',result['rejectedByReason'])
        self.assertEqual(len(self.store.revoke_override('pin',CBBTC_USDC)),1)
        self.assertEqual(len(self.robinhood.revoke_override('exclude_token',TOKEN)),1)
        self.assertEqual(self.store.overrides(NOW)['excludedTokens'],[])

    # ---------------------------------------------------------------- store
    def test_another_chain_s_store_never_serves(self):
        for call in (lambda:self.store.serve(status='current',payload={'listId':'0x'+'00'*32,'pools':[]},day=date(2026,11,5),
                                             run_id=None,generated_at=NOW,effective_at=NOW,valid_until=NOW+1),
                     lambda:self.store.current(),lambda:self.store.draft(date(2026,11,5)),
                     lambda:self.store.add_override('phase','live',reason='x'),
                     lambda:self.store.add_override('phase','shadow',reason='x'),
                     lambda:self.store.add_override('mode','off',reason='x'),
                     lambda:self.store.add_override('veto','2026-11-05',reason='x'),
                     lambda:self.store.add_override('manual','manual',reason='x',value={'pools':[WETH_USDC]}),
                     lambda:self.store.previous_list('live')):
            with self.subTest(call=call),self.assertRaisesRegex(DataError,'featured_chain_shadow_only'):
                call()
        self.assertEqual(self.store.overrides(NOW)['phase'],'shadow')
        self.robinhood.add_override('phase','live',reason='owner')
        self.assertEqual(self.store.overrides(NOW)['phase'],'shadow')
        self.assertIsNone(self.robinhood.current())
        for chain_id in (0,'8453',1<<40):
            with self.subTest(chain_id=chain_id),self.assertRaisesRegex(DataError,'invalid_featured_chain'):
                FeaturedStore(self.catalogue,chain_id)

    def test_every_read_and_write_of_a_store_is_its_chain_s_own(self):
        pool='0x'+'4b'*32
        day=utc_date(NOW)
        evaluation=lambda apr:{'summary':{},'evaluations':[{'poolId':pool,'freshApr':apr,'eligibleExceptPersistence':True}]}
        listing=lambda name:{'listId':'0x'+name*32,'generatedAt':NOW,'pools':[{'poolId':pool,'name':name}]}
        stores={4663:self.robinhood,8453:self.store,42161:FeaturedStore(self.catalogue,42161)}
        tokens={4663:'0x'+'a1'*20,8453:'0x'+'a2'*20,42161:'0x'+'a3'*20}
        runs={}
        for chain_id,store in stores.items():
            # The same pool id, date and phase on every chain: one selection each.
            runs[chain_id]=store.record(phase='shadow',day=day,outcome='selected',policy_version='featured-v1:'+'0'*12,
                                        started_at=NOW+chain_id%7,finished_at=NOW+chain_id%7,
                                        evaluation=evaluation(str(chain_id)),listing=listing('%02x'%(chain_id%256)),
                                        tokens=[{'address':tokens[chain_id],'code':True,'codeHash':'0x'+'cc'*32,
                                                 'symbolReading':'T'}],listed_tokens={tokens[chain_id]})
            store.add_override('exclude_token',CBBTC,reason=str(chain_id))
            store.add_override('pin',pool,reason=str(chain_id),value={'slot':1})
            store.observe_health({pool:{'tvl_collapse'}},NOW)
        for chain_id,store in stores.items():
            with self.subTest(chain=chain_id):
                self.assertTrue(store.selection_done('shadow',day))
                self.assertEqual(store.previous_evaluation('shadow',NOW+60,48)['pools'][pool]['freshApr'],str(chain_id))
                self.assertEqual(store.previous_list('shadow')['revision'],runs[chain_id]['revision'])
                self.assertEqual(store.latest_run(within_hours=48,now=NOW+60)['id'],runs[chain_id]['runId'])
                self.assertEqual(store.run(runs[chain_id]['runId'])['id'],runs[chain_id]['runId'])
                for other,run in runs.items():
                    if other!=chain_id:self.assertIsNone(store.run(run['runId']))
                self.assertEqual(list(store.token_baselines()),[tokens[chain_id]])
                self.assertEqual(len(store.overrides(NOW)['pins']),1)
                self.assertEqual(store.overrides(NOW)['excludedTokens'],[CBBTC])
                self.assertEqual([run['id'] for run in store.status('shadow')['runs']],[runs[chain_id]['runId']])
                self.assertEqual(store.status('shadow')['list']['revision'],runs[chain_id]['revision'])
        # A chain's health check sees and clears its own conditions alone.
        self.assertEqual(self.store.observe_health({pool:set()},NOW+600),{})
        self.assertEqual(list(self.robinhood.observe_health({pool:{'tvl_collapse'}},NOW+600)),[(pool,'tvl_collapse')])
        self.assertEqual(self.store.observe_health({},NOW+900),{})
        self.assertEqual(self.robinhood.observe_health({pool:{'tvl_collapse'}},NOW+900)[(pool,'tvl_collapse')][1],3)
        # A mode or a phase set for another chain is that chain's: Robinhood's own replaces only its own.
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''INSERT INTO domino_public.featured_overrides(chain_id,kind,subject,reason)
              VALUES(8453,'mode','off','a later release'),(8453,'phase','live','a later release')''')
        self.robinhood.add_override('mode','auto',reason='owner')
        self.robinhood.add_override('phase','live',reason='owner')
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            self.assertEqual(conn.execute('''SELECT count(*) FROM domino_public.featured_overrides
              WHERE chain_id=8453 AND kind IN ('mode','phase') AND revoked_at IS NULL''').fetchone()[0],2)
        # A new pin or a revocation replaces only its own chain's.
        self.store.add_override('pin',pool,reason='again',value={'slot':2})
        self.assertEqual(self.robinhood.overrides(NOW)['pins'],[{'poolId':pool,'slot':1}])
        self.assertEqual(len(self.store.revoke_override('exclude_token',CBBTC)),1)
        self.assertEqual(self.robinhood.overrides(NOW)['excludedTokens'],[CBBTC])
        # Retention drops a chain's own old runs, never another's.
        old=NOW-200*DAY
        self.robinhood.record(phase='shadow',day=utc_date(old),outcome='incomplete',policy_version='featured-v1:'+'0'*12,
                              started_at=old,finished_at=old,evaluation={'summary':{},'evaluations':[]})
        self.store.record(phase='shadow',day=day+timedelta(days=1),outcome='incomplete',
                          policy_version='featured-v1:'+'0'*12,started_at=NOW+DAY,finished_at=NOW+DAY,
                          evaluation={'summary':{},'evaluations':[]})
        self.assertEqual(self.count('domino_public.featured_runs','chain_id=4663'),2)
        # Each chain's selection holds its own lock: Base and Robinhood can run at once, two Bases cannot.
        with self.store.selector_lock(),self.robinhood.selector_lock(),stores[42161].selector_lock():
            with self.assertRaisesRegex(DataError,'featured_selector_busy'):
                with FeaturedStore(self.catalogue,8453).selector_lock():pass

    def test_the_tables_name_each_row_s_chain_and_keep_robinhood_s_rows_robinhood_s(self):
        # Rows a release without chain_id writes are Robinhood's, the migration's default.
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''INSERT INTO domino_public.featured_runs(phase,selection_date,outcome,policy_version,
              started_at,finished_at,evaluation) VALUES('live','2026-11-05','selected',%s,now(),now(),'{}')''',
              ('featured-v1:'+'0'*12,))
            conn.execute('''INSERT INTO domino_public.featured_health(pool_id,condition,first_seen_at,last_seen_at)
              VALUES(%s,'tvl_collapse',1,1)''',('0x'+'4b'*32,))
            self.assertEqual(conn.execute('SELECT chain_id FROM domino_public.featured_runs').fetchone()[0],4663)
            # A v3 pool's condition is named by its address; any other shape is refused.
            conn.execute('''INSERT INTO domino_public.featured_health(chain_id,pool_id,condition,first_seen_at,last_seen_at)
              VALUES(8453,%s,'tvl_collapse',1,1)''',(WETH_USDC,))
            for pool_id in ('0x'+'4b'*31,'0x'+'4B'*32):
                with self.subTest(pool=pool_id),self.assertRaises(psycopg.errors.CheckViolation):
                    with conn.transaction():
                        conn.execute('''INSERT INTO domino_public.featured_health(chain_id,pool_id,condition,
                          first_seen_at,last_seen_at) VALUES(8453,%s,'tvl_collapse',1,1)''',(pool_id,))
            # Every table refuses a row of no chain.
            rows=(("featured_runs(chain_id,phase,selection_date,outcome,policy_version,started_at,finished_at,evaluation)",
                   "0,'shadow','2026-11-05','incomplete','featured-v1:000000000000',now(),now(),'{}'"),
                  ("featured_lists(chain_id,phase,status,list_id,generated_at,payload)",
                   "0,'shadow','shadow','0x"+'00'*32+"',1,'{}'"),
                  ("featured_overrides(chain_id,kind,subject,reason)","0,'exclude_token','0x"+'11'*20+"','x'"),
                  ("featured_health(chain_id,pool_id,condition,first_seen_at,last_seen_at)",
                   "0,'0x"+'4b'*32+"','tvl_collapse',1,1"),
                  ("featured_token_checks(chain_id,address,evidence)","0,'0x"+'11'*20+"','{}'"))
            for table,values in rows:
                with self.subTest(table=table),self.assertRaises(psycopg.errors.CheckViolation):
                    with conn.transaction():
                        conn.execute('INSERT INTO domino_public.'+table+' VALUES('+values+')')

    # ---------------------------------------------------------------- health
    def selected(self):
        result=self.selector().select(now=NOW)
        self.assertEqual(result['outcome'],'selected',result)
        self.fake.log.clear()
        self.provider.urls.clear()
        return result

    def health(self,now,**options):
        """A check at `now`, the chain's head five seconds before it."""
        self.fake.head['timestamp']=hex(now-5)
        return self.selector().health(now,**options)

    def test_the_health_check_reads_once_and_records_what_the_live_list_would_withdraw(self):
        self.selected()
        report=self.health(NOW+HEALTH_SECONDS)
        self.assertEqual((report['status'],report['wouldWithdraw'],report['conditions']),('healthy',{},{}))
        # One /pools/multi call and two billed calls: the head and one Multicall3 call.
        self.assertEqual([url.split('/pools/')[1].split('/')[0] for url in self.provider.urls],['multi'])
        self.assertEqual(self.fake.methods(),['eth_getBlockByNumber','eth_call'])
        self.assertEqual(report['rpcItems'],2)
        # The provider reports WETH/USDC's TVL under half the floor: seen now, withdrawn once it has held 10 min.
        collapsed=gt_pool(WETH_USDC,WETH,USDC,dex=V3_LABEL,volume='50000000',tvl='40000')
        self.provider.multi_rows=[collapsed,self.rows[CBBTC_USDC],self.rows[self.eth_token]]
        first=self.health(NOW+2*HEALTH_SECONDS)
        self.assertEqual((first['status'],first['conditions']),('healthy',{WETH_USDC:['tvl_collapse']}))
        # A refused allowance leaves the figures unknown: the condition's window stays, nothing is confirmed.
        self.provider.fail_multi='http_429'
        busy=self.health(NOW+3*HEALTH_SECONDS)
        self.assertEqual((busy['status'],busy['marketReason'],busy['conditions']),('healthy','http_429',{}))
        self.provider.fail_multi=None
        second=self.health(NOW+4*HEALTH_SECONDS)
        self.assertEqual((second['status'],second['wouldWithdraw']),('would_withdraw',{WETH_USDC:'tvl_collapse'}))
        # Only a check that sees a condition confirms it: one that cannot judge it keeps its window, nothing more.
        self.provider.fail_multi='http_429'
        self.assertEqual(self.health(NOW+5*HEALTH_SECONDS)['wouldWithdraw'],{})
        self.provider.fail_multi=None
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            self.assertEqual(conn.execute('''SELECT chain_id,pool_id,condition,first_seen_at,checks
              FROM domino_public.featured_health''').fetchall(),
              [(8453,WETH_USDC,'tvl_collapse',NOW+2*HEALTH_SECONDS,2)])
        # Nothing was withdrawn, repaired, overridden or served.
        self.assertEqual(self.store.previous_list('shadow')['pools'][1]['poolId'],WETH_USDC)
        self.assertEqual((self.store.overrides(NOW)['excludedTokens'],self.count('domino_public.featured_current')),([],0))

    def test_a_check_that_read_no_chain_records_nothing(self):
        self.selected()
        self.provider.multi_rows=[gt_pool(WETH_USDC,WETH,USDC,dex=V3_LABEL,tvl='40000'),self.rows[CBBTC_USDC],
                                  self.rows[self.eth_token]]
        self.health(NOW+HEALTH_SECONDS)
        self.fake.fail={(CHAINSTACK,'eth_call'):'http_503',(ALCHEMY,'eth_call'):'http_503'}
        report=self.health(NOW+2*HEALTH_SECONDS)
        self.assertEqual((report['status'],report['reason']),('unread','http_503'))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            self.assertEqual(conn.execute('SELECT checks FROM domino_public.featured_health').fetchall(),[(1,)])

    def test_a_price_fall_an_exclusion_and_a_changed_token_show_as_they_would_live(self):
        self.selected()
        # TOKEN at a quarter of its price at selection: four times as many TOKEN per ETH.
        v4_pool(self.fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT*2,liquidity=10**23)
        self.health(NOW+HEALTH_SECONDS)
        fell=self.health(NOW+2*HEALTH_SECONDS)
        self.assertEqual(fell['wouldWithdraw'],{self.eth_token:'price_fall'})
        self.store.add_override('exclude_token',CBBTC,reason='owner')
        # Hourly, the listed tokens' code: TOKEN's changed since it was first listed.
        self.fake.codes[TOKEN]='0x6001600055'
        self.fake.log.clear()
        changed=self.health(NOW+3*HEALTH_SECONDS,tokens=True)
        self.assertEqual(changed['wouldWithdraw'],{CBBTC_USDC:'excluded_by_owner',self.eth_token:'token_code_changed'})
        self.assertEqual(changed['tokensChanged'],[TOKEN])
        self.assertEqual(self.fake.methods(),['eth_getBlockByNumber','eth_call','eth_getCode','eth_getCode'])
        # The check excludes nothing itself: the selection's own TA-5 reads the code again.
        self.assertEqual(self.store.overrides(NOW)['excludedTokens'],[CBBTC])
        without=self.health(NOW+4*HEALTH_SECONDS)
        self.assertNotIn('eth_getCode',self.fake.methods()[4:])
        self.assertEqual(without['tokensChanged'],[])

    def test_each_condition_the_live_check_would_act_on(self):
        self.selected()
        # The provider no longer lists cbBTC/USDC: no estimate (held 3 h before it counts, ranked pools only).
        self.provider.multi_rows=[self.rows[WETH_USDC],self.rows[self.eth_token]]
        missing=self.health(NOW+HEALTH_SECONDS)
        self.assertEqual(missing['conditions'],{CBBTC_USDC:['estimate_unavailable']})
        later=self.health(NOW+HEALTH_SECONDS+3*3600)
        self.assertEqual(later['wouldWithdraw'],{CBBTC_USDC:'estimate_unavailable'})
        # The v4 pool's LP fee no longer its key's, and the v3 pool's protocol fee one way only: at once.
        self.provider.multi_rows=list(self.rows.values())
        v4_pool(self.fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23,lp_fee=500)
        v3_pool(self.fake,WETH,USDC,500,10,sqrt=WETH_USDC_SQRT,liquidity=10**18,protocol=0x40)
        self.store.add_override('exclude_pool',CBBTC_USDC,reason='owner')
        now=NOW+HEALTH_SECONDS+3*3600+600
        self.assertEqual(self.health(now)['wouldWithdraw'],
                         {CBBTC_USDC:'excluded_by_owner',WETH_USDC:'protocol_fee_directional_unsupported',
                          self.eth_token:'fixed_fee_mismatch'})
        # A pool that no longer reads as itself leaves at once.
        v4_pool(self.fake,(ZERO,TOKEN,3000,60,ZERO),sqrt=ETH_TOKEN_SQRT,liquidity=10**23,recorded=False)
        self.assertEqual(self.health(now+600)['wouldWithdraw'][self.eth_token],'pool_integration_unsupported')

    def test_a_ceiling_watches_only_when_set_and_a_pin_holds_a_market_condition(self):
        policy={**POLICY,'thresholds':{**POLICY['thresholds'],'maxAprPercent':'100'}}
        self.store.add_override('pin',self.eth_token,reason='owner',value={'slot':1})
        self.assertEqual(self.selector(policy=policy).select(now=NOW)['outcome'],'selected')
        self.assertEqual(self.store.previous_list('shadow')['pools'][0]['source'],'pinned')
        # ETH/TOKEN's 219% is above a 100% ceiling: seen by a policy that sets one, never by the shipped one.
        self.fake.head['timestamp']=hex(NOW+HEALTH_SECONDS-5)
        self.assertEqual(self.selector().health(NOW+HEALTH_SECONDS)['conditions'],{})
        self.store.observe_health({},NOW)
        for offset in (1,2,3):
            self.fake.head['timestamp']=hex(NOW+offset*HEALTH_SECONDS-5)
            report=self.selector(policy=policy).health(NOW+offset*HEALTH_SECONDS)
        self.assertEqual(report['conditions'],{self.eth_token:['apr_or_turnover_above_ceiling']})
        # It removes a pin too, after 30 min; volume collapsing for 3 h does not.
        self.assertEqual(report['wouldWithdraw'],{})
        self.fake.head['timestamp']=hex(NOW+4*HEALTH_SECONDS-5)
        self.assertEqual(self.selector(policy=policy).health(NOW+4*HEALTH_SECONDS)['wouldWithdraw'],
                         {self.eth_token:'apr_or_turnover_above_ceiling'})
        self.rows[self.eth_token]['attributes']['volume_usd']['h24']='1000'
        self.provider.multi_rows=list(self.rows.values())
        for at in (NOW+DAY,NOW+DAY+4*3600):
            report=self.health(at)
        self.assertEqual(report['conditions'][self.eth_token],['volume_collapse'])
        self.assertNotIn(self.eth_token,report['wouldWithdraw'])

    def test_no_list_no_check(self):
        self.store.observe_health({WETH_USDC:{'tvl_collapse'}},NOW)
        self.robinhood.observe_health({'0x'+'4b'*32:{'tvl_collapse'}},NOW)
        self.assertEqual(self.health(NOW+HEALTH_SECONDS),{'status':'idle'})
        self.assertEqual((self.provider.urls,self.fake.log),([],[]))
        self.assertEqual(self.count('domino_public.featured_health','chain_id=8453'),0)
        self.assertEqual(self.count('domino_public.featured_health','chain_id=4663'),1)

    # ---------------------------------------------------------------- the unit
    def test_each_tick_selects_in_the_chain_s_window_and_checks_every_ten_minutes(self):
        first,last,at=window(POLICY,NOW)
        run=lambda now:tick(self.selector(),self.store,POLICY,now,clock=lambda:now)
        self.assertEqual(run(first-30),{'status':'idle','chainId':8453,'phase':'shadow'})
        self.clock[0]=first
        opened=run(first)
        self.assertEqual((opened['selection']['outcome'],opened['health']['status']),('selected','healthy'))
        self.assertEqual(run(first+60)['status'],'idle')          # done today, and no check due
        self.assertEqual(set(run(first+HEALTH_SECONDS+2)),{'chainId','phase','health'})
        self.assertNotIn('selection',run(last))
        # In the first minute of the hour, the listed tokens' code too.
        self.fake.log.clear()
        hour=at+3600
        self.fake.head['timestamp']=hex(hour-5)
        self.assertEqual(run(hour)['health']['status'],'healthy')
        self.assertIn('eth_getCode',self.fake.methods())
        # The selection's final attempt keeps the previous list.
        self.setUp()
        self.provider.fail='http_429'
        self.clock[0]=last
        final=run(last)['selection']
        self.assertEqual(final['outcome'],'carried_over')

    def test_a_selection_that_ran_past_the_check_s_minute_leaves_the_check_to_the_next(self):
        first,_,_=window(POLICY,NOW)
        self.clock[0]=first
        result=tick(self.selector(),self.store,POLICY,first,clock=lambda:first+90)
        self.assertEqual((result['selection']['outcome'],'health' in result),('selected',False))

    def test_the_chain_s_selection_needs_its_own_store_and_policy(self):
        for changes in ({'store':self.robinhood},{'policy':rules.load_policy()},
                        {'policy':load_chain_policy('arbitrum-42161')[0]}):
            with self.subTest(changes=list(changes)),self.assertRaisesRegex(DataError,'featured_chain_mismatch'):
                self.selector(**changes)
        # Without the chain's endpoints a selection would spend the provider's allowance for nothing.
        for call in (lambda selector:selector.select(now=NOW,final=False),lambda selector:selector.health(NOW)):
            with self.assertRaisesRegex(DataError,'v2_chain_rpc_not_configured'):
                call(self.selector(endpoints=None))
        self.assertEqual(self.provider.urls,[])


if __name__=='__main__':unittest.main()
