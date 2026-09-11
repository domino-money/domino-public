"""Finite, resumable archive acquisition at one immutable historical snapshot.

A collection is evidence, never a qualification. Slices retain every round;
overlapping copies are deduplicated only when their original proofs agree.
"""
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
import time

from chainlink_history import ChainlinkHistorical, FEEDS, MANIFEST_SHA256, MAX_ROUNDS, SOURCE
from discovery import CHAIN_ID, ZERO, DataError, address, bytes32, parse_block, quantity
from price_history import MAX_PRICE_ROWS, MAX_PRICE_WINDOW_SECONDS, SUPPORTED_MIN_CADENCE_SECONDS

DEFAULT_SLICE_SECONDS = (MAX_ROUNDS - 2) * SUPPORTED_MIN_CADENCE_SECONDS
MAX_SLICES = MAX_PRICE_ROWS
MAX_TOTAL_ROWS = MAX_PRICE_ROWS + 2 * MAX_SLICES
MAX_STEPS = 4
SLICE_RPC_REQUESTS = 1600
INVOCATION_RPC_REQUESTS = MAX_STEPS * SLICE_RPC_REQUESTS + 2
# Two passes over snapshot, slice boundaries and all publication/predecessor headers.
STORAGE_RPC_REQUESTS = 2 * (2 + MAX_SLICES + 2 * MAX_PRICE_ROWS)
INVOCATION_SECONDS = 480
REFERENCE_RPC_REQUESTS = 15000
MODE = 'bounded_chainlink_collection'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def integer(value, low=0, high=2**63-1):
    if type(value) is not int or not low <= value <= high:
        raise DataError('invalid_chainlink_collection')
    return value


def block(value):
    if not isinstance(value, dict) or set(value) != {'number', 'hash', 'timestamp'}:
        raise DataError('invalid_chainlink_collection')
    integer(value['number']);integer(value['timestamp'])
    if bytes32(value['hash']) != value['hash']:
        raise DataError('invalid_chainlink_collection')
    return value


class BudgetRpc:
    """Bound work even if an embedding caller supplies an unlimited RPC client.

    The caller must also bound each transport call. The CLI clamps socket
    timeouts to its remaining budget; these before/after-call guards are
    cooperative, not a hard cancellation of an in-flight response stream.
    """
    def __init__(self, rpc, *, max_requests, seconds, monotonic=time.monotonic):
        self.rpc, self.limit, self.count = rpc, max_requests, 0
        self.monotonic, self.deadline = monotonic, monotonic() + seconds

    def _call(self, method, *args, **kwargs):
        if self.monotonic() >= self.deadline:
            raise DataError('chainlink_collection_deadline_exhausted')
        if self.count >= self.limit:
            raise DataError('chainlink_collection_rpc_budget_exhausted')
        self.count += 1
        result = getattr(self.rpc, method)(*args, **kwargs)
        if self.monotonic() >= self.deadline:
            raise DataError('chainlink_collection_deadline_exhausted')
        return result

    def request(self, *args, **kwargs):
        return self._call('request', *args, **kwargs)

    def call(self, *args, **kwargs):
        return self._call('call', *args, **kwargs)


def begin_collection(currency, start, end, rpc, *, block_number=None):
    currency = address(currency)
    if currency not in FEEDS:
        raise DataError('chainlink_currency_unsupported')
    integer(start);integer(end, start+1, min(2**63-1, start+MAX_PRICE_WINDOW_SECONDS))
    if block_number is not None:
        integer(block_number)
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
        raise DataError('wrong_chain')
    snapshot = parse_block(rpc.request('eth_getBlockByNumber',
                                      ['latest' if block_number is None else hex(block_number), False]))
    if (end > snapshot.timestamp or (block_number is not None and snapshot.number != block_number)):
        raise DataError('chainlink_snapshot_time_mismatch')
    identity = {'schemaVersion': 1, 'mode': MODE, 'chainId': CHAIN_ID,
                'currency': currency, 'startTimestamp': start, 'endTimestamp': end,
                'snapshot': asdict(snapshot), 'manifestSha256': MANIFEST_SHA256}
    return {**identity, 'collectionId': digest(identity), 'slices': []}


