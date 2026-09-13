"""Closed, read-only private cards candidate; financial evidence remains pending."""
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, ValidationError, model_validator

from session_models import ERROR_STATUS as SESSION_ERROR_STATUS

CONTRACT_VERSION = '1.0.0-rc.1'
MAX_BODY = 2048
MAX_RESPONSE = 32768
MAX_EPOCHS = 8
MAX_SNAPSHOT_AGE = 120
PERFORMANCE_REASONS = ['financial_receipt_adapter_required', 'event_time_valuation_required']
ERROR_STATUS_BY_CODE = {
    **SESSION_ERROR_STATUS,
    'performance_capacity_busy': 429,
    'performance_store_unavailable': 503,
    'onboarding_rate_limited': 429,
    'onboarding_capacity_busy': 429,
}


class PerformanceError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


class StrictModel(BaseModel):
    # The fixed-width identity patterns use a nonzero negative lookahead, also
    # supported by the exported ECMAScript contract; no user pattern is accepted.
    model_config = ConfigDict(extra='forbid', strict=True, regex_engine='python-re')


def _boolean(value):
    if type(value) is not bool:
        raise ValueError('boolean_required')
    return value


def _integer(value):
    if type(value) is not int:
        raise ValueError('integer_required')
    return value


Hash = Annotated[str, Field(pattern=r'^0x(?!0{64}$)[0-9a-f]{64}$', min_length=66, max_length=66)]
Address = Annotated[str, Field(pattern=r'^0x(?!0{40}$)[0-9a-f]{40}$', min_length=42, max_length=42)]
Timestamp = Annotated[StrictInt, Field(ge=0, le=2**53-1)]
PositiveInt = Annotated[StrictInt, Field(ge=1, le=2**53-1)]
FalseFlag = Annotated[Literal[False], BeforeValidator(_boolean)]
TokenId = Annotated[str, Field(pattern=r'^[1-9][0-9]{0,77}$(?![\s\S])', max_length=78,
                              json_schema_extra={'x-maximum-raw': str(2**256-1)})]


class CardsRequest(StrictModel):
    epochIds: Annotated[list[Hash], Field(min_length=1, max_length=MAX_EPOCHS,
                                        json_schema_extra={'uniqueItems': True})]

    @model_validator(mode='after')
    def unique(self):
        if len(self.epochIds) != len(set(self.epochIds)):
            raise ValueError('duplicate_epoch')
        return self


class Snapshot(StrictModel):
    blockNumber: Timestamp
    blockHash: Hash
    timestamp: Timestamp


class ObservationCounts(StrictModel):
    pages: Timestamp
    receipts: Timestamp
    events: Timestamp

    @model_validator(mode='after')
    def coherent(self):
        if (self.pages == 0 and (self.receipts != 0 or self.events != 0)
                or self.receipts == 0 and self.events != 0):
            raise ValueError('invalid_observation_counts')
        return self


class PendingFinancialMetrics(StrictModel):
    # Required literal nulls prevent an injected producer from passing off raw
    # observations, opening balances or calculator fixtures as actual returns.
    newTradingFeesUsd: None
    externalDepositsUsd: None
    externalWithdrawalsUsd: None
    reinvestedUsd: None
    actualServiceFeesUsd: None
    otherStrategyCostsUsd: None
    operatorCostsUsd: None
    netFeeIncomeUsd: None
    timeWeightedCapitalUsd: None
    grossFeeAprPercent: None
    netFeeAprPercent: None
    projectedApyPercent: None


class CardBase(StrictModel):
    epochId: Hash
    performanceStatus: Literal['unavailable']
    performanceReasons: Annotated[
        list[Literal['financial_receipt_adapter_required', 'event_time_valuation_required']],
        Field(min_length=2, max_length=2, json_schema_extra={'const': PERFORMANCE_REASONS})]
    metrics: PendingFinancialMetrics
    complete24h: FalseFlag
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def fixed_reasons(self):
        if self.performanceReasons != PERFORMANCE_REASONS:
            raise ValueError('invalid_performance_reasons')
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

    @model_validator(mode='after')
    def coherent_snapshot(self):
        if (int(self.rootTokenId) >= 2**256 or self.snapshot.blockNumber < self.baseline.blockNumber
                or self.snapshot.timestamp < self.baseline.timestamp
                or self.observedSeconds != self.snapshot.timestamp-self.baseline.timestamp
                or (self.snapshot.blockNumber == self.baseline.blockNumber
                    and (self.snapshot.blockHash != self.baseline.blockHash
                         or self.snapshot.timestamp != self.baseline.timestamp))):
            raise ValueError('invalid_collection_span')
        expected = {'forward_observations_only': 'measuring', 'latest_read_failed': 'stale',
                    'snapshot_stale': 'stale', 'canonical_replay_required': 'partial',
                    'baseline_reorged': 'unavailable'}[self.collectionReason]
        if self.collectionStatus != expected:
            raise ValueError('invalid_collection_state')
        if (self.collectionReason == 'forward_observations_only' and self.snapshotAgeSeconds > MAX_SNAPSHOT_AGE
                or self.collectionReason == 'snapshot_stale' and self.snapshotAgeSeconds <= MAX_SNAPSHOT_AGE):
            raise ValueError('invalid_collection_freshness')
        return self


class MissingCard(CardBase):
    kind: Literal['not_found']
    collectionStatus: Literal['unavailable']
    collectionReason: Literal['epoch_not_found']


Card = Annotated[TrackedCard | MissingCard, Field(discriminator='kind')]


class CardsResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    chainId: Annotated[StrictInt, Field(ge=4663, le=4663)]
    owner: Address
    cards: Annotated[list[Card], Field(min_length=1, max_length=MAX_EPOCHS)]
    refreshAfterSeconds: Annotated[Literal[30, 60], BeforeValidator(_integer)]
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def unique(self):
        ids = [card.epochId for card in self.cards]
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate_epoch')
        if type(self.refreshAfterSeconds) is not int:
            raise ValueError('integer_refresh_required')
        return self


class ErrorResponse(StrictModel):
    error: Literal[tuple(ERROR_STATUS_BY_CODE)]


REQUEST_MODELS = {'cards': CardsRequest}
RESPONSE_MODELS = {'cards': CardsResponse}


def _validate(models, route, value, code):
    try:
        if route not in models or type(value) is not dict:
            raise ValueError()
        return models[route].model_validate(value).model_dump(mode='json')
    except (ValidationError, ValueError, TypeError, OverflowError):
        raise PerformanceError(code) from None


def validate_request(route, value):
    return _validate(REQUEST_MODELS, route, value, 'invalid_request')


def validate_response(route, value):
    return _validate(RESPONSE_MODELS, route, value, 'upstream_invalid_response')
