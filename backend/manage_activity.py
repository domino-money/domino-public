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
`--queue-worker` finds that block itself for a requested pool: it searches the
history the catalogue does not cover, newest first, a bounded part per run, and
remembers how far it got in the request.
`--follow` keeps the stored head `--lag` blocks behind the chain head; the
pool-activity read calls coverage older than 120 s stale, so the default lag is
100 blocks on a one-second chain. `--follow --domino-positions` adds every pool
holding a Domino position (the Setup contract's SetupMinted events) on each run
and registers those the catalogue can anchor (domino-activity-follow.timer).
"""
import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import signal
import time

from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import configured_writer_catalogue
from catalogue_indexer import INITIALIZE_TOPIC, IndexRpc, decode_initialize
from discovery import POOL_MANAGER, STATE_VIEW, DataError, DiscoveryReader, bytes32
from domino_positions import MAX_POSITIONS, position_pools
from followers import follow_many
from indexer_io import MAX_INDEXER_SPAN, AdaptiveSpan, HeaderBudget, RequestBudget, indexer_transport
from local_config import load_config
from rpc_failover import HistoricalReadRpc as ReadRpc
from rpc_config import configured_history_rpc_source, configured_rpc_urls
from pool_activity import ACTIVITY_CAPACITY_PROFILES
from pool_requests import WRITER_ROLE, PgRequests, error_class
from read_deadline import ReadDeadline, read_deadline, use_read_deadline
from selected_pools import SELECTED_POOLS
from manage_catalogue import anchor_candidate

READ_FRESHNESS_SECONDS = 120
DEFAULT_FOLLOW_LAG = 100
# Widest Initialize window one search call asks for. On 6 Oct 2026 the own node
# answered a pool's filtered window of 1,000,000 blocks below its log index in
# 5-9 s (one of 3,000,000 hit its 30 s per-call cap) and millions of recent,
# indexed blocks in a fraction of a second.
MAX_SEARCH_SPAN = 5_000_000
# A window this near the head is searched again by the next claim rather than
# remembered as empty, so a reorganized recent block is never skipped.
SEARCH_FINALITY_BLOCKS = 1_000
# Empty windows a request remembers; merged, a search leaves one or two.
MAX_SEARCH_INTERVALS = 16


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


def initialize_window(rpc,pool_id,start,end):
    """The pool's decoded Initialize log in [start, end], or None; never a guess."""
    logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC,pool_id],
                                    'fromBlock':hex(start),'toBlock':hex(end)}])
    if not isinstance(logs,list) or len(logs)>2000:
        raise DataError('invalid_logs_response')
    if not logs:
        return None
    if len(logs)!=1:
        raise DataError('ambiguous_initialize_anchor')
    return decode_initialize(logs[0])


def find_initialize_anchor(rpc,pool_id,*,from_block,to_block,span,max_spans,reverse=False):
    """Bounded PoolManager log scan for one pool's Initialize event.

    The log is decoded before its block is offered as an anchor, and
    registration re-verifies it at the canonical block, so a stale scan cannot
    become stored history.

    `reverse` starts at the newest window and walks towards the oldest, which is
    what a requested pool usually needs: a pool someone is trading now was
    created recently, while an old pool costs the same as a forward walk.
    """
    if type(reverse) is not bool:
        raise DataError('invalid_search_direction')
    if type(from_block) is not int or type(to_block) is not int or from_block<1 or to_block<from_block:
        raise DataError('invalid_search_range')
    if not 1<=span<=MAX_SEARCH_SPAN or not 1<=max_spans<=10000:
        raise DataError('invalid_search_bounds')
    scanned=0
    window=to_block if reverse else from_block
    lowest,highest=to_block,from_block
    while scanned<max_spans:
        start=max(from_block,window-span+1) if reverse else window
        end=window if reverse else min(window+span-1,to_block)
        if start>to_block or end<from_block:
            break
        lowest=min(lowest,start);highest=max(highest,end)
        event=initialize_window(rpc,pool_id,start,end)
        if event is not None:
            return {'status':'found','blockNumber':event['blockNumber'],'blockHash':event['blockHash'],
                    'spansScanned':scanned+1,'scannedThrough':start if reverse else end,
                    'direction':'reverse' if reverse else 'forward'}
        scanned+=1
        if reverse:
            if start<=from_block:
                break
            window=start-1
        else:
            if end>=to_block:
                break
            window=end+1
    return {'status':'not_found_in_scanned_range','spansScanned':scanned,
            'scannedThrough':lowest if reverse else highest,
            'direction':'reverse' if reverse else 'forward'}


