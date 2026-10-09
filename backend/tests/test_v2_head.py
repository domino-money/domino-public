"""One head per chain, read once and shared: by a process's readers, and through a
shared file by every service of the host."""
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from configure_rpc import prepare_local_config, prepare_node_loopback
from discovery import SNAPSHOT_LOOPBACK_RPC, DataError
from v2_chains import load_registry
from v2_executor import OperatorRpc
from v2_head import HeadFollower
from v2_rpc import ChainEndpoints, Endpoint, configured_endpoints
from v2_fixtures import HEAD, FakeChain

BASE = load_registry().chain('base-8453')
ROBINHOOD = load_registry().chain('robinhood-4663')
URL = 'https://stack.example.invalid/SYNTHETIC'
NOW = int(HEAD['timestamp'], 16) + 3
# Robinhood's endpoints in production's order: the node's VM-local proxy, the node's public route, then Alchemy.
PROXY, NODE, ALCHEMY = (SNAPSHOT_LOOPBACK_RPC, 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_123/',
                        'https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC')
# 9 Oct 2026, 13:00:13 UTC: the node back from a hard power-off, its head 30,879 s old.
WALL = 1_791_550_813
CURRENT = {'number': hex(84_174_000), 'hash': '0x' + 'c4' * 32, 'timestamp': hex(WALL - 1)}
BEHIND = {'number': hex(83_874_932), 'hash': '0x' + '83' * 32, 'timestamp': hex(WALL - 30_879)}


class Clock:
    def __init__(self):
        self.now = float(NOW)

    def __call__(self):
        return self.now


def endpoints(fake):
    return ChainEndpoints(BASE, (Endpoint('stack', 'stack.example.invalid', URL, None, 50, 10000, None),),
                          'v2_chain_rpc_file', send=fake)


class HeadFollowerTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeChain(8453, head={**HEAD, 'baseFeePerGas': '0x5f5e100'})
        self.clock = Clock()

    def follower(self, **kwargs):
        return HeadFollower(endpoints(self.fake), max_age_seconds=2, clock=self.clock, **kwargs)

    def test_a_head_is_read_once_per_max_age(self):
        follower = self.follower()
        head = follower.head()
        self.assertEqual((head.chain_id, head.block.number, head.base_fee_per_gas, head.observed_at),
                         (8453, 100, 100_000_000, NOW))
        self.clock.now += 2
        self.assertIs(follower.head(), head)
        self.assertEqual((follower.polls, len(self.fake.log)), (1, 1))
        self.clock.now += 0.5
        self.fake.head = {**HEAD, 'number': '0x65', 'hash': '0x' + 'cd' * 32, 'timestamp': hex(NOW + 2)}
        self.assertEqual(follower.head().block.number, 101)
        self.assertEqual(follower.polls, 2)
        self.assertEqual(self.fake.calls('eth_chainId'), [])

    def test_a_stalled_or_future_head_is_unavailable(self):
        self.clock.now = NOW + 120 - 3
        self.assertEqual(self.follower().head().block.number, 100)
        self.clock.now = NOW + 121 - 3
        with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
            self.follower().head()
        self.clock.now = NOW - 3 - 16
        with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
            self.follower().head()
        follower = HeadFollower(endpoints(self.fake), max_age_seconds=20, max_block_age_seconds=30, clock=self.clock)
        self.clock.now = NOW + 22  # the block is 25 s old when read
        head = follower.head()
        self.clock.now = NOW + 28  # the read is 6 s old, but its block is now 31 s old
        with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
            follower.head()  # and the node still serves that block: stalled
        self.fake.head = {**HEAD, 'number': '0x65', 'hash': '0x' + 'cd' * 32, 'timestamp': hex(NOW + 47)}
        calls = len(self.fake.log)
        self.clock.now = NOW + 48  # the refusal holds for max_age, unasked
        with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
            follower.head()
        self.assertEqual(len(self.fake.log), calls)
        self.clock.now = NOW + 48.5
        self.assertEqual(follower.head().block.number, 101)
        self.assertEqual(head.block.number, 100)

    def test_a_lagged_head_is_the_block_that_many_below_the_latest(self):
        lagged = {'number': '0x62', 'hash': '0x' + '62' * 32, 'timestamp': hex(NOW - 1)}
        self.fake.blocks['0x62'] = lagged
        head = self.follower(lag_blocks=2).head()
        self.assertEqual((head.block.number, head.block.hash, head.base_fee_per_gas), (98, lagged['hash'], None))
        self.assertEqual([params[0] for _, _, params in self.fake.log], ['latest', '0x62'])
        self.fake.head = {**HEAD, 'number': '0x1'}
        self.fake.log.clear()
        with self.assertRaisesRegex(DataError, '^block_unavailable$'):
            self.follower(lag_blocks=2).head()
        self.assertEqual(len(self.fake.log), 1)  # no read below block zero was sent

    def test_settings_are_bounded(self):
        for options in ({'max_age_seconds': 0}, {'max_age_seconds': 601}, {'max_age_seconds': '2'},
                        {'max_age_seconds': 2, 'lag_blocks': -1}, {'max_age_seconds': 2, 'lag_blocks': 1.0},
                        {'max_age_seconds': 2, 'max_block_age_seconds': 2},
                        {'max_age_seconds': 2, 'max_block_age_seconds': 3601}):
            with self.subTest(options=options), self.assertRaisesRegex(DataError, '^invalid_v2_head_follower$'):
                HeadFollower(endpoints(self.fake), **options)
        with self.assertRaisesRegex(DataError, '^invalid_v2_head_follower$'):
            HeadFollower(object(), max_age_seconds=2)


class SharedHeadTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        self.path = self.directory / 'base-8453.head.json'
        self.fake = FakeChain(8453)
        self.clock = Clock()

    def follower(self, fake=None):
        return HeadFollower(endpoints(fake or self.fake), max_age_seconds=2, shared_path=self.path, clock=self.clock)

    def test_services_of_a_host_share_one_read(self):
        first = self.follower()
        head = first.head()
        data = json.loads(self.path.read_text())
        self.assertEqual(data, {'chainId': 8453, 'number': 100, 'hash': HEAD['hash'], 'timestamp': NOW - 3,
                                'baseFeePerGas': None, 'observedAt': NOW})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o644)
        other_fake = FakeChain(8453)
        second = self.follower(other_fake)
        self.assertEqual(second.head(), head)
        self.assertEqual((second.polls, other_fake.log), (0, []))
        self.clock.now += 3  # older than max_age: the next caller reads and shares it
        self.assertEqual(second.head().observed_at, NOW + 3)
        self.assertEqual(second.polls, 1)
        self.assertEqual(first.head().observed_at, NOW + 3)
        self.assertEqual(first.polls, 1)

    def test_concurrent_followers_read_the_head_once(self):
        class Slow(FakeChain):
            def answer(self, url, body):
                time.sleep(0.05)
                return super().answer(url, body)
        fake = Slow(8453)
        followers = [self.follower(fake) for _ in range(6)]
        threads = [threading.Thread(target=follower.head) for follower in followers]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual((sum(f.polls for f in followers), len(fake.log)), (1, 1))

    def test_a_file_that_is_not_this_chains_fresh_head_is_replaced(self):
        good = {'chainId': 8453, 'number': 90, 'hash': '0x' + '90' * 32, 'timestamp': NOW - 5,
                'baseFeePerGas': 7, 'observedAt': NOW}
        cases = {'another chain': {**good, 'chainId': 42161}, 'missing key': {k: v for k, v in good.items()
                                                                             if k != 'observedAt'},
                 'extra key': {**good, 'url': 'x'}, 'text number': {**good, 'number': '90'},
                 'boolean fee': {**good, 'baseFeePerGas': True}, 'bad hash': {**good, 'hash': '0x12'},
                 'from the future': {**good, 'observedAt': NOW + 60}, 'old read': {**good, 'observedAt': NOW - 3},
                 'stalled block': {**good, 'timestamp': NOW - 121}}
        for name, data in cases.items():
            with self.subTest(case=name):
                self.path.write_text(json.dumps(data))
                follower = self.follower()
                self.assertEqual(follower.head().block.number, 100)
                self.assertEqual(follower.polls, 1)
        for raw in ('{', '', json.dumps(good) + ' ' * 5000):
            self.path.write_text(raw)
            follower = self.follower()
            self.assertEqual((follower.head().block.number, follower.polls), (100, 1))
        self.path.write_text(json.dumps(good))
        follower = self.follower()
        self.assertEqual((follower.head().block.number, follower.head().base_fee_per_gas, follower.polls), (90, 7, 0))

    def test_no_temporary_file_is_left_behind(self):
        self.follower().head()
        self.assertEqual(sorted(os.listdir(self.directory)), ['base-8453.head.json', 'base-8453.head.json.lock'])


