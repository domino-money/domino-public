"""Restricted operator signer. Rebuilds registered ABI; never signs caller bytes.

No listener, browser endpoint, wallet signer or production defaults. A signer
process owns its key, private DB role and RPC; the runner receives status only.
"""
from dataclasses import dataclass
import json
import time
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


class ExecutionError(ValueError):
    def __init__(self, code):
        # Codes only: never echo RPC errors, request data, paths or credentials.
        self.code = code
        super().__init__(code)


class ExecutionRpc:
    """Fixed configured endpoint, bounded replies and no redirects; no failover."""
    def __init__(self, endpoint, *, timeout=5, max_bytes=1048576):
        url = urlsplit(endpoint)
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', '::1')):
            raise ExecutionError('execution_rpc_configuration')
        if url.username or url.password or url.fragment or not 0 < timeout <= 10 or not 1024 <= max_bytes <= 1048576:
            raise ExecutionError('execution_rpc_configuration')
        self._endpoint, self.timeout, self.max_bytes = endpoint, timeout, max_bytes
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self._opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, params):
        allowed = {'eth_chainId','eth_getBlockByNumber','eth_getTransactionCount','eth_getCode','eth_call',
                   'eth_estimateGas','eth_getBalance','eth_sendRawTransaction','eth_getTransactionReceipt',
                   'eth_getTransactionByHash','eth_getLogs'}
        if method not in allowed:
            raise ExecutionError('execution_rpc_method')
        raw = json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}, allow_nan=False).encode()
        try:
            req = urllib.request.Request(self._endpoint, raw, {'Content-Type':'application/json'})
            with self._opener.open(req, timeout=self.timeout) as response:
                data = response.read(self.max_bytes+1)
            if len(data)>self.max_bytes:
                raise ValueError()
            reply=json.loads(data)
            if type(reply) is not dict or reply.get('id')!=1 or reply.get('jsonrpc')!='2.0' or 'error' in reply or 'result' not in reply:
                raise ValueError()
            return reply['result']
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
    def __init__(self, rpc, key, admission, policy):
        self.rpc=rpc
        self._account=Account.from_key(key)
        self.address=self._account.address.lower()
        self.admission=_model(g.CompoundAdmission,admission)
        self.policy=policy

    def qualify(self, plan, observation):
        if not self.policy.enabled:
            raise ExecutionError('execution_disabled')
        plan=_model(m.ExecutionPlan,plan); observation=_model(m.Observation,observation)
        if self.admission.sequence!=plan.sequence or self.address!=observation.operator or self.address==plan.sequence.owner:
            raise ExecutionError('execution_signer_identity')
        verifier=g.CompoundReceiptReconciler(self.rpc)
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

    def envelope(self, plan, nonce, *, fee=None, priority=None):
        compound, _ = self.qualify(plan['plan'],plan['observation'])
        p=_model(m.ExecutionPlan,plan['plan'])
        base=g._quantity(self.rpc.request('eth_getBlockByNumber',['latest',False]).get('baseFeePerGas'))
        fee=min(self.policy.max_fee_per_gas,2*base+self.policy.priority_fee_per_gas) if fee is None else fee
        priority=self.policy.priority_fee_per_gas if priority is None else priority
        if fee>self.policy.max_fee_per_gas or priority>fee or self.policy.max_gas*fee>min(self.policy.max_total_cost,int(p.maxGasCostWei)):
            raise ExecutionError('execution_gas_budget')
        if g._quantity(self.rpc.request('eth_getBalance',[self.address,'latest']))<self.policy.max_gas*fee:
            raise ExecutionError('execution_gas_balance')
        return {'chainId':4663,'nonce':nonce,'type':2,'to':p.sequence.vault,'value':0,
                'data':compound.calldata(),'gas':self.policy.max_gas,'maxFeePerGas':fee,
                'maxPriorityFeePerGas':priority,'accessList':[]}

    def sign(self, record, envelope):
        # The key boundary independently rebuilds even if its caller hands it an
        # internally consistent transaction. There is no raw-envelope authority.
        expected=self.envelope(record,envelope['nonce'],fee=envelope['maxFeePerGas'],priority=envelope['maxPriorityFeePerGas'])
        if envelope!=expected:
            raise ExecutionError('execution_envelope_changed')
        from eth_utils import to_checksum_address
        signed=self._account.sign_transaction({**envelope,'to':to_checksum_address(envelope['to'])})
        raw=bytes(signed.raw_transaction)
        digest='0x'+keccak(raw).hex()
        verify_signed(raw,envelope,self.address,digest)
        return raw,digest


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
