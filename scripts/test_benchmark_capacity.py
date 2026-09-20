"""Offline stdlib checks for the bounded production capacity harness."""
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('benchmark_capacity', Path(__file__).with_name('benchmark-capacity.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.now += max(0, seconds)


class InlineExecutor:
    """Deterministic executor: service time advances the injected clock."""
    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def submit(self, function, index):
        function(index)

    def __exit__(self, *args):
        pass


class DeferredExecutor(InlineExecutor):
    def __init__(self, **kwargs):
        self.jobs = []

    def submit(self, function, index):
        self.jobs.append((function, index))

    def __exit__(self, *args):
        for function, index in self.jobs:
            function(index)


class FakeClient:
    profile, batch = 'node', 1

    def __init__(self, clock, effect=None):
        self.clock, self.effect, self.calls = clock, effect, []

    def call(self, index):
        self.calls.append((index, self.clock()))
        row = {'ms': 1, 'status': 200, 'outcome': 'ok', 'bytes': 80, 'methods': ['eth_call']}
        if self.effect:
            self.effect(index, row)
        return row


def guard():
    return SimpleNamespace(stop=threading.Event(), reasons=[], head=1000)


def result_for(request):
    method = request['method']
    result = {'eth_call': '0x'+'00'*32, 'eth_getCode': '0x6000',
              'eth_getBlockByNumber': {'hash': '0x'+'ab'*32, 'number': '0x3e8'},
              'eth_getLogs': []}[method]
    return {'jsonrpc': '2.0', 'id': request['id'], 'result': result}


class OfflineTest(unittest.TestCase):
    def setUp(self):
        # A regression cannot accidentally contact localhost, a provider or DNS.
        self.network = patch('socket.create_connection', side_effect=AssertionError('network forbidden'))
        self.network.start()
        self.addCleanup(self.network.stop)


class SchedulerTests(OfflineTest):
    def stage(self, client, clock, **kwargs):
        options = dict(rate=10, seconds=1, inflight_limit=2, guard=guard(), max_p95=1000,
                       clock=clock, wait=clock.wait, executor_factory=InlineExecutor)
        options.update(kwargs)
        return bench.run_stage(client, **options)

    def test_open_loop_drops_missed_arrivals_without_catchup(self):
        clock = Clock()
        client = FakeClient(clock, lambda index, row: clock.wait(.35) if index == 0 else None)
        result = self.stage(client, clock)
        self.assertEqual([i for i, _ in client.calls], [0, 3, 4, 5, 6, 7, 8, 9])
        self.assertEqual(result['dropped'], 2)
        self.assertEqual(result['scheduled'], 10)
        self.assertEqual(result['elapsedSeconds'], 1)
        self.assertEqual(len({t for _, t in client.calls}), len(client.calls))

    def test_scheduler_never_sends_after_stage_deadline(self):
        clock = Clock()
        client = FakeClient(clock, lambda index, row: clock.wait(2))
        result = self.stage(client, clock)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(result['dropped'], 9)

    def test_concurrency_is_bounded_without_an_executor_queue(self):
        clock = Clock()
        client = FakeClient(clock)
        client.batch = 8
        result = self.stage(client, clock, executor_factory=DeferredExecutor)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(result['maxInflightHttp'], 2)
        self.assertEqual(result['maxInflightRpcItems'], 16)
        self.assertEqual(result['dropped'], 8)
        self.assertEqual(result['offeredRpcItemsPerSecond'], 80)

    def test_timeout_stops_further_admissions_and_is_reported(self):
        clock = Clock()
        client = FakeClient(clock, lambda index, row: row.update(outcome='timeout'))
        result = self.stage(client, clock)
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(result['stoppedEarly'])
        self.assertIn('timeout', result['stopReasons'])

    def test_unexpected_worker_exception_cannot_disappear_in_future(self):
        def failure(index, row):
            raise RuntimeError('private failure text')
        clock = Clock()
        result = self.stage(FakeClient(clock, failure), clock)
        self.assertEqual(result['n'], 1)
        self.assertTrue(result['stoppedEarly'])
        self.assertIn('worker_RuntimeError', result['stopReasons'])
        self.assertNotIn('private failure text', json.dumps(result))

    def test_final_sparse_stage_still_checks_latency_slo(self):
        clock = Clock()
        client = FakeClient(clock, lambda index, row: row.update(ms=3500) if index == 1 else None)
        client.profile = 'wallet'
        result = self.stage(client, clock, rate=.25, seconds=8, max_p95=3000)
        self.assertEqual(result['n'], 2)
        self.assertTrue(result['stoppedEarly'])
        self.assertIn('slo_p95', result['stopReasons'])

    def test_three_consecutive_slow_responses_abort_without_thirty_samples(self):
        clock = Clock()
        result = self.stage(FakeClient(clock, lambda index, row: row.update(ms=200)), clock, max_p95=100)
        self.assertEqual(result['n'], 3)
        self.assertTrue(result['stoppedEarly'])

    def test_guard_stop_prevents_next_admission(self):
        clock, health = Clock(), guard()
        def wait(seconds):
            clock.wait(seconds)
            health.stop.set()
        client = FakeClient(clock)
        result = self.stage(client, clock, guard=health, wait=wait)
        self.assertEqual(len(client.calls), 1)
        self.assertIn('health_guard', result['stopReasons'])


class RpcValidationTests(OfflineTest):
    def setUp(self):
        super().setUp()
        self.requests = [bench.rpc_row(i, 1000, bench.POOLS) for i in range(10)]
        self.responses = [result_for(r) for r in self.requests]

    def test_unordered_batch_is_validated_by_id(self):
        self.assertEqual(bench.validate_rpc(list(reversed(self.responses)), self.requests), 'ok')

    def test_batch_rejects_duplicate_missing_and_unexpected_ids(self):
        candidates = [self.responses[:-1], self.responses+[self.responses[0]]]
        duplicate = copy.deepcopy(self.responses)
        duplicate[-1]['id'] = duplicate[0]['id']
        candidates.append(duplicate)
        unknown = copy.deepcopy(self.responses)
        unknown[-1]['id'] = 999
        candidates.append(unknown)
        for payload in candidates:
            with self.subTest(payload=payload):
                self.assertEqual(bench.validate_rpc(payload, self.requests), 'invalid_response')

    def test_boolean_string_and_unhashable_ids_are_invalid(self):
        for bad_id in (False, '0', [], {}, None):
            response = copy.deepcopy(self.responses[0])
            response['id'] = bad_id
            self.assertEqual(bench.validate_rpc(response, self.requests[:1]), 'invalid_response')

    def test_envelope_shape_and_exclusive_result_or_error(self):
        self.assertEqual(bench.validate_rpc(self.responses[:1], self.requests[:1]), 'invalid_response')
        self.assertEqual(bench.validate_rpc(self.responses[0], self.requests), 'invalid_response')
        response = dict(self.responses[0], error={'code': -32000, 'message': 'failed'})
        self.assertEqual(bench.validate_rpc(response, self.requests[:1]), 'invalid_response')
        del response['result']
        self.assertEqual(bench.validate_rpc(response, self.requests[:1]), 'jsonrpc_error')
        response['error']['code'] = True
        self.assertEqual(bench.validate_rpc(response, self.requests[:1]), 'invalid_response')

    def test_invalid_hex_header_and_log_data_do_not_count_as_success(self):
        for index, invalid in ((0, '0x1'), (0, '0x'), (6, {'hash': 'x', 'number': '0x1'}),
                               (9, [None]), (9, [{'address': None}])):
            response = copy.deepcopy(self.responses[index])
            response['result'] = invalid
            self.assertEqual(bench.validate_rpc(response, self.requests[index:index+1]), 'invalid_result')

    def test_log_result_must_match_requested_pool_range_and_not_removed(self):
        request = self.requests[9]
        log = {'address': bench.MANAGER, 'topics': ['0x'+'11'*32, request['params'][0]['topics'][1]],
               'blockNumber': '0x3e8', 'removed': False}
        response = dict(self.responses[9], result=[log])
        self.assertEqual(bench.validate_rpc(response, [request]), 'ok')
        for field, bad in (('blockNumber', '0x3e9'), ('removed', True), ('address', bench.WETH)):
            changed = copy.deepcopy(response)
            changed['result'][0][field] = bad
            self.assertEqual(bench.validate_rpc(changed, [request]), 'invalid_result')


class WorkloadTests(OfflineTest):
    def test_builtin_node_workload_is_only_bounded_read_methods(self):
        methods, pools_seen = set(), set()
        for index in range(len(bench.POOLS)*10):
            request = bench.rpc_row(index, 1000, bench.POOLS)
            method, params = request['method'], request['params']
            methods.add(method)
            self.assertEqual(request['jsonrpc'], '2.0')
            self.assertEqual(request['id'], index)
            if method == 'eth_call':
                self.assertEqual(params[1], 'latest')
                self.assertLessEqual(int(params[0]['gas'], 16), 500000)
                self.assertIn(params[0]['to'], (bench.VIEW, bench.WETH))
                self.assertNotIn('value', params[0])
            elif method == 'eth_getLogs':
                self.assertEqual(int(params[0]['toBlock'], 16)-int(params[0]['fromBlock'], 16), 99)
                self.assertEqual(params[0]['address'], bench.MANAGER)
                pools_seen.add(params[0]['topics'][1])
        self.assertEqual(methods, bench.READ_METHODS)
        self.assertEqual(pools_seen, set(bench.POOLS))

    def test_client_uses_only_loopback_and_expected_read_routes(self):
        sent, endpoints = [], []
        class Connection:
            def __init__(self, host, port, **kwargs):
                endpoints.append((host, port))
            def request(self, method, path, body, headers):
                self.payload = json.loads(body)
                sent.append((method, path, self.payload))
            def getresponse(self):
                if isinstance(self.payload, list):
                    payload = [result_for(r) for r in self.payload]
                elif 'jsonrpc' in self.payload:
                    payload = result_for(self.payload)
                else:
                    payload = {}
                raw = io.BytesIO(json.dumps(payload).encode())
                return SimpleNamespace(status=200, read1=raw.read, isclosed=lambda: False)
            def close(self):
                pass
        with patch.object(bench.http.client, 'HTTPConnection', Connection):
            for profile, batch in (('node', 1), ('node', 8), ('stored', 1), ('wallet', 1)):
                client = bench.Client(profile, bench.POOLS, batch, guard())
                for index in (0, 8, 9):
                    self.assertEqual(client.call(index)['outcome'], 'ok')
                client.close()
        self.assertTrue(all(host == '127.0.0.1' and port in (8547, 8876) for host, port in endpoints))
        self.assertEqual({path for _, path, _ in sent},
                         {'/', '/v3/read/overview', '/v3/read/search', '/v3/read/history', '/v1/read/wallet-assets'})
        self.assertTrue(all(method == 'POST' for method, _, _ in sent))
        wallets = [body for _, path, body in sent if path == '/v1/read/wallet-assets']
        self.assertTrue(all(body == {'wallet': bench.DEAD, 'tokens': [], 'autoDiscover': True} for body in wallets))

    def test_client_timeout_closes_connection_without_retry(self):
        connection = SimpleNamespace(request=lambda *args: (_ for _ in ()).throw(TimeoutError()), close=lambda: None)
        with patch.object(bench.http.client, 'HTTPConnection', return_value=connection) as factory, patch.object(connection, 'close') as close:
            client = bench.Client('node', bench.POOLS, 1, guard())
            self.assertEqual(client.call(0)['outcome'], 'timeout')
            self.assertEqual(factory.call_count, 1)
            close.assert_called_once()
            self.assertIsNone(client.local.connection)

    def test_stale_idle_connection_is_replaced_before_send_without_retry(self):
        for replacement_fails in (False, True):
            with self.subTest(replacement_fails=replacement_fails):
                clock, connections, events = Clock(), [], []
                class Connection:
                    def __init__(self, host, port, **kwargs):
                        self.index, self.requests, self.closes = len(connections), 0, 0
                        connections.append(self)
                    def request(self, *args):
                        self.requests += 1
                        events.append(('send', self.index))
                        if self.index == 1 and replacement_fails:
                            raise BrokenPipeError('uncertain request')
                        if self.index == 0 and self.requests == 1:
                            clock.wait(2)
                    def getresponse(self):
                        body = io.BytesIO(b'{}')
                        def read1(size):
                            chunk = body.read(size)
                            if chunk:
                                clock.wait(.25)
                            return chunk
                        return SimpleNamespace(status=200, read1=read1, isclosed=lambda: False)
                    def close(self):
                        self.closes += 1
                        events.append(('close', self.index))
                with patch.object(bench.http.client, 'HTTPConnection', Connection), patch.object(bench.time, 'monotonic', clock):
                    client = bench.Client('stored', bench.POOLS, 1, guard())
                    self.assertEqual(client.call(0)['outcome'], 'ok')
                    self.assertEqual(client.local.last_used, 2.25)
                    # Socket age exceeds four seconds, but actual idle time is
                    # only two seconds: keep it until its post-response idle expires.
                    clock.wait(2)
                    self.assertEqual(client.call(1)['outcome'], 'ok')
                    self.assertEqual(len(connections), 1)
                    clock.wait(4.001)
                    row = client.call(2)
                self.assertEqual(len(connections), 2)
                self.assertEqual([c.requests for c in connections], [2, 1])
                self.assertEqual(events[:4], [('send', 0), ('send', 0), ('close', 0), ('send', 1)])
                self.assertEqual(connections[0].closes, 1)
                self.assertEqual(row['outcome'], 'transport_BrokenPipeError' if replacement_fails else 'ok')
                if replacement_fails:
                    self.assertIsNone(client.local.connection)
                    self.assertEqual(connections[1].closes, 1)
                else:
                    self.assertIs(client.local.connection, connections[1])

    def test_trickling_body_cannot_extend_the_absolute_deadline(self):
        clock, chunks, timeouts = Clock(), [], []
        def read1(size):
            chunks.append(size)
            clock.wait(1)
            return b' '
        connection = SimpleNamespace(sock=SimpleNamespace(settimeout=timeouts.append),
                                     request=lambda *args: None,
                                     getresponse=lambda: SimpleNamespace(status=200, read1=read1, isclosed=lambda: False),
                                     close=lambda: None)
        with patch.object(bench.http.client, 'HTTPConnection', return_value=connection), patch.object(bench.time, 'monotonic', clock):
            client = bench.Client('node', bench.POOLS, 1, guard())
            row = client.call(0)
        self.assertEqual(row['outcome'], 'timeout')
        self.assertEqual(len(chunks), 3)
        self.assertEqual(row['ms'], 3000)
        self.assertEqual(timeouts[-2:], [2, 1])

    def test_oversized_response_is_bounded_and_connection_discarded(self):
        body = io.BytesIO(b'x'*(bench.MAX_BODY+100))
        connection = SimpleNamespace(request=lambda *args: None,
                                     getresponse=lambda: SimpleNamespace(status=200, read1=body.read, isclosed=lambda: False),
                                     close=lambda: None)
        with patch.object(bench.http.client, 'HTTPConnection', return_value=connection):
            client = bench.Client('node', bench.POOLS, 1, guard())
            row = client.call(0)
        self.assertEqual(row['outcome'], 'response_too_large')
        self.assertEqual(row['bytes'], bench.MAX_BODY+1)
        self.assertIsNone(client.local.connection)


class EdgeGuardTests(OfflineTest):
    NOW = datetime(2026, 9, 20, 20, 0, 30, tzinfo=timezone.utc).timestamp()

    def line(self, seconds, status=200, rt='.020', urt='.010'):
        stamp = datetime.fromtimestamp(self.NOW-seconds, timezone.utc).strftime('%d/%b/%Y:%H:%M:%S %z')
        return f'PRIVATE_IP - [{stamp}] "POST /PRIVATE_TOKEN HTTP/1.1" {status} 100 rt={rt} urt={urt}'

    def test_window_aggregates_upstream_and_rejections_without_sensitive_fields(self):
        summary = bench.edge_summary('\n'.join([self.line(2), self.line(3, 503, '.001', '-'), self.line(25, 503)]), now=self.NOW)
        self.assertEqual(summary['requests'], 2)
        self.assertEqual(summary['http503Rate'], .5)
        self.assertEqual(summary['noUpstream503'], 1)
        self.assertEqual(summary['upstreamP95Ms'], 10)
        self.assertNotIn('PRIVATE', json.dumps(summary))

    def test_bad_format_and_truncated_window_fail_closed(self):
        for text, options in (('unexpected log format', {}), (self.line(2), {'tail_limit': 1}),
                              (self.line(2, rt='nan'), {})):
            with self.assertRaises(ValueError):
                bench.edge_summary(text, now=self.NOW, **options)

    def test_503_growth_requires_30_sustained_seconds_and_resets(self):
        health = bench.Guard(None, None)
        health.edge_baseline = {'http503Rate': .1}
        edge = {'requests': 100, 'http503Rate': .2, 'upstreamP95Ms': 20}
        self.assertEqual(health.evaluate_edge(edge, 0), [])
        self.assertEqual(health.evaluate_edge(edge, 29), [])
        self.assertEqual(health.evaluate_edge(edge, 30), ['edge_503_growth'])
        self.assertEqual(health.evaluate_edge(dict(edge, http503Rate=.14), 31), [])
        self.assertEqual(health.evaluate_edge(edge, 50), [])

    def test_upstream_p95_requires_15_sustained_seconds(self):
        health = bench.Guard(None, None)
        health.edge_baseline = {'http503Rate': 0}
        edge = {'requests': 50, 'http503Rate': 0, 'upstreamP95Ms': 201}
        self.assertEqual(health.evaluate_edge(edge, 10), [])
        self.assertEqual(health.evaluate_edge(edge, 24), [])
        self.assertEqual(health.evaluate_edge(edge, 25), ['edge_upstream_p95_above_200ms'])

    def test_edge_collection_failure_aborts_and_does_not_expose_raw_error(self):
        def failure():
            raise ValueError('PRIVATE_TOKEN')
        health = bench.Guard(None, None, edge_collector=failure)
        health.module = SimpleNamespace(collect=lambda *args: ({'head': 100, 'lag_blocks': 0}, {}),
                                        evaluate=lambda metrics, state: ([], {}))
        health.poll()
        self.assertTrue(health.stop.is_set())
        self.assertEqual(health.reasons, ['guard_unavailable_ValueError'])
        self.assertNotIn('PRIVATE_TOKEN', json.dumps(health.samples+health.reasons))

    def test_initial_baseline_runs_thirty_seconds_before_background_thread(self):
        clock = Clock()
        class Stop:
            def is_set(self):
                return False
            def wait(self, seconds):
                clock.wait(seconds)
                return False
        health = bench.Guard(None, None, edge_collector=lambda: {
            'requests': 100, 'http503Rate': clock()/1000, 'upstreamP95Ms': 10})
        health.path, health.stop = 'synthetic-guard', Stop()
        health.module = SimpleNamespace(collect=lambda *args: ({'head': 100, 'lag_blocks': 0}, {}),
                                        evaluate=lambda metrics, state: ([], {}))
        with patch.object(bench.time, 'monotonic', clock), patch.object(bench.threading, 'Thread') as thread:
            health.start()
            thread.return_value.start.assert_called_once()
        self.assertEqual(clock(), 30)
        self.assertEqual(len(health.samples), 7)
        self.assertEqual(health.edge_baseline['http503Rate'], .03)

    def test_collection_runs_only_readonly_tail_and_returns_aggregates(self):
        with patch.object(bench.subprocess, 'run', return_value=SimpleNamespace(stdout=self.line(1))) as run, patch.object(bench.time, 'time', return_value=self.NOW):
            summary = bench.collect_edge()
        run.assert_called_once_with(['docker', 'exec', 'robinhood-edge', 'tail', '-n', '3000',
                                     '/var/log/nginx/access.log'], capture_output=True, text=True,
                                    timeout=3, check=True)
        self.assertEqual(summary['requests'], 1)
        self.assertNotIn('PRIVATE', json.dumps(summary))


if __name__ == '__main__':
    unittest.main()
