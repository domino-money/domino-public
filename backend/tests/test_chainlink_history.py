"""Synthetic archive RPC evidence; no provider, credential, wallet or live call."""
from collections import Counter
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import decode, encode
from eth_hash.auto import keccak

from chainlink_history import (ChainlinkHistorical, ETH_FEED, MANIFEST_SHA256, MAX_ROUNDS,
                               ROUND_TYPES, SOURCE, USDG, USDG_FEED, WETH)
from discovery import CHAIN_ID, ZERO, DataError, ReadRpc


PHASE = 1 << 64
SIGNATURES = {
    'aggregator()': ((), ('address',)),
    'phaseId()': ((), ('uint16',)),
    'phaseAggregators(uint16)': (('uint16',), ('address',)),
    'description()': ((), ('string',)),
    'decimals()': ((), ('uint8',)),
    'latestRoundData()': ((), ROUND_TYPES),
    'getRoundData(uint80)': (('uint80',), ROUND_TYPES),
}
SELECTORS = {keccak(signature.encode())[:4]: signature for signature in SIGNATURES}


class Archive:
    """Two blocks/second with a deliberately delayed round at block 51."""
    def __init__(self):
        self.height = 120
        self.times = {number: 1000 + number // 2 for number in range(self.height + 1)}
        self.rounds = {
            PHASE + 1: (PHASE + 1, 100000000, 1000, 1001, PHASE + 1),
            PHASE + 2: (PHASE + 2, 100000001, 1006, 1007, PHASE + 2),
            PHASE + 3: (PHASE + 3, 9007199254740993123456, 1018, 1020, PHASE + 3),
            PHASE + 4: (PHASE + 4, 246015477204, 1038, 1040, PHASE + 4),
        }
        self.publications = {PHASE + 1: 2, PHASE + 2: 16, PHASE + 3: 51, PHASE + 4: 90}
        self.header_reads, self.calls = Counter(), []
        self.reorg_number = self.fail_signature = None
        self.overrides = {}
        self.chain_id = CHAIN_ID

    @staticmethod
    def block_hash(number):
        return '0x' + (number + 1).to_bytes(32, 'big').hex()

    def __call__(self, unused_url, body):
        method, params = body['method'], body['params']
        if method == 'eth_chainId':
            result = hex(self.chain_id)
        elif method == 'eth_getBlockByNumber':
            tag = params[0]
            number = self.height if tag == 'latest' else int(tag, 16)
            self.header_reads[number] += 1
            result = {'number': hex(number), 'timestamp': hex(self.times[number]),
                      'hash': self.block_hash(number)}
            if self.reorg_number == number and self.header_reads[number] > 1:
                result['hash'] = '0x' + 'ff' * 32
        elif method == 'eth_call':
            call, block = params
            if not isinstance(block, dict) or block.get('requireCanonical') is not True:
                raise AssertionError('Every historical call must be pinned to a canonical block hash')
            number = int(block['blockHash'], 16) - 1
            self.assert_block_exists(number)
            raw = bytes.fromhex(call['data'][2:])
            signature = SELECTORS[raw[:4]]
            inputs, outputs = SIGNATURES[signature]
            args = decode(inputs, raw[4:])
            self.calls.append((signature, number, call['to'], args))
            if signature == self.fail_signature:
                return {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32000}}
            value = self.value(signature, number, call['to'], args)
            if value is None:
                return {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32000}}
            result = '0x' + encode(outputs, value).hex()
        else:
            raise AssertionError(f'Unexpected/non-read-only method: {method}')
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': result}

    def assert_block_exists(self, number):
        if number not in self.times:
            raise AssertionError('Historical call did not name a fetched block')

    def value(self, signature, number, target, args):
        override = self.overrides.get((signature, number))
        if override is not None:
            return override
        feed = USDG_FEED if target == USDG_FEED.proxy else ETH_FEED
        if signature == 'aggregator()' or signature == 'phaseAggregators(uint16)':
            return (feed.aggregator,)
        if signature == 'phaseId()':
            return (feed.phase,)
        if signature == 'description()':
            return (feed.description,)
        if signature == 'decimals()':
            return ((6 if target == USDG else 18) if target in (USDG, WETH) else 8,)
        if signature == 'latestRoundData()':
            available = [round_id for round_id, at in self.publications.items() if at <= number]
            return self.rounds.get(max(available)) if available else None
        if signature == 'getRoundData(uint80)':
            if args[0] not in self.publications or self.publications[args[0]] > number:
                return None
            return self.rounds.get(args[0])
        raise AssertionError(signature)


