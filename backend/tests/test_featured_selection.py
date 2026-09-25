"""The featured-pools store and the shadow selection, end to end against real PostgreSQL.

The chain is test_discovery's scripted node (one ETH/TOKEN pool) and the
provider is a scripted GeckoTerminal; everything between them is the code
that runs in production, the collector's verified pool read included.
"""
import copy
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg import sql

from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import DataError
from featured_pools import load_policy
from featured_selector import Selector
from featured_store import FeaturedStore
from gt_listing import GeckoListing, listing_url
from manage_featured import tick, window
from test_discovery import BLOCK, FakeRpc, KEY, POOL, TOKEN, ZERO

NOW=1_790_380_000   # 2026-09-25 22:13:20 UTC
DAY=86400
UNKNOWN='0x'+'5a'*32
YOUNG='0x'+'6b'*32
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'


def gt_pool(pool_id,base,quote,*,volume='1000000',tvl='2000000',created=NOW-10*DAY,price='0.000000000001'):
    """One GeckoTerminal JSON:API pool object, as the listing and /pools/multi return it."""
    return {'id':'robinhood_'+pool_id,'type':'pool',
            'attributes':{'address':pool_id,'name':'TOKEN / WETH 0.3%','reserve_in_usd':tvl,
                          'volume_usd':{'h24':volume,'h6':str(Decimal(volume)/5)},
                          'transactions':{'h24':{'buys':300,'sells':300,'buyers':150,'sellers':150}},
                          'pool_created_at':datetime.fromtimestamp(created,timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                          'price_change_percentage':{'h24':'5'},'base_token_price_quote_token':price},
            'relationships':{'base_token':{'data':{'id':'robinhood_'+base,'type':'token'}},
                             'quote_token':{'data':{'id':'robinhood_'+quote,'type':'token'}},
                             'dex':{'data':{'id':'uniswap-v4-robinhood','type':'dex'}}}}


class Provider:
    """GeckoTerminal as the selector sees it: listing pages and multi reads."""
    def __init__(self,pages,multi=()):
        self.pages,self.multi_rows,self.urls,self.fail,self.fail_multi=pages,list(multi),[],None,None
    def __call__(self,url,timeout=None):
        self.urls.append(url)
        if self.fail:raise DataError(self.fail)
        if self.fail_multi and '/pools/multi/' in url:raise DataError(self.fail_multi)
        if '/pools/multi/' in url:
            wanted=url.rsplit('/',1)[1].split(',')
            return {'data':[row for row in self.multi_rows if row['attributes']['address'] in wanted]}
        page=int(url.rsplit('=',1)[1])
        return {'data':copy.deepcopy(self.pages[page-1]) if page<=len(self.pages) else []}


class Node(FakeRpc):
    """The scripted pool at a current block, plus what the selector reads beyond pool_market."""
    def __init__(self,clock):
        super().__init__();self.clock=clock
    def request(self,method,params=()):
        if method=='eth_getBlockByNumber':
            raw=super().request(method,params)
            return {**raw,'timestamp':hex(self.clock[0]-5)}
        return super().request(method,params)
    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        if signature=='getLiquidity(bytes32)':return (10**18,)
        if signature=='getTickBitmap(bytes32,int16)':return (0,)
        return super().call(target,signature,inputs,values,outputs,block=block)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class FeaturedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_featured_tests'}
        with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations=Path(__file__).resolve().parents[1]/'migrations'
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            for name in ('001_catalogue','002_activity','020_pool_requests','023_pool_request_scheduling',
                         '024_public_observations','025_public_history','026_public_demand',
                         '042_provider_priority','043_featured_pools'):
                conn.execute((migrations/(name+'.sql')).read_text())

    def setUp(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('''TRUNCATE domino_public.featured_current,domino_public.featured_lists,
              domino_public.featured_runs,domino_public.featured_overrides,domino_public.featured_token_checks,
              domino_public.entities,domino_public.provider_requests,domino_public.history_jobs,
              domino_activity.pool_requests,domino_catalogue.events,domino_catalogue.hints''')
        self.catalogue=PgCatalogue(self.settings)
        self.store=FeaturedStore(self.catalogue)
        self.policy={**load_policy(),'minPublishable':1}
        self.clock=[NOW]
        self.node=Node(self.clock)
        eligible=gt_pool(POOL,TOKEN,ZERO)
        young=gt_pool(YOUNG,TOKEN,USDG,created=NOW-DAY)
        thin=gt_pool('0x'+'7c'*32,TOKEN,USDG,tvl='200000')
        self.provider=Provider([[eligible,young,thin]],multi=[eligible])

    def selector(self,**changes):
        options=dict(store=self.store,catalogue=self.catalogue,policy=self.policy,
                     listing=GeckoListing(transport=self.provider,clock=lambda:self.clock[0],reserve=lambda:True),
                     rpc_factory=lambda:self.node,clock=lambda:self.clock[0],embedded=[POOL])
        return Selector(**{**options,**changes})

    def count(self,table):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            return conn.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.SQL(table))).fetchone()[0]

    # ---------------------------------------------------------------- store
    def test_the_reader_sees_lists_only(self):
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
            for table in ('featured_lists','featured_current'):
                conn.execute(sql.SQL('SELECT * FROM domino_public.{}').format(sql.Identifier(table)))
        for table in ('featured_runs','featured_overrides','featured_token_checks'):
            with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn,\
                 self.subTest(table=table),self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql.SQL('SELECT * FROM domino_public.{}').format(sql.Identifier(table)))
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn,\
             self.assertRaises(psycopg.errors.InsufficientPrivilege):
            conn.execute("INSERT INTO domino_public.featured_overrides(kind,subject,reason) VALUES('exclude_pool',%s,'x')",
                         (POOL,))

    def test_overrides_expire_and_a_new_pin_replaces_the_pool_s_old_one(self):
        self.store.add_override('pin',POOL,reason='owner',value={'slot':1})
        self.store.add_override('pin',POOL,reason='owner',value={'slot':2})
        self.store.add_override('exclude_token',TOKEN.upper().replace('0X','0x'),reason='rug',until=NOW+30*DAY)
        overrides=self.store.overrides(NOW)
        self.assertEqual(overrides['pins'],[{'poolId':POOL,'slot':2}])
        self.assertEqual(overrides['excludedTokens'],[TOKEN])
        self.assertEqual(self.store.overrides(NOW+30*DAY)['excludedTokens'],[])
        self.assertEqual(len(self.store.revoke_override('pin',POOL)),1)
        self.assertEqual(self.store.overrides(NOW)['pins'],[])
        for kind,subject,value in (('mode','auto',None),('pin',POOL,{'slot':'1'}),('exclude_pool','0x12',None)):
            with self.subTest(kind=kind),self.assertRaises(DataError):
                self.store.add_override(kind,subject,reason='x',value=value)
        with self.assertRaisesRegex(DataError,'invalid_featured_override'):
            self.store.add_override('exclude_pool',POOL,reason='  ')

    def test_one_selection_per_date_and_the_lookback_ignores_older_runs(self):
        evaluation={'summary':{},'evaluations':[{'poolId':POOL,'eligibleExceptPersistence':True,'freshApr':'5'}]}
        listing={'listId':'0x'+'00'*32,'generatedAt':NOW,'pools':[]}
        self.store.record(phase='shadow',day=date(2026,9,25),outcome='selected',policy_version='featured-v1:'+'0'*12,
                          started_at=NOW,finished_at=NOW,evaluation=evaluation,listing=listing)
        self.assertTrue(self.store.selection_done('shadow',date(2026,9,25)))
        self.assertFalse(self.store.selection_done('shadow',date(2026,9,26)))
        with self.assertRaisesRegex(DataError,'featured_selection_exists'):
            self.store.record(phase='shadow',day=date(2026,9,25),outcome='selected',
                              policy_version='featured-v1:'+'0'*12,started_at=NOW+1,finished_at=NOW+1,
                              evaluation=evaluation,listing=listing)
        self.assertEqual(self.count('domino_public.featured_runs'),1)   # the refused run rolled back too
        self.assertEqual(self.store.previous_evaluation('shadow',NOW+47*3600,48)['pools'][POOL]['freshApr'],'5')
        self.assertIsNone(self.store.previous_evaluation('shadow',NOW+48*3600+1,48))
        for outcome,listed in (('selected',None),('bootstrap',listing)):
            with self.subTest(outcome=outcome),self.assertRaisesRegex(DataError,'invalid_featured_run'):
                self.store.record(phase='shadow',day=date(2026,9,27),outcome=outcome,
                                  policy_version='featured-v1:'+'0'*12,started_at=NOW,finished_at=NOW,
                                  evaluation=evaluation,listing=listed)

    def test_the_selector_lock_refuses_a_second_selection(self):
        with self.store.selector_lock():
            with self.assertRaisesRegex(DataError,'featured_selector_busy'):
                with FeaturedStore(self.catalogue).selector_lock():pass
        with FeaturedStore(self.catalogue).selector_lock():pass

    # ---------------------------------------------------------------- selector
    def test_bootstrap_then_a_shadow_list_then_one_per_date(self):
        first=self.selector().select(now=NOW)
        self.assertEqual((first['outcome'],first['revision']),('bootstrap',None))
        self.assertEqual((first['screened'],first['evaluated']),(2,1))
        self.assertEqual(first['rejectedByReason'],{'not_persistent':1,'pool_too_young':1,'tvl_below_floor':1})
        self.clock[0]=NOW+DAY
        second=self.selector().select(now=NOW+DAY)
        self.assertEqual(second['outcome'],'selected',second)
        self.assertEqual(self.selector().select(now=NOW+DAY+60)['outcome'],'already_done')
        latest=self.store.previous_list('shadow')
        self.assertEqual([(entry['slot'],entry['poolId'],entry['source']) for entry in latest['pools']],
                         [(1,POOL,'ranked')])
        entry=latest['pools'][0]
        self.assertEqual(entry['identitySource'],'position_manager')
        self.assertEqual(entry['poolKey']['currency1'],TOKEN)
        self.assertEqual(entry['tokens'],[{'address':ZERO,'symbol':'ETH','decimals':18},
                                          {'address':TOKEN,'symbol':'TOKEN','decimals':6}])
        # 1M volume x 0.3% x 365 x 100 / 2M liquidity, the site's own estimate, on both days.
        self.assertEqual(Decimal(entry['rankInputs']['rankApr']),Decimal('54.75'))
        self.assertRegex(latest['listId'],r'^0x[0-9a-f]{64}$')
        baseline=self.store.token_baselines()[TOKEN]
        self.assertEqual(baseline['symbol_reading'],'TOKEN')
        self.assertRegex(baseline['listed_code_hash'],r'^0x[0-9a-f]{64}$')

    def test_the_shadow_creates_no_demand_seed_or_history_job(self):
        self.selector().select(now=NOW)
        self.clock[0]=NOW+DAY
        self.selector().select(now=NOW+DAY)
        for table in ('domino_public.entities','domino_public.history_jobs','domino_activity.pool_requests',
                      'domino_catalogue.hints','domino_catalogue.events'):
            with self.subTest(table=table):
                self.assertEqual(self.count(table),0)
        self.assertTrue(all('api.geckoterminal.com' in url for url in self.provider.urls))

    def test_the_listing_goes_through_the_provider_allowance(self):
        refused=self.selector(listing=GeckoListing(transport=self.provider,clock=lambda:self.clock[0],
                                                   reserve=lambda:False))
        result=refused.select(now=NOW,final=False)
        self.assertEqual(result['outcome'],'incomplete')
        self.assertEqual(self.provider.urls,[])
        self.assertFalse(self.store.selection_done('shadow',date(2026,9,25)))

    def test_a_listing_cut_short_is_retried_then_keeps_yesterday_s_list(self):
        self.provider.fail='http_429'
        self.assertEqual(self.selector().select(now=NOW,final=False)['outcome'],'incomplete')
        self.assertFalse(self.store.selection_done('shadow',date(2026,9,25)))
        last=self.selector().select(now=NOW+60,final=True)
        self.assertEqual((last['outcome'],last['revision']),('carried_over',None))
        self.assertTrue(self.store.selection_done('shadow',date(2026,9,25)))

    def test_shown_pools_the_provider_could_not_read_make_the_run_incomplete(self):
        self.provider.pages=[[]]
        self.provider.fail_multi='http_429'
        self.assertEqual(self.selector().select(now=NOW,final=False)['outcome'],'incomplete')
        self.assertEqual(self.selector().select(now=NOW+60,final=True)['outcome'],'carried_over')

    def test_owner_exclusions_and_pins_reach_the_rules(self):
        self.selector().select(now=NOW)
        self.clock[0]=NOW+DAY
        self.store.add_override('exclude_pool',POOL,reason='owner veto')
        result=self.selector().select(now=NOW+DAY)
        self.assertEqual(result['outcome'],'carried_over')
        self.assertIn('excluded_by_owner',result['rejectedByReason'])

    def test_pinned_pool_outside_the_listing_is_read_through_multi(self):
        self.provider.pages=[[]]
        self.store.add_override('pin',POOL,reason='owner',value={'slot':1})
        self.selector().select(now=NOW)
        self.clock[0]=NOW+DAY
        result=self.selector().select(now=NOW+DAY)
        self.assertEqual(result['outcome'],'selected')
        self.assertEqual(self.store.previous_list('shadow')['pools'][0]['source'],'pinned')
        self.assertTrue(any('/pools/multi/' in url for url in self.provider.urls))

    def test_the_previous_list_meets_the_floors_at_seventy_percent(self):
        for pages,multi in (([[gt_pool(POOL,TOKEN,ZERO,volume='200000',tvl='400000')]],[]),
                            ([[]],[gt_pool(POOL,TOKEN,ZERO,volume='200000',tvl='400000')])):
            with self.subTest(listed=bool(pages[0])):
                self.setUp()
                self.provider.pages,self.provider.multi_rows=pages,multi
                self.selector().select(now=NOW)
                self.clock[0]=NOW+DAY
                self.assertEqual(self.selector().select(now=NOW+DAY)['outcome'],'selected')
                self.assertEqual(self.store.previous_list('shadow')['pools'][0]['source'],'ranked')

    def test_paging_stops_below_the_volume_floor_and_reports_a_truncated_listing(self):
        full=[gt_pool('0x%064x'%(n+1),TOKEN,USDG,created=NOW-DAY) for n in range(20)]
        self.provider.pages=[full,full]
        self.selector().select(now=NOW)
        # Two full pages above the floor: the third answers empty and ends the listing.
        self.assertEqual([url for url in self.provider.urls if 'page=' in url],
                         [listing_url(1),listing_url(2),listing_url(3)])
        self.setUp()
        self.provider.pages=[full[:19]+[gt_pool('0x%064x'%99,TOKEN,USDG,volume='249999')],full]
        self.selector().select(now=NOW)
        self.assertEqual([url for url in self.provider.urls if 'page=' in url],[listing_url(1)])
        self.setUp()
        self.provider.pages=[full]
        truncated=self.selector(policy={**self.policy,'maxListingPages':1}).select(now=NOW)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            coverage=conn.execute('SELECT evaluation->%s AS c FROM domino_public.featured_runs WHERE id=%s',
                                  ('coverage',truncated['runId'])).fetchone()[0]
        self.assertEqual((coverage['pages'],coverage['truncated']),(1,True))

    def test_the_service_window(self):
        first,last,at=window(self.policy,NOW)
        self.assertEqual((at-first,at-last),(30*60,10*60))
        self.assertEqual(at%DAY,12*3600)
        self.assertEqual(tick(self.selector(),self.store,self.policy,first-1)['status'],'idle')
        self.assertEqual(tick(self.selector(),self.store,self.policy,at)['status'],'idle')
        self.clock[0]=first
        self.assertEqual(tick(self.selector(),self.store,self.policy,first)['outcome'],'bootstrap')


if __name__=='__main__':unittest.main()
