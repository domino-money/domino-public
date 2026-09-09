"""Run an explicit, bounded data probe. No daemon, signing or personal config."""
import argparse
import json
import os
from pathlib import Path

from discovery import DataError, ReadRpc, RPC_URL, discover


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--token', required=True, help='Robinhood token contract, or native zero address')
    parser.add_argument('--max-pools', type=int, default=12)
    identity = parser.add_mutually_exclusive_group()
    identity.add_argument('--wallet', help='Optional address for the balance-read qualification')
    identity.add_argument('--position-id', type=int, help='Read the current NFT owner for the optional balance probe')
    parser.add_argument('--probe-inventory', action='store_true', help='Probe one Blockscout ERC-20 inventory page')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.probe_inventory and not (args.wallet or args.position_id):
        parser.error('--probe-inventory requires --wallet or --position-id')
    # Only this dedicated variable; never read the personal bot's configuration.
    rpc = ReadRpc(os.environ.get('DOMINO_DISCOVERY_RPC_URL', RPC_URL))
    try:
        report = discover(args.token, rpc=rpc, max_pools=args.max_pools, wallet=args.wallet,
                          position_id=args.position_id, probe_inventory=args.probe_inventory)
    except DataError as error:
        print(json.dumps({'status': 'unavailable', 'reason': str(error)}))
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Every run is a new artifact, not an overwrite of previously valid evidence.
    with args.output.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    print(json.dumps({'status': 'read_only_probe_complete',
                      'verifiedPools': len(report['pools']),
                      'unverifiedCandidates': len(report['unverifiedCandidates']),
                      'metricsQualified': False,
                      'walletInventory': report['walletInventory']['status']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
