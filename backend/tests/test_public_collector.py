"""Collector integration, isolated from the catalogue/restore test databases."""
import copy
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg import sql

from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, DataError, ZERO
from eth_abi import encode
from eth_hash.auto import keccak
from discovery import POOL_MANAGER
from manage_public_data import PublicCollector
from market_cache import MarketCache
from public_observations import PgPublicData
from public_data_service import PublicDataService
from read_service import ReadService
from test_catalogue import stored_candidate
from test_discovery import BLOCK, FakeRpc, KEY, POOL, TOKEN, candidate
from test_pool_market import Provider
from test_public_observations import another_market, fixtures
from read_deadline import read_deadline


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class PublicCollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # This name is intentionally separate: other agents exercise the usual
        # catalogue/restore databases concurrently. No production name accepted.
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_collector_tests'}
        with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations=Path(__file__).resolve().parents[1]/'migrations'
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            for name in ('001_catalogue','002_activity','020_pool_requests','023_pool_request_scheduling',
                         '024_public_observations','025_public_history','026_public_demand'):
                conn.execute((migrations/(name+'.sql')).read_text())

    def setUp(self):
        self.catalogue=PgCatalogue(self.settings)
        self.writer=PgPublicData(self.catalogue,writer=True,clock=lambda:1010)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_public.entities,domino_public.token_pools,domino_public.provider_requests,domino_catalogue.events,domino_catalogue.chunks,domino_catalogue.hints')
            conn.execute('UPDATE domino_catalogue.state SET revision=0')
            conn.execute('UPDATE domino_public.state SET revision=0')
        self.rpc=FakeRpc();self.provider=Provider();self.discovery=[]
        self.service=ReadService(rpc_factory=lambda:self.rpc,clock=lambda:1010,catalogue=self.catalogue,
            market_cache=MarketCache(self.provider,clock=lambda:1010),
            transport_factory=lambda:lambda url,*args:self.discovery)
        self.history=Mock();self.requests=Mock()
        self.collector=PublicCollector(self.writer,self.service,history=self.history,requests=self.requests,clock=lambda:1010)

    def row(self,kind='token',entity=TOKEN):return self.writer.get(kind,entity)

    def age_interest(self,kind='token',entity=TOKEN):
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET last_requested_at=clock_timestamp()-interval '60 seconds' WHERE kind=%s AND entity_id=%s",(kind,entity))

    def due(self,kind='token',entity=TOKEN):
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET next_due=clock_timestamp()-interval '1 second' WHERE kind=%s AND entity_id=%s",(kind,entity))

    def test_metadata_survives_optional_discovery_timeout(self):
        self.writer.request('token',TOKEN)
        with patch.object(self.service,'pools',side_effect=DataError('read_deadline_exceeded')):
            result=self.collector.tick(token_limit=1,pool_limit=0)
        row=self.row()
        self.assertIsNotNone(row['payload'],'completed token metadata was discarded with optional discovery')
        self.assertEqual(row['payload']['asset']['address'],TOKEN)
        self.assertEqual(row['last_error'],'read_deadline_exceeded')
        self.assertIsNone(row['lease_token'])
        self.assertEqual(result[0]['status'],'retry')

    def test_polling_does_not_cancel_failure_backoff(self):
        self.writer.request('token',TOKEN);claim=self.writer.claim('token')[0]
        self.writer.fail(claim,'network_unavailable',delay=300)
        due=self.row()['next_due'];self.age_interest()
        self.writer.request('token',TOKEN)
        self.assertEqual(self.row()['next_due'],due,'browser polling canceled exponential retry backoff')

    def test_seed_failure_never_publishes_a_discovered_link(self):
        self.writer.request('token',TOKEN);self.discovery=[candidate()]
        with patch.object(self.catalogue,'seed',side_effect=DataError('catalogue_writer_busy')):
            self.collector.tick(token_limit=1,pool_limit=0)
        with self.writer.connection() as conn:
            links=conn.execute('SELECT * FROM domino_public.token_pools').fetchall()
        self.assertEqual(links,[],'discovery links became visible before their verified identity was stored')
        self.assertIsNotNone(self.row()['payload'])
        self.due();result=self.collector.tick(token_limit=1,pool_limit=0)
        self.assertEqual(result[0]['status'],'published',result)
        self.assertIsNotNone(self.row('pool',POOL))
        self.assertEqual(self.catalogue.lookup(TOKEN)['items'][0]['poolId'],POOL)

    def test_unknown_contract_keeps_metadata_and_persists_explicit_empty_discovery(self):
        self.writer.request('token',TOKEN)
        result=self.collector.tick(token_limit=1,pool_limit=0)
        self.assertEqual(result[0]['status'],'published',result)
        self.assertEqual(self.row()['payload']['asset']['readStatus'],'available')
        self.assertEqual(self.writer.overview(token=TOKEN)['poolIds'],[])
        self.assertFalse(self.catalogue.lookup(TOKEN)['items'])
        with self.writer.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_public.provider_requests').fetchone()['n'],1)

    def test_noncontract_ttl_survives_browser_polling(self):
        original=self.rpc.request
        def request(method,params=()):
            if method=='eth_getCode' and params[0]==TOKEN:return '0x'
            return original(method,params)
        self.rpc.request=request
        self.writer.request('token',TOKEN)
        self.collector.tick(token_limit=1,pool_limit=0)
        row=self.row();self.assertEqual(row['payload']['asset']['readStatus'],'no_contract')
        self.assertGreater((row['next_due']-row['last_requested_at']).total_seconds(),86000)
        self.age_interest();self.writer.request('token',TOKEN)
        self.assertEqual(self.row()['next_due'],row['next_due'])
        self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0),[])

    def test_stale_or_reorganized_head_cannot_publish_current_data(self):
        self.writer.request('token',TOKEN)
        self.service.clock=lambda:1300
        self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0)[0]['reason'],'stale_or_future_block')
        self.assertIsNone(self.row()['payload'])
        self.service.clock=lambda:1010;self.rpc.reorg=True;self.rpc.blocks_read=0;self.due()
        self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0)[0]['reason'],'snapshot_reorganized')
        self.assertIsNone(self.row()['payload'])

    def test_discovery_seed_is_fenced_against_expired_token_claim(self):
        self.writer.request('token',TOKEN);self.discovery=[candidate()]
        original=self.service.pools
        def expire(*args,**kwargs):
            response=original(*args,**kwargs)
            with self.writer.connection(write=True) as conn:
                conn.execute("UPDATE domino_public.entities SET lease_until=clock_timestamp()-interval '1 second' WHERE kind='token' AND entity_id=%s",(TOKEN,))
            self.replacement=self.writer.claim('token')[0]
            return response
        with patch.object(self.service,'pools',expire):result=self.collector.tick(token_limit=1,pool_limit=0)
        self.assertEqual(result[0]['reason'],'public_data_lease_lost')
        self.assertFalse(self.catalogue.lookup(TOKEN)['items'])
        self.assertFalse(self.writer.overview(token=TOKEN)['poolIds'])
        self.assertEqual(self.row()['generation'],self.replacement['generation'])
        self.assertEqual(self.row()['lease_token'],self.replacement['lease_token'])

    def test_more_than_one_hundred_known_pools_continue_on_next_discovery_page(self):
        candidates=[stored_candidate((ZERO,TOKEN,500+i,60,ZERO)) for i in range(105)]
        self.catalogue.seed(candidates,Block(700,BLOCK['hash'],1000))
        self.writer.request('token',TOKEN)
        self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0)[0]['status'],'published')
        self.assertIsNotNone(self.row()['discovery_after'])
        self.due();self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0)[0]['status'],'published')
        self.assertIsNone(self.row()['discovery_after'])
        with self.writer.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_public.token_pools').fetchone()['n'],105)
            self.assertEqual(conn.execute("SELECT count(*) AS n FROM domino_public.entities WHERE kind='pool'").fetchone()['n'],105)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_public.provider_requests').fetchone()['n'],0)

    def test_thirty_two_pools_are_collected_without_the_legacy_twenty_four_limit(self):
        _,market=fixtures();markets={row['poolId']:row for row in (another_market(market,i) for i in range(32))}
        for pool in markets:self.writer.request('pool',pool)
        with patch.object(self.service,'pool_market',side_effect=lambda pool,**kwargs:markets[pool]):
            result=[]
            for _ in range(8):result.extend(self.collector.tick(token_limit=0,pool_limit=4))
        self.assertEqual(len(result),32);self.assertTrue(all(row['status']=='published' for row in result))
        first=self.writer.overview(token=TOKEN,limit=24)
        second=self.writer.overview(token=TOKEN,after=first['nextAfter'],revision=first['revision'],limit=24)
        self.assertEqual((len(first['pools']),len(second['pools'])),(24,8))
        self.assertEqual(self.history.request.call_count,32);self.assertEqual(self.requests.enqueue.call_count,32)
        self.assertEqual({call.args[0] for call in self.history.request.call_args_list},set(markets))

    def test_shared_provider_limit_survives_collector_restart(self):
        for index in range(15):self.service.market_cache.get('pool','0x'+f'{index+1:064x}')
        replacement=MarketCache(self.provider,clock=lambda:1010)
        self.service.market_cache=replacement
        PublicCollector(self.writer,self.service)
        results=[replacement.get('pool','0x'+f'{index+100:064x}') for index in range(15)]
        self.assertEqual(len(self.provider.calls),25)
        self.assertEqual([row['cache']['status'] for row in results[-5:]],['rate_limited']*5)

    def test_shared_rpc_budget_stops_discovery_but_retains_completed_metadata(self):
        calls=[]
        def transport(url,body=None):
            if body is None:return []
            if isinstance(body,list):return [transport(url,item) for item in body]
            calls.append(body)
            method,params=body['method'],body['params']
            if method=='eth_chainId':value=hex(4663)
            elif method=='eth_getBlockByNumber':value=BLOCK
            elif method=='eth_getCode':value='0x6000'
            elif method=='eth_call':
                selector=params[0]['data'][:10]
                if selector=='0x'+keccak(b'poolManager()').hex()[:8]:value='0x'+encode(['address'],[POOL_MANAGER]).hex()
                elif selector=='0x'+keccak(b'decimals()').hex()[:8]:value='0x'+encode(['uint8'],[6]).hex()
                elif selector=='0x'+keccak(b'symbol()').hex()[:8]:value='0x'+encode(['string'],['TOKEN']).hex()
                else:raise AssertionError(selector)
            else:raise AssertionError(method)
            return {'jsonrpc':'2.0','id':body['id'],'result':value}
        self.service.rpc_factory=None;self.service.transport_factory=lambda:transport
        self.writer.request('token',TOKEN)
        result=self.collector.tick(token_limit=1,pool_limit=0,max_rpc_calls=16)
        self.assertLessEqual(len(calls),16);self.assertEqual(self.collector.rpc_calls,len(calls))
        self.assertEqual(result[0]['reason'],'public_rpc_budget_exhausted')
        self.assertIsNotNone(self.row()['payload'])

    def test_pg_statement_timeout_obeys_shared_request_deadline(self):
        opened=time.monotonic()
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(.08),self.writer.connection() as conn:
                conn.execute('SELECT pg_sleep(1)')
        self.assertLess(time.monotonic()-opened,.6)

    def test_pg_timeout_shrinks_between_statements_and_overview_is_repeatable_read(self):
        with read_deadline(.8),self.writer.connection() as conn:
            before=int(conn.execute("SELECT current_setting('statement_timeout')::interval AS interval, 1 AS unused").fetchone()['interval'].total_seconds()*1000)
            conn.execute('SELECT pg_sleep(.1)')
            after=int(conn.execute("SELECT current_setting('statement_timeout')::interval AS interval").fetchone()['interval'].total_seconds()*1000)
        self.assertGreater(before-after,70)
        with read_deadline(1):
            self.assertEqual(self.writer.overview(token=TOKEN)['poolIds'],[])

    def test_bulk_demand_uses_one_connection_for_every_item(self):
        ids=['0x'+f'{index+1:064x}' for index in range(24)]
        connect=psycopg.connect
        with patch('public_observations.psycopg.connect',wraps=connect) as observed:
            self.assertTrue(self.writer.request_many('pool',ids))
        self.assertEqual(observed.call_count,1)
        with self.writer.connection() as conn:
            actual=conn.execute("SELECT entity_id FROM domino_public.entities WHERE kind='pool' ORDER BY entity_id").fetchall()
        self.assertEqual([row['entity_id'] for row in actual],ids)

    def test_bulk_demand_validates_all_before_admitting_and_empty_avoids_db(self):
        with self.assertRaises(DataError):self.writer.request_many('pool',[POOL,'invalid'])
        with self.assertRaises(DataError):self.writer.request_many('pool',[POOL]*25)
        self.assertIsNone(self.row('pool',POOL))
        with patch.object(self.writer,'connection',side_effect=AssertionError('empty request touched database')):
            self.assertTrue(self.writer.request_many('pool',[]))

    def test_bulk_demand_does_not_stop_after_a_refused_item(self):
        # Fill the novel-demand ceiling, then request one new ID before one
        # existing ID. The latter's interest must still be refreshed.
        with self.writer.connection(write=True) as conn:
            conn.execute("""INSERT INTO domino_public.entities(kind,entity_id,last_requested_at)
              SELECT 'pool','0x'||lpad(to_hex(n),64,'0'),clock_timestamp()-interval '60 seconds'
              FROM generate_series(1,1000) AS numbers(n)""")
        existing='0x'+f'{1:064x}';before=self.row('pool',existing)['last_requested_at']
        self.assertFalse(self.writer.request_many('pool',[POOL,existing]))
        self.assertGreater(self.row('pool',existing)['last_requested_at'],before)
        self.assertIsNone(self.row('pool',POOL))

    def test_bulk_demand_rolls_back_if_deadline_expires_after_statement(self):
        from public_observations import DeadlineConnection
        original=DeadlineConnection.execute
        def expired(connection,query,params=None,**kwargs):
            cursor=original(connection,query,params,**kwargs)
            if 'FROM unnest' in str(query):raise DataError('read_deadline_exceeded')
            return cursor
        with patch.object(DeadlineConnection,'execute',expired),self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(1):self.writer.request_many('pool',[POOL,'0x'+'42'*32])
        self.assertIsNone(self.row('pool',POOL));self.assertIsNone(self.row('pool','0x'+'42'*32))

    def test_overview_explicit_pool_admission_is_one_bounded_batch(self):
        public=PublicDataService(self.writer,history_store=Mock(),clock=lambda:1010)
        ids=['0x'+f'{index+1:064x}' for index in range(24)]
        with patch.object(self.writer,'request_many',wraps=self.writer.request_many) as batch:
            with read_deadline(2):response=public.overview(poolIds=ids)
        batch.assert_called_once_with('pool',ids)
        self.assertTrue(response['acquisitionAccepted'])
        self.assertEqual(len(response['pools']),24)

    def test_token_overview_renews_only_visible_pools_and_preserves_metadata_ttl(self):
        token,market=fixtures()
        self.writer.request('token',TOKEN)
        self.writer.publish(self.writer.claim('token')[0],token,delay=300)
        markets=[another_market(market,index) for index in range(32)]
        for item in markets:
            self.writer.request('pool',item['poolId'])
            self.writer.publish(self.writer.claim('pool')[0],item,delay=120)
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET last_requested_at=clock_timestamp()-interval '20 minutes'")
        token_due=self.row()['next_due']
        hidden={item['poolId']:self.row('pool',item['poolId']) for item in markets}
        public=PublicDataService(self.writer,history_store=Mock(),clock=lambda:1010)
        with patch.object(self.writer,'request_many',wraps=self.writer.request_many) as batch:
            response=public.overview(token=TOKEN,limit=24)
        visible=[row['poolId'] for row in response['pools']]
        batch.assert_called_once_with('pool',visible)
        self.assertEqual(len(visible),24)
        self.assertTrue(response['acquisitionAccepted'])
        self.assertEqual(self.row()['next_due'],token_due)
        for pool,before in hidden.items():
            after=self.row('pool',pool)
            if pool in visible:
                self.assertGreater(after['last_requested_at'],before['last_requested_at'])
                self.assertLess((after['next_due']-after['last_requested_at']).total_seconds(),6)
            else:
                self.assertEqual(after['last_requested_at'],before['last_requested_at'])
                self.assertEqual(after['next_due'],before['next_due'])
        # Polling within the 15-second debounce does not keep rewriting rows.
        after_first={pool:self.row('pool',pool)['last_requested_at'] for pool in visible}
        public.overview(token=TOKEN,limit=24)
        self.assertEqual({pool:self.row('pool',pool)['last_requested_at'] for pool in visible},after_first)

    def test_token_overview_reports_any_refusal_without_skipping_pool_demand(self):
        public=PublicDataService(self.writer,history_store=Mock(),clock=lambda:1010)
        with patch.object(self.writer,'request',return_value=False),patch.object(
                self.writer,'request_many',return_value=True) as batch:
            self.assertFalse(public.overview(token=TOKEN)['acquisitionAccepted'])
        batch.assert_called_once_with('pool',[])
        with patch.object(self.writer,'request',return_value=True),patch.object(
                self.writer,'request_many',return_value=False):
            self.assertFalse(public.overview(token=TOKEN)['acquisitionAccepted'])

    def test_pool_cadence_uses_recent_demand_and_keeps_oldest_due_fairness(self):
        _,market=fixtures();self.collector.clock=time.time
        self.writer.request('pool',POOL)
        with patch.object(self.service,'pool_market',return_value=market):
            for interest_age,expected_delay in ((30,5),(61,120)):
                with self.writer.connection(write=True) as conn:
                    conn.execute("""UPDATE domino_public.entities SET last_requested_at=clock_timestamp()-(%s*interval '1 second'),
                      next_due=clock_timestamp()-interval '1 second' WHERE kind='pool' AND entity_id=%s""",(interest_age,POOL))
                before=time.time()
                self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
                delay=self.row('pool',POOL)['next_due'].timestamp()-before
                self.assertGreaterEqual(delay,expected_delay)
                self.assertLess(delay,expected_delay+2)
        older='0x'+'42'*32
        self.writer.request('pool',older)
        with self.writer.connection(write=True) as conn:
            conn.execute("""UPDATE domino_public.entities SET next_due=clock_timestamp()-interval '30 seconds',
              last_requested_at=clock_timestamp()-interval '1 hour' WHERE kind='pool' AND entity_id=%s""",(older,))
            conn.execute("""UPDATE domino_public.entities SET next_due=clock_timestamp()-interval '1 second',
              last_requested_at=clock_timestamp() WHERE kind='pool' AND entity_id=%s""",(POOL,))
        self.assertEqual(self.writer.claim('pool')[0]['entity_id'],older)

    def test_pool_currency_metadata_never_recursively_discovers_stablecoin_pools(self):
        candidates=[stored_candidate((ZERO,TOKEN,500+i,60,ZERO)) for i in range(105)]
        self.catalogue.seed(candidates,Block(700,BLOCK['hash'],1000))
        _,market=fixtures()
        self.writer.request('pool',POOL)
        with patch.object(self.service,'pool_market',return_value=market):
            self.collector.tick(token_limit=0,pool_limit=1)
        self.assertFalse(self.row()['discovery_requested'])
        self.assertEqual(self.row()['last_requested_at'].timestamp(),0)
        with (patch.object(self.catalogue,'lookup',side_effect=AssertionError('dependency requested discovery')),
              patch.object(self.service,'pools',side_effect=AssertionError('dependency called provider'))):
            rows=self.collector.tick(token_limit=2,pool_limit=0)
        self.assertTrue(all(row['status']=='published' for row in rows),rows)
        self.assertEqual(len(rows),2)
        with self.writer.connection() as conn:
            self.assertEqual(conn.execute("SELECT count(*) AS n FROM domino_public.entities WHERE kind='pool'").fetchone()['n'],1)
        # A subsequent explicit search can discover the same stablecoin's pools.
        self.writer.request('token',TOKEN);self.due()
        self.assertTrue(self.row()['discovery_requested'])
        self.assertEqual(self.collector.tick(token_limit=1,pool_limit=0)[0]['status'],'published')
        with self.writer.connection() as conn:
            self.assertEqual(conn.execute("SELECT count(*) AS n FROM domino_public.entities WHERE kind='pool'").fetchone()['n'],101)
            self.assertEqual(conn.execute("SELECT count(*) AS n FROM domino_public.entities WHERE kind='pool' AND last_requested_at>'epoch'::timestamptz").fetchone()['n'],1)

    def test_legacy_token_metadata_does_not_admit_discovery(self):
        self.service.public_data=Mock()
        self.service.token(TOKEN)
        self.service.public_data.repository.request.assert_not_called()
        self.service.pools(TOKEN)
        self.service.public_data.repository.request.assert_called_once_with('token',TOKEN)

    def test_large_background_backlog_preserves_three_hot_slots_and_one_oldest_slot(self):
        with self.writer.connection(write=True) as conn:
            conn.execute("""INSERT INTO domino_public.entities(kind,entity_id,last_requested_at,next_due)
              SELECT 'pool','0x'||lpad(to_hex(n),64,'0'),'epoch'::timestamptz,clock_timestamp()-interval '1 day'
              FROM generate_series(1,1000) AS numbers(n)""")
        hot=['0x'+f'{index+2000:064x}' for index in range(3)]
        self.writer.request_many('pool',hot)
        collected=[]
        def collect(claim):
            collected.append(claim['entity_id'])
            self.writer.fail(claim,'fixture_finished',delay=120)
        # One slot per invocation simulates repeated budget exhaustion or
        # service restarts. The fourth turn must still belong to background.
        for _ in range(4):
            collector=PublicCollector(self.writer,self.service)
            with patch.object(collector,'collect',side_effect=collect):
                collector.tick(token_limit=0,pool_limit=1)
        self.assertEqual(set(collected[:3]),set(hot))
        self.assertEqual(collected[3],'0x'+f'{1:064x}')

    def test_background_capacity_does_not_reject_first_explicit_search(self):
        with self.writer.connection(write=True) as conn:
            conn.execute("""INSERT INTO domino_public.entities(kind,entity_id,last_requested_at)
              SELECT 'pool','0x'||lpad(to_hex(n),64,'0'),'epoch'::timestamptz
              FROM generate_series(1,1000) AS numbers(n)""")
        self.assertFalse(self.writer.ensure('token',TOKEN))
        self.assertTrue(self.writer.request('token',TOKEN))
        self.assertTrue(self.row()['discovery_requested'])
        self.assertGreater(self.row()['last_requested_at'].timestamp(),0)
        # The explicit ceiling still holds, including promotion of a prerequisite.
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET last_requested_at=clock_timestamp() WHERE kind='pool' AND entity_id<>%s",('0x'+f'{1:064x}',))
        self.assertFalse(self.writer.request('pool','0x'+f'{1:064x}'))

    def test_explicit_search_during_metadata_lease_schedules_discovery_promptly(self):
        token,_=fixtures();self.writer.ensure('token',TOKEN)
        claim=self.writer.claim('token')[0]
        self.assertFalse(claim['discovery_requested'])
        self.writer.request('token',TOKEN)
        before=time.time();self.writer.publish(claim,token,delay=300)
        self.assertLess(self.row()['next_due'].timestamp()-before,6)
        self.assertTrue(self.row()['discovery_requested'])

    def test_background_pool_observation_does_not_admit_deep_or_recent_history(self):
        _,market=fixtures();self.writer.ensure('pool',POOL)
        with patch.object(self.service,'pool_market',return_value=market):
            self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        self.requests.enqueue.assert_not_called()
        self.history.request.assert_not_called()
        self.assertIsNotNone(self.row('pool',POOL)['payload'])

    def test_demand_repair_preserves_data_and_only_resets_legacy_interest_once(self):
        token,_=fixtures();self.writer.request('token',TOKEN)
        self.writer.publish(self.writer.claim('token')[0],token,delay=300)
        before=self.row()
        migration=(Path(__file__).resolve().parents[1]/'migrations/026_public_demand.sql').read_text()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("INSERT INTO domino_public.entities(kind,entity_id) VALUES('pool',%s)",(POOL,))
            conn.execute("INSERT INTO domino_activity.pool_requests(pool_id,reason,status,detail) VALUES(%s,'read','following','{\"saved\":true}') ON CONFLICT(pool_id) DO UPDATE SET last_requested_at=clock_timestamp(),status='following',detail=EXCLUDED.detail",(POOL,))
            conn.execute('ALTER TABLE domino_public.entities DROP COLUMN discovery_requested')
            conn.execute(migration)
            queue=conn.execute('SELECT last_requested_at,status,detail FROM domino_activity.pool_requests WHERE pool_id=%s',(POOL,)).fetchone()
            self.assertEqual(queue[0].timestamp(),0)
            self.assertEqual(queue[1:],('following',{'saved':True}))
        repaired=self.row()
        self.assertEqual(repaired['payload'],before['payload'])
        self.assertEqual(repaired['observed_at'],before['observed_at'])
        self.assertEqual(repaired['requested_at'],before['requested_at'])
        self.assertEqual(repaired['last_requested_at'].timestamp(),0)
        self.assertFalse(repaired['discovery_requested'])
        self.writer.request('token',TOKEN);explicit=self.row()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:conn.execute(migration)
        self.assertEqual(self.row()['last_requested_at'],explicit['last_requested_at'])
        self.assertTrue(self.row()['discovery_requested'])

    def restart_at(self,now):
        self.writer.clock=lambda:now
        self.service.market_cache=MarketCache(self.provider,clock=lambda:now)
        self.service.clock=lambda:now
        self.collector=PublicCollector(self.writer,self.service,clock=lambda:now,
                                       requests=self.requests,history=self.history)

    def test_cold_restart_keeps_persisted_market_original_age_when_quota_is_full(self):
        _,market=fixtures();self.writer.request('pool',POOL)
        self.writer.publish(self.writer.claim('pool')[0],market)
        self.assertTrue(all(self.writer.reserve_provider() for _ in range(25)))
        self.restart_at(1040);self.due('pool',POOL)
        self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        first=self.row('pool',POOL)
        self.assertEqual(first['observed_at'],1040)
        self.assertEqual(first['payload']['market']['cache']['ageSeconds'],30)
        self.assertEqual(first['payload']['market']['data'],market['market']['data'])
        self.restart_at(1080);self.due('pool',POOL)
        self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        second=self.row('pool',POOL)['payload']['market']
        self.assertEqual((second['status'],second['reason'],second['cache']['ageSeconds']),
                         ('stale','provider_capacity_busy',70))
        self.assertEqual(second['data']['retrievedAt'],1010)
        self.assertEqual(self.provider.calls,[])
        self.assertFalse(self.writer.reserve_provider())

    def test_background_pool_keeps_onchain_state_without_consuming_provider_quota(self):
        self.writer.ensure('pool',POOL)
        self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        value=self.row('pool',POOL)['payload']
        self.assertEqual(value['pool']['identityStatus'],'verified_at_block')
        self.assertEqual(value['market']['status'],'unavailable')
        self.assertEqual(self.provider.calls,[])
        self.assertTrue(all(self.writer.reserve_provider() for _ in range(25)))

    def test_background_pool_reuses_valid_stale_market_without_provider_attempt(self):
        _,market=fixtures();self.writer.import_market(market,1010)
        self.restart_at(1080);self.due('pool',POOL)
        self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        value=self.row('pool',POOL)['payload']['market']
        self.assertEqual((value['status'],value['cache']['ageSeconds']),('stale',70))
        self.assertEqual(value['data'],market['market']['data'])
        self.assertEqual(self.provider.calls,[])
        self.assertTrue(all(self.writer.reserve_provider() for _ in range(25)))

    def test_restored_market_still_rejects_reorganized_current_snapshot(self):
        _,market=fixtures();self.writer.request('pool',POOL)
        self.writer.publish(self.writer.claim('pool')[0],market)
        self.restart_at(1040);self.due('pool',POOL)
        self.rpc.reorg=True;self.rpc.blocks_read=0
        result=self.collector.tick(token_limit=0,pool_limit=1)
        self.assertEqual(result[0]['reason'],'snapshot_reorganized')
        self.assertEqual(self.row('pool',POOL)['observed_at'],1010)
        self.assertEqual(self.row('pool',POOL)['payload'],market)

    def test_new_provider_identity_rejection_cannot_fall_back_to_persisted_good_data(self):
        _,market=fixtures();self.writer.request('pool',POOL)
        self.writer.publish(self.writer.claim('pool')[0],market)
        self.restart_at(1080);self.due('pool',POOL)
        self.provider.dex='unverified-fork'
        self.assertEqual(self.collector.tick(token_limit=0,pool_limit=1)[0]['status'],'published')
        value=self.row('pool',POOL)['payload']['market']
        self.assertEqual((value['status'],value['reason']),('rejected','provider_dex_unconfirmed'))
        self.assertIsNone(value['data'])


if __name__=='__main__':unittest.main()
