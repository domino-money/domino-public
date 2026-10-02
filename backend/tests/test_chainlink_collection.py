"""Synthetic archive, checkpoint and full-day reference evidence; never live RPC."""
from argparse import Namespace
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chainlink_checkpoint import Checkpoint, MAX_CHECKPOINT_BYTES
from chainlink_collection import (BudgetRpc, DEFAULT_SLICE_SECONDS, MAX_SLICES, MAX_TOTAL_ROWS,
    advance_collection, begin_collection, canonical, digest, validate_collection)
from chainlink_history import ChainlinkHistorical, MAX_ROUNDS
from chainlink_reference import MAX_AGE_SECONDS, reference_series, reference_series_from_slices
from collect_chainlink import collect
from discovery import ZERO, DataError, ReadRpc, PUBLIC_RPC_URL
from price_history import MAX_PRICE_ROWS, PRODUCTION_QUALIFICATIONS, PriceQualification, PriceSeries
from test_chainlink_history import Archive, PHASE
from test_chainlink_reference import POOL, POOL_KEY


def archive_at(publications, *, height=None):
    archive = Archive()
    archive.height = max(publications)+60 if height is None else height
    archive.times = {n: 1000+n for n in range(archive.height+1)}
    archive.rounds, archive.publications = {}, {}
    for index, at in enumerate(publications, 1):
        rid, updated = PHASE+index, 1000+at
        archive.rounds[rid] = (rid, 100000000+index, updated, updated, rid)
        archive.publications[rid] = at
    return archive


def rpc_for(archive):
    return ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=50000)


def finish(collection, archive, *, seconds=DEFAULT_SLICE_SECONDS):
    while validate_collection(collection)[0] != collection['endTimestamp']:
        collection = advance_collection(collection, rpc_for(archive), slice_seconds=seconds,
                                        clock=lambda: archive.times[archive.height])
    return collection


class ChainlinkCollectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.archive = archive_at(list(range(60, 86581, 60)))
        cls.collection = begin_collection(ZERO, 1180, 87580, rpc_for(cls.archive))
        cls.complete = finish(cls.collection, cls.archive)

    def test_full_day_minute_feed_uses_bounded_slices_and_all_exact_updates(self):
        c = self.complete
        end, rows = validate_collection(c, complete=True)
        self.assertEqual(end-c['startTimestamp'], 86400)
        self.assertEqual(len(c['slices']), 24)
        self.assertTrue(all(1 <= len(s['observations']) <= MAX_ROUNDS for s in c['slices']))
        expected = [1000+at for at in self.archive.publications.values() if 120 <= at <= 86580]
        self.assertEqual([r['timestamp'] for r in rows], expected)
        self.assertGreater(len(rows), 600)
        self.assertLessEqual(len(rows), MAX_PRICE_ROWS)
        series, evidence = reference_series_from_slices(c, POOL, rpc_for(self.archive), pool_key=POOL_KEY)
        series.require_coverage(1180, 87580)
        self.assertEqual(evidence['snapshot'], self.collection['snapshot'])
        self.assertEqual(evidence['maxAgeSeconds'], 86520)
        self.assertEqual(evidence['observationCount'], len(rows))
        self.assertEqual(evidence['evidenceSha256'], digest(c))
        self.assertFalse(evidence['productionQualified'])
        self.assertFalse(evidence['executionAvailable'])
        self.assertEqual(PRODUCTION_QUALIFICATIONS, {})
        # The old single-fetch factory must not silently accept this wider form.
        bundle = {**c['slices'][-1], 'observations': rows}
        with self.assertRaisesRegex(DataError, 'invalid_chainlink_reference_bundle'):
            reference_series(bundle, POOL, rpc_for(self.archive), pool_key=POOL_KEY)

    def test_atomic_full_day_fetch_still_has_64_round_budget(self):
        with self.assertRaisesRegex(DataError, 'chainlink_round_budget_exhausted'):
            ChainlinkHistorical(rpc_for(self.archive), clock=lambda: 87640).fetch(ZERO, 1180, 87580)
        self.assertEqual(MAX_ROUNDS, 64)

    def test_mixed_cadence_burst_can_resume_with_smaller_controlled_slices(self):
        archive = archive_at(sorted(set(range(60, 2001, 60)) | set(range(600, 680))), height=2060)
        c = begin_collection(ZERO, 1180, 3000, rpc_for(archive))
        c = advance_collection(c, rpc_for(archive), slice_seconds=300, clock=lambda: 3060)
        before = deepcopy(c)
        with self.assertRaisesRegex(DataError, '^chainlink_slice_too_dense$'):
            advance_collection(c, rpc_for(archive), slice_seconds=600, clock=lambda: 3060)
        self.assertEqual(c, before)
        c = finish(c, archive, seconds=30)
        _, rows = validate_collection(c, complete=True)
        self.assertTrue(set(range(1600, 1680)).issubset({r['timestamp'] for r in rows}))
        reference_series_from_slices(c, POOL, rpc_for(archive), pool_key=POOL_KEY)

    def test_incomplete_changed_identity_conflicting_overlap_and_duplicate_fail(self):
        with self.assertRaisesRegex(DataError, 'collection_incomplete'):
            reference_series_from_slices(self.collection, POOL, rpc_for(self.archive), pool_key=POOL_KEY)
        for kind in ('identity', 'hole', 'overlap', 'duplicate', 'credential'):
            c = deepcopy(self.complete)
            if kind == 'identity':
                c['snapshot']['timestamp'] += 1
            elif kind == 'hole':
                c['slices'][1]['coverage']['startTimestamp'] += 1
            elif kind == 'overlap':
                row = c['slices'][1]['observations'][0]
                row['provenance']['precedingBlock']['hash'] = '0x'+'aa'*32
            elif kind == 'duplicate':
                c['slices'][0]['observations'][1] = deepcopy(c['slices'][0]['observations'][0])
            else:
                c['slices'][0]['observations'][0]['provenance']['rpcUrl'] = 'must_not_enter_checkpoint'
            with self.subTest(kind=kind), self.assertRaises(DataError):
                validate_collection(c)

    def test_observation_retrieval_time_does_not_relabel_original_snapshot(self):
        c = deepcopy(self.complete)
        for part in c['slices']:
            for row in part['observations']:
                row['retrievedAt'] += 100000
        _, evidence = reference_series_from_slices(c, POOL, rpc_for(self.archive), pool_key=POOL_KEY)
        self.assertEqual(evidence['snapshot'], self.collection['snapshot'])
        self.assertEqual(evidence['endTimestamp'], 87580)

    def test_reorganized_old_snapshot_or_intermediate_boundary_is_rejected(self):
        for number in (self.complete['snapshot']['number'], self.complete['slices'][3]['coverage']['endBlock']['number']):
            with self.subTest(number=number):
                archive = deepcopy(self.archive)
                archive.reorg_number = number
                archive.header_reads[number] = 2
                with self.assertRaisesRegex(DataError, 'chainlink_snapshot_reorganized'):
                    reference_series_from_slices(self.complete, POOL, rpc_for(archive), pool_key=POOL_KEY)
        archive = deepcopy(self.archive)
        archive.reorg_number = self.collection['snapshot']['number']
        archive.header_reads[archive.reorg_number] = 2
        with self.assertRaisesRegex(DataError, 'chainlink_snapshot_reorganized'):
            advance_collection(self.collection, rpc_for(archive), clock=lambda: 87640)

    def test_global_slices_rows_time_and_rpc_limits_remain_finite(self):
        self.assertEqual(MAX_SLICES, 1446)
        self.assertEqual(MAX_TOTAL_ROWS, 4338)
        c = deepcopy(self.collection);c['slices'] = [{}] * (MAX_SLICES+1)
        with self.assertRaisesRegex(DataError, 'slice_budget_exhausted'):
            validate_collection(c)
        for value in (0, DEFAULT_SLICE_SECONDS+1, True):
            with self.assertRaises(DataError):
                advance_collection(self.collection, Mock(), slice_seconds=value)
        underlying = Mock()
        bounded = BudgetRpc(underlying, max_requests=1, seconds=1, monotonic=lambda: 0)
        bounded.request('eth_chainId')
        with self.assertRaisesRegex(DataError, 'rpc_budget_exhausted'):
            bounded.request('eth_chainId')
        self.assertEqual(underlying.request.call_count, 1)
        bounded = BudgetRpc(underlying, max_requests=1, seconds=1, monotonic=Mock(side_effect=[0, 0, 2]))
        with self.assertRaisesRegex(DataError, 'deadline_exhausted'):
            bounded.request('eth_chainId')

    def test_slow_reference_feed_can_cover_day_only_under_named_reference_policy(self):
        archive = archive_at([60, 120], height=86521)
        c = begin_collection(ZERO, 1121, 87521, rpc_for(archive))
        c = finish(c, archive)
        _, rows = validate_collection(c, complete=True)
        self.assertEqual(len(rows), 1)
        series, evidence = reference_series_from_slices(c, POOL, rpc_for(archive), pool_key=POOL_KEY)
        series.require_coverage(1121, 87521)
        self.assertEqual(evidence['maxAgeSeconds'], MAX_AGE_SECONDS)
        q = PriceQualification(ZERO, 18, rows[0]['source'], POOL, 'synthetic_only')
        with self.assertRaisesRegex(DataError, 'qualified_price_coverage_gap'):
            PriceSeries(q, rows).require_coverage(1121, 87521)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'collection.json'
        self.archive = Archive()
        self.collection = begin_collection(ZERO, 1020, 1055, rpc_for(self.archive))

    def args(self, **kwargs):
        return Namespace(currency=ZERO, start=1020, end=1055, max_steps=1,
            slice_seconds=10, checkpoint=self.path, block_number=None, provider_config=None,
            store_observations=False, **kwargs)

    def test_atomic_private_roundtrip_hash_and_untrusted_extra_field(self):
        with Checkpoint(self.path).lock() as checkpoint:
            checkpoint.save(self.collection)
            self.assertEqual(checkpoint.load(), self.collection)
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
            content = json.loads(self.path.read_text())
            content['collection']['startTimestamp'] += 1
            self.path.write_bytes(canonical(content))
            with self.assertRaisesRegex(DataError, 'hash_mismatch'):
                checkpoint.load()
        self.path.chmod(0o644)
        with Checkpoint(self.path).lock() as checkpoint:
            with self.assertRaisesRegex(DataError, 'private_chainlink_checkpoint_required'):
                checkpoint.load()

    def test_symlink_oversize_duplicate_key_and_concurrent_writer_rejected(self):
        with Checkpoint(self.path).lock() as checkpoint:
            with self.assertRaisesRegex(DataError, 'checkpoint_busy'):
                with Checkpoint(self.path).lock():
                    pass
            checkpoint.save(self.collection)
            with self.path.open('r+b') as stream:
                stream.truncate(MAX_CHECKPOINT_BYTES+1)
            with self.assertRaisesRegex(DataError, 'checkpoint_too_large'):
                checkpoint.load()
            self.path.write_text('{"collection":{},"collection":{}}')
            with self.assertRaisesRegex(DataError, 'invalid_chainlink_checkpoint'):
                checkpoint.load()
        target = self.path.with_suffix('.target');self.path.rename(target);self.path.symlink_to(target)
        with Checkpoint(self.path).lock() as checkpoint:
            with self.assertRaises(OSError):
                checkpoint.load()
            with self.assertRaisesRegex(DataError, 'private_chainlink_checkpoint_required'):
                checkpoint.save(self.collection)

    def test_cli_resumes_pinned_snapshot_and_checks_identity_before_rpc(self):
        with patch('collect_chainlink.RUNTIME', Path(self.tmp.name)):
            first = collect(self.args(), rpc=rpc_for(self.archive), clock=lambda: 1060)
            self.assertEqual(first['stepsCompleted'], 1)
            self.assertEqual(first['status'], 'collection_incomplete')
            args = self.args();args.start += 1
            rpc = Mock()
            with self.assertRaisesRegex(DataError, 'identity_mismatch'):
                collect(args, rpc=rpc)
            rpc.request.assert_not_called()
            while first['status'] != 'observed_unqualified':
                first = collect(self.args(), rpc=rpc_for(self.archive), clock=lambda: 1060)
            self.assertEqual(first['snapshot'], self.collection['snapshot'])
            self.assertFalse(first['productionQualified'])
            with Checkpoint(self.path).lock() as checkpoint:
                complete = checkpoint.load()
            validate_collection(complete, complete=True)
            reference_series_from_slices(complete, POOL, rpc_for(self.archive), pool_key=POOL_KEY)

    def test_cli_limits_and_nonignored_path_reject_before_rpc(self):
        for key, value in (('max_steps', 5), ('slice_seconds', 0)):
            args = self.args();setattr(args, key, value)
            with self.assertRaises(DataError):
                collect(args, rpc=Mock())
        with self.assertRaisesRegex(DataError, 'ignored_chainlink_checkpoint_path_required'):
            collect(self.args(), rpc=Mock())


if __name__ == '__main__':
    unittest.main()
