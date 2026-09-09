"""Bounded HTTP check of indexed pool activity; no user-wallet lookup."""
import argparse
import json
from pathlib import Path
import time

from discovery import CHAIN_ID, DataError, bytes32
from qualify_read_api import request


def qualify(port,pool_ids,*,require_fees=False):
    report={'schemaVersion':1,'mode':'pool_activity_http_qualification','chainId':CHAIN_ID,
            'userWalletQueried':False,'liveExecution':False,'requireReconciledFees':require_fees,'cases':[]}
    for pool_id in pool_ids:
        result=request(port,'/v1/read/pool-activity',{'poolId':pool_id})
        window=result['window24h'];liquidity=result['liquidity']
        quantities=[leg[key] for leg in window['swapLegsRaw'] for key in ['grossInput','output','absoluteTurnover']]
        quantities+=window['donations']['amountsRaw']+[liquidity['activeLiquidityRaw']]
        accounting=result['fees'].get('accounting',{})
        fees_present=window['lpFeesRaw'] is not None
        if fees_present:
            quantities+=window['lpFeesRaw']+window['protocolFeesRaw']
        fees_ok=(accounting.get('status')=='reconciled_as_of' and accounting.get('feeGrowthReconciled') is True
                 and accounting.get('isDominoServiceFee') is False) if fees_present else not require_fees
        exact=all(isinstance(value,str) and value.isascii() and value.isdigit() for value in quantities)
        passed=(result['chainId']==CHAIN_ID and result['poolId']==pool_id and exact
                and result['coverage']['canonicality']=='block_hash_rechecked'
                and not result['executionAvailable'] and not result['suggested']
                and window['volumeUsd'] is None and fees_ok
                and window['feeApr'] is None and liquidity['tvlUsd'] is None
                and liquidity['status']=='core_active_liquidity_reconciled'
                and (not window['usableAsCurrent24h'] or
                     (window['completeWindow'] and result['freshness']['status']=='fresh')))
        report['cases'].append({'poolId':pool_id,'response':result,'checksPassed':passed})
        print(json.dumps({'poolId':pool_id,'swapEvents':window['swapEventCount'],
                          'observedSeconds':window['observedSeconds'],'full24h':window['completeWindow'],
                          'freshness':result['freshness']['status'],'checksPassed':passed}),flush=True)
        time.sleep(1.05)
    report['checksPassed']=all(row['checksPassed'] for row in report['cases'])
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8876)
    parser.add_argument('--pool-id',action='append',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--require-fees',action='store_true')
    args=parser.parse_args()
    if not 1024<=args.port<=65535 or not 1<=len(args.pool_id)<=3:
        parser.error('invalid port or pool count')
    try:
        report=qualify(args.port,[bytes32(value) for value in args.pool_id],require_fees=args.require_fees)
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report,stream,indent=2);stream.write('\n')
        return 0 if report['checksPassed'] else 1
    except DataError as error:
        print(json.dumps({'status':'activity_http_failed','reason':str(error)}))
        return 1


if __name__=='__main__':raise SystemExit(main())
