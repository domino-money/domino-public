"""Closed owner-signed direct-deposit contract, separate from preview contracts."""
from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StrictBool, StrictInt, model_validator

from discovery import ZERO, POSITION_MANAGER
from onboarding_models import (StrictModel, Chain, NormalizedAddress, PoolId, Raw,
    Raw128, PositiveRaw, LiquidityRaw, Tick, Slippage, Timestamp, Fingerprint,
    PoolKeyModel, FalseFlag, TrueFlag, ERROR_STATUS_BY_CODE as AUTH_ERRORS)

CONTRACT_VERSION = '1.1.0-rc.2'
MAX_BODY = 8192
MAX_RESPONSE = 262144
ERROR_STATUS_BY_CODE = {**AUTH_ERRORS,
    'deposit_invalid_request': 400, 'deposit_not_found': 404,
    'deposit_idempotency_conflict': 409, 'deposit_version_conflict': 409,
    'deposit_owner_busy': 409, 'deposit_state_conflict': 409,
    'deposit_artifact_expired': 409, 'deposit_history_full': 409,
    'deposit_capacity_busy': 429, 'deposit_owner_capacity_busy': 429, 'deposit_owner_history_full': 429, 'deposit_store_unavailable': 503,
    'deposit_preparation_unavailable': 503, 'deposit_admission_required': 422,
    'deposit_reconciliation_unavailable': 503,
    'deposit_allowance_unavailable': 503,
    'deposit_wallet_pending': 409, 'deposit_funding_insufficient': 422,
    'deposit_fee_cap_too_low': 422, 'deposit_gas_limit_exceeded': 422,
    'deposit_gas_balance_insufficient': 422, 'deposit_state_changed': 409,
}


class DepositError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


