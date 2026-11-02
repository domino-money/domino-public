"""Featured pools (featured-policy v1): the daily selection service and the owner's overrides.

`serve` selects once per date in the window before `selectionHourUtc` (UTC).
Attempts before `selectionRetryUntilMinutes` may end `incomplete` (the
provider cut the listing short) and are retried; the last attempt keeps the
previous list instead.

The phase is the owner's (`phase --set shadow|live`, default shadow):
- shadow records the day's list for comparison and serves nothing (a list
  served while live gives way to `none`, since nothing checks its health);
- live also serves: the draft is published between the selection time and 30
  minutes after it, the served list is kept warm and repaired all day, and the
  mode chooses between the automatic list, the owner's manual list and none.
Overrides apply from the next tick or selection. One JSON line per invocation
or non-idle tick, as the lanes do.
"""
import argparse
import json
import signal
import threading
import time

from catalogue import configured_writer_catalogue
from discovery import DataError, bytes32
from featured_live import Live, window
from featured_pools import load_policy
from featured_selector import Selector
from featured_store import FeaturedStore
from local_config import load_config
from public_history import PublicHistory
from public_observations import PgPublicData
from rpc_config import configured_rpc_urls
from selected_pools import SELECTED_POOLS


def tick(selector, store, policy, now, live=None, clock=time.time):
    """One pass of the service: the day's selection in its window, then the live list."""
    overrides = store.overrides(now)
    phase, result = overrides['phase'], {}
    first, last, at = window(policy, now)
    with store.selector_lock():
        # The selection runs in every mode: persistence (E17b) needs each day's evaluation.
        if first <= now < at:
            result['selection'] = selector.select(now=now, phase=phase, final=now >= last)
            # A selection takes minutes (11:30:07 to 11:34:28 on 30 Oct 2026): the live list reads
            # the clock again, or what the collector wrote meanwhile is in its future.
            now = max(now, int(clock()))
        if phase == 'live' and live is not None:
            result['live'] = live.tick(now)
        elif live is not None:
            withdrawn = live.withdraw(now)
            if withdrawn is not None:
                result['live'] = withdrawn
    if not result:
        return {'status': 'idle', 'phase': phase, 'nextWindowAt': first if now < first else first + 86400}
    return {'phase': phase, **result}


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
    public = PgPublicData(catalogue, writer=True)
    selector = Selector(store=store, catalogue=catalogue, policy=policy, public_data=public,
                        rpc_urls=configured_rpc_urls(config))

    def rpc_factory():
        service, _ = selector._service()
        return service._rpc(service.transport_factory())
    live = Live(store=store, public=public, history=PublicHistory(catalogue, writer=True), catalogue=catalogue, policy=policy,
                selector=selector, rpc_factory=rpc_factory, embedded=SELECTED_POOLS)
    return store, selector, live


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    serve = commands.add_parser('serve', help='select once a day and, when live, serve and repair the list')
    serve.add_argument('--period', type=float, default=30)
    select = commands.add_parser('select', help='run one selection now, as the last attempt of the day')
    select.add_argument('--now', type=int, default=None, help='the selection clock (UTC seconds); default now')
    commands.add_parser('status', help='the last runs and the latest list')
    for name, choices in (('phase', ('shadow', 'live')), ('mode', ('auto', 'manual', 'off'))):
        command = commands.add_parser(name)
        command.add_argument('--set', required=True, choices=choices)
        command.add_argument('--reason', required=True)
    manual = commands.add_parser('manual', help="the owner's list, served while the mode is manual")
    manual.add_argument('--pools', required=True, help='comma-separated pool ids, in slot order')
    manual.add_argument('--reason', required=True)
    veto = commands.add_parser('veto', help='do not publish the selection of this UTC date')
    veto.add_argument('--date', required=True, help='YYYY-MM-DD')
    veto.add_argument('--reason', required=True)
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
        store, selector, live = build(policy)
        if args.command == 'serve':
            if not 1 <= args.period <= 600:
                parser.error('period must be between 1 and 600 seconds')
            stopped = threading.Event()
            for signum in (signal.SIGTERM, signal.SIGINT):
                signal.signal(signum, lambda *_: stopped.set())
            while not stopped.is_set():
                try:
                    result = tick(selector, store, policy, int(time.time()), live=live)
                except DataError as error:
                    result = {'status': 'retry', 'reason': str(error)}
                if result.get('status') != 'idle':
                    print(json.dumps({'service': 'featured', **result}, default=str), flush=True)
                stopped.wait(args.period)
            return 0
        if args.command == 'select':
            with store.selector_lock():
                phase = store.overrides(int(time.time()))['phase']
                result = selector.select(now=args.now, phase=phase, final=True)
        elif args.command == 'status':
            result = {'phase': store.overrides(int(time.time()))['phase'], 'shadow': store.status('shadow'),
                      'live': store.status('live')}
        elif args.command in ('phase', 'mode'):
            result = {'override': store.add_override(args.command, args.set, reason=args.reason)}
        elif args.command == 'manual':
            pools = [value.strip() for value in args.pools.split(',') if value.strip()]
            result = {'override': store.add_override('manual', 'manual', reason=args.reason,
                                                      value={'pools': pools})}
        elif args.command == 'veto':
            result = {'override': store.add_override('veto', args.date, reason=args.reason)}
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
