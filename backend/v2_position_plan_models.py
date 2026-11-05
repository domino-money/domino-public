"""Closed position-plan-v1 contract: S1 plans for the V2 zap, for the app (F7).

One POST route behind the authenticated private listener (v2_position_plan_api):
- plan: a create, increase, change of range or exit on a Uniswap v3 or v4 pool
  of Robinhood (4663), Base (8453) or Arbitrum One (42161), quoted at one block,
  with its swap legs, the Domino fee, the minimums, the exact zap plan struct,
  the consent artifacts (the direct call, or the Permit2 / relayed typed data),
  the owner's readiness and a simulation of the zap call.

The owner is always the SIWE session's wallet: it is the recipient of the NFT
and of every refund, and no request names an owner or a recipient. A response
grants no signing authority: the wallet shows what it signs, and the app
checks the plan (api-contracts/position-plan-v1/runtime.mjs recomputes the fee
terms, the routes hash, the intent hash and the consent fields) and takes every
Domino address from its pinned deployment manifest, never from this response.
"""
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, StrictInt, model_validator

from onboarding_models import ERROR_STATUS_BY_CODE as AUTH_ERRORS
from v2_chains import default_registry
from v2_liquidity import MAX_TICK, MIN_TICK

CONTRACT_VERSION = '1.0.0-rc.2'
MAX_BODY = 8192
MAX_RESPONSE = 393216
QUOTE_LIFETIME_SECONDS = 180
DEADLINE_SECONDS = 300
SLIPPAGE_MIN_BPS, SLIPPAGE_MAX_BPS, SLIPPAGE_DEFAULT_BPS = 10, 500, 50
U128 = 2**128 - 1
ERROR_STATUS_BY_CODE = {
    **AUTH_ERRORS,
    'position_plan_capacity_busy': 429,
    'position_plan_chain_unavailable': 503,
    'position_plan_unavailable': 503,
    'position_plan_pool_invalid': 422,
    'position_plan_hooked_pool': 422,
    'position_plan_pool_not_initialized': 409,
    'position_plan_pool_initialized': 409,
    'position_plan_price_invalid': 422,
    'position_plan_price_decimals_mismatch': 422,
    'position_plan_range_invalid': 422,
    'position_plan_position_not_found': 404,
    'position_plan_not_owner': 403,
    'position_plan_liquidity_invalid': 422,
    'position_plan_burn_needs_all': 422,
    'position_plan_inputs_unsupported': 422,
    'position_plan_consent_unsupported': 422,
    'position_plan_no_route': 422,
    'position_plan_amount_too_small': 422,
    'position_plan_nothing_to_convert': 422,
    'position_plan_fee_not_backed': 502,
}


class PositionPlanError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status = ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


def _boolean(value):
    if type(value) is not bool:
        raise ValueError('boolean_required')
    return value


def _raw_bound(maximum):
    def check(value):
        if int(value) > maximum:
            raise ValueError('raw_out_of_bounds')
        return value
    return check


def _price(value):
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError('price_invalid') from None
    if not number.is_finite() or number <= 0:
        raise ValueError('price_invalid')
    return value


Address = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{40}$', min_length=42, max_length=42)]
Lower = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
Selector = Annotated[str, Field(pattern=r'^0x[0-9a-f]{8}$', min_length=10, max_length=10)]
Raw = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,77})$', max_length=78,
                           json_schema_extra={'x-maximum-raw': str(2**256 - 1)})]
Raw128 = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,38})$', max_length=39,
                              json_schema_extra={'x-maximum-raw': str(U128)})]
PositiveRaw128 = Annotated[str, Field(pattern=r'^[1-9][0-9]{0,38}$', max_length=39,
                                      json_schema_extra={'x-maximum-raw': str(U128)})]
Raw160 = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,48})$', max_length=49,
                              json_schema_extra={'x-maximum-raw': str(2**160 - 1)})]
Raw64 = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,19})$', max_length=20,
                             json_schema_extra={'x-maximum-raw': str(2**64 - 1)})]
