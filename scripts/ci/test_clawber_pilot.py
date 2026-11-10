"""Offline controller/security tests; no libvirt, VM, network, or host mutation."""
import ast
import base64
from contextlib import contextmanager
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

import clawber_resources as resources

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
    def __init__(self, state='shut off', fail=None, existing=(), netmask='255.255.255.240'):
        self.calls = []
        self.state = state
        self.fail = fail
        self.name = None
        self.defined = False
        self.existing = set(existing)
        self.netmask = netmask

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
            if args[1] == self.name:
                self.defined = False
            self.existing.discard(args[1])
        elif args[0] == 'list':
            text = '\n'.join(sorted(self.existing | ({self.name} if self.defined else set())))
        elif args[0] == 'net-dumpxml':
            text = f'<network><name>{pilot.NETWORK}</name><ip address="{pilot.GATEWAY}" netmask="{self.netmask}"/></network>'
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
        self.slot_dir = self.root / 'jobs/slot-1'

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_storage_requires_the_dedicated_mount_before_path_or_lock_access(self):
        self.assertEqual(pilot.ROOT, Path('/mnt/domino-ci/domino-ci-pilot'))
        config = replace(self.config, root=pilot.ROOT)
        with patch.object(Path, 'is_mount', return_value=False) as mounted, \
             patch.object(pilot, 'owned_path') as owned:
            with self.assertRaisesRegex(pilot.PilotError, 'required_storage_mount_missing'):
                pilot.validate_roots(config)
            mounted.assert_called_once_with()
            owned.assert_not_called()
        with patch.object(Path, 'is_mount', return_value=True), \
             patch.object(pilot, 'owned_path') as owned:
            pilot.validate_roots(config)
            self.assertEqual(owned.call_args_list[0].args, (pilot.ROOT,))
            self.assertEqual(owned.call_args_list[1].args, (pilot.ROOT / 'jobs', pilot.ROOT))

    def test_service_and_image_builder_require_the_same_dedicated_storage(self):
        source = Path(__file__).parent
        unit = (source / 'domino-clawber-broker.service').read_text()
        builder = (source / 'prepare-image.sh').read_text()
        self.assertIn(f'RequiresMountsFor={pilot.ROOT}\n', unit)
        self.assertIn(f'ConditionPathIsMountPoint={pilot.ROOT.parent}\n', unit)
        self.assertIn(f'base_dir={pilot.ROOT}/base\n', builder)
        self.assertLess(builder.index(f'mountpoint -q {pilot.ROOT.parent}\n'),
                        builder.index('install -d '))

    def test_only_ephemeral_jit_accepted(self):
        self.assertEqual(pilot.read_jit(io.BytesIO(jit().encode())), jit())
        with self.assertRaisesRegex(pilot.PilotError, 'must_be_ephemeral'):
            pilot.read_jit(io.BytesIO(jit(False).encode()))

    def test_real_github_pascal_case_string_boolean_and_false_values(self):
        # Sanitized shape observed from generate-jitconfig; no real credential.
        for value in ('True', True, 'False', False, 1, None):
            encoded = json.loads(base64.b64decode(jit()))
            encoded['.runner'] = base64.b64encode(json.dumps({'Ephemeral': value}).encode()).decode()
            payload = base64.b64encode(json.dumps(encoded).encode()).decode()
            if value is True or value == 'True':
                self.assertEqual(pilot.read_jit(io.BytesIO(payload.encode())), payload)
            else:
                with self.assertRaisesRegex(pilot.PilotError, 'must_be_ephemeral'):
                    pilot.read_jit(io.BytesIO(payload.encode()))

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

    def test_fixed_resource_profiles_set_memory_vcpus_and_whole_domain_quota(self):
        expected = {
            'legacy': {'vcpus': 4, 'memory_mib': 16384},
            'light': {'vcpus': 1, 'memory_mib': 3072},
            'standard': {'vcpus': 2, 'memory_mib': 6144},
            'browser': {'vcpus': 2, 'memory_mib': 8192},
            'heavy': {'vcpus': 3, 'memory_mib': 12288},
        }
        self.assertEqual(resources.RESOURCE_PROFILES, expected)
        self.assertEqual((resources.MAX_SLOTS, resources.BUDGET_VCPUS,
                          resources.BUDGET_MEMORY_MIB, resources.MAX_HEAVY), (8, 14, 57344, 2))
        for profile, size in expected.items():
            with self.subTest(profile=profile):
                tree = ET.fromstring(pilot.domain_xml('test', self.slot_dir,
                    replace(self.config, resource_profile=profile)))
                self.assertEqual(int(tree.findtext('memory')), size['memory_mib'])
                self.assertEqual(tree.find('memory').get('unit'), 'MiB')
                self.assertEqual(tree.findtext('currentMemory'), tree.findtext('memory'))
                self.assertEqual(int(tree.findtext('vcpu')), size['vcpus'])
                self.assertEqual(int(tree.findtext('cputune/global_period')), 100000)
                self.assertEqual(int(tree.findtext('cputune/global_quota')), size['vcpus'] * 100000)

    def test_static_network_disables_ipv6(self):
        iface = json.loads(pilot.network_config())['ethernets']['ci0']
        self.assertEqual(iface['match']['macaddress'], pilot.MAC)
        self.assertEqual(iface['addresses'], [pilot.GUEST_IP + '/28'])
        self.assertFalse(iface['dhcp6'])
        self.assertFalse(iface['accept-ra'])

    def test_slot_networks_have_distinct_mac_ip_and_filter_parameters(self):
        ips, macs = [], []
        self.assertEqual(set(pilot.SLOTS), set(range(1, 9)))
        for slot in range(1, 9):
            with self.subTest(slot=slot):
                config = replace(self.config, slot=slot)
                tree = ET.fromstring(pilot.domain_xml('test', pilot.slot_directory(config), config))
                mac = tree.find('devices/interface/mac').get('address')
                ip = tree.find('devices/interface/filterref/parameter').get('value')
                ips.append(ip); macs.append(mac)
                self.assertEqual(tree.find('devices/interface/filterref').get('filter'), pilot.NETWORK)
                iface = json.loads(pilot.network_config(config))['ethernets']['ci0']
                self.assertEqual(iface['addresses'], [ip + '/28'])
                self.assertEqual(iface['match']['macaddress'], mac)
                self.assertEqual(iface['nameservers']['addresses'], [pilot.GATEWAY])
                self.assertFalse(iface['dhcp4'])
                self.assertFalse(iface['dhcp6'])
                self.assertFalse(iface['accept-ra'])
        self.assertEqual(ips, ['172.30.78.' + str(last) for last in range(2, 10)])
        self.assertEqual(macs, ['52:54:00:dc:1a:0' + str(last) for last in range(2, 10)])
        network = ET.parse(Path(__file__).with_name('libvirt') / 'network.xml')
        self.assertEqual(network.find('ip').attrib,
                         {'address': pilot.GATEWAY, 'netmask': '255.255.255.240'})

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

    def test_runner_child_has_hosted_umask_while_credentials_stay_private(self):
        for profile in ('normal', 'systemd'):
            with self.subTest(profile=profile):
                config = json.loads(pilot.cloud_config(jit(), replace(
                    self.config, guest_profile=profile)).split('\n', 1)[1])
                files = {item['path']: item for item in config['write_files']}
                secret = files['/run/runner/encoded-jit-config']
                self.assertEqual((secret['owner'], secret['permissions']), ('runner:runner', '0600'))
                self.assertIn(['chmod', '0700', '/run/runner'], config['bootcmd'])
                launcher = files['/usr/local/sbin/domino-runner-launch.py']
                self.assertEqual((launcher['owner'], launcher['permissions']), ('root:root', '0700'))
                self.assertIn('UMask=0077', files[
                    '/etc/systemd/system/domino-ephemeral-runner.service']['content'])
                calls = [node for node in ast.walk(ast.parse(launcher['content']))
                         if isinstance(node, ast.Call)
                         and isinstance(node.func, ast.Attribute)
                         and isinstance(node.func.value, ast.Name)
                         and node.func.value.id == 'subprocess' and node.func.attr == 'run'
                         and any(arg.arg == 'user' for arg in node.keywords)]
                self.assertEqual(len(calls), 1)
                arguments = {arg.arg: arg.value for arg in calls[0].keywords}
                self.assertEqual(ast.literal_eval(arguments['umask']), 0o022)

    def test_systemd_sudo_is_guest_only_and_normal_profile_removes_it(self):
        normal = json.loads(pilot.cloud_config(jit(), self.config).split('\n', 1)[1])
        systemd = json.loads(pilot.cloud_config(jit(), replace(self.config, guest_profile='systemd')).split('\n', 1)[1])
        files = {item['path']: item for item in systemd['write_files']}
        sudoers = files[pilot.SYSTEMD_SUDOERS]
        self.assertEqual(sudoers['owner'], 'root:root')
        self.assertEqual(sudoers['permissions'], '0440')
        self.assertEqual(sudoers['content'], 'runner ALL=(ALL:ALL) NOPASSWD: ALL\n')
        self.assertIn(['rm', '-f', pilot.SYSTEMD_SUDOERS], normal['runcmd'])
        self.assertNotIn(pilot.SYSTEMD_SUDOERS, {item['path'] for item in normal['write_files']})
        xml = ET.fromstring(pilot.domain_xml('test', self.slot_dir, replace(self.config, guest_profile='systemd')))
        self.assertEqual(xml.findall('.//filesystem') + xml.findall('.//hostdev'), [])

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

    @contextmanager
    def local_ownership(self):
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        real_owned = pilot.owned_path
        def checked(path, parent=None, **kw):
            return real_owned(path, parent, owner=os.getuid(), **kw)
        with patch.object(pilot.pwd, 'getpwnam', return_value=account), \
             patch.object(pilot.os, 'chown'), patch.object(pilot, 'owned_path', side_effect=checked):
            yield

    def execute_fake(self, commands, config=None, **kwargs):
        with self.local_ownership():
            return pilot.run_vm(config or self.config, jit(), commands, **kwargs)

    def test_lifecycle_secret_never_in_command_arguments_and_cleans(self):
        commands = FakeCommands()
        result = self.execute_fake(commands)
        self.assertEqual(result['job_outcome'], 'check_github')
        self.assertEqual(list(self.slot_dir.iterdir()), [])
        self.assertIn('destroy', [c[1] for c in commands.calls if c[0] == 'virsh'])
        self.assertNotIn(jit(), json.dumps(commands.calls))

    def test_restrictive_umask_preserves_qemu_traversal_before_start(self):
        # Model the root-owned host ancestors. QEMU has another UID/GID and
        # needs other-execute here, then group-execute on its own job directory.
        self.root.chmod(0o751)
        (self.root / 'jobs').chmod(0o751)
        case = self
        class TraversalCheckingCommands(FakeCommands):
            def virsh(self, *args, **kwargs):
                if args[0] == 'define':
                    job = Path(args[1]).parent
                    for ancestor in (job.parent, job.parent.parent, case.root):
                        case.assertTrue(ancestor.stat().st_mode & 0o001,
                                        'QEMU cannot traverse ' + ancestor.name)
                        case.assertEqual(ancestor.stat().st_mode & 0o022, 0)
                    case.assertEqual(job.parent.stat().st_mode & 0o777, 0o751)
                    case.assertEqual(job.stat().st_mode & 0o777, 0o710)
                    for filename in ('disk.qcow2', 'seed.iso', 'controller.json', 'user-data'):
                        case.assertEqual((job / filename).stat().st_mode & 0o777, 0o600)
                return super().virsh(*args, **kwargs)
        previous_umask = os.umask(0o077)
        try:
            for slot in (1, 2):
                config = replace(self.config, slot=slot)
                for existing in (False, True):
                    with self.subTest(slot=slot, existing=existing):
                        directory = pilot.slot_directory(config)
                        if existing:
                            directory.chmod(0o700)  # Repair a prior failed startup.
                        self.execute_fake(TraversalCheckingCommands(), config)
                        self.assertEqual(list(directory.iterdir()), [])
        finally:
            os.umask(previous_umask)

    def test_start_failure_still_destroys_and_cleans(self):
        commands = FakeCommands(fail='start')
        with self.assertRaisesRegex(pilot.PilotError, 'host_command_failed'):
            self.execute_fake(commands)
        self.assertEqual(list(self.slot_dir.iterdir()), [])
        self.assertIn(['virsh', 'destroy', commands.name], commands.calls)

    def test_timeout_cleans(self):
        commands = FakeCommands(state='running')
        ticks = iter([0, self.config.timeout_seconds + 1])
        with self.assertRaisesRegex(pilot.PilotError, 'lifetime_exceeded'):
            self.execute_fake(commands, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertEqual(list(self.slot_dir.iterdir()), [])

    def test_interruption_cleans(self):
        commands = FakeCommands(state='running')
        def interrupted(_):
            raise pilot.Interrupted(15)
        with self.assertRaises(pilot.Interrupted):
            self.execute_fake(commands, sleep=interrupted)
        self.assertEqual(list(self.slot_dir.iterdir()), [])

    def test_cannot_delete_disks_without_proving_domain_absent(self):
        commands = FakeCommands(fail='undefine')
        with self.assertRaisesRegex(pilot.PilotError, 'cleanup_domain_still_present'):
            self.execute_fake(commands)
        self.assertEqual(len(list(self.slot_dir.iterdir())), 1)

    def test_one_slot_does_not_block_or_clean_the_other_slot(self):
        other = pilot.PREFIX + 'slot2-' + 'b' * 32
        commands = FakeCommands(existing=[other, 'unrelated-domain'])
        result = self.execute_fake(commands)
        self.assertEqual(result['slot'], 1)
        self.assertEqual(commands.existing, {other, 'unrelated-domain'})
        touched = [call[2] for call in commands.calls if call[:2] in (['virsh', 'destroy'], ['virsh', 'undefine'])]
        self.assertNotIn(other, touched)
        self.assertNotIn('unrelated-domain', touched)

    def test_eighth_slot_launch_preserves_seven_existing_guests_and_records_resources(self):
        others = {pilot.PREFIX + f'slot{slot}-' + 'b' * 32 for slot in range(1, 8)}
        config = replace(self.config, slot=8, resource_profile='light')
        case = self
        class ReceiptCheckingCommands(FakeCommands):
            def virsh(self, *args, **kwargs):
                if args[0] == 'define':
                    job = Path(args[1]).parent
                    metadata = json.loads((job / 'controller.json').read_text())
                    case.assertEqual(metadata['resource_profile'], 'light')
                    case.assertEqual(metadata['slot'], 8)
                    case.assertEqual(ET.parse(args[1]).findtext('memory'), '3072')
                return super().virsh(*args, **kwargs)
        commands = ReceiptCheckingCommands(existing=others)
        report = self.execute_fake(commands, config)
        self.assertEqual((report['slot'], report['resource_profile']), (8, 'light'))
        self.assertEqual(commands.existing, others)
        self.assertEqual(list(pilot.slot_directory(config).iterdir()), [])

    def test_same_slot_or_legacy_orphan_blocks_admission(self):
        for existing in (pilot.PREFIX + 'slot1-' + 'b' * 32, pilot.PREFIX + 'c' * 32):
            with self.subTest(existing=existing):
                commands = FakeCommands(existing=[existing])
                with self.assertRaisesRegex(pilot.PilotError, 'slot_vm_exists|legacy_or_unknown'):
                    self.execute_fake(commands)
                self.assertIn(existing, commands.existing)
                self.assertFalse(any(call[:2] == ['virsh', 'define'] for call in commands.calls))

    def test_legacy_network_is_rejected_before_creating_vm(self):
        for netmask in ('255.255.255.252', '255.255.255.248'):
            with self.subTest(netmask=netmask):
                commands = FakeCommands(netmask=netmask)
                with self.assertRaisesRegex(pilot.PilotError, 'requires_ipv4_28'):
                    self.execute_fake(commands)
                self.assertFalse(any(call[:2] == ['virsh', 'define'] for call in commands.calls))

    def test_locks_allow_eight_slots_but_not_two_controllers_in_same_slot(self):
        descriptors = []
        with self.local_ownership():
            try:
                for slot in range(1, 9):
                    descriptors.extend(pilot.acquire_locks(replace(self.config, slot=slot)))
                for slot in range(1, 9):
                    with self.assertRaisesRegex(pilot.PilotError, 'slot_already_running'):
                        pilot.acquire_locks(replace(self.config, slot=slot))
                legacy = os.open(self.root / 'pilot.lock', os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        pilot.fcntl.flock(legacy, pilot.fcntl.LOCK_EX | pilot.fcntl.LOCK_NB)
                finally:
                    os.close(legacy)
            finally:
                for fd in descriptors:
                    os.close(fd)

    def test_legacy_exclusive_lock_fences_all_eight_slots(self):
        legacy = os.open(self.root / 'pilot.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            pilot.fcntl.flock(legacy, pilot.fcntl.LOCK_EX | pilot.fcntl.LOCK_NB)
            with self.local_ownership():
                for slot in range(1, 9):
                    with self.assertRaisesRegex(pilot.PilotError, 'legacy_pilot_running'):
                        pilot.acquire_locks(replace(self.config, slot=slot))
        finally:
            os.close(legacy)

    def orphan(self, slot=1):
        config = replace(self.config, slot=slot)
        name = pilot.slot_prefix(config) + 'a' * 32
        parent = pilot.slot_directory(config)
        parent.mkdir(exist_ok=True)
        job = parent / (name + '-fixture0')
        job.mkdir()
        pilot.secure_file(job / 'controller.json', json.dumps({
            'version': 1, 'created_by': 'domino-ci-slot-controller', 'slot': slot,
            'domain': name, 'job_directory': str(job),
        }))
        return name, job

    def test_recovery_only_cleans_metadata_proven_slot_and_no_jit(self):
        name, job = self.orphan()
        other, other_dir = self.orphan(2)
        commands = FakeCommands(existing=[name, other, 'unrelated'])
        with self.local_ownership():
            report = pilot.cleanup_slot(self.config, commands)
        self.assertEqual(report['cleaned_domains'], [name])
        self.assertFalse(job.exists())
        self.assertTrue(other_dir.exists())
        self.assertEqual(commands.existing, {other, 'unrelated'})

    def test_slot_eight_recovers_old_metadata_without_resource_profile_and_leaves_slot_one(self):
        name, job = self.orphan(8)
        other, other_dir = self.orphan(1)
        self.assertNotIn('resource_profile', json.loads((job / 'controller.json').read_text()))
        commands = FakeCommands(existing=[name, other, 'unrelated'])
        with self.local_ownership():
            report = pilot.cleanup_slot(replace(self.config, slot=8, resource_profile='light'), commands)
        self.assertEqual(report['cleaned_domains'], [name])
        self.assertFalse(job.exists())
        self.assertTrue(other_dir.exists())
        self.assertEqual(commands.existing, {other, 'unrelated'})

    def test_recovery_rejects_domain_without_metadata_or_wrong_metadata(self):
        name = pilot.slot_prefix(self.config) + 'f' * 32
        with self.local_ownership():
            with self.assertRaisesRegex(pilot.PilotError, 'without_owned_metadata'):
                pilot.cleanup_slot(self.config, FakeCommands(existing=[name]))
        name, job = self.orphan()
        data = json.loads((job / 'controller.json').read_text())
        data['slot'] = 2
        (job / 'controller.json').write_text(json.dumps(data))
        commands = FakeCommands(existing=[name])
        with self.local_ownership():
            with self.assertRaisesRegex(pilot.PilotError, 'invalid_recovery_metadata'):
                pilot.cleanup_slot(self.config, commands)
        self.assertTrue(job.exists())
        self.assertFalse(any(call[:2] == ['virsh', 'destroy'] for call in commands.calls))

    def test_recovery_cli_never_reads_jit_and_cannot_interrupt_active_slot(self):
        output, errors = io.StringIO(), io.StringIO()
        report = {'slot': 1, 'lifecycle': 'slot_cleaned', 'cleaned_domains': []}
        previous_umask = os.umask(0o077)
        descriptors = []
        try:
            with self.local_ownership(), patch.object(pilot, 'Config', return_value=self.config), \
                 patch.object(pilot.os, 'geteuid', return_value=0), \
                 patch.object(pilot.sys, 'stdin', SimpleNamespace(buffer=object())), \
                 patch.object(pilot.sys, 'stdout', output), patch.object(pilot.sys, 'stderr', errors), \
                 patch.object(pilot, 'cleanup_slot', return_value=report) as recover:
                self.assertEqual(pilot.main(['--cleanup-slot', '--slot', '1']), 0)
                self.assertEqual(json.loads(output.getvalue()), report)
                recover.assert_called_once_with(self.config)
                recover.reset_mock()
                descriptors = pilot.acquire_locks(self.config)
                self.assertEqual(pilot.main(['--cleanup-slot', '--slot', '1']), 1)
                self.assertEqual(json.loads(errors.getvalue())['error'], 'pilot_slot_already_running')
                recover.assert_not_called()
        finally:
            for fd in descriptors:
                os.close(fd)
            os.umask(previous_umask)

    def test_recovery_rejects_readable_or_escaping_metadata_without_touching_vm(self):
        name, job = self.orphan()
        metadata = job / 'controller.json'
        commands = FakeCommands(existing=[name])
        metadata.chmod(0o644)
        with self.local_ownership():
            with self.assertRaisesRegex(pilot.PilotError, 'unsafe_recovery_metadata_permissions'):
                pilot.cleanup_slot(self.config, commands)
            metadata.chmod(0o600)
            data = json.loads(metadata.read_text())
            data['job_directory'] = str(self.root / 'jobs/slot-2' / job.name)
            metadata.write_text(json.dumps(data))
            with self.assertRaisesRegex(pilot.PilotError, 'invalid_recovery_metadata'):
                pilot.cleanup_slot(self.config, commands)
        self.assertTrue(job.exists())
        self.assertEqual(commands.calls, [])

    def test_cleanup_rejects_other_slot_domain_before_libvirt_command(self):
        commands = FakeCommands()
        with self.assertRaisesRegex(pilot.PilotError, 'domain_outside_owned_slot'):
            pilot.cleanup(commands, pilot.PREFIX + 'slot2-' + 'a' * 32, None, self.config)
        self.assertEqual(commands.calls, [])

    def test_max_timeout_is_bounded(self):
        with self.assertRaisesRegex(pilot.PilotError, 'invalid_timeout'):
            pilot.validate_config(replace(self.config, timeout_seconds=5401))

    def test_invalid_slot_and_profile_are_rejected(self):
        for slot in (0, 9, True):
            with self.assertRaisesRegex(pilot.PilotError, 'invalid_slot'):
                pilot.validate_roots(replace(self.config, slot=slot))
        with self.assertRaisesRegex(pilot.PilotError, 'invalid_guest_profile'):
            pilot.validate_roots(replace(self.config, guest_profile='host-root'))
        for profile in ('../../host', 'custom', '', None, []):
            with self.assertRaisesRegex(pilot.PilotError, 'invalid_resource_profile'):
                pilot.validate_roots(replace(self.config, resource_profile=profile))


if __name__ == '__main__':
    unittest.main()
