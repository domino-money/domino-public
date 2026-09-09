"""Explicit bounded catalogue work; no polling daemon or transaction submission."""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path

from discovery import DataError, DiscoveryReader, ReadRpc, parse_block, address
from local_config import load_config
from catalogue import configured_catalogue, checked_key
from catalogue_indexer import CatalogueIndexer,IndexRpc
from read_service import bounded_transport


def seed_candidates(path):
    with path.open() as stream: raw=stream.read(2_000_001)
    if len(raw)>2_000_000:raise DataError('seed_report_too_large')
    data=json.loads(raw)
    if not isinstance(data,dict) or data.get('chainId')!=4663:
        raise DataError('invalid_seed_report')
    pools=data.get('pools',[])
    if 'cases' in data:
        if not isinstance(data['cases'],list):raise DataError('invalid_seed_report')
        pools=[pool for case in data['cases'] for pool in case.get('pools',[])]
    if not isinstance(pools,list) or not 1<=len(pools)<=200:
        raise DataError('invalid_seed_report')
    unique={}
    for pool in pools:
        key=checked_key(pool['poolKey'],pool['poolId'])
        unique[pool['poolId']]={'poolId':pool['poolId'],'poolKey':asdict(key),
                              'currencies':[key.currency0,key.currency1],'providerMetrics':None}
    if len(unique)>100:raise DataError('too_many_seed_pools')
    return list(unique.values())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    seed=sub.add_parser('seed');seed.add_argument('--report',type=Path,required=True)
    index=sub.add_parser('index')
    index.add_argument('--start-block',type=int)
    index.add_argument('--through',type=int)
    index.add_argument('--span',type=int,default=1000)
    index.add_argument('--max-steps',type=int,default=5)
    index.add_argument('--output',type=Path,required=True)
    status=sub.add_parser('lookup');status.add_argument('--token',required=True)
    args=parser.parse_args()
    try:
        catalogue=configured_catalogue()
        if not catalogue:raise DataError('catalogue_not_configured')
        url=os.environ.get('DOMINO_DISCOVERY_RPC_URL') or load_config().get('rpcUrl')
        if not url:raise DataError('configured_rpc_required')
        if args.action=='lookup':
            page=catalogue.lookup(address(args.token))
            print(json.dumps(page));return 0
        if args.action=='seed':
            candidates=seed_candidates(args.report)
            reader=DiscoveryReader(ReadRpc(url,transport=bounded_transport(90),max_requests=160))
            block=reader.snapshot()
            pools=[reader.pool(candidate,block) for candidate in candidates]
            reader.assert_canonical(block)
            catalogue.seed(pools,block)
            print(json.dumps({'status':'seeded_verified_observations','pools':len(pools),'snapshot':asdict(block)}))
            return 0
        if not 1<=args.max_steps<=50 or not 1<=args.span<=1000:
            raise DataError('invalid_indexer_bounds')
        def worker():
            return CatalogueIndexer(catalogue,IndexRpc(url,transport=bounded_transport(90),max_requests=300))
        head=DiscoveryReader(ReadRpc(url,transport=bounded_transport())).snapshot()
        target=args.through if args.through is not None else head.number-200
        if target>head.number-200 or target<1:raise DataError('index_target_too_close_or_invalid')
        if args.start_block is not None:worker().start(args.start_block)
        results=[]
        for _ in range(args.max_steps):
            result=worker().step(through=target,span=args.span)
            results.append(result);print(json.dumps(result),flush=True)
            if result['status']=='caught_up_to_target':break
        report={'schemaVersion':1,'mode':'bounded_initialize_index','chainId':4663,
                'headAtStart':asdict(head),'target':target,'steps':results,'completeHistory':False,'liveExecution':False}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x') as stream:json.dump(report,stream,indent=2);stream.write('\n')
        return 0
    except (DataError,ValueError,KeyError,TypeError,OSError):
        print('Catalogue operation unavailable; no unverified chunk was committed.')
        return 1


if __name__=='__main__':
    raise SystemExit(main())
