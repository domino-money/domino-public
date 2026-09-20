"""Stored history: real PostgreSQL transactions, deterministic bounded chain."""
from decimal import Decimal
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.types.json import Jsonb

from catalogue import PgCatalogue
from catalogue_indexer import CatalogueIndexer
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, CHAIN_ID, DataError
from pool_activity import SWAP, decode_activity
from public_history import PublicHistory, aggregate, first_after, intervals, missing_range, ratios
from test_catalogue import block_hash, stored_candidate
from test_discovery import KEY, POOL
from test_pool_activity import event_log


class HistoryRpc:
    def __init__(self):
        self.head=1_000_103
        self.fork=None;self.requests=[];self.fail=None;self.after_logs=None
        self.logs=[event_log(SWAP,[-10,9,2**96,100,0,3000],number=999980),
                   event_log(SWAP,[-10,9,2*2**96,100,0,3000],number=999990),
                   event_log(SWAP,[-10,9,3*2**95,100,0,3000],number=999999)]
    @staticmethod
    def timestamp(number):return 2_000_000+number//10
    def request(self,method,params=()):
        self.requests.append((method,params))
        if method=='eth_chainId':return hex(CHAIN_ID)
        if method=='eth_getBlockByNumber':
            number=self.head if params[0]=='latest' else int(params[0],16)
            branch=int(self.fork is not None and number>=self.fork)
            return {'number':hex(number),'hash':block_hash(number,branch),'timestamp':hex(self.timestamp(number))}
        if method=='eth_getLogs':
            if self.fail:raise DataError(self.fail)
            query=params[0];low=int(query['fromBlock'],16);high=int(query['toBlock'],16)
            rows=[row for row in self.logs if low<=int(row['blockNumber'],16)<=high]
            if self.after_logs:self.after_logs()
            return rows
        raise AssertionError(method)
    def batch(self,calls):return [self.request(method,params) for method,params in calls]


class HistoryDomainTests(unittest.TestCase):
    def test_timestamp_search_uses_actual_subsecond_chain(self):
        rpc=HistoryRpc();chain=CatalogueIndexer(None,rpc)
        target=chain.block(1_000_003)
        lower=first_after(chain,target.timestamp-86400,target)
        self.assertEqual(lower,136010)
        self.assertGreater(target.number-lower,800000)
        self.assertLess(len(rpc.requests),28)

    def test_exact_decimals_and_inverse_ohlc(self):
        self.assertEqual(ratios(2**96,6,18),(Decimal('0.000000000001'),Decimal('1000000000000')))
        events=[]
        for index,sqrt in enumerate((2**96,2**97,3*2**95)):
            row=decode_activity(event_log(SWAP,[-1,1,sqrt,100,0,3000],index=index),POOL)
            row['timestamp']=12345;events.append(row)
        candles=aggregate(events,KEY[:2],(18,18))
        base=next(c for c in candles if c['currency']==KEY[0] and c['resolution']==60)
        quote=next(c for c in candles if c['currency']==KEY[1] and c['resolution']==60)
        self.assertEqual((base['open'],base['high'],base['low'],base['close']),(1,4,1,Decimal('2.25')))
        self.assertEqual((quote['open'],quote['high'],quote['low']),(1,1,Decimal('.25')))

    def test_newest_missing_range_respects_interior_gap(self):
        rows=[{'start_block':90,'end_block':100},{'start_block':1,'end_block':50}]
        self.assertEqual(missing_range(rows,1,100,100),(51,89))
        self.assertEqual(missing_range(rows,1,120,10),(111,120))
        self.assertIsNone(missing_range(rows,90,100,10))

    def test_coverage_union_does_not_fill_holes(self):
        covered,gaps=intervals([{'before_timestamp':0,'end_timestamp':10},
            {'before_timestamp':20,'end_timestamp':30}],5,35)
        self.assertEqual(covered,[{'startTimestamp':5,'endTimestamp':10},{'startTimestamp':20,'endTimestamp':30}])
        self.assertEqual(gaps,[{'startTimestamp':10,'endTimestamp':20},{'startTimestamp':30,'endTimestamp':35}])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL')
