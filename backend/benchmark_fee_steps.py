"""Bounded fee-candidate step measurement for the recorded public qualification window.

No core math changes, ledger writes or provider configuration in output. A stored
or exported input measures replay work; it does not establish current canonicality.
"""
import argparse
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import time

from catalogue import PgCatalogue, checked_key, database_settings
from catalogue_indexer import IndexRpc
from discovery import CHAIN_ID, POOL_MANAGER, RPC_URL, DataError, parse_block, quantity
from fee_accounting import MAX_CHUNK_STEPS, MAX_STEPS, replay_fees
from historical_capacity import MAX_BATCH_EVENTS, replay_batch
from local_config import load_config
from pool_activity import TOPICS, active_liquidity, decode_activity
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
        measured.append(result)
        if offset != len(events):
            break
    complete = len(measured) == len(chunks) and all(c['resumeStatus'] == 'complete' for c in measured)
    return {'status': 'measured' if complete else 'incomplete', 'chunks': measured,
            'busiestExaminedChunk': max(measured, key=lambda c: c['candidateStepsAdmitted']) if measured else None,
            'busiestScope': 'only_the_examined_historical_chunks', 'allChunksWithinSinglePassBudget':
                complete and all(c['status'] == 'within_budget' for c in measured),
            'totalCandidateStepsAdmittedIncludingResume': work.admitted, 'totalStepAttemptsIncludingResume': work.attempts,
            'finalActivity': activity, 'finalLedger': ledger}


def write_new(path, value):
    raw = json.dumps(value, indent=2, allow_nan=False).encode()+b'\n'
    if len(raw) > MAX_INPUT_BYTES:
        raise DataError('fee_benchmark_output_budget')
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('catalogue', 'public-rpc', 'configured-rpc', 'fixture'), required=True)
    parser.add_argument('--database-config', type=Path)
    parser.add_argument('--provider-config', type=Path, help='Required for configured-rpc; existing private product configuration.')
    parser.add_argument('--fixture', type=Path)
    parser.add_argument('--events-output', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
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
            rpc = IndexRpc(config.get('rpcUrl', RPC_URL), transport=bounded_transport(ACQUISITION_SECONDS),
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
