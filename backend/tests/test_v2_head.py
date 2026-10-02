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
from discovery import DataError
from v2_chains import load_registry
from v2_head import HeadFollower
from v2_rpc import ChainEndpoints, Endpoint
from v2_fixtures import HEAD, FakeChain

BASE = load_registry().chain('base-8453')
URL = 'https://stack.example.invalid/SYNTHETIC'
NOW = int(HEAD['timestamp'], 16) + 3


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
        self.fake.head = {**HEAD, 'number': '0x65', 'hash': '0x' + 'cd' * 32, 'timestamp': hex(NOW + 27)}
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


if __name__ == '__main__':
    unittest.main()