Data = Annotated[str, Field(pattern=r'^0x(?:[0-9a-f]{2})*$', max_length=2 + 2 * 65536)]
Tick = Annotated[StrictInt, Field(ge=MIN_TICK, le=MAX_TICK)]
Dex = Literal[3, 4]
# The enabled V2 chains (api-contracts/v2/chains), ascending, as the package's CONSTANTS.chains are.
Chain = Literal[tuple(profile.chainId for profile in default_registry().chains)]
Uint8 = Annotated[StrictInt, Field(ge=0, le=255)]
Uint16 = Annotated[StrictInt, Field(ge=0, le=65535)]
Uint24 = Annotated[StrictInt, Field(ge=0, le=2**24 - 1)]
Spacing = Annotated[StrictInt, Field(ge=1, le=32767)]
Timestamp = Annotated[StrictInt, Field(ge=0, le=2**53 - 1)]
Bool = Annotated[StrictBool, BeforeValidator(_boolean)]
Decimal36 = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,39})(\.[0-9]{1,36})?$', max_length=77)]
SignedDecimal = Annotated[str, Field(pattern=r'^-?(0|[1-9][0-9]{0,3})(\.[0-9]{1,36})?$', max_length=42)]
Slippage = Annotated[StrictInt, Field(ge=SLIPPAGE_MIN_BPS, le=SLIPPAGE_MAX_BPS)]
Action = Literal['create', 'increase', 'changeRange', 'exit']
Consent = Literal['direct', 'permit2', 'relayed']


# ------------------------------------------------------------------ request

class PoolIn(StrictModel):
    dex: Dex
    currency0: Address
    currency1: Address
    fee: Uint24
    tickSpacing: Spacing
    hooks: Address


class PositionIn(StrictModel):
    dex: Dex
    tokenId: Annotated[str, Field(pattern=r'^[1-9][0-9]{0,77}$', max_length=78)]


class InputIn(StrictModel):
    token: Address
    amountRaw: PositiveRaw128


class ReceiveIn(StrictModel):
    mode: Literal['both', 'converted']
    token: Address | None = None

    @model_validator(mode='after')
    def consistent(self):
        if (self.mode == 'converted') != (self.token is not None):
            raise ValueError('receive_token')
        return self


class InitialPriceIn(StrictModel):
    """One whole `baseToken` is worth `price` whole tokens of the pool's other currency."""
    price: Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,39})(\.[0-9]{1,36})?$', max_length=77),
                     BeforeValidator(_price)]
    baseToken: Address
    decimals0: Annotated[StrictInt, Field(ge=0, le=77)]
    decimals1: Annotated[StrictInt, Field(ge=0, le=77)]


class PlanRequest(StrictModel):
    chainId: Chain
    action: Action
    consent: Consent
    pool: PoolIn | None = None
    position: PositionIn | None = None
    tickLower: Tick | None = None
    tickUpper: Tick | None = None
    inputs: Annotated[list[InputIn], Field(min_length=1, max_length=2)] | None = None
    liquidityToRemove: Annotated[str, Field(pattern=r'^(all|0|[1-9][0-9]{0,38})$', max_length=39)] | None = None
    burn: Bool | None = None
    receive: ReceiveIn | None = None
    initialPrice: InitialPriceIn | None = None
    slippageBps: Slippage = SLIPPAGE_DEFAULT_BPS

    @model_validator(mode='after')
    def per_action(self):
        action = self.action
        present = {name for name in ('pool', 'position', 'tickLower', 'tickUpper', 'inputs', 'liquidityToRemove',
                                     'burn', 'receive', 'initialPrice') if getattr(self, name) is not None}
        allowed = {'create': ({'pool', 'tickLower', 'tickUpper', 'inputs'}, {'initialPrice'}),
                   'increase': ({'position', 'inputs'}, set()),
                   'changeRange': ({'position', 'tickLower', 'tickUpper', 'liquidityToRemove', 'burn'}, set()),
                   'exit': ({'position', 'liquidityToRemove', 'burn', 'receive'}, set())}[action]
        if not allowed[0] <= present or not present <= allowed[0] | allowed[1]:
            raise ValueError('fields_for_action')
        consents = {'create': ('direct', 'permit2'), 'increase': ('direct', 'permit2'),
                    'changeRange': ('direct', 'relayed'), 'exit': ('direct', 'relayed')}[action]
        if self.consent not in consents:
            raise ValueError('consent_for_action')
        if self.pool is not None and (self.pool.currency0.lower() >= self.pool.currency1.lower()):
            raise ValueError('pool_currencies')
        if self.inputs is not None and len({item.token.lower() for item in self.inputs}) != len(self.inputs):
            raise ValueError('duplicate_input')
        if self.tickLower is not None and self.tickLower >= self.tickUpper:
            raise ValueError('range_order')
        return self


