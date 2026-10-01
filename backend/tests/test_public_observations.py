import copy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import ValidationError

from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET, create_database
from discovery import DataError, KEY_TYPES
from market_cache import MarketCache
from public_data_contract import validate_response, validate_request_response, RatioCandle
from public_data_service import PublicDataService
from public_observations import PgPublicData, aged_market, PROVIDER_CALLS_PER_MINUTE
from read_service import ReadService
from read_api import ReadGate
from test_discovery import FakeRpc, KEY, TOKEN, ZERO, POOL
from test_pool_market import Provider


def fixtures():
    provider = Provider()
    service = ReadService(rpc_factory=FakeRpc,clock=lambda:1010,
                          market_cache=MarketCache(provider,clock=lambda:1010))
    return service.token(TOKEN),service.pool_market(POOL)


def another_market(original,index):
    result = copy.deepcopy(original)
    key = (*KEY[:2],500+index,*KEY[3:])
    pool_id = '0x'+keccak(encode(KEY_TYPES,key)).hex()
    result['poolId']=result['pool']['poolId']=result['market']['data']['poolId']=pool_id
    result['pool']['poolKey']['fee_pips']=result['pool']['currentLpFeePips']=500+index
    result['market']['data']['sourceUrl']='https://www.geckoterminal.com/robinhood/pools/'+pool_id
    return result


