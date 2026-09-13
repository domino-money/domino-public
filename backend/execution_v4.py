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
BUDGET_TYPE = '(bytes32,address,uint128,uint128)'
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
    @model_validator(mode='after')
    def checked(self):
        if self.maxOriginal == self.maxCharged == '0':
            raise ValueError('empty_v4_budget')
        return self
    def values(self):
        return (bytes.fromhex(self.sourceId[2:]), self.currency, int(self.maxOriginal), int(self.maxCharged))

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
            if (self.sourceId != ZERO_ID or self.currencyIn != ZERO_ADDRESS or self.priceObservationId != ZERO_ID
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
