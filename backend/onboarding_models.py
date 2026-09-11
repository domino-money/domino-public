"""Closed preview-only onboarding contract; no browser-supplied owner or authority."""
from decimal import Decimal
from fractions import Fraction
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, ValidationError, model_validator

from discovery import PoolKey, ZERO
from lp_mint_inspection import MAX_LIQUIDITY
from uniswap_liquidity import SCHEMA_COMMIT

CONTRACT_VERSION = '1.0.0'
MAX_BODY = 8192
MAX_RESPONSE = 131072
UINT256_MAX = (1 << 256) - 1
ERROR_STATUS_BY_CODE = {
    'invalid_request': 400, 'session_required': 401, 'csrf_invalid': 403,
    'account_unsupported': 403, 'origin_not_allowed': 403, 'route_not_available': 404,
    'method_not_allowed': 405, 'preview_expired': 409, 'request_too_large': 413,
    'json_required': 415, 'session_rate_limited': 429, 'session_capacity_busy': 429,
    'onboarding_rate_limited': 429, 'onboarding_capacity_busy': 429,
    'provider_rate_limited': 429, 'upstream_invalid_response': 502,
    'upstream_contract_mismatch': 502, 'session_store_unavailable': 503,
    'account_check_unavailable': 503, 'provider_unavailable': 503,
    'provider_request_rejected': 422, 'upstream_unavailable': 503,
    'request_timeout': 504, 'upstream_timeout': 504,
}


class OnboardingError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


def _raw(value):
    if int(value) > UINT256_MAX:
        raise ValueError('uint256_required')
    return value


def _uint128(value):
    if int(value) >= 2**128:
        raise ValueError('uint128_required')
    return value


def _liquidity(value):
    if int(value) > MAX_LIQUIDITY:
        raise ValueError('liquidity_limit')
    return value


def _boolean(value):
    if type(value) is not bool:
        raise ValueError('boolean_required')
    return value


def _decimal_bound(low, high, *, hundredths=False):
    def check(value):
        decimal = Decimal(value)
        if not Decimal(str(low)) <= decimal <= Decimal(str(high)) or decimal.as_tuple().exponent < -36:
            raise ValueError('decimal_out_of_bounds')
        if hundredths and (Fraction(decimal) * 100).denominator != 1:
            raise ValueError('fractional_bps_precision')
        return value
    return check


def _block(value):
    if int(value) > 2**63-1:
        raise ValueError('block_out_of_bounds')
    return value


def _decimal(value):
    if not Decimal(value).is_finite():
        raise ValueError('finite_decimal_required')
    return value


Address = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{40}$', min_length=42, max_length=42)]
NormalizedAddress = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
PoolId = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
Raw = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,77})$', max_length=78), AfterValidator(_raw)]
PositiveRaw = Annotated[str, Field(pattern=r'^[1-9][0-9]{0,77}$', max_length=78), AfterValidator(_raw)]
Raw128 = Annotated[Raw, AfterValidator(_uint128), Field(json_schema_extra={'x-maximum-raw': str(2**128-1)})]
LiquidityRaw = Annotated[PositiveRaw, AfterValidator(_liquidity), Field(json_schema_extra={'x-maximum-raw': str(MAX_LIQUIDITY)})]
Chain = Annotated[StrictInt, Field(ge=4663, le=4663)]
SchemaVersion = Annotated[StrictInt, Field(ge=1, le=1)]
Tick = Annotated[StrictInt, Field(ge=-887272, le=887272)]
Slippage = Annotated[StrictInt, Field(ge=0, le=9999)]
Impact = Annotated[StrictInt, Field(ge=0, le=10000)]
Timestamp = Annotated[StrictInt, Field(ge=0, le=2**53-1)]
FalseFlag = Annotated[Literal[False], BeforeValidator(_boolean)]
TrueFlag = Annotated[Literal[True], BeforeValidator(_boolean)]
# Adapter emits fixed-point strings; bounds preserve its full decimal precision.
DecimalString = Annotated[str, Field(pattern=r'^-?(0|[1-9][0-9]*)(\.[0-9]+)?$', max_length=208), AfterValidator(_decimal)]
UnsignedDecimal = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]*)(\.[0-9]+)?$', max_length=208), AfterValidator(_decimal)]
PriceImpact = Annotated[DecimalString, AfterValidator(_decimal_bound(-100, 100)), Field(json_schema_extra={'x-minimum-decimal': '-100', 'x-maximum-decimal': '100', 'x-fraction-digits': 36})]
GasUsd = Annotated[UnsignedDecimal, AfterValidator(_decimal_bound(0, 10**30)), Field(json_schema_extra={'x-minimum-decimal': '0', 'x-maximum-decimal': str(10**30), 'x-fraction-digits': 36})]
FeeBps = Annotated[UnsignedDecimal, AfterValidator(_decimal_bound(0, 10000, hundredths=True)), Field(json_schema_extra={'x-minimum-decimal': '0', 'x-maximum-decimal': '10000', 'x-fraction-digits': 36, 'x-hundredths': True})]
Fingerprint = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$', min_length=64, max_length=64)]


