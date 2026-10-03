#!/usr/bin/env python3
"""Point the read and gateway units at an installed read release. Starts nothing.

install_read_release.py writes a release and leaves activation to the operator:
"repoint the drop-in". On the first VM that drop-in grew by hand in three layers
(70 release, 80 V4 snapshot, 90 V5 featured pools; READ_PATH_SWITCH_ON.md and
FEATURED_POOLS.md). This writes their combined effect as one reviewed drop-in per
unit, for the profile live since 27 Sep 2026:

- read: the release's reader, with public data on;
- gateway: the release's gateway with the v1-v5 bridge reads enabled exactly as
  they are today (pool market; overview, history and search; the V1 sequence
  snapshot; featured pools).

The interpreter is the release's own `backend/.venv`, a link to the shared
environment, and each identity's runtime directory is the one the release links
to. The scoped egress drop-ins (60) come from the continuous egress policy.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
RELEASES = install.BASE / 'releases'
DROP_INS = {'read': '70-reader-release.conf', 'gateway': '70-gateway-release.conf'}
COMMANDS = {
    'read': 'backend/read_api.py --port 8876 --read-budget 15',
    'gateway': 'backend/read_gateway.py --port 8878 --reader-port 8876 '
               '--enable --enable-v2 --enable-v3 --enable-v4 --enable-v5',
}
ENVIRONMENT = {
    'read': ('DOMINO_PUBLIC_DATA=1',),
    'gateway': ('DOMINO_BRIDGE_V2_READS=pool-market', 'DOMINO_BRIDGE_V3_READS=overview,history,search',
                'DOMINO_BRIDGE_V4_READS=sequence-snapshot', 'DOMINO_BRIDGE_V5_READS=featured-pools'),
}


def drop_in(component, commit, runtime):
    root = RELEASES / commit / component
    lines = ['# Read path activation (install_read_activation.py): release, runtime and bridge reads.',
             '[Service]', f'WorkingDirectory={root}', 'ExecStart=',
             f'ExecStart={root}/backend/.venv/bin/python3.14 -B {COMMANDS[component]}',
             'ReadWritePaths=', f'ReadWritePaths={runtime}',
             *(f'Environment={value}' for value in ENVIRONMENT[component])]
    return '\n'.join(lines) + '\n'


def plan(commit):
    require(re.fullmatch('[0-9a-f]{40}', commit), 'commit must be a full lowercase Git SHA')
    files = {}
    for component, name in DROP_INS.items():
        root = RELEASES / commit / component
        require(root.is_dir() and (root / 'backend/.venv').is_symlink(), 'read_release_not_installed')
        link = root / 'backend/runtime'
        require(link.is_symlink(), 'read_release_not_installed')
        runtime = Path(os.readlink(link))
        require(runtime.is_absolute() and runtime.is_dir(), 'read_runtime_missing')
        path = install.UNIT_DIR / f'domino-{component}.service.d' / name
        require(not os.path.lexists(path), 'read_activation_exists')
        require((install.UNIT_DIR / f'domino-{component}.service').is_file(), 'base_unit_missing')
        files[str(path)] = drop_in(component, commit, runtime)
    return {'mode': 'read-activation', 'commit': commit, 'dropIns': files,
            'notPerformed': ['service start, enable or restart', 'egress drop-ins (60)', 'runtime configuration']}


def apply(planned):
    require(os.geteuid() == 0, 'root_required')
    for name, text in planned['dropIns'].items():
        path = Path(name)
        path.parent.mkdir(mode=0o755, exist_ok=True)
        install.exclusive_file(path, text.encode(), 0o644)
    install.run(['/usr/bin/systemctl', 'daemon-reload'])
    effective = {}
    for component in DROP_INS:
        output = install.run(['/usr/bin/systemctl', 'show', f'domino-{component}.service',
                              '-p', 'WorkingDirectory', '--value']).decode().strip()
        require(output == str(RELEASES / planned['commit'] / component), 'activation_not_effective')
        effective[component] = output
    return {**planned, 'ok': True, 'workingDirectories': effective,
            'next': 'start through domino-continuous-reads.target at cutover'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True, help='the read release installed by install_read_release.py')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        planned = plan(args.commit)
        result = apply(planned) if args.apply else {**planned, 'ok': True, 'applied': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'no drop-in written'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
