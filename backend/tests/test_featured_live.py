"""The live featured list against real PostgreSQL: warm-up, publication, modes and health.

Pools are the collector's own payload fixture under distinct tokens, stored as
the collector would store them; charts, the manual-list check and the node are
scripted. Times sit on 2026-09-27, around its 12:00 UTC selection.
"""
import copy
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from eth_abi import encode
from eth_hash.auto import keccak

from catalogue import LOCK_ID, PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, KEY_TYPES, POOL_MANAGER
from featured_contract import build_response
from featured_live import CANDIDATE_WARM_SECONDS, VACANCY_SECONDS, Live, window
from featured_pools import list_id, load_policy
from featured_selector import list_entry
from featured_store import FeaturedStore
import manage_featured
from public_observations import PgPublicData
from test_featured_selection import Anchored
from test_public_observations import fixtures

ZERO='0x'+'0'*40
TOKENS=['0x'+('%02x'%n)*20 for n in range(0x21,0x2f)]
AT=int(datetime(2026,9,27,12,0,tzinfo=timezone.utc).timestamp())
DAY=date(2026,9,27)
YESTERDAY=DAY-timedelta(days=1)
BASE=json.loads(json.dumps(fixtures()[1]))
HOUR=3600
ONE_DAY=86400


def key_of(token,fee=3000):
    return {'currency0':ZERO,'currency1':token,'fee_pips':fee,'tick_spacing':60,'hooks':ZERO,'feeMode':'fixed'}


def pool_of(token,fee=3000):
    return '0x'+keccak(encode(KEY_TYPES,(ZERO,token,fee,60,ZERO))).hex()


def payload(token,*,at,tvl='2000000',volume='1000000',sqrt=2**96,fee=3000,lp_fee=None,protocol=0,
            integration='hookless_fixed_fee',rate_limited_for=None):
    """The collector's pool-market payload for the ETH/token pool, observed at `at`; with
    `rate_limited_for`, the provider refused it and its last answer is that many seconds old."""
    result=copy.deepcopy(BASE);pool_id=pool_of(token,fee)
    result['poolId']=result['pool']['poolId']=pool_id
    result['pool'].update(currencies=[ZERO,token],poolKey=key_of(token,fee),currentLpFeePips=fee if lp_fee is None else lp_fee,
                          protocolFeeRaw=protocol,sqrtPriceX96=str(sqrt),integrationClass=integration)
    result['snapshot']=result['pool']['snapshot']={**result['snapshot'],'timestamp':at}
    result['market']['data'].update(poolId=pool_id,currencies=[ZERO,token],baseToken=token,quoteToken=ZERO,
                                    retrievedAt=at,reportedLiquidityUsd=tvl,volume24hUsd=volume,
                                    sourceUrl='https://www.geckoterminal.com/robinhood/pools/'+pool_id)
    result['market']['cache']['ageSeconds']=0
    if rate_limited_for is not None:
        result['market'].update(status='unavailable',reason='provider_rate_limited',data=None)
        result['market']['cache'].update(status='rate_limited',ageSeconds=rate_limited_for)
    return result


def ev(token,rank=100,*,eligible=True,safe=True,sqrt=2**96,fee=3000):
    """One pool's evaluation, as the selector records it."""
    return {'poolId':pool_of(token,fee),'token':token,'reference':ZERO,'major':False,
            'symbolReading':'T'+token[2:6].upper(),'eligible':eligible,'safe':safe,
            'eligibleExceptPersistence':eligible,'reasons':[] if eligible else ['volume_below_floor'],
            'rankApr':str(rank),'freshApr':str(rank),'prevApr':str(rank),'volume24hUsd':'1000000',
            'reportedLiquidityUsd':'2000000','referenceDepthUsd':'50000','poolKey':key_of(token,fee),
            'tokens':[{'address':ZERO,'symbol':'ETH','decimals':18},{'address':token,'symbol':'T','decimals':18}],
            'identitySource':'position_manager','ageSource':'provider_pool_created_at',
            'block':{'number':700,'hash':'0x'+'ab'*32,'timestamp':AT-1800},'sqrtPriceX96':str(sqrt)}


class Charts:
    """Complete hourly candles per pool; two by default, the minimum to be ready."""
    def __init__(self):self.complete={}
    def read(self,pool_id,currency,window_seconds,resolution):
        return {'candles':[{'complete':True}]*self.complete.get(pool_id,2)}


class Checker:
    """The selector's on-demand check of a manual list."""
    def __init__(self):self.evaluations=[];self.calls=0
    def check(self,pool_ids,*,now):
        self.calls+=1
        return [item for item in self.evaluations if item['poolId'] in pool_ids]