class PoolKeyModel(StrictModel):
    currency0: NormalizedAddress
    currency1: NormalizedAddress
    fee_pips: Annotated[StrictInt, Field(ge=0, le=1000000)]
    tick_spacing: Annotated[StrictInt, Field(ge=1, le=32767)]
    hooks: Literal[ZERO]

    @model_validator(mode='after')
    def canonical(self):
        if self.currency0 >= self.currency1:
            raise ValueError('canonical_pair_required')
        return self

    def checked(self, pool_id):
        return PoolKey.checked(tuple(self.model_dump().values()), pool_id)


class SwapRequest(StrictModel):
    chainId: Chain
    tokenIn: Address
    tokenOut: Address
    amountRaw: PositiveRaw
    slippageBps: Slippage
    maxPriceImpactBps: Impact

    @model_validator(mode='after')
    def distinct(self):
        if self.tokenIn.lower() == self.tokenOut.lower():
            raise ValueError('distinct_pair_required')
        return self


class PositionRequest(StrictModel):
    chainId: Chain
    poolId: PoolId
    poolKey: PoolKeyModel
    independentToken: Address
    amountRaw: PositiveRaw
    tickLower: Tick
    tickUpper: Tick
    slippageBps: Slippage
    budget0Raw: Raw | None = None
    budget1Raw: Raw | None = None
    nativeBalanceRaw: Raw | None = None
    nativeGasReserveRaw: Raw | None = None

    @model_validator(mode='after')
    def selected_limits(self):
        self.poolKey.checked(self.poolId)
        currencies = (self.poolKey.currency0, self.poolKey.currency1)
        if self.independentToken.lower() not in currencies:
            raise ValueError('independent_currency_required')
        if (self.tickLower >= self.tickUpper or self.tickLower % self.poolKey.tick_spacing
                or self.tickUpper % self.poolKey.tick_spacing):
            raise ValueError('spaced_range_required')
        budget = (self.budget0Raw, self.budget1Raw)[currencies.index(self.independentToken.lower())]
        if budget is not None and int(self.amountRaw) > int(budget):
            raise ValueError('input_exceeds_budget')
        if self.nativeGasReserveRaw is not None and self.nativeBalanceRaw is None:
            raise ValueError('native_balance_required')
        return self


class SwapIdentity(SwapRequest):
    owner: NormalizedAddress


class PositionIdentity(PositionRequest):
    owner: NormalizedAddress
    # Adapter identities always include the optional fields, including null.
    budget0Raw: Raw | None
    budget1Raw: Raw | None
    nativeBalanceRaw: Raw | None
    nativeGasReserveRaw: Raw | None


class RouteToken(StrictModel):
    address: NormalizedAddress
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None


class RouteHop(StrictModel):
    poolId: PoolId
    poolKey: PoolKeyModel
    tokenIn: RouteToken
    tokenOut: RouteToken
    amountInRaw: PositiveRaw | None
    amountOutRaw: PositiveRaw | None

    @model_validator(mode='after')
    def pool_identity(self):
        self.poolKey.checked(self.poolId)
        if sorted((self.tokenIn.address, self.tokenOut.address)) != [self.poolKey.currency0, self.poolKey.currency1]:
            raise ValueError('route_pair_mismatch')
        return self


