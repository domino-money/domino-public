"""Bounded local HTTP smoke test; report omits wallet, balances and credentials."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

from discovery import CHAIN_ID, RPC_URL, DataError, DiscoveryReader, ReadRpc
from local_config import load_config


def request(port, path, body=None):
    req = urllib.request.Request('http://127.0.0.1:' + str(port) + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=75) as response:
            data = json.load(response)
            if response.headers.get('Cache-Control') != 'no-store':
                raise DataError('missing_no_store_header')
            return data
    except urllib.error.HTTPError as error:
        raise DataError('local_api_http_' + str(error.code)) from None
    except (OSError, ValueError):
        raise DataError('local_api_unavailable') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--position-id', type=int, required=True)
    parser.add_argument('--token', action='append', default=[])
    parser.add_argument('--pool-token')
    parser.add_argument('--max-pages', type=int, default=3)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 5 or not 1024 <= args.port <= 65535:
        parser.error('invalid port or page limit')
    try:
        capabilities = request(args.port, '/v1/capabilities')
        if capabilities['chainId'] != CHAIN_ID or capabilities['automation'] or capabilities['feeCollection']:
            raise DataError('unexpected_api_capabilities')
        config = load_config()
        reader = DiscoveryReader(ReadRpc(os.environ.get('DOMINO_DISCOVERY_RPC_URL') or config.get('rpcUrl', RPC_URL)))
        block = reader.snapshot()
        owner = reader.position_owner(args.position_id, block)
        reader.assert_canonical(block)
        report = {'schemaVersion': 1, 'mode': 'local_http_read_qualification', 'chainId': CHAIN_ID,
                  'capabilities': capabilities, 'pages': [], 'walletIdentityAndAmountsOmitted': True}
        seen_cursors, seen_currencies, cursor = set(), set(), None
        for _ in range(args.max_pages):
            body = {'wallet': owner, 'tokens': args.token, 'autoDiscover': True, 'cursor': cursor}
            result = request(args.port, '/v1/read/wallet-assets', body)
            for asset in result['items']:
                raw = asset['amountRaw']
                if not isinstance(raw, str) or not raw.isascii() or not raw.isdigit() or not 0 <= int(raw) < 2**256:
                    raise DataError('invalid_balance_units')
                seen_currencies.add(asset['address'])
            inventory = result['inventory']
            report['pages'].append({'snapshot': result['snapshot'], 'assetsRead': len(result['items']),
                'unavailableAssets': len(result['unavailableAssets']), 'inventoryStatus': inventory['status'],
                'inventoryReason': inventory.get('reason'), 'providerRows': inventory.get('rowsReceived'),
                'excludedRows': inventory.get('excludedRows'), 'hasMore': inventory['hasMore'],
                'balanceCoverage': result['balanceCoverage']})
            cursor = inventory['nextCursor']
            if not cursor:
                break
            if cursor in seen_cursors:
                raise DataError('repeated_api_cursor')
            seen_cursors.add(cursor)
            time.sleep(1.05)  # Respect the local API's one-start-per-second limit.
        report['uniqueCurrenciesRead'] = len(seen_currencies)
        report['pageLimitReached'] = cursor is not None
        if args.pool_token:
            time.sleep(1.05)
            pools = request(args.port, '/v1/read/pools', {'token': args.pool_token, 'maxPools': 20})
            report['poolProbe'] = {'snapshot': pools['snapshot'], 'discovery': pools['discovery'],
                'verifiedPools': len(pools['pools']), 'unverifiedCandidates': len(pools['unverifiedCandidates']),
                'metricsQualified': pools['metricsQualified'], 'liveExecution': pools['liveExecution']}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
        print(json.dumps(report))
        return 0
    except DataError as error:
        print(json.dumps({'status': 'qualification_failed', 'reason': str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
