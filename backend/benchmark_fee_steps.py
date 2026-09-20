"""Bounded fee-candidate step measurement for the recorded public qualification window.

No core math changes, ledger writes or provider configuration in output. A stored
or exported input measures replay work; it does not establish current canonicality.
"""
import argparse
from copy import deepcopy
from dataclasses import asdict
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import time

from catalogue import PgCatalogue, checked_key, database_settings
from catalogue_indexer import IndexRpc, INITIALIZE_TOPIC, decode_initialize
from discovery import CHAIN_ID, POOL_MANAGER, RPC_URL, DataError, bytes32, parse_block, quantity
from fee_accounting import MAX_CHUNK_STEPS, MAX_STEPS, replay_fees, simulate, supported
from historical_capacity import MAX_BATCH_EVENTS, replay_batch
from local_config import load_config
from rpc_config import configured_history_rpc_source
from pool_activity import TOPICS, SWAP, active_liquidity, decode_activity, replay
from v4_math import sqrt_at_tick
from read_service import bounded_transport

ROOT = Path(__file__).resolve().parents[1]
MAX_CHUNKS = 8
MAX_EVENTS = 2000
MAX_TOTAL_EVENTS = 10000
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_STEPS = 1000000
MAX_BATCHES = 400
ACQUISITION_SECONDS = 60
REPLAY_SECONDS = 30
MAX_RPC_REQUESTS = 80
STUDY_RPC_REQUESTS = 256
STUDY_INITIALIZATIONS = 256
STUDY_CANDIDATES = 8


