"""Canonical observations for the automation cycle, pinned to one block hash.

What the vault, the position manager, the pool and the E5 ledger say at one
block, assembled into the planner's Observation. Every read names the block's
hash; a block whose hash changes between the first and the last read is not an
observation. Ledger balances are offered to the planner only where the vault's
own fee balances agree with them, and pool fee samples carry their epoch and
coverage so an uncovered interval starts a new series instead of an invented
one. Nothing here signs, persists a plan or qualifies a price source.
"""
from dataclasses import dataclass

from eth_abi import encode
from eth_hash.auto import keccak

import execution_models as m
import execution_planner as p
import execution_v4 as v4
import general_compound_receipts as g
from execution_store import _model
from position_accounting import core_position_id
from read_deadline import check_read_deadline

POLICY_TYPE = '(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
LIMITS_TYPE = '(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
POOL_KEY_TYPE = '(address,address,uint24,int24,address)'
MAX_MEMBERS = 256
U256 = 1 << 256


class ObservationError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ChainReader:
    """Bounded reads over the restricted execution transport, at a block hash."""
    def __init__(self, rpc, *, max_requests=4096):
        self.rpc, self.max_requests, self.requests = rpc, max_requests, 0

    def request(self, method, params=()):
        check_read_deadline()
        self.requests += 1
        if self.requests > self.max_requests:
            raise ObservationError('automation_request_budget')
        try:
            result = self.rpc.request(method, list(params))
        except Exception:
            raise ObservationError('automation_rpc_unavailable') from None
        check_read_deadline()
        return result

    def header(self, tag):
        raw = self.request('eth_getBlockByNumber', [tag, False])
        header = g._header(raw)
        fee = raw.get('baseFeePerGas')
        header['baseFeePerGas'] = g._quantity(fee) if fee is not None else 0
        return header

    def head(self):
        return self.header('latest')

    def block(self, number):
        header = self.header(hex(number))
        if header['number'] != number:
            raise ObservationError('automation_header_mismatch')
        return header

    def canonical(self, header):
        return self.block(header['number'])['hash'] == header['hash']

    def call(self, target, signature, outputs, block, inputs=(), values=()):
        data = '0x' + (keccak(signature.encode())[:4] + encode(list(inputs), list(values))).hex()
        raw = self.request('eth_call', [{'to': target, 'data': data, 'gas': hex(1_000_000)},
                                        {'blockHash': block['hash'], 'requireCanonical': True}])
        return g._abi(list(outputs), raw)

    def code_hash(self, address, block):
        code = g._hex(self.request('eth_getCode', [address, {'blockHash': block['hash'], 'requireCanonical': True}]), maximum=24576)
        return '0x' + keccak(code).hex() if code else None

    def balance(self, address):
        return g._quantity(self.request('eth_getBalance', [address, 'latest']))


def clone_code(implementation):
    return bytes.fromhex('363d3d373d3d3d363d73' + implementation[2:] + '5af43d82803e903d91602b57fd5bf3')


