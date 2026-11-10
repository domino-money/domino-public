"""The release drop-ins, and the public-data timers, as the runner's own systemd reads them, not as a model does.

The installers' offline tests fold a drop-in over a unit with a model of
systemd. On 24 September that model was wrong: it kept BindPaths and
BindReadOnlyPaths apart, and a drop-in that reset one lost the other in
production. Here systemd itself loads each unit the financial upgrade and the
automation installer write, under each installer's release drop-in, and must
show the same service as the unit written for the new release. The target
that brings the automation back after a reboot is loaded the same way, with the
link `systemctl enable` would make, and must be wanted at boot and want the
three units it names. A drop-in that resets BindPaths and gives back
only that bind must lose the read-only configuration bind, or the model the
offline tests share is wrong. The V2 indexer's template must run the chain its
instance names, as the writer, and come back after any exit.

It needs root and systemd as PID 1, so it runs only when
DOMINO_TEST_REAL_SYSTEMD=1 asks for it: the hygiene job, under sudo. Nothing is
started. Every file it writes is under /run/systemd/system and removed after.
"""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_auth_release as auth
import install_automation_boot as boot
import install_automation_release as automation
import continuous_egress_policy as egress_policy
import install_crosschain as crosschain
import install_monitor as monitor
import install_points_api as points_listener
import install_financial_release as installer
import install_position_plan as position_plan
import install_v2_automation as automation_v2
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


    def install_timer(self, name, dropin):
        """A minute's timer as the VM's base unit has it, under a public-data drop-in; never started."""
        service, timer = RUNTIME_UNITS / f'{name}.service', RUNTIME_UNITS / f'{name}.timer'
        directory = RUNTIME_UNITS / f'{name}.timer.d'
        for path in (service, timer, directory):
            self.assertFalse(os.path.lexists(path), path)
            self.written.append(path)
        service.write_text('[Service]\nType=oneshot\nExecStart=/bin/true\n')
        timer.write_text(f'[Timer]\nOnBootSec=2min\nOnUnitActiveSec=60s\nUnit={name}.service\n')
        directory.mkdir()
        (directory / '90-public-data.conf').write_text(dropin)

    def test_the_public_data_timers_load_a_minute_calendar_and_no_chain_a_reboot_leaves_elapsed(self):
        # #278: an empty OnUnitActiveSec= after OnBootSec=30s and OnActiveSec=30s reset every
        # trigger; systemd kept only OnUnitInactiveSec=60s, which never fires after a reboot.
        ops = Path(__file__).resolve().parents[3] / 'ops/systemd'
        timers = ('domino-queue-worker', 'domino-catalogue-follower')
        for name in timers:
            self.install_timer(f'{name}-under-test', (ops / f'{name}.timer.d/90-public-data.conf').read_text())
        self.install_timer('domino-timer-reset-under-test',
                           '[Timer]\nOnBootSec=\nOnBootSec=30s\nOnActiveSec=30s\nOnUnitActiveSec=\nOnUnitInactiveSec=60s\n')
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

        def show(name):
            raw = subprocess.run(['systemctl', 'show', '--all', f'{name}.timer',
                                  '--property=LoadState,TimersMonotonic,TimersCalendar'],
                                 check=True, capture_output=True, text=True).stdout
            return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        for name in timers:
            with self.subTest(timer=name):
                shown = show(f'{name}-under-test')
                self.assertEqual(shown['LoadState'], 'loaded')
                self.assertEqual(shown.get('TimersMonotonic', ''), '')
                self.assertIn('OnCalendar=*-*-* *:*:00', shown.get('TimersCalendar', ''))
        # The Domino pool follower ships its own timer, not a drop-in: the same calendar, alone.
        service, timer = RUNTIME_UNITS / 'domino-activity-follow-under-test.service', \
            RUNTIME_UNITS / 'domino-activity-follow-under-test.timer'
        for path in (service, timer):
            self.assertFalse(os.path.lexists(path), path)
            self.written.append(path)
        service.write_text('[Service]\nType=oneshot\nExecStart=/bin/true\n')
        timer.write_text((ops / 'domino-activity-follow.timer').read_text().replace(
            'Unit=domino-activity-follow.service', 'Unit=domino-activity-follow-under-test.service'))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        follower = show('domino-activity-follow-under-test')
        self.assertEqual(follower['LoadState'], 'loaded')
        self.assertEqual(follower.get('TimersMonotonic', ''), '')
        self.assertIn('OnCalendar=*-*-* *:*:00', follower.get('TimersCalendar', ''))
        # The drop-in this replaces: what one empty assignment leaves of the triggers before it.
        lost = show('domino-timer-reset-under-test')
        self.assertIn('OnUnitInactiveUSec=1min', lost.get('TimersMonotonic', ''))
        for erased in ('OnBootUSec', 'OnActiveUSec', 'OnUnitActiveUSec'):
            self.assertNotIn(erased, lost.get('TimersMonotonic', ''))

    def test_the_v2_indexer_template_runs_its_instance_chain_and_always_comes_back(self):
        # `follow` exits 0 after five failed rounds, so only Restart=always revives it, and the
        # instance name is the only place the chain comes from.
        ops = Path(__file__).resolve().parents[3] / 'ops/systemd'
        template = RUNTIME_UNITS / 'domino-v2-indexer-under-test@.service'
        self.assertFalse(os.path.lexists(template), template)
        self.written.append(template)
        template.write_text((ops / 'domino-v2-indexer@.service').read_text()
                            .replace('@PUBLIC_ROOT@', '/opt/domino/public-data')
                            .replace('@QUEUE_ROOT@', '/opt/domino/queue-worker'))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        raw = subprocess.run(['systemctl', 'show', '--all', 'domino-v2-indexer-under-test@robinhood-4663.service',
                              '--property=LoadState,ExecStart,Restart,User,SupplementaryGroups,WorkingDirectory,'
                              'PartOf,BindsTo,BindReadOnlyPaths,ProtectSystem,UnitFileState,ImportCredential,'
                              'DeviceAllow'],
                             check=True, capture_output=True, text=True).stdout
        shown = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        self.assertEqual(shown['LoadState'], 'loaded')
        self.assertIn('argv[]=/opt/domino/queue-worker/venv/bin/python -B v2_indexer.py follow '
                      '--chain robinhood-4663 --chain-rpc-file '
                      '/opt/domino/queue-worker/release/backend/runtime/chain-rpc.json '
                      '--waiting-file /var/lib/domino-v2-automation-public/robinhood-4663.waiting.json ;',
                      shown['ExecStart'])
        # Base and Arbitrum read hosted providers whose keys are sealed credentials; the glob takes all of them.
        # systemd shows a glob quoted (CI run 37243142942).
        self.assertEqual(shlex.split(shown['ImportCredential']), ['v2-rpc-*'])
        # One line per entry, so not in the dict: the TPM the sealed credentials need, beside ProtectClock's rtc.
        self.assertIn('DeviceAllow=char-tpm rw', raw.splitlines())
        self.assertEqual(shown['Restart'], 'always')
        self.assertEqual((shown['User'], shown['SupplementaryGroups']), ('domino-write', 'domino-db'))
        self.assertEqual(shown['WorkingDirectory'], '/opt/domino/public-data/current/backend')
        self.assertEqual((shown['PartOf'], shown['BindsTo']),
                         ('domino-public-data.target', 'domino-continuous-egress.service'))
        # systemd shows a bind with its default option (CI run 37237979007).
        self.assertEqual(shown['BindReadOnlyPaths'], '/etc/domino/continuous-reads/write.hosts:/etc/hosts:rbind')
        self.assertEqual(shown['ProtectSystem'], 'strict')
        # Installed is not enabled: no instance is wanted until an operator enables it. The template has an
        # [Install] section, so it is never static either.
        self.assertIn(shown['UnitFileState'], ('disabled', 'indirect'))

    def test_the_featured_chain_templates_run_their_instance_chain_from_a_minute_timer(self):
        # Launch round P3 (4 Nov 2026): Base's and Arbitrum's shadow selections, one instance per chain, each
        # started by its own timer instance; the instance name is the only place the chain comes from.
        ops = Path(__file__).resolve().parents[3] / 'ops/systemd'
        service = RUNTIME_UNITS / 'domino-featured-chain-under-test@.service'
        timer = RUNTIME_UNITS / 'domino-featured-chain-under-test@.timer'
        for path in (service, timer):
            self.assertFalse(os.path.lexists(path), path)
            self.written.append(path)
        service.write_text((ops / 'domino-featured-chain@.service').read_text()
                           .replace('@PUBLIC_ROOT@', '/opt/domino/public-data')
                           .replace('@QUEUE_ROOT@', '/opt/domino/queue-worker'))
        timer.write_text((ops / 'domino-featured-chain@.timer').read_text())
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

        def show(name, properties):
            raw = subprocess.run(['systemctl', 'show', '--all', name, '--property=' + properties],
                                 check=True, capture_output=True, text=True).stdout
            return raw, dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        raw, shown = show('domino-featured-chain-under-test@base-8453.service',
                          'LoadState,Type,ExecStart,User,SupplementaryGroups,WorkingDirectory,PartOf,BindsTo,'
                          'BindReadOnlyPaths,ProtectSystem,ImportCredential,DeviceAllow')
        self.assertEqual((shown['LoadState'], shown['Type']), ('loaded', 'oneshot'))
        self.assertIn('argv[]=/opt/domino/queue-worker/venv/bin/python -B manage_featured_chain.py '
                      '--chain base-8453 --chain-rpc-file '
                      '/opt/domino/queue-worker/release/backend/runtime/chain-rpc.json tick ;',
                      shown['ExecStart'])
        self.assertEqual(shlex.split(shown['ImportCredential']), ['v2-rpc-*'])
        self.assertIn('DeviceAllow=char-tpm rw', raw.splitlines())
        self.assertEqual((shown['User'], shown['SupplementaryGroups']), ('domino-write', 'domino-db'))
        self.assertEqual(shown['WorkingDirectory'], '/opt/domino/public-data/current/backend')
        self.assertEqual((shown['PartOf'], shown['BindsTo']),
                         ('domino-public-data.target', 'domino-continuous-egress.service'))
        self.assertEqual(shown['BindReadOnlyPaths'], '/etc/domino/continuous-reads/write.hosts:/etc/hosts:rbind')
        self.assertEqual(shown['ProtectSystem'], 'strict')
        _, timed = show('domino-featured-chain-under-test@base-8453.timer',
                        'LoadState,TimersMonotonic,TimersCalendar,Triggers,UnitFileState')
        self.assertEqual(timed['LoadState'], 'loaded')
        self.assertEqual(timed.get('TimersMonotonic', ''), '')
        self.assertIn('OnCalendar=*-*-* *:*:00', timed.get('TimersCalendar', ''))
        self.assertEqual(timed['Triggers'], 'domino-featured-chain-under-test@base-8453.service')
        # Installed is not enabled: no chain's shadow runs until an operator enables its timer.
        self.assertIn(timed['UnitFileState'], ('disabled', 'indirect'))

    def test_the_v2_fees_template_runs_its_instance_chain_and_always_comes_back(self):
        # Launch round P3 (4 Nov 2026): the indexer's user, sandbox, hosts and credentials; its chain is the instance.
        ops = Path(__file__).resolve().parents[3] / 'ops/systemd'
        template = RUNTIME_UNITS / 'domino-v2-fees-under-test@.service'
        self.assertFalse(os.path.lexists(template), template)
        self.written.append(template)
        template.write_text((ops / 'domino-v2-fees@.service').read_text()
                            .replace('@PUBLIC_ROOT@', '/opt/domino/public-data')
                            .replace('@QUEUE_ROOT@', '/opt/domino/queue-worker'))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        raw = subprocess.run(['systemctl', 'show', '--all', 'domino-v2-fees-under-test@base-8453.service',
                              '--property=LoadState,ExecStart,Restart,User,SupplementaryGroups,WorkingDirectory,'
                              'PartOf,BindsTo,BindReadOnlyPaths,ProtectSystem,UnitFileState,ImportCredential,'
                              'DeviceAllow'],
                             check=True, capture_output=True, text=True).stdout
        shown = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        self.assertEqual(shown['LoadState'], 'loaded')
        self.assertIn('argv[]=/opt/domino/queue-worker/venv/bin/python -B v2_fees.py follow --chain base-8453 '
                      '--chain-rpc-file /opt/domino/queue-worker/release/backend/runtime/chain-rpc.json --poll 60 ;',
                      shown['ExecStart'])
        self.assertEqual(shlex.split(shown['ImportCredential']), ['v2-rpc-*'])
        self.assertIn('DeviceAllow=char-tpm rw', raw.splitlines())
        self.assertEqual(shown['Restart'], 'always')
        self.assertEqual((shown['User'], shown['SupplementaryGroups']), ('domino-write', 'domino-db'))
        self.assertEqual(shown['WorkingDirectory'], '/opt/domino/public-data/current/backend')
        self.assertEqual((shown['PartOf'], shown['BindsTo']),
                         ('domino-public-data.target', 'domino-continuous-egress.service'))
        self.assertEqual(shown['BindReadOnlyPaths'], '/etc/domino/continuous-reads/write.hosts:/etc/hosts:rbind')
        self.assertEqual(shown['ProtectSystem'], 'strict')
        self.assertIn(shown['UnitFileState'], ('disabled', 'indirect'))

    def test_the_points_ledger_template_runs_its_instance_chain_and_always_comes_back(self):
        # Points, season 1 (7 Nov 2026): the V2 fees' user, sandbox, hosts and credentials; its chain is the instance.
        ops = Path(__file__).resolve().parents[3] / 'ops/systemd'
        template = RUNTIME_UNITS / 'domino-points-ledger-under-test@.service'
        self.assertFalse(os.path.lexists(template), template)
        self.written.append(template)
        template.write_text((ops / 'domino-points-ledger@.service').read_text()
                            .replace('@PUBLIC_ROOT@', '/opt/domino/public-data')
                            .replace('@QUEUE_ROOT@', '/opt/domino/queue-worker'))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        raw = subprocess.run(['systemctl', 'show', '--all', 'domino-points-ledger-under-test@robinhood-4663.service',
                              '--property=LoadState,ExecStart,Restart,User,SupplementaryGroups,WorkingDirectory,'
                              'PartOf,BindsTo,BindReadOnlyPaths,ProtectSystem,UnitFileState,ImportCredential,'
                              'DeviceAllow'],
                             check=True, capture_output=True, text=True).stdout
        shown = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        self.assertEqual(shown['LoadState'], 'loaded')
        self.assertIn('argv[]=/opt/domino/queue-worker/venv/bin/python -B points_ledger.py follow --chain '
                      'robinhood-4663 --chain-rpc-file /opt/domino/queue-worker/release/backend/runtime/chain-rpc.json '
                      '--poll 60 ;', shown['ExecStart'])
        self.assertEqual(shlex.split(shown['ImportCredential']), ['v2-rpc-*'])
        self.assertIn('DeviceAllow=char-tpm rw', raw.splitlines())
        self.assertEqual(shown['Restart'], 'always')
        self.assertEqual((shown['User'], shown['SupplementaryGroups']), ('domino-write', 'domino-db'))
        self.assertEqual(shown['WorkingDirectory'], '/opt/domino/public-data/current/backend')
        self.assertEqual((shown['PartOf'], shown['BindsTo']),
                         ('domino-public-data.target', 'domino-continuous-egress.service'))
        self.assertEqual(shown['BindReadOnlyPaths'], '/etc/domino/continuous-reads/write.hosts:/etc/hosts:rbind')
        self.assertEqual(shown['ProtectSystem'], 'strict')
        self.assertIn(shown['UnitFileState'], ('disabled', 'indirect'))

    def test_the_v2_automation_template_runs_each_chain_with_its_sealed_passwords(self):
        # One instance per chain: its configuration, its own state directory, the two keystore passwords as
        # encrypted credentials, the hosted RPC URLs imported, and the TPM open for both.
        template = RUNTIME_UNITS / 'domino-v2-automation-under-test@.service'
        self.assertFalse(os.path.lexists(template), template)
        self.written.append(template)
        template.write_text(automation_v2.unit_text(AFTER))
        self.plan_reload()
        name = 'domino-v2-automation-under-test@base-8453'
        raw = subprocess.run(['systemctl', 'show', '--all', f'{name}.service',
                              '--property=LoadState,ExecStart,User,StateDirectory,ImportCredential,'
                              'LoadCredentialEncrypted,DeviceAllow,BindReadOnlyPaths,ProtectSystem,UnitFileState'],
                             check=True, capture_output=True, text=True).stdout
        shown = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        self.assertEqual((shown['LoadState'], shown['User'], shown['ProtectSystem']),
                         ('loaded', 'domino-v2-automation', 'strict'))
        self.assertIn('-B backend/v2_automation.py --config /run/domino-v2-automation-config/base-8453.json serve ;',
                      shown['ExecStart'])
        self.assertEqual(shown['StateDirectory'], 'domino-v2-automation/base-8453')
        self.assertEqual(shlex.split(shown['ImportCredential']), ['v2-rpc-*'])
        # systemd 255 shows this list as "[unprintable]" (CI run 37252557773): present, its names pinned offline
        # by test_install_v2_automation.py; loaded here means both lines parsed.
        self.assertEqual(shown['LoadCredentialEncrypted'], '[unprintable]')
        self.assertIn('DeviceAllow=char-tpm rw', raw.splitlines())
        for target in ('/run/domino-v2-automation-config', '/run/domino-v2-deployments', '/etc/hosts'):
            self.assertIn(target, shown['BindReadOnlyPaths'])
        self.assertIn(shown['UnitFileState'], ('disabled', 'indirect'))

    def test_the_plan_listener_loads_disabled_and_the_egress_drop_in_enables_it(self):
        # The unit starts without --enable, takes the sealed Uniswap key only as a credential, and the continuous
        # egress policy's drop-in (an empty ExecStart= then the enable command) is what switches it on.
        name = 'domino-position-plan-under-test'
        self.install(name, position_plan.unit_text(AFTER))
        self.plan_reload()
        shown = self.plan_show(name, 'LoadState', 'ExecStart', 'User', 'ImportCredential', 'BindReadOnlyPaths',
                               'UnsetEnvironment', 'ProtectSystem')
        self.assertEqual((shown['LoadState'], shown['User'], shown['ProtectSystem']),
                         ('loaded', 'domino-position-plan', 'strict'))
        self.assertIn('-B backend/v2_position_plan_api.py --port 8911 ;', shown['ExecStart'])
        self.assertNotIn('--enable', shown['ExecStart'])
        # A set in systemd, shown in no fixed order and with the glob quoted (CI run 37243142942).
        self.assertEqual(sorted(shlex.split(shown['ImportCredential'])), ['uniswap-api-key', 'v2-rpc-*'])
        # systemd 255 leaves the TPM out of the device policy for ImportCredential=; on the VM the sealed key
        # then failed to decrypt under PrivateDevices=yes (4 Oct). The unit opens it itself.
        devices = subprocess.run(['systemctl', 'show', f'{name}.service', '--property=DeviceAllow'],
                                 check=True, capture_output=True, text=True).stdout.splitlines()
        self.assertIn('DeviceAllow=char-tpm rw', devices)
        self.assertIn('DOMINO_UNISWAP_API_KEY', shown['UnsetEnvironment'])
        for target in ('/run/domino-financial-position-plan-config', '/run/domino-v2-deployments'):
            self.assertIn(target, shown['BindReadOnlyPaths'])
        enable = egress_policy.enable_command('position-plan')
        dropin_dir = RUNTIME_UNITS / f'{name}.service.d'
        self.assertFalse(os.path.lexists(dropin_dir), dropin_dir)
        self.written.append(dropin_dir)
        dropin_dir.mkdir()
        (dropin_dir / egress_policy.DROPIN).write_text('[Service]\nExecStart=\n' + enable + '\n')
        self.plan_reload()
        shown = self.plan_show(name, 'ExecStart')
        self.assertIn('--port 8911 --enable --rpc-config /run/domino-financial-position-plan-config/rpc.json ;',
                      shown['ExecStart'])
        self.assertEqual(shown['ExecStart'].count('argv[]='), 1)

    def test_the_crosschain_listener_loads_disabled_and_the_egress_drop_in_enables_it(self):
        # As the plan listener: no --enable in the unit, the providers' keys only as credentials with the TPM in
        # the device policy, and the continuous egress policy's drop-in is what switches it on.
        name = 'domino-crosschain-under-test'
        self.install(name, crosschain.unit_text(AFTER))
        self.plan_reload()
        shown = self.plan_show(name, 'LoadState', 'ExecStart', 'User', 'ImportCredential', 'BindReadOnlyPaths',
                               'UnsetEnvironment', 'ProtectSystem')
        self.assertEqual((shown['LoadState'], shown['User'], shown['ProtectSystem']),
                         ('loaded', 'domino-crosschain', 'strict'))
        self.assertIn('-B backend/crosschain_api.py --port 8910 ;', shown['ExecStart'])
        self.assertNotIn('--enable', shown['ExecStart'])
        self.assertEqual(sorted(shlex.split(shown['ImportCredential'])),
                         ['across-api-key', 'relay-api-key', 'v2-rpc-*'])
        devices = subprocess.run(['systemctl', 'show', f'{name}.service', '--property=DeviceAllow'],
                                 check=True, capture_output=True, text=True).stdout.splitlines()
        self.assertIn('DeviceAllow=char-tpm rw', devices)
        for variable in ('DOMINO_RELAY_API_KEY', 'DOMINO_ACROSS_API_KEY'):
            self.assertIn(variable, shown['UnsetEnvironment'])
        self.assertIn('/run/domino-financial-crosschain-config', shown['BindReadOnlyPaths'])
        enable = egress_policy.enable_command('crosschain')
        dropin_dir = RUNTIME_UNITS / f'{name}.service.d'
        self.assertFalse(os.path.lexists(dropin_dir), dropin_dir)
        self.written.append(dropin_dir)
        dropin_dir.mkdir()
        (dropin_dir / egress_policy.DROPIN).write_text('[Service]\nExecStart=\n' + enable + '\n')
        self.plan_reload()
        shown = self.plan_show(name, 'ExecStart')
        self.assertIn('--port 8910 --enable --rpc-config /run/domino-financial-crosschain-config/rpc.json ;',
                      shown['ExecStart'])
        self.assertEqual(shown['ExecStart'].count('argv[]='), 1)

    def test_the_points_listener_loads_disabled_holds_no_credential_and_the_egress_drop_in_enables_it(self):
        # As the plan and crosschain listeners: no --enable in the unit, and the continuous egress policy's drop-in
        # is what switches it on. It holds no key, so it imports no credential and keeps the TPM out of its devices.
        name = 'domino-points-under-test'
        self.install(name, points_listener.unit_text(AFTER))
        self.plan_reload()
        shown = self.plan_show(name, 'LoadState', 'ExecStart', 'User', 'ImportCredential', 'BindReadOnlyPaths',
                               'BindPaths', 'ProtectSystem', 'PrivateDevices')
        self.assertEqual((shown['LoadState'], shown['User'], shown['ProtectSystem'], shown['PrivateDevices']),
                         ('loaded', 'domino-points', 'strict', 'yes'))
        self.assertIn('-B backend/points_api.py --port 8912 ;', shown['ExecStart'])
        self.assertNotIn('--enable', shown['ExecStart'])
        self.assertEqual(shown.get('ImportCredential', ''), '')
        devices = subprocess.run(['systemctl', 'show', f'{name}.service', '--property=DeviceAllow'],
                                 check=True, capture_output=True, text=True).stdout.splitlines()
        self.assertNotIn('DeviceAllow=char-tpm rw', devices)
        self.assertIn('/run/domino-financial-points-config', shown['BindReadOnlyPaths'])
        self.assertIn('/var/lib/domino-financial/points', shown['BindPaths'])
        enable = egress_policy.enable_command('points')
        dropin_dir = RUNTIME_UNITS / f'{name}.service.d'
        self.assertFalse(os.path.lexists(dropin_dir), dropin_dir)
        self.written.append(dropin_dir)
        dropin_dir.mkdir()
        (dropin_dir / egress_policy.DROPIN).write_text('[Service]\nExecStart=\n' + enable + '\n')
        self.plan_reload()
        shown = self.plan_show(name, 'ExecStart')
        self.assertIn('--port 8912 --enable --rpc-config /run/domino-financial-points-config/rpc.json ;',
                      shown['ExecStart'])
        self.assertEqual(shown['ExecStart'].count('argv[]='), 1)

    def test_the_monitor_unit_reads_the_journal_takes_its_credentials_and_is_wanted_at_boot(self):
        # Its own unit, outside the read path's target; the journal through its group; the Telegram token and the
        # hosted chains' URLs as credentials, with the TPM in the device policy.
        name = 'domino-monitor-under-test'
        self.install(name, monitor.unit_text(AFTER))
        self.plan_reload()
        shown = self.plan_show(name, 'LoadState', 'ExecStart', 'User', 'SupplementaryGroups', 'ImportCredential',
                               'BindReadOnlyPaths', 'StateDirectory', 'ProtectSystem', 'Restart', 'WantedBy',
                               'PartOf', 'BindsTo')
        self.assertEqual((shown['LoadState'], shown['User'], shown['ProtectSystem'], shown['Restart']),
                         ('loaded', 'domino-monitor', 'strict', 'always'))
        self.assertEqual(shown['SupplementaryGroups'], 'systemd-journal')
        self.assertIn('-B backend/ops_monitor.py --config /run/domino-monitor-config/config.json serve ;',
                      shown['ExecStart'])
        self.assertEqual(sorted(shlex.split(shown['ImportCredential'])), ['telegram-bot-token', 'v2-rpc-*'])
        devices = subprocess.run(['systemctl', 'show', f'{name}.service', '--property=DeviceAllow'],
                                 check=True, capture_output=True, text=True).stdout.splitlines()
        self.assertIn('DeviceAllow=char-tpm rw', devices)
        for target in ('/run/domino-monitor-config', '/etc/domino/continuous-reads/monitor.hosts:/etc/hosts'):
            self.assertIn(target.split(':')[0], shown['BindReadOnlyPaths'])
        self.assertEqual(shown['StateDirectory'], 'domino-monitor')
        self.assertEqual((shown['PartOf'], shown['BindsTo']), ('', ''))

    def plan_reload(self):
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

    def plan_show(self, name, *properties):
        raw = subprocess.run(['systemctl', 'show', '--all', f'{name}.service', '--property=' + ','.join(properties)],
                             check=True, capture_output=True, text=True).stdout
        return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

    def test_the_automation_target_is_wanted_at_boot_and_wants_its_three_units(self):
        target = RUNTIME_UNITS / boot.TARGET
        wants = RUNTIME_UNITS / 'multi-user.target.wants'
        self.assertFalse(os.path.lexists(target), target)
        self.written.append(target)
        target.write_text(boot.target_text())
        if not wants.exists():
            self.written.append(wants)
            wants.mkdir()
        link = wants / boot.TARGET
        self.written.append(link)
        link.symlink_to(target)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)

        def show(unit, *properties):
            raw = subprocess.run(['systemctl', 'show', '--all', unit, '--property=' + ','.join(properties)],
                                 check=True, capture_output=True, text=True).stdout
            return {key: value.split() for key, value in (line.split('=', 1) for line in raw.splitlines() if '=' in line)}
        shown = show(boot.TARGET, 'LoadState', 'Wants', 'After', 'WantedBy')
        self.assertEqual(shown['LoadState'], ['loaded'])
        for member in boot.MEMBERS:
            self.assertIn(member, shown['Wants'])
            self.assertIn(member, shown['After'])
        self.assertIn('multi-user.target', shown['WantedBy'])
        self.assertIn(boot.TARGET, show('multi-user.target', 'Wants')['Wants'])


if __name__ == '__main__':
    unittest.main()
