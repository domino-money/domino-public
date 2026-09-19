"""Closed V4 fee-only execution wire and pinned receipt verification.

Admission is operator-controlled deployment configuration; price observations
are independently published inputs, never a browser qualification or spot oracle.
"""
from typing import Annotated, ClassVar
from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import Field, model_validator
import execution_models as m
import general_compound_receipts as g

ZERO_ID = '0x' + '00' * 32
ZERO_ADDRESS = '0x' + '00' * 20
POSITION_REF_TYPE = '(uint256,bytes32,bytes32)'
BUDGET_TYPE = '(bytes32,address,uint128,uint128,uint128,uint128)'
SWAP_TYPE = '(bytes32,address,uint128,uint128,uint128,uint128,uint160,bytes32)'
PLAN_TYPE = '(' + ','.join((g.PLAN_TYPE, 'uint8', 'uint256', 'int24', 'int24', POSITION_REF_TYPE+'[]', BUDGET_TYPE+'[]', SWAP_TYPE)) + ')'
EXECUTE_SIGNATURE = 'execute(' + PLAN_TYPE + ')'
ADAPTER_ID = '0x' + keccak(b'DominoExecutionEngineV4:single-pool-exact-input').hex()
ADAPTER_VERSION = '1'

class PositionRef(m.Record):
    tokenId: m.Raw256
    positionIdentity: m.Identity
    checkpointId: m.Identity
    def values(self):
        return (int(self.tokenId), bytes.fromhex(self.positionIdentity[2:]), bytes.fromhex(self.checkpointId[2:]))

class FeeBudget(m.Record):
    sourceId: m.Identity
    currency: m.Address
    maxOriginal: m.Raw128
    maxCharged: m.Raw128
    minOriginal: m.Raw128
    minCharged: m.Raw128
    @model_validator(mode='after')
    def checked(self):
        if int(self.minOriginal)>int(self.maxOriginal) or int(self.minCharged)>int(self.maxCharged):
            raise ValueError('invalid_v4_budget_floor')
        return self
    def values(self):
        return (bytes.fromhex(self.sourceId[2:]), self.currency, int(self.maxOriginal), int(self.maxCharged), int(self.minOriginal), int(self.minCharged))

class SwapPlan(m.Record):
    sourceId: m.Hash
    currencyIn: m.Address
    amountIn: m.Raw128
    maxOriginal: m.Raw128
    maxCharged: m.Raw128
    minAmountOut: m.Raw128
    sqrtPriceLimitX96: m.Raw160
    priceObservationId: m.Hash
    @model_validator(mode='after')
    def checked(self):
        if self.amountIn == '0':
            # Every action carries a published observation, swap or not: the
            # anchor binds the whole execution, not only a conversion. Without
            # a swap the id is the one field this plan may set, and it must be.
            if (self.priceObservationId == ZERO_ID or self.sourceId != ZERO_ID
                or self.currencyIn != ZERO_ADDRESS
                or any(getattr(self, name) != '0' for name in ('maxOriginal','maxCharged','minAmountOut','sqrtPriceLimitX96'))):
                raise ValueError('invalid_disabled_v4_swap')
        elif (self.sourceId == ZERO_ID or self.priceObservationId == ZERO_ID or self.minAmountOut == '0'
              or self.maxOriginal == self.maxCharged == '0'
              or not m.MIN_SQRT_RATIO < int(self.sqrtPriceLimitX96) < m.MAX_SQRT_RATIO):
            raise ValueError('invalid_v4_swap')
        return self
    def values(self):
        return (bytes.fromhex(self.sourceId[2:]), self.currencyIn, int(self.amountIn), int(self.maxOriginal),
            int(self.maxCharged), int(self.minAmountOut), int(self.sqrtPriceLimitX96), bytes.fromhex(self.priceObservationId[2:]))

def route_commitment(swap, pool_id):
    """Fixed adapter route identity; priceObservationId is an independent input."""
    swap = m.revalidate_record(SwapPlan, swap)
    return '0x' + keccak(encode(['bytes32','bytes32','address','uint128','uint128','uint160'],
        [bytes.fromhex(ADAPTER_ID[2:]), bytes.fromhex(pool_id[2:]), swap.currencyIn, int(swap.amountIn),
         int(swap.minAmountOut), int(swap.sqrtPriceLimitX96)])).hex()

