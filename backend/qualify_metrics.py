"""Real loopback HTTP qualification with independently repeated NFT contract reads."""
import argparse
import json
from pathlib import Path
import time

from discovery import DataError, POSITION_MANAGER, ReadRpc, bytes32
from local_config import load_config
from rpc_config import configured_history_rpc_url
from nft_ownership import token_id
from qualify_read_api import request
from read_service import bounded_transport


def qualify(port, pool_ids, explicit_ids):
    report = {'schemaVersion': 1, 'mode': 'capital_metrics_nft_http_qualification',
              'cases': [], 'ownerAddressesAndTokenIdsOmitted': True, 'liveExecution': False}
    for pool_id in pool_ids:
        metrics = request(port, '/v1/read/pool-metrics', {'poolId': pool_id})
        time.sleep(1.05)
        response = request(port, '/v1/read/pool-positions', {'poolId': pool_id})
        time.sleep(1.05)
        positions = response['positionAccounting']
        ids = [p['nft']['tokenId'] for p in positions['items'] if p['nft'].get('nftOwnershipResolved')]
        nft_checks = []
        if ids:
            nfts = request(port, '/v1/read/nft-positions', {'tokenIds': ids[:10], 'blockNumber': response['snapshot']['number']})
            time.sleep(1.05)
            core = {p['corePositionId']: p for p in positions['items']}
            for nft in nfts['items']:
                original = core[nft['corePositionId']]
                nft_checks.append(all(nft[k] == original[k] for k in ('principalRaw','unsettledFeesRaw','liquidityRaw'))
                                  and nft['owner'] == original['nft']['owner'])
        capital = metrics['capital']
        conservation = all(int(capital['current']['lpAssetsRaw'][i]) == sum(int(capital['current'][k][i])
            for k in ('principalRaw','unsettledFeesRaw','roundingResidualRaw')) for i in (0,1))
        same = metrics['snapshot'] == response['snapshot'] and capital['current']['lpAssetsRaw'] == positions['lpAssetsRaw']
        passed = (same and conservation and all(nft_checks) and not metrics['executionAvailable'] and
                  metrics['coverage']['canonicality'] == 'block_hash_rechecked' and
                  not metrics['usableAsCurrent24h'] and metrics['valuation']['feeAprPercent'] is None)
        report['cases'].append({'poolId': pool_id, 'checksPassed': passed,
            'nftMappingsCompared': len(nft_checks), 'nftAmountsAndOwnerMatch': all(nft_checks), 'metrics': metrics})
        print(json.dumps({'poolId': pool_id, 'checksPassed': passed, 'nftMappingsCompared': len(nft_checks)}), flush=True)
    if explicit_ids:
        nfts = request(port, '/v1/read/nft-positions', {'tokenIds': explicit_ids})
        config = load_config()
        if not config:
            raise DataError('configured_rpc_required')
        rpc = ReadRpc(configured_history_rpc_url(config), transport=bounded_transport())
        checked = 0
        for nft in nfts['items']:
            if nft['nftOwnershipResolved']:
                owner, = rpc.call(POSITION_MANAGER, 'ownerOf(uint256)', ['uint256'], [token_id(nft['tokenId'])],
                                  ['address'], block=hex(nfts['snapshot']['number']))
                if owner.lower() != nft['owner']:
                    raise DataError('nft_http_owner_recheck_mismatch')
                checked += 1
        report['freshNftRead'] = {'snapshot': nfts['snapshot'], 'freshness': nfts['freshness'],
            'requestedCount': len(explicit_ids), 'verifiedOwnerCount': checked,
            'emptyPositionCount': len(explicit_ids)-checked, 'walletControlVerified': False}
    report['checksPassed'] = all(c['checksPassed'] for c in report['cases'])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--pool-id', action='append', required=True)
    parser.add_argument('--token-id', action='append', default=[])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if not 1024 <= args.port <= 65535 or not 1 <= len(args.pool_id) <= 3 or len(args.token_id) > 10 or args.output.exists():
            raise DataError('invalid_metrics_qualification_bounds')
        for value in args.token_id: token_id(value)
        result = qualify(args.port, [bytes32(p) for p in args.pool_id], args.token_id)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(result, stream, indent=2);stream.write('\n')
        return 0 if result['checksPassed'] else 1
    except DataError as error:
        print(json.dumps({'status': 'metrics_http_failed', 'reason': str(error)}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