class QuoteAmounts(StrictModel):
    dexInputAmountRaw: PositiveRaw
    grossOutputAmountRaw: PositiveRaw
    grossMinimumOutputAmountRaw: PositiveRaw
    policyMinimumOutputRaw: Raw
    outputAfterProviderFeeRaw: PositiveRaw | None
    minimumAfterProviderFeeRaw: PositiveRaw | None
    priceImpactPercent: PriceImpact | None
    routes: Annotated[list[Annotated[list[RouteHop], Field(min_length=1, max_length=4)]], Field(min_length=1, max_length=8)]


SwapReason = Literal['price_impact_unknown', 'price_impact_exceeded', 'provider_output_fee_unknown',
    'provider_output_fee_unsupported_nonzero', 'simulation_unknown', 'provider_simulation_failed', 'gas_estimate_incomplete']


class SwapChecks(StrictModel):
    status: Literal['within_observed_limits', 'blocked']
    reasons: Annotated[list[SwapReason], Field(max_length=7)]

    @model_validator(mode='after')
    def consistent(self):
        if (self.status == 'blocked') != bool(self.reasons) or len(set(self.reasons)) != len(self.reasons):
            raise ValueError('check_status_mismatch')
        return self


class AggregateOutput(StrictModel):
    recipient: NormalizedAddress
    amountRaw: Raw
    minimumAmountRaw: Raw
    bps: FeeBps | None
    kind: Literal['INTEGRATOR'] | None


class ProviderFee(StrictModel):
    status: Literal['reported_zero', 'unsupported_nonzero', 'unknown']
    basis: Literal['output_currency']
    currency: NormalizedAddress
    bps: FeeBps | None
    amountRaw: Raw | None
    recipient: NormalizedAddress | None
    aggregatedOutputs: Annotated[list[AggregateOutput], Field(min_length=1, max_length=4)] | None
    zeroEvidence: Literal['aggregated_outputs', 'explicit_legacy_portion'] | None

    @model_validator(mode='after')
    def zero_evidence(self):
        if (self.status == 'reported_zero') != (self.zeroEvidence is not None):
            raise ValueError('fee_evidence_mismatch')
        if self.status == 'reported_zero' and ((self.bps is not None and Decimal(self.bps) != 0) or
                                               (self.amountRaw is not None and self.amountRaw != '0')):
            raise ValueError('zero_fee_mismatch')
        return self


class SwapDominoFee(StrictModel):
    status: Literal['tariff_not_selected']
    bps: None
    amountRaw: None
    basis: Literal['consumed_owner_selected_gross_input']
    ceilingBps: Annotated[StrictInt, Field(ge=65, le=65)]
    includedInDexInput: FalseFlag
    automationFeeApplies: FalseFlag


class SwapGas(StrictModel):
    feeWei: Raw | None
    units: Raw | None
    usd: GasUsd | None
    source: Literal['provider_estimate']
    includesApprovals: FalseFlag
    fullNetworkCostVerified: FalseFlag


FailureCode = Literal['SIMULATION_ERROR', 'UNSUPPORTED_SIMULATION', 'SIMULATION_UNAVAILABLE', 'SLIPPAGE_TOO_LOW', 'TRANSFER_FROM_FAILED']


class SwapSimulation(StrictModel):
    status: Literal['unknown', 'provider_reported_failure', 'no_provider_failure_reported']
    failureCodes: Annotated[list[FailureCode], Field(max_length=16)] | None
    independentSuccessProven: FalseFlag

    @model_validator(mode='after')
    def consistent(self):
        expected = 'unknown' if self.failureCodes is None else 'provider_reported_failure' if self.failureCodes else 'no_provider_failure_reported'
        if self.status != expected:
            raise ValueError('simulation_status_mismatch')
        return self


