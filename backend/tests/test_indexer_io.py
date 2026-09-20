"""Indexer I/O: batched headers keep every check, adaptive span stays bounded."""
from pathlib import Path
import io
import json
import sys
import unittest
from urllib.error import HTTPError

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from indexer_io import MAX_INDEXER_SPAN, AdaptiveSpan, HeaderBudget, RequestBudget, indexer_transport, read_headers


def raw_block(number, *, number_override=None):
    shown = number if number_override is None else number_override
    return {'number': hex(shown), 'hash': '0x' + f'{number:064x}', 'timestamp': hex(1000 + number)}


class BatchSpy:
    def __init__(self, *, number_override=None):
        self.batches = []
        self.calls = []
        self.number_override = number_override

    def request(self, method, params=()):
        if method != 'eth_getBlockByNumber':
            raise AssertionError(method)
        self.calls.append(int(params[0], 16))
        return raw_block(int(params[0], 16), number_override=self.number_override)

    def batch(self, calls):
        self.batches.append(list(calls))
        return [self.request(method, params) for method, params in calls]


class SequentialSpy(BatchSpy):
    """A client without `batch`; the helper must fall back to one call each."""
    batch = None


class ReadHeadersTests(unittest.TestCase):
    def test_a_shared_cache_pays_for_a_block_once(self):
        rpc = BatchSpy()
        cache = {}
        read_headers(rpc, [7, 8], cache=cache)
        read_headers(rpc, [7, 8, 9], cache=cache)
        self.assertEqual(rpc.calls, [7, 8, 9])
        self.assertEqual(sorted(cache), [7, 8, 9])

    def test_the_budget_counts_only_what_was_fetched_and_refuses_overspend(self):
        budget = HeaderBudget(3)
        cache = {}
        read_headers(BatchSpy(), [1, 2], cache=cache, budget=budget)
        self.assertEqual(budget.calls, 2)
        read_headers(BatchSpy(), [1, 2], cache=cache, budget=budget)
        self.assertEqual(budget.calls, 2)
        with self.assertRaisesRegex(DataError, 'header_budget_exhausted'):
            read_headers(BatchSpy(), [3, 4], cache=cache, budget=budget)
        self.assertEqual(budget.calls, 2)

    def test_an_invalid_budget_is_refused(self):
        for value in (-1, True, '10'):
            with self.subTest(value=value), self.assertRaises(DataError):
                HeaderBudget(value)

    def test_distinct_blocks_are_read_once_in_one_envelope(self):
        rpc = BatchSpy()
        headers = read_headers(rpc, [5, 3, 5, 4])
        self.assertEqual(sorted(headers), [3, 4, 5])
        self.assertEqual(rpc.calls, [5, 3, 4])
        self.assertEqual(len(rpc.batches), 1)
        self.assertEqual(headers[5].number, 5)

    def test_more_blocks_than_one_envelope_are_split(self):
        rpc = BatchSpy()
        read_headers(rpc, list(range(100, 120)), batch_items=8)
        self.assertEqual([len(item) for item in rpc.batches], [8, 8, 4])

    def test_the_default_envelope_is_the_measured_indexer_size(self):
        rpc = BatchSpy()
        read_headers(rpc, list(range(1, 121)))
        self.assertEqual([len(item) for item in rpc.batches], [100, 20])

    def test_batch_items_override_is_honoured(self):
        rpc = BatchSpy()
        read_headers(rpc, list(range(1, 6)), batch_items=2)
        self.assertEqual([len(item) for item in rpc.batches], [2, 2, 1])

    def test_a_client_without_batch_falls_back_to_sequential_reads(self):
        rpc = SequentialSpy()
        headers = read_headers(rpc, [7, 7, 8])
        self.assertEqual(sorted(headers), [7, 8])
        self.assertEqual(rpc.calls, [7, 8])

    def test_a_mismatched_block_number_is_rejected(self):
        with self.assertRaisesRegex(DataError, 'unexpected_block_number'):
            read_headers(BatchSpy(number_override=999), [7])

    def test_invalid_numbers_are_rejected_before_any_read(self):
        for number in (-1, True, '5'):
            with self.subTest(number=number), self.assertRaises(DataError):
                read_headers(BatchSpy(), [number])

    def test_empty_input_reads_nothing(self):
        rpc = BatchSpy()
        self.assertEqual(read_headers(rpc, []), {})
        self.assertEqual(rpc.batches, [])


