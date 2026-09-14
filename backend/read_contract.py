"""Strict, versioned read-v1 wire contract; independent of HTTP and providers.

Models validate the producer's original JSON-shaped dictionaries. Callers must
return that original dictionary after validation: serializing model defaults
would add fields which the 0.8 producer deliberately omits. Monetary quantities
are strings, never floating point. Provider labels remain untrusted text.
"""
from typing import Annotated, Literal, get_args, get_origin
from types import UnionType
from typing_extensions import TypeAliasType
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints, model_validator

CONTRACT_VERSION = '1.1.0-rc.3'
ENABLED_READS = ('token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions',
                 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics')
ReadRoute = Literal[ENABLED_READS]
Address = Annotated[str, StringConstraints(strict=True, pattern=r'^0x[0-9a-f]{40}$')]
Hash = Annotated[str, StringConstraints(strict=True, pattern=r'^0x[0-9a-f]{64}$')]
JS_MAX_SAFE_INTEGER = 2**53 - 1
UInt = Annotated[StrictInt, Field(ge=0, le=JS_MAX_SAFE_INTEGER)]
SafeInt = Annotated[StrictInt, Field(ge=-JS_MAX_SAFE_INTEGER, le=JS_MAX_SAFE_INTEGER)]
Tick = Annotated[StrictInt, Field(ge=-887272, le=887272)]


def unsigned_string_pattern(maximum):
    """Standard JSON Schema regex for decimal strings bounded without floats."""
    digits = str(maximum)
    cases = ['0', '[1-9][0-9]{0,'+str(len(digits)-2)+'}']
    for index, digit in enumerate(digits):
        lower = 1 if index == 0 else 0
        if int(digit) > lower:
            choices = str(lower) if int(digit) == lower+1 else '['+str(lower)+'-'+str(int(digit)-1)+']'
            cases.append(digits[:index]+choices+'[0-9]{'+str(len(digits)-index-1)+'}')
    return '^(?:'+'|'.join(cases+[digits])+')$'


Raw = TypeAliasType('Raw', Annotated[str, StringConstraints(
    strict=True, pattern=unsigned_string_pattern(2**256-1), max_length=78)])
DecimalString = Annotated[str, StringConstraints(strict=True, pattern=r'^[0-9]+(?:\.[0-9]+)?$', max_length=224)]
# Closed safe diagnostics shared by token, inventory and discovery responses.
# Only explicit transport codes normalize at the service boundary; unknown nested
# producer diagnostics fail contract validation instead of disguising schema drift.
REASON_CODES = (
    'upstream_unavailable', 'rpc_error', 'rpc_call_gas_limit', 'rpc_call_reverted',
    'network_unavailable', 'invalid_abi_response',
    'invalid_rpc_envelope', 'missing_rpc_result', 'request_budget_exhausted',
    'invalid_json', 'response_too_large', 'invalid_quantity', 'quantity_too_large',
    'token_has_no_code', 'token_code_unavailable', 'invalid_token_decimals', 'invalid_symbol_text',
    'provider_unavailable', 'provider_rate_limited', 'provider_capacity_busy',
    'invalid_discovery_response', 'invalid_inventory_response', 'invalid_inventory_page',
    'invalid_inventory_cursor', 'invalid_pool_key', 'invalid_tick_spacing', 'pool_id_mismatch',
    'invalid_pool_state', 'fixed_fee_mismatch', 'provider_currency_mismatch',
    'selected_token_mismatch', 'selected_pair_mismatch', 'catalogue_database_unavailable',
    'catalogue_schema_mismatch', 'catalogue_currency_mismatch', 'read_deadline_exceeded',
)
Reason = Literal[REASON_CODES]
Symbol = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=40)]
FalseFlag = Literal[False]
TrueFlag = Literal[True]


class WireModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    @model_validator(mode='before')
    @classmethod
    def exact_literal_types(cls, value):
        # Pydantic Literal[False] accepts integer 0, and Literal[1] accepts True.
        # JSON const identity is type sensitive, including inside nested models.
        if isinstance(value, dict):
            for name, field in cls.model_fields.items():
                if name in value and get_origin(field.annotation) is Literal:
                    if not any(type(value[name]) is type(item) and value[name] == item
                               for item in get_args(field.annotation)):
                        raise ValueError('response_contract_mismatch')
                if name in value and get_origin(field.annotation) is UnionType:
                    for branch in get_args(field.annotation):
                        if get_origin(branch) is Literal and any(
                                value[name] == item and type(value[name]) is not type(item)
                                for item in get_args(branch)):
                            raise ValueError('response_contract_mismatch')
        return value


class Snapshot(WireModel):
    number: UInt
    hash: Hash
    timestamp: UInt


class MetadataIssues(WireModel):
    decimals: Reason = Field(default=None)
    symbol: Reason = Field(default=None)


