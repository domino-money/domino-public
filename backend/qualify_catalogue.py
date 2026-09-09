"""Bounded public catalogue HTTP check in both pair directions, without ID fallback."""
import argparse
import json
from pathlib import Path
import time

from discovery import CHAIN_ID, DataError, address, bytes32
from qualify_read_api import request


def qualify(port, token, paired_token, expected_pool_id):
    report={'schemaVersion':1,'mode':'catalogue_http_qualification','chainId':CHAIN_ID,
            'expectedPoolId':expected_pool_id,'explicitIdsSentToApi':False,
            'userWalletQueried':False,'liveExecution':False,'cases':[]}
    all_passed=True
    for selected,paired in [(token,paired_token),(paired_token,token)]:
        stored=request(port,'/v1/read/catalogue',{'token':selected,'pairedToken':paired,'limit':100})
        time.sleep(1.05)
        fresh=request(port,'/v1/read/pools',{'token':selected,'pairedToken':paired,'maxPools':20})
        stored_ids={pool['poolId'] for pool in stored['items']}
        fresh_ids={pool['poolId'] for pool in fresh['pools']}
        passed=(expected_pool_id in stored_ids and expected_pool_id in fresh_ids
                and stored['chainId']==CHAIN_ID and fresh['chainId']==CHAIN_ID
                and fresh['catalogue']['status']=='available' and not fresh['liveExecution']
                and all(pool['identityStatus']=='verified_at_block'
                        and not pool['executionAvailable'] and pool['feeApr24h'] is None
                        and selected in pool['currencies'] and paired in pool['currencies']
                        for pool in fresh['pools']))
        row={'token':selected,'pairedToken':paired,'storedCatalogue':stored,'snapshot':fresh['snapshot'],
             'discovery':fresh['discovery'],'catalogue':fresh['catalogue'],
             'pools':[{key:pool.get(key) for key in ('poolId','poolKey','currencies','identityStatus',
                      'catalogueSource','integrationClass','tokenMetadataStatus','executionAvailable')}
                      for pool in fresh['pools']],
             'unverifiedCandidates':fresh['unverifiedCandidates'],'checksPassed':passed}
        report['cases'].append(row)
        all_passed=all_passed and passed
        print(json.dumps({'token':selected,'storedPools':len(stored_ids),'verifiedPools':len(fresh_ids),
                          'expectedPoolFoundAutomatically':expected_pool_id in fresh_ids,'checksPassed':passed}),flush=True)
        time.sleep(1.05)
    report['checksPassed']=all_passed
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8876)
    parser.add_argument('--token',required=True)
    parser.add_argument('--paired-token',required=True)
    parser.add_argument('--expected-pool-id',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 1024<=args.port<=65535:parser.error('invalid port')
    try:
        report=qualify(args.port,address(args.token),address(args.paired_token),bytes32(args.expected_pool_id))
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report,stream,indent=2);stream.write('\n')
        return 0 if report['checksPassed'] else 1
    except DataError as error:
        print(json.dumps({'status':'catalogue_http_failed','reason':str(error)}))
        return 1


if __name__=='__main__': raise SystemExit(main())
