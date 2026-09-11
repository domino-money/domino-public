"""Real storage/HTTP moving-window and completed-checkpoint recovery regressions."""
from argparse import Namespace
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import psycopg
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chainlink_checkpoint import Checkpoint
from chainlink_collection import (STORAGE_RPC_REQUESTS, collection_blocks, digest, recheck_collection,
                                 begin_collection, store_collection, validate_collection)
from collect_chainlink import collect
from discovery import ZERO, DataError
from metrics_service import stored_metrics
from price_history import AlchemyHistorical, MAX_PRICE_ROWS, SOURCE, PriceQualification, load_price_series, store_observations
from price_quarantine import private_archive, quarantine_collection
from read_api import ReadGate, create_app
from read_service import ReadService
import test_capital_storage as capital_tests
from test_chainlink_collection import archive_at, finish, rpc_for
from test_chainlink_history import Archive
from test_discovery import POOL, TOKEN
from test_position_accounting import SnapshotRpc, block_hash


class MovingSnapshotRpc(SnapshotRpc):
    def request(self, method, params=()):
        if method == 'eth_getBlockByNumber':
            number = 200000 if params[0] == 'latest' else int(params[0], 16)
            return {'number': hex(number), 'timestamp': hex(1000+number), 'hash': block_hash(number)}
        if method == 'eth_getCode':
            assert params[1] == hex(200000)
            return '0x6000'
        return super().request(method, params)

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        assert block == hex(200000) and signature == 'poolManager()'
        return (self.linked_manager,)