class TokenMetadata(WireModel):
    address: Address
    kind: Literal['native', 'erc20_candidate']
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None
    symbol: Symbol | None
    readStatus: Literal['available', 'partial']
    metadataIssues: MetadataIssues
    displayUnitsAvailable: StrictBool
    executionAvailable: FalseFlag


class UnknownToken(WireModel):
    address: Address
    kind: Literal['unknown']
    decimals: None
    symbol: None
    readStatus: Literal['no_contract', 'unavailable']
    reason: Reason
    metadataIssues: MetadataIssues
    displayUnitsAvailable: FalseFlag
    executionAvailable: FalseFlag


Asset = Annotated[TokenMetadata | UnknownToken, Field(discriminator='kind')]


class TokenResponse(WireModel):
    schemaVersion: Literal[1]
    mode: Literal['public_token_read_only']
    chainId: Literal[4663]
    snapshot: Snapshot
    asset: Asset
    liveExecution: FalseFlag


class WalletItem(TokenMetadata):
    amountRaw: Raw
    balanceStatus: Literal['read_at_block']
    requestedByAddress: StrictBool
    discoveredByProvider: StrictBool


class UnavailableAsset(WireModel):
    currency: Address
    reason: Reason


class InventoryBase(WireModel):
    source: Literal['alchemy'] | None
    asOfBlock: None


class InventoryIdle(InventoryBase):
    status: Literal['not_configured', 'not_requested']
    coverage: Literal['unknown']
    hasMore: None
    nextCursor: None


class InventoryUnavailable(InventoryBase):
    status: Literal['unavailable']
    coverage: Literal['unknown']
    hasMore: None
    nextCursor: None
    reason: Reason


class InventoryPage(InventoryBase):
    status: Literal['page_received']
    coverage: Literal['provider_page_only']
    hasMore: StrictBool
    # Same wire type on the producer and gateway; only the value is substituted.
    nextCursor: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4096)] | None
    retrievedAt: UInt
    rowsReceived: Annotated[StrictInt, Field(ge=0, le=20)]
    excludedRows: Annotated[StrictInt, Field(ge=0, le=20)]
    # Documented partial page: how many provider candidates were actually probed
    # on-chain and how many were skipped to stay inside the read budget (#149).
    candidatesProbed: Annotated[StrictInt, Field(ge=0, le=20)] | None = None
    candidatesSkipped: Annotated[StrictInt, Field(ge=0, le=20)] | None = None
    skippedReason: Reason | None = None


Inventory = Annotated[InventoryIdle | InventoryUnavailable | InventoryPage, Field(discriminator='status')]


class WalletAssetsResponse(WireModel):
    schemaVersion: Literal[2]
    mode: Literal['public_address_read_only']
    chainId: Literal[4663]
    snapshot: Snapshot
    items: Annotated[list[WalletItem], Field(max_length=31)]
    unavailableAssets: Annotated[list[UnavailableAsset], Field(max_length=31)]
    balanceCoverage: Literal['requested_and_page_addresses_only']
    inventory: Inventory
    walletControlVerified: FalseFlag
    liveExecution: FalseFlag


class PoolKeyBase(WireModel):
    currency0: Address
    currency1: Address
    tick_spacing: Annotated[StrictInt, Field(ge=1, le=32767)]
    hooks: Address


class FixedPoolKey(PoolKeyBase):
    feeMode: Literal['fixed']
    fee_pips: Annotated[StrictInt, Field(ge=0, le=1_000_000)]


class DynamicPoolKey(PoolKeyBase):
    feeMode: Literal['dynamic']
    fee_pips: Literal[8388608]


PoolKey = Annotated[FixedPoolKey | DynamicPoolKey, Field(discriminator='feeMode')]


class ProviderMetrics(WireModel):
    source: Literal['dexscreener']
    retrievedAt: UInt
    status: Literal['external_unreconciled']
    asOfBlock: None
    volume24hUsd: DecimalString | None
    reportedLiquidityUsd: DecimalString | None


class CatalogueObservation(WireModel):
    number: UInt
    hash: Hash


class VerifiedPool(WireModel):
    poolId: Hash
    currencies: Annotated[list[Address], Field(min_length=2, max_length=2)]
    poolKey: PoolKey
    identityStatus: Literal['verified_at_block']
    snapshot: Snapshot
    sqrtPriceX96: Raw
    tick: Tick
    currentLpFeePips: Annotated[StrictInt, Field(ge=0, le=1_000_000)]
    protocolFeeRaw: Annotated[StrictInt, Field(ge=0, le=16777215)]
    integrationClass: Literal['hookless_fixed_fee', 'requires_separate_adapter']
    feeApr24h: None
    aprReason: Literal['reconciled_fee_history_unavailable']
    suggested: FalseFlag
    suggestionReason: Literal['metrics_and_policy_not_qualified']
    executionAvailable: FalseFlag
    executionReason: Literal['public_execution_not_implemented']


class DiscoveryPool(VerifiedPool):
    poolKind: Literal['discovery']
    providerMetrics: ProviderMetrics | None
    tokenMetadataStatus: Literal['available', 'partial']
    requestedById: TrueFlag = Field(default=None)


