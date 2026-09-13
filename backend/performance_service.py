"""Project persisted, owner-bound collection state; never calculate live returns.

The injected auth is OnboardingAuth (the existing SIWE begin/finish boundary).
The reader is PerformanceStore.list_epochs(owner, epoch_ids). It receives no
browser-provided owner or evidence. There is no RPC client, calculator, signing
path, or value cache here: every request rereads the durable revision, then
reauthorizes before returning the deliberately limited projection.
"""
import math
import time
from typing import Annotated, Literal

from pydantic import Field, ValidationError

from performance_models import (CONTRACT_VERSION, MAX_EPOCHS, MAX_SNAPSHOT_AGE, PERFORMANCE_REASONS,
    Address, Hash, PositiveInt, Timestamp, StrictModel, PendingFinancialMetrics, PerformanceError,
    validate_request, validate_response)
from read_deadline import check_read_deadline


class _StoredEpoch(StrictModel):
    owner: Address
    epochId: Hash
    baseline: dict
    cursor: dict
    revision: PositiveInt
    replayGeneration: PositiveInt
    status: Literal['active', 'read_failed', 'replaying', 'baseline_reorged']
    lastError: Annotated[str, Field(max_length=160)] | None
    pageCount: Timestamp
    receiptCount: Timestamp
    eventCount: Timestamp
    createdAt: Timestamp
    updatedAt: Timestamp


def _snapshot(cursor):
    return {'blockNumber': cursor.blockNumber, 'blockHash': cursor.blockHash,
            'timestamp': cursor.timestamp}


def _pending(epoch_id):
    return {'epochId': epoch_id, 'performanceStatus': 'unavailable',
            'performanceReasons': list(PERFORMANCE_REASONS),
            'metrics': {field: None for field in PendingFinancialMetrics.model_fields},
            'complete24h': False, 'executionAvailable': False}


class PerformanceService:
    def __init__(self, auth, reader, *, clock=time.time):
        self.auth, self.reader, self.clock = auth, reader, clock

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
            raise PerformanceError('upstream_invalid_response')
        return int(value)

    @staticmethod
    def _project(row, owner, requested, now):
        # The store's strict collection models retain all private provenance.
        # Only the small selected projection below can leave this service.
        from performance_collection import Baseline, Cursor
        try:
            if type(row) is not dict:
                raise ValueError()
            record = _StoredEpoch.model_validate(row)
            baseline = Baseline.model_validate(record.baseline)
            cursor = Cursor.model_validate(record.cursor)
            if (record.owner != owner or baseline.owner != owner or record.epochId not in requested
                    or baseline.epochId != record.epochId or cursor.blockNumber < baseline.baseline.blockNumber
                    or cursor.timestamp < baseline.baseline.timestamp or cursor.timestamp > now
                    or record.createdAt > record.updatedAt or record.updatedAt > now
                    or (cursor.blockNumber == baseline.baseline.blockNumber
                        and cursor != baseline.baseline)):
                raise ValueError()
            age = now-cursor.timestamp
            if record.status == 'baseline_reorged':
                status, reason = 'unavailable', 'baseline_reorged'
            elif record.status == 'replaying':
                status, reason = 'partial', 'canonical_replay_required'
            elif record.status == 'read_failed':
                status, reason = 'stale', 'latest_read_failed'
            elif age > MAX_SNAPSHOT_AGE:
                status, reason = 'stale', 'snapshot_stale'
            else:
                status, reason = 'measuring', 'forward_observations_only'
            return {**_pending(record.epochId), 'kind': 'tracked', 'vault': baseline.vault,
                'positionManager': baseline.positionManager, 'rootTokenId': baseline.rootTokenId,
                'sequenceIdentity': baseline.opening.sequenceIdentity,
                'baseline': _snapshot(baseline.baseline), 'snapshot': _snapshot(cursor),
                'revision': record.revision, 'replayGeneration': record.replayGeneration,
                'collectionStatus': status, 'collectionReason': reason,
                # This is the span of recorded raw observations, never fee or
                # capital coverage and never permission to show a full-day APR.
                'observedSeconds': cursor.timestamp-baseline.baseline.timestamp,
                'snapshotAgeSeconds': age,
                'observations': {'pages': record.pageCount, 'receipts': record.receiptCount,
                                 'events': record.eventCount}}
        except (ValidationError, ValueError, TypeError, AttributeError, OverflowError):
            raise PerformanceError('upstream_invalid_response') from None

    def execute(self, route, body, *, client, session, csrf):
        request = validate_request(route, body)
        check_read_deadline()
        context = self.auth.begin(client, session, csrf)
        owner = context['owner']
        try:
            from performance_store import PerformanceStoreError
            check_read_deadline()
            try:
                rows = self.reader.list_epochs(owner, request['epochIds'])
            except PerformanceStoreError:
                # Subject existence is represented only by omitted rows. Store
                # details, raw provenance and internal errors are never emitted.
                raise PerformanceError('performance_store_unavailable') from None
            check_read_deadline()
            if type(rows) is not list or len(rows) > MAX_EPOCHS:
                raise PerformanceError('upstream_invalid_response')
            now = self._now()
            by_id = {}
            for row in rows:
                projected = self._project(row, owner, request['epochIds'], now)
                if projected['epochId'] in by_id:
                    raise PerformanceError('upstream_invalid_response')
                by_id[projected['epochId']] = projected
            cards = [by_id[epoch] if epoch in by_id else {**_pending(epoch), 'kind': 'not_found',
                     'collectionStatus': 'unavailable', 'collectionReason': 'epoch_not_found'}
                     for epoch in request['epochIds']]
            response = {'contractVersion': CONTRACT_VERSION, 'chainId': 4663, 'owner': owner,
                'cards': cards, 'refreshAfterSeconds': 30 if any(card['collectionStatus'] == 'measuring'
                    for card in cards) else 60, 'executionAvailable': False}
            self.auth.finish(context)
            check_read_deadline()
            return validate_response(route, response)
        except PerformanceError:
            raise
