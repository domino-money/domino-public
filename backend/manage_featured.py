"""Featured pools (featured-policy v1): the daily selection service and the owner's overrides.

`serve` sleeps until the selection window before `selectionHourUtc` (UTC),
selects once per date, and sleeps again; `select` runs one selection now.
Attempts before `selectionRetryUntilMinutes` may end `incomplete` (the
provider cut the listing short) and are retried; the last attempt keeps
yesterday's list instead. Overrides apply from the next selection.

This phase publishes nothing: the list is written as `shadow`, for comparison
with the manual list. One JSON line per invocation or tick, as the lanes do.
"""
import argparse
from datetime import datetime, timezone
import json
import signal
import threading
import time

from catalogue import configured_writer_catalogue
from discovery import DataError, bytes32
from featured_pools import load_policy
from featured_selector import Selector
from featured_store import FeaturedStore
from local_config import load_config
from public_observations import PgPublicData
from rpc_config import configured_rpc_urls

PHASE = 'shadow'


def window(policy, now):
    """(first attempt, last attempt, selection time) for the UTC date of `now`."""
    at = int(datetime.fromtimestamp(now, timezone.utc).replace(
        hour=policy['selectionHourUtc'], minute=0, second=0, microsecond=0).timestamp())
    return at - policy['selectionLeadMinutes'] * 60, at - policy['selectionRetryUntilMinutes'] * 60, at


def tick(selector, store, policy, now):
    first, last, at = window(policy, now)
    if not first <= now < at:
        return {'status': 'idle', 'nextWindowAt': first if now < first else first + 86400}
    with store.selector_lock():
        return selector.select(now=now, phase=PHASE, final=now >= last)


def pin(store, policy, pool_id, slot, reason, until):
    if type(slot) is not int or not 1 <= slot <= policy['size']:
        raise DataError('invalid_featured_pin_slot')
    pool_id = bytes32(pool_id)
    active = [item for item in store.overrides(int(time.time()))['pins'] if item['poolId'] != pool_id]
    if len(active) >= policy['maxPins']:
        raise DataError('featured_pins_full')
    if any(item['slot'] == slot for item in active):
        raise DataError('featured_pin_slot_taken')
    return store.add_override('pin', pool_id, reason=reason, value={'slot': slot}, until=until)


def build(policy):
    config = load_config()
    catalogue = configured_writer_catalogue()
    if catalogue is None:
        raise DataError('catalogue_not_configured')
    store = FeaturedStore(catalogue)
    selector = Selector(store=store, catalogue=catalogue, policy=policy,
                        public_data=PgPublicData(catalogue, writer=True), rpc_urls=configured_rpc_urls(config))
    return store, selector


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    serve = commands.add_parser('serve', help='select once a day, inside the window')
    serve.add_argument('--period', type=float, default=60)
    select = commands.add_parser('select', help='run one selection now, as the last attempt of the day')
    select.add_argument('--now', type=int, default=None, help='the selection clock (UTC seconds); default now')
    commands.add_parser('status', help='the last runs and the latest list')
    for name in ('pin', 'unpin'):
        command = commands.add_parser(name)
        command.add_argument('--pool-id', required=True)
        if name == 'pin':
            command.add_argument('--slot', type=int, required=True)
            command.add_argument('--reason', required=True)
            command.add_argument('--until', type=int, default=None, help='UTC seconds')
    for name in ('exclude', 'unexclude'):
        command = commands.add_parser(name)
        target = command.add_mutually_exclusive_group(required=True)
        target.add_argument('--pool-id')
        target.add_argument('--token')
        if name == 'exclude':
            command.add_argument('--reason', required=True)
            command.add_argument('--until', type=int, default=None, help='UTC seconds')
    args = parser.parse_args(argv)
    policy = load_policy()
    try:
        store, selector = build(policy)
        if args.command == 'serve':
            if not 1 <= args.period <= 600:
                parser.error('period must be between 1 and 600 seconds')
            stopped = threading.Event()
            for signum in (signal.SIGTERM, signal.SIGINT):
                signal.signal(signum, lambda *_: stopped.set())
            while not stopped.is_set():
                try:
                    result = tick(selector, store, policy, int(time.time()))
                except DataError as error:
                    result = {'status': 'retry', 'reason': str(error)}
                if result.get('status') != 'idle':
                    print(json.dumps({'service': 'featured', 'phase': PHASE, **result}, default=str), flush=True)
                stopped.wait(args.period)
            return 0
        if args.command == 'select':
            with store.selector_lock():
                result = selector.select(now=args.now, phase=PHASE, final=True)
        elif args.command == 'status':
            result = store.status(PHASE)
        elif args.command == 'pin':
            result = {'override': pin(store, policy, args.pool_id, args.slot, args.reason, args.until)}
        elif args.command == 'unpin':
            result = {'revoked': store.revoke_override('pin', args.pool_id)}
        elif args.command == 'exclude':
            kind, subject = ('exclude_pool', args.pool_id) if args.pool_id else ('exclude_token', args.token)
            result = {'override': store.add_override(kind, subject, reason=args.reason, until=args.until)}
        else:
            kind, subject = ('exclude_pool', args.pool_id) if args.pool_id else ('exclude_token', args.token)
            result = {'revoked': store.revoke_override(kind, subject)}
    except DataError as error:
        print(json.dumps({'service': 'featured', 'command': args.command, 'status': 'refused',
                          'reason': str(error)}), flush=True)
        return 1
    print(json.dumps({'service': 'featured', 'command': args.command, **result}, default=str), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