def derive_admission(reader, deployment, owner, vault, block):
    """A real admission profile for one sequence, from the verified deployment
    and the vault's own state at a canonical block. Every link is checked, so
    a vault that is not this deployment's clone cannot enter the cycle.
    """
    owner, vault = g._address(owner), g._address(vault)
    d = deployment
    hashes = d.codeHashes
    pins = {vault: hashes.vault, d.factory: hashes.factory, d.implementation: hashes.implementation,
            d.poolManager: hashes.poolManager, d.positionManager: hashes.positionManager, d.stateView: hashes.stateView,
            d.readHelper: hashes.readHelper, d.engine: hashes.engine, d.routing: hashes.routing, d.priceGuard: hashes.priceGuard}
    if len(pins) != 10:
        raise ObservationError('automation_admission_addresses_collide')
    for address, expected in pins.items():
        if reader.code_hash(address, block) != expected:
            raise ObservationError('automation_runtime_changed')
    if '0x' + keccak(clone_code(d.implementation)).hex() != hashes.vault:
        raise ObservationError('automation_vault_not_clone')
    if (not reader.call(d.factory, 'isVault(address)', ['bool'], block, ['address'], [vault])[0]
            or reader.call(d.factory, 'implementation()', ['address'], block)[0] != d.implementation):
        raise ObservationError('automation_vault_unknown_to_factory')
    call = lambda signature, outputs: reader.call(vault, signature, outputs, block)
    if (call('owner()', ['address'])[0] != owner or call('implementationVersion()', ['uint64'])[0] != 4
            or call('factory()', ['address'])[0] != d.factory or call('implementation()', ['address'])[0] != d.implementation
            or call('poolManager()', ['address'])[0] != d.poolManager or call('positionManager()', ['address'])[0] != d.positionManager
            or call('stateView()', ['address'])[0] != d.stateView or call('readHelper()', ['address'])[0] != d.readHelper
            or call('executionEngine()', ['address'])[0] != d.engine or call('serviceFeeRecipient()', ['address'])[0] != d.serviceFeeRecipient):
        raise ObservationError('automation_vault_identity_mismatch')
    key = call('poolKey()', [POOL_KEY_TYPE])[0]
    pool = m.PoolKey(currency0=key[0], currency1=key[1], fee_pips=key[2], tick_spacing=key[3], hooks=key[4])
    sequence = m.SequenceIdentity(chainId=4663, owner=owner, sequenceId='0x' + call('sequenceId()', ['bytes32'])[0].hex(),
        vault=vault, factory=d.factory, implementation=d.implementation, implementationVersion='4',
        poolManager=d.poolManager, positionManager=d.positionManager, poolKey=pool, poolId=pool.pool_id(),
        baseCurrency=call('baseCurrency()', ['address'])[0], quoteCurrency=call('quoteCurrency()', ['address'])[0],
        serviceFeeRecipient=d.serviceFeeRecipient)
    if ('0x' + call('sequenceIdentityHash()', ['bytes32'])[0].hex() != sequence.digest()
            or '0x' + call('poolId()', ['bytes32'])[0].hex() != sequence.poolId):
        raise ObservationError('automation_sequence_identity_mismatch')
    for signature, expected in (('factory()', d.factory), ('readHelper()', d.readHelper),
                                ('routingHelper()', d.routing), ('priceGuard()', d.priceGuard)):
        if reader.call(d.engine, signature, ['address'], block)[0] != expected:
            raise ObservationError('automation_engine_identity_mismatch')
    if reader.call(d.priceGuard, 'publisher()', ['address'], block)[0] != d.pricePublisher:
        raise ObservationError('automation_publisher_mismatch')
    return v4.Admission(sequence=sequence, stateView=d.stateView, readHelper=d.readHelper, executionEngine=d.engine,
        routingHelper=d.routing, priceGuard=d.priceGuard, pricePublisher=d.pricePublisher,
        runtimePins=tuple(g.RuntimePin(address=address, codeHash=code) for address, code in pins.items()))


@dataclass(frozen=True)
class PoolState:
    sqrt_price: int
    tick: int
    protocol_fee: int
    lp_fee: int
    liquidity: int
    fee_growth0: int
    fee_growth1: int


@dataclass(frozen=True)
class ObservationContext:
    observation: m.Observation
    checkpoints: dict
    member_liquidity: dict
    last_execution_at: int
    pool: PoolState
    block: dict
    diagnostics: tuple


def ledger_balances(rows):
    """E5 origins offered as planner balances: remaining after settled spends,
    with active claims of other intents carried as the reserved part."""
    balances = []
    for row in rows:
        remaining = int(row['remaining'])
        if remaining <= 0:
            continue
        balances.append(m.SourceBalance(source=_model(m.FeeSourceIdentity, row['source_record']), lotId=row['lot_id'],
            currency=row['currency'], convertedCharged=row['kind'] == 'converted', amountRaw=str(remaining),
            reservedRaw=str(min(int(row['reserved']), remaining)), reconciliationId=row['origin_id']))
    return tuple(sorted(balances, key=lambda b: b.lotId))