class CatalogueDiscoveryPool(DiscoveryPool):
    poolKind: Literal['catalogue']
    catalogueSource: Literal['initialize_event', 'verified_observation']
    catalogueObservation: CatalogueObservation
    providerCurrencyConflict: TrueFlag = Field(default=None)


class RejectedCandidate(WireModel):
    poolId: Hash
    reason: Reason


class DiscoveryReceived(WireModel):
    source: Literal['dexscreener']
    status: Literal['received']
    coverage: Literal['provider_candidates_only']
    returned: UInt
    v4Candidates: UInt
    rejectedOrOtherMarkets: UInt
    requestedPoolIds: Annotated[StrictInt, Field(ge=0, le=10)]
    notProbed: UInt


class DiscoveryUnavailable(WireModel):
    source: Literal['dexscreener']
    status: Literal['unavailable']
    reason: Reason
    coverage: Literal['unknown']
    returned: None
    v4Candidates: None
    rejectedOrOtherMarkets: None
    requestedPoolIds: Annotated[StrictInt, Field(ge=0, le=10)]
    notProbed: UInt


class CatalogueIdle(WireModel):
    status: Literal['not_configured']
    completeHistory: FalseFlag


class CatalogueUnavailable(WireModel):
    status: Literal['unavailable']
    reason: Reason
    completeHistory: FalseFlag


class CatalogueAvailable(WireModel):
    status: Literal['available']
    chainId: Literal[4663]
    poolManager: Address
    revision: UInt
    startBlock: UInt
    indexedThrough: UInt | None
    coverage: Literal['configured_interval_only']
    completeHistory: FalseFlag
    liveExecution: FalseFlag
    hasMore: StrictBool
    nextAfterPoolId: Hash | None
    candidatesLoaded: Annotated[StrictInt, Field(ge=0, le=100)]


class WalletInventoryUnprobed(WireModel):
    status: Literal['not_probed']
    coverage: Literal['unqualified']


class PoolsResponse(WireModel):
    mode: Literal['read_only_qualification']
    schemaVersion: Literal[2]
    chainId: Literal[4663]
    selectedToken: Address
    pairedToken: Address | None
    snapshot: Snapshot
    tokens: Annotated[list[Asset], Field(min_length=1, max_length=41)]
    pools: Annotated[list[Annotated[DiscoveryPool | CatalogueDiscoveryPool, Field(discriminator='poolKind')]], Field(max_length=20)]
    unverifiedCandidates: Annotated[list[RejectedCandidate], Field(max_length=20)]
    metricsQualified: FalseFlag
    liveExecution: FalseFlag
    discovery: Annotated[DiscoveryReceived | DiscoveryUnavailable, Field(discriminator='status')]
    catalogue: Annotated[CatalogueIdle | CatalogueUnavailable | CatalogueAvailable, Field(discriminator='status')]
    selectedTokenReadStatus: Literal['available', 'partial', 'no_contract', 'unavailable']
    walletInventory: WalletInventoryUnprobed


class CacheObservation(WireModel):
    status: Literal['hit', 'cooldown', 'rate_limited', 'stale_fallback', 'miss']
    ageSeconds: UInt | None
    freshForSeconds: Literal[60]
    maxStaleSeconds: Literal[300]
    scope: Literal['process_local']
    providerUpdateTimeKnown: FalseFlag


class MarketAttribution(WireModel):
    source: Literal['geckoterminal']
    chainId: Literal[4663]
    retrievedAt: UInt
    asOfTimestamp: None
    asOfBlock: None
    poolId: Hash
    sourceUrl: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512)]
    providerReported: TrueFlag
    currencies: Annotated[list[Address], Field(min_length=2, max_length=2)]
    baseToken: Address
    quoteToken: Address


class MarketData(MarketAttribution):
    dexLabel: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128)] | None
    reportedLiquidityUsd: DecimalString | None
    volume24hUsd: DecimalString | None


class Candle(WireModel):
    startTimestamp: UInt
    openUsd: DecimalString
    highUsd: DecimalString
    lowUsd: DecimalString
    closeUsd: DecimalString
    volumeUsd: DecimalString
    closed: StrictBool


class HistoryCoverage(WireModel):
    status: Literal['provider_reported', 'missing']
    requestedLimit: Literal[24]
    returnedCandles: Annotated[StrictInt, Field(ge=0, le=24)]
    closedCandles: Annotated[StrictInt, Field(ge=0, le=24)]
    gapsDetected: StrictBool
    firstTimestamp: UInt | None
    lastTimestamp: UInt | None
    complete24h: FalseFlag
    completeness: Literal['not_established']


class HistoryData(MarketAttribution):
    fetchedAt: UInt
    selectedToken: Literal['base', 'quote']
    currency: Address
    quoteCurrency: Literal['usd']
    intervalSeconds: Literal[3600]
    candles: Annotated[list[Candle], Field(max_length=24)]
    coverage: HistoryCoverage


