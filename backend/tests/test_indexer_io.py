"""Indexer I/O: batched headers keep every check, adaptive span stays bounded."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from indexer_io import MAX_INDEXER_SPAN, AdaptiveSpan, read_headers


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
    def test_distinct_blocks_are_read_once_in_one_envelope(self):
        rpc = BatchSpy()
        headers = read_headers(rpc, [5, 3, 5, 4])
        self.assertEqual(sorted(headers), [3, 4, 5])
        self.assertEqual(rpc.calls, [5, 3, 4])
        self.assertEqual(len(rpc.batches), 1)
        self.assertEqual(headers[5].number, 5)

    def test_more_blocks_than_one_envelope_are_split(self):
        rpc = BatchSpy()
        read_headers(rpc, list(range(100, 120)))
        self.assertEqual([len(item) for item in rpc.batches], [8, 8, 4])

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
    def test_size_rejections_shrink_the_span_to_the_floor_and_never_below(self):
        span = AdaptiveSpan(100_000, floor=1_000, ceiling=MAX_INDEXER_SPAN)
        self.assertEqual(span.record('response_too_large'), 25_000)
        self.assertEqual(span.record('activity_log_budget_exhausted'), 6_250)
        self.assertEqual(span.record('read_deadline_exceeded'), 1_562)
        self.assertEqual(span.record('http_400'), 1_000)
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


if __name__=='__main__':unittest.main()
