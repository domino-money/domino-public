"""The automation comes back after a reboot through a target of its own, and stops coming back on rollback."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import install_automation as automation
import install_automation_boot as boot
# One model of how systemd reads a unit file, shared with the release installers'
# tests; test_financial_release_systemd.py holds this target to systemd itself.
from test_install_auth_release import settings


class AutomationBootTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='domino-automation-boot-')).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        self.units = self.root / 'systemd'
        self.units.mkdir()
        for item in (patch.object(boot.release.release_tool, 'UNIT_DIR', self.units),
                     patch.object(boot.filesystem, 'protected_parents', lambda path: None),
                     patch.object(boot.os, 'geteuid', lambda: 0),
                     patch.object(boot.install, 'run', self.fake_run)):
            item.start()
            self.addCleanup(item.stop)
        self.states = {member: {'LoadState': 'loaded', 'FragmentPath': str(self.units / member)}
                       for member in boot.MEMBERS}
        self.states[boot.TARGET] = {'LoadState': 'not-found', 'FragmentPath': ''}
        self.commands = []

    def fake_run(self, args, *, data=None, stdout=None):
        self.commands.append(args)
        if args[:2] == ['/usr/bin/systemctl', 'show'] and args[2] in self.states:
            return ''.join(f'{k}={v}\n' for k, v in self.states[args[2]].items()).encode()
        raise AssertionError(f'unexpected host command: {args}')

    def test_the_target_wants_the_serve_loop_and_the_gas_peers_triggers_and_multi_user_wants_it(self):
        parsed = settings(boot.target_text())
        members = ' '.join(boot.MEMBERS)
        self.assertEqual((parsed['[Unit]']['Wants'], parsed['[Unit]']['After']), ([members], [members]))
        self.assertEqual(parsed['[Install]']['WantedBy'], ['multi-user.target'])
        # The installer's units: the serve loop, and what starts each gas peer; never the peers themselves.
        self.assertEqual(set(boot.MEMBERS), {automation.UNIT, 'domino-gas-reservation.socket', 'domino-gas-settlement.timer'})
        self.assertTrue(set(boot.MEMBERS) - {automation.UNIT} <= set(automation.PEER_UNITS))
        self.assertTrue(boot.target_text().startswith(boot.HEADER))

    def test_apply_on_a_clean_host_writes_the_target_then_the_link_whatever_the_umask(self):
        planned = boot.plan()
        self.assertEqual(planned['changes'], ['target', 'link'])
        self.assertIn('start, stop, restart or daemon-reload', planned['notPerformed'])
        umask = os.umask(0o077)
        try:
            result = boot.apply(planned)
        finally:
            os.umask(umask)
        target, link = boot.paths()
        self.assertEqual((target, link), (self.units / boot.TARGET, self.units / 'multi-user.target.wants' / boot.TARGET))
        self.assertEqual(target.read_text(), boot.target_text())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
        self.assertEqual(os.readlink(link), str(target))
        self.assertEqual(stat.S_IMODE(link.parent.stat().st_mode), 0o755)
        self.assertEqual((result['written'], result['activated']), (['target', 'link'], False))
        self.assertIn('systemctl daemon-reload', result['activation'])
        # Only reads went to systemd.
        self.assertTrue(self.commands and all(command[:2] == ['/usr/bin/systemctl', 'show'] for command in self.commands))
        # Again, once systemd has loaded it: nothing left to do.
        self.states[boot.TARGET] = {'LoadState': 'loaded', 'FragmentPath': str(target)}
        self.assertEqual(boot.plan()['changes'], [])
        self.assertEqual(boot.apply(boot.plan())['written'], [])

    def test_the_wants_directory_other_units_are_linked_from_is_kept(self):
        wants = self.units / 'multi-user.target.wants'
        wants.mkdir(mode=0o755)
        other = wants / 'postgresql@16-domino.service'
        other.symlink_to('/usr/lib/systemd/system/postgresql@.service')
        boot.apply(boot.plan())
        self.assertEqual(sorted(path.name for path in wants.iterdir()), [boot.TARGET, other.name])
        boot.rollback()
        self.assertEqual([path.name for path in wants.iterdir()], [other.name])

    def test_the_members_must_be_the_installers_units_loaded_from_here(self):
        for member in boot.MEMBERS:
            for changes, reason in (({'LoadState': 'not-found'}, 'member_not_loaded'),
                                    ({'FragmentPath': f'/usr/lib/systemd/system/{member}'}, 'member_moved')):
                with self.subTest(member=member, reason=reason):
                    saved = self.states[member]
                    self.states[member] = {**saved, **changes}
                    with self.assertRaisesRegex(ValueError, reason):
                        boot.plan()
                    self.states[member] = saved
        self.assertFalse(boot.paths()[0].exists())

    def test_only_this_tools_target_and_link_are_accepted(self):
        target, link = boot.paths()
        target.write_text(boot.target_text() + 'Wants=domino-execution-signer.service\n')
        with self.assertRaisesRegex(ValueError, 'target_drift'):
            boot.plan()
        target.unlink()
        target.symlink_to(self.root / 'elsewhere.target')
        (self.root / 'elsewhere.target').write_text(boot.target_text())
        with self.assertRaisesRegex(ValueError, 'target_drift'):
            boot.plan()
        target.unlink()
        target.write_text(boot.target_text())
        link.parent.mkdir()
        link.write_text('')
        with self.assertRaisesRegex(ValueError, 'wants_link_foreign'):
            boot.plan()
        link.unlink()
        link.symlink_to(self.root / 'elsewhere.target')
        with self.assertRaisesRegex(ValueError, 'wants_link_foreign'):
            boot.plan()
        link.unlink()
        # A file of the same name elsewhere is the one systemd would run.
        self.states[boot.TARGET] = {'LoadState': 'loaded', 'FragmentPath': f'/usr/lib/systemd/system/{boot.TARGET}'}
        with self.assertRaisesRegex(ValueError, 'target_moved'):
            boot.plan()
        with self.assertRaisesRegex(ValueError, 'target_moved'):
            boot.rollback()
        self.states[boot.TARGET] = {'LoadState': 'loaded', 'FragmentPath': str(target)}
        self.assertEqual(boot.plan()['changes'], ['link'])

    def test_an_apply_cut_between_target_and_link_is_finished_by_another_or_undone_by_rollback(self):
        planned = boot.plan()
        with patch.object(Path, 'symlink_to', side_effect=OSError('busy')), self.assertRaisesRegex(OSError, 'busy'):
            boot.apply(planned)
        target, link = boot.paths()
        self.assertTrue(target.is_file())
        self.assertFalse(os.path.lexists(link))
        self.assertEqual(boot.plan()['changes'], ['link'])
        self.assertEqual(boot.rollback()['removed'], [str(target)])
        self.assertFalse(os.path.lexists(target))
        boot.apply(boot.plan())
        self.assertEqual(os.readlink(link), str(target))

    def test_rollback_removes_the_link_then_the_target_and_nothing_else(self):
        boot.apply(boot.plan())
        target, link = boot.paths()
        removed = []
        unlink = Path.unlink

        def recording(path, *args, **kwargs):
            removed.append(str(path))
            return unlink(path, *args, **kwargs)
        # A member removed since, by the installer's rollback, does not keep the boot wiring in place.
        self.states[automation.UNIT] = {'LoadState': 'not-found', 'FragmentPath': ''}
        with patch.object(Path, 'unlink', recording):
            result = boot.rollback()
        self.assertEqual(removed, [str(link), str(target)])
        self.assertEqual((result['removed'], result['activated']), ([str(link), str(target)], False))
        self.assertIn('keep running', result['action'])
        self.assertFalse(os.path.lexists(link) or os.path.lexists(target))
        # Twice is harmless.
        self.assertEqual(boot.rollback()['removed'], [])

    def test_rollback_never_removes_what_it_did_not_write(self):
        boot.apply(boot.plan())
        target, link = boot.paths()
        target.write_text(boot.target_text().replace('After=', 'Before='))
        with self.assertRaisesRegex(ValueError, 'target_drift'):
            boot.rollback()
        self.assertTrue(link.is_symlink() and target.is_file())
        target.write_text(boot.target_text())
        link.unlink()
        link.symlink_to(self.root / 'elsewhere.target')
        with self.assertRaisesRegex(ValueError, 'wants_link_foreign'):
            boot.rollback()
        self.assertTrue(link.is_symlink() and target.is_file())

    def test_apply_and_rollback_need_root(self):
        planned = boot.plan()
        with patch.object(boot.os, 'geteuid', lambda: 1000):
            with self.assertRaisesRegex(ValueError, 'root_required'):
                boot.apply(planned)
            with self.assertRaisesRegex(ValueError, 'root_required'):
                boot.rollback()
        self.assertFalse(os.path.lexists(boot.paths()[0]))

    def main(self, *argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = boot.main(list(argv))
        return code, json.loads(output.getvalue())

    def test_the_command_line_inspects_freely_and_applies_and_rolls_back_as_root_under_the_lock(self):
        taken = []

        @contextlib.contextmanager
        def exclusive():
            taken.append(True)
            yield
        with patch.object(boot.release, 'exclusive', exclusive):
            with patch.object(boot.os, 'geteuid', lambda: 1000):
                code, inspected = self.main('--inspect')
                self.assertEqual((code, inspected['ok'], inspected['changes'], taken), (0, True, ['target', 'link'], []))
                for mode in ('--apply', '--rollback'):
                    code, refused = self.main(mode)
                    self.assertEqual((code, refused['reason'], taken), (1, 'root_required', []))
            code, applied = self.main('--apply')
            self.assertEqual((code, applied['written'], taken), (0, ['target', 'link'], [True]))
            code, rolled = self.main('--rollback')
            self.assertEqual((code, len(rolled['removed']), taken), (0, 2, [True, True]))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                boot.main(['--apply', '--rollback'])


if __name__ == '__main__':
    unittest.main()