MarketReason = Literal['provider_capacity_busy', 'provider_rate_limited', 'provider_unavailable',
                       'provider_currency_or_pool_mismatch', 'provider_dex_unconfirmed']
HistoryReason = Literal['provider_capacity_busy', 'provider_rate_limited', 'provider_unavailable',
                        'provider_currency_or_pool_mismatch', 'provider_chart_currency_mismatch',
                        'provider_market_identity_unavailable']


class MarketAvailable(WireModel):
    status: Literal['available', 'stale']
    reason: MarketReason | None
    data: MarketData
    cache: CacheObservation


class MarketUnavailable(WireModel):
    status: Literal['unavailable', 'rejected']
    reason: MarketReason
    data: None
    cache: CacheObservation


MarketObservation = Annotated[MarketAvailable | MarketUnavailable, Field(discriminator='status')]


class HistoryAvailable(WireModel):
    status: Literal['available', 'stale']
    reason: HistoryReason | None
    data: HistoryData
    cache: CacheObservation


class HistoryUnavailable(WireModel):
    status: Literal['unavailable', 'rejected']
    reason: HistoryReason
    data: None
    cache: CacheObservation | None


class HistoryNotRequested(WireModel):
    status: Literal['not_requested']
    reason: None
    data: None
    cache: None


HistoryObservation = Annotated[HistoryAvailable | HistoryUnavailable | HistoryNotRequested,
                               Field(discriminator='status')]


class PoolMarketResponse(WireModel):
    schemaVersion: Literal[1]
    mode: Literal['on_demand_provider_market']
    chainId: Literal[4663]
    poolId: Hash
    pool: VerifiedPool
    snapshot: Snapshot
    market: MarketObservation
    priceHistory: HistoryObservation
    issues: list[Literal['provider_dex_label_unconfirmed']]
    requiresLocalHistory: FalseFlag
    providerMetricsReconciled: FalseFlag
    feeApr24h: None
    aprReason: Literal['provider_lp_fee_history_unavailable']
    suggested: FalseFlag
    executionAvailable: FalseFlag


class EmptyNft(WireModel):
    tokenId: Raw
    status: Literal['position_info_empty_at_snapshot']
    owner: None
    corePositionId: None
    nftOwnershipResolved: FalseFlag


class LiveNft(WireModel):
    tokenId: Raw
    status: Literal['owner_verified_at_snapshot']
    owner: Address
    positionManager: Address
    poolId: Hash
    poolKey: PoolKey
    tickLower: Tick
    tickUpper: Tick
    salt: Hash
    liquidityRaw: Raw
    coreOwner: Address
    corePositionId: Hash
    nftOwnershipResolved: TrueFlag
    ownershipBasis: Literal['ownerOf_at_pinned_block']
    walletControlVerified: FalseFlag
    isWithdrawalQuote: FalseFlag
    executionAvailable: FalseFlag
    principalRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    unsettledFeesRaw: Annotated[list[Raw], Field(min_length=2, max_length=2)]
    inRange: StrictBool
    hasLiquidity: StrictBool
    amountScope: Literal['current_core_principal_and_unsettled_fees_only']
    pastSettledFeesAttributedToCurrentOwner: FalseFlag
    tokenCompatibilityQualified: FalseFlag


class Freshness(WireModel):
    ageSeconds: UInt
    status: Literal['fresh', 'stale']


class NftPositionsResponse(WireModel):
    schemaVersion: Literal[1]
    mode: Literal['public_nft_positions_read_only']
    chainId: Literal[4663]
    snapshot: Snapshot
    items: Annotated[list[Annotated[EmptyNft | LiveNft, Field(discriminator='status')]], Field(min_length=1, max_length=10)]
    requestedIdsOnly: TrueFlag
    ownershipScope: Literal['owner_at_snapshot']
    walletControlVerified: FalseFlag
    freshness: Freshness
    executionAvailable: FalseFlag


# Historical read responses keep raw accounting separate from USD qualification.
RawPair = Annotated[list[Raw], Field(min_length=2, max_length=2)]
# Integrals and cumulative event totals can exceed one uint256 balance.
Total = Annotated[str, StringConstraints(strict=True, pattern=r'^(0|[1-9][0-9]{0,155})$')]
TotalPair = Annotated[list[Total], Field(min_length=2, max_length=2)]


class CatalogueCandidate(WireModel):
    poolKind: Literal['catalogue']
    poolId: Hash
    poolKey: PoolKey
    currencies: Annotated[list[Address], Field(min_length=2, max_length=2)]
    providerMetrics: None
    catalogueSource: Literal['initialize_event', 'verified_observation']
    catalogueObservation: CatalogueObservation
    identityStatus: Literal['catalogue_candidate']
    executionAvailable: FalseFlag