def validate_collection(collection, *, complete=False):
    """Validate saved identity, bounds, every slice and exact overlap evidence.

    This is offline shape/integrity validation. Canonicality and round truth are
    rechecked by reference_series_from_slices before any reference valuation.
    """
    from chainlink_reference import DECIMALS, validate_observation
    keys = {'schemaVersion', 'mode', 'chainId', 'currency', 'startTimestamp', 'endTimestamp',
            'snapshot', 'manifestSha256', 'collectionId', 'slices'}
    if not isinstance(collection, dict) or set(collection) != keys:
        raise DataError('invalid_chainlink_collection')
    c = collection
    if (type(c['schemaVersion']) is not int or c['schemaVersion'] != 1 or c['mode'] != MODE or
            type(c['chainId']) is not int or c['chainId'] != CHAIN_ID or
            c['manifestSha256'] != MANIFEST_SHA256 or address(c['currency']) != c['currency'] or
            c['currency'] not in FEEDS):
        raise DataError('invalid_chainlink_collection')
    start = integer(c['startTimestamp'])
    end = integer(c['endTimestamp'], start+1, min(2**63-1, start+MAX_PRICE_WINDOW_SECONDS))
    snapshot = block(c['snapshot'])
    if end > snapshot['timestamp'] or c['collectionId'] != digest({k: v for k, v in c.items()
                                                                 if k not in ('collectionId', 'slices')}):
        raise DataError('chainlink_collection_identity_mismatch')
    slices = c['slices']
    if not isinstance(slices, list) or len(slices) > MAX_SLICES:
        raise DataError('chainlink_collection_slice_budget_exhausted')
    seen, rounds, raw_count, next_start = {}, {}, 0, start
    expected_feed = {**asdict(FEEDS[c['currency']]), 'source': SOURCE, 'proxyRole': 'standard',
        'manifestSha256': MANIFEST_SHA256, 'currency': c['currency'],
        'currencyDecimals': DECIMALS[c['currency']], 'configurationScope': 'proxy_phase_asset_and_precision'}
    for bundle in slices:
        if not isinstance(bundle, dict) or set(bundle) != {'observations', 'snapshot', 'feed', 'coverage'}:
            raise DataError('invalid_chainlink_collection')
        if canonical(bundle['snapshot']) != canonical(snapshot) or canonical(bundle['feed']) != canonical(expected_feed):
            raise DataError('chainlink_collection_identity_mismatch')
        rows, coverage = bundle['observations'], bundle['coverage']
        if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROUNDS or not isinstance(coverage, dict):
            raise DataError('invalid_chainlink_collection')
        slice_end = integer(coverage.get('endTimestamp'), next_start+1, min(end, next_start+DEFAULT_SLICE_SECONDS))
        end_block = block(coverage.get('endBlock'))
        expected = {'status': 'observed_unqualified', 'startTimestamp': next_start, 'endTimestamp': slice_end,
            'endBlock': end_block, 'precedingObservationIncluded': True, 'roundCount': len(rows),
            'maxRounds': MAX_ROUNDS, 'phaseTraversal': False, 'publicationBlocksVerified': True,
            'freshnessAssessed': False, 'sequencerHistoryAssessed': False, 'withinSecondOrderingSupported': False}
        if (canonical(coverage) != canonical(expected) or end_block['number'] > snapshot['number'] or
                end_block['timestamp'] > slice_end):
            raise DataError('invalid_chainlink_collection')
        raw_count += len(rows)
        if raw_count > MAX_TOTAL_ROWS:
            raise DataError('chainlink_collection_overlap_budget_exhausted')
        previous_at = -1
        for row in rows:
            validate_observation(row)
            if set(row) != {'chainId', 'currency', 'source', 'timestamp', 'retrievedAt', 'priceUsd', 'provenance'}:
                raise DataError('invalid_chainlink_collection')
            p = row['provenance']
            if set(p) != {'adapterVersion', 'manifestSha256', 'status', 'provider', 'proxyRole', 'proxy',
                          'aggregator', 'phaseId', 'feedDecimals', 'currencyDecimals', 'currencyMapping',
                          'roundId', 'answerRaw', 'answerStartedAt', 'answerUpdatedAt', 'answeredInRound',
                          'publicationBlock', 'precedingBlock', 'precedingRoundId', 'timestampSemantics',
                          'freshnessTimestamp', 'targetPoolIndependenceVerified'}:
                raise DataError('invalid_chainlink_collection')
            publication = block(p['publicationBlock']);block(p['precedingBlock'])
            at = row['timestamp']
            if (row['currency'] != c['currency'] or not previous_at < at <= slice_end or
                    publication['number'] > end_block['number']):
                raise DataError('invalid_chainlink_collection')
            previous_at = at
            comparable = {k: v for k, v in row.items() if k != 'retrievedAt'}
            if at in seen and canonical(comparable) != canonical({k: v for k, v in seen[at].items() if k != 'retrievedAt'}):
                raise DataError('chainlink_collection_observation_conflict')
            if p['roundId'] in rounds and rounds[p['roundId']] != at:
                raise DataError('chainlink_collection_observation_conflict')
            seen.setdefault(at, row);rounds[p['roundId']] = at
            if len(seen) > MAX_PRICE_ROWS:
                raise DataError('price_observation_budget_exhausted')
        if rows[0]['timestamp'] >= next_start:
            raise DataError('chainlink_collection_predecessor_missing')
        next_start = slice_end
    if complete and next_start != end:
        raise DataError('chainlink_collection_incomplete')
    return next_start, [seen[at] for at in sorted(seen)]