class BenchmarkLimit(RuntimeError):
    """A harness stop must bypass reconstruction's invalid-candidate handling."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def scope():
    record = json.loads((ROOT/'reports/fee-ledger-live-2026-09-09.json').read_text())
    chunks = [{'fromBlock': step['fromBlock'], 'throughBlock': step['through'],
               'recordedSwapEvents': step['swapEvents']} for step in record['steps'] if 'fromBlock' in step]
    return {'poolId': record['poolId'], 'poolKey': record['result']['poolKey'], 'chunks': chunks,
            'historicalSnapshot': record['result']['snapshot'],
            'expectedFees': record['result']['fees']['accounting'],
            'recordedEventCount': record['result']['storedEventCount'],
            'qualificationSha256': digest(record)}


def projected(event):
    # Core fee replay does not use individual sender, position salt or tx hash.
    result = {k: event[k] for k in ('poolId', 'blockNumber', 'blockHash', 'timestamp', 'logIndex', 'kind', 'payload')}
    result['payload'] = {k: v for k, v in result['payload'].items() if k not in ('sender', 'salt')}
    if 'rawFingerprint' in event:
        result['rawFingerprint'] = event['rawFingerprint']
    return result


def catalogue_input(catalogue, spec):
    chunks = []
    deadline = time.monotonic()+ACQUISITION_SECONDS
    with catalogue.connection() as conn:  # SELECT-only role and READ ONLY transaction.
        for bounds in spec['chunks']:
            if time.monotonic() >= deadline:
                raise DataError('fee_benchmark_acquisition_deadline')
            row = conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_activity.chunks
              WHERE pool_id=%s AND start_block=%s''', (spec['poolId'], bounds['fromBlock'])).fetchone()
            if row is None or row['end_block'] != bounds['throughBlock']:
                raise DataError('fee_benchmark_recorded_chunk_missing')
            rows = conn.execute('''SELECT pool_id AS "poolId",block_number AS "blockNumber",
              block_hash AS "blockHash",block_timestamp AS timestamp,log_index AS "logIndex",kind,payload,
              raw_fingerprint AS "rawFingerprint" FROM domino_activity.events WHERE pool_id=%s AND chunk_start=%s
              ORDER BY block_number,log_index LIMIT 2001''', (spec['poolId'], bounds['fromBlock'])).fetchall()
            if len(rows) > MAX_EVENTS:
                raise DataError('fee_benchmark_event_budget')
            chunks.append({**bounds, 'endBlock': {'number': row['end_block'], 'hash': row['end_hash'],
                'timestamp': row['end_timestamp']}, 'events': [projected(e) for e in rows]})
    return {'poolId': spec['poolId'], 'poolKey': spec['poolKey'], 'chunks': chunks,
            'canonicality': 'stored_historical_requires_rpc_recheck'}


def rpc_input(rpc, spec):
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
        raise DataError('wrong_chain')
    headers, chunks, total = {}, [], 0

    def header(number):
        if number not in headers:
            actual = parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False]))
            if actual.number != number:
                raise DataError('unexpected_block_number')
            headers[number] = actual
        return headers[number]

    for bounds in spec['chunks']:
        start, end = bounds['fromBlock'], bounds['throughBlock']
        before, after = header(start-1), header(end)
        logs = rpc.request('eth_getLogs', [{'address': POOL_MANAGER, 'topics': [TOPICS, spec['poolId']],
                                          'fromBlock': hex(start), 'toBlock': hex(end)}])
        if not isinstance(logs, list) or len(logs) > MAX_EVENTS:
            raise DataError('fee_benchmark_event_budget')
        events = {}
        for raw in logs:
            event = decode_activity(raw, spec['poolId'])
            if not start <= event['blockNumber'] <= end:
                raise DataError('activity_event_outside_chunk')
            block = header(event['blockNumber'])
            if block.hash != event['blockHash'] or not before.timestamp <= block.timestamp <= after.timestamp:
                raise DataError('activity_event_block_mismatch')
            event['timestamp'] = block.timestamp
            identity = (event['blockNumber'], event['logIndex'])
            if identity in events and events[identity] != event:
                raise DataError('conflicting_activity_log')
            events[identity] = event
        rows = [projected(events[k]) for k in sorted(events)]
        total += len(rows)
        if total > MAX_TOTAL_EVENTS:
            raise DataError('fee_benchmark_event_budget')
        chunks.append({**bounds, 'endBlock': asdict(after), 'events': rows})
    for number, expected in headers.items():
        if parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False])) != expected:
            raise DataError('activity_snapshot_reorganized')
    return {'poolId': spec['poolId'], 'poolKey': spec['poolKey'], 'chunks': chunks,
            'canonicality': 'boundary_and_event_hashes_rechecked_single_provider'}


class StudyRpc:
    """One request/deadline allowance for selection, acquisition and revalidation."""
    def __init__(self, rpc, *, max_requests=STUDY_RPC_REQUESTS, seconds=ACQUISITION_SECONDS, clock=time.monotonic):
        self.rpc, self.limit, self.clock = rpc, max_requests, clock
        self.deadline, self.count = clock()+seconds, 0

    def _call(self, method, *args, **kwargs):
        if self.clock() >= self.deadline:raise DataError('fee_benchmark_acquisition_deadline')
        if self.count >= self.limit:raise DataError('fee_benchmark_rpc_budget')
        self.count += 1
        result = getattr(self.rpc, method)(*args, **kwargs)
        if self.clock() >= self.deadline:raise DataError('fee_benchmark_acquisition_deadline')
        return result

    def request(self, method, params=()):
        if method not in IndexRpc.METHODS:raise DataError('method_not_read_only')
        return self._call('request', method, params)

    def call(self, *args, **kwargs):return self._call('call', *args, **kwargs)


def recent_public_input(rpc, *, blocks=10000):
    """Select by observed swap count; reconstruct only a complete recent lifecycle.

    This intentionally samples at most eight oldest supported pool initializations
    in the bounded window. It cannot identify the network's busiest pool/chunk.
    Selection counts are unqualified provider diagnostics; selected event proofs
    and final state receive the normal exact canonical/reconciliation checks.
    """
    if type(blocks) is not int or not 1 <= blocks <= 10000:
        raise DataError('fee_benchmark_invalid_window')
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:raise DataError('wrong_chain')
    head = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
    start = head.number-blocks+1
    if start < 1:raise DataError('fee_benchmark_invalid_window')
    logs = rpc.request('eth_getLogs', [{'address': POOL_MANAGER, 'topics': [INITIALIZE_TOPIC],
                                      'fromBlock': hex(start), 'toBlock': head.tag}])
    if not isinstance(logs, list) or len(logs) > STUDY_INITIALIZATIONS:
        raise DataError('fee_benchmark_candidate_budget')
    candidates = {}
    for raw in logs:
        item = decode_initialize(raw)
        if not start <= item['blockNumber'] <= head.number:raise DataError('activity_event_outside_chunk')
        if item['poolId'] in candidates:raise DataError('fee_benchmark_duplicate_initialization')
        if supported(checked_key(item['poolKey'], item['poolId'])):candidates[item['poolId']] = item
    sampled = sorted(candidates.values(), key=lambda item: (item['blockNumber'], item['poolId']))[:STUDY_CANDIDATES]
    if not sampled:raise DataError('fee_benchmark_no_recent_candidate')
    swaps = rpc.request('eth_getLogs', [{'address': POOL_MANAGER, 'topics': [SWAP, [item['poolId'] for item in sampled]],
                                       'fromBlock': hex(start), 'toBlock': head.tag}])
    if not isinstance(swaps, list) or len(swaps) > MAX_EVENTS:raise DataError('fee_benchmark_event_budget')
    counts = {item['poolId']: 0 for item in sampled};seen = {}
    for raw in swaps:
        topics = raw.get('topics') if isinstance(raw, dict) else None
        if not isinstance(topics, list) or len(topics) != 3 or bytes32(topics[0]) != SWAP:
            raise DataError('invalid_activity_topics')
        pool = bytes32(topics[1])
        if pool not in counts:raise DataError('activity_pool_mismatch')
        event = decode_activity(raw, pool)
        if event['kind'] != 'swap' or not candidates[pool]['blockNumber'] <= event['blockNumber'] <= head.number:
            raise DataError('activity_event_outside_chunk')
        identity = event['blockNumber'], event['logIndex']
        if identity in seen:
            if seen[identity] != event:raise DataError('conflicting_activity_log')
            continue
        seen[identity] = event;counts[pool] += 1
    selected = min(sampled, key=lambda item: (-counts[item['poolId']], item['poolId']))
    if counts[selected['poolId']] == 0:raise DataError('fee_benchmark_no_active_recent_candidate')
    spec = {'poolId': selected['poolId'], 'poolKey': selected['poolKey'],
            'chunks': [{'fromBlock': selected['blockNumber'], 'throughBlock': head.number}]}
    dataset = rpc_input(rpc, spec)
    if dataset['chunks'][0]['endBlock'] != asdict(head):raise DataError('activity_snapshot_reorganized')
    events = dataset['chunks'][0]['events']
    if (not events or events[0]['kind'] != 'initialize' or
            sum(e['kind'] == 'swap' for e in events) != counts[selected['poolId']]):
        raise DataError('fee_benchmark_selection_mismatch')
    # Reuse the real public StateView reader; no catalogue/store is constructed.
    from activity_indexer import ActivityIndexer
    from types import SimpleNamespace
    snapshot = ActivityIndexer.read_state(SimpleNamespace(rpc=rpc), selected['poolId'], head,
                                         checked_key(selected['poolKey'], selected['poolId']))
    if parse_block(rpc.request('eth_getBlockByNumber', [head.tag, False])) != head:
        raise DataError('activity_snapshot_reorganized')
    dataset.update(expectedSnapshot=snapshot, selection={
        'fromBlock': start, 'throughBlock': head.number, 'initializationsObserved': len(logs),
        'supportedInitializations': len(candidates), 'candidatesExamined': len(sampled),
        'policy': 'eight_oldest_supported_recent_initializations_ranked_by_observed_swap_count',
        'candidateCountsStatus': 'unreconciled_provider_selection_diagnostics',
        'candidateSwapCounts': counts, 'selectedPool': selected['poolId'],
        'globalBusiestAssessed': False})
    return dataset


def reconcile_study_result(dataset, result):
    if result['status'] != 'measured':raise DataError('fee_benchmark_study_incomplete')
    state, ledger, expected = result['finalActivity'], result['finalLedger'], dataset['expectedSnapshot']
    if (ledger['growthX128'] != expected['feeGrowthGlobalX128'] or
            any(state[key] != expected[key] for key in ('sqrtPriceX96', 'tick', 'protocolFeeRaw')) or
            str(active_liquidity(state)) != expected['activeLiquidityRaw']):
        raise DataError('fee_benchmark_state_reconciliation_failed')


def public_study(args):
    report = {'schemaVersion': 1, 'mode': 'bounded_recent_fee_step_study', 'chainId': CHAIN_ID,
              'source': args.source, 'status': 'unavailable', 'poolId': None,
              'currentCanonicalityAssessed': False, 'stateReconciled': False,
              'globalBusiestAssessed': False, 'productionCapacityCalibrated': False,
              'executionAvailable': False, 'ledgerWritten': False,
              'limits': {'blocks': args.scan_blocks, 'candidates': STUDY_CANDIDATES,
                         'candidateSteps': MAX_STEPS, 'sharedSteps': MAX_CHUNK_STEPS, 'eventsPerBatch': MAX_BATCH_EVENTS,
                         'initializations': STUDY_INITIALIZATIONS, 'events': MAX_EVENTS,
                         'rpcRequests': STUDY_RPC_REQUESTS, 'acquisitionSeconds': ACQUISITION_SECONDS,
                         'replaySeconds': REPLAY_SECONDS, 'aggregateStepAttempts': MAX_TOTAL_STEPS}}
    rpc = None
    try:
        if args.output.exists() or (args.events_output and args.events_output.exists()):raise DataError('output_exists')
        if args.source == 'study-fixture':
            if args.fixture is None:raise DataError('fee_benchmark_fixture_required')
            with args.fixture.open('rb') as stream:raw = stream.read(MAX_INPUT_BYTES+1)
            if len(raw) > MAX_INPUT_BYTES:raise DataError('fee_benchmark_input_budget')
            dataset = json.loads(raw)
        else:
            rpc = StudyRpc(IndexRpc(RPC_URL, transport=bounded_transport(ACQUISITION_SECONDS), max_requests=STUDY_RPC_REQUESTS))
            dataset = recent_public_input(rpc, blocks=args.scan_blocks)
        result = measure(dataset)
        reconcile_study_result(dataset, result)
        snapshot = dataset['expectedSnapshot']
        if rpc is not None and asdict(parse_block(rpc.request('eth_getBlockByNumber', [hex(snapshot['number']), False]))) != {key:snapshot[key] for key in ('number','hash','timestamp')}:
            raise DataError('activity_snapshot_reorganized')
        result.pop('finalActivity');result.pop('finalLedger')
        report.update(result, poolId=dataset['poolId'], poolKey=dataset['poolKey'], selection=dataset['selection'],
                      snapshot=snapshot, inputSha256=digest(dataset), canonicality=dataset['canonicality'] if rpc else 'exported_historical_requires_rpc_recheck',
                      currentCanonicalityAssessed=rpc is not None, stateReconciled=rpc is not None, recordedStateMatched=True)
        if args.events_output:write_new(args.events_output, dataset)
    except (DataError, BenchmarkLimit) as error:
        report.update(status='unavailable', reason=str(error), chunks=[], busiestExaminedChunk=None,
                      totalCandidateStepsAdmittedIncludingResume=None, totalStepAttemptsIncludingResume=None)
    except (OSError, KeyError, TypeError, ValueError, RecursionError):
        report.update(status='unavailable', reason='fee_benchmark_local_operation_unavailable', chunks=[],
                      busiestExaminedChunk=None, totalCandidateStepsAdmittedIncludingResume=None,
                      totalStepAttemptsIncludingResume=None)
    if rpc is not None:report['rpcRequests'] = rpc.count
    try:write_new(args.output, report)
    except (DataError, OSError):
        print(json.dumps({'status':'unavailable','reason':'fee_benchmark_output_unavailable'}));return 1
    print(json.dumps({key: report[key] for key in ('status','source','poolId')} |
                     ({'reason': report['reason']} if 'reason' in report else {})))
    return 0 if report['status'] == 'measured' else 1


# Wider empirical study has its own explicit acquisition budget; worker math is unchanged.
DENSE_RPC_REQUESTS = 8192
DENSE_SECONDS = 600
DENSE_INITIALIZATIONS = 2048
DENSE_CANDIDATES = 1024
DENSE_SELECTION_EVENTS = 20000
DENSE_POOLS = 3
DENSE_BATCH = 8
DENSE_HTTP_INTERVAL = 1.0


def paced_public_transport(seconds, *, clock=time.monotonic, sleep=time.sleep):
    """Pace envelopes without retrying failed requests; transport deadline includes waits."""
    transport = bounded_transport(seconds)
    next_start = clock()
    def invoke(url, body):
        nonlocal next_start
        remaining = next_start-clock()
        if remaining > 0: sleep(remaining)
        next_start = clock()+DENSE_HTTP_INTERVAL
        return transport(url,body)
    return invoke


class BatchIndexRpc(IndexRpc):
    """Public read-only JSON-RPC batches; count each method, not each HTTP envelope."""
    def batch(self, calls):
        if not self.legacy_single_source:
            return super().batch(calls)
        if not isinstance(calls, list) or not 1 <= len(calls) <= DENSE_BATCH:
            raise DataError('fee_benchmark_rpc_batch_budget')
        if any(method not in self.METHODS for method, _ in calls):
            raise DataError('method_not_read_only')
        if self.count+len(calls) > self.max_requests:
            raise DataError('request_budget_exhausted')
        first = self.count+1
        self.count += len(calls)
        request = [{'jsonrpc':'2.0','id':first+i,'method':method,'params':list(params)}
                   for i,(method,params) in enumerate(calls)]
        response = self.transport(self.url, request)
        if not isinstance(response,list) or len(response)!=len(calls):
            raise DataError('invalid_rpc_envelope')
        found = {}
        for item in response:
            if (not isinstance(item,dict) or item.get('jsonrpc')!='2.0' or
                    type(item.get('id')) is not int or item['id'] in found or
                    not first <= item['id'] < first+len(calls)):
                raise DataError('invalid_rpc_envelope')
            if 'error' in item: raise DataError('rpc_error')
            if set(item) != {'jsonrpc','id','result'}: raise DataError('invalid_rpc_envelope')
            found[item['id']] = item['result']
        return [found[first+i] for i in range(len(calls))]


def study_batch(rpc, calls):
    if not isinstance(calls,list) or not 1<=len(calls)<=DENSE_BATCH:
        raise DataError('fee_benchmark_rpc_batch_budget')
    if any(method not in IndexRpc.METHODS for method,_ in calls): raise DataError('method_not_read_only')
    if rpc.clock() >= rpc.deadline: raise DataError('fee_benchmark_acquisition_deadline')
    if rpc.count+len(calls)>rpc.limit: raise DataError('fee_benchmark_rpc_budget')
    rpc.count += len(calls)
    result = rpc.rpc.batch(calls)
    if rpc.clock() >= rpc.deadline: raise DataError('fee_benchmark_acquisition_deadline')
    return result


def dense_selection(rpc, *, through=None, blocks=80000):
    """Survey every supported initialization inside a declared bounded population."""
    from pool_activity import MODIFY
    if type(blocks) is not int or not 1<=blocks<=80000 or (through is not None and
            (type(through) is not int or through<blocks)):
        raise DataError('fee_benchmark_invalid_window')
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID: raise DataError('wrong_chain')
    head = parse_block(rpc.request('eth_getBlockByNumber', ['latest' if through is None else hex(through),False]))
    if (through is not None and head.number!=through) or head.number<blocks:
        raise DataError('fee_benchmark_invalid_window')
    start=head.number-blocks+1
    windows=[(a,min(a+9999,head.number)) for a in range(start,head.number+1,10000)]
    candidates={};init_count=0
    for begin,end in windows:
        logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC],
                         'fromBlock':hex(begin),'toBlock':hex(end)}])
        if not isinstance(logs,list): raise DataError('invalid_initialize_log')
        init_count+=len(logs)
        if init_count>DENSE_INITIALIZATIONS: raise DataError('fee_benchmark_candidate_budget')
        for raw in logs:
            item=decode_initialize(raw)
            if not begin<=item['blockNumber']<=end: raise DataError('activity_event_outside_chunk')
            if item['poolId'] in candidates: raise DataError('fee_benchmark_duplicate_initialization')
            if supported(checked_key(item['poolKey'],item['poolId'])): candidates[item['poolId']]=item
    if not candidates: raise DataError('fee_benchmark_no_recent_candidate')
    if len(candidates)>DENSE_CANDIDATES: raise DataError('fee_benchmark_candidate_budget')
    stats={pool:{'swaps':0,'ranges':set(),'tickTravel':0,'previousTick':None} for pool in candidates}
    selection_count=0;fingerprints={}
    ordered=sorted(candidates)
    for begin,end in windows:
        for offset in range(0,len(ordered),64):
            allowed=ordered[offset:offset+64]
            logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[[SWAP,MODIFY],allowed],
                             'fromBlock':hex(begin),'toBlock':hex(end)}])
            if not isinstance(logs,list): raise DataError('invalid_activity_log')
            selection_count+=len(logs)
            if selection_count>DENSE_SELECTION_EVENTS: raise DataError('fee_benchmark_selection_event_budget')
            decoded=[]
            for raw in logs:
                topics=raw.get('topics') if isinstance(raw,dict) else None
                if not isinstance(topics,list) or len(topics)<2: raise DataError('invalid_activity_topics')
                pool=bytes32(topics[1])
                if pool not in allowed: raise DataError('activity_pool_mismatch')
                event=decode_activity(raw,pool)
                if event['kind'] not in ('swap','modify_liquidity'): raise DataError('invalid_activity_topics')
                if not max(begin,candidates[pool]['blockNumber'])<=event['blockNumber']<=end:
                    raise DataError('activity_event_outside_chunk')
                identity=(event['blockNumber'],event['logIndex'])
                fingerprint=digest(event)
                if identity in fingerprints:
                    if fingerprints[identity]!=fingerprint: raise DataError('conflicting_activity_log')
                    continue
                fingerprints[identity]=fingerprint;decoded.append(event)
            for event in sorted(decoded,key=lambda e:(e['blockNumber'],e['logIndex'])):
                row=stats[event['poolId']];payload=event['payload']
                if event['kind']=='modify_liquidity': row['ranges'].add((payload['tickLower'],payload['tickUpper']))
                else:
                    row['swaps']+=1
                    if row['previousTick'] is not None: row['tickTravel']+=abs(payload['tick']-row['previousTick'])
                    row['previousTick']=payload['tick']
    ranked=[{'poolId':pool,'initializeBlock':candidates[pool]['blockNumber'],
             'observedSwaps':row['swaps'],'observedDistinctRanges':len(row['ranges']),
             'observedTickTravel':row['tickTravel'],
             'tickSpacing':candidates[pool]['poolKey']['tick_spacing']} for pool,row in stats.items()]
    active=[row for row in ranked if row['observedSwaps']]
    if not active: raise DataError('fee_benchmark_no_active_recent_candidate')
    selected=[]
    policies=[lambda r:(-r['observedDistinctRanges'],-r['observedSwaps'],r['poolId']),
              lambda r:(-r['observedSwaps'],-r['observedDistinctRanges'],r['poolId']),
              lambda r:(-Fraction(r['observedTickTravel'],r['tickSpacing']),-r['observedSwaps'],r['poolId'])]
    for policy in policies:
        choice=next((r for r in sorted(active,key=policy) if r['poolId'] not in selected),None)
        if choice: selected.append(choice['poolId'])
    if parse_block(rpc.request('eth_getBlockByNumber',[head.tag,False]))!=head:
        raise DataError('activity_snapshot_reorganized')
    return head,candidates,{'fromBlock':start,'throughBlock':head.number,'head':asdict(head),
        'initializationsObserved':init_count,'supportedInitializations':len(candidates),
        'unsupportedInitializations':init_count-len(candidates),'selectionEventsObserved':selection_count,
        'candidateCountsStatus':'unreconciled_provider_selection_diagnostics',
        'policy':'distinct_range_leader_then_swap_count_leader_then_spacing_normalized_tick_travel_leader_without_duplicates',
        'selectedPools':selected,'candidateStatistics':sorted(ranked,key=lambda r:r['poolId']),
        'selectionFingerprintSha256':digest(sorted(fingerprints.items())),
        'globalBusiestAssessed':False,'olderPoolsExcluded':True}


def dense_pool_input(rpc, item, head, *, remaining_events=MAX_TOTAL_EVENTS):
    """Complete Initialize-to-end history, fixed chunks and endpoint state proofs."""
    from activity_indexer import ActivityIndexer
    from types import SimpleNamespace
    if type(remaining_events) is not int or not 0<=remaining_events<=MAX_TOTAL_EVENTS:
        raise DataError('fee_benchmark_event_budget')
    pool,key=item['poolId'],checked_key(item['poolKey'],item['poolId'])
    bounds=[(a,min(a+9999,head.number)) for a in range(item['blockNumber'],head.number+1,10000)]
    if len(bounds)>MAX_CHUNKS: raise DataError('fee_benchmark_chunk_budget')
    raw_chunks=[];headers_needed=set();total=0
    for start,end in bounds:
        logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[TOPICS,pool],
                         'fromBlock':hex(start),'toBlock':hex(end)}])
        if not isinstance(logs,list) or len(logs)>MAX_EVENTS: raise DataError('fee_benchmark_event_budget')
        rows={}
        for raw in logs:
            event=decode_activity(raw,pool)
            if not start<=event['blockNumber']<=end: raise DataError('activity_event_outside_chunk')
            identity=event['blockNumber'],event['logIndex']
            if identity in rows and rows[identity]!=event: raise DataError('conflicting_activity_log')
            rows[identity]=event
        events=[rows[k] for k in sorted(rows)];total+=len(events)
        if total>remaining_events: raise DataError('fee_benchmark_event_budget')
        headers_needed.update([start-1,end]);headers_needed.update(e['blockNumber'] for e in events)
        raw_chunks.append((start,end,events))
    headers={}
    ordered=sorted(headers_needed)
    for offset in range(0,len(ordered),DENSE_BATCH):
        numbers=ordered[offset:offset+DENSE_BATCH]
        values=study_batch(rpc,[('eth_getBlockByNumber',[hex(n),False]) for n in numbers])
        for number,value in zip(numbers,values):
            block=parse_block(value)
            if block.number!=number: raise DataError('unexpected_block_number')
            headers[number]=block
    chunks=[]
    for start,end,events in raw_chunks:
        before,after=headers[start-1],headers[end]
        for event in events:
            block=headers[event['blockNumber']]
            if event['blockHash']!=block.hash or not before.timestamp<=block.timestamp<=after.timestamp:
                raise DataError('activity_event_block_mismatch')
            event['timestamp']=block.timestamp
        snapshot=ActivityIndexer.read_state(SimpleNamespace(rpc=rpc),pool,after,key)
        chunks.append({'fromBlock':start,'throughBlock':end,'endBlock':asdict(after),
                       'expectedSnapshot':snapshot,'events':[projected(e) for e in events]})
    first=chunks[0]['events'][0] if chunks[0]['events'] else None
    if (not first or first['kind']!='initialize' or first['blockNumber']!=item['blockNumber'] or
            first['blockHash']!=item['blockHash'] or first['payload']['poolKey']!=item['poolKey']):
        raise DataError('initialize_anchor_mismatch')
    for offset in range(0,len(ordered),DENSE_BATCH):
        numbers=ordered[offset:offset+DENSE_BATCH]
        values=study_batch(rpc,[('eth_getBlockByNumber',[hex(n),False]) for n in numbers])
        if any(parse_block(value)!=headers[n] for n,value in zip(numbers,values)):
            raise DataError('activity_snapshot_reorganized')
    if chunks[-1]['endBlock']!=asdict(head): raise DataError('activity_snapshot_reorganized')
    return {'poolId':pool,'poolKey':item['poolKey'],'chunks':chunks,
        'expectedSnapshot':chunks[-1]['expectedSnapshot'],
        'verifiedHeaders':[asdict(headers[n]) for n in ordered],
        'canonicality':'all_boundary_event_hashes_and_each_chunk_state_rechecked_single_provider'}


def empirical_distribution(values):
    values=sorted(values)
    if not values: return {'count':0,'minimum':None,'maximum':None,'p50':None,'p95':None,'p99':None}
    return {'count':len(values),'minimum':values[0],'maximum':values[-1],
            **{f'p{p}':values[(len(values)*p+99)//100-1] for p in (50,95,99)}}


def detailed_crossing_work(dataset,work):
    import fee_accounting
    from unittest.mock import patch
    state=None;key=checked_key(dataset['poolKey'],dataset['poolId']);swaps=[];candidate_steps=[]
    original=fee_accounting.simulate
    def observed(*args,**kwargs):
        counter=kwargs['budget'];before=counter.admitted
        try: return original(*args,**kwargs)
        finally: candidate_steps.append(counter.admitted-before)
    before=work.attempts
    # Instrument only the call boundary. Original simulate, arguments, errors and
    # budget remain unchanged; the private CLI has no concurrent replay workers.
    with patch.object(fee_accounting,'simulate',side_effect=observed):
        for chunk in dataset['chunks']:
            for event in chunk['events']:
                work.check()
                if event['kind']=='swap':
                    counter=MeasuredBudget([MAX_CHUNK_STEPS],work)
                    result=fee_accounting.reconstruct_swap(state,key,event['payload'],budget=counter,with_trace=True)
                    swaps.append({'blockNumber':event['blockNumber'],'logIndex':event['logIndex'],
                        'candidateSteps':counter.admitted,'initializedTicksCrossed':len(result['crossingGrowth'])})
                state=replay(state,[event],dataset['poolId'],dataset['poolKey'])
    ranked=sorted(swaps,key=lambda r:(-r['candidateSteps'],r['blockNumber'],r['logIndex']))
    if sum(candidate_steps)!=work.attempts-before: raise DataError('fee_benchmark_counter_contract_changed')
    return {'additionalStepAttempts':work.attempts-before,'swapsObserved':len(swaps),
            'percentileMethod':'nearest_rank_of_observed_population_only',
            'stepsPerCandidate':empirical_distribution(candidate_steps),
            'candidateStepsPerSwap':empirical_distribution([r['candidateSteps'] for r in swaps]),
            'initializedTicksPerSwap':empirical_distribution([r['initializedTicksCrossed'] for r in swaps]),
            'totalInitializedTicksCrossed':sum(r['initializedTicksCrossed'] for r in swaps),
            'swapsCrossingInitializedTicks':sum(r['initializedTicksCrossed']>0 for r in swaps),
            'maxInitializedTicksCrossed':max((r['initializedTicksCrossed'] for r in swaps),default=0),
            'highestStepSwaps':ranked[:10]}


def validate_dense_checkpoints(dataset):
    chunks=dataset.get('chunks')
    if not isinstance(chunks,list) or not 1<=len(chunks)<=MAX_CHUNKS:
        raise DataError('fee_benchmark_chunk_budget')
    checked_key(dataset['poolKey'],dataset['poolId'])
    for index,chunk in enumerate(chunks):
        start,end,events=chunk.get('fromBlock'),chunk.get('throughBlock'),chunk.get('events')
        if not isinstance(events,list) or len(events)>MAX_EVENTS:
            raise DataError('fee_benchmark_event_budget')
        if (type(start) is not int or type(end) is not int or not 0<start<=end<2**63 or
                end-start>=10000 or (index and start!=chunks[index-1]['throughBlock']+1) or
                any(not isinstance(e,dict) or e.get('poolId')!=dataset['poolId'] or
                    type(e.get('blockNumber')) is not int or not start<=e['blockNumber']<=end or
                    type(e.get('logIndex')) is not int or not 0<=e['logIndex']<2**63 for e in events) or
                any((a['blockNumber'],a['logIndex'])>=(b['blockNumber'],b['logIndex'])
                    for a,b in zip(events,events[1:]))):
            raise DataError('fee_benchmark_invalid_window')
        expected,end=chunk.get('expectedSnapshot'),chunk.get('endBlock')
        if (not isinstance(expected,dict) or not isinstance(end,dict) or
                expected.get('number')!=chunk.get('throughBlock') or
                any(expected.get(k)!=end.get(k) for k in ('number','hash','timestamp')) or
                any(type(expected.get(k)) is not int or not 0<=expected[k]<2**63 for k in ('number','timestamp'))):
            raise DataError('fee_benchmark_chunk_checkpoint_required')
        bytes32(expected.get('hash'))
    first=chunks[0]['events'][0] if chunks[0]['events'] else None
    if (not first or first.get('kind')!='initialize' or
            first['blockNumber']!=chunks[0]['fromBlock'] or not isinstance(first.get('payload'),dict) or
            first['payload'].get('poolKey')!=dataset['poolKey']):
        raise DataError('initialize_anchor_mismatch')
    if chunks[-1]['expectedSnapshot']!=dataset.get('expectedSnapshot'):
        raise DataError('fee_benchmark_chunk_checkpoint_mismatch')


def selected_dense_input(rpc,path,*,through=None):
    """Reuse explicit survey evidence, reverify chain/head and every selected Initialize."""
    with path.open('rb') as stream: raw=stream.read(MAX_INPUT_BYTES+1)
    if len(raw)>MAX_INPUT_BYTES: raise DataError('fee_benchmark_input_budget')
    source=json.loads(raw);selection=source.get('selection')
    if not isinstance(selection,dict): raise DataError('fee_benchmark_selection_mismatch')
    pools=selection.get('selectedPools');stats=selection.get('candidateStatistics')
    if (not isinstance(pools,list) or not 1<=len(pools)<=DENSE_POOLS or len(set(pools))!=len(pools)
            or not isinstance(stats,list) or len(stats)>DENSE_CANDIDATES):
        raise DataError('fee_benchmark_candidate_budget')
    expected=selection['head'];number=expected['number'];start_bound=selection.get('fromBlock')
    if (type(number) is not int or not 1<=number<2**63 or type(start_bound) is not int or
            not max(1,number-79999)<=start_bound<=number or selection.get('throughBlock')!=number or
            (through is not None and through!=number)):
        raise DataError('fee_benchmark_invalid_window')
    if quantity(rpc.request('eth_chainId'))!=CHAIN_ID: raise DataError('wrong_chain')
    head=parse_block(rpc.request('eth_getBlockByNumber',[hex(number),False]))
    if asdict(head)!=expected: raise DataError('activity_snapshot_reorganized')
    candidates={}
    for pool in pools:
        bytes32(pool);rows=[row for row in stats if row.get('poolId')==pool]
        if len(rows)!=1: raise DataError('fee_benchmark_selection_mismatch')
        start=rows[0]['initializeBlock']
        if type(start) is not int or not start_bound<=start<=head.number:
            raise DataError('fee_benchmark_invalid_window')
        logs=rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC,pool],
                         'fromBlock':hex(start),'toBlock':hex(start)}])
        if not isinstance(logs,list) or len(logs)!=1: raise DataError('initialize_anchor_mismatch')
        item=decode_initialize(logs[0])
        if item['poolId']!=pool or item['blockNumber']!=start or not supported(checked_key(item['poolKey'],pool)):
            raise DataError('initialize_anchor_mismatch')
        candidates[pool]=item
    selection=deepcopy(selection)
    selection['reusedSurveySha256']=digest(source)
    selection['reusedSurveyCountsRevalidated']=False
    return head,candidates,selection


def dense_scope(selection,*,through=None):
    if not isinstance(selection,dict): raise DataError('fee_benchmark_selection_mismatch')
    head=selection.get('head');start=selection.get('fromBlock');end=selection.get('throughBlock')
    if (not isinstance(head,dict) or type(start) is not int or type(end) is not int or
            not 1<=start<=end<2**63 or end-start>=80000 or
            type(head.get('number')) is not int or head['number']!=end or
            type(head.get('timestamp')) is not int or not 0<=head['timestamp']<2**63 or
            (through is not None and through!=end)):
        raise DataError('fee_benchmark_invalid_window')
    bytes32(head.get('hash'))
    pools=selection.get('selectedPools')
    if not isinstance(pools,list) or not 1<=len(pools)<=DENSE_POOLS:
        raise DataError('fee_benchmark_candidate_budget')
    for pool in pools: bytes32(pool)
    if len(set(pools))!=len(pools): raise DataError('fee_benchmark_selection_mismatch')
    return end-start+1


def dense_study(args):
    report={'schemaVersion':1,'mode':'bounded_dense_fee_step_study','chainId':CHAIN_ID,'source':args.source,
        'status':'unavailable','selection':None,'pools':[],'busiestExaminedChunk':None,
        'globalBusiestAssessed':False,'productionCapacityCalibrated':False,'ledgerWritten':False,
        'executionAvailable':False,'currentCanonicalityAssessed':False,
        'limits':{'blocks':args.scan_blocks,'initializations':DENSE_INITIALIZATIONS,'candidates':DENSE_CANDIDATES,
            'selectedPools':DENSE_POOLS,'selectionEvents':DENSE_SELECTION_EVENTS,'rpcRequests':DENSE_RPC_REQUESTS,
            'acquisitionSeconds':DENSE_SECONDS,'httpEnvelopeIntervalSeconds':DENSE_HTTP_INTERVAL,'headersPerBatch':DENSE_BATCH,'chunksPerPool':MAX_CHUNKS,
            'eventsPerChunk':MAX_EVENTS,'eventsAllSelectedPools':MAX_TOTAL_EVENTS,
            'aggregateStepAttempts':MAX_TOTAL_STEPS,'replaySeconds':REPLAY_SECONDS,
            'sharedSteps':MAX_CHUNK_STEPS,'candidateSteps':MAX_STEPS}}
    rpc=None;datasets=[]
    try:
        if args.output.exists() or (args.events_output and args.events_output.exists()): raise DataError('output_exists')
        if args.source=='dense-fixture':
            if args.fixture is None: raise DataError('fee_benchmark_fixture_required')
            with args.fixture.open('rb') as stream: raw=stream.read(MAX_INPUT_BYTES+1)
            if len(raw)>MAX_INPUT_BYTES: raise DataError('fee_benchmark_input_budget')
            bundle=json.loads(raw);datasets=bundle['datasets'];report['selection']=bundle['selection']
        else:
            if args.source=='configured-dense':
                if args.provider_config is None: raise DataError('configured_rpc_required')
                config=load_config(args.provider_config)
                if not config.get('rpcUrl'): raise DataError('configured_rpc_required')
                url=configured_history_rpc_source(config)
            else: url=RPC_URL
            rpc=StudyRpc(BatchIndexRpc(url,transport=paced_public_transport(DENSE_SECONDS),max_requests=DENSE_RPC_REQUESTS),
                         max_requests=DENSE_RPC_REQUESTS,seconds=DENSE_SECONDS)
            if args.selection_fixture:
                head,candidates,selection=selected_dense_input(rpc,args.selection_fixture,through=args.through_block)
            else: head,candidates,selection=dense_selection(rpc,through=args.through_block,blocks=args.scan_blocks)
            report['selection']=selection
            report['limits']['blocks']=dense_scope(selection,through=args.through_block)
            remaining=MAX_TOTAL_EVENTS
            for pool in selection['selectedPools']:
                dataset=dense_pool_input(rpc,candidates[pool],head,remaining_events=remaining)
                remaining-=sum(len(c['events']) for c in dataset['chunks'])
                datasets.append(dataset)
        if not isinstance(datasets,list) or not 1<=len(datasets)<=DENSE_POOLS:
            raise DataError('fee_benchmark_candidate_budget')
        if sum(len(c['events']) for d in datasets for c in d['chunks'])>MAX_TOTAL_EVENTS:
            raise DataError('fee_benchmark_event_budget')
        report['limits']['blocks']=dense_scope(report['selection'],through=args.through_block)
        if report['selection'].get('selectedPools')!=[d['poolId'] for d in datasets]:
            raise DataError('fee_benchmark_selection_mismatch')
        for dataset in datasets:
            validate_dense_checkpoints(dataset)
            if (dataset['chunks'][0]['fromBlock']<report['selection']['fromBlock'] or
                    dataset['chunks'][-1]['endBlock']!=report['selection']['head']):
                raise DataError('fee_benchmark_selection_mismatch')
        if rpc:
            head=report['selection']['head']
            if asdict(parse_block(rpc.request('eth_getBlockByNumber',[hex(head['number']),False])))!=head:
                raise DataError('activity_snapshot_reorganized')
        # Preserve only a complete, checked acquisition before the independent
        # replay allowance starts. A replay failure must not force a fresh scan.
        if args.events_output:
            write_new(args.events_output,{'selection':report['selection'],'datasets':datasets,
                'acquisition':{'status':'complete','replayStatus':'not_assessed',
                    'currentCanonicalityAssessed':rpc is not None,
                    'inputSha256':digest({'selection':report['selection'],'datasets':datasets})}})
        work=WorkLimit()
        for dataset in datasets:
            result=measure(dataset,work=work);reconcile_study_result(dataset,result)
            detail=detailed_crossing_work(dataset,work)
            result.pop('finalActivity');result.pop('finalLedger')
            result['directChunkMeasurementsCensored']=any(c['status']!='within_budget' for c in result['chunks'])
            if result['directChunkMeasurementsCensored']: result['busiestExaminedChunk']=None
            report['pools'].append({**result,'poolId':dataset['poolId'],'poolKey':dataset['poolKey'],
                'inputSha256':digest(dataset),'eachChunkStateMatched':True,'crossingWork':detail})
        if rpc:
            head=report['selection']['head']
            if asdict(parse_block(rpc.request('eth_getBlockByNumber',[hex(head['number']),False])))!=head:
                raise DataError('activity_snapshot_reorganized')
        entries=[{'poolId':p['poolId'],**c} for p in report['pools'] for c in p['chunks']]
        chunk_steps=[c['candidateStepsAdmitted'] for c in entries]
        batch_steps=[b['candidateStepsAdmitted'] for c in entries for b in c['resumeBatches']]
        censored=any(c['status']!='within_budget' for c in entries)
        report.update(status='measured',busiestExaminedChunk=None if censored else max(entries,key=lambda c:c['candidateStepsAdmitted']),
            directChunkMeasurementsCensored=censored,
            observedChunkSteps=None if censored else empirical_distribution(chunk_steps),
            observedResumeBatchSteps=empirical_distribution(batch_steps),
            totalStepAttemptsAllStages=work.attempts,currentCanonicalityAssessed=rpc is not None,
            busiestScope='only_selected_complete_lifecycles_and_fixed_chunks_inside_declared_survey',
            inputSha256=digest({'selection':report['selection'],'datasets':datasets}))
    except (DataError,BenchmarkLimit) as error:
        report.update(status='unavailable',reason=str(error),busiestExaminedChunk=None,totalStepAttemptsAllStages=None)
    except (OSError,KeyError,TypeError,ValueError,RecursionError):
        report.update(status='unavailable',reason='fee_benchmark_local_operation_unavailable',
                      busiestExaminedChunk=None,totalStepAttemptsAllStages=None)
    if rpc is not None:report['rpcRequests']=rpc.count
    try:write_new(args.output,report)
    except (OSError,DataError):
        print(json.dumps({'status':'unavailable','reason':'fee_benchmark_output_unavailable'}));return 1
    print(json.dumps({'status':report['status'],'reason':report.get('reason'),
                      'rpcRequests':report.get('rpcRequests'),'selected':report.get('selection',{}).get('selectedPools') if report['selection'] else None}))
    return 0 if report['status']=='measured' else 1


class WorkLimit:
    def __init__(self, *, clock=time.monotonic, seconds=REPLAY_SECONDS, max_steps=MAX_TOTAL_STEPS):
        self.clock, self.started, self.max_steps = clock, clock(), max_steps
        self.deadline, self.attempts, self.admitted = self.started+seconds, 0, 0

    def check(self):
        if self.clock() >= self.deadline:
            raise BenchmarkLimit('fee_benchmark_replay_deadline')


class MeasuredBudget:
    """Observe the exact shared-budget decrement used by unmodified simulate().

    A decrement below zero is a rejected step attempt: no swap math runs for it.
    Accepted decrements include unsuccessful replay candidates, not just matches.
    """
    def __init__(self, remaining, work):
        self.remaining, self.work, self.attempts, self.admitted = remaining, work, 0, 0

    def __getitem__(self, index):
        return self.remaining[index]

    def __setitem__(self, index, value):
        self.work.check()
        if index != 0 or value != self.remaining[0]-1:
            raise BenchmarkLimit('fee_benchmark_counter_contract_changed')
        if self.work.attempts >= self.work.max_steps:
            raise BenchmarkLimit('fee_benchmark_aggregate_step_budget')
        self.work.attempts += 1;self.attempts += 1
        if value >= 0:
            self.work.admitted += 1;self.admitted += 1
        self.remaining[0] = value


def measure(dataset, *, work=None):
    work = WorkLimit() if work is None else work
    attempts_before, admitted_before = work.attempts, work.admitted
    chunks = dataset.get('chunks')
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS:
        raise DataError('fee_benchmark_chunk_budget')
    if any(not isinstance(c.get('events'), list) or len(c['events']) > MAX_EVENTS for c in chunks):
        raise DataError('fee_benchmark_event_budget')
    if sum(len(c['events']) for c in chunks) > MAX_TOTAL_EVENTS:
        raise DataError('fee_benchmark_event_budget')
    key = checked_key(dataset['poolKey'], dataset['poolId'])
    activity = ledger = None
    measured = []
    for index, chunk in enumerate(chunks):
        work.check()
        start, end, events = chunk['fromBlock'], chunk['throughBlock'], chunk['events']
        if (type(start) is not int or type(end) is not int or not 0 < start <= end < 2**63 or
                end-start >= 10000 or (index and start != chunks[index-1]['throughBlock']+1) or
                any(e['poolId'] != dataset['poolId'] or not start <= e['blockNumber'] <= end for e in events) or
                any((a['blockNumber'], a['logIndex']) >= (b['blockNumber'], b['logIndex']) for a,b in zip(events, events[1:]))):
            raise DataError('fee_benchmark_invalid_window')
        counter = MeasuredBudget([MAX_CHUNK_STEPS], work)
        started = time.perf_counter()
        result = {'fromBlock': start, 'throughBlock': end, 'events': len(events),
                  'swaps': sum(e['kind'] == 'swap' for e in events), 'inputSha256': digest(events)}
        direct = None
        try:
            direct = replay_fees(activity, ledger, events, dataset['poolId'], key, budget=counter)
            result['status'] = 'within_budget'
        except DataError as error:
            if str(error) != 'fee_step_budget_exhausted':
                raise
            result.update(status='over_budget', reason=str(error),
                          exhaustedBound='shared_steps' if counter[0] < 0 else 'candidate_steps')
        result.update(candidateStepsAdmitted=counter.admitted, candidateStepAttempts=counter.attempts,
                      sharedBudgetUsedPercent=100*counter.admitted/MAX_CHUNK_STEPS,
                      replayMilliseconds=round((time.perf_counter()-started)*1000, 3))
        a, m, offset, rows, batches = deepcopy(activity), deepcopy(ledger), 0, [], []
        for _ in range(MAX_BATCHES):
            work.check()
            if offset >= len(events):
                break
            before, attempts, admitted = offset, work.attempts, work.admitted

            def observed(*args, budget, **kwargs):
                return replay_fees(*args, budget=MeasuredBudget(budget, work), **kwargs)

            try:
                a, m, changes, offset = replay_batch(observed, a, m, events, offset, dataset['poolId'], key)
            except DataError as error:
                if str(error) != 'fee_step_budget_exhausted':
                    raise
                result['resumeStatus'] = 'single_event_over_budget'
                batches.append({'fromEventOffset': before, 'nextEventOffset': before, 'status': 'over_budget',
                                'candidateStepsAdmitted': work.admitted-admitted,
                                'candidateStepAttempts': work.attempts-attempts})
                break
            rows.extend(changes)
            batches.append({'fromEventOffset': before, 'nextEventOffset': offset,
                            'candidateStepsAdmitted': work.admitted-admitted,
                            'candidateStepAttempts': work.attempts-attempts})
            if offset <= before:
                raise DataError('fee_benchmark_no_progress')
        else:
            raise DataError('fee_benchmark_batch_budget')
        result.update(resumeBatches=batches, processedEvents=offset)
        if offset == len(events):
            resumed = (a, m, rows)
            if direct is not None and resumed != direct:
                raise DataError('fee_benchmark_resume_mismatch')
            result.update(resumeStatus='complete', resumedEqualsSinglePass=True if direct is not None else None,
                          outputSha256=digest(resumed))
            activity, ledger = a, m
            if 'expectedSnapshot' in chunk:
                reconcile_study_result({'expectedSnapshot':chunk['expectedSnapshot']},
                    {'status':'measured','finalActivity':activity,'finalLedger':ledger})
        measured.append(result)
        if offset != len(events):
            break
    complete = len(measured) == len(chunks) and all(c['resumeStatus'] == 'complete' for c in measured)
    return {'status': 'measured' if complete else 'incomplete', 'chunks': measured,
            'busiestExaminedChunk': max(measured, key=lambda c: c['candidateStepsAdmitted']) if measured else None,
            'busiestScope': 'only_the_examined_historical_chunks', 'allChunksWithinSinglePassBudget':
                complete and all(c['status'] == 'within_budget' for c in measured),
            'totalCandidateStepsAdmittedIncludingResume': work.admitted-admitted_before, 'totalStepAttemptsIncludingResume': work.attempts-attempts_before,
            'finalActivity': activity, 'finalLedger': ledger}


def synthetic_crossing_input(work, *, ranges=200, swaps=160):
    """Deterministic workload, not an independent financial-correctness oracle.

    Build adjacent synthetic ranges then alternate bounded full-width swaps using
    the existing simulator. The real reconstruction and resume paths count work;
    no chain history or production capacity qualification is implied.
    """
    if type(ranges) is not int or type(swaps) is not int or not 2 <= ranges <= 200 or not 1 <= swaps <= 160:
        raise DataError('fee_benchmark_synthetic_bounds')
    fixture = json.loads((ROOT/'backend/tests/fixtures/fee-reference.json').read_text())['cases'][0]
    pool, key_json = fixture['poolId'], fixture['poolKey'];key = checked_key(key_json, pool)
    lower = -(ranges//2)*key.tick_spacing
    upper = lower+ranges*key.tick_spacing
    events=[];state=None
    def event(kind, payload):
        nonlocal state
        work.check()
        row={'poolId':pool,'blockNumber':10,'blockHash':'0x'+'11'*32,'timestamp':1010,
             'logIndex':len(events),'kind':kind,'payload':payload}
        events.append(row);state=replay(state,[row],pool,key_json)
    event('initialize', {'poolKey':key_json,'sqrtPriceX96':str(sqrt_at_tick(lower+1)),'tick':lower+1})
    for tick in range(lower,upper,key.tick_spacing):
        event('modify_liquidity', {'tickLower':tick,'tickUpper':tick+key.tick_spacing,'liquidityDelta':str(10**12)})
    for index in range(swaps):
        zero=bool(index%2);limit=sqrt_at_tick(lower+1 if zero else upper-1)
        result=simulate(state,key,zero=zero,remaining=-(2**90),limit=limit,fee=key.fee_pips,
                        budget=MeasuredBudget([MAX_CHUNK_STEPS],work))
        event('swap', {'amount0':str(-result['grossInput'] if zero else result['output']),
                       'amount1':str(result['output'] if zero else -result['grossInput']),
                       'sqrtPriceX96':str(result['sqrtPriceX96']),'tick':result['tick'],
                       'liquidity':str(result['liquidity']),'swapFeePips':key.fee_pips})
    return {'poolId':pool,'poolKey':key_json,'chunks':[{'fromBlock':10,'throughBlock':10,'events':events}],
            'canonicality':'synthetic_not_chain_evidence', 'synthetic':{'ranges':ranges,'swaps':swaps,
                'rangeLiquidityRaw':str(10**12),'lowerTick':lower,'upperTick':upper,
                'generation':'existing_simulator_workload_not_independent_accounting_oracle'}}


def synthetic_study(args):
    report={'schemaVersion':1,'mode':'synthetic_fee_step_stress','source':'synthetic-stress',
            'status':'unavailable','canonicality':'synthetic_not_chain_evidence',
            'currentCanonicalityAssessed':False,'productionCapacityCalibrated':False,
            'executionAvailable':False,'ledgerWritten':False,'rpcRequests':0,
            'limits':{'candidateSteps':MAX_STEPS,'sharedSteps':MAX_CHUNK_STEPS,
                      'aggregateStepAttempts':MAX_TOTAL_STEPS,'generationAndReplaySeconds':REPLAY_SECONDS}}
    try:
        if args.output.exists() or (args.events_output and args.events_output.exists()):raise DataError('output_exists')
        work=WorkLimit();dataset=synthetic_crossing_input(work)
        generation=work.attempts;result=measure(dataset,work=work)
        # A different partition verifies resume output without widening a worker cap.
        state=ledger=None;rows=[];key=checked_key(dataset['poolKey'],dataset['poolId'])
        for event in dataset['chunks'][0]['events']:
            state,ledger,changes=replay_fees(state,ledger,[event],dataset['poolId'],key,
                                            budget=MeasuredBudget([MAX_CHUNK_STEPS],work))
            rows.extend(changes)
        if ((state,ledger)!=(result['finalActivity'],result['finalLedger']) or
                digest((state,ledger,rows))!=result['chunks'][0].get('outputSha256')):
            raise DataError('fee_benchmark_resume_mismatch')
        result.pop('finalActivity');result.pop('finalLedger')
        report.update(result,synthetic=dataset['synthetic'],inputSha256=digest(dataset),
                      busiestScope='synthetic_workload_only',
                      generationStepAttempts=generation,totalStepAttemptsAllStages=work.attempts,
                      resumedEqualsSingleEventPartition=True)
        if args.events_output:write_new(args.events_output,dataset)
    except (DataError,BenchmarkLimit) as error:
        report.update(status='unavailable',reason=str(error),chunks=[],busiestExaminedChunk=None)
    except (OSError,KeyError,TypeError,ValueError,RecursionError):
        report.update(status='unavailable',reason='fee_benchmark_local_operation_unavailable',chunks=[],busiestExaminedChunk=None)
    try:write_new(args.output,report)
    except (DataError,OSError):
        print(json.dumps({'status':'unavailable','reason':'fee_benchmark_output_unavailable'}));return 1
    print(json.dumps({'status':report['status'],'source':args.source}))
    return 0 if report['status']=='measured' else 1


def write_new(path, value):
    raw = json.dumps(value, indent=2, allow_nan=False).encode()+b'\n'
    if len(raw) > MAX_INPUT_BYTES:
        raise DataError('fee_benchmark_output_budget')
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('catalogue', 'public-rpc', 'configured-rpc', 'fixture', 'public-study', 'study-fixture', 'synthetic-stress', 'public-dense', 'configured-dense', 'dense-fixture'), required=True)
    parser.add_argument('--database-config', type=Path)
    parser.add_argument('--provider-config', type=Path, help='Required for configured-rpc; existing private product configuration.')
    parser.add_argument('--fixture', type=Path)
    parser.add_argument('--events-output', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scan-blocks', type=int, choices=(1000,5000,10000,40000,80000), default=10000)
    parser.add_argument('--selection-fixture', type=Path, help='Explicit prior dense survey report; selected anchors/head are rechecked.')
    parser.add_argument('--through-block', type=int, help='Pinned public-dense survey endpoint; omitted uses latest.')
    args = parser.parse_args(argv)
    if args.source in ('public-dense','configured-dense','dense-fixture'):return dense_study(args)
    if args.source in ('public-study','study-fixture'):return public_study(args)
    if args.source == 'synthetic-stress':return synthetic_study(args)
    spec = scope()
    report = {'schemaVersion': 1, 'mode': 'bounded_fee_step_benchmark', 'chainId': CHAIN_ID,
              'source': args.source, 'poolId': spec['poolId'], 'qualificationSha256': spec['qualificationSha256'],
              'scope': {'fromBlock': spec['chunks'][0]['fromBlock'], 'throughBlock': spec['chunks'][-1]['throughBlock'],
                        'requestedChunks': len(spec['chunks'])},
              'limits': {'candidateSteps': MAX_STEPS, 'sharedSteps': MAX_CHUNK_STEPS, 'eventsPerBatch': MAX_BATCH_EVENTS,
                         'chunks': MAX_CHUNKS, 'eventsPerChunk': MAX_EVENTS, 'totalEvents': MAX_TOTAL_EVENTS,
                         'aggregateStepAttempts': MAX_TOTAL_STEPS, 'resumeBatchesPerChunk': MAX_BATCHES,
                         'acquisitionSeconds': ACQUISITION_SECONDS, 'replaySeconds': REPLAY_SECONDS,
                         'rpcRequests': MAX_RPC_REQUESTS, 'inputBytes': MAX_INPUT_BYTES},
              'executionAvailable': False, 'ledgerWritten': False, 'currentCanonicalityAssessed': False}
    rpc = None
    try:
        if args.output.exists() or (args.events_output and args.events_output.exists()):
            raise DataError('output_exists')
        if args.source == 'fixture':
            if args.fixture is None:
                raise DataError('fee_benchmark_fixture_required')
            with args.fixture.open('rb') as stream:
                raw = stream.read(MAX_INPUT_BYTES+1)
            if len(raw) > MAX_INPUT_BYTES:
                raise DataError('fee_benchmark_input_budget')
            dataset = json.loads(raw)
        elif args.source == 'catalogue':
            settings = database_settings(args.database_config) if args.database_config else database_settings()
            if not settings:
                raise DataError('catalogue_not_configured')
            dataset = catalogue_input(PgCatalogue(settings), spec)
        else:
            config = load_config(args.provider_config) if args.source == 'configured-rpc' and args.provider_config else {}
            if args.source == 'configured-rpc' and not config:
                raise DataError('configured_rpc_required')
            rpc = IndexRpc(configured_history_rpc_source(config), transport=bounded_transport(ACQUISITION_SECONDS),
                           max_requests=MAX_RPC_REQUESTS)
            dataset = rpc_input(rpc, spec)
        if (dataset['poolId'] != spec['poolId'] or dataset['poolKey'] != spec['poolKey'] or
                [(c['fromBlock'], c['throughBlock']) for c in dataset['chunks']] !=
                [(c['fromBlock'], c['throughBlock']) for c in spec['chunks']]):
            raise DataError('fee_benchmark_recorded_window_mismatch')
        last = dataset['chunks'][-1]['endBlock']
        if any(last[k] != spec['historicalSnapshot'][k] for k in ('number', 'hash', 'timestamp')):
            raise DataError('fee_benchmark_recorded_snapshot_mismatch')
        if (sum(len(c['events']) for c in dataset['chunks']) != spec['recordedEventCount'] or
                any(sum(e['kind'] == 'swap' for e in c['events']) != b['recordedSwapEvents']
                    for c, b in zip(dataset['chunks'], spec['chunks']))):
            raise DataError('fee_benchmark_recorded_event_count_mismatch')
        result = measure(dataset)
        activity, ledger = result.pop('finalActivity'), result.pop('finalLedger')
        if result['status'] == 'measured':
            if (any(ledger[k] != spec['expectedFees'][k] for k in ('lpFeesRaw', 'protocolFeesRaw', 'donationsRaw')) or
                    ledger['growthX128'] != spec['historicalSnapshot']['feeGrowthGlobalX128'] or
                    any(activity[k] != spec['historicalSnapshot'][k] for k in ('sqrtPriceX96', 'tick', 'protocolFeeRaw')) or
                    str(active_liquidity(activity)) != spec['historicalSnapshot']['activeLiquidityRaw']):
                raise DataError('fee_benchmark_recorded_result_mismatch')
        report.update(result, inputSha256=digest(dataset), canonicality=dataset['canonicality'],
                      recordedResultMatched=result['status'] == 'measured',
                      currentCanonicalityAssessed=args.source in ('public-rpc', 'configured-rpc'))
        if args.events_output:
            write_new(args.events_output, dataset)
    except (DataError, BenchmarkLimit) as error:
        report.update(status='unavailable', reason=str(error), chunks=[], busiestExaminedChunk=None,
                      totalCandidateStepsAdmittedIncludingResume=None, totalStepAttemptsIncludingResume=None)
    except (OSError, KeyError, TypeError, ValueError, RecursionError):
        report.update(status='unavailable', reason='fee_benchmark_local_operation_unavailable',
                      chunks=[], busiestExaminedChunk=None, totalCandidateStepsAdmittedIncludingResume=None,
                      totalStepAttemptsIncludingResume=None)
    if rpc is not None:
        report['rpcRequests'] = rpc.count
    try:
        write_new(args.output, report)
    except (DataError, OSError):
        print(json.dumps({'status': 'unavailable', 'reason': 'fee_benchmark_output_unavailable'}));return 1
    print(json.dumps({k: report[k] for k in ('status', 'source', 'poolId')} |
                     ({'reason': report['reason']} if 'reason' in report else {})))
    return 0 if report['status'] == 'measured' else 1


if __name__ == '__main__':
    raise SystemExit(main())
