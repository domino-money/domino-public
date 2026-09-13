"""Authenticated managed performance; V1's required-null wire format is unchanged."""
from typing import Annotated, Literal

from pydantic import Field, StrictBool, model_validator

from performance_models import (Address, Hash, TokenId, Timestamp, PositiveInt, FalseFlag,
    Snapshot, ObservationCounts, StrictModel, CardsRequest, PerformanceError,
    ERROR_STATUS_BY_CODE as V1_ERRORS, _validate)

CONTRACT_VERSION = '2.0.0-rc.1'
MAX_BODY, MAX_RESPONSE, MAX_EPOCHS = 8192, 65536, 8
ERROR_STATUS_BY_CODE = {**V1_ERRORS, 'performance_enrollment_unavailable': 503,
    'performance_enrollment_limit': 429, 'performance_subject_not_admitted': 403}
Decimal = Annotated[str, Field(pattern=r'^-?(0|[1-9][0-9]{0,511})(\.[0-9]{1,400})?$', max_length=512)]
Reason = Annotated[str, Field(pattern=r'^[a-z][a-z0-9_]{0,95}$', max_length=96)]


class Error(PerformanceError):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        Exception.__init__(self, self.code)


class EpochsRequest(StrictModel):
    after: Hash | None = None


class EnrollRequest(StrictModel):
    vault: Address
    tokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=64, json_schema_extra={'uniqueItems': True})]

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.tokenIds)) != len(self.tokenIds) or any(int(i) >= 2**256 for i in self.tokenIds):
            raise ValueError('invalid_member_set')
        return self


class Enrollment(StrictModel):
    enrollmentId: Hash
    vault: Address
    tokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=64)]
    epochId: Hash | None
    status: Literal['queued', 'tracking', 'stale', 'blocked']
    reason: Literal['awaiting_baseline', 'forward_collection', 'collection_failed', 'baseline_reorged']
    updatedAt: Timestamp

    @model_validator(mode='after')
    def state(self):
        states = {'awaiting_baseline': 'queued', 'forward_collection': 'tracking',
                  'collection_failed': 'stale', 'baseline_reorged': 'blocked'}
        if states[self.reason] != self.status or self.status == 'tracking' and self.epochId is None:
            raise ValueError('invalid_enrollment_state')
        return self


class ResponseBase(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    chainId: Literal[4663]
    owner: Address
    refreshAfterSeconds: Literal[30, 60]
    executionAvailable: FalseFlag


class EpochsResponse(ResponseBase):
    enrollments: Annotated[list[Enrollment], Field(max_length=MAX_EPOCHS)]
    nextAfter: Hash | None


class EnrollResponse(ResponseBase):
    enrollment: Enrollment


class Metrics(StrictModel):
    newTradingFeesUsd: Decimal | None
    externalDepositsUsd: Decimal | None
    externalWithdrawalsUsd: Decimal | None
    reinvestedUsd: Decimal | None
    actualServiceFeesUsd: Decimal | None
    otherStrategyCostsUsd: Decimal | None
    operatorCostsUsd: Decimal | None
    netFeeIncomeUsd: Decimal | None
    timeWeightedCapitalUsd: Decimal | None
    grossFeeAprPercent: Decimal | None
    netFeeAprPercent: Decimal | None
    projectedApyPercent: None


class FinancialCoverage(StrictModel):
    methodologyVersion: Literal[1]
    financialRevision: PositiveInt | None
    snapshot: Snapshot
    windowStart: Timestamp
    windowEnd: Timestamp
    observedSeconds: Timestamp
    externalFlowsComplete: StrictBool
    operatorCostsReason: Reason

    @model_validator(mode='after')
    def span(self):
        if (self.windowEnd < self.windowStart or self.observedSeconds != self.windowEnd-self.windowStart
                or self.snapshot.timestamp != self.windowEnd):
            raise ValueError('invalid_financial_span')
        return self


class CardBase(StrictModel):
    epochId: Hash
    performanceStatus: Literal['available', 'measuring', 'partial', 'stale', 'unavailable']
    performanceReasons: Annotated[list[Reason], Field(max_length=128)]
    metrics: Metrics
    complete24h: StrictBool
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def financial_state(self):
        apr = self.metrics.grossFeeAprPercent, self.metrics.netFeeAprPercent
        if (not self.complete24h or self.performanceStatus != 'available') and any(v is not None for v in apr):
            raise ValueError('unqualified_apr')
        if self.performanceStatus == 'unavailable' and any(v is not None for v in self.metrics.model_dump().values()):
            raise ValueError('unavailable_metrics')
        return self


class TrackedCard(CardBase):
    kind: Literal['tracked']
    vault: Address
    positionManager: Address
    rootTokenId: TokenId
    sequenceIdentity: Hash
    baseline: Snapshot
    snapshot: Snapshot
    revision: PositiveInt
    replayGeneration: PositiveInt
    collectionStatus: Literal['measuring', 'partial', 'stale', 'unavailable']
    collectionReason: Literal['forward_observations_only', 'latest_read_failed', 'snapshot_stale',
                              'canonical_replay_required', 'baseline_reorged']
    observedSeconds: Timestamp
    snapshotAgeSeconds: Timestamp
    observations: ObservationCounts
    financial: FinancialCoverage

    @model_validator(mode='after')
    def snapshots(self):
        if (self.snapshot.timestamp < self.baseline.timestamp or self.snapshot.blockNumber < self.baseline.blockNumber
                or self.observedSeconds != self.snapshot.timestamp-self.baseline.timestamp
                or self.financial.snapshot.blockNumber > self.snapshot.blockNumber
                or self.financial.windowStart < self.baseline.timestamp
                or self.complete24h and self.financial.observedSeconds != 86400):
            raise ValueError('invalid_card_coverage')
        states = {'forward_observations_only':'measuring','latest_read_failed':'stale','snapshot_stale':'stale',
                  'canonical_replay_required':'partial','baseline_reorged':'unavailable'}
        if (states[self.collectionReason] != self.collectionStatus
                or self.collectionReason == 'forward_observations_only' and self.snapshotAgeSeconds > 120
                or self.collectionReason == 'snapshot_stale' and self.snapshotAgeSeconds <= 120
                or self.snapshot.blockNumber == self.baseline.blockNumber and
                   (self.snapshot.blockHash != self.baseline.blockHash or self.snapshot.timestamp != self.baseline.timestamp)):
            raise ValueError('invalid_collection_state')
        return self


class MissingCard(CardBase):
    kind: Literal['not_found']
    collectionStatus: Literal['unavailable']
    collectionReason: Literal['epoch_not_found']


Card = Annotated[TrackedCard | MissingCard, Field(discriminator='kind')]


class CardsResponse(ResponseBase):
    cards: Annotated[list[Card], Field(min_length=1, max_length=MAX_EPOCHS)]

    @model_validator(mode='after')
    def unique(self):
        if len({card.epochId for card in self.cards}) != len(self.cards):
            raise ValueError('duplicate_epoch')
        return self


REQUEST_MODELS = {'epochs': EpochsRequest, 'enroll': EnrollRequest, 'cards': CardsRequest}
RESPONSE_MODELS = {'epochs': EpochsResponse, 'enroll': EnrollResponse, 'cards': CardsResponse}


def validate_request(route, value):
    try:
        return _validate(REQUEST_MODELS, route, value, 'invalid_request')
    except PerformanceError as error:
        raise Error(error.code) from None


def validate_response(route, value):
    try:
        return _validate(RESPONSE_MODELS, route, value, 'upstream_invalid_response')
    except PerformanceError as error:
        raise Error(error.code) from None