class Plan(m.Record):
    authority: g.CompoundPlan
    action: Annotated[int, Field(ge=0, le=3)]
    destinationTokenId: m.Raw256
    tickLower: m.Tick
    tickUpper: m.Tick
    collect: Annotated[tuple[PositionRef, ...], Field(max_length=16)]
    budgets: Annotated[tuple[FeeBudget, ...], Field(min_length=1, max_length=32)]
    swap: SwapPlan
    @model_validator(mode='after')
    def checked(self):
        a = self.authority
        if any(getattr(a, name) != '0' for name in ('maxOriginal0','maxOriginal1','maxCharged0','maxCharged1')):
            raise ValueError('duplicate_v4_budget_authority')
        ids = [int(p.tokenId) for p in self.collect]
        budgets = [(p.sourceId,p.currency) for p in self.budgets]
        if ids != sorted(set(ids)) or any(i == 0 for i in ids) or budgets != sorted(set(budgets)):
            raise ValueError('unordered_v4_sources')
        if self.action <= 1 and self.destinationTokenId != a.tokenId:
            raise ValueError('invalid_v4_destination')
        if self.action == 3:
            if self.destinationTokenId != '0' or self.tickLower >= self.tickUpper:
                raise ValueError('invalid_v4_successor')
        elif self.destinationTokenId == '0' or self.tickLower != 0 or self.tickUpper != 0:
            raise ValueError('invalid_v4_destination')
        if self.action == 1 and (len(self.collect) != 1 or self.collect[0].tokenId != a.tokenId
                or len(self.budgets) != 2 or any(b.maxCharged != '0' for b in self.budgets)
                or self.swap.amountIn != '0'):
            raise ValueError('invalid_v4_netting')
        for b in self.budgets:
            if b.maxOriginal == b.maxCharged == '0' and not (self.swap.amountIn != '0' and b.sourceId == self.swap.sourceId and b.currency != self.swap.currencyIn):
                raise ValueError('empty_v4_budget')
        if self.swap.amountIn != '0':
            budget = next((b for b in self.budgets if (b.sourceId,b.currency) == (self.swap.sourceId,self.swap.currencyIn)),None)
            if budget is None or int(self.swap.maxOriginal)>int(budget.maxOriginal) or int(self.swap.maxCharged)>int(budget.maxCharged):
                raise ValueError('unfunded_v4_swap')
        return self
    def values(self):
        return (self.authority.values(), self.action, int(self.destinationTokenId), self.tickLower, self.tickUpper,
            tuple(p.values() for p in self.collect), tuple(b.values() for b in self.budgets), self.swap.values())
    def calldata(self):
        checked = m.revalidate_record(Plan,self)
        return '0x'+(keccak(EXECUTE_SIGNATURE.encode())[:4]+encode([PLAN_TYPE],[checked.values()])).hex()
    def contract_plan_hash(self, sequence):
        checked = m.revalidate_record(Plan,self)
        sequence = m.revalidate_record(m.SequenceIdentity,sequence)
        return '0x'+keccak(encode(['bytes32','uint256','address','bytes32',PLAN_TYPE],
            [keccak(b'DominoExecutionV4'),sequence.chainId,sequence.vault,bytes.fromhex(sequence.digest()[2:]),checked.values()])).hex()

class Admission(g._Record):
    sequence: m.SequenceIdentity
    stateView: m.Account
    readHelper: m.Account
    executionEngine: m.Account
    routingHelper: m.Account
    priceGuard: m.Account
    pricePublisher: m.Account
    runtimePins: Annotated[tuple[g.RuntimePin, ...], Field(min_length=10,max_length=10)]
    @model_validator(mode='after')
    def checked(self):
        seq = self.sequence
        expected = {seq.vault,seq.implementation,seq.factory,seq.poolManager,seq.positionManager,
            self.stateView,self.readHelper,self.executionEngine,self.routingHelper,self.priceGuard}
        if (seq.implementationVersion != '4' or len(expected)!=10 or {p.address for p in self.runtimePins}!=expected
                or self.pricePublisher in expected or self.pricePublisher == seq.owner):
            raise ValueError('invalid_v4_admission')
        return self

REALIZED = g.REALIZED
APPLIED = '0x'+keccak(('BudgetApplied(address,bytes32,bytes32,address,uint256,'+g.AMOUNTS_TYPE+')').encode()).hex()
CONVERTED = '0x'+keccak(('FeesConverted(address,bytes32,bytes32,address,address,uint128,uint128,'+g.AMOUNTS_TYPE+',uint128,uint128)').encode()).hex()
COMPLETED = '0x'+keccak(b'ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)').hex()
REGISTERED = '0x'+keccak(b'PositionRegistered(uint256,bytes32,bytes32,bytes32,uint64)').hex()
SUCCESSOR = '0x'+keccak(b'SuccessorCreated(bytes32,uint256,uint256)').hex()
from general_compound_receipts import (_hex, _hash, _address, _abi, _quantity, MAX_LOGS,
    MAX_RECEIPT_BYTES, MAX_TRANSACTIONS)

