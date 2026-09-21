#!/usr/bin/env python3
"""Pure spot-to-spot price-band replay. No network, keys, signing or transactions.

Input: {pools: [{poolId, ...metadata}], samples: [{observedAtUnixMs,
blockNumber, blockTimestamp, rpcLatencyMs, pools: [{poolId, sqrtPriceX96,
tick, error?}]}], metadata?: {...}}. Timestamps must be ordered integer ms;
quantities may be integers or decimal/hex strings. Missing pool reads remain
missing at the first future sample, never silently replaced by a later read.

The contract calls _withinBand(referenceSqrt, publicationSpotSqrt). Thus the
denominator is the later spot, not the original reference. Decisions use only
integers; decimal statistics are presentation, using nearest-rank percentiles.
"""
import argparse
from bisect import bisect_left
from collections import Counter
from decimal import Decimal, localcontext
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import re

DELAYS_MS = (500, 1000, 2000, 5000, 10000, 20000, 30000, 60000)
BANDS_BPS = (25, 50, 100, 200, 2000)
MAX_SQRT = 2**160 - 1
POOL_ID = re.compile(r'0x[0-9a-fA-F]{64}\Z')


def quantity(value):
    if type(value) is int:
        return value if value >= 0 else None
    if isinstance(value, str):
        if re.fullmatch(r'[0-9]+', value):
            return int(value)
        if re.fullmatch(r'0x[0-9a-fA-F]+', value):
            return int(value, 16)
    return None


def within_band(reference, spot, bps):
    """Exactly matches the Solidity guard for valid uint160 prices/band."""
    if any(type(v) is not int for v in (reference, spot, bps)):
        raise ValueError('integer_guard_inputs_required')
    if not 1 <= bps < 10000 or not 0 <= reference <= MAX_SQRT or not 0 <= spot <= MAX_SQRT:
        raise ValueError('guard_input_out_of_range')
    return reference > 0 and spot > 0 and abs(reference - spot) * 10000 <= spot * bps


def decimal(value):
    with localcontext() as ctx:
        ctx.prec = 160
        return format((Decimal(value.numerator) / Decimal(value.denominator))
                      .quantize(Decimal('0.000000000001')), 'f')


def statistics(values):
    if not values:
        return {'count': 0, 'min': None, 'p50': None, 'p95': None, 'p99': None, 'max': None}
    ordered = sorted(Fraction(value) for value in values)
    out = {'count': len(ordered), 'min': decimal(ordered[0]), 'max': decimal(ordered[-1])}
    for percentile in (50, 95, 99):
        index = (percentile * len(ordered) + 99) // 100 - 1
        out['p' + str(percentile)] = decimal(ordered[index])
    out['maxExact'] = {'numerator': str(ordered[-1].numerator), 'denominator': str(ordered[-1].denominator)}
    return out


def price_read(sample, pool_id):
    rows = sample.get('pools', [])
    if not isinstance(rows, list):
        return None, 'invalid_pool_list'
    matches = [row for row in rows if isinstance(row, dict)
               and isinstance(row.get('poolId'), str) and row['poolId'].lower() == pool_id]
    if not matches:
        return None, 'absent_pool'
    if len(matches) != 1:
        return None, 'duplicate_pool'
    row = matches[0]
    if row.get('error') is not None:
        return None, 'reported_error'
    value = quantity(row.get('sqrtPriceX96'))
    if value is None or not 0 < value <= MAX_SQRT:
        return None, 'invalid_sqrt_price'
    return value, None


def block_window(source, future):
    before, after = quantity(source.get('blockNumber')), quantity(future.get('blockNumber'))
    if before is None or after is None:
        return 'unavailable', None
    distance = after - before
    if distance <= 0:
        return 'not_strictly_older', distance
    if distance >= 256:
        return 'exceeds_255_blocks', distance
    return 'within_1_to_255_blocks', distance


def qualification_status(document):
    """Classify the collector's declared evidence, never certify production."""
    status = document.get('status')
    noncanonical = document.get('noncanonicalBlocks')
    if status == 'noncanonical_samples_detected' or isinstance(noncanonical, list) and noncanonical:
        return 'not_qualified_noncanonical_input'
    if status is None:
        return 'not_qualified_collection_status_unavailable'
    if status != 'completed':
        return 'not_qualified_incomplete_collection'
    if any(not isinstance(document.get(key), str) or not document[key].strip()
           for key in ('source', 'startedAtUTC', 'endedAtUTC')) or not re.fullmatch(
               r'[0-9a-fA-F]{64}', str(document.get('collectorSha256', ''))):
        return 'not_qualified_incomplete_provenance'
    checked = document.get('canonicalityCheckedBlocks')
    if type(checked) is not int or checked < 0 or not isinstance(noncanonical, list):
        return 'not_qualified_canonicality_unavailable'
    blocks = {quantity(s.get('blockNumber')) for s in document['samples']}
    blocks.discard(None)
    if not blocks:
        return 'not_qualified_no_recorded_blocks'
    if checked < len(blocks):
        return 'not_qualified_incomplete_canonicality'
    return 'completed_descriptive_collection_only'


