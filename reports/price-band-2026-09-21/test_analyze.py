"""Synthetic regression cases for exact guard math and imperfect sampling."""
import copy
from fractions import Fraction
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import random
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('price_band_analyze', Path(__file__).with_name('analyze.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
POOL = '0x' + 'ab' * 32
OTHER = '0x' + 'cd' * 32


def sample(at, price=2**96, block=1, error=None):
    row = {'poolId': POOL, 'sqrtPriceX96': str(price), 'tick': 0}
    if error is not None:
        row['error'] = error
    return {'observedAtUnixMs': at, 'blockNumber': block, 'blockTimestamp': at//1000,
            'rpcLatencyMs': 12.25, 'pools': [row]}


def data(*samples):
    return {'pools': [{'poolId': POOL, 'label': 'synthetic'}], 'samples': list(samples),
            'metadata': {'source': 'synthetic spot-to-spot'}}


def delay(document, milliseconds=500):
    return a.analyze(document, (milliseconds,))['pools'][0]['delays'][0]


class AnalyzerTests(unittest.TestCase):
    def test_exact_boundary_uses_later_spot_denominator(self):
        self.assertTrue(a.within_band(19900, 20000, 50))
        self.assertFalse(a.within_band(19899, 20000, 50))
        self.assertTrue(a.within_band(20100, 20000, 50))
        self.assertFalse(a.within_band(20101, 20000, 50))
        # The reverse pair has a different denominator and must be rejected.
        self.assertFalse(a.within_band(20000, 19900, 50))

    def test_uint160_one_unit_boundary_is_not_rounded_by_float(self):
        spot = 2**150
        limit = spot*50//10000
        self.assertTrue(a.within_band(spot+limit, spot, 50))
        self.assertFalse(a.within_band(spot+limit+1, spot, 50))
        self.assertFalse(a.within_band(0, spot, 50))
        self.assertFalse(a.within_band(spot, 0, 50))
        for bad in (True, 1.0, '1'):
            with self.assertRaises(ValueError):
                a.within_band(bad, spot, 50)

    def test_random_integer_replay_matches_both_solidity_products(self):
        rng = random.Random(20260921)
        for _ in range(1000):
            reference, spot = rng.randrange(1, 2**160), rng.randrange(1, 2**160)
            band = rng.choice(a.BANDS_BPS)
            expected = spot*(10000-band) <= reference*10000 <= spot*(10000+band)
            self.assertEqual(a.within_band(reference, spot, band), expected)

    def test_drift_and_rejection_denominators(self):
        row = delay(data(sample(0, 19900, 1), sample(500, 20000, 2)))
        self.assertEqual(row['validPricePairs'], 1)
        self.assertEqual(row['absoluteSqrtDriftBps']['max'], '50.000000000000')
        self.assertEqual(row['absolutePriceDriftBps']['max'], '99.750000000000')
        self.assertEqual(row['bands']['50']['accepted'], 1)
        self.assertEqual(row['bands']['25']['rejectionRatePercent'], '100.000000000000')
        self.assertEqual(row['bands']['50']['acceptedWithinBlockWindow'], 1)

    def test_first_future_missing_is_not_skipped(self):
        document = data(sample(0, 20000, 1), sample(500, 20100, 2, 'timeout'), sample(600, 20000, 3))
        row = delay(document)
        self.assertEqual(row['futureMissing'], 1)
        self.assertEqual(row['referenceMissing'], 1)
        self.assertEqual(row['noFutureSample'], 1)
        self.assertEqual(row['validPricePairs'], 0)
        self.assertIsNone(row['bands']['50']['rejectionRatePercent'])
        self.assertIsNone(row['absoluteSqrtDriftBps']['p99'])

    def test_actual_delay_and_overshoot_are_explicit(self):
        row = delay(data(sample(0, block=1), sample(490, block=2), sample(800, block=3)))
        self.assertEqual(row['validPricePairs'], 1)
        self.assertEqual(row['actualDelayMs']['max'], '800.000000000000')
        self.assertEqual(row['delayOvershootMs']['max'], '300.000000000000')
        self.assertEqual(row['noFutureSample'], 2)

    def test_block_window_boundaries_are_distinct_from_band_pass(self):
        for distance, category in ((0, 'not_strictly_older'), (-1, 'not_strictly_older'),
                                   (255, 'within_1_to_255_blocks'), (256, 'exceeds_255_blocks')):
            with self.subTest(distance=distance):
                row = delay(data(sample(0, block=10), sample(500, block=10+distance)))
                self.assertEqual(row['bands']['25']['accepted'], 1)
                self.assertEqual(row['blockWindow'][category], 1)
                self.assertEqual(row['bands']['25']['acceptedWithinBlockWindow'], int(distance == 255))
        unknown = sample(500)
        unknown.pop('blockNumber')
        self.assertEqual(delay(data(sample(0), unknown))['blockWindow']['unavailable'], 1)

    def test_unchanged_samples_do_not_claim_safety_or_movement(self):
        result = a.analyze(data(*(sample(i*500, block=i+1) for i in range(8))))
        pool = result['pools'][0]
        self.assertEqual(pool['movementEvidence'], 'no_observed_price_change')
        self.assertEqual(pool['quality']['unchangedAdjacentPairs'], 7)
        self.assertEqual(pool['quality']['changedAdjacentPairs'], 0)
        self.assertEqual(result['rpcLatencyMs']['p99'], '12.250000000000')
        self.assertIn('No independently sourced price', result['limitations'][0])
        self.assertNotIn('safe', result)
        self.assertEqual(a.analyze(data(sample(0)))['pools'][0]['movementEvidence'], 'insufficient_valid_samples')

    def test_quality_covers_missing_invalid_and_duplicate_reads(self):
        absent, duplicate = sample(500), sample(1000)
        absent['pools'] = []
        duplicate['pools'] *= 2
        document = data(sample(0, 0), absent, duplicate, sample(1500, error='rpc failure'))
        result = a.analyze(document)['pools'][0]
        self.assertEqual(result['quality']['missingPriceSamples'], 4)
        self.assertEqual(result['quality']['missingReasons'],
            {'invalid_sqrt_price': 1, 'absent_pool': 1, 'duplicate_pool': 1, 'reported_error': 1})
        self.assertEqual(result['movementEvidence'], 'unavailable')

    def test_pool_rows_are_independent_and_quantities_allow_hex(self):
        document = data(sample(0, 19900, '0x1'), sample(500, 20000, '2'))
        document['pools'].append({'poolId': OTHER})
        document['samples'][0]['pools'][0]['sqrtPriceX96'] = hex(19900)
        document['samples'][1]['pools'].append({'poolId': OTHER, 'sqrtPriceX96': '1'})
        original = copy.deepcopy(document)
        result = a.analyze(document, (500,))
        self.assertEqual(result['pools'][0]['delays'][0]['bands']['50']['accepted'], 1)
        self.assertEqual(result['pools'][1]['delays'][0]['referenceMissing'], 1)
        self.assertEqual(document, original)

    def test_nearest_rank_and_empty_statistics(self):
        stats = a.statistics([Fraction(i, 3) for i in range(1, 21)])
        self.assertEqual(stats['p50'], '3.333333333333')
        self.assertEqual(stats['p95'], '6.333333333333')
        self.assertEqual(stats['p99'], '6.666666666667')
        self.assertIsNone(a.statistics([])['max'])

    def test_bad_time_and_metadata_fail_instead_of_reordering(self):
        for document in (data(sample(500), sample(0)), data(sample(0.1)),
                         {'samples': [], 'pools': []}, {'samples': []},
                         {'samples': [], 'pools': [{'poolId': 'bad'}]}):
            with self.subTest(document=document), self.assertRaises(ValueError):
                a.analyze(document)
        document = data()
        result = a.analyze(document)
        self.assertEqual(result['sampleCount'], 0)
        self.assertIsNone(result['observedSpanMs'])

    def test_cli_writes_json_without_network_or_mutating_input(self):
        with tempfile.TemporaryDirectory() as folder:
            source, target = Path(folder)/'input.json', Path(folder)/'output.json'
            document = data(sample(0), sample(500, block=2))
            source.write_text(json.dumps(document))
            a.main([str(source), '--out', str(target)])
            result = json.loads(target.read_text())
            self.assertEqual(result['sampleCount'], 2)
            self.assertEqual(result['inputSha256'], sha256(source.read_bytes()).hexdigest())
            self.assertEqual(result['inputByteLength'], len(source.read_bytes()))
            self.assertEqual(json.loads(source.read_text()), document)

    def test_completed_record_provenance_remains_descriptive_only(self):
        document = data(sample(0, block=1), sample(500, block=2))
        fields = dict(status='completed', source='synthetic source',
            startedAtUTC='2026-09-21T00:00:00Z', endedAtUTC='2026-09-21T00:00:01Z',
            collectorSha256='ab'*32, canonicalityCheckedBlocks=2, noncanonicalBlocks=[])
        document.update(fields)
        result = a.analyze(document)
        self.assertEqual(result['inputRecord'], fields)
        self.assertEqual(result['qualificationStatus'], 'completed_descriptive_collection_only')
        self.assertFalse(result['productionQualificationComplete'])
        self.assertIsNone(result['inputSha256'])  # No byte representation supplied to the pure API.
        for updates, expected in (
            ({'status': None}, 'not_qualified_collection_status_unavailable'),
            ({'status': 'running'}, 'not_qualified_incomplete_collection'),
            ({'status': 'failed'}, 'not_qualified_incomplete_collection'),
            ({'endedAtUTC': None}, 'not_qualified_incomplete_provenance'),
            ({'collectorSha256': None}, 'not_qualified_incomplete_provenance'),
            ({'canonicalityCheckedBlocks': None}, 'not_qualified_canonicality_unavailable'),
            ({'canonicalityCheckedBlocks': 1}, 'not_qualified_incomplete_canonicality'),
            ({'noncanonicalBlocks': [1]}, 'not_qualified_noncanonical_input'),
            ({'status': 'noncanonical_samples_detected', 'noncanonicalBlocks': []}, 'not_qualified_noncanonical_input'),
        ):
            with self.subTest(updates=updates):
                changed = a.analyze({**document, **updates})
                self.assertEqual(changed['qualificationStatus'], expected)
                self.assertFalse(changed['productionQualificationComplete'])
                self.assertEqual(changed['pools'][0]['delays'][0]['validPricePairs'], 1)

    def test_default_long_delays_expose_expiry_despite_no_price_movement(self):
        result = a.analyze(data(sample(0, block=1), sample(30000, block=301), sample(60000, block=601)))
        self.assertEqual(result['method']['requestedDelaysMs'], [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000])
        self.assertEqual(result['qualificationStatus'], 'not_qualified_collection_status_unavailable')
        for row in result['pools'][0]['delays'][-2:]:
            self.assertGreater(row['bands']['2000']['accepted'], 0)
            self.assertEqual(row['bands']['2000']['acceptedWithinBlockWindow'], 0)
            self.assertEqual(row['blockWindow']['exceeds_255_blocks'], row['validPricePairs'])


if __name__ == '__main__':
    unittest.main()
