"""Offline controller/security tests; no libvirt, VM, network, or host mutation."""
import base64
from dataclasses import replace
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location('clawber_pilot', Path(__file__).with_name('clawber_pilot.py'))
pilot = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pilot
SPEC.loader.exec_module(pilot)


def jit(ephemeral=True, extra=None):
    document = {'.runner': base64.b64encode(json.dumps({'ephemeral': ephemeral}).encode()).decode(),
                '.credentials': base64.b64encode(b'synthetic-test-credential').decode()}
    document.update(extra or {})
    return base64.b64encode(json.dumps(document).encode()).decode()


class FakeCommands:
    def __init__(self, state='shut off', fail=None):
        self.calls = []
        self.state = state
        self.fail = fail
        self.name = None
        self.defined = False

    def run(self, args, **_kwargs):
        self.calls.append(args)
        if args[0] == 'qemu-img':
            Path(args[-2]).touch(mode=0o600)
        elif args[0] == 'cloud-localds':
            Path(args[-3]).touch(mode=0o600)
        return SimpleNamespace(returncode=0, stdout='')

    def virsh(self, *args, **_kwargs):
        self.calls.append(['virsh', *args])
        if args[0] == self.fail:
            raise pilot.PilotError('host_command_failed')
        text = ''
        if args[0] == 'define':
            self.name = ET.parse(args[1]).findtext('name')
            self.defined = True
        elif args[0] == 'undefine':
            self.defined = False
        elif args[0] == 'list':
            text = self.name if self.defined else ''
        elif args[0] == 'domstate':
            text = self.state
        return SimpleNamespace(returncode=0, stdout=text)


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        (self.root / 'base').mkdir()
        (self.root / 'jobs').mkdir()
        self.base = self.root / 'base/image.qcow2'
        self.base.write_bytes(b'prepared-image-fixture')
        self.config = pilot.Config(self.base, hashlib.sha256(self.base.read_bytes()).hexdigest(), root=self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_ephemeral_jit_accepted(self):
        self.assertEqual(pilot.read_jit(io.BytesIO(jit().encode())), jit())
        with self.assertRaisesRegex(pilot.PilotError, 'must_be_ephemeral'):
            pilot.read_jit(io.BytesIO(jit(False).encode()))

    def test_malformed_or_path_bearing_jit_rejected_without_echo(self):
        for value in ('credential-that-must-not-echo', jit(extra={'../../host': 'bad'}),
                      base64.b64encode(b'{}').decode()):
            with self.assertRaises(pilot.PilotError) as error:
                pilot.read_jit(io.BytesIO(value.encode()))
            self.assertNotIn(value, str(error.exception))

    def test_oversized_jit_rejected(self):
        with self.assertRaisesRegex(pilot.PilotError, 'too_large'):
            pilot.read_jit(io.BytesIO(b'A' * (pilot.MAX_JIT_BYTES + 1)))

    def test_xml_resources_and_no_host_passthrough(self):
        text = pilot.domain_xml('test-vm', self.root / 'jobs/test-vm', self.config)
        tree = ET.fromstring(text)
        self.assertEqual(tree.findtext('vcpu'), '4')
        self.assertEqual(tree.findtext('memory'), '16384')
        self.assertEqual(tree.findtext('cputune/global_quota'), '400000')
        self.assertEqual(tree.findtext('devices/disk/iotune/total_bytes_sec'), str(50 * 1024 * 1024))
        self.assertEqual(tree.find('devices/interface/filterref/parameter').attrib,
                         {'name': 'IP', 'value': pilot.GUEST_IP})
        for tag in ('hostdev', 'filesystem', 'graphics', 'redirdev'):
            self.assertEqual(tree.findall('.//' + tag), [])
        self.assertNotIn(jit(), text)

    def test_static_network_disables_ipv6(self):
        iface = json.loads(pilot.network_config())['ethernets']['ci0']
        self.assertEqual(iface['match']['macaddress'], pilot.MAC)
        self.assertEqual(iface['addresses'], [pilot.GUEST_IP + '/30'])
        self.assertFalse(iface['dhcp6'])
        self.assertFalse(iface['accept-ra'])

    def test_only_shared_base_disables_dac_relabel(self):
        tree = ET.fromstring(pilot.domain_xml('test-vm', self.root / 'jobs/test-vm', self.config))
        disk = tree.find('devices/disk')
        backing = disk.find('backingStore')
        self.assertEqual(backing.attrib, {'type': 'file'})
        self.assertEqual(backing.find('format').attrib, {'type': 'qcow2'})
        self.assertEqual(backing.find('source').attrib, {'file': str(self.base)})
        label = backing.find('source/seclabel')
        self.assertEqual(label.attrib, {'model': 'dac', 'relabel': 'no'})
        self.assertEqual(len(tree.findall('.//seclabel')), 1)
        self.assertIsNotNone(backing.find('backingStore'))
        self.assertIsNone(disk.find('source/seclabel'))
        self.assertIsNone(tree.find('seclabel'))

    def test_cloud_init_no_install_or_secret_argv(self):
        secret = jit()
        config = json.loads(pilot.cloud_config(secret, self.config).split('\n', 1)[1])
        self.assertNotIn('packages', config)
        self.assertFalse(config['users'][0]['sudo'])
        files = {item['path']: item for item in config['write_files']}
        self.assertEqual(files['/run/runner/encoded-jit-config']['permissions'], '0600')
        launcher = files['/usr/local/sbin/domino-runner-launch.py']['content']
        self.assertIn('ACTIONS_RUNNER_INPUT_JITCONFIG', launcher)
        self.assertNotIn('--jitconfig', launcher)
        self.assertNotIn(secret, launcher)
        self.assertIn('user=account.pw_uid', launcher)
        self.assertIn('extra_groups=()', launcher)
        self.assertIn("'/usr/sbin/poweroff'", launcher)
        self.assertEqual(config['runcmd'][0], ['shutdown', '-P', '+15'])
        compile(launcher, 'guest-launcher', 'exec')

    def test_private_file_mode_and_no_overwrite(self):
        path = self.root / 'secret-fixture'
        pilot.secure_file(path, 'fixture')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            pilot.secure_file(path, 'other')

    def test_path_escape_and_symlink_rejected(self):
        with self.assertRaisesRegex(pilot.PilotError, 'outside_owned_root'):
            pilot.owned_path(self.base, self.root / 'jobs', owner=os.getuid())
        link = self.root / 'base/link'
        link.symlink_to(self.base)
        with self.assertRaisesRegex(pilot.PilotError, 'unsafe_path'):
            pilot.owned_path(link, owner=os.getuid())
        self.base.chmod(0o666)
        with self.assertRaisesRegex(pilot.PilotError, 'ownership_or_permissions'):
            pilot.owned_path(self.base, owner=os.getuid())

    def execute_fake(self, commands, **kwargs):
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        real_owned = pilot.owned_path
        def checked(path, parent=None, **kw):
            return real_owned(path, parent, owner=os.getuid(), **kw)
        with patch.object(pilot.pwd, 'getpwnam', return_value=account), \
             patch.object(pilot.os, 'chown'), patch.object(pilot, 'owned_path', side_effect=checked):
            return pilot.run_vm(self.config, jit(), commands, **kwargs)

    def test_lifecycle_secret_never_in_command_arguments_and_cleans(self):
        commands = FakeCommands()
        result = self.execute_fake(commands)
        self.assertEqual(result['job_outcome'], 'check_github')
        self.assertEqual(list((self.root / 'jobs').iterdir()), [])
        self.assertIn('destroy', [c[1] for c in commands.calls if c[0] == 'virsh'])
        self.assertNotIn(jit(), json.dumps(commands.calls))

    def test_start_failure_still_destroys_and_cleans(self):
        commands = FakeCommands(fail='start')
        with self.assertRaisesRegex(pilot.PilotError, 'host_command_failed'):
            self.execute_fake(commands)
        self.assertEqual(list((self.root / 'jobs').iterdir()), [])
        self.assertIn(['virsh', 'destroy', commands.name], commands.calls)

    def test_timeout_cleans(self):
        commands = FakeCommands(state='running')
        ticks = iter([0, self.config.timeout_seconds + 1])
        with self.assertRaisesRegex(pilot.PilotError, 'lifetime_exceeded'):
            self.execute_fake(commands, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertEqual(list((self.root / 'jobs').iterdir()), [])

    def test_interruption_cleans(self):
        commands = FakeCommands(state='running')
        def interrupted(_):
            raise pilot.Interrupted(15)
        with self.assertRaises(pilot.Interrupted):
            self.execute_fake(commands, sleep=interrupted)
        self.assertEqual(list((self.root / 'jobs').iterdir()), [])

    def test_cannot_delete_disks_without_proving_domain_absent(self):
        commands = FakeCommands(fail='undefine')
        with self.assertRaisesRegex(pilot.PilotError, 'cleanup_domain_still_present'):
            self.execute_fake(commands)
        self.assertEqual(len(list((self.root / 'jobs').iterdir())), 1)

    def test_max_timeout_is_bounded(self):
        with self.assertRaisesRegex(pilot.PilotError, 'invalid_timeout'):
            pilot.validate_config(replace(self.config, timeout_seconds=5401))


if __name__ == '__main__':
    unittest.main()
