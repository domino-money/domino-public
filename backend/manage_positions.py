"""Explicit bounded qualification of public core positions. No signing or daemon."""
import argparse
import json
from pathlib import Path

from activity_store import PgActivity
from catalogue import configured_catalogue
from discovery import DataError, DiscoveryReader, ReadRpc, bytes32
from local_config import load_config
from historical_capacity import PROFILES
from position_store import PositionIndexer
from read_service import bounded_transport


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id',required=True)
    parser.add_argument('--max-steps',type=int,default=5)
    parser.add_argument('--capacity-profile',choices=PROFILES,default='standard')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        if not 1<=args.max_steps<=50 or args.output.exists():
            raise DataError('invalid_position_bounds_or_output_exists')
        pool_id=bytes32(args.pool_id);catalogue=configured_catalogue()
        if catalogue is None:raise DataError('catalogue_not_configured')
        url=load_config().get('rpcUrl')
        if not url:raise DataError('configured_rpc_required')
        DiscoveryReader(ReadRpc(url,transport=bounded_transport())).snapshot()
        store=PgActivity(catalogue);results=[]
        for _ in range(args.max_steps):
            result=PositionIndexer(store,ReadRpc(url,transport=bounded_transport(90),max_requests=160),
                                   capacity=args.capacity_profile).step(pool_id)
            results.append(result);print(json.dumps(result),flush=True)
            if result['status']=='caught_up_to_activity':break
        report={'schemaVersion':1,'mode':'bounded_core_position_qualification','chainId':4663,
                'poolId':pool_id,'steps':results,'result':store.read(pool_id),'liveExecution':False}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as stream:json.dump(report,stream,indent=2);stream.write('\n')
        return 0
    except DataError as error:
        print(json.dumps({'status':'position_qualification_failed','reason':str(error),'previousCommittedProgressRetained':True}))
        return 1
    except (OSError,ValueError,TypeError,KeyError):
        print(json.dumps({'status':'position_qualification_failed','reason':'local_operation_unavailable',
                          'previousCommittedProgressRetained':True}))
        return 1


if __name__=='__main__':raise SystemExit(main())
