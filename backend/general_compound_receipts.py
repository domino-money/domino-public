"""Bounded read-only verification of the V3 same-position compound receipt.

Admission is trusted release configuration: exact deployment identities and code
hashes, never browser-supplied qualification flags. RPC canonicality/finality are
provider trust boundaries. This module verifies a known transaction, not complete
execution history, token compatibility, earning timestamps, USD prices or APR.
The optional E1 proof preserves its immutable exact-allocation semantics; V3 caps
alone cannot prove those allocations were consumed.
"""
from typing import Annotated, ClassVar

from eth_abi import decode, encode
from eth_hash.auto import keccak
from pydantic import BaseModel, ConfigDict, Field, model_validator

import execution_models as m
from execution_receipts import PlanEffects, reconcile_plan_effects
from position_accounting import core_position_id
from read_deadline import check_read_deadline


MAX_REQUESTS = 128
MAX_LOGS = 256
MAX_RECEIPT_BYTES = 262144
MAX_TRANSACTIONS = 4096
POSITION_TYPE = '(bool,bool,bool,uint256,uint64,int24,int24,bytes32,bytes32,bytes32,bytes32)'
POOL_KEY_TYPE = '(address,address,uint24,int24,address)'
CHECKPOINT_TYPE = '(uint128,uint256,uint256,uint256,uint256,uint64,bytes32)'
AMOUNTS_TYPE = '(' + ','.join(['uint128'] * 9) + ')'


class CompoundPlan(m.Record):
    intentId: m.Identity
    tokenId: m.Raw256
    positionIdentity: m.Identity
    checkpointId: m.Identity
    policyVersion: m.Raw64
    limitsVersion: m.Raw64
    stateNonce: m.Raw64
    authorityGeneration: m.Raw64
    observedAtBlock: m.Raw64
    observedBlockHash: m.Identity
    observedAtTimestamp: m.Raw64
    deadline: m.Raw64
    liquidityIncrease: m.Raw128
    maxOriginal0: m.Raw128
    maxOriginal1: m.Raw128
    maxCharged0: m.Raw128
    maxCharged1: m.Raw128
    minAdded0: m.Raw128
    minAdded1: m.Raw128
    minSqrtPriceX96: m.Raw160
    maxSqrtPriceX96: m.Raw160
    ABI: ClassVar = (('intentId', 'bytes32'), ('tokenId', 'uint256'),
        ('positionIdentity', 'bytes32'), ('checkpointId', 'bytes32'),
        ('policyVersion', 'uint64'), ('limitsVersion', 'uint64'), ('stateNonce', 'uint64'),
        ('authorityGeneration', 'uint64'), ('observedAtBlock', 'uint64'),
        ('observedBlockHash', 'bytes32'), ('observedAtTimestamp', 'uint64'),
        ('deadline', 'uint64'), ('liquidityIncrease', 'uint128'),
        ('maxOriginal0', 'uint128'), ('maxOriginal1', 'uint128'),
        ('maxCharged0', 'uint128'), ('maxCharged1', 'uint128'),
        ('minAdded0', 'uint128'), ('minAdded1', 'uint128'),
        ('minSqrtPriceX96', 'uint160'), ('maxSqrtPriceX96', 'uint160'))

    @model_validator(mode='after')
    def checked(self):
        if (self.tokenId == '0' or not 0 < int(self.liquidityIncrease) < 2**127
                or self.policyVersion == '0' or self.limitsVersion == '0'
                or not 0 < int(self.authorityGeneration) < m.U64_MAX
                or int(self.stateNonce) == m.U64_MAX
                or int(self.deadline) < int(self.observedAtTimestamp)
                or self.minAdded0 == self.minAdded1 == '0'
                or not m.MIN_SQRT_RATIO <= int(self.minSqrtPriceX96) <= int(self.maxSqrtPriceX96) < m.MAX_SQRT_RATIO):
            raise ValueError('invalid_compound_plan')
        return self

    def values(self):
        return tuple(bytes.fromhex(getattr(self, n)[2:]) if t == 'bytes32'
                     else int(getattr(self, n)) for n, t in self.ABI)

    def calldata(self):
        checked = m.revalidate_record(CompoundPlan, self)
        return '0x' + (keccak(COMPOUND_SIGNATURE.encode())[:4] + encode([PLAN_TYPE], [checked.values()])).hex()

    def contract_plan_hash(self, sequence):
        checked = m.revalidate_record(CompoundPlan, self)
        sequence = m.revalidate_record(m.SequenceIdentity, sequence)
        return '0x' + keccak(encode(['bytes32', 'uint256', 'address', 'bytes32', PLAN_TYPE],
            [keccak(b'DominoCompoundSelfV1'), sequence.chainId, sequence.vault,
             bytes.fromhex(sequence.digest()[2:]), checked.values()])).hex()


