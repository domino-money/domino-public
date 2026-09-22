"""Versioned automation-cycle configuration. Every operational number is explicit.

A private file names the database, the fixed RPC endpoint, the deployed
contracts with their runtime hashes, the admitted sequences with an explicit
expiry, both signer keys by path, and every planner, evidence, gas, scheduling
and finality parameter the cycle consumes. Nothing here has a production
default: an absent field is a refused configuration, not a fixture value.
Keys are read by the signers themselves; this module never opens them.
"""
from fractions import Fraction
import json
from math import isqrt
import re
from typing import Annotated, Literal

from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

import execution_models as m
import execution_planner as p
from bridge_state import strict_json
from execution_status_runtime import private_file
from v4_math import MIN_SQRT, MAX_SQRT

KIND = 'domino-automation-cycle'
UInt = Annotated[StrictInt, Field(ge=0, lt=2**256)]
Positive = Annotated[StrictInt, Field(gt=0, lt=2**256)]
Bps = Annotated[StrictInt, Field(ge=0, le=10000)]
Version = Annotated[str, Field(pattern=r'^[A-Za-z0-9_.-]{1,64}$')]
Path = Annotated[str, Field(pattern=r'^/[A-Za-z0-9_./-]{1,400}$')]


class Frozen(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


class DatabaseSettings(Frozen):
    host: Annotated[str, Field(pattern=r'^/[A-Za-z0-9_/.-]{1,200}$')]
    port: Annotated[StrictInt, Field(ge=1024, le=65535)]
    dbname: Annotated[str, Field(pattern=r'^[a-z_][a-z0-9_]{0,62}$')]

    def settings(self):
        return {'host': self.host, 'port': self.port, 'dbname': self.dbname}


class GasPoolKey(Frozen):
    """Any v4 pool's key, a hook and a dynamic fee included: gas is only
    priced through this pool, never traded in it. The ETH/USDG pool the
    new-token census valued ETH with, on 4663, has both."""
    currency0: m.Address
    currency1: m.Account
    fee: Annotated[StrictInt, Field(ge=0, lt=2**24)]
    tickSpacing: Annotated[StrictInt, Field(ge=1, le=32767)]
    hooks: m.Address

    @model_validator(mode='after')
    def checked(self):
        if int(self.currency0, 16) >= int(self.currency1, 16):
            raise ValueError('currency_order')
        return self

    def pool_id(self):
        return '0x' + keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                    [self.currency0, self.currency1, self.fee, self.tickSpacing, self.hooks])).hex()


class PricingPolicy(Frozen):
    """Where prices come from. The owner decided on 22 September 2026 that
    Domino, serving mostly new tokens no oracle covers, prices from the pool
    itself: the anchor is the pool's spot at the observed block, with no
    external reference, no average and no volatility gate. The planner values
    the other currency over the spot plus or minus `valuationBandBps`, a small
    margin of conservatism; what the execution may actually meet is bounded
    by the owner's impact and slippage limits, which the engine enforces. Gas
    is paid in the native asset: one wei is one atom of the native asset or
    its wrapper, and any other quote currency is priced through an admitted
    native/quote pool at the same block, rounded against the operator.
    """
    kind: Literal['pool_spot']
    valuationBandBps: Annotated[StrictInt, Field(ge=0, le=1000)]
    wrappedNative: m.Account
    gasPools: dict[m.Address, GasPoolKey]
    gasPriceBufferBps: Bps

    @model_validator(mode='after')
    def checked(self):
        native = {m.ZERO, self.wrappedNative}
        for quote, key in self.gasPools.items():
            pair = {key.currency0, key.currency1}
            if quote in native or quote not in pair or not pair & native:
                raise ValueError('gas_pool_not_native_quote')
        return self


