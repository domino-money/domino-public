"""A pool that is anchored but not walked, or walked a day or more behind, still serves its exact 24h window."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from eth_abi import encode
from eth_hash.auto import keccak
from fastapi.testclient import TestClient

import activity_store
from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue
from dev_postgres import ADMIN
from discovery import CHAIN_ID, KEY_TYPES, POOL_MANAGER, STATE_VIEW, Block, DataError
from pool_activity import SWAP, window_metrics
from pool_requests import PgRequests
from read_api import ReadGate, create_app
from read_contract import validate_response
from read_service import ReadService
from test_catalogue import block_hash, stored_candidate
from test_discovery import KEY, OTHER, POOL
from discovery import ZERO
from test_pool_activity import SENDER, ActivityRpc, PACKED, event_log, initial_logs

HEAD=200_000
ANCHOR=10
FIXTURES=Path(__file__).resolve().parent/'fixtures'
# PgActivity.read on production, 6 Oct 2026, read-only as domino_catalogue_reader:
# ETH/USDG 0x24107d15, walked from 1,146,712 and 78 days behind the head, and
# USDG/ORBIO 0xea9f200e, followed at the head.
BEHIND=FIXTURES/'pool-activity-eth-usdg-behind-2026-10-06.json'
CURRENT=FIXTURES/'pool-activity-usdg-orbio-2026-10-06.json'


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

    def test_a_pool_the_manager_cache_does_not_hold_is_still_served(self):
        """The creation log proves the identity the cache cannot."""
        self.register()

        class CacheMissRpc(LiveWindowRpc):
            def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
                if signature=='poolKeys(bytes25)':
                    # A cache entry that hashes to a different pool id.
                    return (ZERO,OTHER,3000,60,ZERO)
                return super().call(target,signature,inputs,values,outputs,block=block)

        self.rpc=CacheMissRpc()
        report=self.service().pool_activity(POOL)
        validate_response('pool-activity',report)
        self.assertEqual(report['mode'],'live_window_only')
        self.assertEqual(report['poolKey']['fee_pips'],KEY[2])

    def walk(self,worker,through):
        while worker.step(POOL,through=through,span=100_000)['status']!='caught_up_to_target':
            pass

    def test_a_walked_pool_still_serves_the_stored_ledger(self):
        self.register()
        worker=ActivityIndexer(PgActivity(self.catalogue),self.rpc)
        # Within the head's 24 h: block timestamps here are block numbers.
        self.walk(worker,HEAD-86_399)
        report=self.service().pool_activity(POOL)
        self.assertEqual(report['mode'],'core_pool_activity_read_only')
        self.assertEqual(report['coverage']['scope'],'since_verified_initialize')
        self.assertGreater(report['storedEventCount'],0)
        self.assertEqual(report['freshness']['status'],'stale')

    def test_a_walk_a_day_behind_is_served_live_until_it_reaches_the_heads_day(self):
        self.register()
        worker=ActivityIndexer(PgActivity(self.catalogue),self.rpc)
        self.walk(worker,11)
        behind=self.service().pool_activity(POOL)
        validate_response('pool-activity',behind)
        self.assertEqual((behind['mode'],behind['revision'],behind['storedEventCount']),('live_window_only',None,0))
        self.assertEqual((behind['coverage']['startBlock'],behind['window24h']['swapEventCount']),(ANCHOR,1))
        # The read asked the queue to walk the pool.
        self.assertEqual(self.requests.status(POOL)['reason'],'read')
        self.walk(worker,HEAD-86_400)
        self.assertEqual(self.service().pool_activity(POOL)['mode'],'live_window_only')
        self.walk(worker,HEAD-86_399)
        current=self.service().pool_activity(POOL)
        validate_response('pool-activity',current)
        self.assertEqual(current['mode'],'core_pool_activity_read_only')
        self.assertEqual(current['coverage']['indexedThrough'],HEAD-86_399)


if __name__=='__main__':unittest.main()


class LiveWindowHonestyTests(unittest.TestCase):
    """The window may only claim the span its block range actually covered."""

    def test_a_block_range_shorter_than_a_day_is_not_reported_as_a_day(self):
        # Robinhood Chain records 7 to 13 blocks a second (four dated heads in
        # reports/), so LIVE_WINDOW_SECONDS blocks reach back hours. The body
        # must say how long it covered, and must not call it the current 24h.
        from pool_activity import window_metrics
        as_of = 1_800_000_000
        covered = 9_400
        window = window_metrics([], initialized_at=as_of - 10 * 86_400, as_of=as_of,
                                window_seconds=covered, range_bounded=True)
        self.assertEqual(window['requestedSeconds'], covered)
        self.assertEqual(window['observedSeconds'], covered)
        self.assertEqual(window['fromTimestampExclusive'], as_of - covered)
        self.assertTrue(window['completeWindow'], 'the pool is older than the span read')
        usable = window['completeWindow'] and covered == 86_400
        self.assertFalse(usable, 'a partial span is never the current 24 hours')

    def test_pool_positions_refuses_a_live_window_instead_of_a_wrong_shape(self):
        # PoolPositionsResponse.coverage is ActivityCoverage: indexedThrough is
        # a required integer, scope is since_verified_initialize, and the model
        # forbids extras. A live window satisfies none of the three.
        from read_contract import ActivityCoverage
        live = {'startBlock': 10, 'indexedThrough': None, 'initializedBlock': 10,
                'initializedAt': 1_800_000_000, 'scope': 'live_window_only',
                'canonicality': 'block_hash_rechecked',
                'rpcCompleteness': 'single_provider_assumption',
                'windowStartBlock': 20, 'windowStartTimestamp': 1_800_000_100}
        with self.assertRaises(Exception):
            ActivityCoverage.model_validate(live)


def swap_log(pool_id, number, fee):
    data = encode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], [-1000, 995, 2**96, 100, 0, fee])
    return {'address': POOL_MANAGER, 'removed': False, 'topics': [SWAP, pool_id, SENDER],
            'data': '0x' + data.hex(), 'blockNumber': hex(number), 'blockHash': block_hash(number),
            'transactionHash': block_hash(number + 100_000), 'logIndex': '0x0'}


class ChainAfterRpc:
    """The chain after a stored report: its own tail block, then ten blocks a second to a later head."""
    batch_reads = False

    def __init__(self, report, *, seconds_behind, lp_fee=None):
        snap, key = report['snapshot'], report['poolKey']
        self.pool_id = report['poolId']
        self.key = (key['currency0'], key['currency1'], key['fee_pips'], key['tick_spacing'], key['hooks'])
        self.lp_fee = key['fee_pips'] if lp_fee is None else lp_fee
        self.tail = (snap['number'], snap['hash'], snap['timestamp'])
        self.head = snap['number'] + 10 * seconds_behind
        # One swap inside the head's window, none in the stored day.
        self.logs = [swap_log(self.pool_id, self.head - 50, key['fee_pips'])]

    def timestamp(self, number):
        return self.tail[2] + (number - self.tail[0]) // 10

    def request(self, method, params=()):
        if method == 'eth_chainId': return hex(CHAIN_ID)
        if method == 'eth_getCode': return '0x6000'
        if method == 'eth_getBlockByNumber':
            number = self.head if params[0] == 'latest' else int(params[0], 16)
            return {'number': hex(number), 'hash': self.tail[1] if number == self.tail[0] else block_hash(number),
                    'timestamp': hex(self.timestamp(number))}
        if method == 'eth_getLogs':
            query = params[0]
            assert query['address'] == POOL_MANAGER and query['topics'][1] == self.pool_id
            low, high = int(query['fromBlock'], 16), int(query['toBlock'], 16)
            return [item for item in self.logs if low <= int(item['blockNumber'], 16) <= high]
        raise AssertionError((method, params))

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        if signature == 'poolManager()': return (POOL_MANAGER,)
        if signature == 'poolKeys(bytes25)': return self.key
        if signature == 'getSlot0(bytes32)': return (2**96, 0, 0, self.lp_fee)
        if signature == 'getLiquidity(bytes32)': return (100,)
        if signature == 'getFeeGrowthGlobals(bytes32)': return (7, 9)
        raise AssertionError(signature)


class Asks:
    def __init__(self): self.asked = []
    def enqueue(self, pool_id, *, reason='read'): self.asked.append((pool_id, reason)); return True


class LiveWhileBehindTests(unittest.TestCase):
    """Production's real stored reports: a walk 78 days behind the head, and one at the head.

    A stored window covers the 24 h before its own tail. While that tail has
    not reached the head's 24 h, the window describes another day: 0x24107d15's
    held no swap at all, the featured pools registered by #381 would hold their
    first 100,000 blocks for days. Such a pool answers with the live window an
    unwalked registered pool gets, and the queue is asked to walk it.
    """
    def read(self, fixture, *, seconds_behind, route='pool-activity', lp_fee=None):
        stored = json.loads(fixture.read_text())
        rpc, asks = ChainAfterRpc(stored, seconds_behind=seconds_behind, lp_fee=lp_fee), Asks()
        service = ReadService(catalogue=object(), market_cache=object(), snapshot=object(), requests=asks,
                              rpc_factory=lambda: rpc, transport_factory=lambda: None,
                              clock=lambda: rpc.timestamp(rpc.head) + 5)
        def read(store, pool_id, *, include_positions=False):
            self.assertEqual(pool_id, stored['poolId'])
            return deepcopy(stored)
        app = create_app(service, gate=ReadGate(interval=0), snapshot_refresh_seconds=0)
        with patch.object(activity_store.PgActivity, 'read', read), \
                TestClient(app, base_url='http://127.0.0.1:8876') as client:
            response = client.post('/v1/read/' + route, json={'poolId': stored['poolId']})
        self.assertEqual(response.status_code, 200, response.text)
        validate_response(route, response.json())
        return response.json(), asks.asked, stored

    def test_a_walk_78_days_behind_answers_with_the_live_window(self):
        stored = json.loads(BEHIND.read_text())
        behind = 1_791_249_318 - stored['snapshot']['timestamp']  # the head on 6 Oct, ten blocks a second
        result, asked, stored = self.read(BEHIND, seconds_behind=behind)
        self.assertEqual((result['mode'], result['revision'], result['storedEventCount']), ('live_window_only', None, 0))
        self.assertEqual(result['coverage']['scope'], 'live_window_only')
        # The registration's own anchor, not anything the stored walk reached.
        self.assertEqual((result['coverage']['startBlock'], result['coverage']['initializedBlock']), (1_146_712, 1_146_712))
        self.assertEqual((result['window24h']['swapEventCount'], stored['window24h']['swapEventCount']), (1, 0))
        self.assertEqual(result['freshness']['status'], 'fresh')
        self.assertEqual(result['liquidity']['status'], 'live_state_only')
        self.assertEqual(asked, [(stored['poolId'], 'read')])

    def test_the_stored_window_answers_once_its_walk_reaches_the_heads_day(self):
        for seconds, mode in ((86_401, 'live_window_only'), (86_400, 'live_window_only'),
                              (86_399, 'core_pool_activity_read_only'), (120, 'core_pool_activity_read_only')):
            with self.subTest(seconds=seconds):
                result, asked, _ = self.read(BEHIND, seconds_behind=seconds)
                self.assertEqual(result['mode'], mode)
                self.assertEqual(len(asked), mode == 'live_window_only')
                if mode == 'core_pool_activity_read_only':
                    self.assertEqual(result['revision'], 5039)
                    self.assertEqual(result['freshness']['status'], 'stale')

    def test_a_pool_at_the_head_keeps_its_stored_window(self):
        result, asked, stored = self.read(CURRENT, seconds_behind=30)
        self.assertEqual((result['mode'], result['revision']), ('core_pool_activity_read_only', stored['revision']))
        self.assertEqual((result['freshness']['status'], result['window24h']['swapEventCount']), ('fresh', 2951))
        self.assertTrue(result['window24h']['usableAsCurrent24h'])
        self.assertEqual(asked, [])

    def test_pool_positions_keeps_the_stored_ledger_however_far_behind(self):
        result, asked, stored = self.read(BEHIND, seconds_behind=6_000_000, route='pool-positions')
        self.assertEqual(result['mode'], 'core_pool_positions_read_only')
        self.assertEqual(result['coverage']['indexedThrough'], stored['coverage']['indexedThrough'])
        self.assertEqual(asked, [])

    def test_a_live_window_that_cannot_be_built_leaves_the_stale_stored_answer(self):
        # The core's fee disagrees with the key: the live identity is refused.
        result, asked, stored = self.read(BEHIND, seconds_behind=6_000_000, lp_fee=3000)
        self.assertEqual((result['mode'], result['revision']), ('core_pool_activity_read_only', stored['revision']))
        self.assertEqual(result['freshness']['status'], 'stale')
        self.assertFalse(result['window24h']['usableAsCurrent24h'])
        self.assertEqual(asked, [(stored['poolId'], 'read')])


class JsonRpcChain:
    """A ChainAfterRpc's chain behind real JSON-RPC envelopes, for the reader's own clients.

    The fakes above forgive a refusal; production's failover client does not:
    once it refuses a range it fails every later request of that read. A log
    answer over `max_logs` is refused here as rpc_http refuses one over the
    reader's 2 MB ceiling: on 6 Oct 2026 ETH/USDG's 3,423 logs were 3,264,580
    bytes, about 953 a log, so 2 MB holds about 2,098.
    """
    OUTPUTS = {'poolManager()': ['address'], 'poolKeys(bytes25)': list(KEY_TYPES),
               'getSlot0(bytes32)': ['uint160', 'int24', 'uint24', 'uint24'],
               'getLiquidity(bytes32)': ['uint128'], 'getFeeGrowthGlobals(bytes32)': ['uint256', 'uint256']}

    def __init__(self, chain, *, max_logs):
        self.chain, self.max_logs, self.windows = chain, max_logs, []
        self.selectors = {'0x' + keccak(name.encode())[:4].hex(): name for name in self.OUTPUTS}

    def __call__(self, url, body=None):
        return [self.answer(item) for item in body] if isinstance(body, list) else self.answer(body)

    def answer(self, body):
        method, params = body['method'], body['params']
        if method == 'eth_getLogs':
            query = params[0]
            self.windows.append((int(query['fromBlock'], 16), int(query['toBlock'], 16)))
            result = self.chain.request(method, params)
            if len(result) > self.max_logs:
                raise DataError('response_too_large')
        elif method == 'eth_call':
            name = self.selectors[params[0]['data'][:10]]
            result = '0x' + encode(self.OUTPUTS[name], list(self.chain.call(params[0]['to'], name, block=params[1]))).hex()
        else:
            result = self.chain.request(method, params)
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': result}


class RefusedRangeTests(unittest.TestCase):
    """ETH/USDG on 6 Oct 2026: its live window over 3.3 MB of logs, through the reader's real clients."""
    def test_a_window_over_the_byte_ceiling_is_read_in_narrower_ranges_on_fresh_clients(self):
        stored = json.loads(BEHIND.read_text())
        chain = ChainAfterRpc(stored, seconds_behind=6_000_000)
        first = chain.head - ReadService.LIVE_WINDOW_SECONDS - ReadService.LIVE_WINDOW_BLOCK_MARGIN
        chain.logs = [swap_log(stored['poolId'], first + 25 * index, 100) for index in range(3423)]
        transport = JsonRpcChain(chain, max_logs=2098)
        service = ReadService(rpc_urls=('https://rpc.invalid',), catalogue=object(), market_cache=object(),
                              snapshot=object(), requests=Asks(), transport_factory=lambda: transport,
                              clock=lambda: chain.timestamp(chain.head) + 5)

        def read(store, pool_id, *, include_positions=False):
            return deepcopy(stored)
        app = create_app(service, gate=ReadGate(interval=0), snapshot_refresh_seconds=0)
        with patch.object(activity_store.PgActivity, 'read', read), \
                TestClient(app, base_url='http://127.0.0.1:8876') as client:
            response = client.post('/v1/read/pool-activity', json={'poolId': stored['poolId']})
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        validate_response('pool-activity', result)
        self.assertEqual(result['mode'], 'live_window_only')
        self.assertEqual(result['window24h']['swapEventCount'], 3423)
        # The state reads that follow the logs still answer.
        self.assertEqual(result['liquidity']['activeLiquidityRaw'], '100')
        # The whole range once, refused; then quarter ranges covering the same blocks.
        self.assertEqual(transport.windows[0], (first, chain.head - 1))
        self.assertEqual(transport.windows[1], (first, first + 21_629))
        self.assertTrue(all(high - low + 1 <= 21_630 for low, high in transport.windows[1:]))
        self.assertEqual((transport.windows[-1][1], len(transport.windows)), (chain.head - 1, 5))