PLAN_TYPE = '(' + ','.join(t for _, t in CompoundPlan.ABI) + ')'
COMPOUND_SIGNATURE = 'compoundSelf(' + PLAN_TYPE + ')'
REALIZED = '0x' + keccak(b'FeesRealized(address,bytes32,uint256,bytes32,bytes32,uint128,uint128)').hex()
APPLIED = '0x' + keccak(('SourceFeesApplied(address,bytes32,bytes32,address,' + AMOUNTS_TYPE + ')').encode()).hex()
COMPLETED = '0x' + keccak(b'CompoundSelfCompleted(bytes32,uint256,bytes32,uint128,uint128,uint64,uint64,uint64)').hex()


class _Record(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


class RuntimePin(_Record):
    address: m.Account
    codeHash: m.Identity


class CompoundAdmission(_Record):
    sequence: m.SequenceIdentity
    stateView: m.Account
    readHelper: m.Account
    compoundEngine: m.Account
    runtimePins: Annotated[tuple[RuntimePin, ...], Field(min_length=8, max_length=8)]

    @model_validator(mode='after')
    def checked(self):
        seq = self.sequence
        expected = {seq.vault, seq.implementation, seq.factory, seq.poolManager,
                    seq.positionManager, self.stateView, self.readHelper, self.compoundEngine}
        if (seq.implementationVersion != '3' or len(expected) != 8
                or {p.address for p in self.runtimePins} != expected):
            raise ValueError('invalid_compound_admission')
        return self


def _quantity(value):
    import re
    if not isinstance(value, str) or not re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)', value):
        raise ValueError('invalid_compound_rpc_quantity')
    result = int(value, 16)
    if result >= 2**256:
        raise ValueError('invalid_compound_rpc_quantity')
    return result


def _hex(value, size=None, maximum=65536):
    import re
    if (not isinstance(value, str) or len(value) > 2 + 2 * maximum
            or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value)):
        raise ValueError('invalid_compound_rpc_data')
    raw = bytes.fromhex(value[2:])
    if size is not None and len(raw) != size:
        raise ValueError('invalid_compound_rpc_data')
    return raw


def _abi(types, value):
    try:
        raw = _hex(value)
        values = decode(types, raw, strict=True)
        if encode(types, values) != raw:
            raise ValueError()
        return values
    except Exception:
        raise ValueError('invalid_compound_abi') from None


def _hash(value):
    return '0x' + _hex(value, 32).hex()


def _address(value):
    return '0x' + _hex(value, 20).hex()


def _header(raw):
    if type(raw) is not dict:
        raise ValueError('compound_header_unavailable')
    result = {'number': _quantity(raw.get('number')), 'hash': _hash(raw.get('hash')),
              'timestamp': _quantity(raw.get('timestamp'))}
    if max(result['number'], result['timestamp']) > m.U64_MAX:
        raise ValueError('invalid_compound_header')
    return result


