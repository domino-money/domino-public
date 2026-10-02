"""The wire formats the V2 operator sends: the vault's PlanV1, the auto-exit's
Execution and a closed vault's returnReserves.

IDominoVaultExecution.execute takes `plan = 0x01 ‖ abi.encode(PlanV1)`: one
version byte, then the ABI encoding of the one-element parameter list
(contracts/src/v2/vault/DominoV2VaultPlan.sol, docs/v2/F3_VAULT.md, "The
execution plan (version 1)"). F3's suite pins a golden vector that this module
reproduces byte for byte (tests/test_v2_plan.py).

IDominoAutoExit.execute takes `(bytes32 mandateHash, Execution)`, with
Execution = (bytes anchorEvidence, SwapLeg[] legs, uint128 amount0MinRemoved,
uint128 amount1MinRemoved); its calldata is built from the frozen ABI export
(v2_abi), never re-declared here.

IDominoVaultLedger.returnReserves() takes nothing and returns (amount0,
amount1), what it paid the owner; its calldata and result come from the same
export. It has no plan to hash, so its journal subject (return_subject) names
the vault, the state nonce and the pass's block instead.

Anchor evidence (docs/v2/F1_REGISTRY_ANCHOR.md): exactly 32 bytes is
abi.encode(uint32 secondsAgo), a v3 TWAP window; anything else is
abi.encode(PriceObservation, bytes signature) (v2_observation).

Nothing here reads a chain or signs: these are pure encoders, decoders and
the plan hash the vault returns and emits.
"""
from dataclasses import dataclass, field

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError, address
from v2_abi import function

VERSION_1 = 1
ACTION_COMPOUND, ACTION_MINT = 1, 2
# DominoV2Types.LEG_*: an admitted Universal Router call, a v3 path, a v4 path.
LEG_UNIVERSAL_ROUTER, LEG_V3_POOL, LEG_V4_POOL = 1, 2, 3
U64, U128, U256 = 2**64 - 1, 2**128 - 1, 2**256 - 1
MIN_TICK, MAX_TICK = -887272, 887272
# DominoSwapExecutor.MAX_LEGS: the executor refuses more.
MAX_LEGS = 8
ZERO = '0x' + '00' * 20

SWAP_LEG_TYPE = '(uint8,address,address,address,uint128,uint128,bytes)'
BUDGET_TYPE = '(uint256,uint128,uint128)'
SWAP_TYPE = f'(uint256,bool,uint128,uint128,{SWAP_LEG_TYPE}[])'
# docs/v2/F3_VAULT.md, as eth_abi writes it.
PLAN_V1_TYPE = (f'(uint8,uint64,uint64,uint256,int24,int24,uint128,uint128,uint128,uint256[],'
                f'{BUDGET_TYPE}[],{SWAP_TYPE},bytes)')
POOL_REF_TYPE = '(uint8,address,address,uint24,int24,address)'


def _uint(value, bound):
    return type(value) is int and 0 <= value <= bound


@dataclass(frozen=True)
class SwapLeg:
    """DominoV2Types.SwapLeg. `data` is router calldata (kind 1), a v3 path
    (kind 2) or abi.encode(PoolRef[]) (kind 3)."""
    kind: int
    router: str
    token_in: str
    token_out: str
    amount_in: int
    min_amount_out: int
    data: bytes

    def __post_init__(self):
        for name in ('router', 'token_in', 'token_out'):
            object.__setattr__(self, name, address(getattr(self, name)))
        if (type(self.kind) is not int or self.kind not in (LEG_UNIVERSAL_ROUTER, LEG_V3_POOL, LEG_V4_POOL)
                or not _uint(self.amount_in, U128) or not _uint(self.min_amount_out, U128)
                or type(self.data) is not bytes or self.token_in == self.token_out
                or (self.kind != LEG_UNIVERSAL_ROUTER) != (self.router == ZERO)):
            raise DataError('v2_invalid_swap_leg')

    def as_tuple(self):
        return (self.kind, self.router, self.token_in, self.token_out, self.amount_in, self.min_amount_out,
                self.data)


@dataclass(frozen=True)
class Budget:
    """A member whose balances fund the execution, with the most it may be
    debited per pool token, the tariff included."""
    token_id: int
    max0: int
    max1: int

    def __post_init__(self):
        if not _uint(self.token_id, U256) or not _uint(self.max0, U128) or not _uint(self.max1, U128):
            raise DataError('v2_invalid_budget')