class SwapCapPolicy(Frozen):
    """The proportion that keeps a compound swap from being worth sandwiching.
    Moving a pool by a fraction and back costs about fee x depth x fraction;
    the gain on a swap of size S is S x fraction. So the swaps of every vault
    in one pool stay under fee x depth, measured tick by tick at the observed
    block over the owner's impact band (automation_evidence.swap_cap), times
    this multiplier. They are summed over the guard's 256-block window, which
    is not configurable: an execution lands up to 255 blocks after the block
    it observed, so two swaps can share a block, and one push, whenever their
    observed blocks are that close.
    """
    depthMultiplierBps: Annotated[StrictInt, Field(ge=1, le=10000)]


class ExecuteGasUnits(Frozen):
    direct: Positive
    swap: Positive
    mint: Positive
    fund: Positive


class GasPolicy(Frozen):
    """Measured units for the complete path, priced at the head's base fee with a
    buffer, plus the L1 data component the node reports. The economic estimate
    and the signed envelope's ceiling are separate numbers; both must fit.
    """
    publishGasUnits: Positive
    executeGasUnits: ExecuteGasUnits
    priorityFeePerGasWei: UInt
    basePriceBufferBps: Bps
    l1DataComponent: Literal['node_interface', 'attested_none']
    operatorMinimumBalanceWei: UInt
    publisherMinimumBalanceWei: UInt


class DestinationPolicy(Frozen):
    maxLiquidityIncreaseBpsOfActive: Annotated[StrictInt, Field(gt=0, le=10000)]
    maxLiquidityIncreaseAbsolute: Annotated[StrictInt, Field(gt=0, lt=2**127)]
    competingLiquidityHaircutBps: Bps
    totalLiquidityMarginBps: Bps
    activeFractionHaircutBps: Bps
    successorActiveFractionBps: Bps
    exposureLossBps: Bps
    swapFractionsBps: Annotated[tuple[Annotated[StrictInt, Field(gt=0, le=10000)], ...], Field(min_length=1, max_length=8)]
    # Below this share of the surplus currency's deployable fees, no swap is
    # quoted: a search cut-off for the planner, not a consumption tolerance.
    minimumSwapFractionBps: Annotated[StrictInt, Field(ge=1, le=10000)]
    quoteSlippageBps: Annotated[StrictInt, Field(ge=1, le=1000)]
    maxSimulationSteps: Annotated[StrictInt, Field(ge=1, le=256)]

    @model_validator(mode='after')
    def checked(self):
        if tuple(sorted(set(self.swapFractionsBps))) != self.swapFractionsBps:
            raise ValueError('swap_fractions_not_unique_sorted')
        return self


class HistoryPolicy(Frozen):
    samplerVersion: Version
    sampleIntervalSeconds: Positive
    maximumSampleGapSeconds: Positive

    @model_validator(mode='after')
    def checked(self):
        if self.maximumSampleGapSeconds < self.sampleIntervalSeconds:
            raise ValueError('sample_gap_below_interval')
        return self


class PlanPolicy(Frozen):
    # The plan's price band is the owner's impact limit itself (impact_bounds);
    # the service keeps no narrower band of its own.
    deadlineSeconds: Annotated[StrictInt, Field(gt=0, le=3600)]
    maxGasCostWei: Positive
    preferNetPath: bool
    # The planner sizes liquidity to spend the funds exactly; the plan keeps
    # this much back so the caps survive the rounding and the price shift of
    # the execution itself. Fees left by the slack wait for the next cycle.
    liquiditySlackBps: Annotated[StrictInt, Field(ge=0, le=1000)]