class CompoundReceiptReconciler:
    """No signer, broadcast, persistence, polling loop or supplied effect objects."""
    def __init__(self, rpc):
        self.rpc = rpc
        self.requests = 0

    def _request(self, method, params=()):
        check_read_deadline()
        self.requests += 1
        if self.requests > MAX_REQUESTS:
            raise ValueError('compound_receipt_request_budget')
        try:
            result = self.rpc.request(method, list(params))
        except Exception:
            raise ValueError('compound_rpc_unavailable') from None
        check_read_deadline()
        return result

    def _block(self, number):
        raw = self._request('eth_getBlockByNumber', [hex(number) if type(number) is int else number, False])
        block = _header(raw)
        if type(number) is int and block['number'] != number:
            raise ValueError('compound_header_mismatch')
        return block, raw

    def _call(self, target, signature, outputs, block, inputs=(), values=()):
        data = '0x' + (keccak(signature.encode())[:4] + encode(inputs, values)).hex()
        result = self._request('eth_call', [{'to': target, 'data': data, 'gas': hex(500000)},
            {'blockHash': block['hash'], 'requireCanonical': True}])
        return _abi(outputs, result)

    def _identity(self, admission, block):
        seq = admission.sequence
        clone = bytes.fromhex('363d3d373d3d3d363d73' + seq.implementation[2:] + '5af43d82803e903d91602b57fd5bf3')
        for pin in admission.runtimePins:
            code = _hex(self._request('eth_getCode', [pin.address,
                {'blockHash': block['hash'], 'requireCanonical': True}]), maximum=24576)
            if not code or '0x' + keccak(code).hex() != pin.codeHash or pin.address == seq.vault and code != clone:
                raise ValueError('compound_runtime_changed')
        for signature, expected in [('owner()', seq.owner), ('factory()', seq.factory),
                ('implementation()', seq.implementation), ('poolManager()', seq.poolManager),
                ('positionManager()', seq.positionManager), ('stateView()', admission.stateView),
                ('readHelper()', admission.readHelper), ('compoundEngine()', admission.compoundEngine),
                ('serviceFeeRecipient()', seq.serviceFeeRecipient)]:
            if self._call(seq.vault, signature, ['address'], block)[0] != expected:
                raise ValueError('compound_deployment_identity_mismatch')
        if ('0x' + self._call(seq.vault, 'sequenceIdentityHash()', ['bytes32'], block)[0].hex() != seq.digest()
                or self._call(seq.vault, 'implementationVersion()', ['uint64'], block)[0] != 3):
            raise ValueError('compound_sequence_identity_mismatch')
        engine_pin = next(p.codeHash for p in admission.runtimePins if p.address == admission.compoundEngine)
        if ('0x' + self._call(seq.vault, 'compoundEngineCodeHash()', ['bytes32'], block)[0].hex() != engine_pin
                or self._call(admission.compoundEngine, 'cloneRuntimeHash()', ['bytes32'], block)[0] != keccak(clone)):
            raise ValueError('compound_engine_identity_mismatch')
        for signature, expected in (('poolManager()', seq.poolManager), ('positionManager()', seq.positionManager),
                                    ('readHelper()', admission.readHelper)):
            if self._call(admission.compoundEngine, signature, ['address'], block)[0] != expected:
                raise ValueError('compound_engine_identity_mismatch')

    def reconcile(self, plan, admission, transaction_hash, *, e1_plan=None, observation=None):
        """Return verified collection/consumption facts, never earning-time credits.

        Historical admission must cover these exact runtimes and currencies.
        Subsequent same-block state changes can make the bounded end-state check
        unavailable; they are never silently attributed to this receipt.
        """
        self.requests = 0
        plan = m.revalidate_record(CompoundPlan, plan)
        admission = m.revalidate_record(CompoundAdmission, admission)
        tx_hash = _hash(transaction_hash)
        seq = admission.sequence
        if _quantity(self._request('eth_chainId')) != 4663:
            raise ValueError('compound_wrong_chain')
        source, _ = self._block(int(plan.observedAtBlock))
        if (source['hash'], source['timestamp']) != (plan.observedBlockHash, int(plan.observedAtTimestamp)):
            raise ValueError('compound_source_reorganized')
        tx = self._request('eth_getTransactionByHash', [tx_hash])
        receipt = self._request('eth_getTransactionReceipt', [tx_hash])
        if type(tx) is not dict or type(receipt) is not dict:
            raise ValueError('compound_receipt_unavailable')
        import json
        if len(json.dumps(receipt, allow_nan=False).encode()) > MAX_RECEIPT_BYTES:
            raise ValueError('compound_receipt_size_budget')
        number = _quantity(receipt.get('blockNumber'))
        block, raw_block = self._block(number)
        finalized, _ = self._block('finalized')
        if (number < source['number'] or finalized['number'] < number
                or finalized['timestamp'] < block['timestamp']
                or (finalized['number'] == number and finalized != block)):
            raise ValueError('compound_finality_unavailable')
        index = _quantity(receipt.get('transactionIndex'))
        transactions = raw_block.get('transactions')
        if (type(transactions) is not list or len(transactions) > MAX_TRANSACTIONS
                or index >= len(transactions) or _hash(transactions[index]) != tx_hash):
            raise ValueError('compound_transaction_location_mismatch')
        actor = _address(tx.get('from'))
        for obj, hash_field in ((receipt, 'transactionHash'), (tx, 'hash')):
            if (_hash(obj.get(hash_field)) != tx_hash or _hash(obj.get('blockHash')) != block['hash']
                    or _quantity(obj.get('blockNumber')) != number
                    or _quantity(obj.get('transactionIndex')) != index
                    or _address(obj.get('to')) != seq.vault or _address(obj.get('from')) != actor):
                raise ValueError('compound_transaction_receipt_mismatch')
        if (_quantity(tx.get('chainId')) != 4663 or _quantity(tx.get('value')) != 0
                or '0x' + _hex(tx.get('input')).hex() != plan.calldata()):
            raise ValueError('compound_calldata_mismatch')
        if _quantity(receipt.get('status')) != 1:
            raise ValueError('compound_transaction_reverted')
        if not source['timestamp'] <= block['timestamp'] <= int(plan.deadline):
            raise ValueError('compound_receipt_outside_plan_time')
        logs = receipt.get('logs')
        if type(logs) is not list or len(logs) > MAX_LOGS:
            raise ValueError('compound_log_budget')
        effect_logs, previous = [], None
        emitters = {seq.vault, admission.compoundEngine}
        for ordinal, log in enumerate(logs):
            if type(log) is not dict:
                raise ValueError('invalid_compound_log')
            log_index = _quantity(log.get('logIndex'))
            if (log.get('removed') is not False or _hash(log.get('transactionHash')) != tx_hash
                    or _hash(log.get('blockHash')) != block['hash']
                    or _quantity(log.get('blockNumber')) != number
                    or _quantity(log.get('transactionIndex')) != index
                    or previous is not None and log_index != previous + 1):
                raise ValueError('compound_log_location_mismatch')
            previous = log_index
            topics = log.get('topics')
            if type(topics) is not list or len(topics) > 4:
                raise ValueError('invalid_compound_log')
            [_hash(t) for t in topics]
            _hex(log.get('data'))
            if _address(log.get('address')) in emitters:
                effect_logs.append((ordinal, log))
        # A second acquisition path catches receipt/query disagreement for the
        # admitted emitter. It does not turn one provider into a consensus proof.
        queried = self._request('eth_getLogs', [{'address': [seq.vault, admission.compoundEngine], 'blockHash': block['hash']}])
        if type(queried) is not list or len(queried) > MAX_LOGS:
            raise ValueError('compound_log_budget')
        selected = []
        for log in queried:
            if (type(log) is not dict or _address(log.get('address')) not in emitters
                    or _hash(log.get('blockHash')) != block['hash']
                    or _quantity(log.get('blockNumber')) != number or log.get('removed') is not False):
                raise ValueError('compound_log_query_mismatch')
            if _hash(log.get('transactionHash')) == tx_hash:
                selected.append(log)
        if selected != [log for _, log in effect_logs]:
            raise ValueError('compound_log_query_mismatch')
        self._identity(admission, source)
        self._identity(admission, block)
        result = self._effects(plan, admission, actor, source, block, tx_hash, effect_logs)
        gas_used = _quantity(receipt.get('gasUsed'))
        gas_price = _quantity(receipt.get('effectiveGasPrice'))
        result['gas'] = {'gasUsedRaw': str(gas_used), 'effectiveGasPriceRaw': str(gas_price),
            'receiptGasProductWei': str(gas_used * gas_price), 'payer': actor,
            'basis': 'receipt_gas_product_unqualified_total', 'executionComponentWei': None,
            'fullL2CostWei': None, 'l1FeeInclusion': 'unqualified', 'usd': None,
            'strategyDebitApplied': False}
        if e1_plan is not None or observation is not None:
            result['e1Proof'] = _e1_proof(plan, admission, result, e1_plan, observation, actor)
        final_check, _ = self._block('finalized')
        if (final_check['number'] < finalized['number']
                or final_check['timestamp'] < finalized['timestamp']
                or final_check['number'] == finalized['number'] and final_check != finalized):
            raise ValueError('compound_finality_changed')
        for expected in (source, block, finalized):
            if self._block(expected['number'])[0] != expected:
                raise ValueError('compound_canonicality_changed')
        if _quantity(self._request('eth_chainId')) != 4663:
            raise ValueError('compound_wrong_chain')
        return result

    def _effects(self, plan, admission, actor, source, block, tx_hash, logs):
        seq = admission.sequence
        signatures = [REALIZED, APPLIED, APPLIED, COMPLETED]
        if len(logs) != 4 or [(log.get('topics') or [None])[0] for _, log in logs] != signatures:
            raise ValueError('compound_event_set_mismatch')
        for index, (_, log) in enumerate(logs):
            engine_event = index < 3
            expected_count = 4 if engine_event else 3
            if (len(log['topics']) != expected_count
                    or _address(log['address']) != (admission.compoundEngine if engine_event else seq.vault)
                    or _hash(log['topics'][2 if engine_event else 1]) != plan.intentId
                    or engine_event and _abi(['address'], log['topics'][1])[0] != seq.vault):
                raise ValueError('compound_event_identity_mismatch')
        if (int(logs[0][1]['topics'][3], 16) != int(plan.tokenId)
                or int(logs[3][1]['topics'][2], 16) != int(plan.tokenId)):
            raise ValueError('compound_event_position_mismatch')
        realized = _abi(['bytes32', 'bytes32', 'uint128', 'uint128'], logs[0][1]['data'])
        complete = _abi(['bytes32', 'uint128', 'uint128', 'uint64', 'uint64', 'uint64'], logs[3][1]['data'])
        expected_hash = plan.contract_plan_hash(seq)
        if ('0x' + complete[0].hex() != expected_hash or complete[2] != complete[1] + int(plan.liquidityIncrease)
                or complete[3:] != (int(plan.policyVersion), int(plan.authorityGeneration), int(plan.stateNonce) + 1)):
            raise ValueError('compound_completion_mismatch')
        call = lambda signature, outputs, at, inputs=(), values=(): self._call(seq.vault, signature, outputs, at, inputs, values)
        policy_type = '(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
        limits_type = '(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
        policy = call('policy()', [policy_type], source)[0]
        limits = call('executionLimits()', [limits_type], source)[0]
        if (policy[0] > 200 or policy[5] != int(plan.policyVersion) or policy[6]
                or limits[0] != int(plan.limitsVersion)
                or int(plan.deadline) - source['timestamp'] > limits[5]
                or block['timestamp'] - source['timestamp'] > limits[5]
                or policy != call('policy()', [policy_type], block)[0]
                or limits != call('executionLimits()', [limits_type], block)[0]):
            raise ValueError('compound_policy_or_freshness_mismatch')
        if actor != seq.owner and not call('isOperator(address)', ['bool'], source, ['address'], [actor])[0]:
            raise ValueError('compound_actor_unavailable')
        for at, nonce, consumed in ((source, int(plan.stateNonce), False), (block, complete[5], True)):
            if (call('stateNonce()', ['uint64'], at)[0] != nonce
                    or call('authorityGeneration()', ['uint64'], at)[0] != int(plan.authorityGeneration)
                    or not call('rootPermissionValid()', ['bool'], at)[0]
                    or call('consumedIntent(bytes32)', ['bool'], at, ['bytes32'], [bytes.fromhex(plan.intentId[2:])])[0] != consumed):
                raise ValueError('compound_authority_changed')
        member = call('position(uint256)', [POSITION_TYPE], source, ['uint256'], [int(plan.tokenId)])[0]
        if (not member[0] or not member[1] or '0x' + member[8].hex() != plan.positionIdentity
                or member != call('position(uint256)', [POSITION_TYPE], block, ['uint256'], [int(plan.tokenId)])[0]):
            raise ValueError('compound_member_changed')
        # Reconstruct E1 identity preimages; internally consistent RPC labels
        # must not rename the position or either original-currency fee source.
        key = seq.poolKey
        expected_key = (key.currency0, key.currency1, key.fee_pips, key.tick_spacing, key.hooks)
        for at in (source, block):
            actual_key, info = self._call(seq.positionManager, 'getPoolAndPositionInfo(uint256)',
                [POOL_KEY_TYPE, 'uint256'], at, ['uint256'], [int(plan.tokenId)])
            signed_tick = lambda offset: ((info >> offset) & 0xffffff) - (1 << 24 if (info >> (offset+23)) & 1 else 0)
            if (actual_key != expected_key or info >> 56 != int(seq.poolId, 16) >> 56
                    or (signed_tick(8), signed_tick(32)) != member[5:7]
                    or member[5] % key.tick_spacing or member[6] % key.tick_spacing):
                raise ValueError('compound_core_position_mismatch')
        position = m.PositionIdentity(sequence=seq.digest(), tokenId=plan.tokenId,
            generation=str(member[4]), isRoot=member[2], parentTokenId=str(member[3]),
            tickLower=member[5], tickUpper=member[6], registrationBaselineId='0x'+member[7].hex(),
            corePositionId=core_position_id(seq.positionManager, member[5], member[6],
                '0x'+int(plan.tokenId).to_bytes(32, 'big').hex()))
        if position.digest() != plan.positionIdentity:
            raise ValueError('compound_position_identity_mismatch')
        source_ids = tuple(m.FeeSourceIdentity(sequence=seq.digest(), position=position.digest(), currency=c).digest()
                           for c in (key.currency0, key.currency1))
        if tuple('0x'+value.hex() for value in member[9:11]) != source_ids:
            raise ValueError('compound_source_identity_mismatch')
        before = call('checkpoint(uint256)', [CHECKPOINT_TYPE], source, ['uint256'], [int(plan.tokenId)])[0]
        after = call('checkpoint(uint256)', [CHECKPOINT_TYPE], block, ['uint256'], [int(plan.tokenId)])[0]
        if ('0x' + before[6].hex() != plan.checkpointId or before[0] != complete[1]
                or after[0] != complete[2] or after[5] != block['number']
                or after[1:3] != after[3:5]):
            raise ValueError('compound_checkpoint_mismatch')
        def commitment(point):
            return keccak(encode(['bytes32', 'bytes32', 'uint256', 'uint128', 'uint256', 'uint256',
                                 'uint256', 'uint256', 'uint64'],
                [keccak(b'DominoRegistrationCheckpointV1'), bytes.fromhex(seq.digest()[2:]), int(plan.tokenId), *point]))
        registration = call('registrationCheckpoint(uint256)', [CHECKPOINT_TYPE], source, ['uint256'], [int(plan.tokenId)])[0]
        if (registration != call('registrationCheckpoint(uint256)', [CHECKPOINT_TYPE], block, ['uint256'], [int(plan.tokenId)])[0]
                or registration[5] > source['number'] or registration[6] != member[7]
                or commitment(registration[:6]) != registration[6]):
            raise ValueError('compound_registration_checkpoint_mismatch')
        # The event's pre-collection point is fresh in the mined block. It is
        # not the earlier stored plan checkpoint: inside growth may have advanced.
        fresh = (before[0], before[1], before[2], after[3], after[4], block['number'])
        zeroed = (before[0], after[3], after[4], after[3], after[4], block['number'])
        if (commitment(before[:6]) != before[6] or commitment(after[:6]) != after[6]
                or commitment(fresh) != realized[0] or commitment(zeroed) != realized[1]
                or tuple(((after[3+i] - before[1+i]) % 2**256) * before[0] // 2**128 for i in (0, 1)) != realized[2:]):
            raise ValueError('compound_realization_checkpoint_mismatch')
        names = ('originalBefore', 'chargedBefore', 'realized', 'grossOriginalConsumed', 'chargedConsumed',
                 'serviceFee', 'liquidityAdded', 'originalAfter', 'chargedAfter')
        sources, collections = [], []
        for i, currency in enumerate((seq.poolKey.currency0, seq.poolKey.currency1)):
            ordinal, log = logs[i+1]
            source_id = source_ids[i]
            reported_currency, values = _abi(['address', AMOUNTS_TYPE], log['data'])
            if (_hash(log['topics'][3]) != source_id or reported_currency != currency):
                raise ValueError('compound_source_identity_mismatch')
            original, charged, amount, gross, spent, fee, added, original_after, charged_after = values
            # V3 pays from the charged reserve first, then uses the smallest
            # gross original amount whose floor fee leaves the exact debt.
            # Conservation alone also admits larger gross/fee plateau values.
            expected_spent = min(added, charged, int(getattr(plan, 'maxCharged'+str(i))))
            net = added - expected_spent
            expected_gross = (net-1)*10000 // (10000-policy[0]) + 1 if net else 0
            if (amount != realized[2+i] or original + amount != gross + original_after
                    or amount >= 2**127 or added >= 2**127
                    or original + amount + charged >= 2**128
                    or spent != expected_spent or gross != expected_gross
                    or charged != spent + charged_after or gross + spent != fee + added
                    or fee != gross * policy[0] // 10000
                    or gross > int(getattr(plan, 'maxOriginal'+str(i)))
                    or spent > int(getattr(plan, 'maxCharged'+str(i)))
                    or added < int(getattr(plan, 'minAdded'+str(i)))):
                raise ValueError('compound_source_conservation_mismatch')
            for at, expected in ((source, (original, charged)), (block, (original_after, charged_after))):
                if call('feeBalance(bytes32,address)', ['(uint128,uint128)'], at,
                        ['bytes32', 'address'], [member[9+i], currency])[0] != expected:
                    raise ValueError('compound_source_balance_mismatch')
            values = (original, charged, amount, gross, spent, fee, added, original_after, charged_after)
            sources.append({'sourceId': source_id, 'currency': currency, 'receiptLogIndex': ordinal,
                            **{name+'Raw': str(value) for name, value in zip(names, values)}})
            if amount:
                credit = m.FeeCredit(source=source_id, transactionHash=tx_hash, eventIndex=logs[0][0],
                    amountRaw=str(amount), blockNumber=str(block['number']), blockHash=block['hash'],
                    canonical=True, finalized=True)
                collections.append(credit)
        if not any(int(row['liquidityAddedRaw']) for row in sources):
            raise ValueError('compound_empty_addition')
        return {'intentId': plan.intentId, 'planHash': expected_hash, 'transactionHash': tx_hash,
            'block': block, 'canonical': True, 'finalized': True, 'sources': sources,
            'collections': tuple(collections), 'destinationTokenId': plan.tokenId,
            'tickLower': member[5], 'tickUpper': member[6], 'liquidityBeforeRaw': str(complete[1]),
            'liquidityAfterRaw': str(complete[2]), 'liquidityIncreaseRaw': plan.liquidityIncrease,
            'serviceFeeBps': policy[0], 'serviceFeeRecipient': seq.serviceFeeRecipient,
            'checkpointBefore': '0x' + realized[0].hex(), 'checkpointAfterCollect': '0x' + realized[1].hex(),
            'collectionClassification': 'realized_accrual_earning_time_unqualified',
            'earningTimestamp': None, 'incomeCoverage': 'unavailable', 'complete24h': False,
            'usdValuation': None, 'e1Proof': None, 'executionAvailable': False}


def _e1_proof(compound, admission, result, plan, observation, actor):
    """Optional exact E1 consistency, without translating caps to allocations."""
    plan = m.revalidate_record(m.ExecutionPlan, plan)
    observation = m.revalidate_record(m.Observation, observation)
    pairs = [('tokenId', plan.destination.tokenId), ('intentId', plan.intent_id()),
        ('policyVersion', plan.expectedPolicyVersion), ('limitsVersion', observation.policy.limits.version),
        ('stateNonce', plan.expectedStateNonce), ('authorityGeneration', plan.expectedAuthorityGeneration),
        ('observedAtBlock', plan.sourceBlockNumber), ('observedBlockHash', plan.sourceBlockHash),
        ('observedAtTimestamp', observation.blockTimestamp), ('deadline', plan.deadline),
        ('liquidityIncrease', plan.liquidityIncrease), ('maxOriginal0', plan.maxGrossFee0),
        ('maxOriginal1', plan.maxGrossFee1), ('maxCharged0', plan.maxChargedInput0),
        ('maxCharged1', plan.maxChargedInput1), ('minAdded0', plan.minNetAdded0),
        ('minAdded1', plan.minNetAdded1), ('minSqrtPriceX96', plan.minSqrtPriceX96),
        ('maxSqrtPriceX96', plan.maxSqrtPriceX96)]
    if (plan.sequence != admission.sequence or plan.action != 1 or plan.path != 0 or plan.swap.enabled
            or observation.policy.serviceFeeBps != result['serviceFeeBps']
            or any(getattr(compound, key) != value for key, value in pairs)):
        raise ValueError('compound_e1_plan_mismatch')
    member = next((p.position for p in observation.positions if p.position.tokenId == compound.tokenId), None)
    if member is None or member.digest() != compound.positionIdentity:
        raise ValueError('compound_e1_position_mismatch')
    if any(a.checkpointId != compound.checkpointId for a in observation.accruals
           if a.source.position == member.digest()):
        raise ValueError('compound_e1_accrual_checkpoint_mismatch')
    balances = []
    meaningful = {(b.source.digest(), b.currency) for b in observation.balances}
    meaningful.update((c.source, row['currency']) for c in result['collections'] for row in result['sources'] if row['sourceId'] == c.source)
    for row in result['sources']:
        if (row['sourceId'], row['currency']) not in meaningful and all(row[name+'Raw'] == '0' for name in (
                'originalBefore', 'chargedBefore', 'realized', 'grossOriginalConsumed', 'chargedConsumed',
                'serviceFee', 'liquidityAdded', 'originalAfter', 'chargedAfter')):
            continue
        balances.append({'sourceId': row['sourceId'], 'currency': row['currency'],
            'originalBeforeRaw': row['originalBeforeRaw'], 'chargedBeforeRaw': row['chargedBeforeRaw'],
            'grossOriginalRaw': row['grossOriginalConsumedRaw'], 'chargedInputRaw': row['chargedConsumedRaw'],
            'serviceFeeRaw': row['serviceFeeRaw'], 'liquidityFromInputRaw': row['liquidityAddedRaw'],
            'liquidityFromSwapRaw': '0', 'swapInRaw': '0', 'swapOutRaw': '0',
            'originalAfterRaw': row['originalAfterRaw'], 'chargedAfterRaw': row['chargedAfterRaw']})
    import json
    effects = PlanEffects.model_validate_json(json.dumps({'intentId': plan.intent_id(),
        'transactionHash': result['transactionHash'], 'blockNumber': str(result['block']['number']),
        'blockHash': result['block']['hash'], 'blockTimestamp': str(result['block']['timestamp']),
        'canonical': True, 'serviceFeeRecipient': result['serviceFeeRecipient'],
        'destinationTokenId': compound.tokenId, 'tickLower': result['tickLower'], 'tickUpper': result['tickUpper'],
        'liquidityIncrease': compound.liquidityIncrease,
        'collections': [c.model_dump(mode='json') for c in result['collections']], 'balances': balances, 'swaps': []}))
    projection = reconcile_plan_effects(plan, observation, effects, actor=actor)
    return {'effects': effects, 'projection': projection}