class CatalogueResponse(WireModel):
    schemaVersion: Literal[1]
    mode: Literal['stored_catalogue_candidates']
    chainId: Literal[4663]
    poolManager: Address
    revision: UInt
    startBlock: UInt
    indexedThrough: UInt | None
    coverage: Literal['configured_interval_only']
    completeHistory: FalseFlag
    liveExecution: FalseFlag
    hasMore: StrictBool
    nextAfterPoolId: Hash | None
    items: Annotated[list[CatalogueCandidate], Field(max_length=100)]


class StateSnapshot(Snapshot):
    sqrtPriceX96: Raw
    tick: Tick
    activeLiquidityRaw: Raw
    protocolFeeRaw: Annotated[StrictInt, Field(ge=0, le=16777215)]
    lpFeePips: Annotated[StrictInt, Field(ge=0, le=1_000_000)]
    feeGrowthGlobalX128: RawPair


class ActivityCoverage(WireModel):
    startBlock: UInt
    indexedThrough: UInt
    initializedBlock: UInt
    initializedAt: UInt
    scope: Literal['since_verified_initialize']
    canonicality: Literal['block_hash_rechecked']
    rpcCompleteness: Literal['single_provider_assumption']


class ActivityFreshness(Freshness):
    checkedAgainstHead: UInt


class CoreOwnerUnavailable(WireModel):
    status: Literal['core_owner_adapter_required']
    owner: None
    nftOwnershipResolved: FalseFlag


class NftIdentity(WireModel):
    tokenId: Raw
    status: Literal['owner_verified_at_snapshot']
    owner: Address
    positionManager: Address
    poolId: Hash
    poolKey: PoolKey
    tickLower: Tick
    tickUpper: Tick
    salt: Hash
    liquidityRaw: Raw
    coreOwner: Address
    corePositionId: Hash
    nftOwnershipResolved: TrueFlag
    ownershipBasis: Literal['ownerOf_at_pinned_block']
    walletControlVerified: FalseFlag
    isWithdrawalQuote: FalseFlag
    executionAvailable: FalseFlag


class CorePosition(WireModel):
    corePositionId: Hash
    coreOwner: Address
    tickLower: Tick
    tickUpper: Tick
    salt: Hash
    liquidityRaw: Raw
    lastInsideX128: RawPair
    settledFeesRaw: TotalPair
    principalRaw: RawPair
    unsettledFeesRaw: RawPair
    nft: Annotated[CoreOwnerUnavailable | EmptyNft | NftIdentity, Field(discriminator='status')]


class PositionProof(WireModel):
    blockNumber: UInt
    blockHash: Hash
    corePositions: UInt
    ticks: UInt
    ranges: UInt
    sourceFeeMethodology: Literal[1]


