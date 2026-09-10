"""Bounded historical reference analytics; never a production execution oracle.

The named tolerance below is Domino's analytics policy, not a Chainlink SLA.
Publication controls availability; answerUpdatedAt controls expiry. A reference
is usable only inside its revalidated evidence window, including its snapshot.
"""
from bisect import bisect_right
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json

from chainlink_history import (ADAPTER_VERSION, FEEDS, MANIFEST_SHA256, MAX_ROUNDS,
                              ROUND_TYPES, SOURCE, USDG, WETH)
from catalogue import checked_key
from discovery import CHAIN_ID, ZERO, DataError, address, bytes32, parse_block, quantity
from price_history import PriceSeries, usd

POLICY = 'chainlink_robinhood_reference_analytics_v1'
HEARTBEAT_SECONDS = 86400
PUBLICATION_GRACE_SECONDS = 120
MAX_AGE_SECONDS = HEARTBEAT_SECONDS + PUBLICATION_GRACE_SECONDS
DECIMALS = {ZERO: 18, WETH: 18, USDG: 6}
MAPPINGS = {ZERO: 'native_eth', WETH: 'canonical_weth_reference', USDG: 'canonical_usdg_reference'}


def _integer(value, *, minimum=0, maximum=2**63-1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise DataError('invalid_chainlink_observation')
    return value


def _raw(value, *, maximum):
    if (not isinstance(value, str) or not value.isascii() or not value.isdecimal()
            or len(value) > 78 or not 0 < int(value) < maximum):
        raise DataError('invalid_chainlink_observation')
    return int(value)


def _block(value):
    if not isinstance(value, dict):
        raise DataError('invalid_chainlink_observation')
    return (_integer(value.get('number')), bytes32(value.get('hash')),
            _integer(value.get('timestamp')))


def validate_observation(row):
    """Validate evidence shape/identity, without asserting truth or qualification."""
    if not isinstance(row, dict):
        raise DataError('invalid_chainlink_observation')
    currency = address(row.get('currency'))
    feed = FEEDS.get(currency)
    p = row.get('provenance')
    if (feed is None or row.get('currency') != currency or type(row.get('chainId')) is not int or row['chainId'] != CHAIN_ID
            or row.get('source') != SOURCE or not isinstance(p, dict)):
        raise DataError('invalid_chainlink_observation')
    expected = {'adapterVersion': ADAPTER_VERSION, 'status': 'external_observation_unqualified',
                'provider': 'chainlink', 'proxyRole': 'standard', 'proxy': feed.proxy,
                'aggregator': feed.aggregator, 'phaseId': feed.phase,
                'feedDecimals': feed.decimals, 'currencyDecimals': DECIMALS[currency],
                'currencyMapping': MAPPINGS[currency], 'manifestSha256': MANIFEST_SHA256,
                'timestampSemantics': 'first_proven_publication_block',
                'freshnessTimestamp': 'answerUpdatedAt', 'targetPoolIndependenceVerified': False}
    if any(p.get(k) != v or type(p.get(k)) is not type(v) for k, v in expected.items()):
        raise DataError('invalid_chainlink_observation')
    pub, prev = _block(p.get('publicationBlock')), _block(p.get('precedingBlock'))
    at, retrieved = _integer(row.get('timestamp')), _integer(row.get('retrievedAt'))
    updated = _integer(p.get('answerUpdatedAt'), minimum=1)
    started = _integer(p.get('answerStartedAt'), minimum=1)
    round_id = _raw(p.get('roundId'), maximum=2**80)
    preceding_round = _raw(p.get('precedingRoundId'), maximum=2**80)
    answered = _raw(p.get('answeredInRound'), maximum=2**80)
    answer = _raw(p.get('answerRaw'), maximum=2**255)
    if (not started <= updated <= pub[2] == at <= retrieved or
            pub[0] != prev[0]+1 or prev[2] > pub[2] or
            round_id >> 64 != feed.phase or not round_id & (2**64-1) or
            preceding_round >> 64 != feed.phase or preceding_round >= round_id or
            answered != round_id or usd(row.get('priceUsd')) != Fraction(answer, 10**feed.decimals)):
        raise DataError('invalid_chainlink_observation')
    return row


@dataclass(frozen=True)
class _ReferenceQualification:
    currency: str
    decimals: int
    target_pool: str
    evidence: str
    start: int
    end: int
    currencies: tuple
    source: str = SOURCE
    max_age: int = MAX_AGE_SECONDS
    reference_only: bool = True


class _ReferenceSeries(PriceSeries):
    def __init__(self, qualification, observations):
        super().__init__(qualification, observations)
        rows = sorted(observations, key=lambda row: row['timestamp'])
        if len(self.times) != len(rows):
            raise DataError('chainlink_publication_timestamp_ambiguous')
        # Block ordering within a second is absent in the valuation engine.
        # Defer the new answer for the WHOLE publication second, even at its end.
        self.times = [row['timestamp']+1 for row in rows]
        self.expires = [row['provenance']['answerUpdatedAt']+MAX_AGE_SECONDS for row in rows]

    def at(self, at):
        q = self.qualification
        index = bisect_right(self.times, at)-1
        if not q.start <= at <= q.end or index < 0 or at > self.expires[index]:
            raise DataError('qualified_price_coverage_gap')
        return self.values[index]

    def boundaries(self, start, end):
        return {t for t in (*self.times, *self.expires) if start < t < end}


def reference_series(bundle, target_pool, rpc, *, pool_key):
    """Revalidate stored/fresh proofs before constructing an offline-only series.

    No HTTP route calls this factory and it never changes the production registry.
    Existing proofs cannot be made current by modifying retrieval timestamps.
    """
    target_pool = bytes32(target_pool)
    key = checked_key(pool_key, target_pool)
    currencies = (key.currency0, key.currency1)
    if not isinstance(bundle, dict):
        raise DataError('invalid_chainlink_reference_bundle')
    rows = bundle.get('observations')
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROUNDS:
        raise DataError('invalid_chainlink_reference_bundle')
    for row in rows:
        validate_observation(row)
    currency = rows[0]['currency']
    if currency not in currencies or any(row['currency'] != currency for row in rows):
        raise DataError('invalid_chainlink_reference_bundle')
    feed = FEEDS[currency]
    feed_metadata = bundle.get('feed')
    expected_feed = {'proxy': feed.proxy, 'aggregator': feed.aggregator, 'description': feed.description,
                     'decimals': feed.decimals, 'phase': feed.phase, 'source': SOURCE,
                     'proxyRole': 'standard', 'currency': currency, 'currencyDecimals': DECIMALS[currency]}
    if not isinstance(feed_metadata, dict) or any(feed_metadata.get(k) != v for k, v in expected_feed.items()):
        raise DataError('invalid_chainlink_reference_bundle')
    coverage = bundle.get('coverage', {})
    if not isinstance(coverage, dict):
        raise DataError('invalid_chainlink_reference_bundle')
    start, end = _integer(coverage.get('startTimestamp')), _integer(coverage.get('endTimestamp'))
    snapshot = _block(bundle.get('snapshot'))
    end_block = _block(coverage.get('endBlock'))
    if not start < end <= snapshot[2] or end-start > 86400+600:
        raise DataError('invalid_chainlink_reference_bundle')
    if end_block[2] > end or end_block[0] > snapshot[0]:
        raise DataError('invalid_chainlink_reference_bundle')
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
        raise DataError('wrong_chain')
    blocks = {snapshot[0]: snapshot, end_block[0]: end_block}
    if snapshot[0] == end_block[0] and snapshot != end_block:
        raise DataError('chainlink_proof_conflict')
    if end_block[0] < snapshot[0]:
        successor = parse_block(rpc.request('eth_getBlockByNumber', [hex(end_block[0]+1), False]))
        if successor.number != end_block[0]+1 or successor.timestamp <= end:
            raise DataError('invalid_chainlink_reference_bundle')
        blocks[successor.number] = (successor.number, successor.hash, successor.timestamp)
    for row in rows:
        for key in ('publicationBlock', 'precedingBlock'):
            block = _block(row['provenance'][key])
            if block[0] > end_block[0] or block[2] > end:
                raise DataError('invalid_chainlink_reference_bundle')
            if block[0] in blocks and blocks[block[0]] != block:
                raise DataError('chainlink_proof_conflict')
            blocks[block[0]] = block

    def recheck():
        for number, expected_hash, timestamp in blocks.values():
            actual = parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False]))
            if (actual.number, actual.hash, actual.timestamp) != (number, expected_hash, timestamp):
                raise DataError('chainlink_snapshot_reorganized')

    def call(signature, block, outputs, inputs=(), values=(), target=feed.proxy):
        return rpc.call(target, signature, inputs, values, outputs,
                        block={'blockHash': block[1], 'requireCanonical': True})

    recheck()
    for boundary in (snapshot, end_block, blocks[min(blocks)]):
        aggregator, = call('aggregator()', boundary, ('address',))
        phase, = call('phaseId()', boundary, ('uint16',))
        decimals, = call('decimals()', boundary, ('uint8',))
        description, = call('description()', boundary, ('string',))
        mapped, = call('phaseAggregators(uint16)', boundary, ('address',), ('uint16',), (feed.phase,))
        token_decimals = 18 if currency == ZERO else call('decimals()', boundary, ('uint8',), target=currency)[0]
        if (address(aggregator) != feed.aggregator or address(mapped) != feed.aggregator
                or phase != feed.phase or decimals != feed.decimals or description != feed.description
                or token_decimals != DECIMALS[currency]):
            raise DataError('chainlink_configuration_changed')
    for row in rows:
        p = row['provenance']
        expected = (int(p['roundId']), int(p['answerRaw']), p['answerStartedAt'],
                    p['answerUpdatedAt'], int(p['answeredInRound']))
        published = call('latestRoundData()', _block(p['publicationBlock']), ROUND_TYPES)
        historical = call('getRoundData(uint80)', snapshot, ROUND_TYPES, ('uint80',), (expected[0],))
        previous = call('latestRoundData()', _block(p['precedingBlock']), ROUND_TYPES)
        if tuple(published) != expected or tuple(historical) != expected or previous[0] != int(p['precedingRoundId']):
            raise DataError('chainlink_round_revision')
    ordered = sorted(rows, key=lambda row: row['timestamp'])
    if any(int(b['provenance']['precedingRoundId']) != int(a['provenance']['roundId'])
           for a, b in zip(ordered, ordered[1:])):
        raise DataError('chainlink_reference_history_gap')
    # A truncated bundle must not hold an old answer across omitted later rounds.
    tail = call('latestRoundData()', end_block, ROUND_TYPES)
    if tail[0] != int(ordered[-1]['provenance']['roundId']):
        raise DataError('chainlink_reference_history_gap')
    recheck()
    digest = hashlib.sha256(json.dumps(bundle, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    qualification = _ReferenceQualification(currency, DECIMALS[currency], target_pool, digest, start, end, currencies)
    series = _ReferenceSeries(qualification, ordered)
    series.require_coverage(start, end)
    return series, {'policy': POLICY, 'status': 'reference_analytics_only', 'evidenceSha256': digest,
        'currency': currency, 'targetPool': target_pool, 'poolKey': pool_key,
        'startTimestamp': start, 'endTimestamp': end,
        'snapshot': bundle['snapshot'], 'maxAgeSeconds': MAX_AGE_SECONDS,
        'heartbeatSeconds': HEARTBEAT_SECONDS, 'publicationGraceSeconds': PUBLICATION_GRACE_SECONDS,
        'ageOrigin': 'answerUpdatedAt', 'availability': 'publication_timestamp_plus_one_second',
        'coverage': 'complete', 'canonicality': 'proof_blocks_rechecked',
        'priceKind': 'external_cex_reference', 'isChainlinkSla': False,
        'executionAvailable': False, 'productionQualified': False}