def unscanned(lower,upper,skipped):
    """[lower, upper] without the `skipped` intervals, newest piece first."""
    pieces=[(lower,upper)] if lower<=upper else []
    for start,end in skipped:
        kept=[]
        for low,high in pieces:
            if end<low or start>high:
                kept.append((low,high));continue
            if low<start:kept.append((low,start-1))
            if end<high:kept.append((end+1,high))
        pieces=kept
    return sorted(pieces,key=lambda piece:piece[1],reverse=True)


def merged(intervals):
    result=[]
    for low,high in sorted(intervals):
        if result and low<=result[-1][1]+1:
            result[-1]=(result[-1][0],max(result[-1][1],high))
        else:
            result.append((low,high))
    return result


def search_order(pieces,boundary):
    """Pieces at or below `boundary` newest first, then the part above it.

    Only windows at or below the boundary are remembered, so they come first:
    a claim that can afford one window still moves the search down. The part
    above is a pool too new for the catalogue follower, which holds its event
    within a minute; it is searched last, when it is all that is left.
    """
    deep,recent=[],[]
    for low,high in pieces:
        if low<=boundary:deep.append((low,min(high,boundary)))
        if high>boundary:recent.append((max(low,boundary+1),high))
    return (sorted(deep,key=lambda piece:piece[1],reverse=True)+
            sorted(recent,key=lambda piece:piece[1],reverse=True))


def stored_scan(detail):
    """Windows an earlier claim proved empty, from its request; nothing if malformed."""
    search=detail.get('anchorSearch') if isinstance(detail,dict) else None
    scanned=search.get('scanned') if isinstance(search,dict) else None
    if (not isinstance(scanned,list) or len(scanned)>MAX_SEARCH_INTERVALS or
            not all(isinstance(item,list) and len(item)==2 and all(type(value) is int for value in item)
                    and 1<=item[0]<=item[1] for item in scanned)):
        return []
    return [tuple(item) for item in scanned]


def search_initialize(rpc,pool_id,*,lower,upper,covered,scanned,span,max_spans,seconds,head_number,
                      clock=time.monotonic):
    """A pool's Initialize block in [lower, upper] outside `covered`, newest window first.

    The catalogue holds every Initialize of its interval (`covered`), so a pool
    it lacks was initialized outside it, usually before its start block, which
    no window counted back from the head reaches. One call scans windows until
    `max_spans` or `seconds` (a window it would not finish in time is not
    started) and returns what it proved: the windows found empty, except those
    within SEARCH_FINALITY_BLOCKS of the head, are remembered so the next claim
    resumes below them (search_order). Only a search with nothing left to scan
    is `complete`, i.e. proves absence.
    A failed window raises with the progress made before it as `.search`.
    """
    if (type(lower) is not int or type(upper) is not int or lower<1 or
            not 1<=span<=MAX_SEARCH_SPAN or not 1<=max_spans<=10000 or not 0<=seconds<=300):
        raise DataError('invalid_search_bounds')
    skipped=[covered] if covered else []
    boundary=head_number-SEARCH_FINALITY_BLOCKS
    remembered=merged(scanned);seen=list(remembered)
    started=clock();slowest=0.0;windows=0;found=None

    def progress():
        left=sum(high-low+1 for low,high in unscanned(lower,upper,merged(skipped+seen)))
        return {'scanned':[list(item) for item in remembered[-MAX_SEARCH_INTERVALS:]],
                'catalogueInterval':list(covered) if covered else None,
                'lowerBound':lower,'upperBound':upper,'remainingBlocks':left,
                'complete':found is None and left==0,'windows':windows,
                'seconds':round(clock()-started,3)}
    while found is None:
        todo=search_order(unscanned(lower,upper,merged(skipped+seen)),boundary)
        if not todo or windows>=max_spans or clock()-started+slowest>=seconds:
            break
        low,high=todo[0];start=max(low,high-span+1);opened=clock()
        try:
            event=initialize_window(rpc,pool_id,start,high)
        except DataError as error:
            error.search=progress()
            raise
        slowest=max(slowest,clock()-opened);windows+=1
        if event is None:
            seen=merged(seen+[(start,high)])
            if high<=boundary:
                remembered=merged(remembered+[(start,high)])
            continue
        if event['poolId']!=pool_id or not start<=event['blockNumber']<=high:
            error=DataError('initialize_anchor_mismatch');error.search=progress()
            raise error
        found=event['blockNumber']
    return found,progress()


