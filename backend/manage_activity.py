"""Explicit bounded per-pool activity indexing; no daemon or financial transaction.

`--pool-id <id> --status` reads persistent operator diagnostics without RPC or
provider configuration. Apply migration 013 first. A live-range block requires
explicit --capacity-profile extended to retry up to 10,000 live ranges; smaller
spans do not bypass either bound. No earlier event or qualified chunk is removed.
Stored status is not a canonicality/freshness check or a current financial value.
"""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path

from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import configured_catalogue
from catalogue_indexer import IndexRpc
from discovery import DataError, DiscoveryReader, ReadRpc, bytes32
from local_config import load_config
from pool_activity import ACTIVITY_CAPACITY_PROFILES
from read_service import bounded_transport


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id',required=True)
    parser.add_argument('--initialization-block',type=int)
    parser.add_argument('--through',type=int)
    parser.add_argument('--span',type=int,default=1000)
    parser.add_argument('--max-steps',type=int,default=5)
    parser.add_argument('--capacity-profile',choices=ACTIVITY_CAPACITY_PROFILES,default='standard')
    parser.add_argument('--status',action='store_true',
                        help='Read persisted operator status from PostgreSQL only; no RPC or current-data claim')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if not args.status and args.output is None:
        parser.error('--output is required unless --status is selected')
    try:
        if not 1<=args.span<=10000 or not 1<=args.max_steps<=50:
            raise DataError('invalid_activity_bounds')
        if args.output is not None and args.output.exists():
            raise DataError('output_already_exists')
        pool_id=bytes32(args.pool_id)
        catalogue=configured_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        store=PgActivity(catalogue)
        if args.status:
            report=store.operator_status(pool_id)
            print(json.dumps(report),flush=True)
            if args.output is not None:
                write_report(args.output,report)
            return 0
        url=os.environ.get('DOMINO_DISCOVERY_RPC_URL') or load_config().get('rpcUrl')
        if not url:
            raise DataError('configured_rpc_required')
        head=DiscoveryReader(ReadRpc(url,transport=bounded_transport())).snapshot()
        target=args.through if args.through is not None else head.number-200
        if not 1<=target<=head.number-200:
            raise DataError('activity_target_too_close_or_invalid')
        def worker():
            return ActivityIndexer(store,IndexRpc(url,transport=bounded_transport(90),max_requests=300),
                                   capacity=args.capacity_profile)
        worker().register(pool_id,args.initialization_block)
        results=[]
        for _ in range(args.max_steps):
            result=worker().step(pool_id,through=target,span=args.span)
            results.append(result);print(json.dumps(result),flush=True)
            if result['status']=='caught_up_to_target':break
        report={'schemaVersion':1,'mode':'bounded_core_pool_activity','chainId':4663,
                'headAtStart':asdict(head),'target':target,'poolId':pool_id,'steps':results,
                'activityCapacityProfile':args.capacity_profile,
                'result':store.read(pool_id),'liveExecution':False}
        write_report(args.output,report)
        return 0
    except DataError as error:
        print(json.dumps({'status':'activity_failed','reason':str(error),'activityCapacityProfile':args.capacity_profile,'previousCommittedProgressRetained':True}))
        return 1
    except (OSError,ValueError,TypeError,KeyError):
        print(json.dumps({'status':'activity_failed','reason':'local_operation_unavailable',
                          'activityCapacityProfile':args.capacity_profile,'previousCommittedProgressRetained':True}))
        return 1


def write_report(path,report):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as stream:
        json.dump(report,stream,indent=2);stream.write('\n')


if __name__=='__main__':raise SystemExit(main())
