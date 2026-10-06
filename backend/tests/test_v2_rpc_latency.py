"""v2_rpc_latency: each endpoint measured on new and on kept connections, the chain-pools survey timed after its head,
and never a URL in the report."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import v2_rpc_latency as latency  # noqa: E402
from discovery import ZERO, DataError  # noqa: E402
from test_v2_chain_reads import BASE, BLOCK, USDC, FakeChain, band_answers, feed_answers, v4_answers  # noqa: E402
from v2_uniswap import PoolRef  # noqa: E402
from v4_math import sqrt_at_tick  # noqa: E402

SECRET = 'k3y-not-to-print'
# USDC, Base's stable, at about US$ 1 against ETH at US$ 4,000; one tick its walk crosses, so the survey takes 3 calls.
POOL, TICK = PoolRef(4, ZERO, USDC, 500, 10), -193_380
ANSWERS = {**v4_answers(POOL, sqrt_at_tick(TICK), TICK, 10**18), **feed_answers(),
           **band_answers(BASE, POOL, sqrt_at_tick(TICK), TICK, USDC, {TICK + 20: 10**15})}


class Clock:
    """Time moves only when a node answers."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Node:
    """A provider over FakeChain's Multicall3, 10 ms a call: eth_chainId, the head, and eth_call; `fail` codes the
    round trip."""

    def __init__(self, clock, fail=None, reply=None):
        self.chain, self.clock, self.fail, self.reply, self.sent = FakeChain(ANSWERS), clock, fail, reply, []

    def __call__(self, url, body):
        self.sent.append(url)
        self.clock.now += 0.010
        method = body['method']
        if method == 'eth_chainId':
            if self.fail:
                raise DataError(self.fail)
            if self.reply is not None:
                return {'jsonrpc': '2.0', 'id': body['id'], **self.reply}
            result = hex(BASE.chainId)
        elif method == 'eth_getBlockByNumber':
            result = {'number': hex(BLOCK.number), 'hash': BLOCK.hash, 'timestamp': hex(BLOCK.timestamp)}
        else:
            result = self.chain.request(method, body['params'])
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': result}


class LatencyTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='domino-latency-')).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        os.chmod(self.directory, 0o700)
        endpoints = [{'name': name, 'host': f'{name}.example.invalid', 'url': f'https://{name}.example.invalid/{SECRET}',
                      'archive': True, 'maxBatchItems': 50, 'maxLogBlocks': 10000, 'requestsPerSecond': None}
                     for name in ('stack', 'alchemy')]
        self.path = self.directory / 'chain-rpc.json'
        self.path.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc',
                                         'chains': {'base-8453': {'endpoints': endpoints}}}))
        self.path.chmod(0o600)

    def run_main(self, *extra, kept_fails=None, kept_reply=None):
        clock = Clock()
        new, kept = Node(clock), Node(clock, fail=kept_fails, reply=kept_reply)
        out = io.StringIO()
        with mock.patch.object(latency, 'MODES', (('new_connection', new), ('kept', kept))), redirect_stdout(out):
            code = latency.main(['--chain', 'base-8453', '--chain-rpc-file', str(self.path), *extra], clock=clock)
        return code, out.getvalue(), new, kept

    def test_every_endpoint_in_both_modes_its_survey_timed_after_its_head(self):
        code, printed, new, kept = self.run_main('--samples', '3')
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, printed)
        report = json.loads(printed)
        self.assertEqual([e['endpoint'] for e in report['endpoints']], ['stack', 'alchemy'])
        self.assertEqual(report['survey'], {'token': USDC, 'candidates': 15})
        for endpoint in report['endpoints']:
            self.assertEqual(endpoint['host'], f"{endpoint['endpoint']}.example.invalid")
            for mode in ('new_connection', 'kept'):
                measured = endpoint[mode]
                # 10 ms a call: the round trip is one; the survey three, its head read before the clock starts.
                self.assertEqual(measured['chainIdMs'], {'samples': 3, 'p50': 10, 'p90': 10, 'max': 10})
                self.assertEqual(measured['surveyMs'], {'samples': 3, 'p50': 30, 'p90': 30, 'max': 30})
                self.assertEqual((measured['surveyCalls'], measured['ethUsd'], measured['failures']),
                                 ({'3': 3}, {'priced': 3}, {}))
        # Each mode through its own transport, every endpoint in turn: per sample a round trip, a head, three calls.
        for node in (new, kept):
            self.assertEqual(len(node.sent), 2 * 3 * 5)
        self.assertEqual(report['calls'], {'new_connection': {'stack': 15, 'alchemy': 15},
                                           'kept': {'stack': 15, 'alchemy': 15}})

    def test_one_endpoint_failures_by_code_and_a_mode_left_unmeasured(self):
        code, printed, _, _ = self.run_main('--endpoint', 'alchemy', '--samples', '2', kept_fails='http_503')
        report = json.loads(printed)
        self.assertEqual(code, 1)
        alchemy, = report['endpoints']
        self.assertEqual(alchemy['endpoint'], 'alchemy')
        self.assertIsNone(alchemy['kept']['chainIdMs'])
        self.assertIn('http_503', alchemy['kept']['failures'])
        self.assertEqual(alchemy['new_connection']['failures'], {})
        self.assertNotIn(SECRET, printed)

    def test_without_an_eth_price_a_survey_reads_no_depth_and_says_so(self):
        stale = {**ANSWERS, **feed_answers(age=BASE.gasPrice.chainlinkEthUsd.heartbeatSeconds + 1)}
        with mock.patch.object(sys.modules[__name__], 'ANSWERS', stale):
            code, printed, _, _ = self.run_main('--endpoint', 'stack', '--samples', '2')
        stack, = json.loads(printed)['endpoints']
        self.assertEqual(code, 0)
        for mode in ('new_connection', 'kept'):
            self.assertEqual((stack[mode]['surveyCalls'], stack[mode]['ethUsd'], stack[mode]['surveyMs']['p50']),
                             ({'1': 2}, {'eth_usd_stale': 2}, 10))

    def test_a_round_trip_counts_only_when_it_is_this_chains(self):
        for reply, code in (({'error': {'code': -32000, 'message': 'busy'}}, 'invalid_rpc_envelope'),
                            ({'result': hex(42161)}, 'wrong_chain')):
            with self.subTest(code=code):
                status, printed, _, _ = self.run_main('--endpoint', 'stack', '--samples', '2', kept_reply=reply)
                stack, = json.loads(printed)['endpoints']
                self.assertEqual((status, stack['kept']['chainIdMs'], stack['kept']['failures']), (1, None, {code: 2}))
                self.assertEqual(stack['kept']['surveyMs']['samples'], 2)

    def test_a_request_out_of_bounds_is_refused_by_name(self):
        for extra, error in ((('--samples', '0'), 'invalid_samples'), (('--samples', str(latency.MAX_SAMPLES + 1)),
                             'invalid_samples'), (('--endpoint', 'none'), 'v2_rpc_endpoint_unknown')):
            with self.subTest(extra=extra):
                code, printed, _, _ = self.run_main(*extra)
                self.assertEqual((code, json.loads(printed)), (1, {'error': error}))
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(latency.main(['--chain', 'base-8453']), 1)
        self.assertEqual(json.loads(out.getvalue()), {'error': 'v2_chain_rpc_not_configured'})

    def test_summary_is_median_ninetieth_and_slowest(self):
        self.assertEqual(latency.summary(list(range(1, 11))), {'samples': 10, 'p50': 6, 'p90': 9, 'max': 10})
        self.assertEqual(latency.summary([7.4]), {'samples': 1, 'p50': 7, 'p90': 7, 'max': 7})
        self.assertIsNone(latency.summary([]))

    def test_the_modes_are_the_readers_before_and_after(self):
        import discovery
        import v2_chain_reads
        self.assertEqual(latency.MODES, (('new_connection', discovery.rpc_http), ('kept', v2_chain_reads.kept_rpc)))


if __name__ == '__main__':
    unittest.main()