# ----------------------------------------------------------------- response

class PoolRef(StrictModel):
    dex: Dex
    currency0: Lower
    currency1: Lower
    fee: Uint24
    tickSpacing: Annotated[StrictInt, Field(ge=-(2**23), le=2**23 - 1)]
    hooks: Lower


class Intent(StrictModel):
    action: Annotated[StrictInt, Field(ge=1, le=4)]
    pool: PoolRef
    tokenId: Raw
    tickLower: Tick
    tickUpper: Tick
    minLiquidity: Raw128
    feeBps: Uint16
    feeToken: Lower
    routesHash: Hash
    recipient: Lower
    nonce: Raw
    deadline: Raw64


class TokenAmount(StrictModel):
    token: Lower
    amount: PositiveRaw128


class SwapLeg(StrictModel):
    kind: Literal[1, 2, 3]
    router: Lower
    tokenIn: Lower
    tokenOut: Lower
    amountIn: PositiveRaw128
    minAmountOut: PositiveRaw128
    data: Data


Legs = Annotated[list[SwapLeg], Field(max_length=8)]
Inputs = Annotated[list[TokenAmount], Field(min_length=1, max_length=2)]


class CreatePlan(StrictModel):
    """IDominoPositionActions.CreatePlan, field for field."""
    intent: Intent
    inputs: Inputs
    legs: Legs
    amount0Max: Raw128
    amount1Max: Raw128
    initSqrtPriceX96: Raw160


class IncreasePlan(StrictModel):
    """IDominoPositionActions.IncreasePlan."""
    intent: Intent
    inputs: Inputs
    legs: Legs
    amount0Max: Raw128
    amount1Max: Raw128


class ChangeRangePlan(StrictModel):
    """IDominoPositionActions.ChangeRangePlan."""
    intent: Intent
    liquidityToRemove: PositiveRaw128
    amount0MinRemoved: Raw128
    amount1MinRemoved: Raw128
    legs: Legs
    amount0Max: Raw128
    amount1Max: Raw128
    burnOld: Bool


class ExitPlan(StrictModel):
    """IDominoPositionActions.ExitPlan."""
    intent: Intent
    liquidityToRemove: Raw128
    amount0MinRemoved: Raw128
    amount1MinRemoved: Raw128
    legs: Legs
    burn: Bool


class Block(StrictModel):
    number: Raw
    hash: Hash
    timestamp: Raw


class FeePips(StrictModel):
    zeroForOne: Annotated[StrictInt, Field(ge=0, le=1_000_000)]
    oneForZero: Annotated[StrictInt, Field(ge=0, le=1_000_000)]


class PoolView(StrictModel):
    dex: Dex
    currency0: Lower
    currency1: Lower
    fee: Uint24
    tickSpacing: Spacing
    hooks: Lower
    id: Annotated[str, Field(pattern=r'^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$')]
    initialized: Bool
    sqrtPriceX96: Raw160 | None
    tick: Tick | None
    liquidity: Raw128 | None
    swapFeePips: FeePips | None