def initialized_at(rpc,pool_id,block_number):
    """The core holds the pool at this block; a zero price means it was never initialized."""
    sqrt,_,_,_=rpc.call(STATE_VIEW,'getSlot0(bytes32)',['bytes32'],[bytes.fromhex(pool_id[2:])],
                        ['uint160','int24','uint24','uint24'],block=hex(block_number))
    return sqrt!=0


def ensure_anchor(catalogue,rpc,url,pool_id,*,lower,head_number,span,max_spans,seconds,scanned=()):
    """Where the pool's Initialize block is known, or how far proving it has got.

    Returns (block, source, search); block is None while the search goes on.
    The catalogue's own events are free. A pool it does not hold was
    initialized outside its interval. A seeded hint is a verified observation
    of the pool; any other id is searched for only if the core holds it at the
    head at all, so an id nobody created costs one state read, not a search of
    the whole history. The identity is then taken from the log found.
    """
    with catalogue.connection() as conn:
        registered=conn.execute('SELECT start_block FROM domino_activity.pools WHERE pool_id=%s',
                                (pool_id,)).fetchone()
        event=conn.execute('SELECT block_number FROM domino_catalogue.events WHERE pool_id=%s',
                           (pool_id,)).fetchone()
        hint=conn.execute('SELECT 1 AS present FROM domino_catalogue.hints WHERE pool_id=%s',
                          (pool_id,)).fetchone()
        state=conn.execute('SELECT start_block,next_block FROM domino_catalogue.state WHERE singleton').fetchone()
    if registered is not None:
        # Registration already proved this anchor with the pool's own Initialize
        # log, so a pool that is registered needs no scan at all.
        return registered['start_block'],'stored_registration',None
    if event is not None:
        return event['block_number'],'catalogue_event',None
    if hint is None and not initialized_at(rpc,pool_id,head_number):
        raise DataError('pool_not_initialized')
    covered=None
    if state and state['start_block'] and state['next_block'] and state['next_block']>state['start_block']:
        covered=(state['start_block'],state['next_block']-1)
    anchor,search=search_initialize(rpc,pool_id,lower=lower,upper=head_number-1,covered=covered,scanned=scanned,
                                    span=span,max_spans=max_spans,seconds=seconds,head_number=head_number)
    if anchor is None:
        if search['complete']:
            error=DataError('initialize_anchor_not_found');error.search=search
            raise error
        return None,'initialize_search',search
    if hint is None:
        try:
            candidate,block=anchor_candidate(url,pool_id,anchor,rpc=rpc)
            catalogue.seed([candidate],block)
        except DataError as error:
            error.search=search
            raise
    return anchor,'initialize_log',search


