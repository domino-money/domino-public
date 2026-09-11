"""Bounded fee qualification of existing public activity; no signing or daemon."""
import argparse
import json
from pathlib import Path

from activity_store import PgActivity
from catalogue import configured_catalogue
from discovery import DataError, DiscoveryReader, ReadRpc, bytes32
from fee_store import FeeIndexer
from historical_capacity import PROFILES
from local_config import load_config
from pool_activity import ACTIVITY_CAPACITY_PROFILES
from read_service import bounded_transport


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id',required=True)
    parser.add_argument('--max-steps',type=int,default=5)
    parser.add_argument('--capacity-profile',choices=PROFILES,default='standard')
    parser.add_argument('--activity-capacity-profile',choices=ACTIVITY_CAPACITY_PROFILES,default='standard')
    parser.add_argument('--restart-unpublished-work',action='store_true',
                        help='Discard only unpublished fee work after source/method review; replay from its chunk start.')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        if not 1<=args.max_steps<=50 or args.output.exists():
            raise DataError('invalid_fee_bounds_or_output_exists')
        pool_id=bytes32(args.pool_id)
        catalogue=configured_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        url=load_config().get('rpcUrl')
        if not url:
            raise DataError('configured_rpc_required')
        # Validate deployment links and a fresh chain head once per invocation.
        DiscoveryReader(ReadRpc(url,transport=bounded_transport())).snapshot()
        store=PgActivity(catalogue)
        results=[]
        if args.restart_unpublished_work:
            result=FeeIndexer(store,ReadRpc(url,transport=bounded_transport(90),max_requests=60),
                              capacity=args.capacity_profile,activity_capacity=args.activity_capacity_profile).restart(pool_id)
            results.append(result);print(json.dumps(result),flush=True)
        for _ in range(args.max_steps):
            result=FeeIndexer(store,ReadRpc(url,transport=bounded_transport(90),max_requests=60),
                              capacity=args.capacity_profile,activity_capacity=args.activity_capacity_profile).step(pool_id)
            results.append(result);print(json.dumps(result),flush=True)
            if result['status']=='caught_up_to_activity':break
        report={'schemaVersion':1,'mode':'bounded_core_trading_fee_qualification',
                'chainId':4663,'poolId':pool_id,'activityCapacityProfile':args.activity_capacity_profile,'steps':results,'result':store.read(pool_id),'liveExecution':False}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report,stream,indent=2);stream.write('\n')
        return 0
    except DataError as error:
        print(json.dumps({'status':'fee_qualification_failed','reason':str(error),
                          'activityCapacityProfile':args.activity_capacity_profile,'previousCommittedProgressRetained':True}))
        return 1
    except (OSError,ValueError,TypeError,KeyError):
        print(json.dumps({'status':'fee_qualification_failed','reason':'local_operation_unavailable',
                          'activityCapacityProfile':args.activity_capacity_profile,'previousCommittedProgressRetained':True}))
        return 1


if __name__=='__main__':raise SystemExit(main())