class Nodes(FakeChain):
    """One chain through several endpoints, each at its own head."""

    def __init__(self, heads):
        super().__init__(4663)
        self.heads = dict(heads)

    def answer(self, url, body):
        self.head = self.heads[url]
        return super().answer(url, body)

    def urls(self):
        return [url for url, _, _ in self.log]


def robinhood(fake, clock):
    config = prepare_local_config({'version': 1, 'rpcUrl': ALCHEMY, 'inventoryUrl': ALCHEMY},
                                  'SYNTHETIC_LOCAL_TOKEN_123')
    endpoints = configured_endpoints(ROBINHOOD, provider_config=prepare_node_loopback(config, True), send=fake,
                                     clock=clock)
    assert [(e.name, e.url) for e in endpoints.endpoints] == [('local', PROXY), ('fallback-1', NODE),
                                                              ('fallback-2', ALCHEMY)]
    return endpoints


def names(endpoints):
    return [endpoint.name for endpoint in endpoints]


class SetAsideTests(unittest.TestCase):
    """An endpoint answering a head outside the window is set aside and the next current one serves: the pass runs
    where its head came from, instead of refusing every head while the node catches up (9 Oct 2026)."""

    def setUp(self):
        self.clock = Clock()
        self.clock.now = float(WALL)

    def follower(self, heads, **kwargs):
        self.fake = Nodes(heads)
        self.endpoints = robinhood(self.fake, self.clock)
        return HeadFollower(self.endpoints, **{'max_age_seconds': 2, **kwargs}, clock=self.clock)

    def test_a_node_far_behind_is_set_aside_and_the_next_current_endpoint_serves(self):
        follower = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT})
        with self.assertLogs('v2_head', 'WARNING') as logs:
            head = follower.head()
        self.assertEqual((head.block.number, head.observed_at, follower.polls), (84_174_000, WALL, 1))
        self.assertEqual(self.fake.urls(), [PROXY, NODE, ALCHEMY])
        self.assertEqual(logs.output, [
            'WARNING:v2_head:v2_head_set_aside chain=robinhood-4663 endpoint=local head_age_seconds=30879',
            'WARNING:v2_head:v2_head_set_aside chain=robinhood-4663 endpoint=fallback-1 head_age_seconds=30879'])
        self.assertEqual(names(self.endpoints.aside()), ['local', 'fallback-1'])
        # Every client of the pass reads, presimulates and sends where the head came from.
        self.fake.log.clear()
        rpc = self.endpoints.read_rpc(anchor=head.block)
        rpc.request('eth_getCode', ['0x' + '11' * 20, head.block.tag])
        self.assertEqual((rpc.names, self.endpoints.history_rpc().names), (('fallback-2',), ('fallback-2',)))
        OperatorRpc(self.endpoints).block(head.block.tag)
        self.assertEqual(self.fake.urls(), [ALCHEMY, ALCHEMY])

    def test_a_head_ahead_of_this_clock_is_set_aside_too(self):
        ahead = {**CURRENT, 'timestamp': hex(WALL + 16)}
        follower = self.follower({PROXY: ahead, NODE: CURRENT, ALCHEMY: CURRENT})
        with self.assertLogs('v2_head', 'WARNING') as logs:
            self.assertEqual(follower.head().block.number, 84_174_000)
        self.assertEqual((self.fake.urls(), names(self.endpoints.aside())), ([PROXY, NODE], ['local']))
        self.assertEqual(logs.output, ['WARNING:v2_head:v2_head_set_aside chain=robinhood-4663 endpoint=local '
                                       'head_age_seconds=-16'])
        for edge in (15, -120):  # the window's edges are current
            with self.subTest(edge=edge):
                follower = self.follower({PROXY: {**CURRENT, 'timestamp': hex(WALL + edge)}, NODE: BEHIND,
                                          ALCHEMY: BEHIND})
                follower.head()
                self.assertEqual((self.fake.urls(), self.endpoints.aside()), ([PROXY], ()))

    def test_a_set_aside_endpoint_is_asked_first_again_and_taken_back_once_current(self):
        follower = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT})
        follower.head()
        self.clock.now += 3
        self.fake.log.clear()
        with self.assertNoLogs('v2_head', 'WARNING'):
            follower.head()  # still behind: asked again and passed over, nothing new to say
        self.assertEqual((self.fake.urls(), names(self.endpoints.aside())), ([PROXY, NODE, ALCHEMY],
                                                                            ['local', 'fallback-1']))
        # The node caught up: its proxy is taken back, and its public route keeps its standing until a poll reaches it.
        caught_up = {**CURRENT, 'number': hex(84_173_000), 'timestamp': hex(WALL - 97)}
        self.fake.heads.update({PROXY: caught_up, NODE: caught_up})
        self.clock.now += 3
        self.fake.log.clear()
        with self.assertLogs('v2_head', 'WARNING') as logs:
            self.assertEqual(follower.head().block.number, 84_173_000)
        self.assertEqual(self.fake.urls(), [PROXY])
        self.assertEqual(logs.output, ['WARNING:v2_head:v2_head_taken_back chain=robinhood-4663 endpoint=local'])
        self.assertEqual((names(self.endpoints.aside()), self.endpoints.read_rpc().names),
                         (['fallback-1'], ('local', 'fallback-2')))
        self.fake.fail[(PROXY, 'eth_getBlockByNumber')] = 'network_unavailable'
        self.clock.now += 3
        self.fake.log.clear()
        with self.assertLogs('v2_head', 'WARNING') as logs:
            follower.head()
        self.assertEqual(self.fake.urls(), [PROXY, NODE])
        self.assertEqual(logs.output, [
            'WARNING:v2_head:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-1 reason=network_unavailable',
            'WARNING:v2_head:v2_head_taken_back chain=robinhood-4663 endpoint=fallback-1'])
        self.assertEqual(self.endpoints.aside(), ())

    def test_with_no_current_head_anywhere_the_refusal_holds_for_max_age(self):
        follower = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: {**CURRENT, 'timestamp': hex(WALL - 200)}})
        for _ in range(2):
            with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
                follower.head()
        self.assertEqual((len(self.fake.log), self.endpoints.aside()), (3, ()))  # one round; nothing set aside
        for offset, calls in ((2, 3), (2.5, 6), (2.5 - 5, 6), (2.5 - 6, 9)):
            with self.subTest(offset=offset):
                self.clock.now = WALL + offset  # held for max_age; a clock set back more than 5 s asks again
                with self.assertRaisesRegex(DataError, '^stale_or_future_block$'):
                    follower.head()
                self.assertEqual(len(self.fake.log), calls)
        # A current head anywhere ends it once the refusal is over.
        self.fake.heads[ALCHEMY] = CURRENT
        self.clock.now = WALL + 2.5 - 6 + 2.5
        self.assertEqual(follower.head().block.number, 84_174_000)

    def test_a_transport_failure_fails_over_as_before_and_sets_nothing_aside(self):
        follower = self.follower({PROXY: CURRENT, NODE: CURRENT, ALCHEMY: CURRENT}, max_age_seconds=0.25)
        self.fake.fail[(PROXY, 'eth_getBlockByNumber')] = 'network_unavailable'
        with self.assertLogs('v2_head', 'WARNING') as logs:
            follower.head()
        self.assertEqual((self.fake.urls(), self.endpoints.aside()), ([PROXY, NODE], ()))
        self.assertEqual(logs.output, ['WARNING:v2_head:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-1 '
                                       'reason=network_unavailable'])
        self.clock.now += 0.5  # the proxy cools down for 1 s: not asked
        self.fake.log.clear()
        follower.head()
        self.assertEqual(self.fake.urls(), [NODE])
        for url in (NODE, ALCHEMY):
            self.fake.fail[(url, 'eth_getBlockByNumber')] = 'http_502'
        self.clock.now += 1
        self.fake.log.clear()
        with self.assertLogs('v2_head', 'WARNING') as logs, self.assertRaisesRegex(DataError, '^http_502$'):
            follower.head()  # every endpoint failed: the last failure, and no refusal held
        self.assertEqual(self.fake.urls(), [PROXY, NODE, ALCHEMY])
        self.assertEqual(logs.output, [
            'WARNING:v2_head:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-1 reason=network_unavailable',
            'WARNING:v2_head:v2_rpc_failover chain=robinhood-4663 endpoint=fallback-2 reason=http_502'])
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoints_cooling$'):
            follower.head()

    def test_any_other_refusal_is_raised_as_before(self):
        follower = self.follower({PROXY: CURRENT, NODE: CURRENT, ALCHEMY: CURRENT})
        self.fake.fail[(PROXY, 'eth_getBlockByNumber')] = 'invalid_json'
        with self.assertRaisesRegex(DataError, '^invalid_json$'):
            follower.head()
        self.assertEqual((self.fake.urls(), self.endpoints.aside()), ([PROXY], ()))

    def test_a_lagged_head_is_read_where_the_latest_was(self):
        lagged = {**CURRENT, 'number': hex(84_173_998), 'hash': '0x' + '98' * 32}
        follower = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT}, lag_blocks=2)
        self.fake.blocks[hex(83_874_930)] = {**BEHIND, 'number': hex(83_874_930), 'hash': '0x' + '82' * 32}
        self.fake.blocks[hex(84_173_998)] = lagged
        self.assertEqual(follower.head().block.hash, lagged['hash'])
        self.assertEqual([(url, params[0]) for url, _, params in self.fake.log],
                         [(PROXY, 'latest'), (PROXY, hex(83_874_930)), (NODE, 'latest'), (NODE, hex(83_874_930)),
                          (ALCHEMY, 'latest'), (ALCHEMY, hex(84_173_998))])


