"""Restricted operator signer. Rebuilds registered ABI; never signs caller bytes.

No listener, browser endpoint, wallet signer or production defaults. A signer
process owns its key, private DB role and RPC; the runner receives status only.
"""
from dataclasses import dataclass
import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_hash.auto import keccak
from hexbytes import HexBytes
from eth_abi import encode

import execution_models as m
import general_compound_receipts as g
from execution_store import _model
from read_deadline import check_read_deadline, read_timeout
from bridge_state import strict_json


class ExecutionError(ValueError):
    def __init__(self, code):
        # Codes only: never echo RPC errors, request data, paths or credentials.
        self.code = code
        super().__init__(code)


class ExecutionRpc:
    """Fixed configured endpoint, bounded replies and no redirects; no failover."""
    def __init__(self, endpoint, *, timeout=5, max_bytes=1048576):
        if type(endpoint) is not str or not 1<=len(endpoint)<=2048 or any(ord(c)<33 or ord(c)>126 for c in endpoint):
            raise ExecutionError('execution_rpc_configuration')
        url = urlsplit(endpoint)
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', '::1')):
            raise ExecutionError('execution_rpc_configuration')
        if (not url.hostname or url.username or url.password or url.fragment or '\\' in endpoint
                or type(timeout) not in (int,float) or not 0 < timeout <= 10
                or type(max_bytes) is not int or not 1024 <= max_bytes <= 1048576):
            raise ExecutionError('execution_rpc_configuration')
        self._endpoint, self.timeout, self.max_bytes = endpoint, timeout, max_bytes
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())

    def request(self, method, params):
        allowed = {'eth_chainId','eth_getBlockByNumber','eth_getTransactionCount','eth_getCode','eth_call',
                   'eth_estimateGas','eth_getBalance','eth_sendRawTransaction','eth_getTransactionReceipt',
                   'eth_getTransactionByHash','eth_getLogs'}
        if method not in allowed:
            raise ExecutionError('execution_rpc_method')
        raw = json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}, allow_nan=False).encode()
        try:
            check_read_deadline()
            req = urllib.request.Request(self._endpoint, raw, {'Content-Type':'application/json'})
            with self._opener.open(req, timeout=read_timeout(self.timeout)) as response:
                data = response.read(self.max_bytes+1)
            check_read_deadline()
            if len(data)>self.max_bytes:
                raise ValueError()
            reply=strict_json(data)
            if type(reply) is not dict or set(reply)!={'jsonrpc','id','result'} or type(reply.get('id')) is not int or reply['id']!=1 or reply.get('jsonrpc')!='2.0':
                raise ValueError()
            return reply['result']
        except urllib.error.HTTPError as error:
            error.close()
            raise ExecutionError('execution_rpc_unavailable') from None
        except Exception:
            raise ExecutionError('execution_rpc_unavailable') from None


@dataclass(frozen=True)
class SignerPolicy:
    # Explicit operator configuration, not universal deployment defaults.
    max_gas: int
    max_fee_per_gas: int
    priority_fee_per_gas: int
    max_total_cost: int
    max_replacements: int = 2
    bump_bps: int = 1250
    enabled: bool = False

    def __post_init__(self):
        if (any(type(v) is not int or not 0<v<2**128 for v in
                (self.max_gas,self.max_fee_per_gas,self.priority_fee_per_gas,self.max_total_cost))
                or self.priority_fee_per_gas>self.max_fee_per_gas
                or type(self.max_replacements) is not int or not 0<=self.max_replacements<=3
                or type(self.bump_bps) is not int or not 1000<=self.bump_bps<=10000 or type(self.enabled) is not bool):
            raise ExecutionError('execution_signer_policy')


def rebuild_compound(plan, observation, checkpoint):
    """Closed registry v3: only no-swap same-NFT general compound is registered."""
    plan=_model(m.ExecutionPlan,plan); observation=_model(m.Observation,observation)
    if plan.action!=1 or plan.path!=0 or plan.swap.enabled:
        raise ExecutionError('execution_action_not_registered')
    member=next(p.position for p in observation.positions if p.position.tokenId==plan.destination.tokenId)
    if any(a.checkpointId!=checkpoint for a in observation.accruals if a.source.position==member.digest()):
        raise ExecutionError('execution_checkpoint_mismatch')
    return g.CompoundPlan(intentId=plan.intent_id(),tokenId=plan.destination.tokenId,
        positionIdentity=member.digest(),checkpointId=checkpoint,
        policyVersion=plan.expectedPolicyVersion,limitsVersion=observation.policy.limits.version,
        stateNonce=plan.expectedStateNonce,authorityGeneration=plan.expectedAuthorityGeneration,
        observedAtBlock=plan.sourceBlockNumber,observedBlockHash=plan.sourceBlockHash,
        observedAtTimestamp=observation.blockTimestamp,deadline=plan.deadline,liquidityIncrease=plan.liquidityIncrease,
        maxOriginal0=plan.maxGrossFee0,maxOriginal1=plan.maxGrossFee1,
        maxCharged0=plan.maxChargedInput0,maxCharged1=plan.maxChargedInput1,
        minAdded0=plan.minNetAdded0,minAdded1=plan.minNetAdded1,
        minSqrtPriceX96=plan.minSqrtPriceX96,maxSqrtPriceX96=plan.maxSqrtPriceX96)