@dataclass(frozen=True)
class Swap:
    """One direction from one source; no swap is the all-zero value."""
    source: int = 0
    zero_for_one: bool = False
    amount_in: int = 0
    min_amount_out: int = 0
    legs: tuple = ()

    def __post_init__(self):
        object.__setattr__(self, 'legs', tuple(self.legs))
        if (not _uint(self.source, U256) or type(self.zero_for_one) is not bool
                or not _uint(self.amount_in, U128) or not _uint(self.min_amount_out, U128)
                or len(self.legs) > MAX_LEGS or any(not isinstance(leg, SwapLeg) for leg in self.legs)):
            raise DataError('v2_invalid_swap')

    @property
    def empty(self):
        return not self.legs


@dataclass(frozen=True)
class PlanV1:
    """DominoV2VaultPlan.PlanV1 (docs/v2/F3_VAULT.md, field by field)."""
    action: int
    state_nonce: int
    deadline: int
    target: int
    amount0_max: int
    amount1_max: int
    min_liquidity: int
    collect: tuple
    budgets: tuple
    anchor_evidence: bytes
    swap: Swap = field(default_factory=Swap)
    tick_lower: int = 0
    tick_upper: int = 0

    def __post_init__(self):
        object.__setattr__(self, 'collect', tuple(self.collect))
        object.__setattr__(self, 'budgets', tuple(self.budgets))
        if (type(self.action) is not int or self.action not in (ACTION_COMPOUND, ACTION_MINT)
                or not _uint(self.state_nonce, U64) or not _uint(self.deadline, U64)
                or not _uint(self.target, U256)
                or type(self.tick_lower) is not int or not MIN_TICK <= self.tick_lower <= MAX_TICK
                or type(self.tick_upper) is not int or not MIN_TICK <= self.tick_upper <= MAX_TICK
                or not _uint(self.amount0_max, U128) or not _uint(self.amount1_max, U128)
                or not _uint(self.min_liquidity, U128)
                or any(not _uint(token, U256) for token in self.collect)
                or any(not isinstance(budget, Budget) for budget in self.budgets)
                or not isinstance(self.swap, Swap) or type(self.anchor_evidence) is not bytes):
            raise DataError('v2_invalid_plan')

    def as_tuple(self):
        return (self.action, self.state_nonce, self.deadline, self.target, self.tick_lower, self.tick_upper,
                self.amount0_max, self.amount1_max, self.min_liquidity, list(self.collect),
                [(b.token_id, b.max0, b.max1) for b in self.budgets],
                (self.swap.source, self.swap.zero_for_one, self.swap.amount_in, self.swap.min_amount_out,
                 [leg.as_tuple() for leg in self.swap.legs]),
                self.anchor_evidence)

    def encode(self):
        """`0x01 ‖ abi.encode(PlanV1)`: what execute(bytes) takes."""
        return bytes([VERSION_1]) + encode([PLAN_V1_TYPE], [self.as_tuple()])


def _address(raw):
    return raw.lower()


def decode_plan(raw):
    """The PlanV1 a vault would decode, or v2_invalid_plan. Version 1 only."""
    if type(raw) is not bytes or not raw or raw[0] != VERSION_1:
        raise DataError('v2_invalid_plan')
    try:
        (value,) = decode([PLAN_V1_TYPE], raw[1:])
    except Exception:
        raise DataError('v2_invalid_plan') from None
    (action, nonce, deadline, target, lower, upper, max0, max1, min_liquidity, collect, budgets, swap,
     evidence) = value
    source, zero_for_one, amount_in, min_out, legs = swap
    plan = PlanV1(action, nonce, deadline, target, max0, max1, min_liquidity, tuple(collect),
                  tuple(Budget(*budget) for budget in budgets), bytes(evidence),
                  Swap(source, zero_for_one, amount_in, min_out,
                       tuple(SwapLeg(leg[0], _address(leg[1]), _address(leg[2]), _address(leg[3]), leg[4],
                                     leg[5], bytes(leg[6])) for leg in legs)),
                  lower, upper)
    # Canonical bytes only: a body with trailing data or a non-standard offset
    # decodes to the same value but is not what this module would send.
    if plan.encode() != raw:
        raise DataError('v2_invalid_plan')
    return plan


def plan_hash(chain_id, vault, plan_bytes):
    """keccak256(abi.encodePacked(uint256 chainId, address vault, bytes plan)): the
    vault's return value, Executed's topic and FeeCharged's ref."""
    if not _uint(chain_id, U256) or type(plan_bytes) is not bytes:
        raise DataError('v2_invalid_plan')
    return '0x' + keccak(chain_id.to_bytes(32, 'big') + bytes.fromhex(address(vault)[2:]) + plan_bytes).hex()


