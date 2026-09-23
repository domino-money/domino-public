#!/usr/bin/env python3
"""Bounded, synthetic CI checks for the automation install boundary.

This does not call install_automation.py --inspect/--apply, connect to a
database/RPC, start systemd units, or read configuration or key files. The
native mode needs root only inside a disposable Ubuntu runner to prove the
real Linux SO_PEERCRED and filesystem permission boundary with synthetic users.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import signal
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'staging'))
import install_automation as installer
import prepare_disabled as base

USERS = ('domino-gas-reservation', 'domino-automation',
         'domino-execution-signer', 'domino-gas-settlement',
         'domino-rehearsal-outsider')
GROUP = 'domino-db'
RESERVATION = {'day': '2026-09-23', 'reservedUsdMicros': 1_000_000,
               'state': 'reserved'}
ATTESTATION = {'answerRaw': 4_000 * 10**8, 'roundId': (1 << 64) + 17,
               'answerUpdatedAt': 100, 'blockNumber': 200,
               'blockHash': '0x' + '55' * 32, 'blockTimestamp': 200}
CLAIM = '0x' + '33' * 32
PUBLISHER = '0x' + '11' * 20
OPERATOR = '0x' + '22' * 20


def need(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def command(*argv):
    return subprocess.run(argv, cwd=ROOT, check=True, capture_output=True,
                          text=True).stdout.strip()


def archive_plan():
    # The native check runs as root inside a disposable runner, while checkout
    # remains owned by the runner user. Trust only this exact checkout for the
    # two read-only Git commands; never change root's global Git config.
    git = ('git', '-c', 'safe.directory=' + str(ROOT))
    commit = command(*git, 'rev-parse', 'HEAD')
    with tempfile.TemporaryDirectory(prefix='domino-automation-plan-') as directory:
        archive = Path(directory) / 'source.tar'
        command(*git, 'archive', '--format=tar', '-o', str(archive), commit)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        files = base.archive_files(archive, digest, commit)
        planned = installer.plan(files, commit, digest)
        cli = command(sys.executable, str(ROOT / 'scripts/staging/install_automation.py'),
                      '--archive', str(archive), '--archive-sha256', digest,
                      '--commit', commit)
        need(json.loads(cli) == planned, 'installer_plan_mismatch')
    units = {installer.UNIT: planned['unit'], **planned['peerUnits']}
    need(set(units) == {installer.UNIT, *installer.PEER_UNITS},
         'unit_set_mismatch')
    need(all('[Install]' not in unit and 'WantedBy=' not in unit
             for unit in units.values()), 'unit_can_be_enabled')
    need(all(planned[key] is False for key in
             ('servicesStarted', 'configurationCreated', 'keysCreated')),
         'plan_not_off')
    need('ConditionPathExists=/etc/domino/financial/automation/config.json\n'
         in units[installer.UNIT], 'automation_missing_off_gate')
    need('ConditionPathExists=/etc/domino/financial/gas-reservation/config.json\n'
         in units['domino-gas-reservation.service'], 'reservation_missing_off_gate')
    need('ConditionPathExists=/etc/domino/financial/gas-settlement/config.json\n'
         in units['domino-gas-settlement.service'], 'settlement_missing_off_gate')
    return commit, digest, units


def add_synthetic_users():
    need(os.geteuid() == 0 and sys.platform == 'linux', 'disposable_linux_root_required')
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines()
                   if '=' in line)
    need(release.get('ID', '').strip('"') == 'ubuntu'
         and release.get('VERSION_ID', '').strip('"') == '24.04',
         'ubuntu_24_04_required')
    need(not Path('/opt/domino').exists()
         and not Path('/etc/domino').exists()
         and not Path('/run/domino-gas-reservation.sock').exists(),
         'not_a_clean_disposable_runner')
    need(not any(user in {entry.pw_name for entry in pwd.getpwall()} for user in USERS)
         and GROUP not in {entry.gr_name for entry in grp.getgrall()},
         'rehearsal_identity_exists')
    command('/usr/sbin/groupadd', '--system', GROUP)
    for user in USERS:
        argv = ['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin']
        if user != 'domino-rehearsal-outsider':
            argv.extend(('--groups', GROUP))
        command(*argv, user)


def verify_units(commit, units):
    """Parse the exact planned units; never install or start any of them."""
    interpreter = Path('/opt/domino/backend-venv/bin/python3.14')
    release = Path('/opt/domino/financial/releases') / commit / 'automation'
    interpreter.parent.mkdir(parents=True)
    interpreter.symlink_to(sys.executable)
    release.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory(prefix='domino-off-units-') as directory:
            target = Path(directory)
            paths = []
            for name, body in units.items():
                path = target / name
                path.write_text(body)
                paths.append(str(path))
            # The PG dependency is a syntax-only placeholder; no database exists
            # or starts on this runner.
            pg = target / 'postgresql@16-domino.service'
            pg.write_text('[Unit]\nDescription=Synthetic dependency for unit parser\n'
                          '[Service]\nType=oneshot\nExecStart=/bin/true\n')
            result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', '--man=no',
                                     *paths, str(pg)], cwd=ROOT,
                                    capture_output=True, text=True)
            need(result.returncode == 0,
                 'systemd_unit_verify_failed: ' + (result.stderr or result.stdout)[-2000:])
    finally:
        shutil.rmtree(Path('/opt/domino'))


def identity(user):
    account = pwd.getpwnam(user)
    return account.pw_uid, account.pw_gid, os.getgrouplist(user, account.pw_gid)


def lower_to(user):
    uid, gid, groups = identity(user)
    os.setgroups(groups)
    os.setgid(gid)
    os.setuid(uid)
    signal.alarm(8)


def socket_case(path, user, operation):
    """Run a real client under a distinct UID and return a small JSON result."""
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            lower_to(user)
            from gas_budget_bridge import GasBudgetClient
            from gas_usd_budget import GasBudgetError
            client = GasBudgetClient(path, server_uid=identity('domino-gas-reservation')[0])
            try:
                if operation == 'reserve':
                    value = client.reserve_pair(CLAIM, PUBLISHER, 1,
                                                '0x' + '44' * 32, OPERATOR, 2)
                else:
                    value = client.attest_settlement_quote(CLAIM, 'publisher')
                answer = {'ok': value}
            except GasBudgetError as error:
                answer = {'error': error.code}
            os.write(write_fd, json.dumps(answer, sort_keys=True).encode())
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(write_fd)
    raw = os.read(read_fd, 4096)
    os.close(read_fd)
    _, status = os.waitpid(pid, 0)
    need(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 and raw,
         'socket_client_failed:' + user + ':' + operation)
    return json.loads(raw)


def verify_socket():
    sys.path.insert(0, str(ROOT / 'backend'))
    from gas_budget_bridge import (SIGNING_OPERATIONS, SETTLEMENT_OPERATIONS,
                                   serve_one)

    class SyntheticService:
        def __init__(self):
            self.calls = []

        def reserve_pair(self, *args):
            self.calls.append('reserve_pair')
            return {'publisher': RESERVATION, 'operator': RESERVATION}

        def attest_settlement_quote(self, *args):
            self.calls.append('attest_settlement_quote')
            return ATTESTATION

    with tempfile.TemporaryDirectory(prefix='domino-gas-peer-') as directory:
        root = Path(directory)
        server_uid = identity('domino-gas-reservation')[0]
        db_gid = grp.getgrnam(GROUP).gr_gid
        os.chown(root, server_uid, db_gid)
        os.chmod(root, 0o2770)
        path = str(root / 'reservation.sock')
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            try:
                lower_to('domino-gas-reservation')
                allowed = {identity('domino-automation')[0]: SIGNING_OPERATIONS,
                           identity('domino-execution-signer')[0]: SIGNING_OPERATIONS,
                           identity('domino-gas-settlement')[0]: SETTLEMENT_OPERATIONS}
                service = SyntheticService()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(path)
                    os.chmod(path, 0o660)
                    listener.listen(5)
                    listener.settimeout(8)
                    os.write(write_fd, b'R')
                    for _ in range(5):
                        conn, _ = listener.accept()
                        with conn:
                            serve_one(conn, service, allowed)
                os.write(write_fd, json.dumps(service.calls).encode())
                os._exit(0)
            except BaseException:
                os._exit(1)
        os.close(write_fd)
        try:
            need(os.read(read_fd, 1) == b'R', 'socket_server_not_ready')
            need(socket_case(path, 'domino-automation', 'reserve') ==
                 {'ok': {'publisher': RESERVATION, 'operator': RESERVATION}},
                 'automation_reservation_failed')
            need(socket_case(path, 'domino-execution-signer', 'reserve') ==
                 {'ok': {'publisher': RESERVATION, 'operator': RESERVATION}},
                 'signer_reservation_failed')
            need(socket_case(path, 'domino-gas-settlement', 'attest') ==
                 {'ok': ATTESTATION}, 'settlement_attestation_failed')
            need(socket_case(path, 'domino-gas-settlement', 'reserve') ==
                 {'error': 'gas_budget_unavailable'}, 'settlement_reserved_gas')
            need(socket_case(path, 'domino-automation', 'attest') ==
                 {'error': 'gas_budget_unavailable'}, 'automation_attested_quote')
            need(socket_case(path, 'domino-rehearsal-outsider', 'reserve') ==
                 {'error': 'gas_budget_unavailable'}, 'outsider_connected')
            calls = json.loads(os.read(read_fd, 4096))
            _, status = os.waitpid(pid, 0)
            pid = None
            need(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0,
                 'socket_server_failed')
            need(calls == ['reserve_pair', 'reserve_pair', 'attest_settlement_quote'],
                 'unauthorized_socket_dispatch')
        finally:
            os.close(read_fd)
            if pid is not None:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('plan', 'native'))
    args = parser.parse_args()
    commit, digest, units = archive_plan()
    if args.mode == 'native':
        add_synthetic_users()
        verify_units(commit, units)
        verify_socket()
    print(json.dumps({'ok': True, 'mode': args.mode, 'commit': commit,
                      'archiveSha256': digest, 'unitCount': len(units),
                      'unitSyntaxVerified': args.mode == 'native',
                      'realPeerCredentialChecks': 6 if args.mode == 'native' else 0,
                      'nativeInstallerApplied': False,
                      'servicesStarted': False, 'configurationCreated': False,
                      'rpcCalls': 0, 'mainnetTransactionsSent': False},
                     sort_keys=True))


if __name__ == '__main__':
    main()
