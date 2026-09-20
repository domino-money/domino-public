#!/usr/bin/env python3
"""Standing operator authorization with finite, transactional development leases.

Only the existing development lane is managed. No provider URL or credential is
printed. The application keeps its expiry checks, quotas and authentication.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

BASE = Path('/etc/domino/dev')
CONFIG = Path('/etc/domino/dev-maintenance/control.json')
STATE = Path('/var/lib/domino-dev-maintenance')
UNITS = ('domino-dev-read.service', 'domino-dev-gateway.service', 'domino-dev-tunnel.service')
ROLES = ('reader', 'gateway', 'tunnel')
POLICY, READER, ADMISSION = BASE/'off-policy.nft', BASE/'reader/profile.json', BASE/'gateway/admission.json'
MANAGED = (POLICY, READER, ADMISSION)
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'


class Refused(Exception):
    pass


def need(ok, code):
    if not ok:
        raise Refused(code)


def command(*args, timeout=45):
    result = subprocess.run(args, capture_output=True, timeout=timeout,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'})
    need(result.returncode == 0, 'command_failed_' + Path(args[0]).name)
    return result.stdout


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def atomic(path, data, uid=0, gid=0, mode=0o600):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private(path):
    info = Path(path).lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
         and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_private_file')
    return json.loads(Path(path).read_bytes())


def controls(value):
    need(set(value) == {'version', 'enabled', 'authorization', 'leaseSeconds', 'renewBeforeSeconds'}
         and value['version'] == 1 and type(value['enabled']) is bool
         and isinstance(value['authorization'], str) and 1 <= len(value['authorization']) <= 256
         and type(value['leaseSeconds']) is int and 86400 <= value['leaseSeconds'] <= 604800
         and type(value['renewBeforeSeconds']) is int
         and 3600 <= value['renewBeforeSeconds'] < value['leaseSeconds'], 'invalid_control')
    need(value['enabled'], 'authorization_revoked')
    return value


@contextmanager
def locked():
    fd = os.open('/opt/domino/.disabled-install.lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('operator_busy') from None
        yield
    finally:
        os.close(fd)


def tracked_files():
    files = set(MANAGED) | {BASE/'gateway/profile.json', BASE/'tunnel/config.yml', BASE/'tunnel-private/token'}
    files.update(BASE/r/'hosts' for r in ROLES)
    for unit in (*UNITS, 'domino-dev-egress.service'):
        path = Path('/etc/systemd/system')/unit
        files.add(path)
        files.update(path.with_name(path.name + '.d').glob('*.conf'))
    files.update(Path('/etc/systemd/system')/n for n in ('dominodev.slice', 'domino-dev-off.target'))
    return sorted(files)


def metadata(path):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_tracked_file')
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def unit_hashes():
    return {u: hashlib.sha256(command('systemctl', 'cat', u)).hexdigest()
            for u in (*UNITS, 'domino-dev-egress.service')}


def pins_from_hosts():
    result = {}
    for role in ROLES:
        mappings = {}
        for line in (BASE/role/'hosts').read_text().splitlines():
            fields = line.split('#', 1)[0].split()
            for name in fields[1:]:
                if name == 'localhost':
                    continue
                need(ipaddress.ip_address(fields[0]).version == 4
                     and ipaddress.ip_address(fields[0]).is_global, 'nonpublic_pin')
                mappings.setdefault(name, []).append(fields[0])
        need(mappings, 'missing_host_pins')
        result[role] = {h: sorted(set(a)) for h, a in sorted(mappings.items())}
    return result


def synchronized_expiry(policy, reader, admission):
    times = re.findall(r'meta time < (\d+)', policy)
    need(len(times) == 8 and len(set(times)) == 1, 'unexpected_policy_windows')
    value = int(times[0])
    need(value == reader['quotaQualification']['expiresAt'] == admission['expiresAt'], 'expiry_mismatch')
    need(reader['enabled'] is True and reader['quotaQualification']['approved'] is True
         and admission['enabled'] is True, 'admission_revoked')
    return value


def snapshot():
    return {'version': 1, 'updatedAt': int(time.time()),
            'expiresAt': synchronized_expiry(POLICY.read_text(), json.loads(READER.read_bytes()),
                                             json.loads(ADMISSION.read_bytes())),
            'files': {str(p): metadata(p) for p in tracked_files()}, 'unitHashes': unit_hashes(),
            'pinHosts': pins_from_hosts()}


def guard(lease):
    need(lease['version'] == 1, 'invalid_lease')
    need({str(p): metadata(p) for p in tracked_files()} == lease['files'], 'installed_file_drift')
    need(unit_hashes() == lease['unitHashes'], 'unit_drift')
    for unit in UNITS:
        need(command('systemctl', 'show', unit, '-p', 'NeedDaemonReload', '--value').strip() == b'no',
             'unit_reload_pending')
    need(snapshot()['expiresAt'] == lease['expiresAt'], 'lease_expiry_drift')


def fresh_pins(previous):
    result = {role: {} for role in ROLES}
    targets = []
    for role, hosts in previous.items():
        for host in hosts:
            addresses = sorted({r[4][0] for r in socket.getaddrinfo(host, None, socket.AF_INET)})
            need(0 < len(addresses) <= 64 and all(ipaddress.ip_address(a).is_global for a in addresses),
                 'invalid_dns_answers')
            if role == 'tunnel':
                network = {'region1.v2.argotunnel.com': '198.41.192.0/24',
                           'region2.v2.argotunnel.com': '198.41.200.0/24'}.get(host)
                need(network and all(ipaddress.ip_address(a) in ipaddress.ip_network(network)
                                     for a in addresses), 'tunnel_inventory_changed')
            else:
                targets.extend((host, address) for address in addresses)
            result[role][host] = addresses
    # Verify certificates against the original hostname at each proposed HTTPS address.
    context = ssl.create_default_context()
    def verify(target):
        host, address = target
        with socket.create_connection((address, 443), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname=host):
                return True
    with ThreadPoolExecutor(max_workers=8) as pool:
        need(all(pool.map(verify, targets)), 'tls_verification_failed')
    return result


def render_policy(original, pins, now, seconds):
    for line in original.splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            need(re.match(r'^(add|delete) (table|chain|set|counter|rule) inet domino_dev_off(?:\s|$)',
                          line) is not None, 'policy_scope')
    need(set(re.findall(r'(?:add|delete) table (\w+ \w+)', original)) == {'inet domino_dev_off'},
         'policy_scope')
    updated, count = re.subn(r'meta time >= \d+ meta time < \d+',
                            f'meta time >= {now} meta time < {now + seconds}', original)
    need(count == 8, 'policy_window_count')
    for role, name in zip(ROLES, ('reader_https', 'gateway_https', 'tunnel_edges')):
        addresses = sorted({a for values in pins[role].values() for a in values})
        elements = ', '.join(f'{a} timeout {seconds - 1}s' for a in addresses)
        line = (f'add set inet domino_dev_off {name} {{ type ipv4_addr; flags timeout; '
                f'size {len(addresses)}; elements = {{ {elements} }}; }}')
        updated, count = re.subn(r'^add set inet domino_dev_off ' + name + r' .*$', line, updated,
                                flags=re.MULTILINE)
        need(count == 1, 'policy_set_count')
    return updated.encode()


def pin_files(pins):
    files = {}
    for role, unit in zip(ROLES, UNITS):
        text = '127.0.0.1 localhost\n' + ''.join(
            f'{address} {host}\n' for host, addresses in sorted(pins[role].items()) for address in addresses)
        files[BASE/role/'hosts'] = text.encode()
        addresses = {'127.0.0.1'} | {a for values in pins[role].values() for a in values}
        if role == 'tunnel':
            addresses.add('127.0.0.53')
        dropin = '[Service]\nIPAddressAllow=\nIPAddressDeny=\nIPAddressDeny=any\n'
        dropin += ''.join(f'IPAddressAllow={a}/32\n' for a in sorted(addresses))
        dropin += f'BindReadOnlyPaths={BASE/role}/hosts:/etc/hosts\n'
        files[Path('/etc/systemd/system')/(unit+'.d')/'50-dev-egress.conf'] = dropin.encode()
    return files


def http_json(url, body=None):
    request = urllib.request.Request(url, data=None if body is None else encoded(body),
                                     headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def ready():
    deadline = time.monotonic() + 95
    while time.monotonic() < deadline:
        try:
            code, data = http_json('http://127.0.0.1:8890/health')
            if code == 200 and data.get('devAdmission', {}).get('state') == 'ready':
                code, tunnel = http_json('http://127.0.0.1:20242/ready')
                if code == 200 and tunnel.get('readyConnections') == 4:
                    gateway_code, _ = http_json('http://127.0.0.1:8891/internal/dev/v1/status')
                    if gateway_code == 403 and all(command('systemctl', 'is-active', u).strip() == b'active' for u in UNITS):
                        break
        except (OSError, ValueError):
            pass
        time.sleep(2)
    else:
        raise Refused('readiness_timeout')
    for _ in range(3):
        code, data = http_json('http://127.0.0.1:8890/v1/read/token', {'token': WETH})
        if code == 200:
            need(data.get('chainId') == 4663 and data.get('asset', {}).get('readStatus') == 'available'
                 and isinstance(data.get('snapshot', {}).get('number'), int), 'functional_read_invalid')
            return
        if code != 429:
            break
        time.sleep(3)
    raise Refused('functional_read_failed')


def production_fingerprint(boot=False):
    if boot:
        # Production may legitimately be starting concurrently at machine boot.
        return {'policyFile': hashlib.sha256(Path('/etc/domino/continuous-reads/policy.nft').read_bytes()).hexdigest()}
    return {'policy': hashlib.sha256(command('nft', '-s', 'list', 'table', 'inet', 'domino_continuous_reads')).hexdigest(),
            'pids': {u: command('systemctl', 'show', u, '-p', 'MainPID', '--value').decode().strip()
                     for u in ('domino-read.service', 'domino-gateway.service', 'domino-tunnel.service')}}


def restore(transaction, boot=False):
    """Block dev first; restore exact backups; leave a recoverable closed state."""
    directory = STATE/transaction['directory']
    need(directory.parent == STATE and directory.name.startswith('transaction-'), 'invalid_transaction_path')
    allowed = set(tracked_files())
    backups = []
    for index, item in enumerate(transaction['files']):
        path, info = Path(item['path']), item['metadata']
        need(path in allowed, 'invalid_backup_target')
        data = (directory/str(index)).read_bytes()
        need(hashlib.sha256(data).hexdigest() == info['sha256'], 'backup_corrupt')
        backups.append((path, data, info))
    need(backups and backups[0][0] == POLICY, 'invalid_policy_backup')
    original = backups[0][1].decode()
    closed = re.sub(r'meta time >= \d+ meta time < \d+', 'meta time >= 0 meta time < 1', original)
    atomic(directory/'closed.nft', closed.encode())
    command('nft', '-f', str(directory/'closed.nft'))
    if not boot:
        command('systemctl', 'stop', *UNITS)
    for path, data, info in backups:
        atomic(path, data, info['uid'], info['gid'], info['mode'])
    command('systemctl', 'daemon-reload')
    atomic(STATE/'lease.json', (directory/'lease.json').read_bytes())
    atomic(STATE/'last-rollback.json', encoded({'at': int(time.time()), 'directory': directory.name}))
    (STATE/'transaction.json').unlink()


def renew(control, lease, pins, boot=False, reason='scheduled'):
    now = int(time.time())
    files = {POLICY: render_policy(POLICY.read_text(), pins, now, control['leaseSeconds'])}
    reader, admission = json.loads(READER.read_bytes()), json.loads(ADMISSION.read_bytes())
    changed_pins = pins != lease['pinHosts']
    directory = Path(tempfile.mkdtemp(prefix='transaction-', dir=STATE))
    os.chmod(directory, 0o700)
    receipt = {'version': 1, 'authorization': control['authorization'], 'grantedAt': now,
               'expiresAt': now + control['leaseSeconds'], 'previousExpiresAt': lease['expiresAt'],
               'previousReceipt': reader['quotaQualification']['receiptSha256'],
               'reason': reason, 'pinsChanged': changed_pins, 'pinHosts': pins}
    atomic(directory/'receipt.json', encoded(receipt))
    reader['quotaQualification'].update(expiresAt=receipt['expiresAt'],
                                      receiptSha256=hashlib.sha256(encoded(receipt)).hexdigest())
    admission['expiresAt'] = receipt['expiresAt']
    files.update({READER: encoded(reader), ADMISSION: encoded(admission)})
    if changed_pins:
        files.update(pin_files(pins))
    transaction = {'version': 1, 'startedAt': now, 'directory': directory.name,
                   'files': [{'path': str(p), 'metadata': metadata(p)} for p in files]}
    for index, p in enumerate(files):
        atomic(directory/str(index), p.read_bytes())
    atomic(directory/'lease.json', encoded(lease))
    atomic(directory/'candidate.nft', files[POLICY])
    command('nft', '-c', '-f', str(directory/'candidate.nft'))
    before = production_fingerprint(boot)
    atomic(STATE/'transaction.json', encoded(transaction))
    try:
        info = metadata(ADMISSION)
        atomic(ADMISSION, encoded(dict(admission, enabled=False)), info['uid'], info['gid'])
        if changed_pins and not boot:
            command('systemctl', 'stop', *UNITS)
        for item in transaction['files']:
            path, info = Path(item['path']), item['metadata']
            if path != ADMISSION:
                atomic(path, files[path], info['uid'], info['gid'], info['mode'])
        command('nft', '-f', str(POLICY))
        if changed_pins:
            command('systemctl', 'daemon-reload')
        # Gateway validates admission during startup. Reader enforces its own
        # 60-second cooldown, so publish the synchronized grant before starting
        # gateway, then verify all components before committing the lease.
        info = transaction['files'][2]['metadata']
        atomic(ADMISSION, files[ADMISSION], info['uid'], info['gid'], info['mode'])
        if not boot:
            command('systemctl', 'restart', UNITS[0])
            command('systemctl', 'start', UNITS[1])
            command('systemctl', 'restart' if changed_pins else 'start', UNITS[2])
            ready()
        need(production_fingerprint(boot) == before, 'production_changed_during_transaction')
        result = snapshot()
        result['lastRenewal'] = {'at': now, 'reason': reason, 'transactionDirectory': str(directory)}
        atomic(STATE/'lease.json', encoded(result))
        (STATE/'transaction.json').unlink()
        print(json.dumps({'event': 'lease_renewed', 'expiresAt': result['expiresAt'], 'pinsChanged': changed_pins}))
        return result
    except BaseException:
        restore(transaction, boot)
        if not boot and lease['expiresAt'] > time.time() and private(CONFIG).get('enabled') is True:
            command('nft', '-f', str(POLICY))
            command('systemctl', 'start', *UNITS)
            ready()
        raise


def run(mode):
    need(os.geteuid() == 0, 'root_required')
    control = private(CONFIG)
    if mode == 'revoke':
        control['enabled'] = False
        atomic(CONFIG, encoded(control))
        data = json.loads(ADMISSION.read_bytes())
        data['enabled'] = False
        info = ADMISSION.stat()
        atomic(ADMISSION, encoded(data), info.st_uid, info.st_gid)
        closed = re.sub(r'meta time >= \d+ meta time < \d+', 'meta time >= 0 meta time < 1', POLICY.read_text())
        atomic(POLICY, closed.encode())
        command('nft', '-f', str(POLICY))
        command('systemctl', 'stop', *UNITS)
        Path('/run/domino-dev-connector.reviewed').unlink(missing_ok=True)
        return
    controls(control)
    need(command('timedatectl', 'show', '-p', 'NTPSynchronized', '--value').strip() == b'yes',
         'clock_not_synchronized')
    if mode == 'adopt':
        need(not (STATE/'lease.json').exists(), 'already_adopted')
        atomic(STATE/'lease.json', encoded(snapshot()))
        return
    if (STATE/'transaction.json').exists():
        restore(private(STATE/'transaction.json'), boot=mode == 'boot')
    lease = private(STATE/'lease.json')
    guard(lease)
    pins = fresh_pins(lease['pinHosts'])
    must_renew = (mode == 'renew' or pins != lease['pinHosts']
                  or lease['expiresAt'] - time.time() <= control['renewBeforeSeconds'])
    if must_renew:
        lease = renew(control, lease, pins, boot=mode == 'boot', reason=mode)
    if mode == 'boot':
        need(lease['expiresAt'] > time.time(), 'lease_expired')
        atomic(Path('/run/domino-dev-connector.reviewed'), b'')
        return
    # Restore an expired/empty kernel set or recover stopped components only with
    # a verified lease. Reapply scoped policy; absolute expiry is never extended.
    command('nft', '-f', str(POLICY))
    command('systemctl', 'start', 'domino-dev-continuous.target')
    command('systemctl', 'start', *UNITS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('adopt', 'boot', 'ensure', 'renew', 'revoke'))
    args = parser.parse_args()
    try:
        with locked():
            run(args.mode)
        (STATE/'last-error.json').unlink(missing_ok=True)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else type(error).__name__
        if code != 'operator_busy' and STATE.is_dir():
            atomic(STATE/'last-error.json', encoded({'at': int(time.time()), 'mode': args.mode, 'code': code}))
        print(json.dumps({'event': 'maintenance_refused', 'code': code}))
        # A skipped boot validation must never unlock dependent services.
        return 0 if code == 'operator_busy' and args.mode == 'ensure' else 1


if __name__ == '__main__':
    raise SystemExit(main())