def execute_calldata(plan_bytes):
    """IDominoVaultExecution.execute(bytes) calldata."""
    return function('IDominoVaultExecution', 'execute').calldata(plan_bytes)


# --------------------------------------------------------------- evidence
def twap_evidence(seconds_ago):
    """abi.encode(uint32 secondsAgo): a v3 TWAP window, exactly 32 bytes."""
    if not _uint(seconds_ago, 2**32 - 1) or seconds_ago == 0:
        raise DataError('v2_invalid_twap_window')
    return encode(['uint32'], [seconds_ago])


def v3_path(token_in, fee, token_out):
    """A one-hop v3 path: token ‖ uint24 fee ‖ token, as the executor reads it."""
    if not _uint(fee, 2**24 - 1):
        raise DataError('v2_invalid_swap_leg')
    return bytes.fromhex(address(token_in)[2:]) + fee.to_bytes(3, 'big') + bytes.fromhex(address(token_out)[2:])


def v4_path(pools):
    """abi.encode(PoolRef[]) for a v4 pool leg; `pools` are v2_uniswap.PoolRef."""
    return encode([POOL_REF_TYPE + '[]'], [[(p.dex, p.currency0, p.currency1, p.fee, p.tick_spacing, p.hooks)
                                             for p in pools]])


def pool_leg(pool, zero_for_one, amount_in, min_amount_out):
    """One leg through `pool` itself: a v3 single-hop path or a one-pool v4 path."""
    token_in, token_out = ((pool.currency0, pool.currency1) if zero_for_one else (pool.currency1, pool.currency0))
    if pool.dex == 3:
        return SwapLeg(LEG_V3_POOL, ZERO, token_in, token_out, amount_in, min_amount_out,
                       v3_path(token_in, pool.fee, token_out))
    if pool.dex == 4:
        return SwapLeg(LEG_V4_POOL, ZERO, token_in, token_out, amount_in, min_amount_out, v4_path([pool]))
    raise DataError('v2_invalid_pool_ref')


# --------------------------------------------------------------- auto-exit
@dataclass(frozen=True)
class ExitExecution:
    """IDominoAutoExit.Execution. A pool leg with amount_in 0 converts what
    remains of the withdrawal (filled in by the module); router legs need an
    exact amount (docs/v2/F4_AUTO_EXIT.md, "Conversion")."""
    anchor_evidence: bytes
    legs: tuple = ()
    amount0_min_removed: int = 0
    amount1_min_removed: int = 0

    def __post_init__(self):
        object.__setattr__(self, 'legs', tuple(self.legs))
        if (type(self.anchor_evidence) is not bytes or len(self.legs) > MAX_LEGS
                or any(not isinstance(leg, SwapLeg) for leg in self.legs)
                or not _uint(self.amount0_min_removed, U128) or not _uint(self.amount1_min_removed, U128)):
            raise DataError('v2_invalid_exit_execution')

    def as_tuple(self):
        return (self.anchor_evidence, [leg.as_tuple() for leg in self.legs], self.amount0_min_removed,
                self.amount1_min_removed)


def exit_calldata(mandate_hash, execution):
    """IDominoAutoExit.execute(bytes32, Execution) calldata, from the frozen export."""
    if type(mandate_hash) is not str or len(mandate_hash) != 66 or not isinstance(execution, ExitExecution):
        raise DataError('v2_invalid_exit_execution')
    return function('IDominoAutoExit', 'execute').calldata(bytes.fromhex(mandate_hash[2:]), execution.as_tuple())


# ------------------------------------------------------------ returnReserves
def return_reserves_calldata():
    """IDominoVaultLedger.returnReserves() calldata, from the frozen export."""
    return function('IDominoVaultLedger', 'returnReserves').calldata()


def returned_amounts(raw):
    """(amount0, amount1) a returnReserves call paid the owner, from its raw result."""
    return tuple(function('IDominoVaultLedger', 'returnReserves').decode(raw))


def return_subject(chain_id, vault, state_nonce, block_number):
    """A returnReserves intent's journal subject: keccak256(abi.encode(uint256
    chainId, address vault, uint64 stateNonce, uint256 block)). The calldata is
    the same on every pass, so the pass's block keeps each pass's call its own
    intent; whether one is due at all is the presimulation's answer."""
    if not _uint(chain_id, U256) or not _uint(state_nonce, U64) or not _uint(block_number, U256):
        raise DataError('v2_invalid_return')
    return '0x' + keccak(encode(['uint256', 'address', 'uint64', 'uint256'],
                                [chain_id, address(vault), state_nonce, block_number])).hex()