class Node:
    """A current block and account code, for the hourly token check."""
    def __init__(self):self.codes,self.code_reads={},[]
    def request(self,method,params=()):
        if method=='eth_chainId':return hex(4663)
        if method=='eth_getBlockByNumber':
            return {'number':'0x2bc','hash':'0x'+'ab'*32,'timestamp':hex(int(time.time()))}
        if method=='eth_getCode':
            self.code_reads.append(params[0])
            return self.codes.get(params[0],'0x6000')
        raise AssertionError(method)
    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        assert signature=='poolManager()',signature
        return (POOL_MANAGER,)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class LiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_featured_live_tests'}
        with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations=Path(__file__).resolve().parents[1]/'migrations'
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            for name in ('001_catalogue','002_activity','020_pool_requests','023_pool_request_scheduling',
                         '024_public_observations','025_public_history','026_public_demand','042_provider_priority',
                         '043_featured_pools','044_demand_horizon','045_featured_live'):
                conn.execute((migrations/(name+'.sql')).read_text())

    def setUp(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''TRUNCATE domino_public.featured_current,domino_public.featured_lists,
              domino_public.featured_runs,domino_public.featured_overrides,domino_public.featured_token_checks,
              domino_public.featured_health,domino_public.entities,domino_catalogue.hints,domino_catalogue.events''')
        self.catalogue=PgCatalogue(self.settings)
        self.store=FeaturedStore(self.catalogue)
        self.public=PgPublicData(self.catalogue,writer=True)
        self.policy=load_policy()
        self.charts,self.checker,self.node=Charts(),Checker(),Node()
        self.embedded=[pool_of(TOKENS[12])]

    def live(self):
        return Live(store=self.store,public=self.public,history=self.charts,catalogue=self.catalogue,
                    policy=self.policy,selector=self.checker,rpc_factory=lambda:Anchored(self.node),embedded=self.embedded)

    # ---------------------------------------------------------------- fixtures
    def figures(self,token,*,at,**changes):
        """The collector's latest publication for the pool, and both tokens' metadata."""
        body=payload(token,at=at,**changes)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at,status,last_requested_at)
              VALUES('pool',%s,%s,%s,'ready',to_timestamp(%s)) ON CONFLICT(chain_id,kind,entity_id) DO UPDATE
              SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at''',(body['poolId'],Jsonb(body),at,at))
            for currency in (ZERO,token):
                conn.execute('''INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at,status)
                  VALUES('token',%s,%s,%s,'ready') ON CONFLICT DO NOTHING''',
                  (currency,Jsonb({'asset':{'decimals':18}}),at))

    def record_selection(self,evaluations,chosen=(),*,day=DAY,sources=None):
        """A completed live selection for `day`; with `chosen`, its draft list."""
        by_id={item['poolId']:item for item in evaluations}
        listing=None
        if chosen:
            entries=[list_entry({'slot':index,'source':(sources or {}).get(pool_id,'ranked'),'poolId':pool_id},by_id[pool_id])
                     for index,pool_id in enumerate(chosen,start=1)]
            listing={'schemaVersion':1,'phase':'live','selectionDate':day.isoformat(),'generatedAt':AT-1800,
                     'policyVersion':'featured-v1:'+'0'*12,'listId':list_id(entries),'pools':entries,
                     'rankedSwaps':0,'coverage':{},'previousRevision':None}
        started=int(datetime(day.year,day.month,day.day,11,30,tzinfo=timezone.utc).timestamp())
        return self.store.record(phase='live',day=day,outcome='selected' if chosen else 'carried_over',
                                 policy_version='featured-v1:'+'0'*12,started_at=started,finished_at=started+10,
                                 evaluation={'summary':{},'evaluations':evaluations,'screened':[]},
                                 listing=listing)

    def serve(self,evaluations,chosen,*,day=YESTERDAY,sources=None,at=AT-ONE_DAY):
        """A list already served (by default, yesterday's)."""
        by_id={item['poolId']:item for item in evaluations}
        entries=[list_entry({'slot':index,'source':(sources or {}).get(pool_id,'ranked'),'poolId':pool_id},by_id[pool_id])
                 for index,pool_id in enumerate(chosen,start=1)]
        return self.store.serve(status='current',payload={'schemaVersion':1,'phase':'live','pools':entries,
                                'listId':list_id(entries),'generatedAt':at,'withdrawn':[]},
                                day=day,run_id=None,generated_at=at,effective_at=at,valid_until=at+36*HOUR)

    def served_ids(self):
        return [entry['poolId'] for entry in self.store.current()['payload']['pools']]

    # ---------------------------------------------------------------- publication
    def test_the_draft_is_served_at_the_selection_time_once_every_newcomer_is_ready(self):
        pools=[pool_of(token) for token in TOKENS[:3]]
        self.record_selection([ev(token,rank) for token,rank in zip(TOKENS[:4],(300,200,100,50))],pools)
        for token in TOKENS[:3]:self.figures(token,at=AT-5)
        early=self.live().tick(AT-60)
        self.assertNotIn('publication',early)
        self.assertIsNone(self.store.current())
        result=self.live().tick(AT)
        self.assertEqual(result['publication']['status'],'served',result)
        served=self.store.current()
        self.assertEqual((served['status'],served['selection_date'],served['effective_at']),('current',DAY,AT))
        self.assertEqual(self.served_ids(),pools)
        self.assertEqual(served['valid_until'],AT+36*HOUR)
        self.assertEqual(self.live().tick(AT+60)['publication']['status'],'published')

    def test_readiness_names_the_first_thing_a_newcomer_lacks(self):
        a,b,c,d,e,f=TOKENS[:6]
        self.figures(b,at=AT-400)                     # older than the market's 300 s: no estimate
        for token in (c,d,e):self.figures(token,at=AT-5)
        self.charts.complete[pool_of(d)]=1
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_public.entities SET payload=%s WHERE kind='token' AND entity_id=%s",
                         (Jsonb({'asset':{}}),c))
            # Asked for, not yet published by the collector.
            conn.execute("INSERT INTO domino_public.entities(kind,entity_id) VALUES('pool',%s)",(pool_of(f),))
        found=self.live().readiness([pool_of(token) for token in (a,b,c,d,e,f)],AT)
        self.assertEqual(found,{pool_of(a):'figures_pending',pool_of(b):'estimate_not_available',
                                pool_of(c):'token_decimals_pending',pool_of(d):'chart_pending',pool_of(e):None,
                                pool_of(f):'figures_pending'})

    def test_warm_up_seeds_the_identity_before_asking_for_a_newcomer(self):
        newcomer,known=TOKENS[0],TOKENS[1]
        self.record_selection([ev(newcomer),ev(known)],[pool_of(newcomer),pool_of(known)])
        self.catalogue.seed([{'poolId':pool_of(known),'poolKey':{k:v for k,v in key_of(known).items() if k!='feeMode'}}],
                            Block(700,'0x'+'ab'*32,0))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            # The follower holds the writer lock: no seed, so no ask for the newcomer.
            conn.execute('SELECT pg_advisory_lock(%s)',(LOCK_ID,))
            held=self.live().tick(AT-20*60)['warmUp']
            conn.execute('SELECT pg_advisory_unlock(%s)',(LOCK_ID,))
        self.assertEqual((held['identityWaiting'],held['asked'],held['seeded']),([pool_of(newcomer)],[pool_of(known)],[]))
        warmed=self.live().tick(AT-19*60)['warmUp']
        self.assertEqual((warmed['seeded'],sorted(warmed['asked'])),([pool_of(newcomer)],sorted([pool_of(newcomer),pool_of(known)])))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            asked=conn.execute("SELECT count(*) FROM domino_public.entities WHERE kind='pool' AND last_requested_at>clock_timestamp()-interval '1 minute'").fetchone()[0]
            hints=conn.execute('SELECT count(*) FROM domino_catalogue.hints').fetchone()[0]
        self.assertEqual((asked,hints),(2,2))

    def test_from_twelve_twenty_five_the_list_is_served_without_newcomers_still_warming(self):
        a,b,c,d=TOKENS[:4]
        evaluations=[ev(a,300),ev(b,250),ev(c,100),ev(d,400)]
        self.serve(evaluations,[pool_of(a),pool_of(b),pool_of(c)])
        self.record_selection(evaluations,[pool_of(d),pool_of(a),pool_of(b)])
        self.charts.complete[pool_of(d)]=0
        self.figures(d,at=AT-5)
        self.assertEqual(self.live().tick(AT)['publication']['status'],'warming')
        self.figures(d,at=AT+25*60-5)
        result=self.live().tick(AT+25*60)['publication']
        self.assertEqual((result['status'],result['withheld']),('served',[pool_of(d)]))
        self.assertEqual(sorted(self.served_ids()),sorted(pool_of(token) for token in (a,b,c)))

    def test_a_replacement_still_warming_is_withheld_too(self):
        a,b,c,d,e=TOKENS[:5]
        evaluations=[ev(a,300),ev(b,250),ev(c,100),ev(d,400),ev(e,350)]
        self.serve(evaluations,[pool_of(a),pool_of(b),pool_of(c)])
        self.record_selection(evaluations,[pool_of(d),pool_of(a),pool_of(b)])
        for token in (a,b,c,d,e):self.figures(token,at=AT+25*60-5)
        # Without d, e would take its place: it is still warming as well.
        self.charts.complete.update({pool_of(d):0,pool_of(e):0})
        result=self.live().tick(AT+25*60)['publication']
        self.assertEqual((result['status'],result['withheld']),('served',[pool_of(d)]))
        self.assertEqual(sorted(self.served_ids()),sorted(pool_of(token) for token in (a,b,c)))

    def test_a_list_repaired_after_publication_is_not_published_again(self):
        pools=[pool_of(token) for token in TOKENS[:3]]
        self.record_selection([ev(token,rank) for token,rank in zip(TOKENS[:3],(300,200,100))],pools)
        for token in TOKENS[:3]:self.figures(token,at=AT-5)
        live=self.live()
        self.assertEqual(live.tick(AT)['publication']['status'],'served')
        self.store.add_override('exclude_pool',pools[1],reason='rug report')
        for token in TOKENS[:3]:self.figures(token,at=AT+55)
        self.assertEqual(live.tick(AT+60)['health']['status'],'repaired')
        later=live.tick(AT+120)
        self.assertEqual(later['publication']['status'],'published')
        self.assertNotIn('warmUp',later)
        self.assertEqual((self.store.current()['status'],self.served_ids()),('repaired',[pools[0],pools[2]]))

    def test_a_pool_chosen_again_is_no_longer_withdrawn(self):
        a,b=TOKENS[:2]
        evaluations=[ev(a,300),ev(b,200)]
        yesterday=self.serve(evaluations,[pool_of(a)])
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_public.featured_lists SET payload=jsonb_set(payload,'{withdrawn}',%s) WHERE revision=%s",
                         (Jsonb([{'poolId':pool_of(b),'reason':'tvl_collapse','at':AT-ONE_DAY+HOUR}]),yesterday))
        self.record_selection(evaluations,[pool_of(a),pool_of(b)])
        for token in (a,b):self.figures(token,at=AT-5)
        self.assertEqual(self.live().tick(AT)['publication']['status'],'served')
        served=self.store.current()
        self.assertEqual((self.served_ids(),served['payload']['withdrawn']),([pool_of(a),pool_of(b)],[]))
        self.assertEqual(build_response(served,now=AT)['withdrawn'],[])

    def test_after_twelve_thirty_the_served_list_carries_over(self):
        evaluations=[ev(token) for token in TOKENS[:3]]
        before=self.serve(evaluations,[pool_of(token) for token in TOKENS[:3]])
        result=self.live().tick(AT+31*60)['publication']
        self.assertEqual(result['status'],'carried_over')
        served=self.store.current()
        self.assertEqual((served['status'],served['selection_date']),('carried_over',DAY))
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            original=conn.execute('SELECT list_id,generated_at,valid_until FROM domino_public.featured_lists WHERE revision=%s',
                                  (before,)).fetchone()
        self.assertEqual((served['list_id'],served['generated_at'],served['valid_until']),tuple(original))
        self.assertEqual(self.live().tick(AT+32*60)['publication']['status'],'published')

    def test_a_veto_holds_the_draft_until_it_carries_over(self):
        evaluations=[ev(token) for token in TOKENS[:3]]
        self.serve(evaluations,[pool_of(TOKENS[0])])
        self.record_selection(evaluations,[pool_of(token) for token in TOKENS[:3]])
        for token in TOKENS[:3]:self.figures(token,at=AT-5)
        self.store.add_override('veto',DAY.isoformat(),reason='owner veto in the daily note')
        self.assertEqual(self.live().tick(AT)['publication']['status'],'vetoed')
        self.assertEqual(self.live().tick(AT+30*60)['publication']['status'],'carried_over')
        self.assertEqual(self.served_ids(),[pool_of(TOKENS[0])])

    # ---------------------------------------------------------------- modes
    def test_mode_off_serves_nothing_and_manual_serves_the_owner_s_safe_pools(self):
        self.store.add_override('mode','off',reason='emergency')
        off=self.live().tick(AT+2*HOUR)
        self.assertEqual(off['served']['status'],'served_none')
        self.assertNotIn('health',off)
        self.assertEqual((self.store.current()['status'],self.served_ids()),('none',[]))
        self.assertEqual(self.live().tick(AT+2*HOUR+60)['served']['status'],'none')
        a,b,x=TOKENS[:3]
        self.checker.evaluations=[ev(a),ev(b),ev(x,safe=False,eligible=False)]
        self.store.add_override('manual','manual',reason='owner list',value={'pools':[pool_of(x),pool_of(b),pool_of(a)]})
        self.store.add_override('mode','manual',reason='owner list')
        live=self.live()
        result=live.tick(AT+3*HOUR)['served']
        self.assertEqual(result['status'],'served_manual')
        self.assertEqual(self.served_ids(),[pool_of(b),pool_of(a)])
        self.assertEqual([item['poolId'] for item in result['dropped']],[pool_of(x)])
        self.assertEqual(live.tick(AT+3*HOUR+60)['served']['status'],'manual')
        self.assertEqual(self.checker.calls,1)

    def test_an_owner_list_is_not_carried_over_so_auto_returns_at_the_next_selection(self):
        a=TOKENS[0]
        self.checker.evaluations=[ev(a)]
        self.store.add_override('manual','manual',reason='owner list',value={'pools':[pool_of(a)]})
        for mode,status in (('manual','manual'),('off','none')):
            with self.subTest(mode=mode):
                self.store.add_override('mode',mode,reason='owner')
                self.live().tick(AT+2*HOUR)
                self.store.add_override('mode','auto',reason='owner')
                result=self.live().tick(AT+2*HOUR+60)
                self.assertEqual(result['publication']['status'],'nothing_to_carry')
                self.assertEqual(self.store.current()['status'],status)

    def test_back_in_shadow_a_served_list_gives_way_to_none(self):
        self.serve_today(TOKENS[:2])
        self.store.add_override('phase','shadow',reason='pause')
        result=manage_featured.tick(None,self.store,self.policy,AT+2*HOUR,live=self.live())
        self.assertEqual((result['phase'],result['live']['status']),('shadow','served_none'))
        served=self.store.current()
        self.assertEqual((served['status'],served['payload']['pools']),('none',[]))
        self.assertEqual(manage_featured.tick(None,self.store,self.policy,AT+2*HOUR+30,live=self.live())['status'],'idle')

    # ---------------------------------------------------------------- health
    def serve_today(self,tokens,*,sources=None,extra=()):
        evaluations=[ev(token,300-10*index) for index,token in enumerate(list(tokens)+list(extra))]
        self.record_selection(evaluations)
        self.serve(evaluations,[pool_of(token) for token in tokens],day=DAY,at=AT,sources=sources)
        return evaluations

    def test_an_owner_exclusion_removes_a_served_pool_at_once_and_the_list_is_refilled(self):
        a,b,c,d,e,f=TOKENS[:6]
        # e and f rank above d, but e's chart is not ready and f's TVL has collapsed:
        # only a pool the site can show now, and would keep, fills the slot.
        self.serve_today([a,b,c],extra=[e,f,d])
        now=AT+2*HOUR
        for token in (a,b,c,d,e):self.figures(token,at=now-5)
        self.charts.complete[pool_of(e)]=1
        self.figures(f,at=now-5,tvl='100000')
        self.store.add_override('exclude_pool',pool_of(b),reason='rug report')
        health=self.live().tick(now)['health']
        self.assertEqual((health['status'],health['removed'],health['added']),
                         ('repaired',{pool_of(b):'excluded_by_owner'},[pool_of(d)]))
        served=self.store.current()
        self.assertEqual(served['status'],'repaired')
        self.assertEqual(self.served_ids(),[pool_of(a),pool_of(c),pool_of(d)])
        self.assertEqual(served['payload']['withdrawn'],[{'poolId':pool_of(b),'reason':'excluded_by_owner','at':now}])
        self.assertEqual([entry['slot'] for entry in served['payload']['pools']],[1,2,3])
        self.assertEqual(build_response(served,now=now)['status'],'repaired')

    def test_a_safety_rule_broken_in_the_payload_removes_even_a_pin_at_once(self):
        a,b,c,d=TOKENS[:4]
        self.serve_today([a,b,c,d],sources={pool_of(a):'pinned'})
        now=AT+2*HOUR
        self.figures(a,at=now-5,integration='hooked_dynamic_fee')
        self.figures(b,at=now-5,lp_fee=500)
        self.figures(c,at=now-5,protocol=1001|(1001<<12))
        self.figures(d,at=now-5)
        health=self.live().tick(now)['health']
        self.assertEqual(health['removed'],{pool_of(a):'pool_integration_unsupported',pool_of(b):'fixed_fee_mismatch',
                                            pool_of(c):'invalid_protocol_fee'})
        self.assertEqual(self.served_ids(),[pool_of(d)])

    def test_market_conditions_remove_a_ranked_pool_once_they_have_held(self):
        a,b,c,d,e=TOKENS[:5]
        evaluations=[ev(a,300),ev(b,290),ev(c,280,fee=500),ev(d,270),ev(e,260)]
        self.record_selection(evaluations)
        self.serve(evaluations,[pool_of(a),pool_of(b),pool_of(c,500),pool_of(d),pool_of(e)],day=DAY,at=AT)
        start=AT+2*HOUR

        def check(offset):
            self.figures(a,at=start+offset-5,volume='20000')                     # under a tenth of the floor
            self.figures(b,at=start+offset-5,tvl='1000000',volume='10000000')    # turnover 10, APR 1095%
            self.figures(c,at=start+offset-5,tvl='1000000',volume='30000000',fee=500)   # turnover 30, APR 547%
            self.figures(d,at=start+offset-5)
            self.figures(e,at=start+offset-7*HOUR)                                  # last good longer ago than the horizon
            return self.live().tick(start+offset)['health']
        self.assertEqual(check(0)['status'],'healthy')
        self.assertEqual(check(1800-1)['status'],'healthy')
        self.assertEqual(check(1800)['removed'],{pool_of(b):'apr_or_turnover_above_ceiling',
                                                 pool_of(c,500):'apr_or_turnover_above_ceiling'})
        self.assertEqual(check(3*HOUR)['removed'],{pool_of(a):'volume_collapse',pool_of(e):'estimate_unavailable'})
        self.assertEqual(self.served_ids(),[pool_of(d)])

    def test_listed_tokens_code_is_read_once_an_hour(self):
        a=TOKENS[0]
        self.serve_today([a])
        listed={'address':a,'code':True,'codeHash':'0x'+keccak(bytes.fromhex('6000')).hex()}
        self.store.record(phase='live',day=YESTERDAY,outcome='carried_over',policy_version='featured-v1:'+'0'*12,
                          started_at=AT-ONE_DAY,finished_at=AT-ONE_DAY,evaluation={'summary':{},'evaluations':[],'screened':[]},
                          tokens=[listed],listed_tokens={a})
        live,now=self.live(),AT+2*HOUR
        for offset in (0,60,HOUR-1):
            self.figures(a,at=now+offset-5)
            self.assertEqual(live.tick(now+offset)['health']['status'],'healthy')
        token_reads=lambda:[address for address in self.node.code_reads if address==a]
        self.assertEqual(token_reads(),[a])
        self.figures(a,at=now+HOUR-5)
        live.tick(now+HOUR)
        self.assertEqual(token_reads(),[a,a])

    def test_a_manual_list_loses_an_excluded_pool_and_is_not_refilled(self):
        a,b,c=TOKENS[:3]
        self.checker.evaluations=[ev(a),ev(b)]
        self.record_selection([ev(a),ev(b),ev(c)])           # c would refill an automatic list
        self.store.add_override('manual','manual',reason='owner list',value={'pools':[pool_of(a),pool_of(b)]})
        self.store.add_override('mode','manual',reason='owner list')
        now=AT+2*HOUR
        for token in (a,b,c):self.figures(token,at=now+55)
        live=self.live()
        live.tick(now)
        before=self.store.current()
        self.store.add_override('exclude_pool',pool_of(a),reason='rug report')
        health=live.tick(now+60)['health']
        self.assertEqual((health['status'],health['added']),('manual',[]))
        served=self.store.current()
        self.assertEqual((served['status'],self.served_ids()),('manual',[pool_of(b)]))
        self.assertEqual(served['valid_until'],before['valid_until'])
        # Nor is it completed later, with c ready: only the owner chooses a manual list's pools.
        for token in (b,c):self.figures(token,at=now+60+VACANCY_SECONDS-5)
        self.assertEqual(live.tick(now+60+VACANCY_SECONDS)['health'],{'status':'healthy'})
        self.assertEqual(self.served_ids(),[pool_of(b)])

    def test_a_collapse_must_hold_across_checks_before_the_pool_leaves(self):
        a,b=TOKENS[:2]
        self.serve_today([a,b])
        start=AT+2*HOUR
        for offset,expected in ((0,'healthy'),(300,'healthy'),(600,'repaired')):
            self.figures(a,at=start+offset-5)
            self.figures(b,at=start+offset-5,tvl='124999')
            with self.subTest(offset=offset):
                health=self.live().tick(start+offset)['health']
                self.assertEqual(health['status'],expected)
        self.assertEqual(health['removed'],{pool_of(b):'tvl_collapse'})

    def test_a_withdrawn_pool_stays_out_of_the_day_s_repairs_even_once_it_recovers(self):
        a,b,c=TOKENS[:3]
        self.serve_today([a,b,c])
        start,live=AT+2*HOUR,self.live()
        for offset in (0,600):
            for token in (a,c):self.figures(token,at=start+offset-5)
            self.figures(b,at=start+offset-5,tvl='100000')
            live.tick(start+offset)
        self.assertEqual(self.served_ids(),[pool_of(a),pool_of(c)])
        for token in (a,b,c):self.figures(token,at=start+695)
        self.store.add_override('exclude_pool',pool_of(c),reason='rug report')
        health=live.tick(start+700)['health']
        self.assertEqual((health['removed'],health['added']),({pool_of(c):'excluded_by_owner'},[]))
        self.assertEqual(self.served_ids(),[pool_of(a)])

    def test_late_data_and_a_busy_provider_are_unknown_not_a_reason_to_leave(self):
        # #278: the collector starved the listed pools and the provider rate-limited it, and every
        # listed pool left within hours. Within the horizon that is unknown, not the pool's fault.
        a,b,c=TOKENS[:3]
        self.serve_today([a,b,c])
        start=AT+2*HOUR

        def check(offset):
            self.figures(a,at=start+offset-400)                                   # snapshot and market late
            self.figures(b,at=start+offset-5,rate_limited_for=2*HOUR)             # refused; last answer 2 h ago
            self.figures(c,at=start+offset-5,rate_limited_for=7*HOUR)             # refused; last answer 7 h ago
            return self.live().tick(start+offset)['health']
        self.assertEqual(check(0)['status'],'healthy')
        self.assertEqual(check(3*HOUR)['removed'],{pool_of(c):'estimate_unavailable'})
        self.assertEqual(check(6*HOUR)['status'],'healthy')
        self.assertEqual(self.served_ids(),[pool_of(a),pool_of(b)])

    def test_a_short_list_takes_a_replacement_once_it_is_ready_without_another_pool_leaving(self):
        # #278: a list repaired while no replacement was ready stayed short for the rest of the day.
        a,b,c=TOKENS[:3]
        self.serve_today([a],extra=[b,c])
        start,live=AT+2*HOUR,self.live()
        self.figures(a,at=start-5)
        self.assertEqual(live.tick(start)['health'],{'status':'healthy','vacant':self.policy['size']-1})
        # b is ready now, but the list looks again only VACANCY_SECONDS after it last looked.
        for token in (a,b):self.figures(token,at=start+60-5)
        self.assertEqual(live.tick(start+60)['health']['status'],'healthy')
        self.assertEqual(self.served_ids(),[pool_of(a)])
        for token in (a,b):self.figures(token,at=start+VACANCY_SECONDS-5)
        health=live.tick(start+VACANCY_SECONDS)['health']
        self.assertEqual((health['status'],health['added']),('refilled',[pool_of(b)]))
        self.assertEqual(self.served_ids(),[pool_of(a),pool_of(b)])
        self.assertEqual(self.store.current()['status'],'repaired')

    def test_a_list_every_pool_left_takes_replacements_once_they_are_ready(self):
        a,b=TOKENS[:2]
        self.serve_today([a],extra=[b])
        start,live=AT+2*HOUR,self.live()
        self.store.add_override('exclude_pool',pool_of(a),reason='rug report')
        health=live.tick(start)['health']
        self.assertEqual((health['removed'],health['added']),({pool_of(a):'excluded_by_owner'},[]))
        self.assertEqual(self.served_ids(),[])
        # The repair has just looked: ready a minute later, b still waits for the next look.
        self.figures(b,at=start+60-5)
        self.assertEqual(live.tick(start+60)['health'],{'status':'idle','vacant':self.policy['size']})
        self.figures(b,at=start+VACANCY_SECONDS-5)
        health=live.tick(start+VACANCY_SECONDS)['health']
        self.assertEqual((health['status'],health['added']),('refilled',[pool_of(b)]))
        self.assertEqual(self.served_ids(),[pool_of(b)])

    def test_a_vetoed_selection_fills_no_vacancy(self):
        a,b=TOKENS[:2]
        self.serve_today([a],extra=[b])
        self.store.add_override('veto',DAY.isoformat(),reason='owner veto in the daily note')
        start=AT+2*HOUR
        for token in (a,b):self.figures(token,at=start-5)
        self.assertEqual(self.live().tick(start)['health'],{'status':'healthy','vacant':self.policy['size']-1})
        self.assertEqual(self.served_ids(),[pool_of(a)])

    def test_a_short_list_keeps_its_next_candidates_warm_for_an_hour(self):
        size=self.policy['size']
        listed,extra=TOKENS[:size],TOKENS[size:size+5]
        self.serve_today(listed[:size-2],extra=extra)                          # two vacancies, five candidates
        now=AT+2*HOUR
        for token in (*listed,*extra):self.figures(token,at=now-3*HOUR)        # too old to be ready
        self.live().tick(now)

        def warm():
            with psycopg.connect(**self.settings,user=ADMIN) as conn:
                return {row[0]:int(row[1]) for row in conn.execute("""SELECT entity_id,extract(epoch FROM keep_warm_until)
                  FROM domino_public.entities WHERE kind='pool' AND keep_warm_until IS NOT NULL""")}
        found=warm()
        self.assertEqual(found[pool_of(listed[0])],now+26*HOUR)
        # The two that would fill the vacancies and two beyond, in refill order; not the fifth.
        self.assertEqual({pool_of(token):found.get(pool_of(token)) for token in extra},
                         {**{pool_of(token):now+CANDIDATE_WARM_SECONDS for token in extra[:4]},pool_of(extra[4]):None})
        # A full list warms no candidate.
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('UPDATE domino_public.entities SET keep_warm_until=NULL')
        self.serve([ev(token) for token in (*listed,*extra)],[pool_of(token) for token in listed])   # served yesterday
        self.live().tick(now)
        self.assertEqual({pool_of(token) for token in extra} & set(warm()),set())

    def test_a_recovered_condition_starts_its_window_again(self):
        a=TOKENS[0]
        self.serve_today([a])
        start=AT+2*HOUR
        for offset,tvl,expected in ((0,'1','healthy'),(300,'2000000','healthy'),(600,'1','healthy'),(1200,'1','repaired')):
            self.figures(a,at=start+offset-5,tvl=tvl)
            with self.subTest(offset=offset):
                self.assertEqual(self.live().tick(start+offset)['health']['status'],expected)

    def test_market_conditions_never_remove_a_pin_but_safety_rules_do(self):
        a,b=TOKENS[:2]
        self.serve_today([a,b],sources={pool_of(a):'pinned'})
        start=AT+2*HOUR
        self.live().tick(start)
        health=self.live().tick(start+3*HOUR)['health']
        self.assertEqual(health['removed'],{pool_of(b):'estimate_unavailable'})
        self.assertIn(pool_of(a),self.served_ids())
        self.figures(a,at=start+3*HOUR+55,protocol=100|(200<<12))
        health=self.live().tick(start+3*HOUR+60)['health']
        self.assertEqual(health['removed'],{pool_of(a):'protocol_fee_directional_unsupported'})

    def test_a_seventy_percent_fall_of_the_listed_token_removes_the_pool(self):
        a,b=TOKENS[:2]
        self.serve_today([a,b])
        start=AT+2*HOUR
        # ETH is currency0; the token's price in ETH is 1/P, so its fall is P rising.
        for offset,expected in ((0,'healthy'),(600,'repaired')):
            self.figures(a,at=start+offset-5,sqrt=int(2**96*1.8))   # 1/3.24: a 69% fall, kept
            self.figures(b,at=start+offset-5,sqrt=2**96*2)          # 1/4: a 75% fall
            with self.subTest(offset=offset):
                self.assertEqual(self.live().tick(start+offset)['health']['status'],expected)
        self.assertEqual(self.store.current()['payload']['withdrawn'][0]['reason'],'price_fall')
        self.assertEqual(self.served_ids(),[pool_of(a)])

    def test_a_token_whose_code_changed_leaves_and_stays_excluded(self):
        a,b=TOKENS[:2]
        self.serve_today([a,b])
        now=AT+2*HOUR
        for token in (a,b):self.figures(token,at=now-5)
        evidence={'address':a,'code':True,'codeHash':'0x'+'11'*32}
        self.store.record(phase='live',day=YESTERDAY,outcome='carried_over',policy_version='featured-v1:'+'0'*12,
                          started_at=AT-ONE_DAY,finished_at=AT-ONE_DAY,evaluation={'summary':{},'evaluations':[],'screened':[]},
                          tokens=[evidence],listed_tokens={a})
        health=self.live().tick(now)['health']
        self.assertEqual(health['removed'],{pool_of(a):'token_code_changed'})
        self.assertEqual(self.store.overrides(now)['excludedTokens'],[a])

    def test_every_pool_the_site_may_show_is_kept_warm_and_rewritten_hourly(self):
        a,b,m=TOKENS[:3]
        evaluations=[ev(token) for token in (a,b,m)]
        self.serve(evaluations,[pool_of(a)])
        self.record_selection(evaluations,[pool_of(b)])
        self.store.add_override('manual','manual',reason='standby list',value={'pools':[pool_of(m)]})
        for token in (a,b,m,TOKENS[12]):self.figures(token,at=AT-3*HOUR)
        live=self.live()
        now=AT-3*HOUR
        self.assertEqual(live.tick(now)['keptWarm'],4)
        self.assertEqual(live.tick(now+60)['keptWarm'],0)
        self.assertEqual(live.tick(now+HOUR+1)['keptWarm'],4)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            until=conn.execute("SELECT min(extract(epoch FROM keep_warm_until)) FROM domino_public.entities WHERE kind='pool'").fetchone()[0]
        self.assertEqual(int(until),now+HOUR+1+26*HOUR)

    def test_the_window(self):
        first,last,at=window(self.policy,AT+5*HOUR)
        self.assertEqual((first,last,at),(AT-30*60,AT-10*60,AT))


if __name__=='__main__':unittest.main()