class SchedulingPolicy(Frozen):
    # A stable worker identity lets a restarted service resume its own leases
    # at once; a null id makes every process a new worker that waits for the
    # previous one's leases to expire. Evaluate-only runs may leave it null.
    workerId: Annotated[str, Field(pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')] | None
    evaluationIntervalSeconds: Positive
    minimumBackoffSeconds: Positive
    maximumBackoffSeconds: Positive
    leaseSeconds: Annotated[StrictInt, Field(ge=1, le=300)]
    publicationWindowSeconds: Positive
    maxPublicationsPerWindow: Positive
    publicationWaitSeconds: Annotated[StrictInt, Field(ge=1, le=120)]
    executionWaitSeconds: Annotated[StrictInt, Field(ge=1, le=600)]
    # The guard admits a source block for 255 blocks; sending past this age is
    # refused here so a slow inclusion fails before it costs a transaction.
    maxSourceBlockAge: Annotated[StrictInt, Field(ge=1, le=200)]
    cycleBudgetSeconds: Annotated[StrictInt, Field(ge=1, le=600)]
    # Every wait is its base value times a random factor within +-jitterBps,
    # so no one outside can tell when a sequence will next observe.
    jitterBps: Annotated[StrictInt, Field(ge=0, le=5000)]
    # Chain seconds from the observed block to the execution's block that each
    # cycle's measured latency is reported against.
    latencyTargetSeconds: Annotated[StrictInt, Field(ge=1, le=60)]
    # After this many consecutive failed attempts (a publication or an
    # execution paid for and not completed) the wait doubles per failure.
    failureBackoffAfter: Annotated[StrictInt, Field(ge=1, le=16)]

    @model_validator(mode='after')
    def checked(self):
        if self.maximumBackoffSeconds < self.minimumBackoffSeconds:
            raise ValueError('inverted_backoff')
        # A failure's backoff never brings the next attempt sooner than a normal pass.
        if self.maximumBackoffSeconds < self.evaluationIntervalSeconds:
            raise ValueError('backoff_below_interval')
        return self


class FinalityPolicy(Frozen):
    publicationConfirmations: Annotated[StrictInt, Field(ge=0, le=64)]


class SignerPolicyConfig(Frozen):
    max_gas: Positive
    max_fee_per_gas: Positive
    priority_fee_per_gas: Positive
    max_total_cost: Positive
    max_replacements: Annotated[StrictInt, Field(ge=0, le=3)]
    bump_bps: Annotated[StrictInt, Field(ge=1000, le=10000)]
    enabled: bool


class OperatorConfig(Frozen):
    keyFile: Path
    policy: SignerPolicyConfig


class PublisherConfig(Frozen):
    keyFile: Path
    maxGas: Positive
    maxFeePerGas: Positive
    priorityFeePerGas: Positive
    maxTotalCostWei: Positive
    expirySeconds: Annotated[StrictInt, Field(ge=1, le=3600)]
    enabled: bool


class CodeHashes(Frozen):
    poolManager: m.Identity
    positionManager: m.Identity
    stateView: m.Identity
    factory: m.Identity
    readHelper: m.Identity
    routing: m.Identity
    priceGuard: m.Identity
    engine: m.Identity
    implementation: m.Identity
    vault: m.Identity


class DeploymentAdmission(Frozen):
    """The verified deployment, as the published sequence profile records it."""
    poolManager: m.Account
    positionManager: m.Account
    stateView: m.Account
    factory: m.Account
    readHelper: m.Account
    routing: m.Account
    priceGuard: m.Account
    engine: m.Account
    implementation: m.Account
    serviceFeeRecipient: m.Account
    operator: m.Account
    pricePublisher: m.Account
    serviceFeeBps: Literal[200]
    dominoServiceFeeBps: Literal[400]
    expiresAt: UInt
    codeHashes: CodeHashes

    @model_validator(mode='after')
    def checked(self):
        roles = (self.operator, self.pricePublisher, self.serviceFeeRecipient)
        contracts = {self.poolManager, self.positionManager, self.stateView, self.factory, self.readHelper,
                     self.routing, self.priceGuard, self.engine, self.implementation}
        if len(contracts) != 9 or len(set(roles)) != 3 or contracts & set(roles):
            raise ValueError('deployment_roles_not_distinct')
        return self


class SequenceAdmission(Frozen):
    owner: m.Account
    vault: m.Account
    expiresAt: UInt
    suspended: bool = False


class LedgerPolicy(Frozen):
    """Who reads the vault's fee events into the ledger, and how much per pass.
    `inline`: the cycle reads them itself before every evaluation, under the
    reconciliation role. `external`: a separate `index` process does, and the
    cycle only refuses to act while an exception is unacknowledged.
    """
    indexer: Literal['inline', 'external']
    maxBlocksPerPass: Annotated[StrictInt, Field(ge=1, le=100000)]
    maxLogsPerPass: Annotated[StrictInt, Field(ge=1, le=4096)]


class AutomationConfig(Frozen):
    schemaVersion: Literal[1]
    kind: Literal[KIND]
    configVersion: Version
    database: DatabaseSettings
    rpcEndpoint: Annotated[str, Field(min_length=1, max_length=2048)]
    deployment: DeploymentAdmission
    sequences: Annotated[tuple[SequenceAdmission, ...], Field(max_length=256)]
    operator: OperatorConfig
    publisher: PublisherConfig
    planner: dict
    pricing: PricingPolicy
    swapCap: SwapCapPolicy
    gas: GasPolicy
    destinations: DestinationPolicy
    history: HistoryPolicy
    plan: PlanPolicy
    scheduling: SchedulingPolicy
    finality: FinalityPolicy
    ledger: LedgerPolicy
    paused: bool

    @model_validator(mode='after')
    def checked(self):
        # The planner's own model validates its numbers; keep one source of truth.
        p.PlannerSettings.model_validate_json(json.dumps(self.planner, allow_nan=False))
        keys = [(s.owner, s.vault) for s in self.sequences]
        if len(set(keys)) != len(keys):
            raise ValueError('duplicate_sequence_admission')
        if self.operator.keyFile == self.publisher.keyFile:
            raise ValueError('operator_publisher_key_not_separate')
        return self

    def planner_settings(self):
        return p.PlannerSettings.model_validate_json(json.dumps(self.planner, allow_nan=False))


def validate_config(raw):
    """JSON-mode validation: strict models, with arrays admitted as tuples."""
    if type(raw) is not dict:
        raise ValueError('invalid_automation_configuration')
    return AutomationConfig.model_validate_json(json.dumps(raw, allow_nan=False))


def parse_config(payload):
    """Strict ingress: duplicate keys refused, every field explicit."""
    return validate_config(strict_json(payload))


def load_config(path):
    """Read a private 0600 file outside any checkout, as the other private services do."""
    return parse_config(private_file(path, 262144))


def impact_bounds(sqrt_price, max_impact_bps):
    """The widest square-root band around the anchor whose squared ratio stays
    inside the owner's impact limit, with the routing helper's own rounding:
    floor(s*s*10000/a/a) >= 10000-I below and ceil(s*s*10000/a/a) <= 10000+I
    above. The plan's band, the swap's price limit and the engine's impact
    check are then one and the same bound.
    """
    if type(sqrt_price) is not int or not MIN_SQRT <= sqrt_price < MAX_SQRT:
        raise ValueError('invalid_sqrt_price')
    if type(max_impact_bps) is not int or not 0 <= max_impact_bps < 10000:
        raise ValueError('invalid_price_impact')
    square = sqrt_price * sqrt_price
    low = (10000 - max_impact_bps) * square
    lower = isqrt(-(-low // 10000))
    if lower * lower * 10000 < low:
        lower += 1
    upper = isqrt((10000 + max_impact_bps) * square // 10000)
    lower, upper = max(MIN_SQRT, lower), min(MAX_SQRT - 1, upper)
    if not lower <= sqrt_price <= upper:
        raise ValueError('invalid_price_band')
    return lower, upper


def gas_price_estimate(base_fee, policy):
    """The expected effective price for the economic estimate, not the envelope ceiling."""
    if type(base_fee) is not int or base_fee < 0:
        raise ValueError('invalid_base_fee')
    return base_fee * (10000 + policy.basePriceBufferBps) // 10000 + policy.priorityFeePerGasWei


def bps_fraction(bps):
    return Fraction(int(bps), 10000)


def valid_hex_key(text):
    return isinstance(text, str) and re.fullmatch(r'[0-9a-f]{64}', text) is not None