def advance_collection(collection, rpc, *, slice_seconds=DEFAULT_SLICE_SECONDS, clock=time.time):
    """Return one completed slice, or fail without modifying the input checkpoint.

    A dense slice is explicitly retried by its caller with a smaller duration.
    No automatic retries, resampling, global budget reset or partial slice exists.
    """
    integer(slice_seconds, 1, DEFAULT_SLICE_SECONDS)
    next_start, _ = validate_collection(collection)
    if next_start == collection['endTimestamp']:
        return deepcopy(collection)
    if len(collection['slices']) >= MAX_SLICES:
        raise DataError('chainlink_collection_slice_budget_exhausted')
    bounded = BudgetRpc(rpc, max_requests=SLICE_RPC_REQUESTS, seconds=180)
    try:
        bundle = ChainlinkHistorical(bounded, clock=clock).fetch(collection['currency'], next_start,
            min(collection['endTimestamp'], next_start+slice_seconds),
            block_number=collection['snapshot']['number'], expected_snapshot=collection['snapshot'])
    except DataError as error:
        if str(error) == 'chainlink_round_budget_exhausted':
            raise DataError('chainlink_slice_too_dense') from None
        raise
    if bundle['snapshot'] != collection['snapshot']:
        raise DataError('chainlink_snapshot_reorganized')
    candidate = {**collection, 'slices': [*collection['slices'], bundle]}
    validate_collection(candidate)
    return candidate


def collection_blocks(collection):
    """All saved canonical evidence, deduplicated without masking conflicts."""
    _, rows = validate_collection(collection, complete=True)
    blocks = {}
    for value in [collection['snapshot'],
                  *(part['coverage']['endBlock'] for part in collection['slices']),
                  *(row['provenance'][key] for row in rows for key in ('publicationBlock', 'precedingBlock'))]:
        if value['number'] in blocks and blocks[value['number']] != value:
            raise DataError('chainlink_proof_conflict')
        blocks[value['number']] = value
    return blocks


def recheck_collection(collection, rpc):
    """Canonical header verification; storage still does not qualify price truth."""
    blocks = collection_blocks(collection)
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
        raise DataError('wrong_chain')
    for number, expected in sorted(blocks.items()):
        actual = asdict(parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False])))
        if actual != expected:
            raise DataError('chainlink_snapshot_reorganized')


def store_collection(catalogue, collection, rpc):
    """Recheck before any write and again before committing, including zero-step resumes."""
    from price_history import store_observations
    _, rows = validate_collection(collection, complete=True)
    bounded = BudgetRpc(rpc, max_requests=STORAGE_RPC_REQUESTS, seconds=INVOCATION_SECONDS)
    recheck_collection(collection, bounded)
    store_observations(catalogue, rows, before_commit=lambda: recheck_collection(collection, bounded))
