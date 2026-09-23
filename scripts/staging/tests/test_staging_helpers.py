"""Unprivileged offline regressions; never run an installer or a host verifier."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

# Re-export the focused profile suite through the existing required CI entry point.
from test_schema_acl_profiles import SchemaAclProfileTests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalogue_inventory
import check_disabled_http
import check_filesystem
import check_roles
import prepare_disabled
import upgrade_financial

COMMIT = 'a' * 40
# Independent release contract: adding a migration to production MIGRATIONS
# must not silently widen what these installation/receipt tests expect.
FOUNDATION_MIGRATIONS = tuple('backend/migrations/' + name + '.sql' for name in (
    '001_catalogue', '002_activity', '003_fee_ledger', '004_positions',
    '005_capital_prices', '006_chainlink_prices', '007_historical_work',
    '008_wallet_sessions', '009_direct_deposits', '010_deposit_recovery',
    '011_wallet_access', '012_capital_work', '013_activity_diagnostics',
    '014_deposit_draft_recovery'))
PACKAGED_MIGRATIONS = ('backend/migrations/015_unsigned_execution.sql',
                       'backend/migrations/016_managed_performance.sql',
                       'backend/migrations/017_performance_financial_history.sql',
                       'backend/migrations/018_performance_enrollment.sql',
                       'backend/migrations/019_execution_journal.sql',
                       'backend/migrations/020_pool_requests.sql',
                       'backend/migrations/021_reference_price_sources.sql',
                       'backend/migrations/022_event_timestamp_source.sql',
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
                       'backend/migrations/040_gas_finalized_quote_lag.sql')


def packaged_records(files):
    return [{'path': path, 'sha256': hashlib.sha256(files[path][0]).hexdigest()}
            for path in PACKAGED_MIGRATIONS if path in files]


class ArchiveTests(unittest.TestCase):
    def test_every_migration_on_disk_is_named_by_a_deployment_list(self):
        """A new migration must be registered, or its release is refused.

        This is the failure that reached CI twice: the packaging allowlist and the
        post-foundation upgrade list both have to name a file under
        `backend/migrations/`, and nothing else in the tree notices a new one.
        """
        on_disk = {path.name for path in (Path(__file__).resolve().parents[3] /
                                          'backend' / 'migrations').glob('*.sql')}
        packaged = {Path(name).name for name in
                    (*prepare_disabled.MIGRATIONS, *prepare_disabled.PACKAGED_ONLY_MIGRATIONS)}
        financial_packaged = {Path(name).name for name in
                   (*upgrade_financial.base.MIGRATIONS, *upgrade_financial.MIGRATIONS,
                    *upgrade_financial.PACKAGED_ONLY_MIGRATIONS)}
        self.assertEqual(on_disk - packaged, set(), 'migrations no release may carry')
        self.assertEqual((packaged | financial_packaged) - on_disk, set(), 'lists naming absent files')
        self.assertEqual(on_disk, packaged, 'the packaging allowlist is the whole tree')
        self.assertEqual(on_disk, financial_packaged, 'the financial archive must also accept every known source migration')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source.tar'

    def archive(self, *, extra=(), omit=(), comment=COMMIT):
        stream = io.BytesIO()
        names = (*prepare_disabled.MIGRATIONS, 'backend/requirements-api.lock',
                 *('backend/' + script for script, _ in prepare_disabled.SERVICES.values()))
        with tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT,
                          pax_headers={'comment': comment}) as archive:
            for name in names:
                if name not in omit:
                    member = tarfile.TarInfo(name)
                    member.size = 2
                    archive.addfile(member, io.BytesIO(b'{}'))
            for name, kind in extra:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = 'backend/read_api.py'
                archive.addfile(member, io.BytesIO())
        payload = stream.getvalue()
        self.path.write_bytes(payload)
        return hashlib.sha256(payload).hexdigest()

    def test_default_cli_emits_plan_without_host_or_apply_calls(self):
        digest = self.archive()
        output = io.StringIO()
        with patch.object(sys, 'argv', ['prepare_disabled.py', '--archive', str(self.path),
                    '--archive-sha256', digest, '--commit', COMMIT]), contextlib.redirect_stdout(output), \
                patch.object(prepare_disabled, 'apply') as apply, \
                patch.object(prepare_disabled, 'preflight') as preflight, \
                patch.object(prepare_disabled, 'run', side_effect=AssertionError('host command')):
            self.assertEqual(prepare_disabled.main(), 0)
        apply.assert_not_called()
        preflight.assert_not_called()
        plan = json.loads(output.getvalue())
        self.assertFalse(plan['hostValidated'])
        self.assertEqual(plan['mode'], 'disabled-install-plan')

    def test_archive_rejects_hash_or_commit_mismatch(self):
        digest = self.archive()
        for claimed_digest, commit in [('0' * 64, COMMIT), (digest, 'b' * 40),
                                       (digest.upper(), COMMIT), (digest, 'a' * 7)]:
            with self.subTest(commit=commit, digest=claimed_digest), self.assertRaises(ValueError):
                prepare_disabled.archive_files(self.path, claimed_digest, commit)

    def test_only_named_optional_migrations_are_packaged_not_applied(self):
        self.assertEqual(prepare_disabled.MIGRATIONS, FOUNDATION_MIGRATIONS)
        self.assertEqual(prepare_disabled.PACKAGED_ONLY_MIGRATIONS, PACKAGED_MIGRATIONS)
        for extras in ((), PACKAGED_MIGRATIONS[:1], PACKAGED_MIGRATIONS[1:], PACKAGED_MIGRATIONS):
            with self.subTest(extras=extras), \
                    patch.object(prepare_disabled, 'run', side_effect=AssertionError('host command')), \
                    patch.object(prepare_disabled, 'sql', side_effect=AssertionError('SQL')):
                digest = self.archive(extra=[(path, tarfile.REGTYPE) for path in extras])
                files = prepare_disabled.archive_files(self.path, digest, COMMIT)
                planned = prepare_disabled.plan(files, digest, COMMIT)
                self.assertEqual([row['path'] for row in planned['migrations']], list(FOUNDATION_MIGRATIONS))
                self.assertEqual(prepare_disabled.packaged_only_migrations(files), packaged_records(files))
                self.assertEqual(set(files) & set(PACKAGED_MIGRATIONS), set(extras))
                if extras:
                    self.assertEqual(planned['packagedOnlyMigrations'], packaged_records(files))
                else:
                    self.assertNotIn('packagedOnlyMigrations', planned)

    def test_optional_sql_never_makes_a_foundation_migration_optional(self):
        for missing in FOUNDATION_MIGRATIONS:
            with self.subTest(missing=missing):
                digest = self.archive(omit=[missing], extra=[(path, tarfile.REGTYPE) for path in PACKAGED_MIGRATIONS])
                with self.assertRaisesRegex(ValueError, 'required release file missing'):
                    prepare_disabled.archive_files(self.path, digest, COMMIT)

    def test_untrusted_members_are_rejected_without_extraction(self):
        cases = [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                 ('backend/../outside', tarfile.REGTYPE), ('backend//extra', tarfile.REGTYPE),
                 ('backend/./extra', tarfile.REGTYPE), ('backend\\extra', tarfile.REGTYPE),
                 ('bad\nname', tarfile.REGTYPE), ('backend/runtime/file', tarfile.REGTYPE),
                 ('backend/.venv/file', tarfile.REGTYPE), ('.git/config', tarfile.REGTYPE),
                 ('node_modules/file', tarfile.REGTYPE), ('backend/link', tarfile.SYMTYPE),
                 ('backend/hardlink', tarfile.LNKTYPE), ('backend/fifo', tarfile.FIFOTYPE),
                 ('backend/device', tarfile.CHRTYPE), ('backend/read_api.py', tarfile.REGTYPE),
                 ('backend/migrations/015_extra.sql', tarfile.REGTYPE),
                 ('backend/migrations/017_future.sql', tarfile.REGTYPE),
                 ('backend/migrations/nested/015_unsigned_execution.sql', tarfile.REGTYPE),
                 (PACKAGED_MIGRATIONS[0], tarfile.SYMTYPE),
                 (PACKAGED_MIGRATIONS[1], tarfile.LNKTYPE)]
        for case in cases:
            with self.subTest(case=case):
                digest = self.archive(extra=[case])
                with self.assertRaises((ValueError, tarfile.TarError)):
                    prepare_disabled.archive_files(self.path, digest, COMMIT)
        self.assertEqual({path.name for path in self.path.parent.iterdir()}, {'source.tar'})

    def test_missing_file_and_file_used_as_parent_rejected(self):
        for options in ({'omit': [prepare_disabled.MIGRATIONS[0]]},
                        {'extra': [('backend', tarfile.REGTYPE)]}):
            with self.subTest(options=options):
                digest = self.archive(**options)
                with self.assertRaises(ValueError):
                    prepare_disabled.archive_files(self.path, digest, COMMIT)

    def test_archive_symlink_rejected(self):
        digest = self.archive()
        link = self.path.with_name('link.tar')
        link.symlink_to(self.path)
        with self.assertRaises(OSError):
            prepare_disabled.archive_files(link, digest, COMMIT)

    def test_units_remain_disabled_and_have_fixed_service_boundary(self):
        for component in prepare_disabled.SERVICES:
            with self.subTest(component=component):
                unit = prepare_disabled.unit_text(component, COMMIT)
                self.assertNotIn('[Install]', unit)
                self.assertIn('User=domino-' + component + '\n', unit)
                self.assertIn('ReadWritePaths=/opt/domino/releases/' + COMMIT + '/' + component + '/backend/runtime\n', unit)
                for line in ('UMask=0077', 'NoNewPrivileges=true', 'ProtectSystem=strict',
                             'IPAddressDeny=any', 'IPAddressAllow=localhost', 'TimeoutStopSec=30'):
                    self.assertIn(line + '\n', unit)


class CurrentGitArchiveTests(unittest.TestCase):
    """The actual release artifact, not a fabricated list of required files."""
    @classmethod
    def setUpClass(cls):
        cls.repo = Path(__file__).resolve().parents[3]
        if not (cls.repo / '.git').exists():
            raise unittest.SkipTest('Building a Git archive requires a source checkout; tar planning does not.')
        # Missing/broken Git in a checkout (including required CI) is a failure.
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-real-archive-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        cls.commit = subprocess.run(['git', '-C', str(cls.repo), 'rev-parse', 'HEAD'],
                                    check=True, capture_output=True, text=True, timeout=30).stdout.strip()
        cls.archive = cls.root / 'source.tar'
        subprocess.run(['git', '-C', str(cls.repo), 'archive', '--format=tar',
                        '--output', str(cls.archive), cls.commit],
                       check=True, capture_output=True, timeout=30)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()

    def test_current_head_plain_git_archive_plans_without_host_access(self):
        with patch.object(prepare_disabled, 'run', side_effect=AssertionError('host command')), \
                patch.object(prepare_disabled, 'sql', side_effect=AssertionError('SQL')), \
                patch.object(prepare_disabled, 'preflight', side_effect=AssertionError('host preflight')), \
                patch.object(prepare_disabled, 'apply', side_effect=AssertionError('apply')):
            files = prepare_disabled.archive_files(self.archive, self.digest, self.commit)
            planned = prepare_disabled.plan(files, self.digest, self.commit)
        self.assertIn('scripts/staging/prepare_disabled.py', files)
        self.assertIn('backend/schema.sql', files)
        self.assertFalse(planned['hostValidated'])
        self.assertEqual([row['path'] for row in planned['migrations']], list(FOUNDATION_MIGRATIONS))
        self.assertEqual(planned.get('packagedOnlyMigrations', []), packaged_records(files))

    def test_separately_reviewed_helper_plans_real_tar_without_git_or_checkout(self):
        helpers = self.root / 'installed-helpers'
        helpers.mkdir()
        for name in ('prepare_disabled.py', 'catalogue_inventory.py'):
            shutil.copyfile(self.repo / 'scripts/staging' / name, helpers / name)
        self.assertFalse((helpers / '.git').exists())
        # Run the actual CLI, but fail before any attempted host child process
        # even if a future regression makes default planning invoke one.
        child = ("import runpy,subprocess,sys\n"
                 "def forbidden(*args, **kwargs): raise AssertionError('planner attempted a child process')\n"
                 "subprocess.Popen=forbidden\n"
                 "sys.path.insert(0,sys.argv[1]); sys.argv=sys.argv[2:]\n"
                 "runpy.run_path(sys.argv[0],run_name='__main__')\n")
        result = subprocess.run([sys.executable, '-I', '-B', '-c', child, str(helpers),
                                 str(helpers / 'prepare_disabled.py'),
                                 '--archive', str(self.archive), '--archive-sha256', self.digest,
                                 '--commit', self.commit], cwd=helpers,
                                env={'PATH': '', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        planned = json.loads(result.stdout)
        self.assertEqual(planned['mode'], 'disabled-install-plan')
        self.assertFalse(planned['hostValidated'])
        self.assertEqual([row['path'] for row in planned['migrations']], list(FOUNDATION_MIGRATIONS))


class InstallerMigrationTests(unittest.TestCase):
    def test_applied_sql_and_receipt_keep_only_foundation_with_optional_sql_packaged(self):
        sentinel = b"DO $$ BEGIN RAISE EXCEPTION 'PACKAGED_SQL_MUST_NOT_RUN'; END $$;\n"
        for extras in ((), PACKAGED_MIGRATIONS):
            with self.subTest(extras=extras), tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
                root = Path(temporary)
                for attr, child in (('BASE', 'opt'), ('CONFIG', 'pg'), ('UNIT_DIR', 'units')):
                    path = root / child
                    path.mkdir()
                    stack.enter_context(patch.object(prepare_disabled, attr, path))
                destination = root / 'backup'
                destination.mkdir()
                for name, rows in (('pg_ident.conf', prepare_disabled.MAPPINGS), ('pg_hba.conf', prepare_disabled.HBA)):
                    (prepare_disabled.CONFIG / name).write_text('\n'.join(' '.join(row) for row in rows) + '\n')
                files = {path: (f"SELECT 'foundation_{i}';\n".encode(), False)
                         for i, path in enumerate(FOUNDATION_MIGRATIONS, 1)}
                files['backend/requirements-api.lock'] = (b'locked\n', False)
                files.update({path: (sentinel, False) for path in extras})
                planned = prepare_disabled.plan(files, 'c' * 64, COMMIT)
                real_fstat = os.fstat
                def root_owned(fd):
                    info = real_fstat(fd)
                    fields = list(info)
                    fields[4] = 0
                    return os.stat_result(fields)
                stack.enter_context(patch.object(prepare_disabled.os, 'geteuid', return_value=0))
                stack.enter_context(patch.object(prepare_disabled.os, 'fstat', side_effect=root_owned))
                stack.enter_context(patch.object(prepare_disabled.os, 'fchown'))
                for name in ('trusted_parents', 'preflight', 'validate_pg_files', 'verify_new_peers'):
                    stack.enter_context(patch.object(prepare_disabled, name))
                stack.enter_context(patch.object(prepare_disabled, 'backup', return_value=destination))
                roots = stack.enter_context(patch.object(prepare_disabled, 'install_roots'))
                stack.enter_context(patch.object(prepare_disabled, 'replace_pg_config',
                                                side_effect=lambda path, content: path.write_bytes(content)))
                stack.enter_context(patch.object(prepare_disabled, 'run', return_value=b''))
                stack.enter_context(patch.object(prepare_disabled.subprocess, 'Popen',
                                                side_effect=AssertionError('host process')))
                sql = stack.enter_context(patch.object(prepare_disabled, 'sql', return_value='t'))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                prepare_disabled.apply(files, planned)
                roots.assert_called_once_with(files, COMMIT)
                migration_calls = [call for call in sql.call_args_list if call.kwargs.get('transaction')]
                self.assertEqual(len(migration_calls), 1)
                expected_sql = '\n'.join(files[path][0].decode() for path in FOUNDATION_MIGRATIONS)
                query = migration_calls[0].args[0]
                self.assertEqual(query[query.index("SELECT 'foundation_1';"):], expected_sql)
                self.assertEqual(query.count("SELECT 'foundation_"), 14)
                self.assertEqual(migration_calls[0].kwargs, {'os_user': 'domino-admin', 'role': prepare_disabled.ADMIN,
                                                            'transaction': True})
                self.assertTrue(all('PACKAGED_SQL_MUST_NOT_RUN' not in call.args[0] for call in sql.call_args_list))
                receipt = json.loads((destination / 'installed.json').read_text())
                self.assertEqual(receipt['migrationsCommitted'], list(FOUNDATION_MIGRATIONS))
                self.assertEqual(receipt.get('packagedOnlyMigrations', []), packaged_records(files))
                if not extras:
                    self.assertNotIn('packagedOnlyMigrations', receipt)


class CodeIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / COMMIT
        self.files = {'backend/read_api.py': (b'read approved\n', False),
                      'scripts/check.py': (b'executable approved\n', True)}
        for component in check_filesystem.COMPONENTS:
            for name, (content, executable) in self.files.items():
                path = self.root / component / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o555 if executable else 0o444)
            runtime = self.root / component / 'backend/runtime'
            runtime.mkdir(mode=0o700)
            (runtime / 'catalogue-db.json').write_text('private descriptor fixture')
            (self.root / component / 'backend/.venv').symlink_to('/fixture/venv')
        for directory, _, _ in os.walk(self.root, topdown=False):
            Path(directory).chmod(0o555)
        self.addCleanup(self.writable)

    def writable(self):
        for directory, _, _ in os.walk(self.root):
            Path(directory).chmod(0o755)

    def check(self, deadline=None):
        return check_filesystem.check_code_identity(self.root, self.files, deadline or time.monotonic() + 10)

    def test_all_seven_copies_match_and_private_runtime_is_not_opened(self):
        real_open = os.open
        def guarded_open(path, flags, *args, **kwargs):
            self.assertNotIn('runtime', Path(path).parts)
            self.assertNotIn('.venv', Path(path).parts)
            return real_open(path, flags, *args, **kwargs)
        with patch.object(check_filesystem.os, 'open', side_effect=guarded_open):
            self.assertEqual(self.check(), {'copies': 7, 'filesPerCopy': 2, 'verifiedFiles': 14})

    def test_same_size_readonly_content_tamper_in_last_copy_rejected(self):
        path = self.root / 'write/backend/read_api.py'
        path.chmod(0o644)
        path.write_bytes(b'read tampered\n')
        path.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'code_content_mismatch'):
            self.check()

    def test_changed_length_rejected(self):
        path = self.root / 'auth/backend/read_api.py'
        path.chmod(0o644)
        path.write_bytes(b'')
        path.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'code_file_metadata_mismatch'):
            self.check()

    def test_executable_mode_tamper_rejected(self):
        (self.root / 'onboarding/backend/read_api.py').chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'code_file_mode_mismatch'):
            self.check()

    def test_missing_file_rejected(self):
        path = self.root / 'deposit/backend/read_api.py'
        path.parent.chmod(0o755)
        path.unlink()
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'code_inventory_incomplete'):
            self.check()

    def test_extra_readonly_python_file_rejected(self):
        path = self.root / 'read/backend/sitecustomize.py'
        path.parent.chmod(0o755)
        path.write_text('injected')
        path.chmod(0o444)
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'unexpected_code_file'):
            self.check()

    def test_extra_empty_directory_rejected(self):
        self.root.chmod(0o755)
        (self.root / 'extra').mkdir(mode=0o555)
        self.root.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'unexpected_code_directory'):
            self.check()

    def test_symlink_and_hardlink_rejected(self):
        path = self.root / 'gateway/backend/read_api.py'
        target = self.root / 'read/backend/read_api.py'
        path.parent.chmod(0o755)
        path.unlink()
        path.symlink_to(target)
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'code_identity_requires_regular_file'):
            self.check()
        path.parent.chmod(0o755)
        path.unlink()
        os.link(target, path)
        path.parent.chmod(0o555)
        with self.assertRaisesRegex(ValueError, 'code_file_metadata_mismatch'):
            self.check()

    def test_deadline_rejected_without_success_report(self):
        with self.assertRaisesRegex(ValueError, 'filesystem_check_deadline'):
            self.check(time.monotonic() - 1)

    def test_verifier_requires_external_archive_reference(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as result:
            check_filesystem.main(['--commit', COMMIT])
        self.assertEqual(result.exception.code, 2)


class CatalogueShapeTests(unittest.TestCase):
    def test_parameter_acl_count_requires_an_explicit_integer_zero(self):
        for value in (None, False, True, '0', 1, -1, []):
            with self.subTest(value=value):
                self.assertFalse(catalogue_inventory.check_inventory({'parameterAclCount': value},
                                  installed=True)['noParameterAclOverrides'])
        self.assertTrue(catalogue_inventory.check_inventory({'parameterAclCount': 0},
                        installed=True)['noParameterAclOverrides'])

    def test_missing_or_malformed_inventory_fails_closed(self):
        for data in (None, [], {}, {'roleSettingCount': False, 'defaultAclCount': False},
                     {'roleSettingCount': 0, 'defaultAclCount': 0, 'schemas': []}):
            with self.subTest(data=data):
                self.assertFalse(all(catalogue_inventory.check_inventory(data, installed=True).values()))

    def test_acl_comparison_rejects_duplicate_grantor_option_and_malformed_rows(self):
        expected = {('runtime', 'CONNECT', 'owner', False), ('owner', 'CREATE', 'owner', False)}
        positive = [list(row) for row in sorted(expected)]
        self.assertTrue(catalogue_inventory.exact_rows(positive, expected))
        for rows in (positive[:1] * 2, positive + positive[:1], None, [],
                     [['runtime', 'CONNECT', 'other', False], positive[0]],
                     [['runtime', 'CONNECT', 'owner', True], positive[0]],
                     [['runtime', 'CONNECT', 'owner', 0], positive[0]],
                     [[{}, 'CONNECT', 'owner', False], positive[0]]):
            with self.subTest(rows=rows):
                self.assertFalse(catalogue_inventory.exact_rows(rows, expected))


class RoleCommandTests(unittest.TestCase):
    def test_arbitrary_failure_is_not_a_successful_denial_and_error_is_redacted(self):
        for code, message, expected in [(2, b'FATAL: database missing secret', 'command_failed'),
                                       (1, b'ERROR: 42501 forbidden', 'privilege_denied'),
                                       (2, b'FATAL: Peer authentication failed for user "fixture"', 'peer_denied')]:
            with self.subTest(code=code, message=message):
                process = Mock(returncode=code)
                process.communicate.return_value = (b'', message)
                with patch.object(check_roles.subprocess, 'Popen', return_value=process):
                    result = check_roles.command(['fixture'], time.monotonic() + 10)
                self.assertEqual(result['status'], expected)
                self.assertNotIn('secret', json.dumps(result))

    def test_timeout_kills_child_group(self):
        process = Mock(pid=12345)
        process.communicate.side_effect = [subprocess.TimeoutExpired('fixture', 1), (b'', b'')]
        with patch.object(check_roles.subprocess, 'Popen', return_value=process), \
                patch.object(check_roles.os, 'killpg') as kill:
            self.assertEqual(check_roles.command(['fixture'], time.monotonic() + 1)['status'], 'timeout')
        kill.assert_called_once_with(12345, check_roles.signal.SIGKILL)


class InventoryWiringTests(unittest.TestCase):
    """Mock the host perimeter, then exercise the actual entry-point control flow.

    Catalogue SQL/validation are exercised with real PG in the companion suite.
    These tests specifically catch removing either entry point's inventory call
    or ignoring its false checks. No preflight fixture touches the actual host.
    """
    checks = ('noDefaultAclOverrides', 'noPersistentRoleDatabaseSettings',
              'noParameterAclOverrides', 'completeSchemaInventory',
              'completeSchemaAcl', 'completeDatabaseAcl')

    def run_role_main(self, failing=None):
        users = {name: 1000 + i for i, name in enumerate(check_roles.PEERS)}
        checked = {name: name != failing for name in self.checks}
        fixture = {'fixture': 'role_catalogue'}
        def query(args, os_user, role, sql, deadline, **kwargs):
            if sql == check_roles.IDENTITY_SQL:
                if role not in check_roles.PEERS[os_user]:
                    return {'status': 'peer_denied' if check_roles.PEERS[os_user] else 'socket_denied'}
                data = {'sessionUser': role, 'currentUser': role, 'database': 'domino_catalogue', 'readonly': True}
            elif sql == check_roles.metadata_sql():
                data = {'fixture': 'legacy_metadata'}
            elif sql == catalogue_inventory.inventory_sql():
                data = fixture
            elif sql.startswith("SELECT json_build_object('checks'"):
                data = {'checks': 1, 'failures': []}
            else:
                table = sql.split('FROM (SELECT 1 FROM ')[1].split(' LIMIT 0)')[0]
                return ({'status': 'ok', 'output': '0'} if check_roles.allowed_table(role, table, 'SELECT')
                        else {'status': 'privilege_denied'})
            return {'status': 'ok', 'output': json.dumps(data)}
        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(check_roles.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(check_roles.os, 'access', return_value=True))
            stack.enter_context(patch.object(check_roles.pwd, 'getpwnam', side_effect=lambda name: SimpleNamespace(pw_uid=users[name])))
            stack.enter_context(patch.object(check_roles, 'socket_access', return_value=[{'ok': True}]))
            stack.enter_context(patch.object(check_roles, 'command', side_effect=lambda argv, deadline: {
                'status': 'ok', 'output': str(users[argv[2]])}))
            stack.enter_context(patch.object(check_roles, 'check_metadata', return_value={'legacy': True}))
            inventory = stack.enter_context(patch.object(check_roles, 'check_inventory', return_value=checked))
            queries = stack.enter_context(patch.object(check_roles, 'query', side_effect=query))
            stack.enter_context(contextlib.redirect_stdout(output))
            status = check_roles.main([])
        inventory.assert_called_once_with(fixture, installed=True)
        self.assertEqual(sum(call.args[3] == catalogue_inventory.inventory_sql() for call in queries.call_args_list), 1)
        return status, json.loads(output.getvalue())

    def test_role_command_requires_every_added_inventory_check(self):
        status, report = self.run_role_main()
        self.assertEqual(status, 0, report)
        for failing in self.checks:
            with self.subTest(failing=failing):
                status, report = self.run_role_main(failing)
                self.assertEqual(status, 1)
                self.assertFalse(report['ok'])
                self.assertIs(report['metadata'][failing], False)
                self.assertEqual(report['error'], 'metadata_mismatch')

    @contextlib.contextmanager
    def preflight_host(self, *, failing=None, empty=True):
        pg = prepare_disabled
        fixture = {'fixture': 'foundation_catalogue'}
        checked = {name: name != failing for name in self.checks}
        members = {row[1] for row in pg.MAPPINGS} | {'postgres'}
        users = {name: SimpleNamespace(pw_uid=1000 + i, pw_gid=2000 + i)
                 for i, name in enumerate(sorted(members | {'domino-gateway', 'domino-tunnel'}))}
        users['postgres'] = SimpleNamespace(pw_uid=109, pw_gid=113)
        settings = {'server_version_num': '160001', 'server_encoding': 'UTF8',
                    'data_directory': str(pg.DATA), 'config_file': str(pg.CONFIG / 'postgresql.conf'),
                    'hba_file': str(pg.CONFIG / 'pg_hba.conf'), 'ident_file': str(pg.CONFIG / 'pg_ident.conf'),
                    'port': '8877', 'listen_addresses': '', 'unix_socket_directories': pg.SOCKET,
                    'unix_socket_permissions': '0770', 'unix_socket_group': 'domino-db'}
        def query(sql):
            if sql == catalogue_inventory.inventory_sql():
                return json.dumps(fixture)
            if 'FROM pg_catalog.pg_settings' in sql:
                return json.dumps(settings)
            if 'pg_encoding_to_char' in sql:
                return 'UTF8'
            if sql == 'SELECT ' + pg.EMPTY:
                return 't' if empty else 'f'
            if 'pg_get_userbyid(datdba)' in sql:
                return pg.ADMIN
            if 'json_agg(rolname' in sql:
                return json.dumps(sorted(row[2] for row in pg.MAPPINGS))
            if sql.startswith('SELECT pg_catalog.count(*)'):
                return '0'
            raise AssertionError('unexpected preflight SQL')
        def lstat(path):
            mode = {pg.SOCKET: stat.S_IFDIR | 0o750,
                    str(Path(pg.SOCKET) / '.s.PGSQL.8877'): stat.S_IFSOCK | 0o770}[str(path)]
            return SimpleNamespace(st_mode=mode, st_uid=109, st_gid=3000)
        def read_text(path, *args, **kwargs):
            self.assertEqual(str(path), '/etc/os-release')
            return 'ID=ubuntu\nVERSION_ID="24.04"\n'
        def run(argv):
            self.assertIn(argv, [['/usr/bin/systemctl', name, '--all', '--no-legend', '--no-pager']
                                for name in ('list-unit-files', 'list-units')] + [['/usr/bin/ss', '-H', '-ltn']])
            return b''
        with contextlib.ExitStack() as stack:
            for function in ('dependency_preflight', 'trusted_parents', 'pg_parents', 'validate_pg_files'):
                stack.enter_context(patch.object(pg, function))
            stack.enter_context(patch.object(pg, 'trusted', return_value=SimpleNamespace(
                st_mode=stat.S_IFREG | 0o600, st_uid=109, st_gid=113)))
            stack.enter_context(patch.object(pg, 'normalized_config', side_effect=lambda path:
                pg.HBA if path.name == 'pg_hba.conf' else pg.MAPPINGS))
            stack.enter_context(patch.object(pg.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(pg.os.path, 'lexists', return_value=False))
            stack.enter_context(patch.object(pg.os, 'getgrouplist', side_effect=lambda user, gid:
                [gid, 3000] if user in members else [gid]))
            stack.enter_context(patch.object(pg.pwd, 'getpwnam', side_effect=users.__getitem__))
            stack.enter_context(patch.object(pg.pwd, 'getpwall', return_value=[]))
            stack.enter_context(patch.object(pg.grp, 'getgrnam', side_effect=lambda name:
                SimpleNamespace(gr_gid=3000, gr_mem=list(members)) if name == 'domino-db'
                else SimpleNamespace(gr_gid=users[name].pw_gid)))
            stack.enter_context(patch.object(pg.grp, 'getgrall', return_value=[]))
            stack.enter_context(patch.object(Path, 'read_text', read_text))
            stack.enter_context(patch.object(Path, 'lstat', lstat))
            stack.enter_context(patch.object(Path, 'is_symlink', return_value=False))
            stack.enter_context(patch.object(Path, 'exists', return_value=False))
            stack.enter_context(patch.object(pg, 'run', side_effect=run))
            queries = stack.enter_context(patch.object(pg, 'sql', side_effect=query))
            inventory = stack.enter_context(patch.object(pg, 'check_inventory', return_value=checked))
            yield queries, inventory, settings, fixture

    def test_preflight_requires_the_full_inventory(self):
        with self.preflight_host() as (queries, inventory, settings, fixture):
            self.assertEqual(prepare_disabled.preflight({}, COMMIT), settings)
            inventory.assert_called_once_with(fixture, installed=False)
            self.assertEqual(sum(call.args[0] == catalogue_inventory.inventory_sql() for call in queries.call_args_list), 1)
        for failing in self.checks:
            with self.subTest(failing=failing), self.preflight_host(failing=failing):
                with self.assertRaisesRegex(ValueError, 'unexpected (PostgreSQL overrides|foundation catalogue inventory)'):
                    prepare_disabled.preflight({}, COMMIT)

    def test_preflight_reports_overrides_before_generic_empty_database_failure(self):
        labels = {'noDefaultAclOverrides': 'default privilege overrides \\(pg_default_acl\\)',
                  'noPersistentRoleDatabaseSettings': 'persistent role/database overrides \\(pg_db_role_setting\\)',
                  'noParameterAclOverrides': 'parameter privilege overrides \\(pg_parameter_acl\\)'}
        for failing, label in labels.items():
            with self.subTest(failing=failing), self.preflight_host(failing=failing, empty=False):
                with self.assertRaisesRegex(ValueError, label):
                    prepare_disabled.preflight({}, COMMIT)
        with self.preflight_host(empty=False), self.assertRaisesRegex(ValueError, '^database is not empty$'):
            prepare_disabled.preflight({}, COMMIT)

    def test_sql_transport_pins_search_path_without_making_migrations_readonly(self):
        process = Mock(returncode=0)
        process.communicate.return_value = (b't\n', b'')
        with patch.object(prepare_disabled.subprocess, 'Popen', return_value=process) as popen:
            self.assertEqual(prepare_disabled.sql('SELECT true', transaction=True), 't')
        args, options = popen.call_args
        self.assertIn('--single-transaction', args[0])
        self.assertIn('-X', args[0])
        self.assertEqual(options['env']['PGOPTIONS'], '-c search_path=pg_catalog')


class HttpHelperTests(unittest.TestCase):
    def test_duplicate_json_keys_are_not_accepted(self):
        with self.assertRaisesRegex(AssertionError, 'duplicate_json_key'):
            json.loads('{"enabled":false,"enabled":true}', object_pairs_hook=check_disabled_http.strict_object)

    def test_smoke_plan_is_fixed_loopback_and_bounded(self):
        # Intercept before any connection. The actual HTTP contract assertions
        # remain in check(); this protects the smoke route plan from host access.
        with patch.object(check_disabled_http, 'check') as check, \
                patch.object(check_disabled_http.http.client, 'HTTPConnection', side_effect=AssertionError('network')), \
                patch.object(check_disabled_http.signal, 'signal'), \
                patch.object(sys, 'argv', ['check_disabled_http.py']), contextlib.redirect_stdout(io.StringIO()):
            check_disabled_http.main()
        self.assertEqual(check.call_count, 46)
        self.assertEqual({call.args[1] for call in check.call_args_list}, {8876, 8878, 8879, 8880, 8881})

    def test_http_check_rejects_wrong_contract_headers_body_and_status(self):
        body = b'{"error":"route_not_available"}'
        headers = [('content-length', str(len(body))), ('content-type', 'application/json'),
                   ('x-domino-read-contract', check_disabled_http.READ_VERSION),
                   ('cache-control', 'no-store, no-transform'), ('x-content-type-options', 'nosniff'),
                   ('content-security-policy', check_disabled_http.CSP), ('x-domino-request-id', 'a' * 32)]
        cases = [('valid', headers, body, 404, True),
                 ('missingNoTransform', [(k, 'no-store' if k == 'cache-control' else v) for k, v in headers], body, 404, False),
                 ('transformedEncoding', headers + [('content-encoding', 'gzip')], body, 404, False),
                 ('wrongVersion', [(k, 'wrong' if k == 'x-domino-read-contract' else v) for k, v in headers], body, 404, False),
                 ('duplicateHeader', headers + [headers[0]], body, 404, False),
                 ('cookie', headers + [('set-cookie', 'fixture')], body, 404, False),
                 ('cors', headers + [('access-control-allow-origin', '*')], body, 404, False),
                 ('oversizeBody', headers, b'x' * (check_disabled_http.MAX_BODY + 1), 404, False),
                 ('unexpectedStatus', headers, body, 200, False),
                 ('wrongBody', headers, b'{"error":"unrecognized_value"}', 404, False)]
        for name, observed_headers, raw, status, expected in cases:
            with self.subTest(name=name):
                response = Mock(status=status)
                response.getheaders.return_value = observed_headers
                response.read.return_value = raw
                connection = Mock()
                connection.getresponse.return_value = response
                with patch.object(check_disabled_http.http.client, 'HTTPConnection', return_value=connection) as factory, \
                        patch.object(check_disabled_http.signal, 'setitimer'), \
                        patch.object(check_disabled_http, 'DEADLINE', time.monotonic() + 10, create=True), \
                        patch.object(check_disabled_http, 'RESULTS', [], create=True):
                    check_disabled_http.check(name, 8878, 'POST', '/internal/read/v1/token', 404,
                                              {'error': 'route_not_available'})
                    self.assertEqual(check_disabled_http.RESULTS[0]['passed'], expected)
                factory.assert_called_once_with('127.0.0.1', 8878, timeout=4)
                connection.close.assert_called_once()
                if name != 'duplicateHeader':
                    response.read.assert_called_once_with(check_disabled_http.MAX_BODY + 1)


if __name__ == '__main__':
    unittest.main()
