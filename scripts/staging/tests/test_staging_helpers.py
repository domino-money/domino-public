"""Unprivileged offline regressions; never run an installer or a host verifier."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalogue_inventory
import check_disabled_http
import check_filesystem
import check_roles
import prepare_disabled

COMMIT = 'a' * 40


class ArchiveTests(unittest.TestCase):
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

    def test_untrusted_members_are_rejected_without_extraction(self):
        cases = [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                 ('backend/../outside', tarfile.REGTYPE), ('backend//extra', tarfile.REGTYPE),
                 ('backend/./extra', tarfile.REGTYPE), ('backend\\extra', tarfile.REGTYPE),
                 ('bad\nname', tarfile.REGTYPE), ('backend/runtime/file', tarfile.REGTYPE),
                 ('backend/.venv/file', tarfile.REGTYPE), ('.git/config', tarfile.REGTYPE),
                 ('node_modules/file', tarfile.REGTYPE), ('backend/link', tarfile.SYMTYPE),
                 ('backend/hardlink', tarfile.LNKTYPE), ('backend/fifo', tarfile.FIFOTYPE),
                 ('backend/device', tarfile.CHRTYPE), ('backend/read_api.py', tarfile.REGTYPE),
                 ('backend/migrations/015_extra.sql', tarfile.REGTYPE)]
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
                   ('cache-control', 'no-store'), ('x-content-type-options', 'nosniff'),
                   ('content-security-policy', check_disabled_http.CSP), ('x-domino-request-id', 'a' * 32)]
        cases = [('valid', headers, body, 404, True),
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