class ReceiptReconciler(g.CompoundReceiptReconciler):
    """Exact typed calldata, canonical RPC locations, pinned code and source ledger.

    Immutable engine code proves real AMM collection/swap/settlement; this layer
    independently checks event conservation against before/after chain state.
    It cannot assign an earning timestamp or claim a live oracle qualification.
    """
    def _request(self, method, params=()):
        from read_deadline import check_read_deadline
        check_read_deadline()
        self.requests += 1
        if self.requests > 768: raise ValueError('v4_receipt_request_budget')
        try: result = self.rpc.request(method,list(params))
        except Exception: raise ValueError('v4_rpc_unavailable') from None
        check_read_deadline()
        return result

    def _identity(self, admission, block):
        seq = admission.sequence
        clone = bytes.fromhex('363d3d373d3d3d363d73'+seq.implementation[2:]+'5af43d82803e903d91602b57fd5bf3')
        for pin in admission.runtimePins:
            code = _hex(self._request('eth_getCode',[pin.address,{'blockHash':block['hash'],'requireCanonical':True}]),maximum=24576)
            if not code or '0x'+keccak(code).hex()!=pin.codeHash or pin.address==seq.vault and code!=clone:
                raise ValueError('v4_runtime_changed')
        for signature, expected in [('owner()',seq.owner),('factory()',seq.factory),('implementation()',seq.implementation),
                ('poolManager()',seq.poolManager),('positionManager()',seq.positionManager),('stateView()',admission.stateView),
                ('readHelper()',admission.readHelper),('executionEngine()',admission.executionEngine),
                ('serviceFeeRecipient()',seq.serviceFeeRecipient)]:
            if self._call(seq.vault,signature,['address'],block)[0]!=expected:
                raise ValueError('v4_deployment_identity_mismatch')
        if ('0x'+self._call(seq.vault,'sequenceIdentityHash()',['bytes32'],block)[0].hex()!=seq.digest()
                or self._call(seq.vault,'implementationVersion()',['uint64'],block)[0]!=4
                or self._call(seq.factory,'implementation()',['address'],block)[0]!=seq.implementation
                or not self._call(seq.factory,'isVault(address)',['bool'],block,['address'],[seq.vault])[0]):
            raise ValueError('v4_sequence_identity_mismatch')
        for signature,expected in [('factory()',seq.factory),('readHelper()',admission.readHelper),
                ('routingHelper()',admission.routingHelper),('priceGuard()',admission.priceGuard)]:
            if self._call(admission.executionEngine,signature,['address'],block)[0]!=expected:
                raise ValueError('v4_engine_identity_mismatch')
        for signature,address in [('executionEngineCodeHash()',admission.executionEngine),('readHelperCodeHash()',admission.readHelper)]:
            expected=next(p.codeHash for p in admission.runtimePins if p.address==address)
            if '0x'+self._call(seq.vault,signature,['bytes32'],block)[0].hex()!=expected:
                raise ValueError('v4_dependency_hash_mismatch')
        if self._call(admission.priceGuard,'publisher()',['address'],block)[0]!=admission.pricePublisher:
            raise ValueError('v4_price_publisher_mismatch')
    def reconcile(self, plan, admission, transaction_hash, *, e1_plan=None, observation=None):
        """Return verified collection/consumption facts, never earning-time credits.

        Historical admission must cover these exact runtimes and currencies.
        Subsequent same-block state changes can make the bounded end-state check
        unavailable; they are never silently attributed to this receipt.
        """
        self.requests = 0
        plan = m.revalidate_record(Plan, plan)
        admission = m.revalidate_record(Admission, admission)
        tx_hash = _hash(transaction_hash)
        seq = admission.sequence
        if _quantity(self._request('eth_chainId')) != 4663:
            raise ValueError('compound_wrong_chain')
        source, _ = self._block(int(plan.authority.observedAtBlock))
        if (source['hash'], source['timestamp']) != (plan.authority.observedBlockHash, int(plan.authority.observedAtTimestamp)):
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
        if not source['timestamp'] <= block['timestamp'] <= int(plan.authority.deadline):
            raise ValueError('compound_receipt_outside_plan_time')
        logs = receipt.get('logs')
        if type(logs) is not list or len(logs) > MAX_LOGS:
            raise ValueError('compound_log_budget')
        effect_logs, previous = [], None
        emitters = {seq.vault, admission.executionEngine}
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
        queried = self._request('eth_getLogs', [{'address': [seq.vault, admission.executionEngine], 'blockHash': block['hash']}])
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
            result['e1Proof'] = self._e1_proof(plan, admission, result, e1_plan, observation, actor)
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
        seq, a = admission.sequence, plan.authority
        call = lambda signature, outputs, at, inputs=(), values=(): self._call(seq.vault,signature,outputs,at,inputs,values)
        policy_type='(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
        limits_type='(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
        policy=call('policy()',[policy_type],source)[0]
        limits=call('executionLimits()',[limits_type],source)[0]
        if (policy[0]>200 or policy[5]!=int(a.policyVersion) or policy[6] or limits[0]!=int(a.limitsVersion)
                or block['timestamp']-source['timestamp']>limits[5]
                or int(a.deadline)-source['timestamp']>limits[5]
                or policy!=call('policy()',[policy_type],block)[0] or limits!=call('executionLimits()',[limits_type],block)[0]):
            raise ValueError('v4_policy_changed')
        if actor!=seq.owner and not call('isOperator(address)',['bool'],source,['address'],[actor])[0]:
            raise ValueError('v4_actor_unavailable')
        for at,nonce,consumed in ((source,int(a.stateNonce),False),(block,int(a.stateNonce)+1,True)):
            if (call('stateNonce()',['uint64'],at)[0]!=nonce
                    or call('authorityGeneration()',['uint64'],at)[0]!=int(a.authorityGeneration)
                    or not call('rootPermissionValid()',['bool'],at)[0]
                    or call('consumedIntent(bytes32)',['bool'],at,['bytes32'],[bytes.fromhex(a.intentId[2:])])[0]!=consumed):
                raise ValueError('v4_authority_changed')
        if not logs or logs[-1][1]['topics'][0]!=COMPLETED:
            raise ValueError('v4_completion_missing')
        _,final=logs[-1]
        if (len(final['topics'])!=3 or _address(final['address'])!=seq.vault
                or _hash(final['topics'][1])!=a.intentId or _hash(final['topics'][2])!=plan.contract_plan_hash(seq)):
            raise ValueError('v4_completion_identity_mismatch')
        action,parent,destination,nonce=_abi(['uint8','uint256','uint256','uint64'],final['data'])
        if ((action,parent,nonce)!=(plan.action,int(a.tokenId),int(a.stateNonce)+1)
                or destination==0 or plan.action!=3 and destination!=int(plan.destinationTokenId)):
            raise ValueError('v4_completion_mismatch')
        members={}
        def member(token,at=source):
            cache_key=(token,at['hash'])
            if cache_key in members:return members[cache_key]
            p=call('position(uint256)',[g.POSITION_TYPE],at,['uint256'],[token])[0]
            if not p[0] or not p[1]:raise ValueError('v4_unknown_position')
            position=m.PositionIdentity(sequence=seq.digest(),tokenId=str(token),generation=str(p[4]),isRoot=p[2],
                parentTokenId=str(p[3]),tickLower=p[5],tickUpper=p[6],registrationBaselineId='0x'+p[7].hex(),
                corePositionId=g.core_position_id(seq.positionManager,p[5],p[6],'0x'+token.to_bytes(32,'big').hex()))
            identities=tuple(m.FeeSourceIdentity(sequence=seq.digest(),position=position.digest(),currency=c).digest()
                for c in (seq.poolKey.currency0,seq.poolKey.currency1))
            if position.digest()!='0x'+p[8].hex() or identities!=tuple('0x'+i.hex() for i in p[9:11]):
                raise ValueError('v4_source_preimage_mismatch')
            owner=self._call(seq.positionManager,'ownerOf(uint256)',['address'],at,['uint256'],[token])[0]
            if owner!=(seq.owner if p[2] else seq.vault):raise ValueError('v4_position_custody_mismatch')
            key,info=self._call(seq.positionManager,'getPoolAndPositionInfo(uint256)',[g.POOL_KEY_TYPE,'uint256'],at,['uint256'],[token])
            expected=(seq.poolKey.currency0,seq.poolKey.currency1,seq.poolKey.fee_pips,seq.poolKey.tick_spacing,seq.poolKey.hooks)
            tick=lambda offset:((info>>offset)&0xffffff)-(1<<24 if (info>>(offset+23))&1 else 0)
            if key!=expected or (tick(8),tick(32))!=p[5:7] or info>>56!=int(seq.poolId,16)>>56:
                raise ValueError('v4_core_position_mismatch')
            members[cache_key]=p
            return p
        parent_member=member(parent)
        if '0x'+parent_member[8].hex()!=a.positionIdentity:raise ValueError('v4_parent_changed')
        for ref in plan.collect:
            if '0x'+member(int(ref.tokenId))[8].hex()!=ref.positionIdentity:
                raise ValueError('v4_collection_identity_mismatch')
            cp=call('checkpoint(uint256)',[g.CHECKPOINT_TYPE],source,['uint256'],[int(ref.tokenId)])[0]
            if '0x'+cp[6].hex()!=ref.checkpointId:raise ValueError('v4_collection_checkpoint_mismatch')
        cp=call('checkpoint(uint256)',[g.CHECKPOINT_TYPE],source,['uint256'],[parent])[0]
        if '0x'+cp[6].hex()!=a.checkpointId:raise ValueError('v4_parent_checkpoint_mismatch')
        target=member(destination,block)
        if action==3:
            if (target[2] or target[3]!=parent or target[5:7]!=(plan.tickLower,plan.tickUpper)
                    or call('successorOf(uint256)',['uint256'],source,['uint256'],[parent])[0]!=0
                    or call('successorOf(uint256)',['uint256'],block,['uint256'],[parent])[0]!=destination):
                raise ValueError('v4_successor_mismatch')
            before_liquidity=0
        else:
            if member(destination)!=target:raise ValueError('v4_destination_changed')
            before_liquidity=call('checkpoint(uint256)',[g.CHECKPOINT_TYPE],source,['uint256'],[destination])[0][0]
        after_cp=call('checkpoint(uint256)',[g.CHECKPOINT_TYPE],block,['uint256'],[destination])[0]
        actual=self._call(seq.positionManager,'getPositionLiquidity(uint256)',['uint128'],block,['uint256'],[destination])[0]
        if after_cp[0]!=before_liquidity+int(a.liquidityIncrease) or actual!=after_cp[0] or after_cp[5]!=block['number']:
            raise ValueError('v4_liquidity_mismatch')
        budgets={(b.sourceId,b.currency):b for b in plan.budgets}
        rows={}; collections=[]; conversions=[]; realizations=[]; applications=[]; net_realized={}; seen_successor=0; seen_registered=0
        def row(source_id,currency):
            key=(source_id,currency)
            if key in rows:return rows[key]
            sid=bytes.fromhex(source_id[2:])
            known,token,original_currency,identity=call('source(bytes32)',['(bool,uint256,address,bytes32)'],source,['bytes32'],[sid])[0]
            if not known or currency not in (seq.poolKey.currency0,seq.poolKey.currency1):raise ValueError('v4_foreign_source')
            source_member=member(token)
            if identity!=source_member[8] or sid not in source_member[9:11]:raise ValueError('v4_foreign_source')
            original,charged=call('feeBalance(bytes32,address)',['(uint128,uint128)'],source,['bytes32','address'],[sid,currency])[0]
            result={'sourceId':source_id,'currency':currency,'tokenId':str(token),'originalCurrency':original_currency,
                'originalBefore':original,'chargedBefore':charged,'original':original,'charged':charged,
                'realized':0,'grossOriginalConsumed':0,'chargedConsumed':0,'serviceFee':0,'liquidityAdded':0,
                'swapIn':0,'swapOut':0,'liquidityFromSwap':0,'receiptLogIndex':None}
            rows[key]=result;return result
        def apply(source_id,currency,values,ordinal,swap=False):
            r=row(source_id,currency); b=budgets.get((source_id,currency))
            original,charged,realized,gross,spent,fee,added,after_original,after_charged=values
            if b is None or (original,charged)!=(r['original'],r['charged']):raise ValueError('v4_budget_balance_mismatch')
            if (realized and plan.action!=1 or original+realized!=gross+after_original
                    or charged!=spent+after_charged or gross+spent!=fee+added
                    or fee!=(r['grossOriginalConsumed']+gross)*policy[0]//10000-r['grossOriginalConsumed']*policy[0]//10000
                    or r['grossOriginalConsumed']+gross>int(b.maxOriginal)
                    or r['grossOriginalConsumed']+gross>int(b.minOriginal)+min(int(b.maxOriginal)-int(b.minOriginal),r['realized']+realized)
                    or r['originalBefore']<int(b.minOriginal) or r['chargedBefore']<int(b.minCharged)
                    or gross and currency!=r['originalCurrency']):raise ValueError('v4_conservation_mismatch')
            # Output created earlier in this receipt is distinct from admitted old
            # charged input. The immutable engine consumes charged balances first.
            old_charged=min(spent,max(0,int(b.maxCharged)-r['chargedConsumed']))
            newly_charged=spent-old_charged
            if newly_charged and (swap or r['liquidityFromSwap']+newly_charged>r['swapOut']):
                raise ValueError('v4_charged_cap_mismatch')
            if realized:net_realized[(source_id,currency)]=net_realized.get((source_id,currency),0)+realized
            r.update(original=after_original,charged=after_charged,receiptLogIndex=ordinal)
            for name,amount in [('grossOriginalConsumed',gross),('chargedConsumed',old_charged),('serviceFee',fee)]:r[name]+=amount
            r['swapIn' if swap else 'liquidityAdded']+=added
            if not swap:r['liquidityFromSwap']+=newly_charged
            return r
        for ordinal,log in logs[:-1]:
            topics=log['topics'];sig=topics[0];emitter=_address(log['address'])
            if sig in (REALIZED,APPLIED,CONVERTED):
                if (emitter!=admission.executionEngine or len(topics)!=4 or _abi(['address'],topics[1])[0]!=seq.vault
                        or _hash(topics[2])!=a.intentId):raise ValueError('v4_event_identity_mismatch')
            elif emitter!=seq.vault:raise ValueError('v4_unexpected_event')
            if sig==REALIZED:
                token=int(topics[3],16);p=member(token)
                before_id,after_id,amount0,amount1=_abi(['bytes32','bytes32','uint128','uint128'],log['data'])
                if not any(before_id) or not any(after_id):raise ValueError('v4_checkpoint_missing')
                allowed={int(ref.tokenId) for ref in plan.collect}|({destination} if action!=3 else set())
                if token not in allowed:raise ValueError('v4_unplanned_collection')
                realizations.append({'tokenId':str(token),'amount0Raw':str(amount0),'amount1Raw':str(amount1),
                    'checkpointBefore':'0x'+before_id.hex(),'checkpointAfter':'0x'+after_id.hex(),'receiptLogIndex':ordinal})
                for sid,currency,amount in zip(p[9:11],(seq.poolKey.currency0,seq.poolKey.currency1),(amount0,amount1)):
                    source_id='0x'+sid.hex();r=row(source_id,currency)
                    r['realized']+=amount
                    if action!=1:r['original']+=amount
                    if amount:collections.append(m.FeeCredit(source=source_id,transactionHash=tx_hash,eventIndex=ordinal,
                        amountRaw=str(amount),blockNumber=str(block['number']),blockHash=block['hash'],canonical=True,finalized=True))
            elif sig==APPLIED:
                currency,target_id,values=_abi(['address','uint256',g.AMOUNTS_TYPE],log['data'])
                if target_id!=destination:raise ValueError('v4_budget_destination_mismatch')
                r=apply(_hash(topics[3]),currency,values,ordinal)
                applications.append({'sourceId':r['sourceId'],'sourceTokenId':r['tokenId'],'currency':currency,
                    'destinationTokenId':str(destination),'receiptLogIndex':ordinal,
                    **{name+'Raw':str(value) for name,value in zip(('originalBefore','chargedBefore','realized',
                    'grossOriginalConsumed','chargedConsumed','serviceFee','liquidityAdded','originalAfter','chargedAfter'),values)}})
            elif sig==CONVERTED:
                if conversions or plan.swap.amountIn=='0':raise ValueError('v4_unplanned_swap')
                c_in,c_out,amount_in,amount_out,values,before_charged,after_charged=_abi(
                    ['address','address','uint128','uint128',g.AMOUNTS_TYPE,'uint128','uint128'],log['data'])
                sid=_hash(topics[3]);swap=plan.swap
                if ((sid,c_in,amount_in)!=(swap.sourceId,swap.currencyIn,int(swap.amountIn))
                        or c_out not in (seq.poolKey.currency0,seq.poolKey.currency1) or c_in==c_out
                        or amount_out<int(swap.minAmountOut) or values[6]!=amount_in):raise ValueError('v4_swap_bounds_mismatch')
                apply(sid,c_in,values,ordinal,True);out=row(sid,c_out)
                if out['charged']!=before_charged or after_charged!=before_charged+amount_out:
                    raise ValueError('v4_conversion_lineage_mismatch')
                out['charged']=after_charged;out['swapOut']+=amount_out
                conversions.append({'sourceId':sid,'sourceTokenId':out['tokenId'],'inputAmounts':{name+'Raw':str(value) for name,value in zip(('originalBefore','chargedBefore','realized','grossOriginalConsumed','chargedConsumed','serviceFee','liquidityAdded','originalAfter','chargedAfter'),values)},'currencyIn':c_in,'currencyOut':c_out,
                    'amountInRaw':str(amount_in),'amountOutRaw':str(amount_out),'receiptLogIndex':ordinal,
                    'chargedOutputBeforeRaw':str(before_charged),'chargedOutputAfterRaw':str(after_charged),
                    'priceObservationId':swap.priceObservationId})
            elif sig==REGISTERED:
                if (action!=3 or seen_registered or len(topics)!=3 or int(topics[1],16)!=destination
                        or _hash(topics[2])!='0x'+target[8].hex()):raise ValueError('v4_registration_mismatch')
                s0,s1,event_nonce=_abi(['bytes32','bytes32','uint64'],log['data'])
                if (s0,s1,event_nonce)!=(target[9],target[10],int(a.stateNonce)):raise ValueError('v4_registration_mismatch')
                seen_registered+=1
            elif sig==SUCCESSOR:
                if (action!=3 or seen_successor or len(topics)!=4 or _hash(topics[1])!=a.intentId
                        or int(topics[2],16)!=parent or int(topics[3],16)!=destination or _hex(log['data'])!=b''):
                    raise ValueError('v4_successor_event_mismatch')
                seen_successor+=1
            else:raise ValueError('v4_unexpected_event')
        if bool(conversions)!=(plan.swap.amountIn!='0') or (seen_registered,seen_successor)!=((1,1) if action==3 else (0,0)):
            raise ValueError('v4_event_set_mismatch')
        additions={seq.poolKey.currency0:0,seq.poolKey.currency1:0}; result_rows=[]
        for (sid,currency),r in sorted(rows.items()):
            actual=call('feeBalance(bytes32,address)',['(uint128,uint128)'],block,['bytes32','address'],[bytes.fromhex(sid[2:]),currency])[0]
            if actual!=(r['original'],r['charged']) or (action==1 and net_realized.get((sid,currency),0)!=r['realized']):
                raise ValueError('v4_end_balance_mismatch')
            if (r['originalBefore']+r['chargedBefore']+r['realized']+r['swapOut']!=r['original']+r['charged']+
                    r['serviceFee']+r['liquidityAdded']+r['swapIn']):raise ValueError('v4_source_total_mismatch')
            b=budgets.get((sid,currency))
            if b and (r['grossOriginalConsumed']<int(b.minOriginal) or r['chargedConsumed']<int(b.minCharged)):
                raise ValueError('v4_unconsumed_exact_allocation')
            additions[currency]+=r['liquidityAdded']
            result_rows.append({'sourceId':sid,'currency':currency,'tokenId':r['tokenId'],'sourceTokenId':r['tokenId'],'destinationTokenId':str(destination),'receiptLogIndex':r['receiptLogIndex'],
                **{name+'Raw':str(r[name]) for name in ('originalBefore','chargedBefore','realized','grossOriginalConsumed',
                    'chargedConsumed','serviceFee','liquidityAdded','swapIn','swapOut','liquidityFromSwap')},
                'originalAfterRaw':str(r['original']),'chargedAfterRaw':str(r['charged'])})
        if (not any(additions.values()) or additions[seq.poolKey.currency0]<int(a.minAdded0)
                or additions[seq.poolKey.currency1]<int(a.minAdded1)):raise ValueError('v4_minimum_liquidity_mismatch')
        return {'intentId':a.intentId,'planHash':plan.contract_plan_hash(seq),'transactionHash':tx_hash,'block':block,
            'canonical':True,'finalized':True,'action':action,'parentTokenId':str(parent),'destinationTokenId':str(destination),
            'tickLower':target[5],'tickUpper':target[6],'liquidityBeforeRaw':str(before_liquidity),
            'liquidityAfterRaw':str(after_cp[0]),'liquidityIncreaseRaw':a.liquidityIncrease,
            'serviceFeeBps':policy[0],'serviceFeeRecipient':seq.serviceFeeRecipient,'sources':result_rows,
            'collections':tuple(collections),'conversions':tuple(conversions),'realizations':tuple(realizations),
            'applications':tuple(applications),'successorCreated':({'parentTokenId':str(parent),'tokenId':str(destination)} if action==3 else None),'e1Proof':None,
            'collectionClassification':'realized_accrual_earning_time_unqualified','earningTimestamp':None,
            'incomeCoverage':'unavailable','complete24h':False,'usdValuation':None,'executionAvailable':False}
    def _e1_proof(self, typed, admission, result, plan, observation, actor):
        """Preserve exact E1 debits; incidental credits remain separately available.

        E1's immutable projection does not acquire permission to spend newly
        discovered destination fees. Remove only these unspent credits from the
        projection view, retaining their real chain records in the result.
        """
        import json
        from collections import defaultdict
        from execution_receipts import PlanEffects, reconcile_plan_effects
        plan=m.revalidate_record(m.ExecutionPlan,plan)
        observation=m.revalidate_record(m.Observation,observation)
        a=typed.authority
        expected_action=(1 if plan.path==1 else 0) if plan.action==1 else plan.action
        pairs=[('intentId',plan.intent_id()),('policyVersion',plan.expectedPolicyVersion),
            ('limitsVersion',observation.policy.limits.version),('stateNonce',plan.expectedStateNonce),
            ('authorityGeneration',plan.expectedAuthorityGeneration),('observedAtBlock',plan.sourceBlockNumber),
            ('observedBlockHash',plan.sourceBlockHash),('observedAtTimestamp',observation.blockTimestamp),
            ('deadline',plan.deadline),('liquidityIncrease',plan.liquidityIncrease),
            ('minAdded0',plan.minNetAdded0),('minAdded1',plan.minNetAdded1),
            ('minSqrtPriceX96',plan.minSqrtPriceX96),('maxSqrtPriceX96',plan.maxSqrtPriceX96)]
        if (plan.sequence!=admission.sequence or typed.action!=expected_action
                or any(getattr(a,name)!=value for name,value in pairs)
                or observation.policy.serviceFeeBps!=result['serviceFeeBps']):raise ValueError('v4_e1_plan_mismatch')
        if plan.swap.enabled:
            if (plan.swap.adapterId!=ADAPTER_ID or plan.swap.adapterVersion!=ADAPTER_VERSION
                    or plan.swap.routeCommitment!=route_commitment(typed.swap,plan.sequence.poolId)
                    or (typed.swap.currencyIn,typed.swap.amountIn,typed.swap.minAmountOut)!=(
                        plan.swap.currencyIn,plan.swap.amountInRaw,plan.swap.minAmountOutRaw)):
                raise ValueError('v4_e1_swap_commitment_mismatch')
        elif typed.swap.amountIn!='0':raise ValueError('v4_e1_swap_commitment_mismatch')
        by_lot={b.lotId:b for b in observation.balances}
        floors=defaultdict(lambda:[0,0])
        for allocation in plan.allocations:
            lot=by_lot[allocation.lotId];floors[(lot.source.digest(),lot.currency)][int(lot.convertedCharged)]+=int(allocation.amountRaw)
        caps={c.sourceId:int(c.maxGrossRaw) for c in plan.collections}
        accruals={c.source.digest():c for c in observation.accruals}
        expected={key:[*amounts,amounts[0],amounts[1]] for key,amounts in floors.items()}
        for sid,cap in caps.items():
            key=(sid,accruals[sid].source.currency);row=expected.setdefault(key,[0,0,0,0]);row[2]+=cap
        if typed.swap.amountIn!='0':
            output=seq_out=plan.swap.currencyOut
            expected.setdefault((typed.swap.sourceId,output),[0,0,0,0])
        actual={(b.sourceId,b.currency):[int(b.minOriginal),int(b.minCharged),int(b.maxOriginal),int(b.maxCharged)] for b in typed.budgets}
        if actual!=expected:raise ValueError('v4_e1_budget_authority_mismatch')
        incidental=tuple(c for c in result['collections'] if c.source not in caps)
        projected_credits=tuple(c for c in result['collections'] if c.source in caps)
        incidental_by_key=defaultdict(int)
        by_source={r['sourceId']:r['currency'] for r in result['sources'] if r['realizedRaw']!='0'}
        for credit in incidental:incidental_by_key[(credit.source,by_source[credit.source])]+=int(credit.amountRaw)
        meaningful={(b.source.digest(),b.currency) for b in observation.balances}
        meaningful.update((sid,accruals[sid].source.currency) for sid in caps)
        for c in result['conversions']:meaningful.update(((c['sourceId'],c['currencyIn']),(c['sourceId'],c['currencyOut'])))
        balances=[]
        for r in result['sources']:
            key=(r['sourceId'],r['currency'])
            if key not in meaningful:
                if any(int(r[name]) for name in ('grossOriginalConsumedRaw','chargedConsumedRaw','liquidityAddedRaw','swapInRaw','swapOutRaw')):
                    raise ValueError('v4_incidental_consumed')
                continue
            after=int(r['originalAfterRaw'])-incidental_by_key[key]
            if after<0:raise ValueError('v4_incidental_consumed')
            balances.append({'sourceId':r['sourceId'],'currency':r['currency'],'originalBeforeRaw':r['originalBeforeRaw'],
                'chargedBeforeRaw':r['chargedBeforeRaw'],'grossOriginalRaw':r['grossOriginalConsumedRaw'],
                'chargedInputRaw':r['chargedConsumedRaw'],'serviceFeeRaw':r['serviceFeeRaw'],
                'liquidityFromInputRaw':str(int(r['liquidityAddedRaw'])-int(r['liquidityFromSwapRaw'])),
                'liquidityFromSwapRaw':r['liquidityFromSwapRaw'],'swapInRaw':r['swapInRaw'],'swapOutRaw':r['swapOutRaw'],
                'originalAfterRaw':str(after),'chargedAfterRaw':r['chargedAfterRaw']})
        # Uninvolved observed sources remain part of the exact E1 ledger. Pinned
        # engine has no callback capable of changing them without a source event.
        present={(r['sourceId'],r['currency']) for r in balances}
        totals=defaultdict(lambda:[0,0])
        for b in observation.balances:totals[(b.source.digest(),b.currency)][int(b.convertedCharged)]+=int(b.amountRaw)
        for key,(original,charged) in totals.items():
            if key in present:continue
            for at in ({'hash':plan.sourceBlockHash},result['block']):
                actual_balance=self._call(admission.sequence.vault,'feeBalance(bytes32,address)',['(uint128,uint128)'],at,
                    ['bytes32','address'],[bytes.fromhex(key[0][2:]),key[1]])[0]
                if actual_balance!=(original,charged):raise ValueError('v4_uninvolved_balance_changed')
            balances.append({'sourceId':key[0],'currency':key[1],'originalBeforeRaw':str(original),'chargedBeforeRaw':str(charged),
                'grossOriginalRaw':'0','chargedInputRaw':'0','serviceFeeRaw':'0','liquidityFromInputRaw':'0',
                'liquidityFromSwapRaw':'0','swapInRaw':'0','swapOutRaw':'0','originalAfterRaw':str(original),'chargedAfterRaw':str(charged)})
        swaps=[{'swapId':'0x'+keccak(encode(['bytes32','uint256'],[bytes.fromhex(result['transactionHash'][2:]),c['receiptLogIndex']])).hex(),
            'currencyIn':c['currencyIn'],'currencyOut':c['currencyOut'],'amountOutRaw':c['amountOutRaw'],
            'inputs':[{'sourceId':c['sourceId'],'amountInRaw':c['amountInRaw']}]} for c in result['conversions']]
        effects=PlanEffects.model_validate_json(json.dumps({'intentId':plan.intent_id(),'transactionHash':result['transactionHash'],
            'blockNumber':str(result['block']['number']),'blockHash':result['block']['hash'],
            'blockTimestamp':str(result['block']['timestamp']),'canonical':True,'serviceFeeRecipient':result['serviceFeeRecipient'],
            'destinationTokenId':result['destinationTokenId'],'tickLower':result['tickLower'],'tickUpper':result['tickUpper'],
            'liquidityIncrease':result['liquidityIncreaseRaw'],'collections':[c.model_dump(mode='json') for c in projected_credits],
            'balances':balances,'swaps':swaps}))
        projection=reconcile_plan_effects(plan,observation,effects,actor=actor)
        return {'effects':effects,'projection':projection,'incidentalCollections':incidental,
            'collectionAuthority':'incidental_credits_unspent_not_added_to_plan'}
