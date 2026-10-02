"""Legacy CLI storage gates against real proof validation and disposable PG."""
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row

from catalogue import PgCatalogue
from chainlink_history import ChainlinkHistorical, USDG
from chainlink_reference import reference_series
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, CHAIN_ID, DataError, ReadRpc, ZERO, PUBLIC_RPC_URL
from price_history import SOURCE, store_observations
import qualify_chainlink as cli
from test_chainlink_history import Archive
from test_chainlink_reference import POOL, POOL_KEY


NOW = 4620
SNAPSHOT = Block(120, Archive.block_hash(120), NOW)


class ControlledArchive(Archive):
    """The normal Archive plus explicit faults at test-controlled boundaries."""
    def __init__(self, control):
        super().__init__()
        # A one-hour CLI interval starts at1020, after its proven predecessor.
        # The quiet tail is valid under the named reference-only age policy.
        self.times[120] = NOW
        self.control = control
        self.currency = None

    def __call__(self, url, body):
        method, params = body['method'], body['params']
        if self.control.get('rpc_failure') or self.control.get('fail_final') and self.currency is None:
            return {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32000}}
        response = super().__call__(url, body)
        if method == 'eth_getBlockByNumber' and 'result' in response:
            number = self.height if params[0] == 'latest' else int(params[0], 16)
            if number in self.control.get('changed_headers', ()):
                response['result']['hash'] = '0x' + 'ee'*32
        return response


