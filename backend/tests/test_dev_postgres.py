"""Cleanup never targets the shared development cluster in these tests."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dev_postgres as pg
from discovery import DataError


class StopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='domino-pg-stop-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root/'runtime'
        self.data = self.runtime/'postgres'
        self.socket = self.runtime/'pgsocket'
        self.addCleanup(patch.stopall)
        patch.multiple(pg, RUNTIME=self.runtime, DATA=self.data, SOCKET=self.socket).start()
        self.run = patch.object(pg.subprocess, 'run').start()
        self.command = patch.object(pg, 'pg_command').start()

    def initialized(self, *, running=False):
        self.data.mkdir(parents=True, mode=0o700)
        self.runtime.chmod(0o700)
        (self.data/'PG_VERSION').write_text('18\n')
        if running:
            pid = self.data/'postmaster.pid'
            pid.write_text(f'12345\n{self.data.resolve()}\n')
            pid.chmod(0o600)
        self.run.return_value.returncode = 0 if running else 3

    def test_never_initialized_does_not_create_paths_or_invoke_tools(self):
        self.assertFalse(pg.stop())
        self.assertFalse(self.runtime.exists())
        self.run.assert_not_called()
        self.command.assert_not_called()

    def test_runtime_without_data_and_empty_data_are_noops(self):
        self.runtime.mkdir(mode=0o700)
        self.assertFalse(pg.stop())
        self.data.mkdir(mode=0o700)
        self.assertFalse(pg.stop())
        self.run.assert_not_called()
        self.command.assert_not_called()

    def test_already_stopped_retains_cluster_and_does_not_signal(self):
        self.initialized()
        self.assertFalse(pg.stop())
        self.assertTrue((self.data/'PG_VERSION').is_file())
        self.command.assert_not_called()
        self.assertEqual(self.run.call_args.args[0][-1], 'status')

    def test_running_task_cluster_uses_fast_bounded_stop(self):
        self.initialized(running=True)
        self.assertTrue(pg.stop())
        self.command.assert_called_once_with([
            str(pg.BIN/'pg_ctl'), '-D', str(self.data), '-m', 'fast', '-w', '-t', '15', 'stop'])

    def test_status_failure_is_not_treated_as_stopped(self):
        self.initialized()
        for result in (1, 2, 4):
            with self.subTest(result=result):
                self.run.return_value.returncode = result
                with self.assertRaisesRegex(DataError, 'local_postgres_command_failed'):
                    pg.stop()
        self.command.assert_not_called()

    def test_stop_failure_is_preserved_unless_another_cleanup_stopped_it(self):
        self.initialized(running=True)
        self.command.side_effect = DataError('local_postgres_command_failed')
        with self.assertRaisesRegex(DataError, 'local_postgres_command_failed'):
            pg.stop()
        self.run.side_effect = [subprocess.CompletedProcess([], 0),
                                subprocess.CompletedProcess([], 3)]
        self.assertFalse(pg.stop())

    def test_runtime_and_data_symlinks_are_refused_before_running_tools(self):
        outside = self.root/'outside'
        outside.mkdir(mode=0o700)
        self.runtime.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(DataError, 'private_postgres_directory_required'):
            pg.stop()
        self.runtime.unlink()
        self.runtime.mkdir(mode=0o700)
        self.data.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(DataError, 'private_postgres_directory_required'):
            pg.stop()
        self.run.assert_not_called()
        self.command.assert_not_called()

    def test_nonprivate_or_foreign_owned_directory_is_refused(self):
        self.initialized()
        for directory in (self.runtime, self.data):
            with self.subTest(directory=directory):
                directory.chmod(0o750)
                with self.assertRaisesRegex(DataError, 'private_postgres_directory_required'):
                    pg.stop()
                directory.chmod(0o700)
        with patch.object(pg.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(DataError, 'private_postgres_directory_required'):
                pg.stop()
        self.run.assert_not_called()

    def test_foreign_data_directory_pid_and_invalid_pid_are_never_signalled(self):
        self.initialized(running=True)
        pid = self.data/'postmaster.pid'
        for content in (f'12345\n{self.root}/another-cluster\n',
                        f'0\n{self.data}\n', f'invalid\n{self.data}\n', '12345\n'):
            with self.subTest(content=content):
                pid.write_text(content)
                with self.assertRaisesRegex(DataError, 'invalid_local_postgres_cluster'):
                    pg.stop()
        self.command.assert_not_called()

    def test_symlinked_pid_and_version_are_refused(self):
        self.initialized(running=True)
        for name in ('postmaster.pid', 'PG_VERSION'):
            with self.subTest(name=name):
                original = self.data/name
                target = self.root/name
                original.replace(target)
                original.symlink_to(target)
                with self.assertRaisesRegex(DataError, 'invalid_local_postgres_cluster'):
                    pg.stop()
                original.unlink()
                target.replace(original)
        self.command.assert_not_called()

    def test_partial_cluster_with_pid_is_refused(self):
        self.initialized(running=True)
        (self.data/'PG_VERSION').unlink()
        with self.assertRaisesRegex(DataError, 'invalid_local_postgres_cluster'):
            pg.stop()
        self.run.assert_not_called()
        self.command.assert_not_called()

    def test_cli_cleanup_succeeds_before_initialization(self):
        with patch.object(sys, 'argv', ['dev_postgres.py', 'stop']), patch('builtins.print'):
            self.assertEqual(pg.main(), 0)
        self.run.assert_not_called()
        self.command.assert_not_called()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'opt-in disposable PostgreSQL cluster')
class DisposableStopTests(unittest.TestCase):
    def test_start_stop_and_repeated_stop_in_unique_private_cluster(self):
        # No dev configuration, migrations, shared socket, or shared DATA path.
        with tempfile.TemporaryDirectory(prefix='domino-stop-pg-', dir='/tmp') as tmp:
            runtime = Path(tmp)
            data, socket = runtime/'postgres', runtime/'pgsocket'
            socket.mkdir(mode=0o700)
            with patch.multiple(pg, RUNTIME=runtime, DATA=data, SOCKET=socket):
                self.assertFalse(pg.stop())
                pg.pg_command([str(pg.BIN/'initdb'), '-D', str(data), '-U', 'stop_test_admin',
                               '--auth-local=trust', '--auth-host=reject', '--locale=C'])
                self.assertFalse(pg.stop())
                try:
                    options = pg.shlex.join(['-k', str(socket), '-p', '18879',
                                            '-c', 'listen_addresses=',
                                            '-c', 'unix_socket_permissions=0700'])
                    pg.pg_command([str(pg.BIN/'pg_ctl'), '-D', str(data), '-l', str(runtime/'postgres.log'),
                                   '-o', options, '-w', '-t', '15', 'start'])
                    self.assertTrue(pg.stop())
                    self.assertFalse(pg.stop())
                    self.assertTrue((data/'PG_VERSION').is_file())
                finally:
                    if (data/'postmaster.pid').exists():
                        pg.pg_command([str(pg.BIN/'pg_ctl'), '-D', str(data), '-m', 'immediate',
                                       '-w', '-t', '15', 'stop'])


class MigrationListTests(unittest.TestCase):
    def test_create_database_applies_every_migration_but_039(self):
        # A test database without a migration tests against the wrong schema: 060's index, for one, decides the
        # plans that test_ledger_predecessor reads. 039 creates a policy that cannot be created twice, and
        # create_database runs again on every start, so test_automation_store applies 039 in its own transaction.
        source = Path(pg.__file__).read_text()
        applied = set(re.findall(r"migrations/([0-9]{3}_[a-z0-9_]+\.sql)", source))
        on_disk = {path.name for path in (Path(pg.__file__).parent/'migrations').glob('*.sql')}
        self.assertEqual(on_disk - applied, {'039_automation_readiness.sql'})
        self.assertEqual(applied - on_disk, set())


if __name__ == '__main__':
    unittest.main()
