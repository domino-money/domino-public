"""The release drop-ins as the runner's own systemd reads them, not as a model does.

The installers' offline tests fold a drop-in over a unit with a model of
systemd. On 24 September that model was wrong: it kept BindPaths and
BindReadOnlyPaths apart, and a drop-in that reset one lost the other in
production. Here systemd itself loads each unit the financial upgrade and the
automation installer write, under each installer's release drop-in, and must
show the same service as the unit written for the new release. A drop-in that resets BindPaths and gives back
only that bind must lose the read-only configuration bind, or the model the
offline tests share is wrong.

It needs root and systemd as PID 1, so it runs only when
DOMINO_TEST_REAL_SYSTEMD=1 asks for it: the hygiene job, under sudo. Nothing is
started. Every file it writes is under /run/systemd/system and removed after.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_auth_release as auth
import install_automation_release as automation
import install_financial_release as installer
import upgrade_financial as financial

RUNTIME_UNITS = Path('/run/systemd/system')
BEFORE, AFTER = 'a' * 40, 'b' * 40
PROPERTIES = ('LoadState', 'Description', 'WorkingDirectory', 'ExecStart', 'BindPaths', 'BindReadOnlyPaths',
              'ReadWritePaths', 'User', 'Group', 'SupplementaryGroups', 'Environment', 'EnvironmentFiles',
              'UnsetEnvironment', 'Type', 'Restart', 'MemoryMax', 'IPAddressAllow', 'IPAddressDeny',
              'RestrictAddressFamilies')
DROPINS = {'auth': auth.dropin_text,
           **{component: (lambda commit, component=component: installer.dropin_text(component, commit))
              for component in installer.COMPONENTS}}


def naive(component, commit):
    """The first auth drop-in's mistake: reset BindPaths and give back only that bind."""
    lines = financial.unit_text(component, commit).splitlines()
    return '\n'.join(['[Service]', next(line for line in lines if line.startswith('WorkingDirectory=')),
                      'BindPaths=', next(line for line in lines if line.startswith('BindPaths='))]) + '\n'


def egress(component):
    """The part of the continuous egress drop-in that shares the bind list."""
    return ('[Service]\nIPAddressAllow=\nIPAddressDeny=\nIPAddressDeny=any\nIPAddressAllow=127.0.0.1/32\n'
            f'BindReadOnlyPaths=/etc/domino/continuous-reads/{component}.hosts:/etc/hosts\n')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_REAL_SYSTEMD') == '1',
                     'needs root and systemd as PID 1; the hygiene job sets DOMINO_TEST_REAL_SYSTEMD=1')
class RealSystemdTests(unittest.TestCase):
    def setUp(self):
        # Asked for explicitly, so a missing precondition fails rather than skips.
        self.assertEqual(os.geteuid(), 0, 'run under sudo')
        self.assertTrue(RUNTIME_UNITS.is_dir(), 'systemd is not running as PID 1')
        self.written = []
        self.addCleanup(self.remove)

    def remove(self):
        for path in reversed(self.written):
            if path.is_dir():
                shutil.rmtree(path)
            elif os.path.lexists(path):
                path.unlink()
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

    def install(self, name, unit, **dropins):
        path = RUNTIME_UNITS / f'{name}.service'
        self.assertFalse(os.path.lexists(path), path)
        self.written.append(path)
        path.write_text(unit)
        if dropins:
            directory = RUNTIME_UNITS / f'{name}.service.d'
            self.assertFalse(os.path.lexists(directory), directory)
            self.written.append(directory)
            directory.mkdir()
            for file, text in dropins.items():
                (directory / f'{file}.conf').write_text(text)

    def show(self, name):
        # --all prints a requested property even when it is empty, as a lost bind list is.
        raw = subprocess.run(['systemctl', 'show', '--all', f'{name}.service', '--property=' + ','.join(PROPERTIES)],
                             check=True, capture_output=True, text=True).stdout
        return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

    def test_each_release_dropin_loads_as_the_unit_written_for_its_release(self):
        for component, dropin in DROPINS.items():
            before, after = financial.unit_text(component, BEFORE), financial.unit_text(component, AFTER)
            name = f'domino-{component}'
            self.install(name, before, **{'50-release': dropin(AFTER)})
            self.install(f'{name}-expected', after)
            self.install(f'{name}-naive', before, **{'50-release': naive(component, AFTER)})
            self.install(f'{name}-egress', before, **{'50-release': dropin(AFTER), '60-continuous-reads': egress(component)})
            self.install(f'{name}-egress-expected', after, **{'60-continuous-reads': egress(component)})
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        for component in DROPINS:
            with self.subTest(component=component):
                name = f'domino-{component}'
                actual, expected = self.show(name), self.show(f'{name}-expected')
                self.assertEqual(actual['LoadState'], 'loaded')
                self.assertEqual(actual['WorkingDirectory'], str(financial.release_root(AFTER, component)))
                config = f'/etc/domino/financial/{component}:/run/domino-financial-{component}-config'
                self.assertIn(config, actual['BindReadOnlyPaths'])
                self.assertIn(f'{financial.release_root(AFTER, component)}/backend/runtime', actual['BindPaths'])
                self.assertEqual(actual, expected)
                # systemd keeps one bind list: resetting BindPaths empties BindReadOnlyPaths too.
                lost = self.show(f'{name}-naive')
                self.assertEqual((lost['BindPaths'], lost.get('BindReadOnlyPaths', '')), (expected['BindPaths'], ''))
                # The egress drop-in sorts after the release drop-in and appends its hosts bind.
                hosts, wanted = self.show(f'{name}-egress'), self.show(f'{name}-egress-expected')
                self.assertEqual(hosts, wanted)
                self.assertIn(config, hosts['BindReadOnlyPaths'])
                self.assertIn(f'/etc/domino/continuous-reads/{component}.hosts:/etc/hosts', hosts['BindReadOnlyPaths'])


    def test_each_automation_release_dropin_loads_as_the_unit_written_for_its_release(self):
        # The configuration generator's drop-in sorts before the release's and names no release.
        keystore = ('[Service]\nLoadCredentialEncrypted=operator-keystore-password:'
                    '/etc/domino/financial/automation/operator-keystore-password.cred\n')
        for name in automation.UNITS:
            unit = f'domino-{name}'
            self.install(unit, automation.unit_text(name, BEFORE), **{'50-release': automation.dropin_text(name, AFTER)})
            self.install(f'{unit}-expected', automation.unit_text(name, AFTER))
        self.install('domino-automation-keyed', automation.unit_text('automation', BEFORE),
                     **{'40-keystore-credentials': keystore, '50-release': automation.dropin_text('automation', AFTER)})
        self.install('domino-automation-keyed-expected', automation.unit_text('automation', AFTER),
                     **{'40-keystore-credentials': keystore})
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        root = financial.release_root(AFTER, 'automation')
        for name in automation.UNITS:
            with self.subTest(unit=name):
                actual = self.show(f'domino-{name}')
                self.assertEqual(actual['LoadState'], 'loaded')
                self.assertEqual(actual['WorkingDirectory'], str(root))
                self.assertEqual(actual, self.show(f'domino-{name}-expected'))
        binds = self.show('domino-automation')
        self.assertIn('/etc/domino/financial/automation:/run/domino-financial-automation-config',
                      binds['BindReadOnlyPaths'])
        self.assertIn(f'/var/lib/domino-financial/automation:{root}/backend/runtime', binds['BindPaths'])
        self.assertEqual(self.show('domino-automation-keyed'), self.show('domino-automation-keyed-expected'))


if __name__ == '__main__':
    unittest.main()
