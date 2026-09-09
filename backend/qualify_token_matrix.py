"""Probe a public token matrix through the loopback API; never query a user wallet."""
import argparse
import json
from pathlib import Path
import time

from discovery import CHAIN_ID, ZERO, DataError, address, bytes32
from qualify_read_api import request


def validate_manifest(data):
    if not isinstance(data, dict) or data.get('chainId') != CHAIN_ID:
        raise DataError('invalid_matrix_chain')
    cases = data.get('cases')
    if not isinstance(cases, list) or not 1 <= len(cases) <= 12:
        raise DataError('invalid_matrix_cases')
    clean = []
    for case in cases:
        if not isinstance(case, dict):
            raise DataError('invalid_matrix_case')
        token = address(case.get('token'))
        label = case.get('label')
        if not isinstance(label, str) or not 1 <= len(label) <= 50 or not label.isprintable():
            raise DataError('invalid_matrix_label')
        pool_ids = case.get('poolIds', [])
        if not isinstance(pool_ids, list) or len(pool_ids) > 5:
            raise DataError('invalid_matrix_pool_ids')
        expected = case.get('expectedReadStatus', 'available')
        if expected not in {'available', 'partial', 'no_contract'}:
            raise DataError('invalid_matrix_expected_status')
        clean.append({'label': label, 'token': token, 'poolIds': [bytes32(p) for p in pool_ids],
                      'expectedReadStatus': expected})
    if len({c['token'] for c in clean}) != len(clean):
        raise DataError('duplicate_matrix_token')
    return clean


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('invalid port')
    try:
        cases = validate_manifest(json.loads(args.manifest.read_text()))
        report = {'schemaVersion': 1, 'mode': 'generic_token_http_qualification', 'chainId': CHAIN_ID,
                  'cases': [], 'batchBalanceChecks': [], 'userWalletQueried': False,
                  'amountsOmitted': True, 'liveExecution': False}
        checks_passed, unique_pools = True, set()
        for case in cases:
            row = dict(case)
            try:
                token = request(args.port, '/v1/read/token', {'token': case['token']})
                time.sleep(1.05)
                pools = request(args.port, '/v1/read/pools',
                                {'token': case['token'], 'maxPools': 5, 'poolIds': case['poolIds']})
                pool_ids = {pool['poolId'] for pool in pools['pools']}
                checked = (token['asset']['address'] == case['token'] and token['chainId'] == CHAIN_ID
                           and token['asset']['readStatus'] == case['expectedReadStatus']
                           and set(case['poolIds']).issubset(pool_ids) and not token['liveExecution']
                           and all(case['token'] in pool['currencies'] and not pool['executionAvailable']
                                   for pool in pools['pools']))
                row.update(asset=token['asset'], tokenSnapshot=token['snapshot'],
                           poolSnapshot=pools['snapshot'], discovery=pools['discovery'],
                           pools=[{key: pool[key] for key in ('poolId', 'currencies', 'poolKey',
                                  'identityStatus', 'integrationClass', 'tokenMetadataStatus', 'executionAvailable')}
                                  for pool in pools['pools']],
                           unverifiedCandidates=pools['unverifiedCandidates'], checksPassed=checked)
                unique_pools.update(pool_ids)
                checks_passed = checks_passed and checked
                print(json.dumps({'case': case['label'], 'tokenRead': token['asset']['readStatus'],
                                  'verifiedPools': len(pool_ids), 'checksPassed': checked}), flush=True)
            except DataError as error:
                row.update(status='unavailable', reason=str(error), checksPassed=False)
                checks_passed = False
                print(json.dumps({'case': case['label'], 'reason': str(error)}), flush=True)
            report['cases'].append(row)
            time.sleep(1.05)
        tokens = [case['token'] for case in cases if case['token'] != ZERO]
        for start in range(0, len(tokens), 10):
            result = request(args.port, '/v1/read/wallet-assets',
                             {'wallet': ZERO, 'tokens': tokens[start:start+10], 'autoDiscover': False})
            valid = all(isinstance(item['amountRaw'], str) and item['amountRaw'].isascii()
                        and item['amountRaw'].isdigit() and 0 <= int(item['amountRaw']) < 2**256
                        for item in result['items'])
            checks_passed = checks_passed and valid
            report['batchBalanceChecks'].append({'snapshot': result['snapshot'],
                'requestedAddresses': len(tokens[start:start+10]), 'assetsRead': len(result['items']),
                'unavailableAssets': result['unavailableAssets'], 'rawIntegerUnitsValid': valid,
                'inventoryStatus': result['inventory']['status']})
            time.sleep(1.05)
        report.update(checksPassed=checks_passed, uniqueVerifiedPools=len(unique_pools))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
        print(json.dumps({'status': 'matrix_complete', 'cases': len(cases),
                          'uniqueVerifiedPools': len(unique_pools), 'checksPassed': checks_passed}))
        return 0 if checks_passed else 1
    except DataError as error:
        print(json.dumps({'status': 'matrix_failed', 'reason': str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