class HistoryPostgresTests(unittest.TestCase):
    settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}
    def setUp(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_public.history_jobs,domino_public.history_coverage,domino_public.history_swaps,domino_public.history_candles,domino_public.entities')
        self.catalogue=PgCatalogue(self.settings)
        self.catalogue.seed([stored_candidate()],Block(9,block_hash(9),1009))
        self.rpc=HistoryRpc();self.now=self.rpc.timestamp(self.rpc.head)
        self.writer=PublicHistory(self.catalogue,writer=True,clock=lambda:self.now)
        self.reader=PublicHistory(self.catalogue,clock=lambda:self.now)
        self.service=SimpleNamespace(_rpc=lambda transport:self.rpc,historical_rpc_url='https://historical.invalid',
                                     rpc_urls=('https://current.invalid',),rpc_url='https://current.invalid')
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            for currency in KEY[:2]:
                conn.execute("INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at) VALUES('token',%s,%s,%s)",
                             (currency,Jsonb({'asset':{'decimals':18}}),self.now))

    def due(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_public.history_jobs SET next_due=clock_timestamp()-interval '1 second'")

    def tick(self):
        with patch('public_history.IndexRpc',return_value=self.rpc) as factory:
            result=self.writer.tick(self.service,budget_seconds=20)
        if result['status']!='idle':self.assertEqual(factory.call_args.args[0],'https://historical.invalid')
        return result

    def read(self,currency=None):return self.reader.read(POOL,currency or KEY[0],86400,3600)

    def finish_day(self):
        for _ in range(12):
            self.due();result=self.tick()
            if result['status']=='current':return result
            self.assertEqual(result['status'],'indexed',result)
        self.fail('bounded day did not complete')

    def test_day_is_persisted_with_exact_headers_candles_and_no_rpc_on_read(self):
        self.assertTrue(self.reader.request(POOL,86400))
        self.assertEqual(self.read()['status'],'not_built')
        first=self.tick();self.assertEqual(first['status'],'indexed',first)
        partial=self.read();self.assertEqual(partial['status'],'partial')
        self.assertTrue(partial['gaps'])
        self.assertEqual(partial['candles'][0]['swapCount'],3)
        self.finish_day()
        calls=len(self.rpc.requests)
        result=self.read();inverse=self.read(KEY[1])
        self.assertEqual(len(self.rpc.requests),calls)
        self.assertEqual(result['status'],'available')
        self.assertEqual(result['gaps'],[])
        self.assertEqual(result['candles'][0]['high'],'4')
        self.assertEqual(inverse['candles'][0]['low'],'0.25')
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_public.history_coverage').fetchone()['n'],1)
            actual=conn.execute('SELECT timestamp FROM domino_public.history_swaps ORDER BY block_number').fetchall()
        self.assertEqual([x['timestamp'] for x in actual],[self.rpc.timestamp(n) for n in (999980,999990,999999)])
        self.due();self.assertEqual(self.tick()['status'],'current')
        self.assertEqual(self.read()['candles'][0]['swapCount'],3)

    def test_seven_days_cannot_take_a_lease_before_recent_day_completed(self):
        self.reader.request(POOL,604800)
        claim=self.writer.claim();self.assertEqual(claim['window_seconds'],86400)
        self.assertIsNone(self.writer.claim())
        with self.writer.store.connection(write=True) as conn:
            self.writer.guard(conn,claim);self.writer.finish(conn,claim,complete=True)
        self.assertEqual(self.writer.claim()['window_seconds'],604800)

    def test_expired_worker_cannot_publish_after_reclaim(self):
        self.reader.request(POOL,86400);old=self.writer.claim()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_public.history_jobs SET lease_until=clock_timestamp()-interval '1 second'")
        new=self.writer.claim();self.assertGreater(new['generation'],old['generation'])
        with self.assertRaisesRegex(DataError,'history_lease_lost'):
            self.writer.publish(old,Block(10,block_hash(10),10),Block(11,block_hash(11),11),[],[],span=1000)
        self.assertEqual(self.read()['status'],'not_built')

    def test_reorg_invalidates_candles_coverage_and_all_window_leases(self):
        self.reader.request(POOL,604800);self.tick();self.due()
        self.rpc.fork=999990
        result=self.tick();self.assertEqual(result['status'],'rewound',result)
        data=self.read();self.assertEqual(data['status'],'not_built');self.assertFalse(data['candles'])
        self.assertEqual(data['reason'],'history_snapshot_reorganized')
        with self.catalogue.connection() as conn:
            self.assertTrue(all(x['lease_token'] is None and x['completed_at'] is None for x in
                                conn.execute('SELECT * FROM domino_public.history_jobs').fetchall()))

    def test_mid_fetch_reorg_publishes_nothing(self):
        self.reader.request(POOL,86400)
        self.rpc.after_logs=lambda:setattr(self.rpc,'fork',999990)
        result=self.tick();self.assertEqual(result['reason'],'history_snapshot_reorganized')
        self.assertEqual(self.read()['status'],'not_built')

    def test_duplicate_or_wrong_event_header_cannot_claim_coverage(self):
        self.reader.request(POOL,86400)
        self.rpc.logs.append(self.rpc.logs[0])
        self.assertEqual(self.tick()['reason'],'duplicate_activity_log')
        self.rpc.logs.pop();self.rpc.logs[0]['blockHash']=block_hash(999980,1);self.due()
        self.assertEqual(self.tick()['reason'],'history_snapshot_reorganized')
        self.assertFalse(self.read()['covered'])

    def test_unknown_400_has_backoff_and_does_not_shrink_or_claim_coverage(self):
        self.reader.request(POOL,86400);self.rpc.fail='http_400'
        result=self.tick();self.assertEqual(result['reason'],'http_400');self.assertEqual(result['spanBlocks'],100000)
        self.assertEqual(self.tick()['status'],'idle')
        self.assertFalse(self.read()['covered'])

    def test_size_overflow_retries_and_persists_span(self):
        self.reader.request(POOL,86400)
        original=self.rpc.request
        def request(method,params=()):
            if method=='eth_getLogs' and int(params[0]['toBlock'],16)-int(params[0]['fromBlock'],16)>=25000:
                raise DataError('rpc_log_range_too_large')
            return original(method,params)
        self.rpc.request=request
        result=self.tick();self.assertEqual(result['status'],'indexed',result);self.assertEqual(result['spanBlocks'],25000)
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT span_blocks FROM domino_public.history_jobs').fetchone()['span_blocks'],25000)

    def test_missing_decimals_never_defaults_to_eighteen(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('DELETE FROM domino_public.entities WHERE entity_id=%s',(KEY[0],))
        self.reader.request(POOL,86400)
        self.assertEqual(self.tick()['reason'],'history_token_metadata_unavailable')
        result=self.read();self.assertEqual(result['status'],'unavailable');self.assertIsNone(result['quoteCurrency'])

    def test_reader_has_demand_permission_but_no_projection_write(self):
        self.assertTrue(self.reader.request(POOL,86400))
        with self.assertRaisesRegex(DataError,'public_data_writer_required'):self.reader.claim()
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute('DELETE FROM domino_public.history_jobs')

    def test_stale_snapshot_is_not_retimestamped_by_read(self):
        self.reader.request(POOL,86400);self.finish_day()
        observed=self.read()['snapshot'];self.now+=300
        result=self.read();self.assertEqual(result['status'],'stale');self.assertEqual(result['snapshot'],observed)

    def test_moving_head_does_not_starve_the_backfill(self):
        self.reader.request(POOL,86400)
        for _ in range(12):
            self.rpc.head+=1000;self.now=self.rpc.timestamp(self.rpc.head)
            self.due();result=self.tick()
            if result['status']=='current':break
            self.assertEqual(result['status'],'indexed',result)
        else:self.fail('a moving head starved recent history')
        self.assertFalse(self.read()['gaps'])
        old_head=self.read()['snapshot']['number']
        self.due();self.assertEqual(self.tick()['status'],'current')
        self.assertGreater(self.read()['snapshot']['number'],old_head)

    def test_changed_token_decimals_cannot_relabel_existing_candles(self):
        self.reader.request(POOL,86400);self.tick()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_public.entities SET payload=%s WHERE kind='token' AND entity_id=%s",
                         (Jsonb({'asset':{'decimals':6}}),KEY[0]))
        data=self.read();self.assertFalse(data['candles']);self.assertFalse(data['covered'])
        self.assertEqual(data['reason'],'history_token_metadata_changed')
        self.due();self.assertEqual(self.tick()['reason'],'history_token_metadata_changed')
        self.due();self.assertEqual(self.tick()['status'],'indexed')
        self.assertEqual(self.read()['candles'][0]['high'],'0.000000000004')

    def test_successful_empty_log_range_is_covered_without_invented_prices(self):
        self.rpc.logs=[];self.reader.request(POOL,86400);self.finish_day()
        result=self.read();self.assertEqual(result['status'],'available');self.assertFalse(result['candles'])
        self.assertFalse(result['gaps'])

    def test_new_publication_keeps_acquired_events_and_candles_older_than_a_month(self):
        self.reader.request(POOL,86400);self.tick()
        with self.catalogue.connection() as conn:
            swaps=conn.execute('SELECT * FROM domino_public.history_swaps ORDER BY block_number,log_index').fetchall()
            candles=conn.execute('SELECT * FROM domino_public.history_candles ORDER BY currency,resolution_seconds,start_timestamp').fetchall()
        self.assertTrue(swaps);self.assertTrue(candles)
        self.due();claim=self.writer.claim()
        self.now+=40*86400
        before=Block(2_000_000,block_hash(2_000_000),self.now-60)
        end=Block(2_000_010,block_hash(2_000_010),self.now)
        self.writer.publish(claim,before,end,[],[],span=1000,complete=True)
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT * FROM domino_public.history_swaps ORDER BY block_number,log_index').fetchall(),swaps)
            self.assertEqual(conn.execute('SELECT * FROM domino_public.history_candles ORDER BY currency,resolution_seconds,start_timestamp').fetchall(),candles)
        # A fresh reader keeps the bounded requested window; retained older
        # rows never leak into a current chart or become invented coverage.
        restarted=PublicHistory(self.catalogue,clock=lambda:self.now)
        result=restarted.read(POOL,KEY[0],86400,3600)
        self.assertEqual(result['status'],'partial')
        self.assertFalse(result['candles'])
        self.assertTrue(result['gaps'])


if __name__=='__main__':unittest.main()
