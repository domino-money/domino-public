#!/usr/bin/env python3
"""Root-only host controller for one of two disposable Clawber CI VM slots.

Feed GitHub's encoded_jit_config on stdin, never a PAT or command argument.
The pinned base already contains the runner/toolchain. The admitting broker must
authorize the exact workflow/job and create a one-use JIT runner before launch.
This controller reports VM lifecycle only; GitHub reports the job conclusion.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass

ROOT = Path('/mnt/narrative-ssd/domino-ci-pilot')
MAX_SECONDS = 5400
DEFAULT_SECONDS = 900
MAX_JIT_BYTES = 1_048_576
PREFIX = 'domino-ci-pilot-'
NETWORK = 'domino-ci-pilot'
MAC = '52:54:00:dc:1a:02'
GUEST_IP = '172.30.78.2'
GATEWAY = '172.30.78.1'
GUEST_PREFIX = 29
SLOTS = {1: (GUEST_IP, MAC), 2: ('172.30.78.3', '52:54:00:dc:1a:03')}
SYSTEMD_SUDOERS = '/etc/sudoers.d/91-domino-ci-systemd'
URI = 'qemu:///system'


class PilotError(Exception):
    """Only fixed, non-secret error codes may leave the controller."""


class Interrupted(PilotError):
    def __init__(self, signum):
        self.signum = signum
        super().__init__('interrupted')


@dataclass(frozen=True)
class Config:
    base_image: Path
    base_sha256: str
    root: Path = ROOT
    network: str = NETWORK
    nwfilter: str = NETWORK
    runner_dir: str = '/opt/actions-runner'
    timeout_seconds: int = DEFAULT_SECONDS
    slot: int = 1
    guest_profile: str = 'normal'


def slot_prefix(config):
    return PREFIX + f'slot{config.slot}-'


def slot_directory(config):
    return config.root / 'jobs' / f'slot-{config.slot}'


def owned_domain(name, config):
    if not re.fullmatch(re.escape(slot_prefix(config)) + r'[0-9a-f]{32}', name):
        raise PilotError('domain_outside_owned_slot')


def read_jit(stream):
    raw = stream.read(MAX_JIT_BYTES + 1)
    if len(raw) > MAX_JIT_BYTES:
        raise PilotError('jit_config_too_large')
    try:
        encoded = raw.decode('ascii').strip()
        payload = json.loads(base64.b64decode(encoded, validate=True))
        if not isinstance(payload, dict) or not payload or any(
            not isinstance(key, str) or not re.fullmatch(r'\.[A-Za-z0-9_-]{1,64}', key)
            or not isinstance(value, str) for key, value in payload.items()
        ):
            raise ValueError()
        runner = json.loads(base64.b64decode(payload['.runner'], validate=True))
        if not isinstance(runner, dict):
            raise ValueError()
        # generate-jitconfig serializes RunnerSettings with PascalCase keys
        # and string booleans (Ephemeral: True); older settings use bools.
        flags = [runner[key] for key in ('Ephemeral', 'ephemeral') if key in runner]
        if len(flags) != 1 or not (flags[0] is True or flags[0] in ('True', 'true')):
            raise PilotError('jit_runner_must_be_ephemeral')
        if not {'.runner', '.credentials'} <= payload.keys():
            raise ValueError()
    except PilotError:
        raise
    except (ValueError, KeyError, TypeError, UnicodeError, binascii.Error):
        raise PilotError('invalid_jit_config') from None
    return encoded


def domain_xml(name, job_dir, config):
    domain = ET.Element('domain', {'type': 'kvm'})
    ET.SubElement(domain, 'name').text = name
    ET.SubElement(domain, 'memory', {'unit': 'MiB'}).text = '16384'
    ET.SubElement(domain, 'currentMemory', {'unit': 'MiB'}).text = '16384'
    ET.SubElement(domain, 'vcpu', {'placement': 'static'}).text = '4'
    cpu_tune = ET.SubElement(domain, 'cputune')
    ET.SubElement(cpu_tune, 'global_period').text = '100000'
    ET.SubElement(cpu_tune, 'global_quota').text = '400000'
    block_tune = ET.SubElement(domain, 'blkiotune')
    ET.SubElement(block_tune, 'weight').text = '100'
    os_node = ET.SubElement(domain, 'os')
    ET.SubElement(os_node, 'type', {'arch': 'x86_64', 'machine': 'q35'}).text = 'hvm'
    ET.SubElement(os_node, 'boot', {'dev': 'hd'})
    ET.SubElement(domain, 'features').append(ET.Element('acpi'))
    ET.SubElement(domain, 'cpu', {'mode': 'host-passthrough', 'check': 'none'})
    ET.SubElement(domain, 'on_poweroff').text = 'destroy'
    ET.SubElement(domain, 'on_reboot').text = 'destroy'
    ET.SubElement(domain, 'on_crash').text = 'destroy'
    devices = ET.SubElement(domain, 'devices')
    disk = ET.SubElement(devices, 'disk', {'type': 'file', 'device': 'disk'})
    ET.SubElement(disk, 'driver', {'name': 'qemu', 'type': 'qcow2', 'cache': 'none'})
    ET.SubElement(disk, 'source', {'file': str(job_dir / 'disk.qcow2')})
    backing = ET.SubElement(disk, 'backingStore', {'type': 'file'})
    ET.SubElement(backing, 'format', {'type': 'qcow2'})
    base_source = ET.SubElement(backing, 'source', {'file': str(config.base_image)})
    # Keep the shared, pinned root-owned base immutable across VM lifecycles.
    # This per-source DAC override leaves overlay ownership and AppArmor intact.
    ET.SubElement(base_source, 'seclabel', {'model': 'dac', 'relabel': 'no'})
    ET.SubElement(backing, 'backingStore')
    ET.SubElement(disk, 'target', {'dev': 'vda', 'bus': 'virtio'})
    io_tune = ET.SubElement(disk, 'iotune')
    ET.SubElement(io_tune, 'total_bytes_sec').text = str(50 * 1024 * 1024)
    cd = ET.SubElement(devices, 'disk', {'type': 'file', 'device': 'cdrom'})
    ET.SubElement(cd, 'driver', {'name': 'qemu', 'type': 'raw'})
    ET.SubElement(cd, 'source', {'file': str(job_dir / 'seed.iso')})
    ET.SubElement(cd, 'target', {'dev': 'sda', 'bus': 'sata'})
    ET.SubElement(cd, 'readonly')
    nic = ET.SubElement(devices, 'interface', {'type': 'network'})
    guest_ip, mac = SLOTS[config.slot]
    ET.SubElement(nic, 'mac', {'address': mac})
    ET.SubElement(nic, 'source', {'network': config.network})
    ET.SubElement(nic, 'model', {'type': 'virtio'})
    filt = ET.SubElement(nic, 'filterref', {'filter': config.nwfilter})
    ET.SubElement(filt, 'parameter', {'name': 'IP', 'value': guest_ip})
    channel = ET.SubElement(devices, 'channel', {'type': 'unix'})
    ET.SubElement(channel, 'target', {'type': 'virtio', 'name': 'org.qemu.guest_agent.0'})
    serial = ET.SubElement(devices, 'serial', {'type': 'file'})
    ET.SubElement(serial, 'source', {'path': str(job_dir / 'serial.log')})
    ET.SubElement(serial, 'target', {'type': 'isa-serial', 'port': '0'})
    # No graphics, filesystem, hostdev, USB, GPU, host socket, or host directory.
    ET.SubElement(devices, 'memballoon', {'model': 'none'})
    return ET.tostring(domain, encoding='unicode') + '\n'


def network_config(config=None):
    guest_ip, mac = SLOTS[config.slot if config is not None else 1]
    return json.dumps({'version': 2, 'ethernets': {'ci0': {
        'match': {'macaddress': mac}, 'set-name': 'ci0',
        'dhcp4': False, 'dhcp6': False, 'accept-ra': False, 'link-local': [],
        'addresses': [guest_ip + f'/{GUEST_PREFIX}'],
        'routes': [{'to': 'default', 'via': GATEWAY}],
        'nameservers': {'addresses': [GATEWAY]},
    }}}, indent=2) + '\n'


def cloud_config(jit, config):
    # This root launcher starts a child as runner with no supplementary groups.
    # Runner consumes/removes ACTIONS_RUNNER_INPUT_* and masks jitconfig itself:
    # actions/runner src/Runner.Listener/CommandSettings.cs + Runner.Common/Constants.cs.
    launcher = '''#!/usr/bin/python3
import json, os, pwd, subprocess
from pathlib import Path
secret = Path('/run/runner/encoded-jit-config')
account = pwd.getpwnam('runner')
code = 1
try:
    jit = secret.read_text().strip()
    secret.unlink()
    env = {'HOME': account.pw_dir, 'USER': 'runner', 'LOGNAME': 'runner',
           'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'LANG': 'C.UTF-8', 'ACTIONS_RUNNER_INPUT_JITCONFIG': jit,
           'RUNNER_TOOL_CACHE': '/opt/hostedtoolcache'}
    completed = subprocess.run([RUNNER_DIR + '/run.sh'], cwd=RUNNER_DIR,
        env=env, user=account.pw_uid, group=account.pw_gid, extra_groups=(),
        umask=0o022, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
    code = completed.returncode
finally:
    secret.unlink(missing_ok=True)
    result = Path('/run/runner/result.json')
    fd = os.open(result, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'runner_exit_code': code}, stream)
    os.sync()
    subprocess.run(['/usr/sbin/poweroff'], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=False)
'''.replace('RUNNER_DIR', repr(config.runner_dir))
    service = '''[Unit]
Description=One-use Domino CI runner
After=network-online.target cloud-final.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/sbin/domino-runner-launch.py
StandardOutput=null
StandardError=null
TimeoutStartSec=infinity
UMask=0077
'''
    document = {
        'users': [{'name': 'runner', 'uid': 1001, 'lock_passwd': True,
                   'shell': '/bin/bash', 'sudo': False, 'groups': []}],
        'disable_root': True, 'ssh_pwauth': False,
        'bootcmd': [['mkdir', '-p', '/run/runner'], ['chmod', '0700', '/run/runner']],
        'write_files': [
            {'path': '/run/runner/encoded-jit-config', 'owner': 'runner:runner',
             'permissions': '0600', 'content': jit},
            {'path': '/usr/local/sbin/domino-runner-launch.py', 'owner': 'root:root',
             'permissions': '0700', 'content': launcher},
            {'path': '/etc/systemd/system/domino-ephemeral-runner.service',
             'owner': 'root:root', 'permissions': '0644', 'content': service},
        ],
        'runcmd': [
            # Independent guest deadline also covers a disconnected controller.
            ['shutdown', '-P', '+' + str((config.timeout_seconds + 59) // 60)],
            ['systemctl', 'disable', '--now', 'ssh.service', 'ssh.socket'],
            ['systemctl', 'start', 'qemu-guest-agent.service'],
            ['chown', '-R', 'runner:runner', config.runner_dir, '/opt/hostedtoolcache'],
            ['systemctl', 'daemon-reload'],
            ['systemctl', 'start', '--no-block', 'domino-ephemeral-runner.service'],
        ],
    }
    if config.guest_profile == 'systemd':
        # This file exists only in the disposable guest. It grants no host
        # account, mount, device, socket, or network access.
        document['write_files'].append({
            'path': SYSTEMD_SUDOERS, 'owner': 'root:root', 'permissions': '0440',
            'content': 'runner ALL=(ALL:ALL) NOPASSWD: ALL\n',
        })
    else:
        document['runcmd'].insert(1, ['rm', '-f', SYSTEMD_SUDOERS])
    return '#cloud-config\n' + json.dumps(document, indent=2) + '\n'


def secure_file(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)


def owned_path(path, parent=None, *, directory=False, owner=0):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise PilotError('unsafe_path')
    if parent is not None and not path.is_relative_to(parent):
        raise PilotError('path_outside_owned_root')
    try:
        info = path.stat()
    except OSError:
        raise PilotError('required_owned_path_missing') from None
    if info.st_uid != owner or info.st_mode & 0o022:
        raise PilotError('path_ownership_or_permissions')
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise PilotError('unexpected_path_type')
    return path


def validate_roots(config):
    if type(config.slot) is not int or config.slot not in SLOTS:
        raise PilotError('invalid_slot')
    if config.guest_profile not in ('normal', 'systemd'):
        raise PilotError('invalid_guest_profile')
    owned_path(config.root, directory=True)
    owned_path(config.root / 'jobs', config.root, directory=True)


def validate_config(config):
    if not 1 <= config.timeout_seconds <= MAX_SECONDS:
        raise PilotError('invalid_timeout')
    if not re.fullmatch(r'[0-9a-f]{64}', config.base_sha256):
        raise PilotError('invalid_base_sha256')
    for value in (config.network, config.nwfilter):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', value):
            raise PilotError('invalid_network_name')
    if not re.fullmatch(r'/opt/[A-Za-z0-9_/-]+', config.runner_dir) or '..' in config.runner_dir:
        raise PilotError('invalid_guest_runner_path')
    validate_roots(config)
    owned_path(config.root / 'base', config.root, directory=True)
    owned_path(config.base_image, config.root / 'base')
    digest = hashlib.sha256()
    with config.base_image.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != config.base_sha256:
        raise PilotError('base_checksum_mismatch')


class Commands:
    deadline = None

    def run(self, args, *, capture=False, check=True):
        timeout = 30
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise PilotError('vm_lifetime_exceeded')
            timeout = min(timeout, remaining)
        try:
            result = subprocess.run(args, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, text=True, timeout=timeout,
                                    env={**os.environ, 'LC_ALL': 'C'})
        except (OSError, subprocess.TimeoutExpired):
            raise PilotError('host_command_failed') from None
        if check and result.returncode:
            raise PilotError('host_command_failed')
        return result

    def virsh(self, *args, **kwargs):
        return self.run(['virsh', '--connect', URI, *args], **kwargs)


def acquire_locks(config):
    """Fence old one-VM controllers, then reserve this slot exclusively."""
    descriptors = []
    try:
        for filename, kind, error in (
            ('pilot.lock', fcntl.LOCK_SH, 'legacy_pilot_running'),
            (f'slot-{config.slot}.lock', fcntl.LOCK_EX, 'pilot_slot_already_running'),
        ):
            path = config.root / filename
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            owned_path(path, config.root)
            try:
                fcntl.flock(fd, kind | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PilotError(error) from None
        return descriptors
    except BaseException:
        for fd in descriptors:
            os.close(fd)
        raise


def validate_network(commands, config):
    """Do not boot slot 2 on the legacy /30 broadcast address."""
    try:
        network = ET.fromstring(commands.virsh('net-dumpxml', config.network, capture=True).stdout)
        addresses = [node for node in network.findall('ip') if node.get('address') == GATEWAY]
        if (network.findtext('name') != config.network or len(addresses) != 1
                or not (addresses[0].get('netmask') == '255.255.255.248'
                        or addresses[0].get('prefix') == str(GUEST_PREFIX))):
            raise PilotError('dedicated_network_requires_ipv4_29')
    except ET.ParseError:
        raise PilotError('invalid_dedicated_network_xml') from None


def cleanup(commands, name, job_dir, config):
    owned_domain(name, config)
    if job_dir is not None:
        if job_dir.parent != slot_directory(config):
            raise PilotError('job_directory_outside_owned_slot')
        owned_path(job_dir, slot_directory(config), directory=True)
        if not re.fullmatch(re.escape(name) + r'-[a-z0-9_]{6,32}', job_dir.name):
            raise PilotError('unsafe_cleanup_path')
    # Cleanup must still run when the workload deadline expired.
    commands.deadline = None
    failed = False
    for action in ('destroy', 'undefine'):
        try:
            commands.virsh(action, name, check=False)
        except PilotError:
            failed = True
    try:
        # An arbitrary nonzero dominfo exit can mean lost libvirt access. A
        # successful list is required before deleting disks from under a VM.
        listing = commands.virsh('list', '--all', '--name', capture=True).stdout
        exists = name in listing.splitlines()
    except PilotError:
        exists = True
    if exists:
        raise PilotError('cleanup_domain_still_present')
    if job_dir is not None:
        if not shutil.rmtree.avoids_symlink_attacks:
            raise PilotError('unsafe_cleanup_path')
        shutil.rmtree(job_dir)
    if failed:
        raise PilotError('cleanup_command_failed')


def cleanup_slot(config, commands=None):
    """Recover only metadata-proven artifacts of this exclusively locked slot."""
    commands = commands or Commands()
    commands.deadline = None
    directory = slot_directory(config)
    jobs = {}
    if directory.exists():
        owned_path(directory, config.root / 'jobs', directory=True)
        for path in directory.iterdir():
            if not path.name.startswith(slot_prefix(config)):
                continue
            owned_path(path, directory, directory=True)
            metadata = owned_path(path / 'controller.json', path)
            if metadata.stat().st_mode & 0o077:
                raise PilotError('unsafe_recovery_metadata_permissions')
            try:
                data = json.loads(metadata.read_text())
                name = data['domain']
                owned_domain(name, config)
                if (data.get('version') != 1 or data.get('slot') != config.slot
                        or data.get('job_directory') != str(path)
                        or data.get('created_by') != 'domino-ci-slot-controller'
                        or name in jobs
                        or not re.fullmatch(re.escape(name) + r'-[a-z0-9_]{6,32}', path.name)):
                    raise PilotError('invalid_recovery_metadata')
            except (ValueError, KeyError, TypeError):
                raise PilotError('invalid_recovery_metadata') from None
            jobs[name] = path
    listing = commands.virsh('list', '--all', '--name', capture=True).stdout.splitlines()
    if any(name.startswith(slot_prefix(config)) and name not in jobs for name in listing):
        raise PilotError('slot_domain_without_owned_metadata')
    for name, path in jobs.items():
        cleanup(commands, name, path, config)
    return {'slot': config.slot, 'lifecycle': 'slot_cleaned', 'cleaned_domains': sorted(jobs)}


def run_vm(config, jit, commands=None, *, clock=time.monotonic, sleep=time.sleep):
    commands = commands or Commands()
    deadline = clock() + config.timeout_seconds
    if isinstance(commands, Commands):
        commands.deadline = deadline
    name = slot_prefix(config) + uuid.uuid4().hex
    job_dir = None
    result = {'domain': name, 'slot': config.slot, 'guest_profile': config.guest_profile,
              'lifecycle': 'guest_stopped', 'job_outcome': 'check_github'}
    try:
        listing = commands.virsh('list', '--all', '--name', capture=True).stdout
        domains = [line for line in listing.splitlines() if line.startswith(PREFIX)]
        if any(line.startswith(slot_prefix(config)) for line in domains):
            raise PilotError('another_or_orphaned_slot_vm_exists')
        if any(not any(line.startswith(PREFIX + f'slot{slot}-') for slot in SLOTS) for line in domains):
            raise PilotError('legacy_or_unknown_pilot_vm_exists')
        if len(domains) >= len(SLOTS):
            raise PilotError('pilot_slot_inventory_conflict')
        validate_network(commands, config)
        account = pwd.getpwnam('libvirt-qemu')
        directory = slot_directory(config)
        directory.mkdir(mode=0o751, exist_ok=True)
        owned_path(directory, config.root / 'jobs', directory=True)
        # The controller's 0077 umask masks mkdir's traversal bits. Restore
        # them only after proving this is a safe, root-owned slot directory.
        os.chmod(directory, 0o751)
        job_dir = Path(tempfile.mkdtemp(prefix=name + '-', dir=directory))
        # Root owns directory entries; QEMU can traverse, but not replace files.
        os.chown(job_dir, 0, account.pw_gid)
        os.chmod(job_dir, 0o710)
        secure_file(job_dir / 'controller.json', json.dumps({
            'version': 1, 'created_by': 'domino-ci-slot-controller', 'slot': config.slot,
            'domain': name, 'job_directory': str(job_dir),
        }) + '\n')
        secure_file(job_dir / 'user-data', cloud_config(jit, config))
        secure_file(job_dir / 'meta-data', json.dumps({'instance-id': name, 'local-hostname': 'domino-ci'}) + '\n')
        secure_file(job_dir / 'network-config', network_config(config))
        secure_file(job_dir / 'domain.xml', domain_xml(name, job_dir, config))
        commands.run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2',
                      '-b', str(config.base_image), str(job_dir / 'disk.qcow2'), '80G'])
        commands.run(['cloud-localds', '--network-config', str(job_dir / 'network-config'),
                      str(job_dir / 'seed.iso'), str(job_dir / 'user-data'), str(job_dir / 'meta-data')])
        secure_file(job_dir / 'serial.log', '')
        for filename in ('disk.qcow2', 'seed.iso', 'serial.log'):
            os.chown(job_dir / filename, account.pw_uid, account.pw_gid)
            os.chmod(job_dir / filename, 0o600)
        commands.virsh('define', str(job_dir / 'domain.xml'), '--validate')
        commands.virsh('start', name)
        while clock() < deadline:
            state = commands.virsh('domstate', name, capture=True).stdout.strip().lower()
            if state in ('shut off', 'crashed'):
                if state == 'crashed':
                    raise PilotError('guest_crashed')
                return result
            sleep(min(2, max(0, deadline - clock())))
        raise PilotError('vm_lifetime_exceeded')
    finally:
        cleanup(commands, name, job_dir, config)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-image', type=Path, default=ROOT / 'base/ubuntu-24.04-ci.qcow2')
    parser.add_argument('--base-sha256', default='', help='Required to launch: pinned prepared image SHA-256')
    parser.add_argument('--network', default=NETWORK)
    parser.add_argument('--nwfilter', default=NETWORK)
    parser.add_argument('--runner-dir', default='/opt/actions-runner')
    parser.add_argument('--timeout-seconds', type=int, default=DEFAULT_SECONDS)
    parser.add_argument('--slot', type=int, choices=sorted(SLOTS), default=1)
    parser.add_argument('--guest-profile', choices=('normal', 'systemd'), default='normal')
    parser.add_argument('--cleanup-slot', action='store_true', help='Recover only this locked slot; no JIT input')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print(json.dumps({'error': 'host_root_required'}), file=sys.stderr)
        return 1
    os.umask(0o077)
    values = vars(args).copy()
    recover = values.pop('cleanup_slot')
    config = Config(**values)
    lock_fds = []
    old_handlers = {}
    try:
        validate_roots(config) if recover else validate_config(config)
        lock_fds = acquire_locks(config)
        def interrupted(signum, _frame):
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(sig, signal.SIG_IGN)
            raise Interrupted(signum)
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            old_handlers[sig] = signal.signal(sig, interrupted)
        if recover:
            print(json.dumps(cleanup_slot(config)))
        else:
            jit = read_jit(sys.stdin.buffer)
            print(json.dumps(run_vm(config, jit)))
        return 0
    except Interrupted as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 128 + error.signum
    except (PilotError, OSError, KeyError):
        # Never print exception/subprocess bodies: they can contain guest data.
        error = sys.exc_info()[1]
        code = str(error) if isinstance(error, PilotError) else 'host_controller_failed'
        print(json.dumps({'error': code}), file=sys.stderr)
        return 1
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        for fd in lock_fds:
            os.close(fd)


if __name__ == '__main__':
    raise SystemExit(main())
