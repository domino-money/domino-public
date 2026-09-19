"""Bounded catalogue work: seed, index, follow and reset; no transaction submission."""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import signal

from discovery import Block, DataError, DiscoveryReader, POOL_MANAGER, ReadRpc, bytes32, address
from local_config import load_config
from rpc_config import configured_history_rpc_url, configured_rpc_urls
from catalogue import configured_writer_catalogue, checked_key
from catalogue_indexer import (INITIALIZE_TOPIC, CatalogueIndexer, IndexRpc, decode_initialize,
                                initialize_identity)
from followers import follow
from indexer_io import MAX_INDEXER_SPAN, AdaptiveSpan, indexer_transport, read_headers
from selected_pools import SELECTED_POOLS


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


def requested_pool_candidates(pool_ids, selected=False):
    """Unverified candidates: the complete key is read on chain before storage.

    A pool id alone is enough to seed because `DiscoveryReader.pool` resolves the
    bytes25 cache key and then proves the full 32-byte identity, the manager, the
    current fee and the price slot at one canonical block.
    """
    requested=[]
    for pool_id in pool_ids:
        value=bytes32(pool_id)
        if value not in requested: requested.append(value)
    if selected:
        requested += [pool_id for pool_id in SELECTED_POOLS if pool_id not in requested]
    return requested, [{'poolId':pool_id,'poolKey':None,'currencies':None,'providerMetrics':None}
                       for pool_id in requested]


def anchor_candidate(url,pool_id,anchor_block,*,rpc=None):
    """Kept for the CLI and its tests; the identity proof lives in the indexer."""
    return initialize_identity(url,pool_id,anchor_block,rpc=rpc)


def observed_head(url):
    """Verified head snapshot: chain identity and freshness, not just a number."""
    return asdict(DiscoveryReader(ReadRpc(url,transport=indexer_transport(60))).snapshot())


def coverage(catalogue):
    with catalogue.connection() as conn:
        return catalogue.coverage(catalogue.state(conn))


class StopRequests:
    """SIGTERM/SIGINT flag; a follower stops at a pass boundary, never mid-write."""
    def __init__(self):
        self.requested=False
    def handle(self,signum,frame):
        self.requested=True
    def __call__(self):
        return self.requested