class InitialPrice(StrictModel):
    sqrtPriceX96: Raw160
    tick: Tick
    price0In1: Decimal36
    price1In0: Decimal36
    decimals0: Annotated[StrictInt, Field(ge=0, le=77)]
    decimals1: Annotated[StrictInt, Field(ge=0, le=77)]
    decimalsVerified: Bool
    baseToken: Lower
    price: Decimal36


class PositionView(StrictModel):
    tokenId: Raw
    manager: Lower
    tickLower: Tick
    tickUpper: Tick
    liquidity: Raw128
    liquidityToRemove: Raw128 | None
    feesOwed0Raw: Raw
    feesOwed1Raw: Raw
    inRange: Bool
    approved: Lower
    subscriber: Lower | None


class Call(StrictModel):
    to: Lower
    function: Literal['create', 'createWithPermit', 'increase', 'increaseWithPermit', 'changeRange',
                      'changeRangeWithSignature', 'exit', 'exitWithSignature']
    selector: Selector
    valueRaw: Raw
    data: Data | None


class TypedField(StrictModel):
    name: Annotated[str, Field(pattern=r'^[A-Za-z][A-Za-z0-9]{0,31}$')]
    type: Annotated[str, Field(pattern=r'^[A-Za-z][A-Za-z0-9]{0,63}(\[\])?$')]


Fields = Annotated[list[TypedField], Field(min_length=1, max_length=16)]


class Permit2Types(StrictModel):
    EIP712Domain: Fields
    PermitBatchWitnessTransferFrom: Fields
    TokenPermissions: Fields
    PositionIntent: Fields
    PoolRef: Fields


class RelayedTypes(StrictModel):
    EIP712Domain: Fields
    RelayedPositionAction: Fields
    PositionIntent: Fields
    PoolRef: Fields


class Permit2Domain(StrictModel):
    name: Literal['Permit2']
    chainId: Chain
    verifyingContract: Address


class DominoDomain(StrictModel):
    name: Literal['Domino']
    version: Literal['2']
    chainId: Chain
    verifyingContract: Lower


class Permission(StrictModel):
    token: Lower
    amount: PositiveRaw128


class Permit(StrictModel):
    permitted: Annotated[list[Permission], Field(min_length=1, max_length=2)]
    nonce: Raw
    deadline: Raw


class Permit2Message(StrictModel):
    permitted: Annotated[list[Permission], Field(min_length=1, max_length=2)]
    spender: Lower
    nonce: Raw
    deadline: Raw
    witness: Intent


class RelayedMessage(StrictModel):
    intent: Intent
    liquidityToRemove: Raw128
    amount0MinRemoved: Raw128
    amount1MinRemoved: Raw128
    amount0Max: Raw128
    amount1Max: Raw128
    burn: Bool


class Permit2TypedData(StrictModel):
    """eth_signTypedData_v4 for createWithPermit / increaseWithPermit (F7 §2.5.2)."""
    types: Permit2Types
    primaryType: Literal['PermitBatchWitnessTransferFrom']
    domain: Permit2Domain
    message: Permit2Message


class RelayedTypedData(StrictModel):
    """eth_signTypedData_v4 for changeRangeWithSignature / exitWithSignature (F7 §2.5.3)."""
    types: RelayedTypes
    primaryType: Literal['RelayedPositionAction']
    domain: DominoDomain
    message: RelayedMessage


class Permit2Signature(StrictModel):
    kind: Literal['permit2']
    permit: Permit
    typedData: Permit2TypedData
    digest: Hash


class RelayedSignature(StrictModel):
    kind: Literal['relayed']
    permit: None
    typedData: RelayedTypedData
    digest: Hash


class LegPool(StrictModel):
    dex: Dex
    currency0: Lower
    currency1: Lower
    fee: Uint24
    tickSpacing: Spacing | None
    hooks: Lower | None
    id: Annotated[str, Field(pattern=r'^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$')]


