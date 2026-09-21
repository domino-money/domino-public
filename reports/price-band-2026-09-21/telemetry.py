#!/usr/bin/env python3
"""Offline telemetry for collect.mjs JSON: input --out TELEMETRY.json.

No network or signing. The CLI refuses an unfinished collector snapshot.
Reported canonicality is evidence from the input, never a new chain check.
"""
import argparse
from bisect import bisect_left
from decimal import Decimal, localcontext
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import re


HASH = re.compile(r'0x[0-9a-fA-F]{64}\Z')


def quantity(value):
    if type(value) is int:
        return value if value >= 0 else None
    if isinstance(value, str) and re.fullmatch(r'(?:[0-9]+|0x[0-9a-fA-F]+)', value):
        return int(value, 16 if value.startswith('0x') else 10)
    return None


def decimal(value):
    value = Fraction(value)
    with localcontext() as ctx:
        ctx.prec = 100
        return format((Decimal(value.numerator) / Decimal(value.denominator))
                      .quantize(Decimal('0.000000000001')), 'f')


def statistics(values):
    if not values:
        return {'count': 0, 'min': None, 'p50': None, 'p95': None, 'p99': None, 'max': None}
    ordered = sorted(Fraction(v) for v in values)
    result = {'count': len(ordered), 'min': decimal(ordered[0]), 'max': decimal(ordered[-1])}
    for p in (50, 95, 99):
        result['p' + str(p)] = decimal(ordered[(p * len(ordered) + 99) // 100 - 1])
    return result


def latency(value):
    if not isinstance(value, (int, float, str)) or isinstance(value, bool):
        return None
    try:
        number = Fraction(str(value))
        return number if number >= 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def latency_summary(values):
    parsed = [latency(value) for value in values]
    return {'sampleCount': len(parsed), 'missingOrInvalidTimingSamples': sum(v is None for v in parsed),
            'milliseconds': statistics([v for v in parsed if v is not None])}


def telemetry(document):
    if not isinstance(document, dict) or not isinstance(document.get('samples'), list) or not isinstance(document.get('pools'), list):
        raise ValueError('samples_and_pool_metadata_required')
    samples, metadata = document['samples'], document['pools']
    times = []
    for sample in samples:
        if not isinstance(sample, dict) or type(sample.get('observedAtUnixMs')) is not int or sample['observedAtUnixMs'] < 0:
            raise ValueError('integer_observation_time_required')
        times.append(sample['observedAtUnixMs'])
    if any(b < a for a, b in zip(times, times[1:])):
        raise ValueError('samples_not_chronological')
    ids = []
    for pool in metadata:
        if not isinstance(pool, dict) or not isinstance(pool.get('poolId'), str) or not HASH.fullmatch(pool['poolId']):
            raise ValueError('invalid_pool_metadata')
        ids.append(pool['poolId'].lower())
    if not ids or len(set(ids)) != len(ids):
        raise ValueError('missing_or_duplicate_pool_metadata')

    headers, hashes, invalid_hash_samples = [], {}, []
    for index, sample in enumerate(samples):
        number = quantity(sample.get('blockNumber'))
        if number is None:
            continue
        headers.append((index, number, times[index], quantity(sample.get('blockTimestamp'))))
        block_hash = sample.get('blockHash')
        if not isinstance(block_hash, str) or not HASH.fullmatch(block_hash):
            invalid_hash_samples.append(index)
            continue
        hashes.setdefault(number, {}).setdefault(block_hash.lower(), []).append(index)
    conflicts = [{'blockNumber': n, 'hashes': [{'blockHash': h, 'sampleIndexes': indexes}
                 for h, indexes in sorted(variants.items())]}
                 for n, variants in sorted(hashes.items()) if len(variants) > 1]
    regressions = [{'previousSampleIndex': a[0], 'sampleIndex': b[0], 'previousBlock': a[1], 'block': b[1]}
                   for a, b in zip(headers, headers[1:]) if b[1] < a[1]]
    numbers = [h[1] for h in headers]
    span = max(numbers) - min(numbers) if numbers else None
    first, last = (headers[0], headers[-1]) if headers else (None, None)
    elapsed_ms = last[2] - first[2] if headers else None
    chain_seconds = last[3] - first[3] if headers and first[3] is not None and last[3] is not None else None
    cadence_ok = bool(headers and not regressions and span and elapsed_ms > 0)

    durations, brackets, crossed, censored, lower_bounds = [], [], [], [], []
    if not regressions:
        for index, source in enumerate(headers):
            target = bisect_left(numbers, source[1] + 256, lo=index + 1)
            if target == len(headers):
                censored.append(source[0])
                lower_bounds.append(last[2] - source[2])
                continue
            future, previous = headers[target], headers[target - 1]
            durations.append(future[2] - source[2])
            brackets.append(future[2] - previous[2])
            crossed.append(future[1] - source[1])
    expiry = {
        'available': bool(headers) and not regressions,
        'unavailableReason': 'observed_block_number_regression' if regressions else 'no_valid_headers' if not headers else None,
        'eligibleReferenceSamples': len(headers) if not regressions else 0,
        'observedCrossings': len(durations), 'rightCensoredReferenceSamples': len(censored),
        'elapsedUntilFirstSampleAtLeast256BlocksAheadMs': statistics(durations),
        'crossingObservationBracketMs': statistics(brackets),
        'observedBlocksAtCrossing': statistics(crossed),
        'rightCensoredObservedLowerBoundMs': statistics(lower_bounds),
        'method': 'For each observed header, find the first later sampled header >= source block + 256. Requires nondecreasing observed block numbers. Duplicate heights remain separate observation-time references.',
        'censoring': 'References with no sampled crossing by the last valid header are right-censored, not zero-duration crossings; quantiles use completed crossings only and can bias short. Missing headers hide the true crossing and widen sampling uncertainty.',
        'resolution': 'The crossing lies between the previous observed header and the first threshold-crossing header, subject to RPC/head staleness. Times are local header-receipt wall times, not canonical block arrival times; this is not a precisely measured on-chain TTL.',
    }

    pools = []
    for pool, pool_id in zip(metadata, ids):
        timings, errors, absent, duplicates = [], 0, 0, 0
        for sample in samples:
            rows = sample.get('pools', [])
            matches = [row for row in rows if isinstance(row, dict) and str(row.get('poolId', '')).lower() == pool_id] if isinstance(rows, list) else []
            if len(matches) != 1:
                absent += not matches
                duplicates += len(matches) > 1
                timings.append(None)
                continue
            errors += matches[0].get('error') is not None
            timings.append(matches[0].get('rpcLatencyMs'))
        pools.append({'poolId': pool_id, 'label': pool.get('label'),
                      'poolKeyHashVerified': pool.get('poolKeyHashVerified'),
                      'reportedErrors': errors, 'absentRows': absent, 'duplicateRows': duplicates,
                      'slot0CallRtt': latency_summary(timings)})

    declared_noncanonical = document.get('noncanonicalBlocks')
    declared_count = document.get('canonicalityCheckedBlocks')
    unique_heights = len(set(numbers))
    complete_declared_check = (document.get('status') == 'completed'
        and type(declared_count) is int and declared_count == unique_heights and unique_heights > 0
        and declared_noncanonical == [] and not conflicts and not invalid_hash_samples)
    return {
        'schemaVersion': 1, 'kind': 'domino-price-band-offline-telemetry', 'fullyQualified': False,
        'source': {name: document.get(name) for name in ('chainId', 'source', 'startedAtUTC', 'endedAtUTC',
            'requestedSeconds', 'intervalMs', 'observedDurationMs', 'status', 'collectorSha256',
            'canonicalityCheckedBlocks', 'noncanonicalBlocks', 'independentOracle', 'warnings')},
        'sampleCount': len(samples), 'observedSpanMs': times[-1] - times[0] if times else None,
        'sampleSpacingMs': statistics([b-a for a, b in zip(times, times[1:])]),
        'headerCallRtt': latency_summary([s.get('headerRpcLatencyMs') for s in samples]),
        'cycleDuration': latency_summary([s.get('rpcLatencyMs') for s in samples]),
        'cyclesWithReportedErrors': sum(s.get('error') is not None for s in samples),
        'pools': pools,
        'blockCadence': {'validHeaderSamples': len(headers), 'missingBlockNumberSamples': len(samples)-len(headers),
            'uniqueHeights': unique_heights, 'minimumBlock': min(numbers) if numbers else None,
            'maximumBlock': max(numbers) if numbers else None, 'blockSpan': span,
            'observedHeadersMonotonic': not regressions, 'regressions': regressions,
            'localObservedElapsedMs': elapsed_ms, 'recordedHeaderTimestampSpanSeconds': chain_seconds,
            'averageLocalObservedMsPerBlock': decimal(Fraction(elapsed_ms, span)) if cadence_ok else None,
            'averageHeaderTimestampMsPerBlock': decimal(Fraction(chain_seconds*1000, span))
                if cadence_ok and chain_seconds is not None and chain_seconds >= 0 else None},
        'window256Blocks': expiry,
        'hashAudit': {'scope': 'Every sampled hash for each height; no last-hash overwrite.',
            'uniqueHeightHashPairs': sum(len(variants) for variants in hashes.values()),
            'conflictingHeightCount': len(conflicts), 'conflicts': conflicts,
            'missingOrInvalidHashSampleIndexes': invalid_hash_samples,
            'declaredFinalCheckCompleteAndNoObservedHashConflict': complete_declared_check,
            'independentChainRecheckPerformed': False},
        'method': {'percentiles': 'nearest rank; all durations in milliseconds; decimal display rounded to 12 places',
            'rtt': 'Header and per-pool fields measure individual successful HTTP RPC calls. Cycle includes header followed by all parallel pool reads; failures can consume cycle time without an individual RTT record.'},
        'limitations': [
            'No publisher, signer, queue, submission, inclusion or production execution latency is measured.',
            'Mac/SSH tunnel measurements do not qualify the runtime VM/HTTPS route.',
            'No new canonicality or finality RPC check: input status and final-check counts are declarations bound to the input SHA.',
            'Absence of conflicting sampled hashes does not prove absence of reorgs between samples or after the final check.',
            'Timing quantiles exclude unavailable per-call timings, including failed requests; they are not an availability SLA.',
            'Headers can be skipped/repeated and local wall-clock jumps are not measured; average cadence and crossing times are descriptive.',
            'Crossing pairs overlap and are correlated; the last part of the series is right-censored.',
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(argv)
    if args.input.resolve() == args.out.resolve():
        raise ValueError('output_must_differ_from_input')
    raw = args.input.read_bytes()
    document = json.loads(raw)
    if not isinstance(document, dict) or document.get('status') not in ('completed', 'failed', 'noncanonical_samples_detected'):
        raise ValueError('collector_not_finished')
    result = telemetry(document)
    result['inputSha256'] = sha256(raw).hexdigest()
    result['inputBytes'] = len(raw)
    result['telemetrySha256'] = sha256(Path(__file__).read_bytes()).hexdigest()
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