def write_report(path,report):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as stream:
        json.dump(report,stream,indent=2);stream.write('\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    seed=sub.add_parser('seed')
    seed.add_argument('--report',type=Path)
    seed.add_argument('--pool-id',action='append',default=[],dest='pool_ids',
                      help='repeatable; the pool key is read and verified on chain')
    seed.add_argument('--selected',action='store_true',
                      help='also seed every pool in backend/selected_pools.py')
    seed.add_argument('--anchor-block',type=int,
                      help='one --pool-id: take the identity from its Initialize log at this block')
    lookup=sub.add_parser('lookup');lookup.add_argument('--token',required=True)
    index=sub.add_parser('index')
    index.add_argument('--start-block',type=int)
    index.add_argument('--through',type=int)
    index.add_argument('--span',type=int,default=1000)
    index.add_argument('--lag',type=int,default=200)
    index.add_argument('--max-steps',type=int,default=5)
    index.add_argument('--output',type=Path,required=True)
    run=sub.add_parser('follow')
    run.add_argument('--start-block',type=int)
    run.add_argument('--span',type=int,default=1000)
    run.add_argument('--span-floor',type=int,default=1000)
    run.add_argument('--span-ceiling',type=int,default=MAX_INDEXER_SPAN)
    run.add_argument('--lag',type=int,default=200,
                     help='index only to head-lag; the reorg window stays uncommitted')
    run.add_argument('--max-passes',type=int,default=1,
                     help='0 runs until SIGTERM/SIGINT or --max-seconds')
    run.add_argument('--poll-seconds',type=float,default=5.0)
    run.add_argument('--max-seconds',type=float)
    run.add_argument('--max-consecutive-failures',type=int,default=5)
    # No header budget here: the catalogue reads its chunk boundaries and the
    # anchor block, never one header per event.
    run.add_argument('--output',type=Path)
    reset=sub.add_parser('reset')
    reset.add_argument('--start-block',type=int,required=True)
    reset.add_argument('--confirm',action='store_true',
                       help='required: drops every stored chunk, event and seed hint')
    args=parser.parse_args()
    try:
        catalogue=configured_writer_catalogue()
        if not catalogue:raise DataError('catalogue_not_configured')
        config=load_config()
        override=os.environ.get('DOMINO_DISCOVERY_RPC_URL')
        if not config and not override:raise DataError('configured_rpc_required')
        # Catalogue chunks verify contract code at their historical end block.
        # Keep a v3 archive route isolated from a current-read environment override.
        current_url=configured_rpc_urls(config,override)[0]
        url=(configured_history_rpc_url(config) if config.get('version')==3 or not override
             else current_url)
        if args.action=='seed':url=current_url
        if args.action=='lookup':
            print(json.dumps(catalogue.lookup(address(args.token))));return 0
        if args.action=='seed':
            candidates=seed_candidates(args.report) if args.report is not None else []
            requested,from_ids=requested_pool_candidates(args.pool_ids,selected=args.selected)
            if not candidates and not from_ids:
                raise DataError('invalid_seed_report')
            if args.anchor_block is not None:
                if len(requested)!=1 or candidates:
                    raise DataError('anchor_block_needs_one_pool_id')
                candidate,anchor=anchor_candidate(url,requested[0],args.anchor_block)
                catalogue.seed([candidate],anchor)
                print(json.dumps({'status':'seeded_initialize_identity','pools':1,'poolIds':requested,
                                  'anchor':{'number':anchor.number,'hash':anchor.hash},
                                  'identitySource':'initialize_log'}))
                return 0
            candidates=[*candidates,*from_ids]
            if len(candidates)>100:raise DataError('too_many_seed_pools')
            reader=DiscoveryReader(ReadRpc(url,transport=indexer_transport(90),max_requests=160))
            block=reader.snapshot()
            pools=[reader.pool(candidate,block) for candidate in candidates]
            reader.assert_canonical(block)
            catalogue.seed(pools,block)
            print(json.dumps({'status':'seeded_verified_observations','pools':len(pools),'poolIds':requested,
                              'snapshot':asdict(block)}))
            return 0
        def worker():
            return CatalogueIndexer(catalogue,IndexRpc(url,transport=indexer_transport(90),max_requests=20_000))
        if args.action=='reset':
            if not args.confirm:
                raise DataError('catalogue_reset_requires_confirmation')
            if args.start_block<1:
                raise DataError('invalid_catalogue_start')
            result=worker().reset(args.start_block)
            print(json.dumps({**result,'chainId':4663,'coverage':coverage(catalogue)}))
            return 0
        if not 1<=args.span<=MAX_INDEXER_SPAN or args.lag<0:
            raise DataError('invalid_indexer_bounds')
        if args.action=='index':
            if not 1<=args.max_steps<=50:raise DataError('invalid_indexer_bounds')
            head=observed_head(url)
            target=args.through if args.through is not None else head['number']-args.lag
            if target>head['number']-args.lag or target<1:raise DataError('index_target_too_close_or_invalid')
            if args.start_block is not None:worker().start(args.start_block)
            results=[]
            for _ in range(args.max_steps):
                result=worker().step(through=target,span=args.span)
                results.append(result);print(json.dumps(result),flush=True)
                if result['status']=='caught_up_to_target':break
            write_report(args.output,{'schemaVersion':1,'mode':'bounded_initialize_index','chainId':4663,
                          'headAtStart':head,'target':target,'steps':results,'completeHistory':False,
                          'liveExecution':False})
            return 0
        if args.max_passes<0 or args.poll_seconds<0 or args.max_consecutive_failures<1:
            raise DataError('invalid_follow_bounds')
        if args.max_passes==0 and args.max_seconds is None:
            raise DataError('unbounded_follow_needs_a_stop')
        if not 1<=args.span_floor<=args.span<=args.span_ceiling<=MAX_INDEXER_SPAN:
            raise DataError('invalid_span_bounds')
        if args.start_block is not None:worker().start(args.start_block)
        span=AdaptiveSpan(args.span,floor=args.span_floor,ceiling=args.span_ceiling)
        def step(*,through):
            # A rejected range is retried inside the same pass with the smaller
            # span: with one pass per timer tick, waiting for the next tick would
            # never use a span the provider just told us to take.
            for attempt in range(3):
                try:
                    result=worker().step(through=through,span=span.next_span())
                except (DataError,OSError) as error:
                    reason=str(error);span.record(reason)
                    if reason in AdaptiveSpan.SHRINK_REASONS and attempt<2:
                        continue
                    raise
                span.record(None)
                return result
        stop=StopRequests()
        signal.signal(signal.SIGTERM,stop.handle)
        signal.signal(signal.SIGINT,stop.handle)
        summary=follow(step,
                       lambda: observed_head(url),
                       lag=args.lag,max_passes=args.max_passes,poll_seconds=args.poll_seconds,
                       max_seconds=args.max_seconds,
                       max_consecutive_failures=args.max_consecutive_failures,
                       should_stop=stop,on_pass=lambda step: print(json.dumps(step),flush=True))
        report={'schemaVersion':1,'mode':'catalogue_follower','chainId':4663,'span':args.span,
                'spanRuntime':span.as_dict(),'follow':summary,'coverage':coverage(catalogue),
                'liveExecution':False}
        if args.output is not None:write_report(args.output,report)
        else:print(json.dumps(report))
        return 0
    except DataError as error:
        # The reason matters to an operator: a provider hiccup, a lock held by
        # another writer and a malformed argument are different next steps.
        print(json.dumps({'status':'catalogue_failed','reason':str(error),
                          'previousCommittedProgressRetained':True}))
        return 1
    except (ValueError,KeyError,TypeError,OSError):
        print(json.dumps({'status':'catalogue_failed','reason':'local_operation_unavailable',
                          'previousCommittedProgressRetained':True}))
        return 1


if __name__=='__main__':
    raise SystemExit(main())
