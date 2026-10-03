#!/usr/bin/env python3
"""Apply the migrations the first VM applied by hand, each as the identity it used. Starts nothing.

Most migrations arrive with an installer (001-014 prepare_disabled.py, 015-019
upgrade_financial.py, 028-040 and 046 install_automation.py). These did not: the
operator ran them with psql as the procedures in WALLET_ACCESS.md,
WALLET_SESSIONS.md and FEATURED_POOLS.md describe. On the first VM their objects
show who ran them: the domino_activity changes (020-023) belong to the catalogue
owner, and the domino_public schema (024-026, 042-045, 047) to postgres; 027 and
041 only alter existing tables and were run as postgres.

Each migration is read from a verified release archive and applied in one
transaction with ON_ERROR_STOP, in the order given, after its predecessors. A
private receipt per migration refuses any second application.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
RECEIPTS = Path('/var/backups/domino-migrations')
ADMIN = ('domino-admin', install.ADMIN)
POSTGRES = ('postgres', 'postgres')
# Every migration this tool may apply, with the OS and SQL identity that applied it first.
HAND_APPLIED = {
    '020_pool_requests': ADMIN,
    '021_reference_price_sources': ADMIN,
    '022_event_timestamp_source': ADMIN,
    '023_pool_request_scheduling': ADMIN,
    '024_public_observations': POSTGRES,
    '025_public_history': POSTGRES,
    '026_public_demand': POSTGRES,
    '027_remove_wallet_access_gate': POSTGRES,
    '041_session_delegated_accounts': POSTGRES,
    '042_provider_priority': POSTGRES,
    '043_featured_pools': POSTGRES,
    '044_demand_horizon': POSTGRES,
    '045_featured_live': POSTGRES,
    '047_provider_ceiling': POSTGRES,
}


def selected(names):
    """Known names only, in ascending order, each after every requested predecessor."""
    chosen = [name.strip() for name in names.split(',') if name.strip()]
    require(chosen and len(set(chosen)) == len(chosen), 'migration_list_invalid')
    require(all(name in HAND_APPLIED for name in chosen), 'migration_not_hand_applied')
    require(chosen == sorted(chosen), 'migrations_out_of_order')
    return chosen


def receipt(name):
    return RECEIPTS / f'{name}.json'


def plan(files, commit, digest, chosen):
    steps = []
    for name in chosen:
        path = f'backend/migrations/{name}.sql'
        require(path in files, 'migration_missing_from_archive')
        require(not os.path.lexists(receipt(name)), 'migration_already_applied')
        os_user, role = HAND_APPLIED[name]
        steps.append({'migration': name, 'sha256': hashlib.sha256(files[path][0]).hexdigest(),
                      'osUser': os_user, 'role': role})
    return {'mode': 'hand-applied-migrations', 'commit': commit, 'archiveSha256': digest,
            'migrations': steps, 'notPerformed': ['unit, release or service change', 'migration outside the list']}


def psql(os_user, role):
    return ['/usr/sbin/runuser', '-u', os_user, '--', str(install.PG / 'psql'), '-X', '-w', '-q',
            '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-h', install.SOCKET, '-p', '8877',
            '-U', role, '-d', install.DB, '-f', '-']


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    if not RECEIPTS.exists():
        install.trusted_parents(RECEIPTS.parent)
        RECEIPTS.mkdir(mode=0o700)
    install.trusted_parents(RECEIPTS)
    applied = []
    for step in planned['migrations']:
        name = step['migration']
        payload = files[f'backend/migrations/{name}.sql'][0]
        require(hashlib.sha256(payload).hexdigest() == step['sha256'], 'migration_changed_since_plan')
        require(not os.path.lexists(receipt(name)), 'migration_already_applied')
        install.run(psql(step['osUser'], step['role']), data=payload)
        record = {**step, 'commit': planned['commit'], 'appliedAt': int(time.time())}
        install.exclusive_file(receipt(name), json.dumps(record, sort_keys=True).encode() + b'\n')
        applied.append(name)
    return {**planned, 'ok': True, 'applied': applied}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--migrations', required=True, help='comma-separated, e.g. 020_pool_requests,021_...')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        require(re.fullmatch(r'[0-9a-z_,]+', args.migrations), 'migration_list_invalid')
        files = install.archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(files, args.commit, args.archive_sha256, selected(args.migrations))
        result = apply(files, planned) if args.apply else {**planned, 'ok': True, 'applied': []}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'stop; migrations before the failing one stay applied and receipted'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