class SwapProvenance(StrictModel):
    endpoint: Literal['https://trade-api.gateway.uniswap.org/v1/quote']
    schemaCommit: Literal[SCHEMA_COMMIT]
    routerVersion: Literal['2.1.1']
    providerBlockNumber: Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,18})$', max_length=19, json_schema_extra={'x-maximum-raw': str(2**63-1)}), AfterValidator(_block)] | None
    providerBlockHash: None
    onchainSnapshotVerified: FalseFlag
    routeIdentity: Literal['provider_pool_key_hash_checked']
    tokenTransferSafetyVerified: FalseFlag
    ownerControlVerified: FalseFlag


class PreviewBase(StrictModel):
    schemaVersion: SchemaVersion
    chainId: Chain
    status: Literal['preview_only']
    executionAvailable: FalseFlag
    requestedAt: Timestamp
    retrievedAt: Timestamp
    expiresAt: Timestamp
    requestFingerprint: Fingerprint

    @model_validator(mode='after')
    def timestamps(self):
        if not self.requestedAt <= self.retrievedAt < self.expiresAt or self.expiresAt != self.requestedAt + 30:
            raise ValueError('preview_times_mismatch')
        return self


class SwapPreview(PreviewBase):
    source: Literal['uniswap_trading_quote_v1']
    quote: QuoteAmounts
    previewChecks: SwapChecks
    providerOutputFee: ProviderFee
    dominoFee: SwapDominoFee
    gas: SwapGas
    simulation: SwapSimulation
    approvalApplicable: bool | None
    provenance: SwapProvenance
    request: SwapIdentity

    @model_validator(mode='after')
    def associations(self):
        request, quote = self.request, self.quote
        if request.owner == ZERO or quote.dexInputAmountRaw != request.amountRaw or self.providerOutputFee.currency != request.tokenOut.lower():
            raise ValueError('swap_request_mismatch')
        total_in = total_out = 0
        for path in quote.routes:
            if path[0].tokenIn.address != request.tokenIn.lower() or path[-1].tokenOut.address != request.tokenOut.lower():
                raise ValueError('swap_route_endpoints_mismatch')
            if path[0].amountInRaw is None or path[-1].amountOutRaw is None:
                raise ValueError('swap_boundary_amount_missing')
            for previous, current in zip(path, path[1:]):
                if previous.tokenOut.address != current.tokenIn.address:
                    raise ValueError('swap_route_disconnected')
            total_in += int(path[0].amountInRaw)
            total_out += int(path[-1].amountOutRaw)
        if total_in != int(quote.dexInputAmountRaw) or total_out != int(quote.grossOutputAmountRaw):
            raise ValueError('swap_amount_mismatch')
        floor = int(quote.grossOutputAmountRaw) * (10000-request.slippageBps) // 10000
        if int(quote.policyMinimumOutputRaw) != floor or not floor <= int(quote.grossMinimumOutputAmountRaw) <= int(quote.grossOutputAmountRaw):
            raise ValueError('swap_minimum_mismatch')
        expected = (quote.grossOutputAmountRaw, quote.grossMinimumOutputAmountRaw) if self.providerOutputFee.status == 'reported_zero' else (None, None)
        if (quote.outputAfterProviderFeeRaw, quote.minimumAfterProviderFeeRaw) != expected:
            raise ValueError('swap_fee_projection_mismatch')
        reasons = []
        if quote.priceImpactPercent is None: reasons.append('price_impact_unknown')
        elif Fraction(quote.priceImpactPercent) * 100 > request.maxPriceImpactBps: reasons.append('price_impact_exceeded')
        if self.providerOutputFee.status != 'reported_zero': reasons.append('provider_output_fee_' + self.providerOutputFee.status)
        if self.simulation.failureCodes is None: reasons.append('simulation_unknown')
        elif self.simulation.failureCodes: reasons.append('provider_simulation_failed')
        if self.gas.feeWei is None or self.gas.units is None: reasons.append('gas_estimate_incomplete')
        if self.previewChecks.reasons != reasons:
            raise ValueError('swap_checks_mismatch')
        return self