class StorageVerificationTests(unittest.TestCase):
    def setUp(self):
        self.archive = Archive()
        self.collection = finish(begin_collection(ZERO, 1020, 1055, rpc_for(self.archive)), self.archive)

    def test_complete_collection_checks_every_unique_header_and_has_finite_budget(self):
        rpc = Mock(wraps=rpc_for(self.archive))
        recheck_collection(self.collection, rpc)
        numbers = {int(call.args[1][0], 16) for call in rpc.request.call_args_list if call.args[0] == 'eth_getBlockByNumber'}
        self.assertEqual(numbers, set(collection_blocks(self.collection)))
        self.assertLessEqual(2 * (len(numbers) + 1), STORAGE_RPC_REQUESTS)
        with patch('chainlink_collection.STORAGE_RPC_REQUESTS', 1), patch('price_history.store_observations') as store:
            with self.assertRaisesRegex(DataError, 'rpc_budget_exhausted'):
                store_collection(Mock(), self.collection, rpc_for(self.archive))
            store.assert_not_called()

    def test_complete_cli_rechecks_before_zero_step_storage(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'checkpoint.json'
            with Checkpoint(path).lock() as checkpoint:
                checkpoint.save(self.collection)
            args = Namespace(currency=ZERO, start=1020, end=1055, max_steps=1, slice_seconds=10,
                checkpoint=path, block_number=None, provider_config=None, store_observations=True)
            for fault in ('snapshot', 'boundary', 'publication', 'unavailable'):
                archive = deepcopy(self.archive)
                if fault != 'unavailable':
                    number = (self.collection['snapshot']['number'] if fault == 'snapshot' else
                              self.collection['slices'][0]['coverage']['endBlock']['number'] if fault == 'boundary' else
                              self.collection['slices'][0]['observations'][0]['provenance']['publicationBlock']['number'])
                    archive.reorg_number = number;archive.header_reads[number] = 5
                    rpc = rpc_for(archive)
                else:
                    rpc = Mock();rpc.request.side_effect = DataError('rpc_unavailable')
                with self.subTest(fault=fault), patch('collect_chainlink.RUNTIME', Path(folder)), \
                        patch('collect_chainlink.configured_catalogue', return_value=Mock()) as configured, \
                        patch('price_history.store_observations') as store:
                    with self.assertRaisesRegex(DataError, 'snapshot_reorganized|rpc_unavailable'):
                        collect(args, rpc=rpc)
                    store.assert_not_called()
                    with Checkpoint(path).lock() as checkpoint:
                        self.assertEqual(checkpoint.load(), self.collection)

    def test_cli_invalid_limits_and_path_do_not_call_rpc(self):
        rpc = Mock()
        with tempfile.TemporaryDirectory() as folder:
            args = Namespace(currency=ZERO, start=1020, end=1055, max_steps=5, slice_seconds=10,
                checkpoint=Path(folder)/'checkpoint.json', block_number=None, provider_config=None,
                store_observations=False)
            for maximum, seconds in ((5, 10), (1, 0), (1, 10)):
                args.max_steps, args.slice_seconds = maximum, seconds
                with self.assertRaises(DataError):collect(args, rpc=rpc)
                rpc.request.assert_not_called();rpc.call.assert_not_called()

    def test_alchemy_window_and_response_capacity_are_explicit(self):
        transport = Mock(return_value={'currency': 'usd', 'symbol': 'ETH', 'data': [{}] * (MAX_PRICE_ROWS + 1)})
        fetcher = AlchemyHistorical('https://robinhood-mainnet.g.alchemy.com/v2/test', transport=transport, clock=lambda: 90000)
        with self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'):
            fetcher.fetch(ZERO, 0, 87000)
        transport.assert_not_called()
        with self.assertRaisesRegex(DataError, 'price_observation_budget_exhausted'):
            fetcher.fetch(ZERO, 0, 86700)
        transport.return_value['data'] = None
        with self.assertRaisesRegex(DataError, 'invalid_price_history_response'):
            fetcher.fetch(ZERO, 0, 86700)


class PrivateArchiveTests(unittest.TestCase):
    def test_existing_archive_is_verified_and_both_file_and_directory_are_synced(self):
        with tempfile.TemporaryDirectory() as folder:
            document = {'evidence': 'unchanged'}
            result = private_archive(folder, document)
            path = Path(folder, result['file']);before = path.stat().st_mtime_ns
            with patch('price_quarantine.os.fsync', wraps=os.fsync) as sync:
                self.assertEqual(private_archive(folder, document), result)
                self.assertEqual(sync.call_count, 2)
            self.assertEqual(path.stat().st_mtime_ns, before)
            raw = path.read_bytes();path.write_bytes(b'x' * len(raw))
            with self.assertRaisesRegex(DataError, 'archive_mismatch'):
                private_archive(folder, document)

    def test_archive_directory_must_exist_privately_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            absent = Path(folder)/'absent'
            with self.assertRaises(FileNotFoundError):private_archive(absent, {})
            self.assertFalse(absent.exists())
            path = Path(folder)/'public';path.mkdir(mode=0o755)
            with self.assertRaisesRegex(DataError, 'private_price_archive_required'):
                private_archive(path, {})
            link = Path(folder)/'link';link.symlink_to(folder, target_is_directory=True)
            with self.assertRaises(OSError):private_archive(link, {})
            with patch('price_quarantine.MAX_ARCHIVE_BYTES', 1):
                with self.assertRaisesRegex(DataError, 'archive_budget_exhausted'):
                    private_archive(folder, {})


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class PriceStorageRecoveryTests(unittest.TestCase):
    settings = capital_tests.CapitalPostgresTests.settings
    setUp = capital_tests.CapitalPostgresTests.setUp
    counts = capital_tests.CapitalPostgresTests.counts
    price = capital_tests.CapitalPostgresTests.price

    def advance_capital(self, through):
        self.capital.step(POOL)
        for end in [*range(10018, through, 10000), through]:
            self.worker.step(POOL, through=end, span=10000)
            self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)

    def client(self, rpc=None, clock=201000):
        rpc = rpc or MovingSnapshotRpc()
        return TestClient(create_app(ReadService(catalogue=self.catalogue, rpc_factory=lambda: rpc, clock=lambda: clock),
                          gate=ReadGate(interval=0)), base_url='http://127.0.0.1', raise_server_exceptions=True)

    def test_two_valid_complete_collections_cross_1446_1447_in_real_moving_window(self):
        # A: one predecessor plus 1445 updates in the last twelve hours. B: its
        # predecessor plus two early updates. Each is valid and bounded independently.
        timestamps = [1500, 1999, *[45200 + i*29 for i in range(1445)], 88401, 88402]
        archive = archive_at([at-1000 for at in timestamps], height=173860)
        a = finish(begin_collection(ZERO, 2000, 88400, rpc_for(archive)), archive, seconds=600)
        b = finish(begin_collection(ZERO, 88400, 174800, rpc_for(archive)), archive)
        self.assertEqual(len(validate_collection(a, complete=True)[1]), MAX_PRICE_ROWS)
        self.assertEqual(len(validate_collection(b, complete=True)[1]), 3)
        store_collection(self.catalogue, a, rpc_for(archive))
        store_collection(self.catalogue, b, rpc_for(archive))
        self.assertEqual(self.counts()[2], MAX_PRICE_ROWS + 2)
        self.advance_capital(130900)  # [45500, 131900], causal lookback includes timestamp45200.
        before = stored_metrics(self.catalogue, POOL)
        self.assertEqual(before['valuation']['reason'], 'price_observation_budget_exhausted')
        # Other unqualified source retains a separate full budget; it cannot mask overflow.
        alchemy = [{**self.price(), 'timestamp': 45500 + i*59, 'retrievedAt': 200000} for i in range(MAX_PRICE_ROWS)]
        store_observations(self.catalogue, alchemy)
        report = self.client().post('/v1/read/pool-metrics', json={'poolId': POOL})
        self.assertEqual(report.status_code, 200, report.text)
        overflow = report.json()
        self.assertEqual(overflow['capital'], before['capital'])
        self.assertEqual(overflow['snapshot'], before['snapshot'])
        self.assertEqual(overflow['revision'], before['revision'])
        self.assertEqual(overflow['valuation']['reason'], 'price_observation_budget_exhausted')
        row = overflow['prices'][0]
        self.assertEqual((row['status'], row['reason']), ('unavailable', 'price_observation_budget_exhausted'))
        self.assertIsNone(row['observations']);self.assertIsNone(row['observedSources'])
        self.assertEqual(row['sourceQualification'], 'not_assessed')
        self.assertEqual(row['coverage']['status'], 'not_assessed')
        missing = overflow['prices'][1]
        self.assertEqual((missing['status'], missing['reason']), ('unavailable', 'price_history_missing'))
        self.assertEqual((missing['observations'], missing['observedSources']), (0, []))
        self.assertEqual(missing['coverage']['status'], 'missing')
        self.assertTrue(all(overflow['valuation'][key] is None for key in
                            ('tvlUsd', 'timeWeightedAverageTvlUsd', 'tradingLpFeesUsd', 'grossInputVolumeUsd', 'feeAprPercent')))
        self.assertFalse(overflow['usableAsCurrent24h'])
        self.worker.step(POOL, through=130901);self.fees.step(POOL);self.positions.step(POOL);self.capital.step(POOL)
        recovered = self.client().post('/v1/read/pool-metrics', json={'poolId': POOL})
        self.assertEqual(recovered.status_code, 200, recovered.text)
        recovered = recovered.json()
        self.assertEqual(recovered['prices'][0]['observations'], 2 * MAX_PRICE_ROWS)
        self.assertEqual(recovered['prices'][0]['status'], 'observed_unqualified')
        self.assertEqual(recovered['prices'][0]['coverage']['status'], 'not_assessed')
        self.assertEqual(recovered['valuation']['reason'], 'qualified_usd_prices_required')
        self.assertIsNone(recovered['valuation']['tvlUsd'])
        evidence_dir = os.environ.get('DOMINO_PRICE_EVIDENCE')
        if evidence_dir:
            Path(evidence_dir).mkdir(exist_ok=True, parents=True)
            Path(evidence_dir, 'moving-window-http.json').write_text(json.dumps({
                'collectionRows': [MAX_PRICE_ROWS, 3], 'overflow': overflow, 'recovered': recovered}, indent=2))

    def test_one_currency_overflow_preserves_other_observed_or_qualified_diagnostics(self):
        self.advance_capital(10000)
        before = stored_metrics(self.catalogue, POOL)
        start, end = 1010, 11000
        for overflowing, retained in ((ZERO, TOKEN), (TOKEN, ZERO)):
            with self.catalogue.connection(writer=True) as conn:
                conn.execute('DELETE FROM domino_activity.price_observations')
            dense = [{**self.price(), 'currency': overflowing, 'timestamp': start+i,
                      'retrievedAt': end} for i in range(MAX_PRICE_ROWS+1)]
            store_observations(self.catalogue, dense[:MAX_PRICE_ROWS])
            store_observations(self.catalogue, dense[MAX_PRICE_ROWS:])
            observations = [{**self.price(), 'currency': retained, 'timestamp': at,
                             'retrievedAt': end} for at in [*range(start, end, 300), end]]
            store_observations(self.catalogue, observations)
            for qualified in (False, True):
                registry = {(POOL, retained): PriceQualification(retained, 18, SOURCE, POOL, 'synthetic_only')} if qualified else {}
                with self.subTest(overflowing=overflowing, qualified=qualified), \
                        patch.dict('price_history.PRODUCTION_QUALIFICATIONS', registry, clear=True):
                    with self.catalogue.connection() as conn:
                        _, expected = load_price_series(conn, POOL, [retained], start, end)
                    response = self.client().post('/v1/read/pool-metrics', json={'poolId': POOL})
                    self.assertEqual(response.status_code, 200, response.text)
                    report = response.json()
                    self.assertEqual([row['currency'] for row in report['prices']], [ZERO, TOKEN])
                    by_currency = {row['currency']: row for row in report['prices']}
                    self.assertEqual(by_currency[retained], expected[0])
                    self.assertEqual(by_currency[retained]['status'], 'qualified' if qualified else 'observed_unqualified')
                    self.assertEqual(by_currency[retained]['observations'], len(observations))
                    self.assertEqual(by_currency[retained]['coverage']['status'], 'complete' if qualified else 'not_assessed')
                    lost = by_currency[overflowing]
                    self.assertEqual((lost['status'], lost['reason']), ('unavailable', 'price_observation_budget_exhausted'))
                    self.assertIsNone(lost['observations']);self.assertIsNone(lost['observedSources'])
                    self.assertEqual(lost['sourceQualification'], 'not_assessed')
                    self.assertEqual(lost['coverage']['status'], 'not_assessed')
                    self.assertEqual(report['capital'], before['capital'])
                    self.assertEqual(report['snapshot'], before['snapshot'])
                    self.assertEqual(report['revision'], before['revision'])
                    self.assertEqual(report['valuation']['reason'], 'price_observation_budget_exhausted')
                    self.assertTrue(all(report['valuation'][key] is None for key in
                        ('tvlUsd', 'timeWeightedAverageTvlUsd', 'tradingLpFeesUsd', 'grossInputVolumeUsd', 'feeAprPercent')))

    def test_real_faults_are_errors_and_never_unavailable_price_states(self):
        self.capital.step(POOL)
        for error, expected in ((DataError('capital_tail_mismatch'), 503),
                                (DataError('rpc_unavailable'), 503),
                                (psycopg.OperationalError('synthetic offline failure'), 503)):
            with self.subTest(error=type(error).__name__), patch('metrics_service.load_price_series', side_effect=error):
                response = self.client(SnapshotRpc(), clock=2000).post('/v1/read/pool-metrics', json={'poolId': POOL})
                self.assertEqual(response.status_code, expected)
                self.assertNotIn('"capital":', response.text)
            # An earlier currency overflow must not suppress a real later fault.
            with patch('metrics_service.load_price_series', side_effect=[DataError('price_observation_budget_exhausted'), error]):
                response = self.client(SnapshotRpc(), clock=2000).post('/v1/read/pool-metrics', json={'poolId': POOL})
                self.assertEqual(response.status_code, expected)
                self.assertNotIn('"capital":', response.text)
        rpc = SnapshotRpc();rpc.orphan = True
        self.assertEqual(self.client(rpc, clock=2000).post('/v1/read/pool-metrics', json={'poolId': POOL}).status_code, 503)

    def complete(self):
        archive = Archive()
        collection = finish(begin_collection(ZERO, 1020, 1055, rpc_for(archive)), archive)
        return collection, archive

    def test_completed_cli_storage_idempotent_and_recheck_failure_rolls_back(self):
        collection, archive = self.complete()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'checkpoint.json'
            with Checkpoint(path).lock() as checkpoint:checkpoint.save(collection)
            args = Namespace(currency=ZERO, start=1020, end=1055, max_steps=1, slice_seconds=10,
                checkpoint=path, block_number=None, provider_config=None, store_observations=True)
            with patch('collect_chainlink.RUNTIME', Path(folder)), patch('collect_chainlink.configured_catalogue', return_value=self.catalogue):
                first = collect(args, rpc=rpc_for(archive));count = self.counts()
                second = collect(args, rpc=rpc_for(archive))
                self.assertEqual(self.counts(), count)
                self.assertEqual((first['stepsCompleted'], second['stepsCompleted']), (0, 0))
                self.assertTrue(first['observationsSaved']);self.assertGreater(first['rpcRequests'], 0)
        with self.catalogue.connection(writer=True) as conn:conn.execute('DELETE FROM domino_activity.price_observations')
        for error in (DataError('chainlink_snapshot_reorganized'), DataError('rpc_unavailable')):
            with patch('chainlink_collection.recheck_collection', side_effect=[None, error]):
                with self.assertRaises(DataError):store_collection(self.catalogue, collection, rpc_for(archive))
            self.assertEqual(self.counts()[2], 0)

    def test_reviewed_orphan_quarantine_preserves_provenance_and_allows_separate_retry(self):
        collection, archive = self.complete()
        store_collection(self.catalogue, collection, rpc_for(archive))
        rows = validate_collection(collection, complete=True)[1];before = self.counts()[2]
        orphan = deepcopy(archive)
        orphan.reorg_number = rows[0]['provenance']['publicationBlock']['number']
        orphan.header_reads[orphan.reorg_number] = 5
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(DataError, 'review_mismatch'):
                quarantine_collection(self.catalogue, collection, rpc_for(orphan), reviewed_sha256='wrong', archive_directory=folder)
            with self.assertRaisesRegex(DataError, 'no_orphans'):
                quarantine_collection(self.catalogue, collection, rpc_for(archive), reviewed_sha256=digest(collection), archive_directory=folder)
            result = quarantine_collection(self.catalogue, collection, rpc_for(orphan),
                reviewed_sha256=digest(collection), archive_directory=folder)
            raw = Path(folder, result['archive']['file']).read_bytes();saved = json.loads(raw)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), result['archive']['sha256'])
            self.assertEqual(saved['collection'], collection)
            self.assertEqual(saved['storedRows'], [rows[0]])
            self.assertEqual(self.counts()[2], before - 1)
            self.assertEqual(Path(folder, result['archive']['file']).stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(DataError, 'no_orphans'):
                quarantine_collection(self.catalogue, collection, rpc_for(orphan), reviewed_sha256=digest(collection), archive_directory=folder)
            # No automatic replacement: original collection still fails current canonicality.
            with self.assertRaisesRegex(DataError, 'snapshot_reorganized'):
                store_collection(self.catalogue, collection, rpc_for(orphan))
            self.assertEqual(self.counts()[2], before - 1)
            # A separate reviewed canonical collection can fill the vacated identity;
            # immutable evidence from the old fork remains in the archive.
            replacement = deepcopy(collection)
            for part in replacement['slices']:
                for row in part['observations']:
                    for key in ('publicationBlock', 'precedingBlock'):
                        if row['provenance'][key]['number'] == orphan.reorg_number:
                            row['provenance'][key]['hash'] = '0x' + 'ff' * 32
            store_collection(self.catalogue, replacement, rpc_for(orphan))
            self.assertEqual(self.counts()[2], before)
            self.assertEqual(json.loads(Path(folder, result['archive']['file']).read_bytes()), saved)

    def test_quarantine_stored_revision_and_concurrent_writer_require_review(self):
        collection, archive = self.complete();store_collection(self.catalogue, collection, rpc_for(archive))
        before = self.counts()
        with tempfile.TemporaryDirectory() as folder:
            with self.catalogue.connection(writer=True, lock=True):
                with self.assertRaisesRegex(DataError, 'writer_busy'):
                    quarantine_collection(self.catalogue, collection, rpc_for(archive),
                        reviewed_sha256=digest(collection), archive_directory=folder)
            with self.catalogue.connection(writer=True) as conn:
                conn.execute("UPDATE domino_activity.price_observations SET price_usd='999'")
            with patch('price_quarantine.private_archive') as archive_writer:
                with self.assertRaisesRegex(DataError, 'stored_revision_mismatch'):
                    quarantine_collection(self.catalogue, collection, rpc_for(archive),
                        reviewed_sha256=digest(collection), archive_directory=folder)
                archive_writer.assert_not_called()
            self.assertEqual(self.counts(), before)

    def test_quarantine_rpc_archive_and_chain_change_failures_preserve_database(self):
        collection, archive = self.complete();store_collection(self.catalogue, collection, rpc_for(archive))
        before = self.counts()
        orphan = deepcopy(archive)
        orphan.reorg_number = collection['slices'][0]['observations'][0]['provenance']['publicationBlock']['number']
        orphan.header_reads[orphan.reorg_number] = 5
        with tempfile.TemporaryDirectory() as folder:
            for fault in ('rpc', 'file_fsync', 'directory_fsync', 'archive_readback', 'chain_change'):
                rpc = rpc_for(orphan)
                if fault == 'rpc':rpc = Mock();rpc.request.side_effect = DataError('rpc_unavailable')
                real_fsync = os.fsync
                def fsync(fd):
                    import stat
                    is_directory = stat.S_ISDIR(os.fstat(fd).st_mode)
                    if is_directory == (fault == 'directory_fsync'):raise OSError('synthetic sync failure')
                    real_fsync(fd)
                def archive_then_reorg(directory, document):
                    result = private_archive(directory, document)
                    orphan.reorg_number = orphan.height;orphan.header_reads[orphan.height] = 5
                    return result
                context = (patch('price_quarantine.private_archive', side_effect=archive_then_reorg) if fault == 'chain_change' else
                           patch('price_quarantine.os.fsync', side_effect=fsync) if 'fsync' in fault else
                           patch('price_quarantine.private_archive', side_effect=DataError('price_quarantine_archive_mismatch')) if fault == 'archive_readback' else
                           patch('price_quarantine.MAX_ARCHIVE_BYTES', 16*1024*1024))
                with self.subTest(fault=fault), context:
                    with self.assertRaises((DataError, OSError)):
                        quarantine_collection(self.catalogue, collection, rpc,
                            reviewed_sha256=digest(collection), archive_directory=folder)
                self.assertEqual(self.counts(), before)
                orphan.reorg_number = collection['slices'][0]['observations'][0]['provenance']['publicationBlock']['number']
            # Existing durable archive is re-read and synced on a retry before deletion.
            result = quarantine_collection(self.catalogue, collection, rpc_for(orphan),
                reviewed_sha256=digest(collection), archive_directory=folder)
            self.assertEqual(result['observations'], 1)


if __name__ == '__main__':
    unittest.main()