class LegView(StrictModel):
    kind: Literal['universal_router', 'v3_pool', 'v4_pool']
    tokenIn: Lower
    tokenOut: Lower
    amountInRaw: PositiveRaw128
    expectedOutRaw: PositiveRaw128
    minAmountOutRaw: PositiveRaw128
    source: Literal['local_simulation', 'quoter_v2', 'v4_quoter', 'uniswap_trading_api']
    pools: Annotated[list[LegPool], Field(min_length=1, max_length=32)]
    priceImpactPercent: SignedDecimal | None


class Rank(StrictModel):
    token: Lower
    rank: Uint8


class Fee(StrictModel):
    """The Domino fee of the plan: the token by the rule (F1b) from the
    registry's ranks of every token the legs touch, and its expected amount."""
    bps: Literal[0, 65]
    token: Lower
    place: Literal['input', 'output', 'hop', 'fallback', 'none']
    basisRaw: Raw
    amountRaw: Raw
    ranks: Annotated[list[Rank], Field(max_length=16)]


class Returned(StrictModel):
    token: Lower
    amountRaw: Raw


class Expected(StrictModel):
    liquidity: Raw128
    amount0Raw: Raw
    amount1Raw: Raw
    sqrtPriceX96After: Raw160 | None
    principal0Raw: Raw | None
    principal1Raw: Raw | None
    fees0Raw: Raw | None
    fees1Raw: Raw | None
    returned: Annotated[list[Returned], Field(max_length=8)]


class Band(StrictModel):
    """The sqrt prices at -s and +s around a price (the minimums' band)."""
    lowerSqrtPriceX96: Raw160
    upperSqrtPriceX96: Raw160


class Minimums(StrictModel):
    """Each minimum at the worst price within ±s (1.0.0-rc.2): minLiquidity over the
    band around the price the mint meets (`mintBand`), the removal minima at the
    band around the pool's price (`removalBand`); each leg's minAmountOut is its
    quote less s."""
    liquidity: Raw128
    slippageBps: Slippage
    amount0RemovedRaw: Raw128 | None
    amount1RemovedRaw: Raw128 | None
    mintBand: Band | None
    removalBand: Band | None


class L1DataFee(StrictModel):
    """The transaction's L1 data fee, apart from its L2 execution gas (v2_l1_fee):
    OP Stack from the GasPriceOracle (`weiRaw` getL1Fee of the unsigned
    transaction, `upperBoundWeiRaw` getL1FeeUpperBound of its size); Nitro from
    NodeInterface.gasEstimateL1Component (`l1GasUnits` × `l2BaseFeeWei`)."""
    status: Literal['ok', 'unavailable']
    source: Literal['op_gas_price_oracle', 'nitro_node_interface']
    block: Raw
    weiRaw: Raw | None
    upperBoundWeiRaw: Raw | None
    l1GasUnits: Raw | None
    l2BaseFeeWei: Raw | None
    transactionBytes: Annotated[StrictInt, Field(ge=1, le=2**20)] | None

    @model_validator(mode='after')
    def consistent(self):
        ok = self.status == 'ok'
        op = self.source == 'op_gas_price_oracle'
        if ok != (self.weiRaw is not None) or (ok and op) != (self.upperBoundWeiRaw is not None) \
                or (ok and op) != (self.transactionBytes is not None) or (ok and not op) != (self.l1GasUnits is not None) \
                or (ok and not op) != (self.l2BaseFeeWei is not None):
            raise ValueError('l1_data_fee_shape')
        if ok and not op and int(self.weiRaw) != int(self.l1GasUnits) * int(self.l2BaseFeeWei):
            raise ValueError('l1_data_fee_product')
        return self


class RouterStatus(StrictModel):
    status: Literal['not_needed', 'not_configured', 'unavailable', 'refused', 'not_better', 'chosen']
    reason: Annotated[str, Field(pattern=r'^[a-z][a-z0-9_]{0,63}$', max_length=64)] | None


class Routing(StrictModel):
    router: RouterStatus
    advantageBps: Literal[10]


class Account(StrictModel):
    kind: Literal['eoa', 'eip7702', 'contract']
    delegate: Lower | None
    consents: Annotated[list[Consent], Field(min_length=1, max_length=2)]


