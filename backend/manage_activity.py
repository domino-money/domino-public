"""Bounded per-pool activity work: register, index, follow and status.

No financial transaction is ever submitted. `--status` reads persistent
operator diagnostics without RPC or provider configuration; apply migration 013
first. A live-range block requires an explicit `--capacity-profile extended` to
retry up to 10,000 live ranges; smaller spans do not bypass either bound. No
earlier event or qualified chunk is removed. Stored status is not a
canonicality/freshness check or a current financial value.

Registration needs a verified Initialize anchor: either the catalogue already
holds the pool's Initialize event, or `--initialization-anchor POOLID=BLOCK`
supplies the block of a pool the catalogue only knows as a seeded hint.
`--follow` keeps the stored head `--lag` blocks behind the chain head; the
pool-activity read calls coverage older than 120 s stale, so the default lag is
100 blocks on a one-second chain.
"""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import signal

from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import configured_writer_catalogue
from catalogue_indexer import INITIALIZE_TOPIC, IndexRpc, decode_initialize
from discovery import POOL_MANAGER, DataError, DiscoveryReader, ReadRpc, bytes32
from followers import follow_many
from indexer_io import MAX_INDEXER_SPAN, AdaptiveSpan, indexer_transport
from local_config import load_config
from pool_activity import ACTIVITY_CAPACITY_PROFILES
from pool_requests import PERMANENT, WRITER_ROLE, PgRequests
from selected_pools import SELECTED_POOLS
from manage_catalogue import anchor_candidate

READ_FRESHNESS_SECONDS = 120
DEFAULT_FOLLOW_LAG = 100


def requested_pool_ids(pool_ids, selected=False):
    requested=[]
    for pool_id in pool_ids:
        value=bytes32(pool_id)
        if value not in requested:requested.append(value)
    if selected:
        requested += [pool_id for pool_id in SELECTED_POOLS if pool_id not in requested]
    return requested


def parse_anchors(values):
    anchors={}
    for value in values:
        pool_id,_,block=value.partition('=')
        if not _ or not block.isdigit():
            raise DataError('invalid_initialization_anchor')
        anchors[bytes32(pool_id)]=int(block)
    return anchors


def find_initialize_anchor(rpc,pool_id,*,from_block,to_block,span,max_spans):
    """Bounded PoolManager log scan for one pool's Initialize event.

    The found log is decoded here so the range and the identity are proven
    before the block is offered as an anchor; registration re-verifies it at the
    canonical block, so a stale scan cannot become stored history.
    """
    scanned,cursor=0,from_block
    while cursor<=to_block and scanned<max_spans:
        end=min(cursor+span-1,to_block)
        logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC,pool_id],
                                        'fromBlock':hex(cursor),'toBlock':hex(end)}])
        if not isinstance(logs,list) or len(logs)>2000:
            raise DataError('invalid_logs_response')
        if logs:
            if len(logs)!=1:
                raise DataError('ambiguous_initialize_anchor')
            event=decode_initialize(logs[0])
            return {'status':'found','blockNumber':event['blockNumber'],'blockHash':event['blockHash'],
                    'spansScanned':scanned+1,'scannedThrough':end}
        scanned,cursor=scanned+1,end+1
    return {'status':'not_found_in_scanned_range','spansScanned':scanned,
            'scannedThrough':min(to_block,cursor-1)}


def ensure_anchor(catalogue,rpc,url,pool_id,*,search_from,span,max_spans,head_number):
    """Where the pool's Initialize block is known, or how to prove it now.

    The catalogue's own events are free; a seeded hint has no block, so the
    bounded scan finds it and the identity is then taken from that log.
    """
    with catalogue.connection() as conn:
        event=conn.execute('SELECT block_number FROM domino_catalogue.events WHERE pool_id=%s',
                           (pool_id,)).fetchone()
        hint=conn.execute('SELECT 1 AS present FROM domino_catalogue.hints WHERE pool_id=%s',
                          (pool_id,)).fetchone()
    if event is not None:
        return event['block_number'],'catalogue_event'
    found=find_initialize_anchor(rpc,pool_id,from_block=search_from,to_block=head_number-1,
                                 span=span,max_spans=max_spans)
    if found['status']!='found':
        raise DataError('initialize_anchor_not_found')
    anchor=found['blockNumber']
    if hint is None:
        candidate,block=anchor_candidate(url,pool_id,anchor,rpc=rpc)
        catalogue.seed([candidate],block)
    return anchor,'initialize_log'