Id = Annotated[str, Field(pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', min_length=36, max_length=36)]
Version = Annotated[StrictInt, Field(ge=1, le=2**31-1)]
BlockNumber = Annotated[StrictInt, Field(ge=0, le=2**53-1)]
Kind = Literal['erc20_reset', 'erc20_approval', 'permit2_approval', 'mint']
State = Literal['draft', 'awaiting_wallet', 'pending', 'confirmed', 'reverted', 'cancel_requested', 'cancelled', 'attention', 'superseded']


def _nonce(value):
    if int(value) >= 2**64:
        raise ValueError('nonce_out_of_bounds')
    return value


Nonce = Annotated[Raw, AfterValidator(_nonce), Field(json_schema_extra={'x-maximum-raw': str(2**64-1)})]


class DepositSelection(StrictModel):
    chainId: Chain
    poolId: PoolId
    poolKey: PoolKeyModel
    independentToken: NormalizedAddress
    amountRaw: PositiveRaw
    tickLower: Tick
    tickUpper: Tick
    slippageBps: Slippage
    budget0Raw: Raw128
    budget1Raw: Raw128
    nativeGasReserveRaw: Raw
    maxGasLimitRaw: PositiveRaw
    maxFeePerGasRaw: PositiveRaw
    maxPriorityFeePerGasRaw: Raw

    @model_validator(mode='after')
    def policy(self):
        self.poolKey.checked(self.poolId)
        currencies = (self.poolKey.currency0, self.poolKey.currency1)
        if self.independentToken not in currencies:
            raise ValueError('independent_currency_required')
        if (self.tickLower >= self.tickUpper or self.tickLower % self.poolKey.tick_spacing
                or self.tickUpper % self.poolKey.tick_spacing):
            raise ValueError('spaced_range_required')
        budget = (self.budget0Raw, self.budget1Raw)[currencies.index(self.independentToken)]
        if int(self.amountRaw) > int(budget):
            raise ValueError('input_exceeds_budget')
        if not 21000 <= int(self.maxGasLimitRaw) <= 3000000:
            raise ValueError('gas_limit_out_of_bounds')
        if not int(self.maxPriorityFeePerGasRaw) <= int(self.maxFeePerGasRaw) < 2**128:
            raise ValueError('gas_price_out_of_bounds')
        return self


class CreateRequest(StrictModel):
    idempotencyKey: Id
    selection: DepositSelection


class GetRequest(StrictModel):
    intentId: Id


class ChangeRequest(GetRequest):
    version: Version


class ReportRequest(ChangeRequest):
    transactionHash: PoolId


class ListRequest(StrictModel):
    limit: Annotated[StrictInt, Field(ge=1, le=20)] = 20
    before: Id | None = None


class SourceBlock(StrictModel):
    number: BlockNumber
    hash: PoolId
    timestamp: Timestamp


class WalletTransaction(StrictModel):
    chainId: Chain
    # 'from' is reserved in Python, not in JSON.
    sender: NormalizedAddress = Field(alias='from')
    to: NormalizedAddress
    data: Annotated[str, Field(pattern=r'^0x(?:[0-9a-f]{2}){4,}$', max_length=131074)]
    valueRaw: Raw
    nonceRaw: Nonce
    gasLimitRaw: PositiveRaw
    maxFeePerGasRaw: PositiveRaw
    maxPriorityFeePerGasRaw: Raw

    @model_validator(mode='after')
    def gas(self):
        if self.sender in (ZERO, '0x' + '0'*39 + '1', '0x' + '0'*39 + '2') or self.to == ZERO:
            raise ValueError('transaction_identity_required')
        if not 21000 <= int(self.gasLimitRaw) <= 3000000:
            raise ValueError('gas_limit_out_of_bounds')
        if int(self.maxPriorityFeePerGasRaw) > int(self.maxFeePerGasRaw):
            raise ValueError('gas_price_out_of_bounds')
        return self


class MintedBounds(StrictModel):
    amount0MaxRaw: Raw128
    amount1MaxRaw: Raw128
    mintLiquidityRaw: LiquidityRaw
    nativeValueRaw: Raw128


class Balances(StrictModel):
    nativeRaw: Raw
    token0Raw: Raw
    token1Raw: Raw


class Admission(StrictModel):
    manifestId: Fingerprint
    policyVersion: Literal['direct_existing_pool_v1']


class Simulation(StrictModel):
    status: Literal['passed']
    estimatedGasRaw: PositiveRaw
    blockNumber: BlockNumber
    blockHash: PoolId


class PreparedArtifact(StrictModel):
    kind: Kind
    transaction: WalletTransaction
    sourceBlock: SourceBlock
    expiresAt: Timestamp
    preparedDeadline: Annotated[StrictInt, Field(ge=0, le=2**48-1)]
    mintedBounds: MintedBounds
    balances: Balances
    admission: Admission
    simulation: Simulation

    @model_validator(mode='after')
    def binding(self):
        tx = self.transaction
        if (self.expiresAt >= self.preparedDeadline or self.expiresAt < self.sourceBlock.timestamp
                or self.expiresAt > self.sourceBlock.timestamp + 60
                or self.preparedDeadline > self.sourceBlock.timestamp + (3650 if self.kind == 'permit2_approval' else 170)
                or self.simulation.blockNumber != self.sourceBlock.number
                or self.simulation.blockHash != self.sourceBlock.hash
                or int(self.simulation.estimatedGasRaw) > int(tx.gasLimitRaw)):
            raise ValueError('artifact_context_mismatch')
        if self.kind == 'mint' and tx.to != POSITION_MANAGER:
            raise ValueError('mint_manager_required')
        return self


class ReceiptPosition(StrictModel):
    tokenId: PositiveRaw
    recipient: NormalizedAddress
    poolId: PoolId
    tickLower: Tick
    tickUpper: Tick
    liquidityRaw: LiquidityRaw
    currentOwner: NormalizedAddress | None
    currentOwnerStatus: Literal['verified', 'unavailable']
    ownershipObservedBlock: SourceBlock
    amount0Raw: Raw | None
    amount1Raw: Raw | None

    @model_validator(mode='after')
    def evidence(self):
        if (self.currentOwner is None) != (self.currentOwnerStatus == 'unavailable'):
            raise ValueError('owner_evidence_mismatch')
        if self.tickLower >= self.tickUpper:
            raise ValueError('invalid_range')
        return self


class ObservedTransaction(StrictModel):
    nonceRaw: Nonce
    gasLimitRaw: PositiveRaw
    maxFeePerGasRaw: Raw
    maxPriorityFeePerGasRaw: Raw
    selectedLimitsExceeded: Annotated[list[Literal['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas']], Field(max_length=3)]

    @model_validator(mode='after')
    def envelope(self):
        if (int(self.gasLimitRaw) < 21000
                or int(self.maxPriorityFeePerGasRaw) > int(self.maxFeePerGasRaw)
                or len(set(self.selectedLimitsExceeded)) != len(self.selectedLimitsExceeded)):
            raise ValueError('invalid_observed_transaction')
        return self


class ReceiptSummary(StrictModel):
    transactionHash: PoolId
    blockNumber: BlockNumber
    blockHash: PoolId
    outcome: Literal['success', 'reverted']
    finality: Literal['finalized', 'provisional', 'unavailable']
    gasUsedRaw: Raw
    effectiveGasPriceRaw: Raw
    executionFeeRaw: Raw
    l1FeeRaw: Raw | None
    totalFeeRaw: Raw | None
    position: ReceiptPosition | None
    # Old stored observations have no envelope evidence until reconciled again.
    transaction: ObservedTransaction | None

    @model_validator(mode='after')
    def actual_cost(self):
        execution = int(self.gasUsedRaw) * int(self.effectiveGasPriceRaw)
        if int(self.executionFeeRaw) != execution:
            raise ValueError('gas_accounting_mismatch')
        total = None if self.l1FeeRaw is None else str(execution + int(self.l1FeeRaw))
        if self.totalFeeRaw != total:
            raise ValueError('total_gas_accounting_mismatch')
        if self.outcome == 'reverted' and self.position is not None:
            raise ValueError('reverted_mint_evidence')
        if self.transaction is not None and (
                int(self.gasUsedRaw) > int(self.transaction.gasLimitRaw)
                or int(self.effectiveGasPriceRaw) > int(self.transaction.maxFeePerGasRaw)):
            raise ValueError('observed_gas_mismatch')
        return self


ReconciliationState = Literal['not_found', 'pending', 'confirmed', 'reverted', 'mismatched', 'reorged']


class ReportedEffectConflict(StrictModel):
    transactionHash: PoolId
    nonceRaw: Nonce


class StepSummary(StrictModel):
    step: Annotated[StrictInt, Field(ge=1, le=16)]
    kind: Kind
    issuedAt: Timestamp
    expiresAt: Timestamp
    nonceRaw: Nonce
    transactionHash: PoolId | None
    reconciliationState: ReconciliationState | None
    receipt: ReceiptSummary | None
    reportedEffectConflicts: Annotated[list[ReportedEffectConflict], Field(max_length=8)]

    @model_validator(mode='after')
    def conflict_identity(self):
        if (any(item.nonceRaw == self.nonceRaw for item in self.reportedEffectConflicts)
                or len({item.transactionHash for item in self.reportedEffectConflicts}) != len(self.reportedEffectConflicts)):
            raise ValueError('invalid_reported_effect_conflict')
        if (self.receipt is not None and self.receipt.transaction is not None
                and self.receipt.transaction.nonceRaw != self.nonceRaw):
            raise ValueError('receipt_nonce_mismatch')
        return self


def _step_policy(step, selection, state):
    if step.reportedEffectConflicts and state not in ('attention', 'cancel_requested'):
        raise ValueError('unresolved_reported_effect')
    observed = step.receipt.transaction if step.receipt is not None else None
    if observed is not None:
        expected = [name for name, actual, cap in (
            ('gasLimit', observed.gasLimitRaw, selection.maxGasLimitRaw),
            ('maxFeePerGas', observed.maxFeePerGasRaw, selection.maxFeePerGasRaw),
            ('maxPriorityFeePerGas', observed.maxPriorityFeePerGasRaw, selection.maxPriorityFeePerGasRaw))
            if int(actual) > int(cap)]
        if observed.selectedLimitsExceeded != expected:
            raise ValueError('selected_limit_evidence_mismatch')


class Operation(StrictModel):
    id: Id
    idempotencyKey: Id
    owner: NormalizedAddress
    chainId: Chain
    selection: DepositSelection
    state: State
    version: Version
    outstanding: StrictBool
    createdAt: Timestamp
    updatedAt: Timestamp
    history: Annotated[list[StepSummary], Field(max_length=16)]
    serviceFeeBps: Annotated[StrictInt, Field(ge=0, le=0)]

    @model_validator(mode='after')
    def consistency(self):
        if self.owner in (ZERO, '0x' + '0'*39 + '1', '0x' + '0'*39 + '2'):
            raise ValueError('owner_required')
        if self.createdAt > self.updatedAt:
            raise ValueError('invalid_operation_time')
        if [row.step for row in self.history] != list(range(1, len(self.history) + 1)):
            raise ValueError('invalid_history_order')
        if self.outstanding and (not self.history or self.state in ('draft', 'confirmed', 'cancelled', 'reverted', 'superseded')):
            raise ValueError('unresolved_operation_state')
        if self.state == 'superseded' and (not self.history or self.outstanding
                or self.history[-1].reconciliationState != 'mismatched'
                or self.history[-1].receipt is None or self.history[-1].receipt.finality != 'finalized'
                or self.history[-1].receipt.position is not None):
            raise ValueError('supersession_evidence_required')
        for step in self.history:
            _step_policy(step, self.selection, self.state)
            if step.receipt is not None:
                if step.transactionHash != step.receipt.transactionHash:
                    raise ValueError('receipt_transaction_mismatch')
                pos = step.receipt.position
                if pos is not None and (pos.recipient != self.owner or pos.poolId != self.selection.poolId
                        or pos.tickLower != self.selection.tickLower or pos.tickUpper != self.selection.tickUpper):
                    raise ValueError('receipt_position_mismatch')
        return self


class OperationResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    operation: Operation
    walletStep: PreparedArtifact | None
    serverBroadcastAvailable: FalseFlag
    automationAvailable: FalseFlag

    @model_validator(mode='after')
    def wallet_binding(self):
        if self.walletStep is not None:
            step, operation = self.walletStep, self.operation
            if (not operation.outstanding or operation.state != 'awaiting_wallet'
                    or step.transaction.sender != operation.owner or not operation.history
                    or step.kind != operation.history[-1].kind
                    or step.transaction.nonceRaw != operation.history[-1].nonceRaw
                    or step.expiresAt != operation.history[-1].expiresAt):
                raise ValueError('wallet_step_not_current')
            selected = operation.selection
            if (int(step.transaction.gasLimitRaw) > int(selected.maxGasLimitRaw)
                    or int(step.transaction.maxFeePerGasRaw) > int(selected.maxFeePerGasRaw)
                    or int(step.transaction.maxPriorityFeePerGasRaw) > int(selected.maxPriorityFeePerGasRaw)
                    or int(step.mintedBounds.amount0MaxRaw) > int(selected.budget0Raw)
                    or int(step.mintedBounds.amount1MaxRaw) > int(selected.budget1Raw)):
                raise ValueError('wallet_step_exceeds_selection')
        return self


class AllowanceObservation(StrictModel):
    currency: NormalizedAddress
    erc20Spender: Literal['0x000000000022d473030f116ddee9f6b43ac78ba3']
    permit2Spender: Literal['0x58daec3116aae6d93017baaea7749052e8a04fa7']
    erc20Status: Literal['observed', 'unavailable']
    erc20AllowanceRaw: Raw | None
    permit2Status: Literal['active', 'expired', 'zero', 'unavailable']
    permit2AllowanceRaw: Raw | None
    permit2Expiration: Timestamp | None
    revocationGuidance: Literal['wallet_erc20_approve_zero_and_permit2_approve_zero']

    @model_validator(mode='after')
    def observed_values(self):
        if self.currency == ZERO or (self.erc20AllowanceRaw is None) != (self.erc20Status == 'unavailable'):
            raise ValueError('allowance_observation_mismatch')
        absent = self.permit2Status == 'unavailable'
        if ((self.permit2AllowanceRaw is None) != absent or (self.permit2Expiration is None) != absent
                or not absent and int(self.permit2AllowanceRaw) >= 2**160
                or self.permit2Expiration is not None and self.permit2Expiration >= 2**48):
            raise ValueError('allowance_observation_mismatch')
        return self


class AllowanceReport(StrictModel):
    snapshot: SourceBlock
    basis: Literal['pinned_contract_reads_not_token_admission']
    observations: Annotated[list[AllowanceObservation], Field(max_length=2)]

    @model_validator(mode='after')
    def expiration(self):
        for row in self.observations:
            if row.permit2Status != 'unavailable':
                expected = ('zero' if row.permit2AllowanceRaw == '0' else
                    'expired' if row.permit2Expiration < self.snapshot.timestamp else 'active')
                if row.permit2Status != expected:
                    raise ValueError('allowance_expiration_mismatch')
        return self


class AllowanceResponse(OperationResponse):
    allowances: AllowanceReport

    @model_validator(mode='after')
    def currency_binding(self):
        key = self.operation.selection.poolKey
        if [row.currency for row in self.allowances.observations] != [c for c in (key.currency0, key.currency1) if c != ZERO]:
            raise ValueError('allowance_currency_mismatch')
        if self.walletStep is not None:
            raise ValueError('allowance_read_never_prepares')
        return self


class OperationListItem(StrictModel):
    id: Id
    idempotencyKey: Id
    owner: NormalizedAddress
    chainId: Chain
    selection: DepositSelection
    state: State
    version: Version
    outstanding: StrictBool
    createdAt: Timestamp
    updatedAt: Timestamp
    historyCount: Annotated[StrictInt, Field(ge=0, le=16)]
    lastStep: StepSummary | None
    serviceFeeBps: Annotated[StrictInt, Field(ge=0, le=0)]

    @model_validator(mode='after')
    def summary(self):
        if ((self.historyCount == 0) != (self.lastStep is None)
                or self.lastStep and self.lastStep.step != self.historyCount
                or self.createdAt > self.updatedAt):
            raise ValueError('summary_history_mismatch')
        if self.lastStep is not None:
            _step_policy(self.lastStep, self.selection, self.state)
        return self


class ListResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    operations: Annotated[list[OperationListItem], Field(max_length=20)]
    hasMore: StrictBool
    nextBefore: Id | None
    serverBroadcastAvailable: FalseFlag
    automationAvailable: FalseFlag

    @model_validator(mode='after')
    def pagination(self):
        if (self.nextBefore is not None) != self.hasMore:
            raise ValueError('pagination_mismatch')
        if self.hasMore and (not self.operations or self.nextBefore != self.operations[-1].id):
            raise ValueError('pagination_anchor_mismatch')
        return self


REQUEST_MODELS = {'create': CreateRequest, 'get': GetRequest, 'list': ListRequest,
    'prepare': ChangeRequest, 'report': ReportRequest, 'reconcile': ChangeRequest,
    'cancel': ChangeRequest, 'allowances': GetRequest}
RESPONSE_MODELS = {route: ListResponse if route == 'list' else AllowanceResponse if route == 'allowances' else OperationResponse for route in REQUEST_MODELS}


def validate_request(route, body):
    if route not in REQUEST_MODELS:
        raise DepositError('route_not_available')
    return REQUEST_MODELS[route].model_validate(body).model_dump(by_alias=True)


def validate_response(route, body):
    if route not in RESPONSE_MODELS:
        raise DepositError('route_not_available')
    result = RESPONSE_MODELS[route].model_validate(body).model_dump(by_alias=True)
    if route != 'prepare' and result.get('walletStep') is not None:
        raise ValueError('wallet_step_only_on_prepare')
    return result