class PositionToken(StrictModel):
    address: NormalizedAddress
    expectedDepositRaw: Raw
    maximumDebitRaw: Raw128
    selectedBudgetRaw: Raw | None
    budgetStatus: Literal['unknown', 'exceeded', 'within_limit']
    estimatedUnspentBudgetRaw: Raw | None
    unspentAtMaximumRaw: Raw | None

    @model_validator(mode='after')
    def limits(self):
        nominal, maximum = int(self.expectedDepositRaw), int(self.maximumDebitRaw)
        if nominal > maximum:
            raise ValueError('deposit_exceeds_maximum')
        budget = None if self.selectedBudgetRaw is None else int(self.selectedBudgetRaw)
        status = 'unknown' if budget is None else 'exceeded' if maximum > budget else 'within_limit'
        unspent = None if budget is None or nominal > budget else str(budget-nominal)
        at_max = None if budget is None or maximum > budget else str(budget-maximum)
        if (self.budgetStatus, self.estimatedUnspentBudgetRaw, self.unspentAtMaximumRaw) != (status, unspent, at_max):
            raise ValueError('budget_projection_mismatch')
        return self


class AdjustedPrices(StrictModel):
    min: UnsignedDecimal
    max: UnsignedDecimal
    unit: Literal['raw_token1_per_raw_token0']
    status: Literal['provider_reported']
    humanPrices: None

    @model_validator(mode='after')
    def ordered(self):
        if not Decimal('1e-78') <= Decimal(self.min) < Decimal(self.max) <= Decimal('1e78'):
            raise ValueError('ordered_prices_required')
        return self


class Position(StrictModel):
    poolId: PoolId
    poolKey: PoolKeyModel
    recipient: NormalizedAddress
    tickLower: Tick
    tickUpper: Tick
    tokens: Annotated[list[PositionToken], Field(min_length=2, max_length=2)]
    mintLiquidityRaw: LiquidityRaw
    adjustedPrices: AdjustedPrices

    @model_validator(mode='after')
    def identity(self):
        self.poolKey.checked(self.poolId)
        if [token.address for token in self.tokens] != [self.poolKey.currency0, self.poolKey.currency1]:
            raise ValueError('position_currency_mismatch')
        if self.tickLower >= self.tickUpper or self.tickLower % self.poolKey.tick_spacing or self.tickUpper % self.poolKey.tick_spacing:
            raise ValueError('spaced_range_required')
        return self


PositionReason = Literal['token0_maximum_exceeds_budget', 'token1_maximum_exceeds_budget',
    'token0_budget_unknown', 'token1_budget_unknown', 'native_balance_unknown',
    'native_gas_reserve_unspecified', 'native_deposit_exceeds_balance', 'native_gas_reserve_exceeded']


class PositionChecks(StrictModel):
    status: Literal['blocked', 'incomplete', 'within_selected_limits']
    reasons: Annotated[list[PositionReason], Field(max_length=8)]

    @model_validator(mode='after')
    def consistent(self):
        blocked = any(reason.endswith('exceeded') or reason.endswith('exceeds_budget') or reason.endswith('exceeds_balance') for reason in self.reasons)
        expected = 'blocked' if blocked else 'incomplete' if self.reasons else 'within_selected_limits'
        if self.status != expected or len(set(self.reasons)) != len(self.reasons):
            raise ValueError('check_status_mismatch')
        return self


class NativeFunding(StrictModel):
    depositMaximumRaw: Raw
    reportedBalanceRaw: Raw | None
    selectedGasReserveRaw: Raw | None
    balanceIndependentlyVerified: FalseFlag
    reserveCoversActualGasVerified: FalseFlag


class PositionGas(StrictModel):
    feeWei: Raw | None
    source: Literal['provider_estimate'] | None
    fullNetworkCostVerified: FalseFlag

    @model_validator(mode='after')
    def source_matches(self):
        if (self.feeWei is None) != (self.source is None):
            raise ValueError('gas_source_mismatch')
        return self


class PositionDominoFee(StrictModel):
    status: Literal['not_applicable_direct_deposit']
    bps: Annotated[StrictInt, Field(ge=0, le=0)]
    automationFeeApplies: FalseFlag
    assistedSwapPerformed: FalseFlag


