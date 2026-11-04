"""Featured pools on Base and Arbitrum One, in shadow: the daily selection and its list's health (launch round P3).

`tick` is one pass of domino-featured-chain@<profile>.service, which its timer starts every minute:
- the chain's selection, in the half hour before its policy's selectionHourUtc, each minute until one completes
  (the last attempt, from selectionRetryUntilMinutes before that hour, keeps the previous list). Base selects
  09:30-10:00 UTC and Arbitrum One 10:30-11:00, both clear of Robinhood's 11:30-12:30 (manage_featured.py), so the
  three never list at once on the house's one GeckoTerminal allowance;
- in the first minute of every ten, the health of the chain's latest shadow list (one /pools/multi call and one
  Multicall3 call), and once an hour its tokens' code.
Nothing is published or served: read-v5 answers Robinhood's list alone until it takes a chain. The owner's pins and
exclusions apply from the next selection. One JSON line per invocation or non-idle tick, as manage_featured.py's.
"""
import argparse
import json
import time

from catalogue import configured_writer_catalogue
from discovery import DataError
from featured_chain_selector import HEALTH_SECONDS, PHASE, TOKEN_CHECK_SECONDS, ChainSelector
from featured_chains import CHAINS, load_chain_policy
from featured_live import window
from featured_store import FeaturedStore
from manage_featured import pin
from public_observations import PgPublicData
from v2_rpc import configured_endpoints, load_chain_rpc_config

# The timer's period: a selection attempt each minute in the window, a health check in the first minute of ten.
TICK_SECONDS = 60


def tick(selector, store, policy, now, clock=time.time):
    """One pass: the day's selection in its window, then the list's health when its minute has come."""
    first, last, at = window(policy, now)
    result = {}
    with store.selector_lock():
        if first <= now < at:
            selection = selector.select(now=now, final=now >= last)
            if selection['outcome'] != 'already_done':
                result['selection'] = selection
            # A selection takes minutes: the health check reads the clock again.
            now = max(now, int(clock()))
        if now % HEALTH_SECONDS < TICK_SECONDS:
            result['health'] = selector.health(now, tokens=now % TOKEN_CHECK_SECONDS < TICK_SECONDS)
    if not result:
        return {'status': 'idle', 'chainId': store.chain_id, 'phase': PHASE}
    return {'chainId': store.chain_id, 'phase': PHASE, **result}


def build(key, chain_rpc_file=None):
    """The chain's policy, store and selector. The chain RPC file is the writer's private V2 file
    (v2_rpc.load_chain_rpc_config); without it nothing reads the chain."""
    policy, chain = load_chain_policy(key)
    catalogue = configured_writer_catalogue()
    if catalogue is None:
        raise DataError('catalogue_not_configured')
    endpoints = None
    if chain_rpc_file is not None:
        endpoints = configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(chain_rpc_file))
    store = FeaturedStore(catalogue, chain.chainId)
    selector = ChainSelector(store=store, policy=policy, chain=chain, endpoints=endpoints,
                             public_data=PgPublicData(catalogue, writer=True))
    return policy, store, selector


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chain', required=True, choices=CHAINS, help='the chain profile, e.g. base-8453')
    parser.add_argument('--chain-rpc-file', help="the writer's private V2 chain RPC file (backend/v2_rpc.py)")
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('tick', help="one pass of the unit: the selection in its window, the list's health")
    select = commands.add_parser('select', help='run one selection now, as the last attempt of the day')
    select.add_argument('--now', type=int, default=None, help='the selection clock (UTC seconds); default now')
    commands.add_parser('health', help="check the latest shadow list's health now, its tokens' code included")
    commands.add_parser('status', help='the last runs and the latest shadow list')
    for name in ('pin', 'unpin'):
        command = commands.add_parser(name)
        command.add_argument('--pool-id', required=True, help='a v4 pool id or a v3 pool address')
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
    try:
        policy, store, selector = build(args.chain, args.chain_rpc_file)
        if args.command == 'tick':
            result = tick(selector, store, policy, int(time.time()))
            if result.get('status') != 'idle':
                print(json.dumps({'service': 'featured-chain', **result}, default=str), flush=True)
            return 0
        if args.command == 'select':
            with store.selector_lock():
                result = selector.select(now=args.now, final=True)
        elif args.command == 'health':
            with store.selector_lock():
                result = selector.health(int(time.time()), tokens=True)
        elif args.command == 'status':
            result = {'chainId': store.chain_id, PHASE: store.status(PHASE)}
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
        print(json.dumps({'service': 'featured-chain', 'chain': args.chain, 'command': args.command,
                          'status': 'refused', 'reason': str(error)}), flush=True)
        return 1
    print(json.dumps({'service': 'featured-chain', 'chain': args.chain, 'command': args.command, **result},
                     default=str), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
