import copy
from fractions import Fraction
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chainlink_history import ChainlinkHistorical, SOURCE, USDG
from chainlink_reference import (MAX_AGE_SECONDS, _ReferenceQualification, _ReferenceSeries,
                                 reference_series, validate_observation)
from discovery import ZERO, DataError, ReadRpc, KEY_TYPES
from eth_abi import encode
from eth_hash.auto import keccak
from price_history import PriceQualification, PRODUCTION_QUALIFICATIONS
from test_chainlink_history import Archive, PHASE
from test_valuation import sample_window
from valuation import value_window

POOL_KEY = {'currency0': ZERO, 'currency1': USDG, 'fee_pips': 3000, 'tick_spacing': 60, 'hooks': ZERO}
POOL = '0x'+keccak(encode(KEY_TYPES, tuple(POOL_KEY.values()))).hex()


class ChainlinkReferenceTests(unittest.TestCase):
    def setUp(self):
        self.archive = Archive()
        self.rpc = ReadRpc(transport=self.archive, max_requests=2000)
        self.bundle = ChainlinkHistorical(self.rpc, clock=lambda: 1060).fetch(ZERO, 1020, 1055)

    def make(self, bundle=None):
        return reference_series(self.bundle if bundle is None else bundle, POOL, self.rpc, pool_key=POOL_KEY)

    def test_revalidated_reference_is_bounded_and_does_not_qualify_production(self):
        series, evidence = self.make()
        self.assertEqual(evidence['status'], 'reference_analytics_only')
        self.assertEqual(evidence['coverage'], 'complete')
        self.assertFalse(evidence['productionQualified'])
        self.assertFalse(evidence['executionAvailable'])
        self.assertEqual(PRODUCTION_QUALIFICATIONS, {})
        for at in (1019, 1056):
            with self.assertRaisesRegex(DataError, 'coverage_gap'): series.at(at)

    def test_publication_second_uses_previous_round_not_future_answer(self):
        series, _ = self.make()
        previous = Fraction('1.00000001')
        self.assertEqual(series.at(1020), previous)  # answerUpdatedAt alone is insufficient
        self.assertEqual(series.at(1025), previous)  # preceding block has same timestamp
        self.assertEqual(series.at(Fraction(2051, 2)), previous)
        self.assertEqual(series.at(1026), Fraction('90071992547409.93123456'))

    def test_existing_source_policy_is_not_globally_relaxed(self):
        for source in ('alchemy_historical', SOURCE, 'unknown'):
            with self.subTest(source=source), self.assertRaisesRegex(DataError, 'invalid_price_qualification'):
                PriceQualification(ZERO, 18, source, POOL, 'fixture', max_age=MAX_AGE_SECONDS)

    def test_expiry_uses_answer_age_not_retrieval_or_delayed_publication(self):
        row = copy.deepcopy(self.bundle['observations'][0])
        row['retrievedAt'] = 200000
        q = _ReferenceQualification(ZERO, 18, POOL, 'fixture', 1009, 100000, (ZERO, USDG))
        series = _ReferenceSeries(q, [row])
        origin = row['provenance']['answerUpdatedAt']
        self.assertEqual(series.at(origin+86426), Fraction(row['priceUsd']))
        self.assertEqual(series.at(origin+86520), Fraction(row['priceUsd']))
        with self.assertRaisesRegex(DataError, 'coverage_gap'): series.at(Fraction(2*(origin+86520)+1, 2))
        self.assertIn(origin+MAX_AGE_SECONDS, series.boundaries(1009, 100000))

    def test_fractional_gap_and_expired_before_publication_are_unavailable(self):
        row = copy.deepcopy(self.bundle['observations'][0])
        origin = row['provenance']['answerUpdatedAt']
        q = _ReferenceQualification(ZERO, 18, POOL, 'fixture', 1009, 100000, (ZERO, USDG))
        series = _ReferenceSeries(q, [row])
        with self.assertRaisesRegex(DataError, 'coverage_gap'):
            series.require_coverage(origin+86426, origin+86521)
        row['timestamp'] = origin+86521;row['retrievedAt'] = 200000
        expired = _ReferenceSeries(q, [row])
        with self.assertRaisesRegex(DataError, 'coverage_gap'): expired.at(row['timestamp']+1)

    def test_complete_shape_is_required_and_flags_cannot_promote(self):
        original = self.bundle['observations'][0]
        validate_observation(original)
        for field, value in [('proxy', '0x'+'11'*20), ('adapterVersion', 2), ('phaseId', 2),
                             ('currencyDecimals', 6), ('manifestSha256', '0'*64),
                             ('status', 'qualified'), ('feedDecimals', True),
                             ('targetPoolIndependenceVerified', True)]:
            row = copy.deepcopy(original);row['provenance'][field] = value
            with self.subTest(field=field), self.assertRaises(DataError): validate_observation(row)
        row = copy.deepcopy(original);row['priceUsd'] = '2'
        with self.assertRaises(DataError): validate_observation(row)

    def test_source_asset_snapshot_and_feed_identity_mismatches_fail(self):
        for field, value in [('source', 'alchemy_historical'), ('currency', USDG), ('chainId', 1)]:
            bundle = copy.deepcopy(self.bundle);bundle['observations'][0][field] = value
            with self.subTest(field=field), self.assertRaises(DataError): self.make(bundle)
        bundle = copy.deepcopy(self.bundle);bundle['feed']['proxy'] = '0x'+'11'*20
        with self.assertRaises(DataError): self.make(bundle)
        bundle = copy.deepcopy(self.bundle);bundle['snapshot']['hash'] = '0x'+'11'*32
        with self.assertRaisesRegex(DataError, 'reorganized'): self.make(bundle)

    def test_reorganized_publication_predecessor_or_snapshot_is_rejected_on_reuse(self):
        for number in (16, 15, 51, 50, 90, 89, 120):
            self.archive.reorg_number = number
            with self.subTest(number=number), self.assertRaisesRegex(DataError, 'reorganized'): self.make()

    def test_changed_round_or_proxy_configuration_is_rejected_on_reuse(self):
        self.archive.overrides[('latestRoundData()', 51)] = self.archive.rounds[PHASE+2]
        with self.assertRaisesRegex(DataError, 'round_revision'): self.make()
        self.archive.overrides.clear()
        self.archive.overrides[('aggregator()', 120)] = ('0x'+'11'*20,)
        with self.assertRaisesRegex(DataError, 'configuration_changed'): self.make()

    def test_missing_intermediate_or_final_round_cannot_be_silently_held(self):
        for index in (1, 2):
            bundle = copy.deepcopy(self.bundle);bundle['observations'].pop(index)
            with self.subTest(index=index), self.assertRaisesRegex(DataError, 'history_gap'): self.make(bundle)
        bundle = copy.deepcopy(self.bundle);bundle['observations'].pop(0)
        with self.assertRaisesRegex(DataError, 'coverage_gap'): self.make(bundle)

    def test_rpc_errors_never_become_zero_or_cached_success(self):
        self.archive.fail_signature = 'getRoundData(uint80)'
        with self.assertRaisesRegex(DataError, '^rpc_error$'): self.make()

    def test_malformed_coverage_and_noncanonical_currency_fail_safely(self):
        for value in (None, [], 'invalid'):
            bundle = copy.deepcopy(self.bundle);bundle['coverage'] = value
            with self.subTest(value=value), self.assertRaises(DataError): self.make(bundle)
        bundle = ChainlinkHistorical(self.rpc, clock=lambda: 1060).fetch(USDG, 1020, 1055)
        bundle['observations'][0]['currency'] = '0x'+USDG[2:].upper()
        with self.assertRaises(DataError): self.make(bundle)

    def test_target_pool_key_must_hash_to_target_pool_and_contain_asset(self):
        key = {**POOL_KEY, 'fee_pips': 500}
        with self.assertRaises(DataError): reference_series(self.bundle, POOL, self.rpc, pool_key=key)

    def test_partial_capital_window_still_has_no_full_day_apr(self):
        series, _ = self.make()
        window = sample_window(35)
        window['start'], window['end'] = 1020, 1055
        window['events'][0]['timestamp'] += 1020
        window['swaps'][0]['timestamp'] += 1020
        window['currencies'] = [ZERO, USDG]
        stable_bundle = ChainlinkHistorical(self.rpc, clock=lambda: 1060).fetch(USDG, 1020, 1055)
        stable, _ = self.make(stable_bundle)
        result = value_window(window, [series, stable], POOL)
        self.assertEqual(result['status'], 'reference_analytics_only')
        self.assertIsNone(result['feeAprPercent'])
        self.assertFalse(result['complete24h'])
        self.assertEqual(result['feeAprReason'], 'pool_younger_than_window')
        with self.assertRaisesRegex(DataError, 'qualified_usd_prices_required'):
            value_window(window, [series, None], POOL)
        for pair in ([series, series], [stable, series]):
            with self.assertRaisesRegex(DataError, 'currencies_mismatch'):
                value_window(window, pair, POOL)


if __name__ == '__main__':
    unittest.main()
