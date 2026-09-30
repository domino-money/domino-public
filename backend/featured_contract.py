"""read-v5: the featured pools list, one stored route (featured-pools v1 §10).

The response is the served revision (featured_current) as it was written: its
pools, the rules and the evaluation summary recorded at selection, and the
removals of the last seven days. The reader role reads lists only. Nothing is
recomputed here, so every visitor gets the same list.
"""
from datetime import date
import time
import unicodedata
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, StringConstraints, model_validator

from discovery import CHAIN_ID, DataError
from featured_pools import REASONS, SOURCES
from pool_apr import AprDecimal, METHOD
from read_contract import Address, DecimalString, FalseFlag, Hash, UInt, WireModel

# rc.2 (featured-policy v2): today's APR may rank the list, a market rule may be off
# (null threshold), and a ranked pool may have no previous-day APR or no measured depth.
CONTRACT_VERSION = '1.0.0-rc.2'
RANK_BY = {'min_fresh_and_previous': 'min_fresh_and_previous_day_feeAprEstimate24hPercent',
           'fresh': 'feeAprEstimate24hPercent'}
ZERO = '0x' + '0' * 40
MAX_POOLS = 12
MAX_WITHDRAWN = 24
WITHDRAWN_SECONDS = 7 * 86400
STATUSES = ('current', 'repaired', 'carried_over', 'manual', 'none')
WITHDRAW_REASONS = ('excluded_by_owner', 'pool_integration_unsupported', 'fixed_fee_mismatch',
                    'invalid_protocol_fee', 'protocol_fee_directional_unsupported', 'token_code_changed',
                    'tvl_collapse', 'price_fall', 'apr_or_turnover_above_ceiling', 'estimate_unavailable',
                    'volume_collapse')
LIMITATIONS = ('provider_reported_volume_and_tvl_unreconciled', 'provider_listed_universe_only',
               'no_wash_trading_certification', 'not_a_return_forecast_or_recommendation')
PolicyVersion = Annotated[str, StringConstraints(strict=True, pattern=r'^featured-v1:[0-9a-f]{12}$')]
Symbol = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=32)]


class FeaturedPoolsRequest(WireModel):
    """The route takes no parameters: the list is the same for everyone."""


class Token(WireModel):
    address: Address
    symbol: Symbol
    decimals: Annotated[int, Field(strict=True, ge=0, le=36)]

    @model_validator(mode='after')
    def displayable(self):
        if any(ch.isspace() or unicodedata.category(ch) in ('Cc', 'Cf') for ch in self.symbol):
            raise ValueError('unsafe symbol')
        return self


class Key(WireModel):
    currency0: Address
    currency1: Address
    fee_pips: Annotated[int, Field(strict=True, ge=0, lt=1_000_000)]
    tick_spacing: Annotated[int, Field(strict=True, ge=1, le=32767)]
    hooks: Literal[ZERO]
    feeMode: Literal['fixed']


class Block(WireModel):
    number: UInt
    hash: Hash


class RankInputs(WireModel):
    rankApr: AprDecimal
    freshApr: AprDecimal
    # null: no evaluation the day before (a new pool, when persistence is off).
    prevApr: AprDecimal | None
    volume24hUsd: DecimalString
    reportedLiquidityUsd: DecimalString
    # null: not measured, when the depth rule is off.
    referenceDepthUsd: DecimalString | None
    evaluatedAt: UInt


class Pool(WireModel):
    slot: Annotated[int, Field(strict=True, ge=1, le=MAX_POOLS)]
    source: Literal[SOURCES]
    poolId: Hash
    poolKey: Key
    integrationClass: Literal['hookless_fixed_fee']
    tokens: Annotated[list[Token], Field(min_length=2, max_length=2)]
    identitySource: Literal['catalogue_event', 'catalogue_hint', 'position_manager', 'initialize_scan']
    # Age is a market rule: a pinned, carried, fallback or manual pool may have none.
    ageSource: Literal['catalogue_event', 'provider_pool_created_at', 'initialize_scan'] | None
    initializeBlock: UInt | None
    verifiedAt: Block
    rankInputs: RankInputs | None

    @model_validator(mode='after')
    def consistent(self):
        key = self.poolKey
        if key.currency0 >= key.currency1 or [token.address for token in self.tokens] != [key.currency0, key.currency1]:
            raise ValueError('pool currencies')
        if (self.rankInputs is None) != (self.source != 'ranked'):
            raise ValueError('rank inputs belong to ranked pools only')
        return self


class Withdrawn(WireModel):
    poolId: Hash
    reason: Literal[WITHDRAW_REASONS]
    at: UInt


class Window(WireModel):
    start: UInt
    end: UInt


class Coverage(WireModel):
    source: Literal['geckoterminal_dex_pools_by_h24_volume']
    pages: Annotated[int, Field(strict=True, ge=0, le=10)]
    lastListedVolume24hUsd: DecimalString | None
    truncated: bool


class Rules(WireModel):
    rankBy: Literal[tuple(RANK_BY.values())]
    estimateMethod: Literal[METHOD]
    marketSource: Literal['geckoterminal']
    minVolume24hUsd: DecimalString
    minTvlUsd: DecimalString
    # null: that rule is off.
    minReferenceDepthUsd: DecimalString | None
    maxAprPercent: DecimalString | None
    maxTurnover24h: DecimalString | None
    minPoolAgeHours: UInt | None
    size: Annotated[int, Field(strict=True, ge=1, le=MAX_POOLS)]


class Evaluation(WireModel):
    candidates: UInt
    shortlisted: UInt
    eligible: UInt
    rejectedByReason: dict[Literal[REASONS], UInt]