class PositionSimulation(StrictModel):
    status: Literal['not_requested']
    independentSuccessProven: FalseFlag


class PositionProvenance(StrictModel):
    schemaCommit: Literal[SCHEMA_COMMIT]
    calculation: Literal['uniswap_lp_create']
    mintIdentityAndLimitsInspected: TrueFlag
    onchainSnapshotVerified: FalseFlag
    blockNumber: None
    balancesAndAllowancesVerified: FalseFlag
    tokenSafetyVerified: FalseFlag
    slippageModelIndependentlyVerified: FalseFlag


class PositionPreview(PreviewBase):
    source: Literal['uniswap_liquidity_create_v1']
    position: Position
    previewChecks: PositionChecks
    nativeFunding: NativeFunding
    gas: PositionGas
    dominoFee: PositionDominoFee
    simulation: PositionSimulation
    provenance: PositionProvenance
    request: PositionIdentity
    preparedDeadline: Timestamp

    @model_validator(mode='after')
    def deadline(self):
        if self.preparedDeadline != self.requestedAt + 1200:
            raise ValueError('prepared_deadline_mismatch')
        request, position, native = self.request, self.position, self.nativeFunding
        if (request.owner in (ZERO, '0x' + '0'*39 + '1', '0x' + '0'*39 + '2') or
                position.recipient != request.owner or position.poolId != request.poolId or
                position.poolKey != request.poolKey or position.tickLower != request.tickLower or position.tickUpper != request.tickUpper):
            raise ValueError('position_request_mismatch')
        if [token.selectedBudgetRaw for token in position.tokens] != [request.budget0Raw, request.budget1Raw]:
            raise ValueError('position_budget_mismatch')
        if native.reportedBalanceRaw != request.nativeBalanceRaw or native.selectedGasReserveRaw != request.nativeGasReserveRaw:
            raise ValueError('native_request_mismatch')
        native_maximum = position.tokens[0].maximumDebitRaw if request.poolKey.currency0 == ZERO else '0'
        if native.depositMaximumRaw != native_maximum:
            raise ValueError('native_deposit_mismatch')
        independent = next(token for token in position.tokens if token.address == request.independentToken.lower())
        if int(independent.expectedDepositRaw) > int(request.amountRaw) or not any(int(token.expectedDepositRaw) for token in position.tokens):
            raise ValueError('position_amount_mismatch')
        blocked, incomplete = [], []
        for index, token in enumerate(position.tokens):
            if token.budgetStatus == 'exceeded': blocked.append(f'token{index}_maximum_exceeds_budget')
            if token.budgetStatus == 'unknown': incomplete.append(f'token{index}_budget_unknown')
        if native.reportedBalanceRaw is None: incomplete.append('native_balance_unknown')
        elif int(native.depositMaximumRaw) > int(native.reportedBalanceRaw): blocked.append('native_deposit_exceeds_balance')
        if native.selectedGasReserveRaw is None: incomplete.append('native_gas_reserve_unspecified')
        elif int(native.depositMaximumRaw) + int(native.selectedGasReserveRaw) > int(native.reportedBalanceRaw): blocked.append('native_gas_reserve_exceeded')
        if self.previewChecks.reasons != blocked + incomplete:
            raise ValueError('position_checks_mismatch')
        return self


class SwapResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    preview: SwapPreview


class PositionResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    preview: PositionPreview


REQUEST_MODELS = {'swap-preview': SwapRequest, 'position-preview': PositionRequest}
RESPONSE_MODELS = {'swap-preview': SwapResponse, 'position-preview': PositionResponse}
ROUTES = frozenset(REQUEST_MODELS)


def validate_request(route, body):
    try:
        return REQUEST_MODELS[route].model_validate(body)
    except (KeyError, ValueError, TypeError, ValidationError):
        raise OnboardingError('invalid_request') from None


def validate_response(route, body):
    try:
        return RESPONSE_MODELS[route].model_validate(body).model_dump()
    except (KeyError, ValueError, TypeError, ValidationError):
        raise OnboardingError('upstream_contract_mismatch') from None
