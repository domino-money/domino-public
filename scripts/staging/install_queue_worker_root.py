#!/usr/bin/env python3
"""Create the writer's queue-worker root and its four base units. Starts and enables nothing.

On the first VM this root was assembled by hand on 15 Sep 2026
(reports/T1_6_T1_7_FOLLOWERS_2026-09-15.md): a copy of the repository under
/opt/domino/queue-worker/release, the writer's virtual environment beside it, a
private runtime directory, and four hand-written units. install_public_data.py
then repoints the units at /opt/domino/public-data/current with its 90 drop-ins,
so of the copied tree only two things are still read: the dependency lock, which
install_public_data.py compares with its own, and the runtime directory.

This creates exactly those two, from a verified release archive, and the four
base units with the first VM's text. The virtual environment comes from
install_runtimes.py. Run it before install_public_data.py, which refuses without
it (`writer_runtime_not_private`, `writer_interpreter_missing`).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
QUEUE = install.BASE / 'queue-worker'
BACKEND = QUEUE / 'release/backend'
RUNTIME = BACKEND / 'runtime'
LOCK = 'backend/requirements-api.lock'
WRITER = 'domino-write'
DESCRIPTOR = json.dumps({'host': install.SOCKET, 'port': 8877, 'dbname': install.DB}).encode() + b'\n'
HARDENING = """UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectKernelLogs=yes
ProtectClock=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
"""


def service(description, command):
    return f"""[Unit]
Description={description}
After=postgresql@16-domino.service
StartLimitIntervalSec=300
StartLimitBurst=6

[Service]
Type=oneshot
User={WRITER}
Group={WRITER}
SupplementaryGroups=domino-db
WorkingDirectory={BACKEND}
ExecStart={QUEUE}/venv/bin/python -B {command}
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
""" + HARDENING


def timer(description, boot, unit):
    return f"""[Unit]
Description={description}

[Timer]
OnBootSec={boot}
OnUnitActiveSec=60s
AccuracySec=5s
Unit={unit}

[Install]
WantedBy=timers.target
"""


# The first VM's base units, byte for byte. install_public_data.py's 90 drop-ins
# replace the working directory, the command and the triggers.
UNITS = {
    'domino-queue-worker.service': service(
        'Domino on-demand pool queue worker',
        'manage_activity.py --queue-worker --search-back-blocks 400000 --search-span 5000 --search-max-spans 80 '
        '--max-pools 2 --max-steps 5 --span 100000 --lag 100 --parallel-walks --max-header-calls 5000'),
    'domino-queue-worker.timer': timer('Run the Domino pool queue worker every minute', '2min',
                                       'domino-queue-worker.service'),
    'domino-catalogue-follower.service': service(
        'Domino public catalogue follower',
        'manage_catalogue.py follow --lag 200 --span 100000 --max-passes 1 --poll-seconds 0 '
        '--max-consecutive-failures 3'),
    'domino-catalogue-follower.timer': timer('Follow the Domino public catalogue every minute', '3min',
                                             'domino-catalogue-follower.service'),
}


def plan(files, commit, digest):
    require(LOCK in files, 'lock_missing_from_archive')
    require((QUEUE / 'venv/bin/python').exists(), 'writer_interpreter_missing')
    require(not os.path.lexists(QUEUE / 'release'), 'queue_worker_release_exists')
    for name in UNITS:
        require(not os.path.lexists(install.UNIT_DIR / name), 'queue_worker_unit_exists')
    pwd.getpwnam(WRITER)
    return {'mode': 'queue-worker-root', 'commit': commit, 'archiveSha256': digest,
            'lockSha256': hashlib.sha256(files[LOCK][0]).hexdigest(), 'runtime': str(RUNTIME),
            'units': sorted(UNITS),
            'notPerformed': ['unit enable or start', 'provider configuration (owner phase)',
                             'copy of any other release file']}


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    install.trusted_parents(QUEUE)
    for path in (QUEUE / 'release', BACKEND):
        path.mkdir(mode=0o755)
        os.chmod(path, 0o755)
    install.exclusive_file(BACKEND / 'requirements-api.lock', files[LOCK][0], 0o444)
    account = pwd.getpwnam(WRITER)
    RUNTIME.mkdir(mode=0o700)
    os.chown(RUNTIME, account.pw_uid, account.pw_gid)
    os.chmod(RUNTIME, 0o700)
    install.exclusive_file(RUNTIME / 'catalogue-db.json', DESCRIPTOR, 0o600, account.pw_uid, account.pw_gid)
    for name, text in UNITS.items():
        install.exclusive_file(install.UNIT_DIR / name, text.encode(), 0o644)
    install.run(['/usr/bin/systemctl', 'daemon-reload'])
    return {**planned, 'ok': True, 'installed': True,
            'next': 'install_public_data.py; the timers are enabled at cutover'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True, help='the public-data release archive')
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        files = install.archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(files, args.commit, args.archive_sha256)
        result = apply(files, planned) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'nothing enabled or started'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