class PublicContractTests(unittest.TestCase):
    def test_stored_capacity_is_bounded_without_provider_pacing(self):
        gate=ReadGate(clock=lambda:100,stored_capacity=4,stored_interval=0)
        self.assertTrue(gate.enter(gate.PROVIDER))
        self.assertTrue(all(gate.enter(gate.STORED) for _ in range(4)))
        self.assertFalse(gate.enter(gate.STORED))
        gate.leave(gate.STORED)
        self.assertTrue(gate.enter(gate.STORED))
        self.assertIsNotNone(gate.held[gate.STORED])
        for _ in range(4):gate.leave(gate.STORED)
        self.assertIsNone(gate.held[gate.STORED])
        self.assertEqual(gate.stored_inflight,0)
        self.assertFalse(gate.enter(gate.PROVIDER))
        gate.leave(gate.PROVIDER)
        self.assertFalse(gate.enter(gate.PROVIDER))

    def test_aged_market_preserves_source_time_and_expires_estimates(self):
        _,market=fixtures()
        aged=aged_market(market,1010,1311)
        self.assertEqual(aged['snapshot'],market['snapshot'])
        self.assertEqual(aged['market']['status'],'unavailable')
        self.assertIsNone(aged['market']['data'])
        self.assertEqual(aged['market']['cache']['ageSeconds'],301)
        self.assertEqual(market['market']['cache']['ageSeconds'],0)

    def test_candles_reject_inverted_or_zero_prices(self):
        candle=dict(startTimestamp=0,open='2',high='3',low='1',close='2.5',swapCount=1,complete=True)
        RatioCandle.model_validate(candle)
        for change in ({'low':'4'},{'high':'1'},{'open':'0'},{'close':'4'},{'low':'0'}):
            with self.subTest(change=change),self.assertRaises(ValidationError):
                RatioCandle.model_validate({**candle,**change})


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class PublicObservationStorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_restore_tests'}
        create_database(cls.settings['dbname'])

    def setUp(self):
        self.catalogue=PgCatalogue(self.settings)
        self.writer=PgPublicData(self.catalogue,writer=True,clock=lambda:1010)
        self.reader=PgPublicData(self.catalogue,clock=lambda:1010)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_public.entities,domino_public.token_pools,domino_public.provider_requests')
            conn.execute('UPDATE domino_public.state SET revision=0')
        self.token,self.market=fixtures()
        self.service=PublicDataService(self.reader,clock=lambda:1010,history_store=Mock())

    def publish_token(self):
        self.reader.request('token',TOKEN)
        claim=self.writer.claim('token')[0]
        self.writer.publish(claim,self.token,delay=300)

    def publish_market(self,market=None):
        market=market or self.market
        self.reader.request('pool',market['poolId'])
        claims=self.writer.claim('pool',limit=24)
        claim=next(x for x in claims if x['entity_id']==market['poolId'])
        self.writer.publish(claim,market,delay=120)

    def test_duplicate_interest_is_one_job_and_reader_cannot_publish(self):
        self.assertTrue(self.reader.request('token',TOKEN))
        self.assertTrue(self.reader.request('token',TOKEN.upper().replace('0X','0x')))
        claims=self.writer.claim('token',limit=24)
        self.assertEqual(len(claims),1)
        self.assertEqual(self.writer.claim('token'),[])
        with self.assertRaisesRegex(DataError,'public_data_writer_required'):
            self.reader.publish(claims[0],self.token)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
                conn.execute("UPDATE domino_public.entities SET status='ready'")

    def test_expired_claim_cannot_overwrite_new_publication(self):
        self.reader.request('token',TOKEN)
        old=self.writer.claim('token')[0]
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET lease_until=clock_timestamp()-interval '1 second'")
        new=self.writer.claim('token')[0]
        self.assertGreater(new['generation'],old['generation'])
        self.writer.publish(new,self.token)
        with self.assertRaisesRegex(DataError,'public_data_lease_lost'):
            self.writer.publish(old,{**self.token,'asset':{**self.token['asset'],'symbol':'OLD'}})
        self.assertEqual(self.reader.get('token',TOKEN)['payload'],self.token)

    def test_restart_and_more_than_twenty_four_pools_preserve_data_and_pagination(self):
        self.publish_token()
        for index in range(32):
            self.publish_market(another_market(self.market,index))
        restarted=PgPublicData(PgCatalogue(self.settings))
        first=restarted.overview(token=TOKEN,limit=24)
        self.assertEqual(len(first['pools']),24)
        self.assertTrue(first['hasMore'])
        second=restarted.overview(token=TOKEN,limit=24,after=first['nextAfter'],revision=first['revision'])
        self.assertEqual(len(second['pools']),8)
        self.assertFalse(second['hasMore'])
        self.assertEqual(len(set(first['poolIds']+second['poolIds'])),32)
        first_value=first['pools'][0]
        self.assertEqual(first_value['observed_at'],1010)
        self.assertEqual(restarted.get('pool',first_value['entity_id'])['payload'],first_value['payload'])

    def test_overview_is_stored_and_reuses_validated_apr_metadata(self):
        self.publish_token();self.publish_market()
        response=self.service.overview(poolIds=[POOL])
        validate_request_response('overview',{'poolIds':[POOL]},response)
        self.assertTrue(response['acquisitionAccepted'])
        self.assertEqual(response['pools'][0]['value']['market']['snapshot'],self.market['snapshot'])
        token=next(item for item in response['tokens'] if item['address']==TOKEN)
        self.assertEqual(token['value']['asset']['address'],TOKEN)
        self.service.clock=lambda:1311
        old=self.service.overview(poolIds=[POOL])
        self.assertNotEqual(old['pools'][0]['value']['estimate']['status'],'available')
        self.assertEqual(old['pools'][0]['observedAt'],1010)
        with self.assertRaises(ValueError):
            validate_request_response('overview',{'poolIds':['0x'+'ab'*32]},response)

    def test_unknown_address_has_truthful_pending_durable_admission(self):
        response=self.service.overview(token=TOKEN)
        self.assertTrue(response['acquisitionAccepted'])
        self.assertIsNone(response['tokens'][0]['value'])
        self.assertEqual(response['tokens'][0]['acquisition']['status'],'pending')
        self.assertEqual(response['pools'],[])
        self.assertFalse(response['completeHistory'])
        self.assertEqual(len(self.writer.claim('token')),1)

    def test_symbol_search_never_fabricates_unknown_identity(self):
        self.publish_token()
        response=self.service.search(query=self.token['asset']['symbol'])
        self.assertEqual([x['address'] for x in response['tokens']],[TOKEN])
        self.assertEqual(self.service.search(query='not-a-known-symbol')['tokens'],[])
        with self.assertRaises(ValidationError):
            validate_response('search',{**response,'tokens':response['tokens']*2})

    def test_shared_provider_budget_applies_across_repository_instances(self):
        self.assertTrue(all(self.writer.reserve_provider() for _ in range(PROVIDER_CALLS_PER_MINUTE-1)))
        self.assertTrue(self.reader.reserve_provider())
        self.assertFalse(PgPublicData(self.catalogue).reserve_provider())

    def test_a_deferred_reservation_leaves_the_minute_s_last_calls_to_higher_priorities(self):
        # 047: eight a minute. An idle refresh leaves three, the featured listing two.
        self.assertTrue(all(self.writer.reserve_provider_if_headroom(3) for _ in range(PROVIDER_CALLS_PER_MINUTE-3)))
        self.assertFalse(self.writer.reserve_provider_if_headroom(3))
        self.assertTrue(self.writer.reserve_provider_if_headroom(2))
        self.assertFalse(self.writer.reserve_provider_if_headroom(2))
        self.assertTrue(self.reader.reserve_provider())
        self.assertTrue(self.writer.reserve_provider())
        self.assertFalse(self.writer.reserve_provider())
        self.assertFalse(self.writer.reserve_provider_if_headroom(0))

    def test_only_the_writer_defers_and_nonsense_headroom_reserves_nothing(self):
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn,\
             self.assertRaises(psycopg.errors.InsufficientPrivilege):
            conn.execute('SELECT domino_public.reserve_provider_if_headroom(0)')
        with psycopg.connect(**self.settings,user='domino_catalogue_writer') as conn:
            for value in (None,-1,25,26):
                with self.subTest(value=value):
                    self.assertFalse(conn.execute('SELECT domino_public.reserve_provider_if_headroom(%s)',
                                                  (value,)).fetchone()[0])
        for value in (-1,25,True,'2',2.0):
            with self.subTest(value=value),self.assertRaisesRegex(DataError,'invalid_request'):
                self.writer.reserve_provider_if_headroom(value)
        with self.assertRaisesRegex(DataError,'public_data_writer_required'):
            self.reader.reserve_provider_if_headroom(0)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_public.provider_requests').fetchone()[0],0)

    def test_first_token_failure_is_retryable_and_retains_last_good_value(self):
        self.reader.request('token',TOKEN)
        claim=self.writer.claim('token')[0]
        self.writer.fail(claim,'network_unavailable',delay=1)
        row=self.reader.get('token',TOKEN)
        self.assertEqual(row['status'],'pending')
        self.assertIsNone(row['payload'])
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET next_due=clock_timestamp()-interval '1 second'")
        claim=self.writer.claim('token')[0]
        self.writer.publish(claim,self.token,delay=1)
        with self.writer.connection(write=True) as conn:
            conn.execute("UPDATE domino_public.entities SET next_due=clock_timestamp()-interval '1 second'")
        claim=self.writer.claim('token')[0]
        self.writer.fail(claim,'network_unavailable')
        self.assertEqual(self.reader.get('token',TOKEN)['payload'],self.token)

    def test_snapshot_import_preserves_age_and_does_not_overwrite_active_claim(self):
        self.assertTrue(self.writer.import_market(self.market,900))
        self.assertFalse(self.writer.import_market(self.market,899))
        self.assertEqual(self.reader.get('pool',POOL)['observed_at'],900)
        claim=self.writer.claim('pool')[0]
        self.assertFalse(self.writer.import_market(self.market,950))
        self.writer.publish(claim,self.market)
        self.assertEqual(self.reader.get('pool',POOL)['observed_at'],1010)


if __name__=='__main__':
    unittest.main()
