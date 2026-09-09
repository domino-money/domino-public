"""Bounded HTTP qualification of core-position amounts, without wallet lookups."""
import argparse
import copy
import json
from pathlib import Path
import time

from discovery import CHAIN_ID,DataError,bytes32
from qualify_read_api import request


def qualify(port,pool_ids):
    report={'schemaVersion':1,'mode':'core_position_http_qualification','chainId':CHAIN_ID,
            'userWalletQueried':False,'liveExecution':False,'cases':[]}
    for pool_id in pool_ids:
        response=request(port,'/v1/read/pool-positions',{'poolId':pool_id})
        accounting=response['positionAccounting'];items=accounting['items']
        names=('lpAssetsRaw','principalRaw','unsettledFeesRaw','roundingResidualRaw','settledFeesRaw',
               'principalDepositedRaw','principalWithdrawnRaw')
        quantities=[value for name in names for value in accounting[name]]
        quantities += [value for item in items for name in ('principalRaw','unsettledFeesRaw','settledFeesRaw') for value in item[name]]
        exact=all(isinstance(v,str) and v.isascii() and v.isdigit() for v in quantities)
        sums=all(sum(int(p[name][i]) for p in items)==int(accounting[name][i])
                 for name in ('principalRaw','unsettledFeesRaw','settledFeesRaw') for i in (0,1))
        conserved=all(int(accounting['lpAssetsRaw'][i])==sum(int(accounting[k][i])
                      for k in ('principalRaw','unsettledFeesRaw','roundingResidualRaw')) for i in (0,1))
        passed=(response['chainId']==CHAIN_ID and response['poolId']==pool_id and exact and sums and conserved
                and response['coverage']['canonicality']=='block_hash_rechecked'
                and accounting['status']=='reconciled_as_of' and accounting['corePositionCount']==len(items)
                and accounting['onchainReconciliation']['corePositions']==len(items)
                and accounting['onchainReconciliation']['blockHash']==response['snapshot']['hash']
                and accounting['tvlUsd'] is None and not response['executionAvailable']
                and not accounting['isWalletBalance'] and not accounting['isWithdrawalQuote']
                and accounting['nftOwnershipScope']=='historical_snapshot_not_current_wallet_authentication')
        # The API can return public core identities; qualification artifacts need only aggregate evidence.
        saved=copy.deepcopy(response);saved['positionAccounting'].pop('items')
        report['cases'].append({'poolId':pool_id,'checksPassed':passed,'positionsChecked':len(items),
                                'individualCoreIdentitiesOmitted':True,'response':saved})
        print(json.dumps({'poolId':pool_id,'positionsChecked':len(items),'freshness':response['freshness']['status'],
                          'conservationPassed':conserved,'checksPassed':passed}),flush=True)
        time.sleep(1.05)
    report['checksPassed']=all(c['checksPassed'] for c in report['cases'])
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8876)
    parser.add_argument('--pool-id',action='append',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 1024<=args.port<=65535 or not 1<=len(args.pool_id)<=3:
        parser.error('invalid port or pool count')
    try:
        if args.output.exists():raise DataError('output_already_exists')
        result=qualify(args.port,[bytes32(p) for p in args.pool_id])
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
        return 0 if result['checksPassed'] else 1
    except DataError as error:
        print(json.dumps({'status':'position_http_failed','reason':str(error)}));return 1


if __name__=='__main__':raise SystemExit(main())