class FeaturedPoolsResponse(WireModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schemaVersion: Literal[1]
    contractVersion: Literal[CONTRACT_VERSION]
    chainId: Literal[CHAIN_ID]
    mode: Literal['stored_featured_pools']
    status: Literal[STATUSES]
    revision: UInt | None
    listId: Hash | None
    policyVersion: PolicyVersion | None
    selectionDate: Annotated[str, StringConstraints(strict=True, pattern=r'^\d{4}-\d{2}-\d{2}$')] | None
    generatedAt: UInt | None
    effectiveAt: UInt | None
    validUntil: UInt | None
    servedAt: UInt
    window: Window | None
    coverage: Coverage | None
    rules: Rules | None
    pools: Annotated[list[Pool], Field(max_length=MAX_POOLS)]
    withdrawn: Annotated[list[Withdrawn], Field(max_length=MAX_WITHDRAWN)]
    upcoming: None
    evaluation: Evaluation | None
    suggested: FalseFlag
    executionAvailable: FalseFlag
    limitations: list[Literal[LIMITATIONS]]

    @model_validator(mode='after')
    def consistent(self):
        if (self.status == 'none') != (not self.pools):
            raise ValueError('an empty list is exactly status none')
        if [pool.slot for pool in self.pools] != list(range(1, len(self.pools) + 1)):
            raise ValueError('slots run from 1 without gaps')
        if len({pool.poolId for pool in self.pools}) != len(self.pools):
            raise ValueError('a pool appears once')
        if {pool.poolId for pool in self.pools} & {item.poolId for item in self.withdrawn}:
            raise ValueError('a listed pool is not withdrawn')
        if self.status != 'none':
            times = (self.revision, self.listId, self.generatedAt, self.effectiveAt, self.validUntil)
            if any(value is None for value in times):
                raise ValueError('a served list names its revision and times')
            if not self.generatedAt <= self.effectiveAt <= self.validUntil or self.generatedAt > self.servedAt:
                raise ValueError('times out of order')
        if self.selectionDate is not None:
            date.fromisoformat(self.selectionDate)
        return self


def validate_featured_response(route, body):
    if route != 'featured-pools':
        raise ValueError('unknown featured route')
    FeaturedPoolsResponse.model_validate(body)
    return body


def rules_of(policy):
    """What a list states about how it was chosen: recorded with the list at selection."""
    thresholds = policy['thresholds']
    return {'rankBy': RANK_BY[policy['rankBy']], 'estimateMethod': METHOD,
            'marketSource': 'geckoterminal', 'minVolume24hUsd': thresholds['minVolume24hUsd'],
            'minTvlUsd': thresholds['minTvlUsd'], 'minReferenceDepthUsd': thresholds['minReferenceDepthUsd'],
            'maxAprPercent': thresholds['maxAprPercent'], 'maxTurnover24h': thresholds['maxTurnover24h'],
            'minPoolAgeHours': thresholds['minPoolAgeHours'], 'size': policy['size']}


def prune_withdrawn(items, now):
    """Removals of the last seven days, newest last, at most 24."""
    return [item for item in items if now - item['at'] <= WITHDRAWN_SECONDS][-MAX_WITHDRAWN:]


WIRE_POOL = ('slot', 'source', 'poolId', 'poolKey', 'integrationClass', 'tokens', 'identitySource',
             'ageSource', 'initializeBlock', 'verifiedAt', 'rankInputs')


def build_response(served, *, now):
    """The wire answer for the served revision (None: nothing was ever served)."""
    empty = {'revision': None, 'listId': None, 'policyVersion': None, 'selectionDate': None,
             'generatedAt': None, 'effectiveAt': None, 'validUntil': None, 'window': None, 'coverage': None,
             'rules': None, 'pools': [], 'withdrawn': [], 'evaluation': None}
    body = {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'chainId': CHAIN_ID,
            'mode': 'stored_featured_pools', 'status': 'none', 'servedAt': now, 'upcoming': None,
            'suggested': False, 'executionAvailable': False, 'limitations': list(LIMITATIONS), **empty}
    if served is not None:
        payload = served['payload']
        body.update(status=served['status'], revision=served['revision'], listId=served['list_id'],
                    policyVersion=payload.get('policyVersion'),
                    selectionDate=served['selection_date'].isoformat() if served['selection_date'] else None,
                    generatedAt=served['generated_at'], effectiveAt=served['effective_at'],
                    validUntil=served['valid_until'], window=payload.get('window'),
                    coverage=({name: payload['coverage'][name] for name in
                               ('source', 'pages', 'lastListedVolume24hUsd', 'truncated')}
                              if payload.get('coverage') else None),
                    rules=payload.get('rules'), evaluation=payload.get('evaluation'),
                    # A missing name is null: lists recorded before a nullable field existed stay readable.
                    pools=[{name: entry.get(name) for name in WIRE_POOL} for entry in payload['pools']],
                    withdrawn=prune_withdrawn(payload.get('withdrawn', []), now))
        if body['status'] == 'none':
            # No pools, but a pool withdrawn this week stays blocked when opened by link (§11.5).
            body.update({**empty, 'withdrawn': body['withdrawn']}, status='none')
    return validate_featured_response('featured-pools', body)


class FeaturedReader:
    """The served list through the public reader role: lists only, never runs or overrides."""
    def __init__(self, repository, clock=time.time):
        self.repository, self.clock = repository, clock

    def read(self):
        with self.repository.connection() as conn:
            served = conn.execute('''SELECT l.* FROM domino_public.featured_current c
              JOIN domino_public.featured_lists l ON l.revision=c.revision WHERE c.singleton''').fetchone()
        try:
            return build_response(served, now=int(self.clock()))
        except ValueError:
            raise DataError('upstream_contract_mismatch') from None
