"""Scoped source/SQL/rollback regressions. No real host installer is invoked."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upgrade_financial as financial

REPO = Path(__file__).resolve().parents[3]
# Named for the public collector, which owns most of them; 027 is the
# foundation's own session-gate removal, packaged the same way.
PACKAGED_ONLY_MIGRATIONS = (
    'backend/migrations/023_pool_request_scheduling.sql',
    'backend/migrations/024_public_observations.sql',
    'backend/migrations/025_public_history.sql',
    'backend/migrations/026_public_demand.sql',
    'backend/migrations/027_remove_wallet_access_gate.sql',
    'backend/migrations/028_automation_cycle.sql',
    'backend/migrations/029_ledger_index.sql',
    'backend/migrations/030_swap_exposure.sql',
    'backend/migrations/031_publication_resend.sql',
    'backend/migrations/032_shared_gas_budget.sql',
    'backend/migrations/033_gas_budget_claim_read.sql',
    'backend/migrations/034_gas_settlement_sweep.sql',
    'backend/migrations/035_cancel_unsigned_gas_claims.sql',
    'backend/migrations/036_gas_settlement_journal_read.sql',
    'backend/migrations/037_gas_settlement_receipt_evidence.sql',
    'backend/migrations/038_gas_settlement_quote_witness.sql',
    'backend/migrations/039_automation_readiness.sql',
    'backend/migrations/040_gas_finalized_quote_lag.sql',
    'backend/migrations/041_session_delegated_accounts.sql',
    'backend/migrations/042_provider_priority.sql',
    'backend/migrations/043_featured_pools.sql',
    'backend/migrations/044_demand_horizon.sql',
    'backend/migrations/045_featured_live.sql',
    'backend/migrations/046_gas_answer_heartbeat.sql',
    'backend/migrations/047_provider_ceiling.sql',
    # The V2 index (read-v6): applied with the V2 indexer's installation, never by this upgrade.
    'backend/migrations/052_v2_index.sql',
    # The ledgers' per-chunk index: applied by apply_migrations.py, never by this upgrade.
    'backend/migrations/053_activity_chunk_index.sql',
)


class FinancialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-financial-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.path), cls.commit], cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.path.read_bytes()).hexdigest()
        cls.files = financial.archive_files(cls.path, cls.digest, cls.commit)
        cls.planned = financial.plan(cls.files, cls.commit, cls.digest)

    def test_real_git_archive_and_no_git_cli_plan(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/upgrade_financial.py'),
                                 '--archive', str(self.path), '--archive-sha256', self.digest,
                                 '--commit', self.commit], capture_output=True, text=True,
                                env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertFalse(self.planned['servicesStarted'])
        # Only the registered financial upgrade migrations are applied.
        self.assertEqual([row['path'] for row in self.planned['migrations']],
                         list(financial.MIGRATIONS))
        self.assertEqual(financial.PACKAGED_ONLY_MIGRATIONS,PACKAGED_ONLY_MIGRATIONS)
        self.assertEqual(self.planned['packagedOnlyMigrations'],
                         [{'path':p,'sha256':financial.sha(self.files[p][0])}
                          for p in PACKAGED_ONLY_MIGRATIONS if p in self.files])
        self.assertEqual(set(self.planned['units']), {'domino-' + c + '.service' for c in financial.COMPONENTS})

    def test_units_scope_off_and_private_namespaces(self):
        for component in financial.COMPONENTS:
            text = financial.unit_text(component, self.commit)
            self.assertIn('IPAddressDeny=any\nIPAddressAllow=localhost\n', text)
            self.assertIn('BindReadOnlyPaths=/etc/domino/financial/' + component, text)
            self.assertNotIn('[Install]', text)
            self.assertNotIn('WantedBy=', text)
            self.assertNotIn('domino-dev', text)
            if component not in ('performance-collector', 'execution-signer'):
                self.assertNotIn('--enable', text)
            else:
                self.assertIn('ConditionPathExists=/etc/domino/financial/' + component + '/profile.json', text)
        for component in financial.OLD_COMPONENTS:
            self.assertIn('/releases/' + financial.OLD + '/' + component + '/backend/runtime:',
                          financial.unit_text(component, self.commit))
        signer = financial.unit_text('execution-signer', self.commit)
        self.assertIn('Type=oneshot', signer)
        self.assertNotIn('--key', signer)
        self.assertIn('Restart=no', signer)

    def test_only_financial_upgrade_migrations_are_executed(self):
        # Foundation and public files carry sentinels: even their contents must
        # never be included in upgrade DDL or its applied migration receipt.
        files = dict(self.files)
        for index, name in enumerate(financial.base.MIGRATIONS):
            files[name] = (f'RAISE_FOUNDATION_REPLAY_{index};'.encode(), False)
        files['backend/schema.sql'] = (b'RAISE_CANDIDATE_SCHEMA_REPLAY;', False)
        for index,name in enumerate(PACKAGED_ONLY_MIGRATIONS):
            files[name]=(f'RAISE_PACKAGED_ONLY_{index};'.encode(),False)
        query = financial.migration_sql(files, self.planned)
        self.assertNotIn('RAISE_FOUNDATION_REPLAY', query)
        self.assertNotIn('RAISE_CANDIDATE_SCHEMA_REPLAY', query)
        self.assertNotIn('RAISE_PACKAGED_ONLY', query)
        for name in PACKAGED_ONLY_MIGRATIONS:self.assertNotIn(name,query)
        self.assertTrue(query.startswith('BEGIN;'))
        self.assertTrue(query.endswith('COMMIT;\n'))
        for name in financial.MIGRATIONS:
            self.assertIn(self.files[name][0].decode(), query)
        self.assertIn('financial_schema_already_exists', query)
        self.assertIn('domino_financial_install.receipt', query)

    def test_public_source_migrations_are_optional_but_unknown_or_missing_required_are_refused(self):
        def archive(extras,omit=()):
            files={name:raw for name,(raw,_) in self.files.items()
                   if name not in PACKAGED_ONLY_MIGRATIONS and name not in omit}
            files.update({name:b'-- packaged only' for name in extras})
            output=io.BytesIO()
            with tarfile.open(fileobj=output,mode='w',format=tarfile.PAX_FORMAT,
                              pax_headers={'comment':self.commit}) as tar:
                for name,raw in files.items():
                    member=tarfile.TarInfo(name);member.size=len(raw)
                    tar.addfile(member,io.BytesIO(raw))
            target=Path(self.temp.name)/'packaged.tar';target.write_bytes(output.getvalue())
            return financial.archive_files(target,financial.sha(output.getvalue()),self.commit)
        for extras in ((),PACKAGED_ONLY_MIGRATIONS[:1],PACKAGED_ONLY_MIGRATIONS[1:],PACKAGED_ONLY_MIGRATIONS):
            with self.subTest(extras=extras):
                files=archive(extras)
                self.assertEqual(set(files)&set(PACKAGED_ONLY_MIGRATIONS),set(extras))
                planned=financial.plan(files,self.commit,self.digest)
                self.assertEqual([row['path'] for row in planned['migrations']],list(financial.MIGRATIONS))
        with self.assertRaisesRegex(ValueError,'unexpected_migration'):
            archive((*PACKAGED_ONLY_MIGRATIONS,'backend/migrations/999_unregistered.sql'))
        for name in (*financial.base.MIGRATIONS,*financial.MIGRATIONS):
            with self.subTest(missing=name),self.assertRaisesRegex(ValueError,'required_release_file_missing'):
                archive(PACKAGED_ONLY_MIGRATIONS,omit=(name,))

    def test_only_the_pinned_foundation_succession_is_accepted(self):
        """The upgrade compares foundation source without replaying migration 006."""
        name = 'backend/migrations/006_chainlink_prices.sql'
        successors = financial.base.FOUNDATION_SUCCESSORS
        self.assertEqual(set(successors), {name, 'backend/schema.sql'},
                         'another exemption needs its own review')
        (installed, expected), = successors[name].items()
        # The pin names the release this upgrade reads and the file it carries.
        self.assertEqual(expected, financial.sha(self.files[name][0]))
        self.assertEqual(expected, self.planned['foundation'][name])
        self.assertNotEqual(installed, expected)
        # What the pin accepts: the re-added check marked NOT VALID.
        self.assertIn(b'NOT VALID', self.files[name][0])
        # The rest compares against the release the pin names, which needs that
        # commit present. A shallow checkout does not have it, and the pin is
        # still held to its digests above; skip only the content comparison.
        if subprocess.run(['git', 'cat-file', '-e', f'{financial.OLD}:{name}'],
                          cwd=REPO, capture_output=True).returncode:
            self.skipTest('the release the pin names is outside this checkout')
        previous = subprocess.check_output(['git', 'show', f'{financial.OLD}:{name}'], cwd=REPO)
        self.assertEqual(financial.sha(previous), installed,
                         'the pin must name the digest the installed release actually holds')
        # Ignoring comment lines, the two files differ by NOT VALID alone.
        def statements(raw):
            lines = [l for l in raw.decode().splitlines() if not l.lstrip().startswith('--')]
            return '\n'.join(lines).replace(') NOT VALID;', ');')
        self.assertNotIn(b'NOT VALID', previous)
        self.assertEqual(statements(previous), statements(self.files[name][0]),
                         'the accepted change adds NOT VALID and a comment, nothing else')

    def test_schema_tariff_succession_is_exact_and_inert(self):
        name = 'backend/schema.sql'
        current, executable = self.files[name]
        removed = (b' -- New policy tariff is the mode: 200 simple / 400 Domino. Historical receipts are separate.\n'
                   b' protocol_fee_bps smallint NOT NULL CHECK(protocol_fee_bps IN (200,400)),')
        previous_check = b' protocol_fee_bps smallint NOT NULL CHECK(protocol_fee_bps BETWEEN 0 AND 200),'
        self.assertEqual(current.count(removed), 1)
        previous = current.replace(removed, previous_check)
        (installed_hash, expected_hash), = financial.base.FOUNDATION_SUCCESSORS[name].items()
        self.assertEqual(financial.sha(previous), installed_hash)
        self.assertEqual(financial.sha(current), expected_hash)
        self.assertEqual(self.planned['foundation'][name], expected_hash)
        self.assertTrue(financial.base.succeeds(name, installed_hash, expected_hash))
        self.assertTrue(financial.base.succeeds(name, (previous, executable), (current, executable)))
        for installed, wanted in (
            (installed_hash, '0' * 64), ('0' * 64, expected_hash),
            ((previous + b'-- drift\n', executable), (current, executable)),
            ((previous, executable), (current, not executable)),
            (None, (current, executable)),
        ):
            with self.subTest(installed=installed, wanted=wanted):
                self.assertFalse(financial.base.succeeds(name, installed, wanted))

        # baseline must pass this exact digest gate before touching host state.
        installed = {n: self.files[n][0] for n in self.planned['foundation']}
        installed[name] = previous
        def read(path, maximum=64*1024*1024):
            return installed[str(path).split('/auth/', 1)[1]]
        with patch.object(financial, 'read_file', read), \
             patch.object(financial.os, 'geteuid', lambda: 0), \
             patch.object(financial.base, 'trusted_parents', lambda *a: None), \
             patch.object(financial.base, 'pg_parents', lambda *a: None), \
             patch.object(financial.base, 'dependency_preflight', lambda *a: None), \
             patch.object(financial, 'unit_state', side_effect=ValueError('reached_unit_state')):
            with self.assertRaisesRegex(ValueError, 'reached_unit_state'):
                financial.baseline(self.files, self.planned)
            installed[name] = previous + b'-- drift\n'
            with self.assertRaisesRegex(ValueError, 'foundation_or_dependency_change'):
                financial.baseline(self.files, self.planned)

    def test_a_foundation_change_that_is_not_pinned_still_fails_closed(self):
        from unittest.mock import patch as _patch
        name = 'backend/migrations/006_chainlink_prices.sql'
        other = 'backend/migrations/005_capital_prices.sql'
        installed = {n: self.files[n][0] for n in self.planned['foundation']}
        def read(path, maximum=64*1024*1024):
            return installed[str(path).split('/auth/', 1)[1]]
        with _patch.object(financial, 'read_file', read), \
             _patch.object(financial.os, 'geteuid', lambda: 0), \
             _patch.object(financial.base, 'trusted_parents', lambda *a: None), \
             _patch.object(financial.base, 'pg_parents', lambda *a: None), \
             _patch.object(financial.base, 'dependency_preflight', lambda *a: None), \
             _patch.object(financial, 'unit_state', lambda name: self.fail('reached the host')):
            for changed, reason in ((name, 'an unpinned digest for the exempt file'),
                                    (other, 'any other foundation file')):
                installed[changed] = b'-- drifted\n' + self.files[changed][0]
                with self.subTest(reason=reason), self.assertRaises(ValueError) as raised:
                    financial.baseline(self.files, self.planned)
                self.assertIn('foundation_or_dependency_change', str(raised.exception))
                installed[changed] = self.files[changed][0]

    def test_peers_preserve_existing_rows_and_reject_boundary(self):
        hba = b'local all postgres peer\nlocal domino_catalogue domino_session_auth peer map=domino\nlocal all all reject\nhost all all 0.0.0.0/0 reject\n'
        ident = b'domino domino-auth domino_session_auth\ndomino_dev domino-dev-read domino_dev_catalogue_reader\n'
        new_hba, new_ident = financial.peers(hba, ident)
        self.assertTrue(new_ident.startswith(ident))
        self.assertEqual(new_hba.count(b'local all all reject'), 1)
        for role in financial.NEW_ROLES:
            self.assertIn(f'local domino_catalogue {role} peer map=domino_financial\n'.encode(), new_hba)
        self.assertNotIn(b'domino-dev-read domino_performance', new_ident)
        self.assertNotIn(b'domino-read domino_execution', new_ident)
        self.assertIn(b'domino domino-execution-status domino_session_auth', new_ident)
        with self.assertRaises(ValueError): financial.peers(new_hba, new_ident)

    def test_peer_reload_waits_only_for_bounded_new_connections(self):
        calls = []
        def query(text, *, os_user, role):
            calls.append((os_user, role))
            if len(calls) == 1: raise ValueError('reload_pending')
            return role
        with patch.object(financial.base, 'sql', side_effect=query), patch.object(financial.time, 'sleep') as pause:
            financial.verify_peers()
        self.assertEqual(len(calls), 1 + sum(len(roles) for roles in financial.PEERS.values()))
        pause.assert_called_once_with(0.1)

    def test_the_archive_bounds_are_prepare_disabled_s_inclusive(self):
        """The financial upgrade reads the same release archive with the same bounds (prepare_disabled's constants),
        each met exactly by this repository's own archive and refused one below."""
        with tarfile.open(self.path) as tar:
            members = tar.getmembers()
        exact = {'MAX_ARCHIVE_BYTES': (self.path.stat().st_size, 'regular_bounded_file_required'),
                 'MAX_EXPANDED_BYTES': (sum(member.size for member in members), 'archive_expansion_limit'),
                 'MAX_MEMBER_BYTES': (max(member.size for member in members), 'archive_expansion_limit'),
                 'MAX_MEMBERS': (len(members), 'duplicate_or_excessive_archive')}
        for name, (bound, refusal) in exact.items():
            with self.subTest(limit=name), patch.object(financial.base, 'run', side_effect=AssertionError('host_command')):
                with patch.object(financial.base, name, bound):
                    self.assertEqual(set(financial.archive_files(self.path, self.digest, self.commit)), set(self.files))
                with patch.object(financial.base, name, bound - 1), self.assertRaisesRegex(ValueError, refusal):
                    financial.archive_files(self.path, self.digest, self.commit)

    def test_bad_archives_fail_before_host_commands(self):
        with patch.object(financial.base, 'run', side_effect=AssertionError('host_command')):
            with self.assertRaises(ValueError): financial.archive_files(self.path, '0' * 64, self.commit)
            for member_name, kind in (('../escape', tarfile.REGTYPE), ('backend/link', tarfile.SYMTYPE),
                                      ('backend/runtime/key', tarfile.REGTYPE)):
                with self.subTest(member_name=member_name):
                    output = io.BytesIO()
                    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT,
                                      pax_headers={'comment': self.commit}) as archive:
                        member = tarfile.TarInfo(member_name); member.type = kind
                        if kind == tarfile.SYMTYPE: member.linkname = '/etc/shadow'
                        archive.addfile(member)
                    bad = Path(self.temp.name) / 'bad.tar'; bad.write_bytes(output.getvalue())
                    with self.assertRaises(ValueError): financial.archive_files(bad, hashlib.sha256(bad.read_bytes()).hexdigest(), self.commit)

    def test_partial_rollback_is_scoped_repeatable_and_retains_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            directory = receipts / self.commit; directory.mkdir()
            original = b'[Service]\nExecStart=/old/auth\n'
            (directory / 'auth.service').write_bytes(original)
            (directory / 'plan.json').write_bytes(financial.json_bytes(self.planned))
            (units / 'domino-auth.service').write_text(self.planned['units']['domino-auth.service'])
            # Intent journaled, but new performance unit never renamed yet.
            state = {'unitsWritten': ['auth', 'performance'], 'peerFilesWritten': [], 'sqlCommitted': False}
            (directory / 'journal.json').write_bytes(financial.json_bytes(state))
            protected = units / 'domino-read.service'; protected.write_bytes(b'unchanged')
            calls = []
            exclusive = financial.base.exclusive_file
            def fixture_file(path, raw, mode=0o600, **kwargs):
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            with patch.object(financial, 'RECEIPTS', receipts), patch.object(financial.base, 'UNIT_DIR', units), \
                    patch.object(financial.base, 'trusted_parents'), \
                    patch.object(financial.base, 'exclusive_file', side_effect=fixture_file), \
                    patch.object(financial.base, 'run', side_effect=lambda args: calls.append(args) or b''), \
                    patch.object(financial, 'sql', return_value='t'):
                self.assertTrue(financial.rollback(self.planned)['financialSchemasRetained'])
                self.assertTrue(financial.rollback(self.planned)['financialSchemasRetained'])
            self.assertEqual((units / 'domino-auth.service').read_bytes(), original)
            self.assertEqual(protected.read_bytes(), b'unchanged')
            self.assertFalse((units / 'domino-performance.service').exists())
            self.assertTrue(all('domino-read.service' not in command for command in calls))
            self.assertFalse(any('start' in command for command in calls))

    def test_rollback_rejects_unrelated_unit_change_before_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir(); directory = receipts / self.commit; directory.mkdir()
            (directory / 'plan.json').write_bytes(financial.json_bytes(self.planned))
            (directory / 'auth.service').write_bytes(b'original')
            (directory / 'journal.json').write_bytes(financial.json_bytes({'unitsWritten': ['auth'], 'peerFilesWritten': []}))
            (units / 'domino-auth.service').write_bytes(b'foreign update')
            with patch.object(financial, 'RECEIPTS', receipts), patch.object(financial.base, 'UNIT_DIR', units), \
                    patch.object(financial.base, 'trusted_parents'), patch.object(financial.base, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'rollback_unit_drift'): financial.rollback(self.planned)
                run.assert_not_called()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_STAGING_POSTGRES') == '1', 'opt-in disposable PostgreSQL')