class AdaptiveSpanTests(unittest.TestCase):
    def test_unknown_http_400_does_not_trigger_a_size_retry(self):
        span=AdaptiveSpan(100000)
        self.assertEqual(span.record('http_400'),100000)

    def test_bounded_run_retries_at_smaller_span_but_stops_at_floor(self):
        span=AdaptiveSpan(100000,floor=1000)
        observed=[]
        def step(value):
            observed.append(value)
            if value>6250:raise DataError('rpc_log_range_too_large')
            return {'status':'indexed'}
        self.assertEqual(span.run(step)['status'],'indexed')
        self.assertEqual(observed,[100000,25000,6250])
        floor=AdaptiveSpan(1000)
        observed.clear()
        def refused(value):
            observed.append(value);raise DataError('rpc_log_range_too_large')
        with self.assertRaises(DataError):floor.run(refused)
        self.assertEqual(observed,[1000])

    def test_size_rejections_shrink_the_span_to_the_floor_and_never_below(self):
        span = AdaptiveSpan(100_000, floor=1_000, ceiling=MAX_INDEXER_SPAN)
        self.assertEqual(span.record('response_too_large'), 25_000)
        self.assertEqual(span.record('activity_log_budget_exhausted'), 6_250)
        self.assertEqual(span.record('read_deadline_exceeded'), 1_562)
        self.assertEqual(span.record('rpc_log_range_too_large'), 1_000)
        self.assertEqual(span.record('response_too_large'), 1_000)
        self.assertEqual(span.shrinks, 4)

    def test_unrelated_failures_do_not_shrink_the_span(self):
        span = AdaptiveSpan(10_000, floor=1_000)
        self.assertEqual(span.record('network_unavailable'), 10_000)
        self.assertEqual(span.shrinks, 0)

    def test_consecutive_successes_grow_back_to_the_ceiling(self):
        span = AdaptiveSpan(1_000, floor=1_000, ceiling=8_000, growth_passes=2)
        self.assertEqual(span.record(None), 1_000)
        self.assertEqual(span.record(None), 2_000)
        self.assertEqual(span.next_span(), 2_000)
        self.assertEqual(span.record(None), 2_000)
        self.assertEqual(span.record(None), 4_000)
        for _ in range(4):
            span.record(None)
        self.assertEqual(span.next_span(), 8_000)

    def test_a_shrink_resets_the_growth_counter(self):
        span = AdaptiveSpan(8_000, floor=1_000, ceiling=8_000, growth_passes=2)
        span.record(None)
        span.record('response_too_large')
        span.record(None)
        self.assertEqual(span.next_span(), 2_000)
        self.assertEqual(span.record(None), 4_000)

    def test_invalid_bounds_are_rejected(self):
        for options in ({'floor': 0}, {'floor': 2_000}, {'ceiling': 500}, {'growth_passes': 0}):
            with self.subTest(options=options), self.assertRaises(DataError):
                AdaptiveSpan(1_000, **options)


class IndexerTransportTests(unittest.TestCase):
    def test_only_structural_log_size_error_is_classified_and_private_text_dropped(self):
        request={'jsonrpc':'2.0','id':1,'method':'eth_getLogs','params':[]}
        for code,message,expected in [
            (-32602,'Log response size exceeded. private-provider-detail','rpc_log_range_too_large'),
            (-32602,'invalid address','http_400'),(-32000,'Log response size exceeded','http_400')]:
            with self.subTest(code=code,message=message):
                stream=io.BytesIO(json.dumps({'error':{'code':code,'message':message}}).encode())
                def opened(*args,**kwargs):raise HTTPError('https://private.invalid/secret',400,'secret',{},stream)
                with self.assertRaises(DataError) as caught:
                    indexer_transport(opener=opened)('https://private.invalid/secret',request)
                self.assertEqual(str(caught.exception),expected)
                self.assertTrue(stream.closed)

    def test_budget_is_shared_across_transports_and_counts_batch_items(self):
        budget=RequestBudget(3)
        def opened(*args,**kwargs):return io.BytesIO(b'{"result":[]}')
        first=indexer_transport(budget=budget,opener=opened)
        second=indexer_transport(budget=budget,opener=opened)
        first('https://private.invalid',{'method':'eth_chainId'})
        second('https://private.invalid',[{},{}])
        self.assertEqual(budget.calls,3)
        with self.assertRaisesRegex(DataError,'indexer_rpc_budget_exhausted'):
            first('https://private.invalid',{})


if __name__=='__main__':unittest.main()
