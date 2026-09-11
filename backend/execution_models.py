"""E1 offline candidate identities. No RPC, signing, persistence or admission.

Digests describe an immutable candidate; validating a record is NOT authorization.
Every encoded model declares its complete ABI field order. Nested records are
struct hashes; arrays are keccak(abi.encode(bytes32[])). See execution-v1.md.
"""
from typing import Annotated, ClassVar, Literal

from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, model_validator

from v4_math import MIN_SQRT as MIN_SQRT_RATIO, MAX_SQRT as MAX_SQRT_RATIO
from position_accounting import core_position_id


VERSION = 'e1-candidate-1'
ZERO = '0x' + '00' * 20
ZERO_HASH = '0x' + '00' * 32
U64_MAX = 2**64 - 1


def _uint(bits):
    def check(value):
        if int(value) >= 2**bits:
            raise ValueError('raw_uint_overflow')
        return value
    return Annotated[str, Field(pattern=r'^(0|[1-9][0-9]*)$', max_length=78), AfterValidator(check)]


def _nonzero(value):
    if int(value, 16) == 0:
        raise ValueError('zero_identity')
    return value


Raw64, Raw128, Raw160, Raw256 = (_uint(n) for n in (64, 128, 160, 256))
Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
Account = Annotated[Address, AfterValidator(_nonzero)]
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
Identity = Annotated[Hash, AfterValidator(_nonzero)]
Tick = Annotated[StrictInt, Field(ge=-887272, le=887272)]
Bps = Annotated[StrictInt, Field(ge=0, le=10000)]


def _hex(value):
    return '0x' + value.hex()


def _hash(value):
    return keccak(value)


class Record(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)
    ABI: ClassVar[tuple[tuple[str, str], ...]] = ()

    @classmethod
    def type_string(cls):
        return cls.__name__ + '(' + ','.join(t + ' ' + n for n, t in cls.ABI) + ')'

    def struct_hash(self):
        # Catch schema drift, including an accidentally omitted security field.
        if set(type(self).model_fields) != {n for n, _ in self.ABI}:
            raise ValueError('incomplete_encoding_schema')
        values = [_hash(self.type_string().encode())]
        for name, kind in self.ABI:
            value = getattr(self, name)
            if isinstance(value, Record):
                value = bytes.fromhex(value.digest()[2:])
            elif isinstance(value, tuple):
                value = _hash(encode(['bytes32[]'], [[bytes.fromhex(v.digest()[2:]) for v in value]]))
            elif kind == 'bytes32':
                value = bytes.fromhex(value[2:])
            elif kind.startswith(('uint', 'int')):
                value = int(value)
            values.append(value)
        return _hash(encode(['bytes32'] + [t for _, t in self.ABI], values))

    def digest(self):
        return _hex(self.struct_hash())