class GatedCatalogue(PgCatalogue):
    """Inject a fault only after the actual writer lock, not before validation."""
    def __init__(self, settings):
        super().__init__(settings)
        self.on_write = None
        self.writer_entries = 0

    @contextmanager
    def connection(self, *, writer=False, lock=False):
        with super().connection(writer=writer, lock=lock) as conn:
            if writer and lock:
                self.writer_entries += 1
                if self.on_write is not None:
                    self.on_write()
            yield conn


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL')
class QualifyChainlinkStorageTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def setUp(self):
        self.assertEqual(self.settings['dbname'], 'domino_catalogue_tests')
        self.catalogue = GatedCatalogue(self.settings)
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_activity.price_observations')
        self.control = {}
        self.proofs = {}
        self.archives = []
        self.after_fetch = None
        self.reference_passes = []
        self.seed_legacy()
        self.before = self.snapshot()

    def seed_legacy(self):
        # Existing observations need neither deletion nor silent promotion when
        # a new legacy qualification fails. This is an unrelated old source.
        store_observations(self.catalogue, [{
            'chainId': CHAIN_ID, 'currency': ZERO, 'source': SOURCE,
            'timestamp': 900, 'retrievedAt': 901, 'priceUsd': '123.456',
            'provenance': {'status': 'external_observation_unqualified', 'legacy': True}}])
        self.catalogue.writer_entries = 0

    def snapshot(self):
        return {
            'rows': self.admin.execute('SELECT * FROM domino_activity.price_observations '
                'ORDER BY chain_id,currency,source,observed_at').fetchall(),
            'catalogue': self.admin.execute('SELECT * FROM domino_catalogue.state ORDER BY singleton').fetchall()}

    def rpc(self, *args, **kwargs):
        archive = ControlledArchive(self.control)
        self.archives.append(archive)
        rpc = ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=kwargs.get('max_requests', 1600))
        rpc.test_archive = archive
        return rpc

    def historical(self, rpc, **kwargs):
        actual = ChainlinkHistorical(rpc, clock=lambda: NOW, **kwargs)
        def fetch(currency, start, end, **options):
            rpc.test_archive.currency = currency
            bundle = actual.fetch(currency, start, end, **options)
            self.proofs[currency] = deepcopy(bundle)
            if self.after_fetch is not None:
                self.after_fetch(currency, bundle, rpc.test_archive)
            return bundle
        return SimpleNamespace(fetch=fetch)

    def verify(self, bundle, pool, rpc, **kwargs):
        result = reference_series(bundle, pool, rpc, **kwargs)
        self.reference_passes.append(bundle['observations'][0]['currency'])
        return result

    def qualify(self, *, persist=True):
        reader = SimpleNamespace(snapshot=lambda: SNAPSHOT,
            pool=lambda query, snapshot: {'currencies': [ZERO, USDG], 'poolKey': POOL_KEY,
                                         'identityStatus': 'verified'},
            assert_canonical=lambda snapshot: None)
        # The probe reads the operator's provider file; it never falls back to a public default.
        with patch.object(cli, 'load_config', return_value={'rpcUrl': 'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}), \
             patch.object(cli, 'ReadRpc', side_effect=self.rpc), \
             patch.object(cli, 'DiscoveryReader', return_value=reader), \
             patch.object(cli, 'ChainlinkHistorical', side_effect=self.historical), \
             patch.object(cli, 'reference_series', side_effect=self.verify), \
             patch.object(cli, 'configured_catalogue', return_value=self.catalogue), \
             redirect_stdout(io.StringIO()):
            return cli.qualify(POOL, 1, persist=persist)

    def assert_not_saved(self, report, reason=None):
        self.assertEqual([case['observationsSaved'] for case in report['cases']], [False, False])
        self.assertEqual(self.snapshot(), self.before)
        if reason is not None:
            reasons = [case.get('reason') for case in report['cases']]
            reasons.append(report.get('storage', {}).get('reason'))
            self.assertIn(reason, reasons)
        self.assertFalse(report['productionQualified'])
        self.assertFalse(report['executionAvailable'])

    def test_success_saves_both_real_reference_proofs_and_retry_is_idempotent(self):
        report = self.qualify()
        self.assertTrue(report['referenceCoverageComplete'])
        self.assertEqual([case['observationsSaved'] for case in report['cases']], [True, True])
        self.assertEqual(set(self.reference_passes), {ZERO, USDG})
        self.assertEqual(len(self.snapshot()['rows']), 1 + sum(len(b['observations']) for b in self.proofs.values()))
        saved = self.snapshot()
        self.assertIn(self.before['rows'][0], saved['rows'])
        self.assertEqual(saved['catalogue'], self.before['catalogue'])
        again = self.qualify()
        self.assertTrue(all(case['observationsSaved'] for case in again['cases']))
        self.assertEqual(self.snapshot(), saved)

    def test_without_store_flag_success_does_not_enter_writer_or_change_legacy_rows(self):
        report = self.qualify(persist=False)
        self.assertTrue(report['referenceCoverageComplete'])
        self.assert_not_saved(report)
        self.assertEqual(self.catalogue.writer_entries, 0)

    def test_idempotent_existing_batch_still_rechecks_headers_before_claiming_saved(self):
        self.qualify()
        self.before = self.snapshot()
        self.catalogue.on_write = lambda: self.control.update(changed_headers={51})
        report = self.qualify()
        self.assert_not_saved(report, 'chainlink_snapshot_reorganized')

    def test_cli_returns_failure_and_writes_diagnostics_when_valid_reference_cannot_store(self):
        # A real competing writer prevents this save, while both source proofs
        # remain valid. The command must not turn coverage=true into exit0.
        with self.catalogue.connection(writer=True, lock=True):
            report = self.qualify()
        self.assertTrue(report['referenceCoverageComplete'])
        self.assert_not_saved(report, 'catalogue_writer_busy')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'failed-storage.json'
            args = ['qualify_chainlink.py', '--pool-id', POOL, '--hours', '1',
                    '--store-observations', '--output', str(output)]
            with patch.object(sys, 'argv', args), patch.object(cli, 'qualify', return_value=report):
                self.assertEqual(cli.main(), 1)
            persisted = json.loads(output.read_text())
            self.assertEqual(persisted['storage']['reason'], 'catalogue_writer_busy')
            self.assertEqual([case['observationsSaved'] for case in persisted['cases']], [False, False])
        self.assertEqual(self.snapshot(), self.before)

    def test_rpc_failure_after_fetch_preserves_original_reason_and_blocks_both_assets(self):
        def fail(currency, bundle, archive):
            if currency == USDG:
                archive.fail_signature = 'getRoundData(uint80)'
        self.after_fetch = fail
        report = self.qualify()
        failed = next(case for case in report['cases'] if case['currency'] == USDG)
        self.assertEqual(failed['reason'], 'rpc_error')
        self.assertIn('history', failed)
        self.assert_not_saved(report, 'rpc_error')

    def test_complete_rows_do_not_allow_storage_when_reference_coverage_fails(self):
        def truncate(currency, bundle, archive):
            if currency == USDG:
                bundle['observations'].pop()
        self.after_fetch = truncate
        report = self.qualify()
        failed = next(case for case in report['cases'] if case['currency'] == USDG)
        self.assertEqual(failed['reason'], 'chainlink_reference_history_gap')
        self.assert_not_saved(report, 'chainlink_reference_history_gap')

    def test_source_metadata_failure_keeps_case_reason_and_has_no_partial_write(self):
        def changed_source(currency, bundle, archive):
            if currency == USDG:
                bundle['feed']['proxy'] = '0x' + '11'*20
        self.after_fetch = changed_source
        report = self.qualify()
        self.assertEqual(next(case for case in report['cases'] if case['currency'] == USDG)['reason'],
                         'invalid_chainlink_reference_bundle')
        self.assert_not_saved(report, 'invalid_chainlink_reference_bundle')

    def test_later_snapshot_rpc_failure_cannot_replace_the_original_case_reason(self):
        def fail(currency, bundle, archive):
            if currency == USDG:
                bundle['feed']['proxy'] = '0x' + '11'*20
                self.control['fail_final'] = True
        self.after_fetch = fail
        report = self.qualify()
        self.assertEqual(next(case for case in report['cases'] if case['currency'] == USDG)['reason'],
                         'invalid_chainlink_reference_bundle')
        self.assert_not_saved(report, 'invalid_chainlink_reference_bundle')

    def test_reorganized_publication_predecessor_and_boundary_after_fetch_never_save(self):
        for number in (51, 50, 120):
            with self.subTest(number=number):
                def reorg(currency, bundle, archive):
                    if currency == USDG:
                        archive.reorg_number = number
                        archive.header_reads[number] = max(2, archive.header_reads[number])
                self.after_fetch = reorg
                report = self.qualify()
                self.assert_not_saved(report, 'chainlink_snapshot_reorganized')

    def test_publication_predecessor_and_end_are_rechecked_under_writer_lock(self):
        for number in (51, 50, 120):
            with self.subTest(number=number):
                self.control.clear()
                self.reference_passes.clear()
                self.catalogue.on_write = lambda n=number: self.control.update(changed_headers={n})
                report = self.qualify()
                self.assertEqual(set(self.reference_passes), {ZERO, USDG})
                self.assert_not_saved(report)
                self.assertGreater(self.catalogue.writer_entries, 0)

    def test_rpc_failure_inside_atomic_write_gate_preserves_all_observations(self):
        self.catalogue.on_write = lambda: self.control.update(rpc_failure=True)
        report = self.qualify()
        self.assertEqual(set(self.reference_passes), {ZERO, USDG})
        self.assert_not_saved(report, 'rpc_error')

    def test_conflict_in_last_asset_rolls_back_first_asset_and_preserves_stored_revision(self):
        archive = ControlledArchive({})
        rpc = ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=1600)
        bundle = ChainlinkHistorical(rpc, clock=lambda: NOW).fetch(USDG, NOW-3600, NOW, block_number=120)
        row = bundle['observations'][-1]
        store_observations(self.catalogue, [row])
        # Existing legacy data may predate current proof validation. It must be
        # retained for explicit review, including its original retrieval clock.
        self.admin.execute('UPDATE domino_activity.price_observations SET price_usd=%s '
            'WHERE currency=%s AND source=%s AND observed_at=%s',
            ('999', USDG, row['source'], row['timestamp']))
        self.before = self.snapshot()
        report = self.qualify()
        self.assert_not_saved(report, 'stored_price_revision_requires_review')

    def test_no_storage_guard_is_emitted_until_full_reference_coverage_succeeds(self):
        archive = Archive()
        rpc = ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=2000)
        bundle = ChainlinkHistorical(rpc, clock=lambda: 1060).fetch(ZERO, 1020, 1055)
        bundle['observations'].pop()
        guards = []
        with self.assertRaisesRegex(DataError, '^chainlink_reference_history_gap$'):
            reference_series(bundle, POOL, rpc, pool_key=POOL_KEY, on_verified=guards.append)
        self.assertEqual(guards, [])
        self.assertEqual(self.snapshot(), self.before)

    def test_saved_guard_retains_publication_predecessor_end_successor_and_snapshot_headers(self):
        # The normal CLI ends at its snapshot. This real shorter historical
        # bundle also exercises a distinct endBlock and its required successor.
        for number in (51, 50, 111, 112, 120):
            with self.subTest(number=number):
                archive = Archive()
                rpc = ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=2000)
                bundle = ChainlinkHistorical(rpc, clock=lambda: 1060).fetch(ZERO, 1020, 1055)
                self.assertEqual(bundle['coverage']['endBlock']['number'], 111)
                guards = []
                reference_series(bundle, POOL, rpc, pool_key=POOL_KEY, on_verified=guards.append)
                self.assertEqual(len(guards), 1)
                def change_required_header():
                    archive.reorg_number = number
                    archive.header_reads[number] = max(2, archive.header_reads[number])
                self.catalogue.on_write = change_required_header
                with self.assertRaisesRegex(DataError, '^chainlink_snapshot_reorganized$'):
                    store_observations(self.catalogue, bundle['observations'], before_commit=guards[0])
                self.assertEqual(self.snapshot(), self.before)

    def test_storage_guard_rejects_changed_chain_without_committing_valid_rows(self):
        archive = Archive()
        rpc = ReadRpc(PUBLIC_RPC_URL, transport=archive, max_requests=2000)
        bundle = ChainlinkHistorical(rpc, clock=lambda: 1060).fetch(ZERO, 1020, 1055)
        guards = []
        reference_series(bundle, POOL, rpc, pool_key=POOL_KEY, on_verified=guards.append)
        self.catalogue.on_write = lambda: setattr(archive, 'chain_id', CHAIN_ID+1)
        with self.assertRaisesRegex(DataError, '^wrong_chain$'):
            store_observations(self.catalogue, bundle['observations'], before_commit=guards[0])
        self.assertEqual(self.snapshot(), self.before)

    def test_bundle_integrity_is_rechecked_before_and_after_write_gate_rpc(self):
        for timing in ('before', 'during_rpc'):
            with self.subTest(timing=timing):
                archive = Archive()
                armed = []
                def transport(url, request):
                    result = archive(url, request)
                    if armed:
                        armed.clear()
                        bundle['feed']['description'] = 'changed during storage recheck'
                    return result
                rpc = ReadRpc(PUBLIC_RPC_URL, transport=transport, max_requests=2000)
                bundle = ChainlinkHistorical(rpc, clock=lambda: 1060).fetch(ZERO, 1020, 1055)
                guards = []
                reference_series(bundle, POOL, rpc, pool_key=POOL_KEY, on_verified=guards.append)
                def modify_evidence():
                    if timing == 'before':
                        bundle['feed']['description'] = 'changed after validation'
                    else:
                        armed.append(True)
                self.catalogue.on_write = modify_evidence
                with self.assertRaisesRegex(DataError, '^chainlink_reference_bundle_changed$'):
                    store_observations(self.catalogue, bundle['observations'], before_commit=guards[0])
                self.assertEqual(self.snapshot(), self.before)


if __name__ == '__main__':
    unittest.main()