def domino_position_targets(store,worker,positions):
    """Which pools holding a Domino position to follow, registering any the catalogue can anchor.

    A pool already registered is followed. One whose Initialize event the
    catalogue holds is registered now. One it knows only as a hint, or not at
    all, is reported until an operator registers it with its Initialize block
    (backend/README.md), as is a registration the writer lock deferred.
    """
    followed,registered_now,not_registered=[],[],[]
    for pool_id in sorted(positions):
        if store.anchor(pool_id) is None:
            try:
                worker().register(pool_id)
            except DataError as error:
                not_registered.append({'poolId':pool_id,'reason':str(error)})
                continue
            registered_now.append(pool_id)
        followed.append(pool_id)
    return followed,registered_now,not_registered


def seconds_left(deadline):
    try:
        return deadline.remaining()
    except DataError:
        return 0.0


def expired(deadline):
    return seconds_left(deadline)<=0


def worker_exit_code(results):
    """0 when the run advanced, or had nothing to do, and only its own budget stopped a claim.

    The run's budget ends some claim in every busy run: that is where a run
    stops once something advanced, not a failure. A run that advanced nothing
    before its budget ran out, or any other refusal, is one the unit shows.
    A claim another writer was moving (contention: the activity follower holds
    or just advanced that pool) is neither: the pool moved.
    """
    budget=failed=0
    for item in results:
        if 'reason' in item:
            kind=error_class(item['reason'])
            if kind=='run_budget':budget+=1
            elif kind!='contention':failed+=1
    advanced=len(results)-budget-failed
    return 0 if not failed and (advanced or not budget) else 1


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
    parser.add_argument('--max-header-calls',type=int,dest='max_header_calls',default=20_000,
                        help='hard ceiling on provider header reads per invocation')
    parser.add_argument('--max-rpc-calls',type=int,default=20_000,
                        help='shared RPC item ceiling including retries for this invocation')
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
    parser.add_argument('--search-back-blocks',type=int,dest='search_back_blocks',
                        help='scan back this many blocks from the head when --search-from is absent; '
                             'without either, --queue-worker searches the whole history')
    parser.add_argument('--search-span',type=int,default=10000,
                        help=f'blocks per Initialize log window, at most {MAX_SEARCH_SPAN:,}')
    parser.add_argument('--search-max-spans',type=int,default=100)
    parser.add_argument('--search-seconds',type=float,default=20.0,dest='search_seconds',
                        help='with --queue-worker: wall time one run spends searching Initialize windows')
    parser.add_argument('--claim-reserve-seconds',type=float,default=10.0,dest='claim_reserve_seconds',
                        help='with --queue-worker: claim nothing more once less than this is left of --max-seconds')
    parser.add_argument('--search-direction',choices=('reverse','forward'),default='reverse',
                        help='scan the anchor window from the head (default) or from its start')
    parser.add_argument('--follow',action='store_true')
    parser.add_argument('--domino-positions',action='store_true',dest='domino_positions',
                        help='with --follow: also every pool holding a Domino position (the Setup '
                             "contract's SetupMinted events), registering those the catalogue can anchor")
    parser.add_argument('--quiet',action='store_true',
                        help='with --follow: print only the final report, not every pass')
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
        config=load_config()
        override=os.environ.get('DOMINO_DISCOVERY_RPC_URL')
        if not config and not override:
            raise DataError('configured_rpc_required')
        current_routes=configured_rpc_urls(config,override)
        current_url=current_routes if config.get('version')==4 and not override else current_routes[0]
        # Walks reconcile state at old checkpoints; registration/anchor discovery
        # use retained logs and headers only and can use the current node.
        url=(configured_history_rpc_source(config) if config.get('version') in (3,4) or not override
             else current_url)
        if args.find_anchor or args.register or (args.queue_worker and args.anchor_only):
            url=current_url
        if args.find_anchor:
            if not pool_ids:
                raise DataError('pool_id_required')
            if args.search_from is None or args.search_from<1:
                raise DataError('invalid_search_range')
            if not 1<=args.search_span<=MAX_SEARCH_SPAN or not 1<=args.search_max_spans<=10000:
                raise DataError('invalid_search_bounds')
            head=DiscoveryReader(ReadRpc(url,transport=indexer_transport(60))).snapshot()
            rpc=IndexRpc(url,transport=indexer_transport(90),max_requests=args.search_max_spans+16)
            pools=[{'poolId':pool_id,**find_initialize_anchor(
                        rpc,pool_id,from_block=args.search_from,to_block=head.number-1,
                        span=args.search_span,max_spans=args.search_max_spans,
                        reverse=args.search_direction=='reverse')}
                   for pool_id in pool_ids]
            print(json.dumps({'schemaVersion':1,'mode':'activity_initialize_anchor_scan','chainId':4663,
                              'fromBlock':args.search_from,'headAtStart':asdict(head),'pools':pools,
                              'storedWrite':False}))
            return 0 if all(pool['status']=='found' for pool in pools) else 1
        catalogue=configured_writer_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        store=PgActivity(catalogue)
        # One cache and one budget per invocation: the same block is never paid
        # for twice across pools or chunks, and the run stops at the ceiling
        # instead of spending whatever the walk needs.
        header_cache={}
        header_budget=HeaderBudget(args.max_header_calls)
        rpc_budget=RequestBudget(args.max_rpc_calls)
        def worker(claim=None):
            return ActivityIndexer(store,IndexRpc(url,transport=indexer_transport(90,budget=rpc_budget),max_requests=20_000),
                                   capacity=args.capacity_profile,
                                   parallel_walks=args.parallel_walks,
                                   header_cache=header_cache,header_budget=header_budget,
                                   publication_guard=(None if claim is None else lambda conn:PgRequests.guard(claim,conn)))
        if args.queue_worker:
            if not 1<=args.max_pools<=64 or not 1<=args.max_steps<=50:
                raise DataError('invalid_pool_request_claim')
            if not 1<=args.span_floor<=args.span<=args.span_ceiling<=MAX_INDEXER_SPAN:
                raise DataError('invalid_span_bounds')
            if args.max_seconds is not None and not 1<=args.max_seconds<=300:
                raise DataError('invalid_follow_bounds')
            if (not 1<=args.search_span<=MAX_SEARCH_SPAN or not 1<=args.search_max_spans<=10000 or
                    not 0<=args.search_seconds<=300 or not 0<=args.claim_reserve_seconds<300):
                raise DataError('invalid_search_bounds')
            run_deadline=ReadDeadline(args.max_seconds or 90)
            requests=PgRequests(catalogue,role=WRITER_ROLE)
            reopened=requests.reopen_unfinished_anchor_searches()
            with use_read_deadline(run_deadline):
                head=DiscoveryReader(ReadRpc(current_url,transport=indexer_transport(60,budget=rpc_budget))).snapshot()
            target=head.number-args.lag
            # The whole history unless the operator bounds it: a requested pool
            # the catalogue lacks is older than the catalogue, which no window
            # counted back from the head reaches.
            search_from=args.search_from
            if search_from is None and args.search_back_blocks is not None:
                if not 1<=args.search_back_blocks<=50_000_000:
                    raise DataError('invalid_search_range')
                search_from=max(1,head.number-args.search_back_blocks)
            search_from=1 if search_from is None else search_from
            if search_from<1:
                raise DataError('invalid_search_range')
            results=[];seen=[];stopped='max_pools';search_left=args.search_seconds
            for _ in range(args.max_pools):
                # Claim only what the run can still finish: a claim the run's own
                # deadline cuts makes no progress and costs that pool a retry.
                if seconds_left(run_deadline)<=args.claim_reserve_seconds:
                    stopped='run_budget';break
                # The persisted claim counter reserves every fourth slot for
                # background work even when budgets stop this run after one pool.
                claims=requests.claim(limit=1,stale_seconds=args.stale_claim_seconds,
                                      exclude=seen,priority='auto')
                if not claims:
                    stopped='queue_empty';break
                claim=claims[0]
                pool_id=claim['pool_id']
                seen.append(pool_id)
                # Each walked span doubles the next one up to the ceiling, so a
                # pool brought down by a dense range recovers its width.
                span=AdaptiveSpan(min(args.span_ceiling,max(args.span_floor,claim['span_blocks'] or args.span)),
                                  floor=args.span_floor,ceiling=args.span_ceiling,growth_passes=1)
                progress={'search':None,'steps':[]}

                def step(value,claim=claim,pool_id=pool_id):
                    try:
                        return worker(claim).step(pool_id,through=target,span=value)
                    except DataError:
                        # The run running out is no range the provider refused:
                        # the span must not shrink for it.
                        if expired(run_deadline):raise DataError('run_deadline_exceeded') from None
                        raise

                def work(claim=claim,pool_id=pool_id,span=span,progress=progress):
                    rpc=IndexRpc(current_url,transport=indexer_transport(90,budget=rpc_budget),max_requests=20_000)
                    # The run's search seconds, never the reserve the rest of
                    # this claim needs, so a window seldom outlives the run and
                    # leaves the node scanning for a reader that has gone.
                    seconds=max(0.0,min(search_left,seconds_left(run_deadline)-args.claim_reserve_seconds))
                    anchor,source,search=ensure_anchor(
                        catalogue,rpc,current_url,pool_id,lower=search_from,head_number=head.number,
                        span=args.search_span,max_spans=args.search_max_spans,seconds=seconds,
                        scanned=stored_scan(claim.get('detail')))
                    progress['search']=search
                    if anchor is None:
                        return {'status':'indexing','anchorBlock':None,'anchorSource':source}
                    worker(claim).register(pool_id,anchor)
                    for _ in range(0 if args.anchor_only else args.max_steps):
                        requests.renew(claim,lease_seconds=args.stale_claim_seconds)
                        result=span.run(step)
                        progress['steps'].append(result['status'])
                        if result['status']!='indexed':break
                    steps=progress['steps']
                    return {'status':'following' if steps and steps[-1]=='caught_up_to_target' else 'indexing',
                            'anchorBlock':anchor,'anchorSource':source}

                outcome=None
                try:
                    # One bounded task cannot hold a claim indefinitely. Current
                    # headers/logs find the identity; old state stays on history RPC.
                    with use_read_deadline(run_deadline),read_deadline(min(90,args.stale_claim_seconds)):
                        outcome=work()
                except DataError as error:
                    failure=error
                else:
                    failure=None
                search=progress['search'] if failure is None else getattr(failure,'search',progress['search'])
                if search is not None:
                    search_left-=search['seconds']
                if outcome is not None:
                    # Finished, even if leaving the deadline's scope then found
                    # the run spent: that is where this run stops, not a failure.
                    status=outcome['status']
                    detail={'anchorBlock':outcome['anchorBlock'],'anchorSource':outcome['anchorSource'],
                            'targetBlock':target,'steps':progress['steps'],
                            'capacityProfile':args.capacity_profile}
                    if search is not None:detail['anchorSearch']=search
                    lost=None
                    try:
                        requests.record(pool_id,status,claim=claim,span=span.next_span(),detail=detail)
                    except DataError as error:
                        if str(error)!='pool_request_lease_lost':raise
                        status,lost='lease_lost',str(error)
                    results.append({'poolId':pool_id,'status':status,'anchorBlock':outcome['anchorBlock'],
                                    'anchorSource':outcome['anchorSource'],'steps':progress['steps'],
                                    'span':span.as_dict(),**({'reason':lost} if lost else {}),
                                    **({'anchorSearch':{key:search[key] for key in
                                                        ('remainingBlocks','windows','seconds','complete')}}
                                       if search is not None else {})})
                    continue
                reason=str(failure)
                if expired(run_deadline):reason='run_deadline_exceeded'
                classification=error_class(reason)
                status='blocked' if classification in ('identity','authorization') else 'indexing'
                detail={'reason':reason}
                if search is not None:detail['anchorSearch']=search
                if progress['steps']:detail['steps']=progress['steps']
                try:
                    requests.record(pool_id,status,claim=claim,error=reason,span=span.next_span(),detail=detail)
                except DataError as lost:
                    if str(lost)!='pool_request_lease_lost':raise
                    status='lease_lost'
                results.append({'poolId':pool_id,'status':status,'reason':reason,
                                **({'steps':progress['steps']} if progress['steps'] else {})})
                if classification=='run_budget':
                    stopped='run_budget';break
            print(json.dumps({'schemaVersion':1,'mode':'pool_request_worker','chainId':4663,
                              'targetBlock':target,'searchFromBlock':search_from,
                              'headerCalls':header_budget.calls,'headerBudget':args.max_header_calls,
                              'rpcCalls':rpc_budget.calls,'rpcBudget':rpc_budget.max_calls,
                              'stoppedBecause':stopped,'reopenedRequests':reopened,
                              'pools':results,'liveExecution':False}))
            return worker_exit_code(results)
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
            # The queue worker blocks a request whose Initialize its search
            # missed; the anchor registered here is what it lacked.
            reopened,reopen_reason=[],None
            anchored=[item['poolId'] for item in results if item['status']!='not_registered']
            if anchored:
                try:
                    requests=PgRequests(catalogue,role=WRITER_ROLE)
                    for pool_id in anchored:reopened+=requests.retry(pool_id)
                except DataError as error:
                    reopen_reason=str(error)
            print(json.dumps({'schemaVersion':1,'mode':'core_pool_activity_registration','chainId':4663,
                              'pools':results,'reopenedRequests':reopened,
                              **({'reopenReason':reopen_reason} if reopen_reason else {}),
                              'capacityProfile':args.capacity_profile,
                              'financialTransaction':False}))
            return 0 if all(item['status']!='not_registered' for item in results) else 1
        if args.follow:
            positions=None
            if args.domino_positions:
                # The head, the Setup contract's logs and one key read per position.
                rpc=IndexRpc(url,transport=indexer_transport(60,budget=rpc_budget),max_requests=MAX_POSITIONS+16)
                positions=position_pools(rpc,DiscoveryReader(rpc).snapshot())
                followed,registered_now,not_registered=domino_position_targets(store,worker,positions)
                pool_ids=sorted(set(pool_ids)|set(followed))
                positions={'pools':len(positions),'positions':sum(len(ids) for ids in positions.values()),
                           'followed':len(followed),'registeredNow':registered_now,
                           'notRegistered':not_registered}
            if not pool_ids:
                if positions is not None:
                    print(json.dumps({'schemaVersion':1,'mode':'core_pool_activity_follower','chainId':4663,
                                      'dominoPositions':positions,'follow':None,'financialTransaction':False}))
                    return 0
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
                    # A rejected range is retried inside the same pass with the
                    # smaller span.
                    for attempt in range(3):
                        try:
                            result=worker().step(pool_id,through=through,span=span.next_span())
                        except (DataError,OSError) as error:
                            reason=str(error);span.record(reason)
                            if reason in AdaptiveSpan.SHRINK_REASONS and attempt<2:
                                continue
                            raise
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
                                should_stop=stop,
                                on_pass=None if args.quiet else lambda step: print(json.dumps(step),flush=True))
            report={'schemaVersion':1,'mode':'core_pool_activity_follower','chainId':4663,
                    'capacityProfile':args.capacity_profile,'readFreshnessSeconds':READ_FRESHNESS_SECONDS,
                    'span':span.as_dict(),'parallelWalks':args.parallel_walks,
                    'headerCalls':header_budget.calls,'headerBudget':args.max_header_calls,
                    'follow':summary,'financialTransaction':False}
            if positions is not None:report['dominoPositions']=positions
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