def analyze(document, delays_ms=DELAYS_MS, bands_bps=BANDS_BPS):
    if not isinstance(document, dict) or not isinstance(document.get('samples'), list) or not isinstance(document.get('pools'), list):
        raise ValueError('samples_and_pool_metadata_required')
    if not delays_ms or any(type(d) is not int or d <= 0 for d in delays_ms) or len(set(delays_ms)) != len(delays_ms):
        raise ValueError('invalid_delays')
    if not bands_bps or any(type(b) is not int or not 1 <= b < 10000 for b in bands_bps) or len(set(bands_bps)) != len(bands_bps):
        raise ValueError('invalid_bands')
    samples = document['samples']
    times = []
    for sample in samples:
        if not isinstance(sample, dict) or type(sample.get('observedAtUnixMs')) is not int or sample['observedAtUnixMs'] < 0:
            raise ValueError('integer_observation_time_required')
        times.append(sample['observedAtUnixMs'])
    if any(b < a for a, b in zip(times, times[1:])):
        raise ValueError('samples_not_chronological')
    ids = []
    for pool in document['pools']:
        if not isinstance(pool, dict) or not isinstance(pool.get('poolId'), str) or not POOL_ID.fullmatch(pool['poolId']):
            raise ValueError('invalid_pool_metadata')
        ids.append(pool['poolId'].lower())
    if not ids or len(ids) != len(set(ids)):
        raise ValueError('missing_or_duplicate_pool_metadata')
    latencies = []
    for sample in samples:
        value = sample.get('rpcLatencyMs')
        if isinstance(value, (int, float, str)) and not isinstance(value, bool):
            try:
                number = Fraction(str(value))
                if number >= 0:
                    latencies.append(number)
            except (ValueError, ZeroDivisionError):
                pass
    output = {
        'schemaVersion': 1,
        'scope': 'observed spot-to-spot replay; not an independently sourced publisher or a production execution replay',
        'metadata': document.get('metadata'),
        'inputRecord': {key: document[key] for key in ('status', 'source', 'startedAtUTC', 'endedAtUTC',
            'collectorSha256', 'canonicalityCheckedBlocks', 'noncanonicalBlocks') if key in document},
        'qualificationStatus': qualification_status(document),
        'productionQualificationComplete': False,
        'inputSha256': None,  # CLI hashes the exact byte buffer that was parsed.
        'inputByteLength': None,
        'sampleCount': len(samples),
        'observedSpanMs': times[-1] - times[0] if times else None,
        'sampleSpacingMs': statistics([b-a for a, b in zip(times, times[1:])]),
        'rpcLatencyMs': statistics(latencies),
        'missingRpcLatencySamples': len(samples) - len(latencies),
        'method': {
            'requestedDelaysMs': list(delays_ms),
            'bandsBps': list(bands_bps),
            'futureSample': 'first global sample with observedAtUnixMs >= reference time + requested delay; missing reads are not skipped',
            'guardDecision': 'abs(referenceSqrt - laterSpotSqrt) * 10000 <= laterSpotSqrt * bandBps; both prices nonzero',
            'absoluteSqrtDriftBps': 'abs(referenceSqrt - laterSpotSqrt) * 10000 / laterSpotSqrt',
            'absolutePriceDriftBps': 'abs(referenceSqrt^2 - laterSpotSqrt^2) * 10000 / laterSpotSqrt^2',
            'percentiles': 'nearest rank over valid pairs; decimals rounded to 12 places for display only',
            'blockWindow': 'source block must be strictly older and no more than 255 L2 blocks behind the later sample',
        },
        'limitations': [
            'No independently sourced price, publisher signing, submission or inclusion latency is measured.',
            'Collector completion and canonicality fields are preserved input claims, not independently verified by this pure analyzer. Partial, absent-status or noncanonical inputs cannot complete qualification.',
            'Passing the band does not establish safety against pre-observation manipulation.',
            'A wider band cannot make an observation older than 255 L2 blocks admissible; 30/60-second delays expose this separate constraint.',
            'Block distance is checked when available; canonical hashes, observation expiry, wall-clock age policy, execution slippage, impact and plan limits are not replayed.',
            'Overlapping delay pairs are correlated; percentiles/rejection rates are descriptive, not statistical guarantees.',
            'The first available global sample can overshoot the requested delay; actual delays and overshoot are reported.',
            'Missing observations and unchanged prices do not demonstrate low risk or future availability.',
        ],
        'pools': [],
    }
    for metadata, pool_id in zip(document['pools'], ids):
        readings = [price_read(sample, pool_id) for sample in samples]
        prices = [value for value, _ in readings]
        errors = Counter(reason for _, reason in readings if reason is not None)
        adjacent = [(a, b) for a, b in zip(prices, prices[1:]) if a is not None and b is not None]
        quality = {
            'validPriceSamples': sum(value is not None for value in prices),
            'missingPriceSamples': sum(errors.values()), 'missingReasons': dict(sorted(errors.items())),
            'distinctSqrtPrices': len({value for value in prices if value is not None}),
            'validAdjacentPairs': len(adjacent),
            'unchangedAdjacentPairs': sum(a == b for a, b in adjacent),
            'changedAdjacentPairs': sum(a != b for a, b in adjacent),
        }
        pool = {'poolId': pool_id, 'metadata': metadata, 'quality': quality, 'delays': []}
        pool['movementEvidence'] = ('unavailable' if quality['validPriceSamples'] == 0 else
            'insufficient_valid_samples' if quality['validPriceSamples'] < 2 else
            'no_observed_price_change' if quality['distinctSqrtPrices'] == 1 else 'observed_price_changes')
        for delay in delays_ms:
            counts = Counter()
            window_counts = Counter()
            sqrt_drift, price_drift, actual_delays, overshoots, distances = [], [], [], [], []
            bands = {str(b): {'accepted': 0, 'rejected': 0, 'acceptedWithinBlockWindow': 0,
                              'rejectedWithinBlockWindow': 0} for b in bands_bps}
            for index, source in enumerate(samples):
                reference = prices[index]
                if reference is None:
                    counts['referenceMissing'] += 1
                    continue
                future_index = bisect_left(times, times[index] + delay, lo=index+1)
                if future_index == len(samples):
                    counts['noFutureSample'] += 1
                    continue
                spot = prices[future_index]
                if spot is None:
                    counts['futureMissing'] += 1
                    continue
                counts['validPricePairs'] += 1
                counts['unchangedPairs' if reference == spot else 'changedPairs'] += 1
                actual = times[future_index] - times[index]
                actual_delays.append(actual)
                overshoots.append(actual - delay)
                window, distance = block_window(source, samples[future_index])
                window_counts[window] += 1
                if distance is not None:
                    distances.append(distance)
                sqrt_drift.append(Fraction(abs(reference-spot)*10000, spot))
                price_drift.append(Fraction(abs(reference*reference-spot*spot)*10000, spot*spot))
                for band in bands_bps:
                    accepted = within_band(reference, spot, band)
                    bands[str(band)]['accepted' if accepted else 'rejected'] += 1
                    if window == 'within_1_to_255_blocks':
                        bands[str(band)]['acceptedWithinBlockWindow' if accepted else 'rejectedWithinBlockWindow'] += 1
            total = counts['validPricePairs']
            for row in bands.values():
                row['rejectionRatePercent'] = decimal(Fraction(row['rejected']*100, total)) if total else None
            pool['delays'].append({
                'requestedDelayMs': delay,
                **{name: counts[name] for name in ('referenceMissing', 'noFutureSample', 'futureMissing', 'validPricePairs', 'unchangedPairs', 'changedPairs')},
                'blockWindow': {name: window_counts[name] for name in ('within_1_to_255_blocks', 'exceeds_255_blocks', 'not_strictly_older', 'unavailable')},
                'actualDelayMs': statistics(actual_delays), 'delayOvershootMs': statistics(overshoots),
                'blockDistance': statistics(distances),
                'absoluteSqrtDriftBps': statistics(sqrt_drift),
                'absolutePriceDriftBps': statistics(price_drift), 'bands': bands,
            })
        output['pools'].append(pool)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args(argv)
    raw = args.input.read_bytes()
    result = analyze(json.loads(raw))
    result['inputSha256'] = sha256(raw).hexdigest()
    result['inputByteLength'] = len(raw)
    rendered = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + '\n'
    if args.out:
        args.out.write_text(rendered)
    else:
        print(rendered, end='')


if __name__ == '__main__':
    main()