class BalanceCheck(StrictModel):
    token: Lower
    requiredRaw: Raw
    heldRaw: Raw | None
    sufficient: Bool | None


class ApprovalCheck(StrictModel):
    token: Lower
    spender: Lower
    spenderKind: Literal['zap', 'permit2']
    allowanceRaw: Raw | None
    requiredRaw: Raw
    sufficient: Bool | None


class PositionApproval(StrictModel):
    manager: Lower
    tokenId: Raw
    approved: Lower | None
    approvedForAll: Bool | None
    sufficient: Bool | None


class Nonce(StrictModel):
    kind: Literal['permit2', 'relayed']
    word: Raw
    bit: Uint8
    nonce: Raw


class Step(StrictModel):
    kind: Literal['approve_token', 'approve_position', 'sign_permit2', 'sign_relayed', 'send_action']
    to: Lower | None
    valueRaw: Raw
    data: Data | None


class Readiness(StrictModel):
    account: Account
    balances: Annotated[list[BalanceCheck], Field(max_length=2)]
    approvals: Annotated[list[ApprovalCheck], Field(max_length=2)]
    positionApproval: PositionApproval | None
    nonce: Nonce | None
    steps: Annotated[list[Step], Field(min_length=1, max_length=6)]


class ActionResult(StrictModel):
    tokenId: Raw
    liquidity: Raw128
    amount0: Raw
    amount1: Raw
    feeToken: Lower
    feeAmount: Raw


class RevertError(StrictModel):
    selector: Selector | None
    name: Annotated[str, Field(pattern=r'^[A-Za-z][A-Za-z0-9]{0,63}\([a-z0-9,\[\]()]*\)$', max_length=160)] | None


class Simulation(StrictModel):
    status: Literal['ok', 'reverted', 'not_run']
    reason: Literal['approvals_missing', 'approval_reverted', 'simulation_disabled'] | None
    method: Literal['eth_simulateV1', 'eth_call'] | None
    error: RevertError | None
    gasUnits: Raw | None
    result: ActionResult | None


class RequestIdentity(PlanRequest):
    owner: Lower


class PlanDocument(StrictModel):
    schemaVersion: Literal[1]
    source: Literal['position_plan_v1']
    chainId: Chain
    action: Action
    consent: Consent
    owner: Lower
    zap: Lower
    block: Block
    requestedAt: Timestamp
    retrievedAt: Timestamp
    expiresAt: Timestamp
    deadline: Raw64
    requestFingerprint: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$', min_length=64, max_length=64)]
    request: RequestIdentity
    pool: PoolView
    initialPrice: InitialPrice | None
    position: PositionView | None
    zapPlan: CreatePlan | IncreasePlan | ChangeRangePlan | ExitPlan
    routesHash: Hash
    intentHash: Hash
    call: Call
    signature: Permit2Signature | RelayedSignature | None
    legs: Annotated[list[LegView], Field(max_length=8)]
    fee: Fee
    expected: Expected
    minimums: Minimums
    routing: Routing
    readiness: Readiness
    simulation: Simulation
    l1DataFee: L1DataFee
    warnings: Annotated[list[Literal['simulated_liquidity_below_minimum', 'simulation_reverted']], Field(max_length=4)]

    @model_validator(mode='after')
    def consistent(self):
        from v2_position_plan_rules import check_document
        check_document(self.model_dump())
        return self


class PlanResponse(StrictModel):
    contractVersion: Literal[CONTRACT_VERSION]
    plan: PlanDocument


REQUEST_MODELS = {'plan': PlanRequest}
RESPONSE_MODELS = {'plan': PlanResponse}


def validate_request(route, body):
    try:
        return REQUEST_MODELS[route].model_validate(body)
    except (KeyError, ValueError, TypeError):
        raise PositionPlanError('invalid_request') from None


def validate_response(route, body):
    try:
        return RESPONSE_MODELS[route].model_validate(body).model_dump(exclude_none=False)
    except (KeyError, ValueError, TypeError):
        raise PositionPlanError('upstream_contract_mismatch') from None