class SharedSetAsideTests(unittest.TestCase):
    """A head read past a set-aside endpoint stays in its process: another process's clients would read it at an
    endpoint that does not have it. A process passing over one reads the head itself until it takes it back."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        self.path = self.directory / 'robinhood-4663.head.json'
        self.clock = Clock()
        self.clock.now = float(WALL)

    def follower(self, heads):
        fake = Nodes(heads)
        return HeadFollower(robinhood(fake, self.clock), max_age_seconds=2, shared_path=self.path,
                            clock=self.clock), fake

    def test_a_head_read_past_a_set_aside_endpoint_is_not_shared(self):
        first, _ = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT})
        self.assertEqual(first.head().block.number, 84_174_000)
        self.assertFalse(self.path.exists())
        second, fake = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT})
        self.assertEqual(second.head().block.number, 84_174_000)
        self.assertEqual((fake.urls(), names(second.endpoints.aside())), ([PROXY, NODE, ALCHEMY],
                                                                          ['local', 'fallback-1']))

    def test_a_process_passing_over_an_endpoint_reads_the_head_itself(self):
        caught_up = {**CURRENT, 'timestamp': hex(WALL + 2)}
        first, fake = self.follower({PROXY: BEHIND, NODE: BEHIND, ALCHEMY: CURRENT})
        first.head()
        self.clock.now += 3
        other, _ = self.follower({PROXY: caught_up, NODE: caught_up, ALCHEMY: caught_up})
        other.head()  # another process's head, read at the node: shared
        self.assertEqual(json.loads(self.path.read_text())['observedAt'], WALL + 3)
        fake.heads.update({PROXY: caught_up, NODE: caught_up})
        fake.log.clear()
        first.head()  # this one passes over the node: it asks the node itself and takes it back
        self.assertEqual((fake.urls(), first.polls, names(first.endpoints.aside())), ([PROXY], 2, ['fallback-1']))
        self.clock.now += 3
        other.head()
        fake.log.clear()
        self.assertEqual(first.head().observed_at, WALL + 6)  # it no longer passes over one: the shared head
        self.assertEqual((fake.urls(), first.polls), ([], 2))


if __name__ == '__main__':
    unittest.main()