class PositionsUnavailable(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['unavailable']
    lpAssetsRaw: None
    principalRaw: None
    unsettledFeesRaw: None
    reason: Literal['position_ledger_not_caught_up', 'position_accounting_adapter_required']


class PositionsReconciled(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['reconciled_as_of']
    reason: None
    scope: Literal['core_positions_not_nft_ownership']
    basis: Literal['event_token_flows_excluding_protocol']
    lpAssetsRaw: TotalPair
    principalRaw: TotalPair
    unsettledFeesRaw: TotalPair
    roundingResidualRaw: TotalPair
    settledFeesRaw: TotalPair
    principalDepositedRaw: TotalPair
    principalWithdrawnRaw: TotalPair
    corePositionCount: UInt
    nonzeroLiquidityPositionCount: UInt
    knownTickCount: UInt
    donationsIncluded: TrueFlag
    protocolFeesExcluded: TrueFlag
    isWalletBalance: FalseFlag
    isWithdrawalQuote: FalseFlag
    nftOwnershipResolved: StrictBool
    tvlUsd: None
    tvlReason: Literal['timestamp_aligned_valuation_unavailable']
    onchainReconciliation: PositionProof


class PositionsWithOwners(PositionsReconciled):
    items: Annotated[list[CorePosition], Field(max_length=128)]
    nftOwnershipScope: Literal['historical_snapshot_not_current_wallet_authentication']


class ActivityLiquidity(WireModel):
    status: Literal['core_active_liquidity_reconciled']
    activeLiquidityRaw: Raw
    rangeCount: UInt
    isTvl: FalseFlag
    tvlUsd: None
    tvlReason: Literal['timestamp_aligned_valuation_unavailable', 'pool_assets_and_uncollected_fees_not_reconciled']
    positionAccounting: Annotated[PositionsUnavailable | PositionsReconciled, Field(discriminator='status')]


class FeesUnavailable(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['unavailable']
    reason: Literal['fee_ledger_not_caught_up', 'fee_accounting_adapter_required']
    lpFeesRaw: None
    protocolFeesRaw: None
    donationsRaw: None
    basis: Literal['core_trading_fee_before_Q128_distribution_rounding']
    isCollectedAmount: FalseFlag
    isDominoServiceFee: FalseFlag


class FeesReconciled(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['reconciled_as_of']
    reason: None
    lpFeesRaw: TotalPair
    protocolFeesRaw: TotalPair
    donationsRaw: TotalPair
    basis: Literal['core_trading_fee_before_Q128_distribution_rounding']
    isCollectedAmount: FalseFlag
    isDominoServiceFee: FalseFlag
    scope: Literal['since_verified_initialize']
    feeGrowthReconciled: TrueFlag


class ActivityFees(WireModel):
    protocolDirectionalPips: Annotated[list[Annotated[StrictInt, Field(ge=0, le=4095)]], Field(min_length=2, max_length=2)]
    lpFeePipsAtSnapshot: Annotated[StrictInt, Field(ge=0, le=1_000_000)]
    feeGrowthGlobalX128: RawPair
    growthIsTokenAmount: FalseFlag
    growthIncludesDonations: TrueFlag
    accounting: Annotated[FeesUnavailable | FeesReconciled, Field(discriminator='status')]


class SwapLeg(WireModel):
    currencyIndex: Literal[0, 1]
    grossInput: Total
    output: Total
    absoluteTurnover: Total


class Donations(WireModel):
    count: UInt
    amountsRaw: TotalPair


class ActivityWindow(WireModel):
    requestedSeconds: Annotated[StrictInt, Field(ge=1, le=86400)]
    fromTimestampExclusive: SafeInt
    throughTimestamp: UInt
    observedSinceTimestamp: UInt
    observedSeconds: Annotated[StrictInt, Field(ge=0, le=86400)]
    completeWindow: StrictBool
    status: Literal['covered_as_of', 'pool_younger_than_window']
    swapEventCount: UInt
    nonzeroSwapCount: UInt
    swapLegsRaw: Annotated[list[SwapLeg], Field(min_length=2, max_length=2)]
    donations: Donations
    observedTotalSwapFeePips: Annotated[list[Annotated[StrictInt, Field(ge=0, le=1_000_000)]], Field(max_length=50000)]
    volumeUsd: None
    volumeUsdReason: Literal['timestamp_aligned_valuation_unavailable']
    lpFeesRaw: TotalPair | None
    lpFeesReason: Literal['per_step_fee_accounting_not_reconciled', 'fee_ledger_not_caught_up', 'fee_accounting_adapter_required'] | None
    protocolFeesRaw: TotalPair = Field(default=None)
    lpFeesBasis: Literal['core_trading_fee_before_Q128_distribution_rounding'] = Field(default=None)
    feeApr: None
    feeAprReason: Literal['lp_fee_and_time_weighted_tvl_not_reconciled', 'time_weighted_tvl_and_usd_valuation_not_reconciled']
    usableAsCurrent24h: StrictBool


class PoolActivityResponse(WireModel):
    schemaVersion: Literal[1]
    methodologyVersion: Literal[1]
    mode: Literal['core_pool_activity_read_only']
    chainId: Literal[4663]
    poolId: Hash
    poolKey: PoolKey
    revision: UInt
    accountingScope: Literal['core_pool_events_only']
    snapshot: StateSnapshot
    coverage: ActivityCoverage
    freshness: ActivityFreshness
    window24h: ActivityWindow
    liquidity: ActivityLiquidity
    fees: ActivityFees
    storedEventCount: UInt
    suggested: FalseFlag
    executionAvailable: FalseFlag


class PoolPositionsResponse(WireModel):
    schemaVersion: Literal[1]
    mode: Literal['core_pool_positions_read_only']
    chainId: Literal[4663]
    poolId: Hash
    poolKey: PoolKey
    snapshot: StateSnapshot
    coverage: ActivityCoverage
    freshness: ActivityFreshness
    positionAccounting: Annotated[PositionsUnavailable | PositionsWithOwners, Field(discriminator='status')]
    executionAvailable: FalseFlag


class CapitalPoint(WireModel):
    lpAssetsRaw: TotalPair
    principalRaw: TotalPair
    unsettledFeesRaw: TotalPair
    roundingResidualRaw: TotalPair
    principalDepositedRaw: TotalPair
    principalWithdrawnRaw: TotalPair
    settledFeesRaw: TotalPair
    sqrtPriceX96: Raw
    tick: Tick


class CapitalIntegral(WireModel):
    lpAssetsRaw: TotalPair
    principalRaw: TotalPair
    unsettledFeesRaw: TotalPair
    roundingResidualRaw: TotalPair


class CapitalReconciled(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['reconciled_event_history']
    fromTimestampInclusive: UInt
    throughTimestamp: UInt
    observedSeconds: Annotated[StrictInt, Field(ge=0, le=86400)]
    complete24h: StrictBool
    timeWeighting: Literal['post_event_step_function_last_event_wins_at_same_timestamp']
    tvlBasis: Literal['lp_attributed_assets_including_unsettled_fees_and_rounding_residual_excluding_protocol']
    current: CapitalPoint
    integralRawSeconds: CapitalIntegral
    averageDenominatorSeconds: UInt
    sourceEventCount: UInt
    sourceChunks: UInt
    isInvestorPnl: FalseFlag


CapitalReason = Literal['reconciled_position_tail_required', 'capital_ledger_not_caught_up', 'capital_window_budget_exhausted']


class CapitalUnavailable(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['unavailable']
    reason: CapitalReason
    current: None
    integralRawSeconds: None
    complete24h: FalseFlag


class PriceCoverage(WireModel):
    status: Literal['not_assessed', 'missing', 'incomplete', 'complete']
    startTimestamp: UInt
    endTimestamp: UInt
    maxAgeSeconds: UInt | None


class PriceEvidenceAssessed(WireModel):
    currency: Address
    observations: UInt
    observedSources: Annotated[list[Literal['alchemy_historical', 'chainlink_robinhood_standard_v1']], Field(max_length=2)]
    firstTimestamp: UInt | None
    lastTimestamp: UInt | None
    status: Literal['observed_unqualified', 'unavailable', 'qualified']
    reason: Literal['price_source_quality_not_qualified', 'price_history_missing', 'qualified_price_coverage_gap'] | None
    sourceQualification: Literal['qualified', 'unqualified']
    coverage: PriceCoverage


class PriceCoverageUnassessed(WireModel):
    status: Literal['not_assessed']
    startTimestamp: UInt
    endTimestamp: UInt
    maxAgeSeconds: None


class PriceEvidenceUnassessed(WireModel):
    currency: Address
    observations: None
    observedSources: None
    firstTimestamp: None
    lastTimestamp: None
    status: Literal['unavailable']
    reason: Literal['price_observation_budget_exhausted', 'capital_history_unavailable']
    sourceQualification: Literal['not_assessed']
    coverage: PriceCoverageUnassessed


PriceEvidence = Annotated[PriceEvidenceAssessed | PriceEvidenceUnassessed, Field(discriminator='sourceQualification')]


ValuationReason = Literal['qualified_usd_prices_required', 'price_pool_independence_not_qualified',
    'reference_price_pool_currencies_mismatch', 'zero_observed_duration', 'qualified_price_coverage_gap',
    'swap_outside_valuation_window', 'reconciled_swap_fees_required', 'ambiguous_swap_input',
    'price_observation_budget_exhausted', 'capital_history_unavailable']


class ValuationUnavailable(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['unavailable']
    reason: ValuationReason
    tvlUsd: None
    timeWeightedAverageTvlUsd: None
    tradingLpFeesUsd: None
    grossInputVolumeUsd: None
    feeAprPercent: None


class ValuationCalculated(WireModel):
    methodologyVersion: Literal[1]
    status: Literal['reference_analytics_only', 'qualified_historical_calculation']
    tvlUsd: DecimalString
    timeWeightedAverageTvlUsd: DecimalString
    tradingLpFeesUsd: DecimalString
    grossInputVolumeUsd: DecimalString
    feeAprPercent: DecimalString | None
    feeAprReason: Literal['pool_younger_than_window', 'zero_time_weighted_tvl'] | None
    complete24h: StrictBool
    observedSeconds: UInt
    priceConvention: Literal['publication_plus_one_second_and_answer_age_reference_policy', 'causal_last_observation_with_qualified_max_age']
    feeAprBasis: Literal['365_times_full_day_trading_lp_fees_over_time_weighted_lp_assets']
    annualizationDays: Literal[365]
    isPositionApr: FalseFlag
    isApy: FalseFlag
    includesDominoServiceFee: FalseFlag
    includesTokenPricePnl: FalseFlag
    decimalPlaces: Literal[18]
    executionAvailable: FalseFlag


class MetricsCoverage(WireModel):
    canonicality: Literal['block_hash_rechecked']
    rpcCompleteness: Literal['single_provider_assumption']


class PoolMetricsResponse(WireModel):
    model_config = ConfigDict(extra='forbid', strict=True, json_schema_extra={
        'x-domino-constraints': ['usableAsCurrent24h requires qualified_historical_calculation, '
            'complete24h capital and valuation, fresh snapshot, and non-null feeAprPercent']})
    schemaVersion: Literal[1]
    mode: Literal['historical_pool_metrics_read_only']
    chainId: Literal[4663]
    poolId: Hash
    poolKey: PoolKey
    snapshot: StateSnapshot
    revision: UInt
    capital: Annotated[CapitalReconciled | CapitalUnavailable, Field(discriminator='status')]
    prices: Annotated[list[PriceEvidence], Field(min_length=2, max_length=2)]
    valuation: Annotated[ValuationUnavailable | ValuationCalculated, Field(discriminator='status')]
    freshness: Freshness
    usableAsCurrent24h: StrictBool
    suggested: FalseFlag
    executionAvailable: FalseFlag
    coverage: MetricsCoverage

    @model_validator(mode='after')
    def current_apr_requires_qualification(self):
        if self.usableAsCurrent24h and not (
                self.valuation.status == 'qualified_historical_calculation'
                and self.valuation.complete24h and self.valuation.feeAprPercent is not None
                and self.capital.status == 'reconciled_event_history' and self.capital.complete24h
                and self.freshness.status == 'fresh'):
            raise ValueError('current_24h_apr_requires_complete_fresh_qualified_valuation')
        return self


class BridgeCapabilities(WireModel):
    contractVersion: Literal['1.1.0-rc.3']
    dataMode: Literal['disabled', 'live_read_only']
    chainId: Literal[4663]
    enabledReads: Annotated[list[ReadRoute], Field(max_length=9, json_schema_extra={"uniqueItems": True})]
    walletAuthentication: FalseFlag
    privateAccounts: FalseFlag
    ownerTransactions: FalseFlag
    automation: FalseFlag

    @model_validator(mode='after')
    def coherent_mode(self):
        if len(set(self.enabledReads)) != len(self.enabledReads):
            raise ValueError('duplicate_enabled_reads')
        if self.dataMode == 'disabled' and self.enabledReads:
            raise ValueError('disabled_reads_must_be_empty')
        return self


# Only reviewed, finite codes may leave the HTTP boundary. Unknown provider or
# exception text maps to upstream_unavailable; it never becomes the wire code.
ERROR_STATUS_BY_CODE = {
    'invalid_or_expired_cursor': 400, 'invalid_token_list': 400,
    'local_client_required': 403, 'origin_not_allowed': 403,
    'route_not_available': 404, 'method_not_allowed': 405,
    'request_timeout': 408, 'catalogue_revision_changed': 409,
    'request_too_large': 413, 'json_required': 415, 'invalid_request': 422,
    'read_capacity_busy': 429,
    'upstream_contract_mismatch': 502, 'upstream_invalid_response': 502,
    'upstream_unavailable': 503, 'upstream_timeout': 504,
}
for _code in (
    'snapshot_reorganized', 'nft_snapshot_reorganized', 'activity_snapshot_reorganized',
    'metrics_snapshot_reorganized', 'stale_or_future_block', 'wrong_chain',
    'missing_contract_code', 'manager_mismatch', 'block_unavailable',
    'rpc_error', 'rpc_call_gas_limit', 'rpc_call_reverted',
    'network_unavailable', 'request_budget_exhausted',
    'invalid_rpc_envelope', 'missing_rpc_result', 'invalid_abi_response',
    'invalid_quantity', 'quantity_too_large', 'invalid_json', 'response_too_large',
    'invalid_pool_key', 'invalid_tick_spacing', 'pool_id_mismatch', 'invalid_pool_state',
    'fixed_fee_mismatch', 'provider_currency_mismatch', 'catalogue_not_configured',
    'catalogue_database_unavailable', 'catalogue_schema_mismatch',
    'activity_not_indexed', 'activity_pool_not_registered', 'activity_methodology_mismatch',
    'activity_window_budget_exhausted',
    'invalid_nft_snapshot_block', 'invalid_nft_position_info', 'nft_pool_or_range_mismatch',
    'nft_live_position_has_no_owner', 'nft_core_liquidity_mismatch',
):
    ERROR_STATUS_BY_CODE[_code] = 503
ERROR_STATUS_BY_CODE['read_deadline_exceeded'] = 504
ErrorCode = Literal[tuple(sorted(ERROR_STATUS_BY_CODE))]


class ErrorResponse(WireModel):
    error: ErrorCode


RESPONSE_MODELS = {
    'token': TokenResponse, 'pools': PoolsResponse, 'pool-market': PoolMarketResponse,
    'wallet-assets': WalletAssetsResponse, 'nft-positions': NftPositionsResponse,
    'catalogue': CatalogueResponse, 'pool-activity': PoolActivityResponse,
    'pool-positions': PoolPositionsResponse, 'pool-metrics': PoolMetricsResponse,
}


def validate_response(route, payload):
    """Raise on drift, return the exact input unchanged (no repair or dropping)."""
    model = BridgeCapabilities if route == 'capabilities' else RESPONSE_MODELS[route]
    model.model_validate(payload, strict=True)
    return payload


def sanitize_error(code):
    """Return a reviewed (status, body) pair without including untrusted input."""
    safe = code if type(code) is str and code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
    return ERROR_STATUS_BY_CODE[safe], {'error': safe}


def export_contract():
    """Return standalone draft 2020-12 schemas for the neutral shared package."""
    result = {}
    for route, model in {**RESPONSE_MODELS, 'capabilities': BridgeCapabilities, 'error': ErrorResponse}.items():
        schema = model.model_json_schema()
        # Omitted optional response fields must never advertise invalid null defaults.
        def remove_defaults(value):
            if isinstance(value, dict):
                value.pop('default', None)
                for child in value.values(): remove_defaults(child)
            elif isinstance(value, list):
                for child in value: remove_defaults(child)
        remove_defaults(schema)
        schema.update({'$schema': 'https://json-schema.org/draft/2020-12/schema',
                       '$id': f'https://domino.invalid/contracts/read-v1/{route}.response.schema.json',
                       'x-contract-version': CONTRACT_VERSION})
        result[f'{route}.response.schema.json'] = schema
    return result
