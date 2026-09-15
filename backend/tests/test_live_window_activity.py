"""A pool that is anchored but not walked still serves its exact 24h window."""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg

from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue
from dev_postgres import ADMIN
from discovery import CHAIN_ID, POOL_MANAGER, STATE_VIEW, Block, DataError
from pool_activity import SWAP, window_metrics
from pool_requests import PgRequests
from read_contract import validate_response
from read_service import ReadService
from test_catalogue import block_hash, stored_candidate
from test_discovery import KEY, POOL
from test_pool_activity import ActivityRpc, PACKED, event_log, initial_logs

HEAD=200_000
ANCHOR=10


class LiveWindowRpc(ActivityRpc):
    """Core state, the manager's key cache and the pool's own window logs."""
    def __init__(self):
        super().__init__()
        self.logs=initial_logs()
        # One swap inside the window, one donation; nothing outside it.
        self.logs.append(event_log(SWAP,[-1000,995,2**96,100,0,3997],number=HEAD-50))

    def request(self,method,params=()):
        if method=='eth_getBlockByNumber':
            number=HEAD if params[0]=='latest' else int(params[0],16)
            # Timestamps equal block numbers so the head matches the injected
            # clock and the window's lower bound stays a real block age.
            return {'number':hex(number),'hash':block_hash(number),'timestamp':hex(number)}
        if method=='eth_getLogs':
            query=params[0]
            low,high=int(query['fromBlock'],16),int(query['toBlock'],16)
            return [item for item in self.logs
                    if low<=int(item['blockNumber'],16)<=high
                    and (isinstance(query['topics'][0],list) or item['topics'][0]==query['topics'][0])]
        return super().request(method,params)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        # `snapshot()` proves each deployed contract links to the PoolManager.
        if signature=='poolManager()':return (POOL_MANAGER,)
        if signature=='poolKeys(bytes25)':return KEY
        if signature=='getSlot0(bytes32)':return (2**96,0,PACKED,3000)
        if signature=='getLiquidity(bytes32)':return (100,)
        if signature=='getFeeGrowthGlobals(bytes32)':return (123456789012345678901234567890,0)
        raise AssertionError(signature)


class WindowRangeTests(unittest.TestCase):
    def test_range_bounded_events_need_no_timestamp_of_their_own(self):
        events=[{'kind':'swap','payload':{'amount0':'-1000','amount1':'995','swapFeePips':3997}},
                {'kind':'donate','payload':{'amount0':'7','amount1':'9'}}]
        result=window_metrics(events,initialized_at=1,as_of=90000,range_bounded=True)
        self.assertEqual((result['swapEventCount'],result['donations']['count']),(1,1))
        self.assertEqual([leg['absoluteTurnover'] for leg in result['swapLegsRaw']],['1000','995'])
        self.assertTrue(result['completeWindow'])

    def test_the_default_path_still_filters_by_event_time(self):
        events=[{'timestamp':5,'kind':'swap','payload':{'amount0':'-1000','amount1':'995','swapFeePips':3997}}]
        self.assertEqual(window_metrics(events,initialized_at=1,as_of=90000)['swapEventCount'],0)
        self.assertEqual(window_metrics(events,initialized_at=1,as_of=90000,
                                        range_bounded=False)['swapEventCount'],0)

    def test_only_a_boolean_range_bound_is_accepted(self):
        for value in (1,'yes',None):
            with self.subTest(value=value), self.assertRaises(DataError):
                window_metrics([],initialized_at=1,as_of=100,range_bounded=value)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class LiveWindowServeTests(unittest.TestCase):
    def setUp(self):
        from dev_postgres import PORT, SOCKET
        self.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue'}
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pools CASCADE')
            conn.execute('TRUNCATE domino_activity.pool_requests')
            conn.execute('TRUNCATE domino_catalogue.events,domino_catalogue.hints,domino_catalogue.chunks')
            conn.execute('UPDATE domino_catalogue.state SET start_block=NULL,next_block=NULL,'
                         'base_hash=NULL,revision=0')
        self.catalogue=PgCatalogue(self.settings)
        self.catalogue.seed([stored_candidate()],Block(9,block_hash(9),1009))
        self.rpc=LiveWindowRpc()
        self.requests=PgRequests(self.catalogue)

    def service(self):
        return ReadService(rpc_urls=('https://rpc.invalid',),catalogue=self.catalogue,
                           requests=self.requests,rpc_factory=lambda:self.rpc,clock=lambda:HEAD)

    def register(self):
        ActivityIndexer(PgActivity(self.catalogue),self.rpc).register(POOL,ANCHOR)

    def test_an_anchored_but_unwalked_pool_serves_its_window_and_validates(self):
        self.register()
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_activity.chunks').fetchone()['n'],0)
        report=self.service().pool_activity(POOL)
        validate_response('pool-activity',report)
        self.assertEqual(report['mode'],'live_window_only')
        self.assertIsNone(report['revision'])
        self.assertEqual(report['storedEventCount'],0)
        self.assertEqual(report['coverage']['scope'],'live_window_only')
        self.assertIsNone(report['coverage']['indexedThrough'])
        self.assertEqual(report['coverage']['initializedBlock'],ANCHOR)
        self.assertEqual(report['liquidity']['status'],'live_state_only')
        self.assertIsNone(report['liquidity']['rangeCount'])
        self.assertEqual(report['liquidity']['activeLiquidityRaw'],'100')
        self.assertEqual(report['fees']['accounting']['reason'],'fee_ledger_not_caught_up')
        self.assertEqual(report['window24h']['swapEventCount'],1)
        self.assertTrue(report['window24h']['completeWindow'])
        self.assertEqual(report['snapshot']['activeLiquidityRaw'],'100')
        # The pool is not registered twice and the ask is idempotent.
        self.assertEqual(self.requests.status(POOL)['status'],'queued')

    def test_an_unknown_pool_keeps_todays_answer_and_is_queued(self):
        with self.assertRaisesRegex(DataError,'activity_pool_not_registered'):
            self.service().pool_activity(POOL)
        self.assertEqual(self.requests.status(POOL)['status'],'queued')

    def test_a_walked_pool_still_serves_the_stored_ledger(self):
        self.register()
        worker=ActivityIndexer(PgActivity(self.catalogue),self.rpc)
        worker.step(POOL,through=11)
        report=self.service().pool_activity(POOL)
        self.assertEqual(report['mode'],'core_pool_activity_read_only')
        self.assertEqual(report['coverage']['scope'],'since_verified_initialize')
        self.assertGreater(report['storedEventCount'],0)


if __name__=='__main__':unittest.main()
