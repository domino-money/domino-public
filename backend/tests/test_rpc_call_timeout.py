"""A call a route did not answer within its own ceiling moves the read to the next route (item 4.5, 3 Nov 2026).

Each RPC call has a ceiling of its own inside its read's deadline: 8 s on the reader's transport, 12 s by default.
A call that reached it raised read_deadline_exceeded, on which no client failed over, so the read, the pass or the
head poll failed with the next route healthy and time left: 6 moments on the node's proxy and about 25 a day on
Base's and Arbitrum's first endpoint, 21 Oct to 3 Nov 2026. Now such a call is an internal RpcCallTimeout, still
read_deadline_exceeded to every caller, and the read moves on: past the own node's other route, which is the same
node; the route is held for a while; a slow log range on the own node stays where it is. Every URL is synthetic and
nothing here opens a socket.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalogue_indexer import IndexRpc
from configure_rpc import prepare_local_config, prepare_node_loopback
from discovery import CHAIN_ID, SNAPSHOT_LOOPBACK_RPC, DataError, RpcCallTimeout, rpc_http
from read_deadline import read_deadline
from rpc_failover import FailoverReadRpc, HistoricalReadRpc, ProcessRoutes
from v2_chains import load_registry
from v2_head import HeadFollower
from v2_rpc import ChainEndpoints, ChainIndexRpc, Endpoint, configured_endpoints
from v2_fixtures import FakeChain

LOOPBACK = SNAPSHOT_LOOPBACK_RPC
LOCAL = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_0123/'
ARCHIVE = 'https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC_ARCHIVE'
SECOND = 'https://secondary.example.invalid/SYNTHETIC_SECOND'
ROUTES = (LOOPBACK, LOCAL, ARCHIVE)
TOKEN = '0x' + '1' * 40
STACK, ALCHEMY = 'https://stack.example.invalid/SYNTHETIC_STACK', 'https://alchemy.example.invalid/SYNTHETIC_ALCHEMY'
BASE = load_registry().chain('base-8453')
ROBINHOOD = load_registry().chain('robinhood-4663')
WALL = 1_793_000_000
CURRENT = {'number': hex(105_106_888), 'hash': '0x' + 'c4' * 32, 'timestamp': hex(WALL - 1)}
BLOCK = {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['latest', False]}


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def header(number):
    return {'number': hex(number), 'hash': '0x' + f'{number:064x}', 'timestamp': hex(1000 + number)}


class Node:
    """V1's routes. A route in `slow` lets `seconds` pass on the clock and runs out of time on the calls of `methods`
    (all of them when empty); a route in `down` cannot be reached; every answered call takes `took` seconds."""

    def __init__(self, clock, *, slow=(), methods=(), seconds=8, took=0, down=()):
        self.clock, self.slow, self.methods, self.seconds, self.took = clock, set(slow), set(methods), seconds, took
        self.down, self.calls = set(down), []

    def one(self, call):
        method, params = call['method'], call['params']
        if method == 'eth_chainId':
            result = hex(CHAIN_ID)
        elif method == 'eth_getBlockByNumber':
            result = header(2000 if params[0] == 'latest' else int(params[0], 16))
        elif method == 'eth_getLogs':
            result = []
        else:
            result = '0x01'
        return {'jsonrpc': '2.0', 'id': call['id'], 'result': result}

    def __call__(self, url, body):
        items = body if isinstance(body, list) else [body]
        self.calls.extend((url, item['method']) for item in items)
        if url in self.slow and (not self.methods or any(item['method'] in self.methods for item in items)):
            self.clock.now += self.seconds
            raise RpcCallTimeout('read_deadline_exceeded')
        if url in self.down:
            raise DataError('network_unavailable')
        self.clock.now += self.took
        replies = [self.one(item) for item in items]
        return replies if isinstance(body, list) else replies[0]

    def asked(self):
        return [url for url, _ in self.calls]


class CallCeilingTests(unittest.TestCase):
    """rpc_http tells a call that outlived its own ceiling from a read that outlived its deadline."""

    def opener(self, clock, seconds):
        def opener(request, timeout):
            clock.now += seconds
            raise TimeoutError('timed out')
        return opener

    def test_a_call_past_its_own_ceiling_with_the_read_still_open_is_the_routes_timeout(self):
        clock = Clock()
        with read_deadline(15, clock=clock):
            with self.assertRaises(RpcCallTimeout) as raised:
                rpc_http(SECOND, BLOCK, timeout=8, opener=self.opener(clock, 8.5))
        self.assertEqual(str(raised.exception), 'read_deadline_exceeded')  # the public code is unchanged

    def test_a_read_past_its_own_deadline_stays_the_reads(self):
        clock, raised = Clock(), []
        with self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
            with read_deadline(5, clock=clock):
                try:
                    rpc_http(SECOND, BLOCK, timeout=8, opener=self.opener(clock, 6))
                except DataError as error:
                    raised.append(error)  # what the call raised, before the read's own scope refuses as well
                    raise
        self.assertIs(type(raised[0]), DataError)
        self.assertEqual(str(raised[0]), 'read_deadline_exceeded')

    def test_every_other_failure_passes_unchanged(self):
        def refused(request, timeout):
            raise ConnectionRefusedError()
        with read_deadline(15, clock=Clock()):
            with self.assertRaises(DataError) as raised:
                rpc_http(SECOND, BLOCK, timeout=8, opener=refused)
        self.assertIs(type(raised.exception), DataError)
        self.assertEqual(str(raised.exception), 'network_unavailable')


class ReadTimeoutTests(unittest.TestCase):
    """V1: the read moves on, past the node's other route; the process's next reads start past both for 15 s."""

    def setUp(self):
        self.clock = Clock()
        self.routes = ProcessRoutes(clock=self.clock)
        patcher = patch.object(FailoverReadRpc, 'routes', self.routes)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_call_the_proxy_did_not_answer_in_time_is_asked_past_the_node(self):
        node = Node(self.clock)
        rpc = FailoverReadRpc(ROUTES, transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        node.slow.add(LOOPBACK)
        before = len(node.calls)
        with self.assertLogs('rpc_failover', 'WARNING') as logged:
            self.assertEqual(rpc.request('eth_getBalance', [TOKEN, hex(2000)]), '0x01')
        self.assertEqual(node.calls[before:], [(LOOPBACK, 'eth_getBalance'), (ARCHIVE, 'eth_chainId'),
                                               (ARCHIVE, 'eth_getBlockByNumber'), (ARCHIVE, 'eth_getBalance')])
        self.assertEqual(logged.output, [
            'WARNING:rpc_failover:rpc_slow_call provider_index=0 method=eth_getBalance items=1 ms=8000 '
            'outcome=call_timeout',
            'WARNING:rpc_failover:rpc_failover provider_index=2 reason=call_timeout'])
        self.assertEqual(rpc.count, len(node.calls))
        # Its identity check that ran out of time moves it too.
        node = Node(self.clock, slow=(SECOND,))
        rpc = FailoverReadRpc((SECOND, ARCHIVE), transport=node)
        with self.assertLogs('rpc_failover', 'WARNING'):
            self.assertEqual(rpc.request('eth_getBlockByNumber', ['latest', False]), header(2000))
        self.assertEqual(node.asked(), [SECOND, ARCHIVE, ARCHIVE])

    def test_the_processs_next_reads_start_past_the_held_routes_until_the_hold_ends(self):
        node = Node(self.clock, slow=(LOOPBACK,))
        with self.assertLogs('rpc_failover', 'WARNING'):
            FailoverReadRpc(ROUTES, transport=node).request('eth_getBlockByNumber', ['latest', False])
        held_at = self.clock.now
        node.calls.clear()
        for offset, index in ((0, 2), (14.9, 2), (15, 0)):
            with self.subTest(offset=offset):
                self.clock.now = held_at + offset
                rpc = FailoverReadRpc(ROUTES, transport=node)
                self.assertEqual((rpc.index, rpc.url), (index, ROUTES[index]))
        node.slow.clear()
        self.clock.now = held_at
        with self.assertNoLogs('rpc_failover', 'WARNING'):
            FailoverReadRpc(ROUTES, transport=node).request('eth_getBlockByNumber', ['latest', False])
        self.assertEqual(node.asked(), [ARCHIVE, ARCHIVE])
        # Another route's timeout holds that route alone; with every route held a read starts at the first.
        self.routes.hold([ARCHIVE])
        self.assertEqual(FailoverReadRpc((LOCAL, ARCHIVE), transport=node).index, 0)

    def test_each_history_operation_starts_past_the_held_routes_too(self):
        node = Node(self.clock, slow=(LOOPBACK,))
        rpc = HistoricalReadRpc(ROUTES, transport=node)
        with self.assertLogs('rpc_failover', 'WARNING'):
            self.assertEqual(rpc.request('eth_getBlockByNumber', ['0x20', False]), header(0x20))
        node.calls.clear()
        with self.assertNoLogs('rpc_failover', 'WARNING'):
            self.assertEqual(rpc.request('eth_getBlockByNumber', ['0x21', False]), header(0x21))
        self.assertEqual(node.asked(), [ARCHIVE])
        self.clock.now += 15  # the hold is over: the next operation leads with the proxy again
        node.slow.clear()
        node.calls.clear()
        rpc.request('eth_getBlockByNumber', ['0x22', False])
        self.assertEqual(node.calls[-1], (LOOPBACK, 'eth_getBlockByNumber'))

    def test_a_batch_the_route_did_not_answer_in_time_is_asked_of_the_next(self):
        node = Node(self.clock)
        rpc = FailoverReadRpc(ROUTES, transport=node, batch_reads=True)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        node.slow.add(LOOPBACK)
        node.calls.clear()
        with self.assertLogs('rpc_failover', 'WARNING'):
            self.assertEqual(rpc.batch([('eth_getCode', [TOKEN, hex(2000)]), ('eth_getBalance', [TOKEN, hex(2000)])]),
                             ['0x01', '0x01'])
        self.assertEqual(node.asked(), [LOOPBACK, LOOPBACK, ARCHIVE, ARCHIVE, ARCHIVE, ARCHIVE])
        # A batch lost to the network once sent still is not replayed: its completion is unknown.
        self.clock.now += 15
        node = Node(self.clock, down=(LOOPBACK,))
        rpc = FailoverReadRpc(ROUTES, transport=node)
        node.down.clear()
        rpc.request('eth_getBlockByNumber', ['latest', False])
        node.down.add(LOOPBACK)
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            rpc.batch([('eth_getCode', [TOKEN, hex(2000)])])
        self.assertEqual(set(node.asked()), {LOOPBACK})

    def test_a_slow_log_range_on_the_own_node_stays_where_it_is(self):
        node = Node(self.clock, slow=(LOOPBACK,), methods=('eth_getLogs',))
        rpc = IndexRpc(ROUTES, transport=node)
        logs = [{'fromBlock': '0x1', 'toBlock': '0x186a0'}]
        with self.assertLogs('rpc_failover', 'WARNING') as logged, \
                self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
            rpc.request('eth_getLogs', logs)
        self.assertEqual(logged.output, ['WARNING:rpc_failover:rpc_slow_call provider_index=0 method=eth_getLogs '
                                         'items=1 ms=8000 outcome=call_timeout'])
        self.assertEqual(node.calls, [(LOOPBACK, 'eth_chainId'), (LOOPBACK, 'eth_getLogs')])
        self.assertEqual(IndexRpc(ROUTES, transport=node).index, 0)  # nothing held
        # A hosted route's slow log range moves on.
        node = Node(self.clock, slow=(SECOND,), methods=('eth_getLogs',))
        with self.assertLogs('rpc_failover', 'WARNING'):
            self.assertEqual(IndexRpc((SECOND, ARCHIVE), transport=node).request('eth_getLogs', logs), [])
        self.assertEqual(node.calls[-1], (ARCHIVE, 'eth_getLogs'))
        # So does a log read whose identity check ran out of time on the own node.
        node = Node(self.clock, slow=(LOOPBACK,), methods=('eth_chainId',))
        with self.assertLogs('rpc_failover', 'WARNING'):
            self.assertEqual(IndexRpc(ROUTES, transport=node).request('eth_getLogs', logs), [])
        self.assertEqual(node.asked(), [LOOPBACK, ARCHIVE, ARCHIVE])

    def test_a_read_that_ran_out_of_its_own_time_holds_and_moves_nothing(self):
        def opener(request, timeout):
            self.clock.now += 6
            raise TimeoutError('timed out')
        rpc = FailoverReadRpc((LOCAL, ARCHIVE), transport=lambda url, body: rpc_http(url, body, timeout=8,
                                                                                       opener=opener))
        with self.assertLogs('rpc_failover', 'WARNING') as logged, \
                self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
            with read_deadline(5, clock=self.clock):
                rpc.request('eth_getBlockByNumber', ['latest', False])
        # The slow call is told, as the read's own timeout; no failover, and no hold on the route.
        self.assertEqual(logged.output, ['WARNING:rpc_failover:rpc_slow_call provider_index=0 method=eth_chainId '
                                         'items=1 ms=6000 outcome=read_deadline_exceeded'])
        self.assertEqual((rpc.index, FailoverReadRpc((LOCAL, ARCHIVE)).index), (0, 0))

    def test_with_no_route_left_the_read_fails_with_the_same_public_code(self):
        node = Node(self.clock, slow=ROUTES)
        rpc = FailoverReadRpc(ROUTES, transport=node)
        with self.assertLogs('rpc_failover', 'WARNING'), self.assertRaises(RpcCallTimeout) as raised:
            rpc.request('eth_getBlockByNumber', ['latest', False])
        self.assertEqual((str(raised.exception), rpc.failure), ('read_deadline_exceeded', 'read_deadline_exceeded'))
        self.assertEqual(node.asked(), [LOOPBACK, ARCHIVE])

    def test_a_call_that_took_two_seconds_or_ran_out_of_time_leaves_one_line(self):
        node = Node(self.clock, took=1.99)
        rpc = FailoverReadRpc(ROUTES, transport=node, batch_reads=True)
        with self.assertNoLogs('rpc_failover', 'WARNING'):
            rpc.request('eth_getBlockByNumber', ['latest', False])
        node.took = 2
        with self.assertLogs('rpc_failover', 'WARNING') as logged:
            rpc.batch([('eth_getCode', [TOKEN, hex(2000)]), ('eth_getBalance', [TOKEN, hex(2000)])])
        self.assertEqual(logged.output, ['WARNING:rpc_failover:rpc_slow_call provider_index=0 '
                                         'method=eth_getBalance+eth_getCode items=2 ms=2000 outcome=answered'])
        node.slow, node.seconds = {LOOPBACK}, 1  # a timeout is told even when its ceiling was short
        with self.assertLogs('rpc_failover', 'WARNING') as logged:
            rpc.request('eth_getBalance', [TOKEN, hex(2000)])
        self.assertEqual(logged.output[0], 'WARNING:rpc_failover:rpc_slow_call provider_index=0 method=eth_getBalance '
                                           'items=1 ms=1000 outcome=call_timeout')
        self.assertNotIn('127.0.0.1', '\n'.join(logged.output))
        # A single-source tool's client (one URL, no route list) is told as its one route.
        node = Node(self.clock, took=2)
        with self.assertLogs('rpc_failover', 'WARNING') as logged:
            IndexRpc(SECOND, transport=node).request('eth_chainId')
        self.assertEqual(logged.output, ['WARNING:rpc_failover:rpc_slow_call provider_index=0 method=eth_chainId '
                                         'items=1 ms=2000 outcome=answered'])


class SlowChain:
    """A chain's endpoints as V2 sends to them. An endpoint in `slow` lets 12 s pass on the clock and runs out of
    time on the calls of `methods` (all when empty); every answered call takes `took` seconds."""

    def __init__(self, fake, clock):
        self.fake, self.clock, self.slow, self.methods, self.took = fake, clock, set(), set(), 0

    def __call__(self, url, body):
        items = body if isinstance(body, list) else [body]
        if url in self.slow and (not self.methods or any(item.get('method') in self.methods for item in items)):
            self.clock.now += 12
            raise RpcCallTimeout('read_deadline_exceeded')
        self.clock.now += self.took
        return self.fake(url, body)


def names(endpoints):
    return [endpoint.name for endpoint in endpoints]


class ChainTimeoutTests(unittest.TestCase):
    """V2: the endpoint is held 15 s, doubling to 120 s, and an answer ends it; the own node's two routes together."""

    def setUp(self):
        self.clock = Clock(float(WALL))

    def base(self):
        self.fake = FakeChain(8453)
        self.send = SlowChain(self.fake, self.clock)
        return ChainEndpoints(BASE, (Endpoint('stack', 'stack.example.invalid', STACK, None, 50, 10000, None),
                                     Endpoint('alchemy', 'alchemy.example.invalid', ALCHEMY, None, 50, None, None)),
                              'v2_chain_rpc_file', send=self.send, clock=self.clock)

    def robinhood(self):
        self.fake = FakeChain(4663, head=CURRENT)
        self.send = SlowChain(self.fake, self.clock)
        config = prepare_local_config({'version': 1, 'rpcUrl': ARCHIVE, 'inventoryUrl': ARCHIVE},
                                      'SYNTHETIC_LOCAL_TOKEN_0123')
        endpoints = configured_endpoints(ROBINHOOD, provider_config=prepare_node_loopback(config, True),
                                         send=self.send, clock=self.clock)
        self.assertEqual([(e.name, e.url) for e in endpoints.endpoints],
                         [('local', LOOPBACK), ('fallback-1', LOCAL), ('fallback-2', ARCHIVE)])
        return endpoints

    def test_an_endpoint_that_ran_out_of_time_is_held_15_s_doubling_to_120_and_an_answer_ends_it(self):
        endpoints = self.base()
        self.send.slow.add(STACK)
        with self.assertLogs('v2_rpc', 'WARNING') as logs:
            self.assertEqual(endpoints.read_rpc().request('eth_getBlockByNumber', ['latest', False])['number'], '0x64')
        self.assertEqual(logs.output, [
            'WARNING:v2_rpc:v2_rpc_slow_call chain=base-8453 endpoint=stack method=eth_getBlockByNumber items=1 '
            'ms=12000 outcome=call_timeout',
            'WARNING:v2_rpc:v2_rpc_failover chain=base-8453 endpoint=alchemy reason=call_timeout'])
        timed_out = self.clock.now
        for hold in (15, 30, 60, 120, 120):
            with self.subTest(hold=hold):
                self.clock.now = timed_out + hold - 0.01
                self.assertEqual(names(endpoints.usable()), ['alchemy'])
                self.clock.now = timed_out + hold  # the order is kept: back first once the hold ends
                self.assertEqual(names(endpoints.usable()), ['stack', 'alchemy'])
                with self.assertLogs('v2_rpc', 'WARNING'), self.assertRaises(RpcCallTimeout):
                    endpoints(STACK, BLOCK)
                timed_out = self.clock.now
        self.clock.now = timed_out + 120
        self.send.slow.clear()
        endpoints(STACK, BLOCK)  # an answer ends it
        self.send.slow.add(STACK)
        with self.assertLogs('v2_rpc', 'WARNING'), self.assertRaises(RpcCallTimeout):
            endpoints(STACK, BLOCK)
        self.clock.now += 15
        self.assertEqual(names(endpoints.usable()), ['stack', 'alchemy'])

    def test_the_own_node_is_held_on_both_routes_and_a_client_moves_past_both(self):
        endpoints = self.robinhood()
        self.send.slow.add(LOOPBACK)
        with self.assertLogs('v2_rpc', 'WARNING') as logs:
            endpoints.read_rpc().request('eth_getBlockByNumber', ['latest', False])
        self.assertEqual(logs.output, [
            'WARNING:v2_rpc:v2_rpc_slow_call chain=robinhood-4663 endpoint=local method=eth_getBlockByNumber items=1 '
            'ms=12000 outcome=call_timeout',
            'WARNING:v2_rpc:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-2 reason=call_timeout'])
        self.assertEqual([url for url, _, _ in self.fake.log], [ARCHIVE])
        self.assertEqual(names(endpoints.usable()), ['fallback-2'])
        self.clock.now += 15
        self.assertEqual(names(endpoints.usable()), ['local', 'fallback-1', 'fallback-2'])

    def test_a_slow_log_range_on_the_own_node_holds_nothing_and_a_hosted_one_moves_on(self):
        endpoints = self.robinhood()
        self.send.slow.add(LOOPBACK)
        self.send.methods.add('eth_getLogs')
        logs = [{'fromBlock': '0x1', 'toBlock': '0x2'}]
        with self.assertLogs('v2_rpc', 'WARNING'), self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):
            ChainIndexRpc(endpoints).request('eth_getLogs', logs)
        self.assertEqual(names(endpoints.usable()), ['local', 'fallback-1', 'fallback-2'])
        endpoints = self.base()
        self.send.slow.add(STACK)
        self.send.methods.add('eth_getLogs')
        with self.assertLogs('v2_rpc', 'WARNING'):
            self.assertEqual(ChainIndexRpc(endpoints).request('eth_getLogs', logs), [])
        self.assertEqual(names(endpoints.usable()), ['alchemy'])

    def test_a_history_operation_starts_past_an_endpoint_held_since_the_client_was_made(self):
        endpoints = self.robinhood()
        rpc = endpoints.history_rpc()
        self.send.slow.add(LOOPBACK)
        with self.assertLogs('v2_rpc', 'WARNING'):
            head = rpc.request('eth_getBlockByNumber', ['latest', False])
        self.fake.log.clear()
        with self.assertNoLogs('v2_rpc', 'WARNING'):
            self.assertEqual(rpc.request('eth_getBlockByNumber', [head['number'], False]), head)
        self.assertEqual([url for url, _, _ in self.fake.log], [ARCHIVE])

    def test_the_head_follower_asks_the_next_endpoint_after_a_call_timeout(self):
        endpoints = self.robinhood()
        self.send.slow.add(LOOPBACK)
        follower = HeadFollower(endpoints, max_age_seconds=2, clock=self.clock)
        with self.assertLogs('v2_head', 'WARNING') as logs, self.assertLogs('v2_rpc', 'WARNING') as slow:
            head = follower.head()
        self.assertEqual(slow.output, ['WARNING:v2_rpc:v2_rpc_slow_call chain=robinhood-4663 endpoint=local '
                                       'method=eth_getBlockByNumber items=1 ms=12000 outcome=call_timeout'])
        self.assertEqual((head.block.number, follower.polls, endpoints.aside()), (105_106_888, 1, ()))
        self.assertEqual(logs.output, [
            'WARNING:v2_head:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-2 reason=call_timeout'])
        self.assertEqual([url for url, _, _ in self.fake.log], [ARCHIVE])

    def test_a_call_that_took_two_seconds_leaves_one_line_with_the_endpoint_name(self):
        endpoints = self.base()
        self.send.took = 1.99
        with self.assertNoLogs('v2_rpc', 'WARNING'):
            endpoints(STACK, BLOCK)
        self.send.took = 2
        with self.assertLogs('v2_rpc', 'WARNING') as logs:
            endpoints(STACK, [BLOCK, {**BLOCK, 'id': 2, 'method': 'eth_getBalance', 'params': [TOKEN, '0x64']}])
        self.assertEqual(logs.output, ['WARNING:v2_rpc:v2_rpc_slow_call chain=base-8453 endpoint=stack '
                                       'method=eth_getBalance+eth_getBlockByNumber items=2 ms=2000 outcome=answered'])
        self.assertNotIn('SYNTHETIC', '\n'.join(logs.output))
        # A V2 client's calls are its endpoints' to tell and hold, by name, never V1's by ordinal.
        routes = ProcessRoutes(clock=self.clock)
        routes.hold([STACK])
        with patch.object(FailoverReadRpc, 'routes', routes):
            rpc = endpoints.read_rpc()
            with self.assertLogs('v2_rpc', 'WARNING'), self.assertNoLogs('rpc_failover', 'WARNING'):
                rpc.request('eth_getBlockByNumber', ['latest', False])
        self.assertEqual((rpc.index, rpc.names), (0, ('stack', 'alchemy')))


if __name__ == '__main__':
    unittest.main()