class ChainlinkHistoryTests(unittest.TestCase):
    def setUp(self):
        self.archive = Archive()
        self.rpc = ReadRpc(transport=self.archive, max_requests=1000)
        self.reader = ChainlinkHistorical(self.rpc, clock=lambda: 1060)

    def fetch(self, currency=ZERO, start=1020, end=1055, **kwargs):
        return self.reader.fetch(currency, start, end, **kwargs)

    def test_delay_and_same_second_predecessor_prove_actual_publication(self):
        result = self.fetch()
        rows = result['observations']
        self.assertEqual([row['timestamp'] for row in rows], [1008, 1025, 1045])
        delayed = rows[1]['provenance']
        self.assertEqual(delayed['answerUpdatedAt'], 1020)
        self.assertEqual(delayed['publicationBlock']['number'], 51)
        self.assertEqual(delayed['publicationBlock']['timestamp'], 1025)
        self.assertEqual(delayed['precedingBlock']['number'], 50)
        self.assertEqual(delayed['precedingBlock']['timestamp'], 1025)
        self.assertEqual(delayed['precedingRoundId'], str(PHASE + 2))
        self.assertEqual(rows[1]['priceUsd'], '90071992547409.93123456')
        self.assertEqual(rows[0]['priceUsd'], '1.00000001')
        self.assertEqual(result['coverage']['endBlock']['number'], 111)
        self.assertTrue(result['coverage']['precedingObservationIncluded'])
        self.assertTrue(result['coverage']['publicationBlocksVerified'])
        self.assertFalse(result['coverage']['freshnessAssessed'])
        self.assertFalse(result['coverage']['withinSecondOrderingSupported'])
        for row in rows:
            self.assertEqual(row['source'], SOURCE)
            self.assertEqual(row['provenance']['status'], 'external_observation_unqualified')
            self.assertFalse(row['provenance']['targetPoolIndependenceVerified'])
            self.assertEqual(row['provenance']['currencyDecimals'], 18)
            self.assertEqual(row['provenance']['manifestSha256'], MANIFEST_SHA256)
        # Query cache avoids repeated archive latestRoundData calls at one block.
        calls = [(signature, number) for signature, number, _, _ in self.archive.calls
                 if signature == 'latestRoundData()']
        self.assertEqual(len(calls), len(set(calls)))

    def test_end_does_not_leak_future_snapshot_round(self):
        rows = self.fetch(end=1030)['observations']
        self.assertEqual([row['provenance']['roundId'] for row in rows],
                         [str(PHASE + 2), str(PHASE + 3)])

    def test_publication_at_answer_lower_bound_does_not_search_old_stale_tail(self):
        self.archive.height = 120000
        self.archive.times = {number: 1000 + number // 2 for number in range(120001)}
        self.archive.publications[PHASE + 4] = 80
        result = ChainlinkHistorical(self.rpc, clock=lambda: 61000).fetch(ZERO, 1020, 61000)
        self.assertEqual(result['observations'][-1]['provenance']['publicationBlock']['number'], 80)
        # Only the required end-of-window latest read touches the stale tail.
        tail_reads = {number for signature, number, _, _ in self.archive.calls
                      if signature == 'latestRoundData()' and number > 80}
        self.assertEqual(tail_reads, {120000})

    def test_short_publication_delay_has_same_call_bound_even_hours_from_snapshot(self):
        counts = []
        for height in (5000, 120000):
            with self.subTest(height=height):
                self.setUp()
                self.archive.height = height
                self.archive.times = {number: 1000 + number // 2 for number in range(height + 1)}
                self.archive.publications[PHASE + 4] = 83
                end = self.archive.times[height]
                result = ChainlinkHistorical(self.rpc, clock=lambda: end).fetch(ZERO, 1020, end)
                last = result['observations'][-1]['provenance']
                self.assertEqual(last['publicationBlock']['number'], 83)
                self.assertEqual(last['precedingBlock']['number'], 82)
                counts.append(sum(signature == 'latestRoundData()' for signature, *_ in self.archive.calls))
                self.assertLessEqual(counts[-1], 25)
        self.assertEqual(counts[0], counts[1])

    def test_rpc_failure_inside_exponential_bracket_is_not_an_absent_round(self):
        self.archive.publications[PHASE + 4] = 83
        original = self.archive.value
        def failed(signature, number, target, args):
            if signature == 'latestRoundData()' and number == 82:
                return None
            return original(signature, number, target, args)
        self.archive.value = failed
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            self.fetch()
        self.assertEqual(sum(signature == 'latestRoundData()' and number == 82
                             for signature, number, _, _ in self.archive.calls), 1)

    def test_update_exactly_at_start_still_includes_a_strict_predecessor(self):
        rows = self.fetch(start=1025)['observations']
        self.assertEqual([row['timestamp'] for row in rows], [1008, 1025, 1045])

    def test_exact_canonical_erc20_identity_reads_decimals(self):
        for currency, decimals, expected_feed in ((WETH, 18, ETH_FEED), (USDG, 6, USDG_FEED)):
            with self.subTest(currency=currency):
                result = self.fetch(currency)
                self.assertEqual(result['feed']['currencyDecimals'], decimals)
                self.assertEqual(result['feed']['proxy'], expected_feed.proxy)
                self.assertTrue(any(signature == 'decimals()' and target == currency
                                    for signature, _, target, _ in self.archive.calls))

    def test_no_ticker_alias_or_unreviewed_contract_is_admitted(self):
        for currency in ('ETH', 'WETH', 'USDG', '0x' + '11' * 20):
            with self.subTest(currency=currency), self.assertRaises(DataError):
                self.fetch(currency)
        self.assertEqual(self.rpc.count, 0)

    def test_explicit_snapshot_number_and_equal_timestamp_end(self):
        result = self.fetch(end=1050, block_number=100)
        self.assertEqual(result['snapshot']['number'], 100)
        self.assertEqual(result['coverage']['endBlock']['number'], 100)

    def test_bounds_reject_future_inverted_overlong_and_bool_inputs(self):
        for start, end in ((1055, 1020), (1020, 1061), (True, 1055), (1020, True), (-1, 1055)):
            with self.subTest(start=start, end=end), self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'):
                self.fetch(start=start, end=end)
        with self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'):
            ChainlinkHistorical(self.rpc, clock=lambda: 200000).fetch(ZERO, 0, 90000)
        with self.assertRaisesRegex(DataError, 'chainlink_snapshot_time_mismatch'):
            self.fetch(end=1060, block_number=100)
        with self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'):
            self.fetch(block_number=True)

    def test_invalid_clock_is_a_safe_error(self):
        for now in (float('nan'), float('inf'), 10 ** 400, True, '1060'):
            with self.subTest(now=now), self.assertRaisesRegex(DataError, 'invalid_price_history_clock'):
                ChainlinkHistorical(self.rpc, clock=lambda: now).fetch(ZERO, 1020, 1055)

    def test_snapshot_and_publication_reorganizations_fail_closed(self):
        for number in (120, 90, 89, 51, 50, 16, 15):
            with self.subTest(number=number):
                self.setUp()
                self.archive.reorg_number = number
                with self.assertRaisesRegex(DataError, 'chainlink_snapshot_reorganized'):
                    self.fetch()

    def test_rpc_failure_is_not_missing_history_or_a_previous_price(self):
        self.archive.fail_signature = 'latestRoundData()'
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            self.fetch()
        self.assertEqual(sum(signature == 'latestRoundData()' for signature, *_ in self.archive.calls), 1)

    def test_missing_intermediate_round_is_an_error_not_a_gap_fill(self):
        del self.archive.rounds[PHASE + 3]
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            self.fetch()

    def test_request_budget_is_preserved(self):
        self.rpc.max_requests = 2
        with self.assertRaisesRegex(DataError, '^request_budget_exhausted$'):
            self.fetch()
        self.assertEqual(self.rpc.count, 2)

    def test_deadline_is_bounded_without_sleeping(self):
        with patch('chainlink_history.time.monotonic', side_effect=[0, 181]):
            with self.assertRaisesRegex(DataError, 'chainlink_deadline_exhausted'):
                self.fetch()
        self.assertEqual(self.rpc.count, 0)

    def test_explicit_archive_budget_remains_bounded(self):
        for seconds in (0, 361, True, '360'):
            with self.subTest(seconds=seconds), self.assertRaisesRegex(DataError, 'invalid_chainlink_deadline'):
                ChainlinkHistorical(self.rpc, deadline_seconds=seconds)
        reader = ChainlinkHistorical(self.rpc, clock=lambda: 1060, deadline_seconds=360)
        with patch('chainlink_history.time.monotonic', side_effect=[0, 361]):
            with self.assertRaisesRegex(DataError, 'chainlink_deadline_exhausted'):
                reader.fetch(ZERO, 1020, 1055)
        self.assertEqual(self.rpc.count, 0)

    def test_malformed_incomplete_nonpositive_and_future_rounds_rejected(self):
        base = self.archive.rounds[PHASE + 4]
        cases = ((1, 0), (1, -1), (2, 0), (2, 1041), (3, 1061), (4, PHASE + 3))
        for index, value in cases:
            with self.subTest(index=index, value=value):
                self.setUp()
                changed = list(base)
                changed[index] = value
                self.archive.rounds[PHASE + 4] = tuple(changed)
                with self.assertRaisesRegex(DataError, 'chainlink_invalid_round'):
                    self.fetch()

    def test_previous_phase_cannot_be_crossed_or_reinterpreted(self):
        self.archive.overrides['phaseId()', 15] = (2,)
        with self.assertRaisesRegex(DataError, 'chainlink_phase_boundary'):
            self.fetch()

    def test_history_beginning_in_first_round_requires_phase_adapter(self):
        self.archive.rounds[PHASE] = (PHASE, 100000000, 1000, 1000, PHASE)
        self.archive.publications[PHASE] = 0
        # The first reviewed phase cannot prove a predecessor within that phase.
        with self.assertRaisesRegex(DataError, 'chainlink_invalid_round|chainlink_phase_boundary'):
            self.fetch(start=1000)

    def test_proxy_and_feed_precision_changes_rejected(self):
        for signature, value in (('aggregator()', ('0x' + 'aa' * 20,)),
                                 ('phaseAggregators(uint16)', ('0x' + 'aa' * 20,)),
                                 ('decimals()', (18,)), ('description()', ('ETH / TOKEN',))):
            with self.subTest(signature=signature):
                self.setUp()
                self.archive.overrides[signature, 15] = value
                with self.assertRaisesRegex(DataError, 'chainlink_configuration_changed'):
                    self.fetch()

    def test_token_decimal_change_between_bounds_rejected(self):
        original = self.archive.value
        def changed(signature, number, target, args):
            if signature == 'decimals()' and target == USDG and number == 15:
                return (18,)
            return original(signature, number, target, args)
        self.archive.value = changed
        with self.assertRaisesRegex(DataError, 'chainlink_currency_decimals_mismatch'):
            self.fetch(USDG)

    def test_wrong_canonical_decimals_rejected_even_if_constant_through_history(self):
        original = self.archive.value
        def changed(signature, number, target, args):
            if signature == 'decimals()' and target == WETH:
                return (6,)
            return original(signature, number, target, args)
        self.archive.value = changed
        with self.assertRaisesRegex(DataError, 'chainlink_currency_decimals_mismatch'):
            self.fetch(WETH)

    def test_two_distinct_rounds_published_in_one_second_are_not_coalesced(self):
        self.archive.rounds[PHASE + 4] = (PHASE + 4, 100000001, 1020, 1020, PHASE + 4)
        self.archive.publications[PHASE + 3] = 50
        self.archive.publications[PHASE + 4] = 51
        with self.assertRaisesRegex(DataError, 'chainlink_publication_timestamp_ambiguous'):
            self.fetch()

    def test_same_block_round_overwrite_cannot_invent_a_publication(self):
        self.archive.rounds[PHASE + 4] = (PHASE + 4, 100000001, 1020, 1020, PHASE + 4)
        self.archive.publications[PHASE + 4] = 51
        with self.assertRaisesRegex(DataError, 'chainlink_publication_unavailable'):
            self.fetch()

    def test_round_answer_revision_between_snapshot_and_publication_rejected(self):
        original = self.archive.rounds[PHASE + 4]
        changed = (original[0], original[1] + 1, *original[2:])
        self.archive.overrides['getRoundData(uint80)', 90] = changed
        with self.assertRaisesRegex(DataError, 'chainlink_round_revision'):
            self.fetch()

    def test_wrong_chain_rejected_before_feed_reads(self):
        self.archive.chain_id = 1
        with self.assertRaisesRegex(DataError, '^wrong_chain$'):
            self.fetch()
        self.assertEqual(self.archive.calls, [])

    def test_round_budget_ends_without_partial_result(self):
        self.archive.rounds, self.archive.publications = {}, {}
        self.archive.height = 300
        self.archive.times = {number: 1000 + number for number in range(301)}
        for index in range(1, 80):
            at = 1000 + index * 2
            self.archive.rounds[PHASE + index] = (PHASE + index, 100000000, at, at, PHASE + index)
            self.archive.publications[PHASE + index] = index * 2
        self.rpc.max_requests = 5000
        reader = ChainlinkHistorical(self.rpc, clock=lambda: 1300)
        with self.assertRaisesRegex(DataError, 'chainlink_round_budget_exhausted'):
            reader.fetch(ZERO, 1003, 1300)
        proven = [call for call in self.archive.calls if call[0] == 'getRoundData(uint80)']
        self.assertGreaterEqual(len(proven), MAX_ROUNDS)


if __name__ == '__main__':
    unittest.main()