class RestrictedSigner:
    def __init__(self, rpc, key, admission, policy, *, price_observation_id=m.ZERO_HASH, gas_budget=None):
        self.rpc=rpc
        self._account=Account.from_key(key)
        self.address=self._account.address.lower()
        raw=admission.model_dump(mode='json') if hasattr(admission,'model_dump') else admission
        if type(raw) is not dict or type(raw.get('sequence')) is not dict:
            raise ExecutionError('execution_admission_invalid')
        version=raw['sequence'].get('implementationVersion')
        if version=='4':
            from execution_v4 import Admission
            self.admission=_model(Admission,raw)
            if self.admission.pricePublisher==self.address:raise ExecutionError('execution_price_publisher_not_independent')
        else:self.admission=_model(g.CompoundAdmission,raw)
        self.action='typed_fee_execution_v4' if version=='4' else 'compound_self_general_v3'
        if version!='4' and price_observation_id!=m.ZERO_HASH:raise ExecutionError('execution_unexpected_price_observation')
        # A V4 signer without an observation can sign nothing: the engine
        # refuses every action that does not carry one.
        if version=='4' and price_observation_id==m.ZERO_HASH:
            raise ExecutionError('execution_price_observation_required')
        self.price_observation_id=price_observation_id
        self.policy=policy
        self.gas_budget=gas_budget

    def verifier(self):
        if self.action=='typed_fee_execution_v4':
            from execution_v4 import ReceiptReconciler
            return ReceiptReconciler(self.rpc)
        return g.CompoundReceiptReconciler(self.rpc)

    def qualify(self, plan, observation):
        if not self.policy.enabled:
            raise ExecutionError('execution_disabled')
        plan=_model(m.ExecutionPlan,plan); observation=_model(m.Observation,observation)
        if self.admission.sequence!=plan.sequence or self.address!=observation.operator or self.address==plan.sequence.owner:
            raise ExecutionError('execution_signer_identity')
        verifier=self.verifier()
        if g._quantity(verifier._request('eth_chainId'))!=4663:
            raise ExecutionError('execution_wrong_chain')
        head,_=verifier._block('latest')
        source,_=verifier._block(int(plan.sourceBlockNumber))
        if head['number']<=source['number']:
            raise ExecutionError('execution_observation_block_pending')
        if source['hash']!=plan.sourceBlockHash or source['timestamp']!=int(observation.blockTimestamp):
            raise ExecutionError('execution_source_reorg')
        m.validate_candidate(plan,observation,now=head['timestamp'],actor=self.address)
        verifier._identity(self.admission,head)
        vault=plan.sequence.vault
        for signature,expected in [('stateNonce()',int(plan.expectedStateNonce)),
                ('authorityGeneration()',int(plan.expectedAuthorityGeneration))]:
            if verifier._call(vault,signature,['uint64'],head)[0]!=expected:
                raise ExecutionError('execution_authority_changed')
        if verifier._call(vault,'operator()',['address'],head)[0]!=self.address or not verifier._call(vault,'rootPermissionValid()',['bool'],head)[0]:
            raise ExecutionError('execution_authority_changed')
        actual=verifier._call(vault,'policy()',['(uint16,uint16,uint16,uint32,uint8,uint64,bool)'],head)[0]
        p=observation.policy
        if actual!=(p.serviceFeeBps,p.triggerDistanceBps,p.maxOverlapBps,p.minimumIntervalSeconds,p.maxPositions,int(p.version),p.paused):
            raise ExecutionError('execution_policy_changed')
        actual=verifier._call(vault,'executionLimits()',['(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'],head)[0]
        lim=p.limits
        if actual!=(int(lim.version),lim.upsideBps,lim.maxSlippageBps,lim.maxPriceImpactBps,int(lim.maxGasCostWei),lim.maxObservationAgeSeconds,lim.forecastHorizonSeconds):
            raise ExecutionError('execution_policy_changed')
        if self.action=='typed_fee_execution_v4':
            from execution_v4_adapter import rebuild_v4,selected_positions,qualify_price
            members={p.position.tokenId:p for p in observation.positions}
            checkpoints={}
            for token in selected_positions(plan,observation):
                actual=verifier._call(vault,'position(uint256)',[g.POSITION_TYPE],source,['uint256'],[int(token)])[0]
                member=members[token].position
                if actual[:8]!=(True,members[token].active,member.isRoot,int(member.parentTokenId),int(member.generation),
                        member.tickLower,member.tickUpper,bytes.fromhex(member.registrationBaselineId[2:])) or '0x'+actual[8].hex()!=member.digest():
                    raise ExecutionError('execution_position_identity_changed')
                point=verifier._call(vault,'checkpoint(uint256)',[g.CHECKPOINT_TYPE],source,['uint256'],[int(token)])[0]
                checkpoints[token]='0x'+point[6].hex()
            # The anchor binds every action on chain, so it is required and
            # qualified for every action here, not only for a conversion.
            compound=rebuild_v4(plan,observation,checkpoints,price_observation_id=self.price_observation_id)
            qualify_price(verifier,self.admission,plan,observation,head,self.price_observation_id)
        else:
            checkpoint=verifier._call(vault,'checkpoint(uint256)',[g.CHECKPOINT_TYPE],source,['uint256'],[int(plan.destination.tokenId)])[0]
            compound=rebuild_compound(plan,observation,'0x'+checkpoint[6].hex())
        call={'from':self.address,'to':vault,'data':compound.calldata(),'value':'0x0','gas':hex(self.policy.max_gas)}
        # Exact typed call at a hash-pinned current block proves the actual vault
        # accepts custody, fee-only caps, recipient, versions and price guards.
        g._hex(verifier._request('eth_call',[call,{'blockHash':head['hash'],'requireCanonical':True}]))
        estimated=g._quantity(verifier._request('eth_estimateGas',[call,hex(head['number'])]))
        if estimated>self.policy.max_gas:
            raise ExecutionError('execution_gas_budget')
        # A final canonical check catches head changes during the bounded probe.
        again,_=verifier._block(head['number'])
        if again!=head:
            raise ExecutionError('execution_source_reorg')
        return compound,head

    def envelope(self, plan, nonce, *, fee=None, priority=None, existing_signed=False):
        compound, _ = self.qualify(plan['plan'],plan['observation'])
        p=_model(m.ExecutionPlan,plan['plan'])
        base=g._quantity(self.rpc.request('eth_getBlockByNumber',['latest',False]).get('baseFeePerGas'))
        fee=min(self.policy.max_fee_per_gas,2*base+self.policy.priority_fee_per_gas) if fee is None else fee
        priority=self.policy.priority_fee_per_gas if priority is None else priority
        if fee>self.policy.max_fee_per_gas or priority>fee or self.policy.max_gas*fee>min(self.policy.max_total_cost,int(p.maxGasCostWei)):
            raise ExecutionError('execution_gas_budget')
        if self.action=='typed_fee_execution_v4':
            if self.gas_budget is None:
                raise ExecutionError('execution_gas_reservation_required')
            try:
                if not existing_signed:
                    # A replacement may raise the fee ceiling. Re-price the
                    # same claim atomically under the shared daily cap before
                    # the new envelope can cross the key boundary.
                    self.gas_budget.reserve_one(p.intent_id(),'operator',
                        self.address,self.policy.max_gas*fee)
                require = (self.gas_budget.require_existing_reservation if existing_signed
                           else self.gas_budget.require_reservation)
                require(p.intent_id(),'operator',self.address,self.policy.max_gas*fee)
            except Exception:
                raise ExecutionError('execution_gas_reservation_required') from None
        if g._quantity(self.rpc.request('eth_getBalance',[self.address,'latest']))<self.policy.max_gas*fee:
            raise ExecutionError('execution_gas_balance')
        return {'chainId':4663,'nonce':nonce,'type':2,'to':p.sequence.vault,'value':0,
                'data':compound.calldata(),'gas':self.policy.max_gas,'maxFeePerGas':fee,
                'maxPriorityFeePerGas':priority,'accessList':[]}

    def sign(self, record, envelope):
        # The key boundary independently rebuilds even if its caller hands it an
        # internally consistent transaction. There is no raw-envelope authority.
        self.assert_envelope(record,envelope)
        from eth_utils import to_checksum_address
        signed=self._account.sign_transaction({**envelope,'to':to_checksum_address(envelope['to'])})
        raw=bytes(signed.raw_transaction)
        digest='0x'+keccak(raw).hex()
        verify_signed(raw,envelope,self.address,digest)
        return raw,digest

    def assert_envelope(self,record,envelope,*,existing_signed=False):
        expected=self.envelope(record,envelope['nonce'],fee=envelope['maxFeePerGas'],
            priority=envelope['maxPriorityFeePerGas'],existing_signed=existing_signed)
        if envelope!=expected:raise ExecutionError('execution_envelope_changed')


def verify_signed(raw,envelope,signer,digest):
    """Independent pre-broadcast byte/identity boundary, including every field."""
    try:
        decoded=TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        normalized={**envelope,'to':bytes.fromhex(envelope['to'][2:]),'data':bytes.fromhex(envelope['data'][2:]),'accessList':()}
        if (Account.recover_transaction(raw).lower()!=signer or '0x'+keccak(raw).hex()!=digest or
                any(decoded.get(k)!=v for k,v in normalized.items()) or
                set(decoded)!=set(normalized)|{'v','r','s'} or envelope['type']!=2 or
                envelope['chainId']!=4663 or envelope['value']!=0):
            raise ValueError()
    except Exception:
        raise ExecutionError('execution_signature_mismatch') from None