def write_report(path,report):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as stream:
        json.dump(report,stream,indent=2);stream.write('\n')


class StopRequests:
    """SIGTERM/SIGINT flag; a follower stops at a round boundary, never mid-write."""
    def __init__(self):
        self.requested=False
    def handle(self,signum,frame):
        self.requested=True
    def __call__(self):
        return self.requested


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id',action='append',default=[],dest='pool_ids')
    parser.add_argument('--selected',action='store_true',
                        help='every pool in backend/selected_pools.py')
    parser.add_argument('--initialization-block',type=int)
    parser.add_argument('--initialization-anchor',action='append',default=[],dest='anchors',
                        help='repeatable POOLID=BLOCK for pools the catalogue cannot anchor')
    parser.add_argument('--through',type=int)
    parser.add_argument('--span',type=int,default=1000)
    parser.add_argument('--span-floor',type=int,default=1000)
    parser.add_argument('--span-ceiling',type=int,default=MAX_INDEXER_SPAN)
    parser.add_argument('--parallel-walks',action='store_true',dest='parallel_walks',
                        help='per-pool writer lock; different pools may be walked at once')
    parser.add_argument('--lag',type=int,default=DEFAULT_FOLLOW_LAG)
    parser.add_argument('--max-steps',type=int,default=5)
    parser.add_argument('--anchor-only',action='store_true',dest='anchor_only',
                        help='with --queue-worker: anchor and register, index nothing yet')
    parser.add_argument('--max-passes',type=int,default=1,
                        help='0 runs until SIGTERM/SIGINT or --max-seconds')
    parser.add_argument('--poll-seconds',type=float,default=5.0)
    parser.add_argument('--max-seconds',type=float)
    parser.add_argument('--max-consecutive-failures',type=int,default=5)
    parser.add_argument('--capacity-profile',choices=ACTIVITY_CAPACITY_PROFILES,default='standard')
    parser.add_argument('--register',action='store_true')
    parser.add_argument('--request',action='store_true',
                        help='enqueue this pool (or --selected) for on-demand indexing')
    parser.add_argument('--queue',action='store_true',
                        help='read the demand queue; no RPC or provider configuration')
    parser.add_argument('--queue-worker',action='store_true',dest='queue_worker',
                        help='drain the demand queue: anchor, register, index, record')
    parser.add_argument('--max-pools',type=int,default=4,dest='max_pools',
                        help='requests claimed per worker round')
    parser.add_argument('--stale-claim-seconds',type=int,default=300,dest='stale_claim_seconds',
                        help='reclaim a request whose worker died mid-pool')
    parser.add_argument('--find-anchor',action='store_true',dest='find_anchor',
                        help='bounded PoolManager scan for a pool Initialize block; no write')
    parser.add_argument('--search-from',type=int)
    parser.add_argument('--search-span',type=int,default=10000)
    parser.add_argument('--search-max-spans',type=int,default=100)
    parser.add_argument('--follow',action='store_true')
    parser.add_argument('--status',action='store_true',
                        help='Read persisted operator status from PostgreSQL only; no RPC or current-data claim')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    try:
        if not 1<=args.span<=MAX_INDEXER_SPAN or args.lag<0:
            raise DataError('invalid_activity_bounds')
        pool_ids=requested_pool_ids(args.pool_ids,selected=args.selected)
        if args.queue:
            catalogue=configured_writer_catalogue()
            if catalogue is None:
                raise DataError('catalogue_not_configured')
            requests=PgRequests(catalogue,role=WRITER_ROLE)
            rows=requests.status(pool_ids[0] if len(pool_ids)==1 else None)
            print(json.dumps({'schemaVersion':1,'mode':'pool_request_queue',
                              'requests':rows if isinstance(rows,list) else [rows]}))
            return 0
        if args.request:
            catalogue=configured_writer_catalogue()
            if catalogue is None:
                raise DataError('catalogue_not_configured')
            if not pool_ids:
                raise DataError('pool_id_required')
            requests=PgRequests(catalogue,role=WRITER_ROLE)
            reason='selected' if args.selected else 'operator'
            accepted=[requests.enqueue(pool_id,reason=reason) for pool_id in pool_ids]
            print(json.dumps({'schemaVersion':1,'mode':'pool_request_enqueue','reason':reason,
                              'pools':pool_ids,'accepted':accepted,'ledgerWrite':False}))
            return 0
        if args.status:
            catalogue=configured_writer_catalogue()
            if catalogue is None:
                raise DataError('catalogue_not_configured')
            store=PgActivity(catalogue)
            if not pool_ids:
                raise DataError('pool_id_required')
            reports=[store.operator_status(pool_id) for pool_id in pool_ids]
            for report in reports:
                print(json.dumps(report),flush=True)
            if args.output is not None:
                write_report(args.output,reports[0] if len(reports)==1 else
                             {'schemaVersion':1,'mode':'activity_operator_status','pools':reports})
            return 0
        url=os.environ.get('DOMINO_DISCOVERY_RPC_URL') or load_config().get('rpcUrl')
        if not url:
            raise DataError('configured_rpc_required')
        if args.find_anchor:
            if not pool_ids:
                raise DataError('pool_id_required')
            if args.search_from is None or args.search_from<1:
                raise DataError('invalid_search_range')
            if not 1<=args.search_span<=10000 or not 1<=args.search_max_spans<=10000:
                raise DataError('invalid_search_bounds')
            head=DiscoveryReader(ReadRpc(url,transport=indexer_transport(60))).snapshot()
            rpc=IndexRpc(url,transport=indexer_transport(90),max_requests=args.search_max_spans+16)
            pools=[{'poolId':pool_id,**find_initialize_anchor(rpc,pool_id,from_block=args.search_from,
                    to_block=head.number-1,span=args.search_span,max_spans=args.search_max_spans)}
                   for pool_id in pool_ids]
            print(json.dumps({'schemaVersion':1,'mode':'activity_initialize_anchor_scan','chainId':4663,
                              'fromBlock':args.search_from,'headAtStart':asdict(head),'pools':pools,
                              'storedWrite':False}))
            return 0 if all(pool['status']=='found' for pool in pools) else 1
        catalogue=configured_writer_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        store=PgActivity(catalogue)
        def worker():
            return ActivityIndexer(store,IndexRpc(url,transport=indexer_transport(90),max_requests=300),
                                   capacity=args.capacity_profile,
                                   parallel_walks=args.parallel_walks)
        if args.queue_worker:
            if not args.search_from or args.search_from<1:
                raise DataError('invalid_search_range')
            if not 1<=args.max_pools<=64:
                raise DataError('invalid_pool_request_claim')
            requests=PgRequests(catalogue,role=WRITER_ROLE)
            rpc=IndexRpc(url,transport=indexer_transport(90),max_requests=300)
            head=DiscoveryReader(ReadRpc(url,transport=indexer_transport(60))).snapshot()
            target=head.number-args.lag
            results=[]
            for claim in requests.claim(limit=args.max_pools,stale_seconds=args.stale_claim_seconds):
                pool_id=claim['pool_id']
                try:
                    anchor,source=ensure_anchor(catalogue,rpc,url,pool_id,
                                                search_from=args.search_from,
                                                span=args.search_span,
                                                max_spans=args.search_max_spans,
                                                head_number=head.number)
                    worker().register(pool_id,anchor)
                    steps=[]
                    for _ in range(0 if args.anchor_only else args.max_steps):
                        result=worker().step(pool_id,through=target,span=args.span)
                        steps.append(result['status'])
                        if result['status']!='indexed':break
                    status=('following' if steps and steps[-1] in ('caught_up_to_target','rewound')
                            else 'indexing')
                    requests.record(pool_id,status,
                                    detail={'anchorBlock':anchor,'anchorSource':source,
                                            'targetBlock':target,'steps':steps,
                                            'capacityProfile':args.capacity_profile})
                    results.append({'poolId':pool_id,'status':status,'anchorBlock':anchor,
                                    'anchorSource':source,'steps':steps})
                except DataError as error:
                    reason=str(error)
                    status='blocked' if reason in PERMANENT else 'indexing'
                    requests.record(pool_id,status,error=reason,detail={'reason':reason})
                    results.append({'poolId':pool_id,'status':status,'reason':reason})
            print(json.dumps({'schemaVersion':1,'mode':'pool_request_worker','chainId':4663,
                              'targetBlock':target,'pools':results,'liveExecution':False}))
            return 0 if all(item['status']!='blocked' for item in results) else 1
        if args.register:
            if not pool_ids:
                raise DataError('pool_id_required')
            anchors=parse_anchors(args.anchors)
            results=[]
            for pool_id in pool_ids:
                anchor=anchors.get(pool_id)
                if anchor is None and len(pool_ids)==1:
                    anchor=args.initialization_block
                try:
                    outcome=worker().register(pool_id,anchor)
                except DataError as error:
                    results.append({'poolId':pool_id,'status':'not_registered','reason':str(error)})
                else:
                    results.append({'poolId':pool_id,**outcome})
            print(json.dumps({'schemaVersion':1,'mode':'core_pool_activity_registration','chainId':4663,
                              'pools':results,'capacityProfile':args.capacity_profile,
                              'financialTransaction':False}))
            return 0 if all(item['status']!='not_registered' for item in results) else 1
        if args.follow:
            if not pool_ids:
                raise DataError('pool_id_required')
            if not 1<=args.max_steps<=50 or not 1<=args.span<=MAX_INDEXER_SPAN:
                raise DataError('invalid_activity_bounds')
            if args.max_passes<0 or args.poll_seconds<0 or args.max_consecutive_failures<1:
                raise DataError('invalid_follow_bounds')
            if args.max_passes==0 and args.max_seconds is None:
                raise DataError('unbounded_follow_needs_a_stop')
            if not 1<=args.span_floor<=args.span<=args.span_ceiling<=MAX_INDEXER_SPAN:
                raise DataError('invalid_span_bounds')
            span=AdaptiveSpan(args.span,floor=args.span_floor,ceiling=args.span_ceiling)
            def step_for(pool_id):
                def step(*,through):
                    try:
                        result=worker().step(pool_id,through=through,span=span.next_span())
                    except (DataError,OSError) as error:
                        span.record(str(error));raise
                    span.record(None)
                    return result
                return step
            stop=StopRequests()
            signal.signal(signal.SIGTERM,stop.handle)
            signal.signal(signal.SIGINT,stop.handle)
            summary=follow_many([(pool_id,step_for(pool_id)) for pool_id in pool_ids],
                                lambda: asdict(DiscoveryReader(
                                    ReadRpc(url,transport=indexer_transport(60))).snapshot()),
                                lag=args.lag,max_passes=args.max_passes,poll_seconds=args.poll_seconds,
                                max_seconds=args.max_seconds,
                                max_consecutive_failures=args.max_consecutive_failures,
                                should_stop=stop,on_pass=lambda step: print(json.dumps(step),flush=True))
            report={'schemaVersion':1,'mode':'core_pool_activity_follower','chainId':4663,
                    'capacityProfile':args.capacity_profile,'readFreshnessSeconds':READ_FRESHNESS_SECONDS,
                    'span':span.as_dict(),'parallelWalks':args.parallel_walks,
                    'follow':summary,'financialTransaction':False}
            if args.output is not None:write_report(args.output,report)
            else:print(json.dumps(report))
            return 0
        if len(pool_ids)!=1:
            raise DataError('pool_id_required')
        pool_id=pool_ids[0]
        if not args.status and args.output is None:
            parser.error('--output is required unless --status is selected')
        if not 1<=args.max_steps<=50 or not 1<=args.span<=MAX_INDEXER_SPAN:
            raise DataError('invalid_activity_bounds')
        head=DiscoveryReader(ReadRpc(url,transport=indexer_transport(60))).snapshot()
        target=args.through if args.through is not None else head.number-args.lag
        if not 1<=target<=head.number-args.lag:
            raise DataError('activity_target_too_close_or_invalid')
        worker().register(pool_id,args.initialization_block)
        results=[]
        for _ in range(args.max_steps):
            result=worker().step(pool_id,through=target,span=args.span)
            results.append(result);print(json.dumps(result),flush=True)
            if result['status']=='caught_up_to_target':break
        write_report(args.output,{'schemaVersion':1,'mode':'bounded_core_pool_activity','chainId':4663,
                      'headAtStart':asdict(head),'target':target,'poolId':pool_id,'steps':results,
                      'activityCapacityProfile':args.capacity_profile,'lag':args.lag,
                      'result':store.read(pool_id),'liveExecution':False})
        return 0
    except DataError as error:
        print(json.dumps({'status':'activity_failed','reason':str(error),
                          'activityCapacityProfile':args.capacity_profile,
                          'previousCommittedProgressRetained':True}))
        return 1
    except (OSError,ValueError,TypeError,KeyError):
        print(json.dumps({'status':'activity_failed','reason':'local_operation_unavailable',
                          'activityCapacityProfile':args.capacity_profile,
                          'previousCommittedProgressRetained':True}))
        return 1


if __name__=='__main__':raise SystemExit(main())