def pool_state(reader, state_view, pool_id, block):
    pool = bytes.fromhex(pool_id[2:])
    price, tick, protocol_fee, lp_fee = reader.call(state_view, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'], block, ['bytes32'], [pool])
    liquidity = reader.call(state_view, 'getLiquidity(bytes32)', ['uint128'], block, ['bytes32'], [pool])[0]
    growth0, growth1 = reader.call(state_view, 'getFeeGrowthGlobals(bytes32)', ['uint256', 'uint256'], block, ['bytes32'], [pool])
    return PoolState(price, tick, protocol_fee, lp_fee, liquidity, growth0, growth1)


def observe_sequence(reader, admission, balances, block):
    """The planner's Observation for one sequence at one canonical block."""
    seq = admission.sequence
    vault = seq.vault
    call = lambda signature, outputs, inputs=(), values=(): reader.call(vault, signature, outputs, block, inputs, values)
    if ('0x' + call('sequenceIdentityHash()', ['bytes32'])[0].hex() != seq.digest()
            or call('owner()', ['address'])[0] != seq.owner or call('implementationVersion()', ['uint64'])[0] != 4):
        raise ObservationError('automation_sequence_identity_mismatch')
    policy = call('policy()', [POLICY_TYPE])[0]
    limits = call('executionLimits()', [LIMITS_TYPE])[0]
    limits = m.ExecutionLimits(version=str(limits[0]), baseCurrency=seq.baseCurrency, quoteCurrency=seq.quoteCurrency,
        upsideBps=limits[1], maxSlippageBps=limits[2], maxPriceImpactBps=limits[3], maxGasCostWei=str(limits[4]),
        maxObservationAgeSeconds=limits[5], forecastHorizonSeconds=limits[6])
    policy = m.SequencePolicy(serviceFeeBps=policy[0], triggerDistanceBps=policy[1], maxOverlapBps=policy[2],
        minimumIntervalSeconds=policy[3], maxPositions=policy[4], version=str(policy[5]), paused=policy[6], limits=limits)
    operator = call('operator()', ['address'])[0]
    enabled = operator != m.ZERO and call('isOperator(address)', ['bool'], ['address'], [operator])[0]
    root = call('rootTokenId()', ['uint256'])[0]
    diagnostics = []
    members, checkpoints, liquidity, accruals, sources = [], {}, {}, [], []
    token, seen = root, set()
    while token and len(seen) < MAX_MEMBERS:
        if token in seen:
            raise ObservationError('automation_membership_cycle')
        seen.add(token)
        row = call('position(uint256)', [g.POSITION_TYPE], ['uint256'], [token])[0]
        if not row[0]:
            raise ObservationError('automation_unknown_position')
        position = m.PositionIdentity(sequence=seq.digest(), tokenId=str(token), generation=str(row[4]), isRoot=row[2],
            parentTokenId=str(row[3]), tickLower=row[5], tickUpper=row[6], registrationBaselineId='0x' + row[7].hex(),
            corePositionId=core_position_id(seq.positionManager, row[5], row[6], '0x' + token.to_bytes(32, 'big').hex()))
        if position.digest() != '0x' + row[8].hex():
            raise ObservationError('automation_position_identity_mismatch')
        holder = reader.call(seq.positionManager, 'ownerOf(uint256)', ['address'], block, ['uint256'], [token])[0]
        approval = reader.call(seq.positionManager, 'getApproved(uint256)', ['address'], block, ['uint256'], [token])[0] if row[2] else m.ZERO
        members.append(m.CustodyObservation(position=position, holder=holder, individualApproval=approval, active=row[1]))
        stored = call('checkpoint(uint256)', [g.CHECKPOINT_TYPE], ['uint256'], [token])[0]
        checkpoints[str(token)] = '0x' + stored[6].hex()
        liquidity[str(token)] = reader.call(seq.positionManager, 'getPositionLiquidity(uint256)', ['uint128'], block, ['uint256'], [token])[0]
        sources.append((position, '0x' + row[9].hex(), '0x' + row[10].hex()))
        if row[1]:
            fresh = reader.call(admission.readHelper, 'readCheckpoint(bytes32,bytes32,uint256,int24,int24)', [g.CHECKPOINT_TYPE], block,
                ['bytes32', 'bytes32', 'uint256', 'int24', 'int24'], [bytes.fromhex(seq.poolId[2:]), bytes.fromhex(seq.digest()[2:]), token, row[5], row[6]])[0]
            if fresh[:3] != stored[:3]:
                # The engine refuses a position whose manager state moved past
                # the stored checkpoint; offering its accrual would plan a revert.
                diagnostics.append('checkpoint_drift')
            else:
                amounts = reader.call(admission.readHelper, 'accrued(' + g.CHECKPOINT_TYPE + ')', ['uint128', 'uint128'], block, [g.CHECKPOINT_TYPE], [fresh])
                for source_id, currency, amount in zip((row[9], row[10]), (seq.poolKey.currency0, seq.poolKey.currency1), amounts):
                    source = m.FeeSourceIdentity(sequence=seq.digest(), position=position.digest(), currency=currency)
                    if source.digest() != '0x' + source_id.hex():
                        raise ObservationError('automation_source_identity_mismatch')
                    if amount:
                        accruals.append(m.AccrualObservation(source=source, amountRaw=str(amount), checkpointId=checkpoints[str(token)]))
        token = call('successorOf(uint256)', ['uint256'], ['uint256'], [token])[0]
    if token:
        raise ObservationError('automation_membership_budget')
    # The ledger is offered only where the vault agrees with it, per source and
    # currency: original lots against the original balance, converted lots
    # against the charged balance. Anything the ledger does not know about, or
    # knows differently, keeps the planner waiting rather than spending.
    ledger = {}
    for b in balances:
        key = (b.source.digest(), b.currency, b.convertedCharged)
        ledger[key] = ledger.get(key, 0) + int(b.amountRaw)
    for position, source0, source1 in sources:
        for source_id, currency in ((source0, seq.poolKey.currency0), (source1, seq.poolKey.currency1)):
            original, charged = call('feeBalance(bytes32,address)', ['(uint128,uint128)'], ['bytes32', 'address'], [bytes.fromhex(source_id[2:]), currency])[0]
            if ledger.get((source_id, currency, False), 0) != original or ledger.get((source_id, currency, True), 0) != charged:
                diagnostics.append('ledger_chain_mismatch')
    known = {sid for _, s0, s1 in sources for sid in (s0, s1)}
    if any(key[0] not in known for key in ledger):
        diagnostics.append('ledger_foreign_source')
    pool = pool_state(reader, admission.stateView, seq.poolId, block)
    last = call('lastExecutionAt()', ['uint64'])[0]
    canonical = reader.canonical(block)
    if not canonical:
        diagnostics.append('block_not_canonical')
    observation = m.Observation(sequence=seq, policy=policy, stateNonce=str(call('stateNonce()', ['uint64'])[0]),
        authorityGeneration=str(call('authorityGeneration()', ['uint64'])[0]), blockNumber=str(block['number']),
        blockHash=block['hash'], blockTimestamp=str(block['timestamp']), sqrtPriceX96=str(pool.sqrt_price),
        operator=operator, operatorEnabled=bool(enabled), canonical=canonical,
        coverageComplete=not diagnostics, positions=tuple(sorted(members, key=lambda c: c.position.digest())),
        balances=tuple(sorted(balances, key=lambda b: b.lotId)), accruals=tuple(sorted(accruals, key=lambda a: a.source.digest())))
    return ObservationContext(observation=observation, checkpoints=checkpoints, member_liquidity=liquidity,
        last_execution_at=last, pool=pool, block=block, diagnostics=tuple(diagnostics))


def sample_pool(reader, state_view, pool_id, block, previous, *, max_gap_seconds, sampler_version):
    """One pool fee/liquidity sample continuing the previous one's epoch.

    Fees earned over an interval are the fee-growth delta times the smaller of
    the two active liquidities at its ends, a floor under whatever liquidity
    actually sat in the pool between them. An interval longer than the
    admitted gap, or one touching a zero-liquidity reading, is not measured:
    the sample opens a new epoch instead of counting an uncovered interval.
    """
    state = pool_state(reader, state_view, pool_id, block)
    evidence = '0x' + keccak(encode(['bytes32', 'bytes32', 'uint256', 'uint256', 'uint128', 'int24', 'string'],
        [bytes.fromhex(pool_id[2:]), bytes.fromhex(block['hash'][2:]), state.fee_growth0, state.fee_growth1,
         state.liquidity, state.tick, sampler_version])).hex()
    row = {'pool_id': pool_id, 'block_number': block['number'], 'block_hash': block['hash'], 'block_timestamp': block['timestamp'],
           'fee_growth0': state.fee_growth0, 'fee_growth1': state.fee_growth1, 'liquidity': state.liquidity, 'tick': state.tick,
           'sqrt_price': state.sqrt_price, 'evidence_id': evidence, 'sampler_version': sampler_version, 'qualified': state.liquidity > 0}
    fresh = previous is None
    if not fresh:
        if int(previous['block_number']) >= block['number'] or int(previous['block_timestamp']) > block['timestamp']:
            raise ObservationError('automation_sample_order')
        elapsed = block['timestamp'] - int(previous['block_timestamp'])
        if elapsed == 0:
            # Same second as the previous sample: no interval to measure and no
            # reason to open a new epoch. The reading is simply not a sample.
            return None
        floor = min(int(previous['liquidity']), state.liquidity)
        fresh = (elapsed > max_gap_seconds or floor == 0 or not previous['qualified']
                 or previous['sampler_version'] != sampler_version)
    if fresh:
        row.update(epoch='0x' + keccak(encode(['string', 'bytes32', 'bytes32'], ['DominoPoolFeeEpochV1', bytes.fromhex(pool_id[2:]),
            bytes.fromhex(block['hash'][2:])])).hex(), cumulative_fee0=0, cumulative_fee1=0, cumulative_liquidity_seconds=0, coverage_complete=True)
        return row
    delta0 = (state.fee_growth0 - int(previous['fee_growth0'])) % U256
    delta1 = (state.fee_growth1 - int(previous['fee_growth1'])) % U256
    row.update(epoch=previous['epoch'], cumulative_fee0=int(previous['cumulative_fee0']) + (delta0 * floor >> 128),
        cumulative_fee1=int(previous['cumulative_fee1']) + (delta1 * floor >> 128),
        cumulative_liquidity_seconds=int(previous['cumulative_liquidity_seconds']) + floor * elapsed, coverage_complete=True)
    return row


def measurement_history(sequence_hash, rows, *, waiting_since, last_attempt_at, last_read_failed):
    """The planner's history from one epoch's qualified samples, newest last."""
    samples = tuple(p.FeeSample(sequence=sequence_hash, epoch=row['epoch'], blockNumber=int(row['block_number']),
        blockHash=row['block_hash'], timestamp=int(row['block_timestamp']), cumulativeFee0=int(row['cumulative_fee0']),
        cumulativeFee1=int(row['cumulative_fee1']), cumulativeLiquiditySeconds=int(row['cumulative_liquidity_seconds']),
        coverageComplete=bool(row['coverage_complete']), qualified=bool(row['qualified']), evidenceId=row['evidence_id'])
        for row in rows[-512:] if row['qualified'] and row['coverage_complete'])
    if samples:
        epoch = samples[-1].epoch
        samples = tuple(s for s in samples if s.epoch == epoch)
        # Strictly increasing liquidity-time is what the planner's validator
        # demands; a repeated reading of the same block is not a second sample.
        kept = []
        for sample in samples:
            if kept and (sample.cumulativeLiquiditySeconds <= kept[-1].cumulativeLiquiditySeconds or sample.timestamp <= kept[-1].timestamp):
                continue
            kept.append(sample)
        samples = tuple(kept)
    return p.MeasurementHistory(sequence=sequence_hash, waitingSince=waiting_since, samples=samples,
                                lastAttemptAt=last_attempt_at, lastReadFailed=last_read_failed)