class FinancialPostgresTests(unittest.TestCase):
    def test_actual_foundation_upgrade_atomic_failure_and_single_commit(self):
        # Reuse the established local PG16+ fixture and populated foundation,
        # not a VM/host schema. No installer, service or provider is invoked.
        import test_upgrade_postgres as fixture
        cluster = fixture.UpgradePostgresTests
        cluster.setUpClass()
        self.addCleanup(cluster.doClassCleanups)
        files = {p: ((REPO / p).read_bytes(), False) for p in financial.MIGRATIONS}
        planned = {'commit': 'a' * 40, 'migrations': [{'path': p, 'sha256': financial.sha(raw)} for p, (raw, _) in files.items()]}
        before = cluster.query("SELECT json_build_object('wallets',(SELECT count(*) FROM domino_wallet_access.grants),'catalogue',(SELECT count(*) FROM domino_catalogue.events))")
        with patch.object(financial.base, 'DB', 'upgrade_fixture'):
            invalid = dict(files)
            invalid[financial.MIGRATIONS[-1]] = (b'SELECT nonexistent_financial_function();', False)
            with self.assertRaises(AssertionError): cluster.query(financial.migration_sql(invalid, planned))
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_namespace WHERE nspname IN ('domino_execution','domino_performance','domino_financial_install')"), '0')
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_roles WHERE rolname='domino_execution_signer'"), '0')
            cluster.query(financial.migration_sql(files, planned))
            stored = json.loads(cluster.query('SELECT value FROM domino_financial_install.receipt'))
            self.assertEqual(stored, planned)
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'domino_execution_%' AND (rolsuper OR rolinherit OR rolbypassrls)"), '0')
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname LIKE 'domino_execution_%' OR r.rolname LIKE 'domino_performance_%'"), '0')
            with self.assertRaises(AssertionError): cluster.query(financial.migration_sql(files, planned))
        self.assertEqual(before, cluster.query("SELECT json_build_object('wallets',(SELECT count(*) FROM domino_wallet_access.grants),'catalogue',(SELECT count(*) FROM domino_catalogue.events))"))
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_execution.attempts', role='domino_execution_reader')
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_sessions.sessions', role='domino_performance_collector')
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_financial_install.receipt', role='domino_execution_signer')


if __name__ == '__main__': unittest.main()
