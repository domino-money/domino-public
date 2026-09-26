#!/usr/bin/env python3
"""Bring the automation back after a reboot. Starts, stops and reloads nothing.

The automation installer writes static units: domino-automation, the gas
reservation socket and the settlement timer have no [Install] section, so a
reboot leaves them off until someone starts them again. The VM's other
families come back through a target of their own that multi-user.target wants
(domino-continuous-reads.target, domino-public-data.target). This tool writes
domino-automation.target, which wants those three, and enables it the way
`systemctl enable` does, with a link in multi-user.target.wants. The units,
their drop-ins and the reservation service its socket starts stay as they are.

At boot the serve loop may start before the RPC tunnel is back: it retries its
publication recovery every interval until the node answers
(automation_cycle.serve), so waiting never spends the unit's start limit.

After --apply the operator runs daemon-reload; `systemctl start
domino-automation.target` then starts only what is not running. --rollback
removes the link and the target, which stops nothing: the units keep running
until they are stopped or the host restarts.
"""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import install_automation_release as release
import prepare_disabled as install
from install_read_release import read_installed

require = install.require
auth = release.auth
TARGET = 'domino-automation.target'
# What a reboot must bring back; the reservation service starts from its socket.
MEMBERS = ('domino-gas-reservation.socket', 'domino-gas-settlement.timer', 'domino-automation.service')
HEADER = ('# Written by scripts/staging/install_automation_boot.py: what brings the automation\n'
          '# back after a reboot. The units themselves stay static.\n')


def target_text():
    members = ' '.join(MEMBERS)
    return (HEADER + '[Unit]\nDescription=Domino automation after a reboot: the serve loop and its gas peers\n'
            f'Wants={members}\nAfter={members}\n\n[Install]\nWantedBy=multi-user.target\n')


def paths():
    """The target, and the link `systemctl enable` would make for its WantedBy."""
    unit_dir = release.release_tool.UNIT_DIR
    return unit_dir / TARGET, unit_dir / 'multi-user.target.wants' / TARGET


def show(unit, *properties):
    raw = install.run(['/usr/bin/systemctl', 'show', unit, '--property=' + ','.join(properties)]).decode()
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def wiring():
    """Whether this tool's target and link are in place; anything else under their names is refused."""
    target, link = paths()
    written = target.exists() or target.is_symlink()
    if written:
        require(not target.is_symlink() and read_installed(target, 65536).decode() == target_text(), 'target_drift')
    linked = link.exists() or link.is_symlink()
    if linked:
        require(link.is_symlink() and os.readlink(link) == str(target), 'wants_link_foreign')
    loaded = show(TARGET, 'LoadState', 'FragmentPath')
    # Another file under this name would be the one systemd runs.
    require(loaded.get('LoadState') != 'loaded' or loaded.get('FragmentPath') == str(target), 'target_moved')
    return written, linked


def plan():
    unit_dir = paths()[0].parent
    for member in MEMBERS:
        state = show(member, 'LoadState', 'FragmentPath')
        require(state.get('LoadState') == 'loaded', 'member_not_loaded')
        require(state.get('FragmentPath') == str(unit_dir / member), 'member_moved')
    written, linked = wiring()
    target, link = paths()
    return {'schemaVersion': 1, 'mode': 'automation-boot', 'target': str(target), 'link': str(link),
            'members': list(MEMBERS), 'changes': [name for name, done in (('target', written), ('link', linked)) if not done],
            'notPerformed': ['start, stop, restart or daemon-reload', 'unit, drop-in or configuration change',
                             'enable or disable of any other unit']}


def apply(planned):
    require(os.geteuid() == 0, 'root_required')
    target, link = paths()
    filesystem.protected_parents(target.parent)
    # The target first: the link never points at nothing.
    if 'target' in planned['changes']:
        auth.replace(target, target_text().encode(), 0o644)
    if 'link' in planned['changes']:
        wants = link.parent
        if not wants.exists():
            filesystem.protected_parents(wants.parent)
            wants.mkdir(mode=0o755)
            os.chmod(wants, 0o755)
        filesystem.protected_parents(wants)
        link.symlink_to(target)
        install.fsync_directory(wants)
    return {'ok': True, 'mode': planned['mode'], 'written': planned['changes'], 'activated': False,
            'activation': (f'systemctl daemon-reload; every boot then starts {TARGET}. systemctl start {TARGET} '
                           'now starts only what is not running')}


def rollback():
    require(os.geteuid() == 0, 'root_required')
    written, linked = wiring()
    target, link = paths()
    # The link first, so no reload ever finds it pointing at a missing target.
    for path, present in ((link, linked), (target, written)):
        if present:
            filesystem.protected_parents(path.parent)
            path.unlink()
            install.fsync_directory(path.parent)
    return {'ok': True, 'mode': 'automation-boot-rollback',
            'removed': [str(path) for path, present in ((link, linked), (target, written)) if present],
            'activated': False,
            'action': 'systemctl daemon-reload; the units keep running, and the next boot no longer starts them'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.inspect:
            result = {**plan(), 'ok': True, 'installed': False}
        else:
            require(os.geteuid() == 0, 'root_required')
            # The lock the automation installer, its readiness upgrade and its release mover take.
            with release.exclusive():
                result = apply(plan()) if args.apply else rollback()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'nothing started, stopped or reloaded'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