class PoolKey(Record):
    currency0: Address
    currency1: Account
    fee_pips: Annotated[StrictInt, Field(ge=0, le=1000000)]
    tick_spacing: Annotated[StrictInt, Field(ge=1, le=32767)]
    hooks: Literal[ZERO]
    ABI = (('currency0', 'address'), ('currency1', 'address'), ('fee_pips', 'uint24'),
           ('tick_spacing', 'int24'), ('hooks', 'address'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.currency0, 16) >= int(self.currency1, 16):
            raise ValueError('currency_order')
        return self

    def pool_id(self):
        return _hex(_hash(encode([t for _, t in self.ABI], [getattr(self, n) for n, _ in self.ABI])))


class SequenceIdentity(Record):
    chainId: Annotated[StrictInt, Field(ge=4663, le=4663)]
    owner: Account
    sequenceId: Identity
    vault: Account
    factory: Account
    implementation: Account
    implementationVersion: Raw64
    poolManager: Account
    positionManager: Account
    poolKey: PoolKey
    poolId: Identity
    baseCurrency: Address
    quoteCurrency: Address
    serviceFeeRecipient: Account
    ABI = (('chainId', 'uint256'), ('owner', 'address'), ('sequenceId', 'bytes32'),
           ('vault', 'address'), ('factory', 'address'), ('implementation', 'address'),
           ('implementationVersion', 'uint64'), ('poolManager', 'address'),
           ('positionManager', 'address'), ('poolKey', 'bytes32'), ('poolId', 'bytes32'),
           ('baseCurrency', 'address'), ('quoteCurrency', 'address'), ('serviceFeeRecipient', 'address'))

    @model_validator(mode='after')
    def checked(self):
        if self.poolId != self.poolKey.pool_id() or int(self.implementationVersion) == 0:
            raise ValueError('sequence_identity_mismatch')
        if self.baseCurrency == self.quoteCurrency or {self.baseCurrency, self.quoteCurrency} != {self.poolKey.currency0, self.poolKey.currency1}:
            raise ValueError('sequence_orientation_mismatch')
        return self


class PositionIdentity(Record):
    sequence: Identity
    tokenId: Raw256
    generation: Raw64
    isRoot: bool
    parentTokenId: Raw256
    tickLower: Tick
    tickUpper: Tick
    corePositionId: Identity
    registrationBaselineId: Identity
    ABI = (('sequence', 'bytes32'), ('tokenId', 'uint256'), ('generation', 'uint64'),
           ('isRoot', 'bool'), ('parentTokenId', 'uint256'), ('tickLower', 'int24'),
           ('tickUpper', 'int24'), ('corePositionId', 'bytes32'), ('registrationBaselineId', 'bytes32'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.generation) == 0 or self.tickLower >= self.tickUpper:
            raise ValueError('invalid_position')
        if (self.isRoot and self.parentTokenId != '0') or (not self.isRoot and self.parentTokenId == self.tokenId):
            raise ValueError('invalid_parent')
        return self


class FeeSourceIdentity(Record):
    sequence: Identity
    position: Identity
    currency: Address
    ABI = (('sequence', 'bytes32'), ('position', 'bytes32'), ('currency', 'address'))


class FeeCredit(Record):
    source: Identity
    transactionHash: Identity
    eventIndex: Annotated[StrictInt, Field(ge=0, le=2**32-1)]
    amountRaw: Raw128
    blockNumber: Raw64
    blockHash: Identity
    canonical: bool
    finalized: bool
    ABI = (('source', 'bytes32'), ('transactionHash', 'bytes32'), ('eventIndex', 'uint32'),
           ('amountRaw', 'uint128'), ('blockNumber', 'uint64'), ('blockHash', 'bytes32'),
           ('canonical', 'bool'), ('finalized', 'bool'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.amountRaw) == 0 or (self.finalized and not self.canonical):
            raise ValueError('invalid_credit')
        return self

    def credit_id(self):
        # Fork location and amount are reconciliation evidence, not dedup keys.
        return _hex(_hash(encode(['bytes32', 'bytes32', 'bytes32', 'uint32'], [
            _hash(b'FeeCreditId(bytes32 source,bytes32 transactionHash,uint32 eventIndex)'),
            bytes.fromhex(self.source[2:]), bytes.fromhex(self.transactionHash[2:]), self.eventIndex])))


class ExecutionLimits(Record):
    version: Raw64
    baseCurrency: Address
    quoteCurrency: Address
    upsideBps: Annotated[StrictInt, Field(gt=0, le=1000000)]
    maxSlippageBps: Annotated[StrictInt, Field(ge=0, lt=10000)]
    maxPriceImpactBps: Annotated[StrictInt, Field(ge=0, lt=10000)]
    maxGasCostWei: Raw128
    maxObservationAgeSeconds: Annotated[StrictInt, Field(gt=0, le=2**32-1)]
    forecastHorizonSeconds: Annotated[StrictInt, Field(gt=0, le=2**32-1)]
    ABI = (('version', 'uint64'), ('baseCurrency', 'address'), ('quoteCurrency', 'address'),
           ('upsideBps', 'uint32'), ('maxSlippageBps', 'uint16'), ('maxPriceImpactBps', 'uint16'),
           ('maxGasCostWei', 'uint128'), ('maxObservationAgeSeconds', 'uint32'),
           ('forecastHorizonSeconds', 'uint32'))

    @model_validator(mode='after')
    def checked(self):
        if self.baseCurrency == self.quoteCurrency or int(self.version) == 0 or int(self.maxGasCostWei) == 0:
            raise ValueError('invalid_execution_limits')
        return self


class SequencePolicy(Record):
    serviceFeeBps: Annotated[StrictInt, Field(ge=0, le=200)]
    triggerDistanceBps: Annotated[StrictInt, Field(ge=0, le=2000)]
    maxOverlapBps: Annotated[StrictInt, Field(ge=0, le=2000)]
    minimumIntervalSeconds: Annotated[StrictInt, Field(gt=0, le=2**32-1)]
    maxPositions: Annotated[StrictInt, Field(gt=0, le=255)]
    version: Raw64
    paused: bool
    limits: ExecutionLimits
    ABI = (('serviceFeeBps', 'uint16'), ('triggerDistanceBps', 'uint16'), ('maxOverlapBps', 'uint16'),
           ('minimumIntervalSeconds', 'uint32'), ('maxPositions', 'uint8'), ('version', 'uint64'),
           ('paused', 'bool'), ('limits', 'bytes32'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.version) == 0:
            raise ValueError('zero_policy_version')
        return self


class CustodyObservation(Record):
    position: PositionIdentity
    holder: Account
    individualApproval: Address
    active: bool
    ABI = (('position', 'bytes32'), ('holder', 'address'), ('individualApproval', 'address'), ('active', 'bool'))


class SourceBalance(Record):
    """Reconciled ledger/checkpoint assertion, not a balanceOf spending proof."""
    source: FeeSourceIdentity
    lotId: Identity
    currency: Address
    convertedCharged: bool
    amountRaw: Raw128
    reservedRaw: Raw128
    reconciliationId: Identity
    ABI = (('source', 'bytes32'), ('lotId', 'bytes32'), ('currency', 'address'),
           ('convertedCharged', 'bool'), ('amountRaw', 'uint128'), ('reservedRaw', 'uint128'),
           ('reconciliationId', 'bytes32'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.reservedRaw) > int(self.amountRaw):
            raise ValueError('over_reserved')
        if not self.convertedCharged and self.currency != self.source.currency:
            raise ValueError('original_currency_changed')
        return self


class AccrualObservation(Record):
    """Prospective collection estimate. Not a realized credit or a reserve."""
    source: FeeSourceIdentity
    amountRaw: Raw128
    checkpointId: Identity
    ABI = (('source', 'bytes32'), ('amountRaw', 'uint128'), ('checkpointId', 'bytes32'))


def _unique_sorted(records, key):
    keys = [key(v) for v in records]
    if keys != sorted(keys) or len(set(keys)) != len(keys):
        raise ValueError('duplicate_or_unsorted_records')


class Observation(Record):
    sequence: SequenceIdentity
    policy: SequencePolicy
    stateNonce: Raw64
    authorityGeneration: Raw64
    blockNumber: Raw64
    blockHash: Identity
    blockTimestamp: Raw64
    sqrtPriceX96: Raw160
    operator: Address
    operatorEnabled: bool
    canonical: bool
    coverageComplete: bool
    positions: Annotated[tuple[CustodyObservation, ...], Field(min_length=1, max_length=4096)]
    balances: Annotated[tuple[SourceBalance, ...], Field(max_length=4096)]
    accruals: Annotated[tuple[AccrualObservation, ...], Field(max_length=4096)]
    ABI = (('sequence', 'bytes32'), ('policy', 'bytes32'), ('stateNonce', 'uint64'),
           ('authorityGeneration', 'uint64'), ('blockNumber', 'uint64'), ('blockHash', 'bytes32'),
           ('blockTimestamp', 'uint64'), ('sqrtPriceX96', 'uint160'), ('operator', 'address'),
           ('operatorEnabled', 'bool'), ('canonical', 'bool'), ('coverageComplete', 'bool'),
           ('positions', 'bytes32'), ('balances', 'bytes32'), ('accruals', 'bytes32'))

    @model_validator(mode='after')
    def checked(self):
        sequence = self.sequence
        sid = sequence.digest()
        pair = {sequence.poolKey.currency0, sequence.poolKey.currency1}
        if (self.policy.limits.baseCurrency, self.policy.limits.quoteCurrency) != (sequence.baseCurrency, sequence.quoteCurrency):
            raise ValueError('orientation_pair_mismatch')
        if not MIN_SQRT_RATIO <= int(self.sqrtPriceX96) < MAX_SQRT_RATIO:
            raise ValueError('invalid_sqrt_price')
        if int(self.authorityGeneration) == 0:
            raise ValueError('zero_authority_generation')
        if self.operatorEnabled and self.operator == ZERO:
            raise ValueError('missing_enabled_operator')
        if sum(p.active for p in self.positions) > self.policy.maxPositions:
            raise ValueError('active_membership_exceeds_policy')
        _unique_sorted(self.positions, lambda v: v.position.digest())
        _unique_sorted(self.balances, lambda v: v.lotId)
        _unique_sorted(self.accruals, lambda v: v.source.digest())
        positions = {p.position.digest(): p for p in self.positions}
        nft_ids = [p.position.tokenId for p in self.positions]
        if len(set(nft_ids)) != len(nft_ids) or sum(p.position.isRoot for p in self.positions) != 1:
            raise ValueError('invalid_membership')
        for p in self.positions:
            identity = p.position
            if identity.sequence != sid or identity.tickLower % sequence.poolKey.tick_spacing or identity.tickUpper % sequence.poolKey.tick_spacing:
                raise ValueError('position_sequence_mismatch')
            if not identity.isRoot and identity.parentTokenId not in nft_ids:
                raise ValueError('unknown_parent')
            expected_core = core_position_id(sequence.positionManager, identity.tickLower, identity.tickUpper,
                                            '0x' + int(identity.tokenId).to_bytes(32, 'big').hex())
            if identity.corePositionId != expected_core:
                raise ValueError('core_position_mismatch')
            lineage, current = set(), identity
            while not current.isRoot:
                if current.tokenId in lineage:
                    raise ValueError('membership_cycle')
                lineage.add(current.tokenId)
                current = next(item.position for item in self.positions if item.position.tokenId == current.parentTokenId)
        aggregates = {}
        for entry in (*self.balances, *self.accruals):
            source = entry.source
            if source.sequence != sid or source.position not in positions or source.currency not in pair:
                raise ValueError('foreign_fee_source')
            if isinstance(entry, SourceBalance) and entry.currency not in pair:
                raise ValueError('foreign_balance_currency')
            currency = entry.currency if isinstance(entry, SourceBalance) else source.currency
            key = (source.digest(), currency)
            aggregates[key] = aggregates.get(key, 0) + int(entry.amountRaw)
            if aggregates[key] >= 2**128:
                raise ValueError('source_balance_overflow')
        return self


class Allocation(Record):
    lotId: Identity
    amountRaw: Raw128
    ABI = (('lotId', 'bytes32'), ('amountRaw', 'uint128'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.amountRaw) == 0:
            raise ValueError('zero_allocation')
        return self


class CollectionBudget(Record):
    sourceId: Identity
    maxGrossRaw: Raw128
    ABI = (('sourceId', 'bytes32'), ('maxGrossRaw', 'uint128'))

    @model_validator(mode='after')
    def checked(self):
        if int(self.maxGrossRaw) == 0:
            raise ValueError('zero_collection')
        return self


class Destination(Record):
    createChild: bool
    tokenId: Raw256
    tickLower: Tick
    tickUpper: Tick
    ABI = (('createChild', 'bool'), ('tokenId', 'uint256'), ('tickLower', 'int24'), ('tickUpper', 'int24'))

    @model_validator(mode='after')
    def checked(self):
        if self.tickLower >= self.tickUpper:
            raise ValueError('invalid_destination_range')
        return self


class SwapBounds(Record):
    """Single typed route commitment; E7 must reconstruct and qualify it."""
    enabled: bool
    adapterId: Hash
    adapterVersion: Raw64
    routeCommitment: Hash
    currencyIn: Address
    currencyOut: Address
    amountInRaw: Raw128
    minAmountOutRaw: Raw128
    ABI = (('enabled', 'bool'), ('adapterId', 'bytes32'), ('adapterVersion', 'uint64'),
           ('routeCommitment', 'bytes32'), ('currencyIn', 'address'), ('currencyOut', 'address'),
           ('amountInRaw', 'uint128'), ('minAmountOutRaw', 'uint128'))

    @model_validator(mode='after')
    def checked(self):
        if self.enabled:
            if (self.adapterId == ZERO_HASH or self.routeCommitment == ZERO_HASH or self.adapterVersion == '0'
                    or self.currencyIn == self.currencyOut or self.amountInRaw == '0' or self.minAmountOutRaw == '0'):
                raise ValueError('invalid_swap_bounds')
        elif (self.adapterId != ZERO_HASH or self.routeCommitment != ZERO_HASH or self.adapterVersion != '0'
              or self.currencyIn != ZERO or self.currencyOut != ZERO or self.amountInRaw != '0' or self.minAmountOutRaw != '0'):
            raise ValueError('noncanonical_disabled_swap')
        return self


class ExecutionPlan(Record):
    sequence: SequenceIdentity
    policyHash: Identity
    observationHash: Identity
    action: Annotated[StrictInt, Field(ge=1, le=3)]  # 1=self, 2=redirect, 3=create_domino
    path: Annotated[StrictInt, Field(ge=0, le=1)]  # 0=general, 1=net
    expectedPolicyVersion: Raw64
    expectedStateNonce: Raw64
    expectedAuthorityGeneration: Raw64
    sourceBlockNumber: Raw64
    sourceBlockHash: Identity
    deadline: Raw64
    allocations: Annotated[tuple[Allocation, ...], Field(max_length=4096)]
    collections: Annotated[tuple[CollectionBudget, ...], Field(max_length=4096)]
    destination: Destination
    liquidityIncrease: Raw128
    maxGrossFee0: Raw128
    maxGrossFee1: Raw128
    maxChargedInput0: Raw128
    maxChargedInput1: Raw128
    minNetAdded0: Raw128
    minNetAdded1: Raw128
    minSqrtPriceX96: Raw160
    maxSqrtPriceX96: Raw160
    maxGasCostWei: Raw128
    swap: SwapBounds
    ABI = (('sequence', 'bytes32'), ('policyHash', 'bytes32'), ('observationHash', 'bytes32'),
           ('action', 'uint8'), ('path', 'uint8'), ('expectedPolicyVersion', 'uint64'),
           ('expectedStateNonce', 'uint64'), ('expectedAuthorityGeneration', 'uint64'),
           ('sourceBlockNumber', 'uint64'), ('sourceBlockHash', 'bytes32'), ('deadline', 'uint64'),
           ('allocations', 'bytes32'), ('collections', 'bytes32'), ('destination', 'bytes32'), ('liquidityIncrease', 'uint128'),
           ('maxGrossFee0', 'uint128'), ('maxGrossFee1', 'uint128'), ('maxChargedInput0', 'uint128'),
           ('maxChargedInput1', 'uint128'), ('minNetAdded0', 'uint128'), ('minNetAdded1', 'uint128'),
           ('minSqrtPriceX96', 'uint160'), ('maxSqrtPriceX96', 'uint160'), ('maxGasCostWei', 'uint128'),
           ('swap', 'bytes32'))

    @model_validator(mode='after')
    def checked(self):
        _unique_sorted(self.allocations, lambda v: v.lotId)
        _unique_sorted(self.collections, lambda v: v.sourceId)
        if not self.allocations and not self.collections:
            raise ValueError('empty_plan')
        if not MIN_SQRT_RATIO <= int(self.minSqrtPriceX96) <= int(self.maxSqrtPriceX96) < MAX_SQRT_RATIO:
            raise ValueError('invalid_price_bounds')
        if int(self.expectedStateNonce) == U64_MAX or self.expectedPolicyVersion == '0' or self.expectedAuthorityGeneration == '0':
            raise ValueError('invalid_or_exhausted_version')
        if (self.action == 3) != self.destination.createChild:
            raise ValueError('action_destination_mismatch')
        if self.path == 1 and (self.action != 1 or self.swap.enabled or self.allocations):
            raise ValueError('net_path_not_eligible')
        if self.minNetAdded0 == self.minNetAdded1 == '0' or self.maxGasCostWei == '0':
            raise ValueError('missing_execution_bound')
        if not 0 < int(self.liquidityIncrease) < 2**127:
            raise ValueError('invalid_positive_liquidity_delta')
        return self

    def domain_hash(self):
        return _hash(encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
            _hash(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
            _hash(b'DominoPublicExecutor'), _hash(VERSION.encode()), self.sequence.chainId, self.sequence.vault]))

    def intent_id(self):
        return _hex(_hash(b'\x19\x01' + self.domain_hash() + self.struct_hash()))

    def successor_id(self):
        if self.action != 3:
            raise ValueError('not_successor_plan')
        return _hex(_hash(encode(['bytes32', 'bytes32', 'uint256'], [
            _hash(b'SuccessorId(bytes32 sequence,uint256 parentTokenId)'),
            self.sequence.struct_hash(), int(self.destination.tokenId)])))


class WaitDecision(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)
    action: Literal['wait']
    observationHash: Identity
    reason: Literal['unavailable', 'stale', 'paused', 'uneconomic', 'out_of_range', 'pending_intent', 'not_due']
    # There is deliberately no intent_id, calldata or transaction nonce.


def validate_candidate(plan: ExecutionPlan, observation: Observation, *, now: int, actor: str,
                       unresolved_successors: frozenset[str] = frozenset()):
    """Check offline consistency, NOT price integrity or live execution permission.

    E3 owns strategy/economics; E2/E4 enforce custody/fee authority on-chain; E5
    independently rebuilds the plan and atomically reserves balances/nonces.
    """
    if type(now) is not int or not 0 <= now <= U64_MAX:
        raise ValueError('invalid_clock')
    policy, sequence = observation.policy, observation.sequence
    if plan.sequence != sequence or plan.policyHash != policy.digest() or plan.observationHash != observation.digest():
        raise ValueError('candidate_snapshot_mismatch')
    if (plan.expectedPolicyVersion != policy.version or plan.expectedStateNonce != observation.stateNonce
            or plan.expectedAuthorityGeneration != observation.authorityGeneration
            or plan.sourceBlockNumber != observation.blockNumber or plan.sourceBlockHash != observation.blockHash):
        raise ValueError('stale_candidate')
    if policy.paused or (actor != sequence.owner and (actor != observation.operator or not observation.operatorEnabled)):
        raise ValueError('automation_authority_unavailable')
    if not observation.canonical or not observation.coverageComplete:
        raise ValueError('observation_unqualified')
    if not int(observation.blockTimestamp) <= now <= int(plan.deadline) or now - int(observation.blockTimestamp) > policy.limits.maxObservationAgeSeconds:
        raise ValueError('observation_or_plan_expired')
    if int(plan.deadline) > int(observation.blockTimestamp) + policy.limits.maxObservationAgeSeconds:
        raise ValueError('deadline_exceeds_observation_lifetime')
    if not int(plan.minSqrtPriceX96) <= int(observation.sqrtPriceX96) <= int(plan.maxSqrtPriceX96):
        raise ValueError('price_outside_bounds')
    if int(plan.maxGasCostWei) > int(policy.limits.maxGasCostWei):
        raise ValueError('gas_budget_exceeded')
    positions = {p.position.tokenId: p for p in observation.positions}
    root = next(p for p in observation.positions if p.position.isRoot)
    if not root.active or root.holder != sequence.owner or root.individualApproval != sequence.vault:
        raise ValueError('root_permission_unavailable')
    for p in observation.positions:
        if p.active and not p.position.isRoot and p.holder != sequence.vault:
            raise ValueError('child_custody_unavailable')
    destination = positions.get(plan.destination.tokenId)
    if destination is None or not destination.active:
        raise ValueError('destination_unavailable')
    lower, upper = plan.destination.tickLower, plan.destination.tickUpper
    if lower % sequence.poolKey.tick_spacing or upper % sequence.poolKey.tick_spacing:
        raise ValueError('destination_tick_alignment')
    if not plan.destination.createChild and (lower, upper) != (destination.position.tickLower, destination.position.tickUpper):
        raise ValueError('existing_range_changed')
    if plan.action == 3:
        if (sum(p.active for p in observation.positions) >= policy.maxPositions
                or any(p.active and not p.position.isRoot and p.position.parentTokenId == plan.destination.tokenId for p in observation.positions)
                or plan.successor_id() in unresolved_successors):
            raise ValueError('successor_unavailable')
    lots = {b.lotId: b for b in observation.balances}
    accruals = {a.source.digest(): a for a in observation.accruals}
    totals = {False: [0, 0], True: [0, 0]}
    original_by_source = {}
    selected_sources = set()
    pair = (sequence.poolKey.currency0, sequence.poolKey.currency1)
    for allocation in plan.allocations:
        lot = lots.get(allocation.lotId)
        if lot is None or int(allocation.amountRaw) > int(lot.amountRaw) - int(lot.reservedRaw):
            raise ValueError('allocation_unavailable')
        totals[lot.convertedCharged][pair.index(lot.currency)] += int(allocation.amountRaw)
        if not lot.convertedCharged:
            key = (lot.source.digest(), lot.currency)
            original_by_source[key] = original_by_source.get(key, 0) + int(allocation.amountRaw)
        selected_sources.add(lot.source.position)
    for collection in plan.collections:
        accrual = accruals.get(collection.sourceId)
        if accrual is None or int(collection.maxGrossRaw) > int(accrual.amountRaw):
            raise ValueError('collection_unavailable')
        member = next(p for p in observation.positions if p.position.digest() == accrual.source.position)
        if not member.active:
            raise ValueError('collection_source_inactive')
        totals[False][pair.index(accrual.source.currency)] += int(collection.maxGrossRaw)
        key = (accrual.source.digest(), accrual.source.currency)
        original_by_source[key] = original_by_source.get(key, 0) + int(collection.maxGrossRaw)
        selected_sources.add(accrual.source.position)
    if totals[False] != [int(plan.maxGrossFee0), int(plan.maxGrossFee1)] or totals[True] != [int(plan.maxChargedInput0), int(plan.maxChargedInput1)]:
        raise ValueError('fee_caps_mismatch')
    if plan.action == 1 and selected_sources != {destination.position.digest()}:
        raise ValueError('self_source_mismatch')
    if plan.action == 2 and selected_sources == {destination.position.digest()}:
        raise ValueError('redirect_without_foreign_source')
    net_budgets = [totals[False][i] + totals[True][i] for i in range(2)]
    if any(budget >= 2**128 for budget in net_budgets):
        raise ValueError('aggregate_currency_budget_overflow')
    for (_, currency), gross in original_by_source.items():
        net_budgets[pair.index(currency)] -= gross * policy.serviceFeeBps // 10000
    if plan.swap.enabled:
        if {plan.swap.currencyIn, plan.swap.currencyOut} != set(pair):
            raise ValueError('swap_pair_mismatch')
        index = pair.index(plan.swap.currencyIn)
        if int(plan.swap.amountInRaw) > net_budgets[index]:
            raise ValueError('swap_budget_exceeded')
        net_budgets[index] -= int(plan.swap.amountInRaw)
        net_budgets[1-index] += int(plan.swap.minAmountOutRaw)
    if int(plan.minNetAdded0) > net_budgets[0] or int(plan.minNetAdded1) > net_budgets[1]:
        raise ValueError('minimum_addition_exceeds_net_budget')
    return None
