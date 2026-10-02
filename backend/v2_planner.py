"""The V2 compound planner: pure, deterministic, integer-exact.

Given what the service read at one pinned block (a vault's ledger, its
positions, its pool, the anchor price, native prices of both pool tokens and
the chain's gas quote), it decides whether compounding now is worth it and
builds the plan the vault will accept (v2_plan.PlanV1). It reads no chain,
signs nothing and has no clock: every input is an argument.

The vault's own rules (docs/v2/F3_VAULT.md, contracts/src/v2/vault) are
reproduced with the contract's integer arithmetic, so a plan this module
builds is one the vault's checks accept at the planning block:
- the tariff (200 / 400 bps) is cut once per source and token from the
  uncharged gross consumed, rounded down for the owner; charged units (swap
  output) are spent first and never charged again (DominoV2VaultMath);
- a swap spends exactly amountIn of one source's input token, its floor is
  DominoSwapFloor.minimumOutput at the ANCHOR, less the pool's whole fee and
  the owner's maxSlippageBps, and its output must fund the add (A5: at most
  1/100 of it may stay), so the planner sizes the swap to leave the OUTPUT
  token the scarce side even if the price at the add moves by the tolerance;
- the add is amount-driven (A2): the budgets' capacities, liquidity sized at
  the price as LiquidityAmounts does, and a liquidity floor below it.

The economics are in native wei, USD-free: both pool tokens are valued
through on-chain prices (the vault's own pool at the anchor, and reference
pools to the wrapped native token; V1's #253 lesson: a token without a
reference is valued through the other pool token). Two independent gates
(REINVESTMENT_POLICY.md):
- execution sustainability: the tariff the compound earns covers its gas,
  the L1 data fee included, with the approved 15% buffer. The gas is the
  measured cost (presimulation), never a configured worst case (V1 priced
  gas at about twice the real cost, #282);
- owner benefit: the added liquidity's incremental fee earnings over a bounded
  horizon, from the pool's time-weighted fee growth inside the range over a
  window (V1's #254 lesson: the mean, not the quietest interval), less a
  haircut, cover the tariff and the swap's pool cost. Missing evidence never
  justifies an action.
Among the candidates that pass both (direct, or a balancing swap of the whole
or half of the excess), the one with the greatest net owner outcome wins
("Prefer the greatest net productive reinvestment"); there is no fixed idle
reserve.
"""
from dataclasses import dataclass, replace
from fractions import Fraction

from discovery import DataError
from v2_plan import ACTION_COMPOUND, U128, Budget, PlanV1, Swap, pool_leg
from v2_uniswap import PoolRef
from v4_math import MAX_SQRT, MIN_SQRT, Q96, Q128, amount_delta, sqrt_at_tick, swap_step

BPS = 10_000
PIPS = 1_000_000
U256 = 2**256 - 1
MODE_SIMPLE, MODE_DOMINO = 1, 2
TARIFF_BPS = {MODE_SIMPLE: 200, MODE_DOMINO: 400}
# DominoV2VaultExecutor.SWAP_LEFTOVER_DIVISOR.
SWAP_LEFTOVER_DIVISOR = 100


def mul_div(a, b, d):
    """FullMath.mulDiv for non-negative operands: floor(a * b / d)."""
    if a < 0 or b < 0 or d <= 0:
        raise DataError('v2_planner_math')
    return a * b // d


# ---------------------------------------------------------------- tariff
def fee_of(amount, bps):
    """DominoFeeRules.feeOf: rounded down, for the owner."""
    return amount * bps // BPS


def net_of(gross, bps):
    """DominoV2VaultMath.netOf."""
    return gross - fee_of(gross, bps)


def gross_for(prior, net, bps):
    """DominoV2VaultMath.grossFor: the least cumulative gross whose net is netOf(prior) + net."""
    if net == 0:
        return prior
    target = net_of(prior, bps) + net
    return (target - 1) * BPS // (BPS - bps) + 1


@dataclass
class Budgeted:
    """One source's lots in one token during an execution, as the executor spends them."""
    charged: int
    uncharged: int
    cap: int
    bps: int
    gross: int = 0  # cumulative uncharged gross taken in this execution
    fee: int = 0

    def capacity(self):
        charged = min(self.charged, self.cap)
        gross = min(self.uncharged, self.cap - charged)
        return charged + net_of(self.gross + gross, self.bps) - net_of(self.gross, self.bps)

    def spend(self, want):
        """DominoV2VaultExecutor._spend: charged first, then uncharged gross."""
        provided = min(want, self.capacity())
        if provided == 0:
            return 0
        charged = min(self.charged, self.cap, provided)
        total = gross_for(self.gross, provided - charged, self.bps)
        gross = total - self.gross
        self.charged -= charged
        self.uncharged -= gross
        self.cap -= charged + gross
        self.gross = total
        self.fee += gross - (provided - charged)
        return provided


# ----------------------------------------------------------------- floor
def quote(amount_in, sqrt_price, zero_for_one):
    """DominoSwapFloor.quote: amountIn at the price, rounded down, on the contract's two branches."""
    if sqrt_price <= 0:
        raise DataError('v2_planner_math')
    if sqrt_price <= U128:
        ratio = sqrt_price * sqrt_price
        return mul_div(ratio, amount_in, 1 << 192) if zero_for_one else mul_div(1 << 192, amount_in, ratio)
    ratio = mul_div(sqrt_price, sqrt_price, 1 << 64)
    return mul_div(ratio, amount_in, 1 << 128) if zero_for_one else mul_div(1 << 128, amount_in, ratio)


def minimum_output(amount_in, sqrt_price, zero_for_one, fee_pips, slippage_bps):
    """DominoSwapFloor.minimumOutput: quote × (1 − fee) × (1 − slippage), one rounding, down."""
    if not 0 <= fee_pips < PIPS or not 0 <= slippage_bps < BPS:
        raise DataError('v2_planner_math')
    return mul_div(quote(amount_in, sqrt_price, zero_for_one), (PIPS - fee_pips) * (BPS - slippage_bps), PIPS * BPS)


# ------------------------------------------------------------- liquidity
def _liquidity0(a, b, amount0):
    a, b = min(a, b), max(a, b)
    return mul_div(amount0, mul_div(a, b, Q96), b - a)


def _liquidity1(a, b, amount1):
    a, b = min(a, b), max(a, b)
    return mul_div(amount1, Q96, b - a)


def liquidity_for_amounts(sqrt_price, tick_lower, tick_upper, amount0, amount1):
    """DominoPositionMath.liquidityForAmounts (LiquidityAmounts): rounded down."""
    if sqrt_price <= 0:
        raise DataError('v2_planner_math')
    a, b = sqrt_at_tick(tick_lower), sqrt_at_tick(tick_upper)
    if sqrt_price <= a:
        liquidity = _liquidity0(a, b, amount0)
    elif sqrt_price < b:
        liquidity = min(_liquidity0(sqrt_price, b, amount0), _liquidity1(a, sqrt_price, amount1))
    else:
        liquidity = _liquidity1(a, b, amount1)
    if liquidity > U128:
        raise DataError('v2_planner_math')
    return liquidity


def amounts_for_liquidity(sqrt_price, tick_lower, tick_upper, liquidity, round_up):
    """DominoPositionMath.amountsForLiquidity."""
    a, b = sqrt_at_tick(tick_lower), sqrt_at_tick(tick_upper)
    if liquidity == 0:
        return 0, 0
    if sqrt_price <= a:
        return amount_delta(a, b, liquidity, 0, round_up), 0
    if sqrt_price < b:
        return amount_delta(sqrt_price, b, liquidity, 0, round_up), amount_delta(a, sqrt_price, liquidity, 1, round_up)
    return 0, amount_delta(a, b, liquidity, 1, round_up)


def simulate_swap(sqrt_price, liquidity, fee_pips, zero_for_one, amount_in):
    """An exact-input swap that stays inside the active range: (price after, output).

    SwapMath.computeSwapStep against the price limit, the same for v3 and v4.
    A swap that would cross an initialized tick is not modelled; the
    presimulation of the whole plan is what proves a plan before it is sent.
    """
    if amount_in == 0 or liquidity == 0:
        return sqrt_price, 0
    target = MIN_SQRT + 1 if zero_for_one else MAX_SQRT - 1
    end, _, amount_out, _ = swap_step(sqrt_price, target, liquidity, -amount_in, fee_pips)
    return end, amount_out


# ----------------------------------------------------------- the quote seam
@dataclass(frozen=True)
class SwapQuote:
    """What a quoter answers for one exact-input swap: the output it expects,
    the leg that performs it (its minAmountOut is set by the planner, never
    below the vault's floor), and the vault pool's sqrt price after it, when
    the route crosses that pool (None: the route leaves it untouched)."""
    amount_out: int
    leg: object  # v2_plan.SwapLeg
    sqrt_price_after: int | None


class PoolQuoter:
    """The planner's quote seam, with one call: quote(chain, pool, token_in,
    amount_in) -> SwapQuote. This default prices one leg through the vault's
    own pool (a direct v3/v4 pool leg), in the pool's active range, from the
    state read at the planning block; it needs no RPC, so the planner stays
    pure. A quoter backed by on-chain quoters or Universal Router 2.1.2 routes
    (backend/v2_quotes.py, workstream 3c) can take its place through
    decide(quoter=...), with no other change to the planner."""

    def __init__(self, state):
        self.state = state  # PoolState: the vault pool at the planning block

    def quote(self, chain, pool, token_in, amount_in):
        state = self.state
        if pool != state.pool or token_in not in (pool.currency0, pool.currency1):
            raise DataError('v2_quote_unavailable')
        zero_for_one = token_in == pool.currency0
        fee = state.fee_pips[0 if zero_for_one else 1]
        after, out = simulate_swap(state.sqrt_price_x96, state.liquidity, fee, zero_for_one, amount_in)
        return SwapQuote(out, pool_leg(pool, zero_for_one, amount_in, max(out, 1)), after)


# ---------------------------------------------------------------- inputs
@dataclass(frozen=True)
class Policy:
    mode: int
    trigger_distance_bps: int
    max_overlap_bps: int
    minimum_interval_seconds: int
    max_positions: int


@dataclass(frozen=True)
class Limits:
    max_slippage_bps: int
    max_price_impact_bps: int
    max_observation_age_seconds: int
    upside_bps: int


@dataclass(frozen=True)
class MemberState:
    """A vault member at the block: IDominoVaultLedger.member and lot, and the
    position as its manager reports it (v2_uniswap.PositionState)."""
    token_id: int
    tick_lower: int
    tick_upper: int
    liquidity: int
    fees_owed: tuple  # what collect delivers now, per pool token
    lots: tuple  # ((uncharged0, charged0), (uncharged1, charged1))
    parent: int = 0
    successor: int = 0


@dataclass(frozen=True)
class PoolState:
    pool: PoolRef
    sqrt_price_x96: int  # the spot at the block
    liquidity: int  # active liquidity at the spot
    fee_pips: tuple  # (zeroForOne, oneForZero): the whole fee a swap pays, protocol included


@dataclass(frozen=True)
class VaultState:
    chain_id: int
    vault: str
    owner: str
    root_token_id: int
    members: tuple  # MemberState, active members only
    policy: Policy
    limits: Limits
    pool: PoolState
    state_nonce: int
    last_execution_at: int
    paused: bool
    root_armed: bool
    halted: bool
    swap_available: bool  # the implementation has a swap module
    block_number: int
    block_timestamp: int

    def member(self, token_id):
        return next(m for m in self.members if m.token_id == token_id)


@dataclass(frozen=True)
class PriceBook:
    """Native wei per raw unit of each pool token (Fractions), from on-chain prices."""
    wei_per_unit0: Fraction
    wei_per_unit1: Fraction

    def value(self, amount0, amount1):
        return self.wei_per_unit0 * amount0 + self.wei_per_unit1 * amount1


def price_book(pool, anchor_sqrt_price, references):
    """Both tokens in native wei. `references` maps a token to its wei per raw
    unit from a reference pool (the native token and its wrapper are 1). A
    token without one is valued through the vault's pool at the anchor
    (token1 per token0 = anchor²/2^192), the #253 lesson; neither: refused."""
    known = {token: Fraction(value) for token, value in references.items()}
    ratio = Fraction(anchor_sqrt_price * anchor_sqrt_price, 1 << 192)  # token1 per token0
    w0, w1 = known.get(pool.currency0), known.get(pool.currency1)
    if w0 is None and w1 is not None:
        w0 = w1 * ratio
    if w1 is None and w0 is not None:
        w1 = w0 / ratio
    if w0 is None or w1 is None or w0 <= 0 or w1 <= 0:
        raise DataError('v2_gas_price_source_missing')
    return PriceBook(w0, w1)


@dataclass(frozen=True)
class GasQuote:
    """The chain's cost of one execution: fee per gas (the base fee plus the
    tip the operator pays, with its buffer) and the L1 data fee where the
    stack charges it apart from gas (OP Stack); Nitro folds it into gas units."""
    fee_per_gas: int
    l1_fee_wei: int = 0

    def cost(self, units):
        return units * self.fee_per_gas + self.l1_fee_wei


@dataclass(frozen=True)
class FeeGrowth:
    """Fee growth inside a range per unit of liquidity (Q128) at two blocks: the
    pool's time-weighted fee rate over the window, for the owner gate."""
    inside0_start: int
    inside1_start: int
    start_timestamp: int
    inside0_end: int
    inside1_end: int
    end_timestamp: int

    def rate(self):
        """Per-second growth (Q128 per unit of liquidity), per token."""
        seconds = self.end_timestamp - self.start_timestamp
        if seconds <= 0:
            raise DataError('v2_earnings_window_invalid')
        return (Fraction((self.inside0_end - self.inside0_start) % (U256 + 1), seconds),
                Fraction((self.inside1_end - self.inside1_start) % (U256 + 1), seconds))


@dataclass(frozen=True)
class PlannerConfig:
    deadline_seconds: int = 120
    # The add's liquidity floor below what the planning price funds (A2: no zero-width window).
    liquidity_slack_bps: int = 100
    # The swap's minimum below the simulated output; never below the vault's floor.
    swap_quote_slippage_bps: int = 50
    # The output token stays the scarce side (A5) by this much of the add's
    # liquidity, even with the add's sqrt price moved against it by the tolerance.
    swap_margin_bps: int = 10
    swap_price_tolerance_bps: int = 20
    # On v3 the anchor is a TWAP that keeps moving: the floor is taken at an anchor this much higher.
    twap_drift_bps: int = 10
    # Swap only when the excess is worth at least this share of the fees consumed.
    min_swap_share_bps: int = 1000
    # Gas units before presimulation measures them; the gate is checked again with
    # the presimulated estimate before anything is signed. Measured on Base's
    # deployed v4 bytecode with a signed observation (tests/test_v2_automation_evm.py,
    # 2 Oct 2026): 414,777 used for a compound, 574,595 with one pool swap leg.
    # Nitro chains (Robinhood, Arbitrum) add the L1 component in gas units: tune per chain.
    gas_units_compound: int = 450_000
    gas_units_swap: int = 170_000
    # The platform's margin (owner decision, 2 Oct: "we must earn fees too"): the
    # tariff covers the gas by this much (the approved 15%), and by at least this
    # much in absolute native wei, so no execution loses money for the platform.
    gas_buffer_bps: int = 1500
    platform_min_profit_wei: int = 0
    owner_horizon_seconds: int = 7 * 86400
    forecast_haircut_bps: int = 2000
    owner_margin_bps: int = 0

    def __post_init__(self):
        values = {name: getattr(self, name) for name in self.__dataclass_fields__}
        if any(type(v) is not int or v < 0 for v in values.values()):
            raise DataError('v2_invalid_planner_config')
        if (not 1 <= self.deadline_seconds <= 3600 or self.liquidity_slack_bps >= BPS
                or self.swap_quote_slippage_bps >= BPS or self.swap_margin_bps >= BPS
                or self.forecast_haircut_bps >= BPS or self.owner_horizon_seconds > 30 * 86400
                or self.gas_units_compound == 0 or self.twap_drift_bps >= BPS):
            raise DataError('v2_invalid_planner_config')


# --------------------------------------------------------------- outputs
@dataclass(frozen=True)
class Economics:
    tariff: tuple  # per pool token
    tariff_wei: Fraction
    gas_units: int
    gas_wei: int
    swap_cost_wei: Fraction
    earnings_wei: Fraction | None  # incremental, over the horizon, before the haircut
    operator_ok: bool
    owner_ok: bool

    @property
    def net_owner_wei(self):
        if self.earnings_wei is None:
            return None
        return self.earnings_wei - self.tariff_wei - self.swap_cost_wei


@dataclass(frozen=True)
class Candidate:
    """One way to compound now: what it spends, adds and costs."""
    target: int
    sources: tuple
    budgets: tuple
    swap: Swap
    swap_out_expected: int
    liquidity: int  # what the planning price funds
    min_liquidity: int
    consumed: tuple  # net amounts the add takes, per token
    tariff: tuple
    leftover: tuple  # net capacity left in the budgets, per token
    anchor_sqrt_price: int
    label: str

    @property
    def has_swap(self):
        return not self.swap.empty


@dataclass(frozen=True)
class Decision:
    act: bool
    reason: str
    candidate: Candidate | None = None
    economics: Economics | None = None
    considered: tuple = ()  # (label, reason) of every candidate

    def plan(self, vault, *, anchor_evidence, deadline):
        """The PlanV1 to sign, with the evidence the anchor checks."""
        if not self.act:
            raise DataError('v2_nothing_to_execute')
        c = self.candidate
        return PlanV1(action=ACTION_COMPOUND, state_nonce=vault.state_nonce, deadline=deadline, target=c.target,
                      amount0_max=U128, amount1_max=U128, min_liquidity=c.min_liquidity,
                      collect=tuple(sorted(c.sources)), budgets=c.budgets, anchor_evidence=anchor_evidence,
                      swap=c.swap)


# ---------------------------------------------------------------- rules
def in_range(member, sqrt_price):
    """DominoV2VaultExecutor._inRange, against the anchor."""
    return sqrt_at_tick(member.tick_lower) <= sqrt_price < sqrt_at_tick(member.tick_upper)


def preconditions(vault, now):
    """Why the vault refuses any execution now, or None."""
    if vault.halted:
        return 'automation_halted'
    if vault.paused:
        return 'vault_paused'
    if vault.last_execution_at and now < vault.last_execution_at + vault.policy.minimum_interval_seconds:
        return 'too_soon'
    if vault.policy.mode not in TARIFF_BPS:
        return 'unknown_mode'
    return None


def funding(vault, target, anchor):
    """The sources the vault's routing admits for a COMPOUND of `target`: its
    own fees (rule 1) and, in Domino mode, members the anchor has left when
    the target is in range (rule 3). A member the price is in funds nothing
    else here; a successor's funding from a parent near its ceiling and the
    MINT of successors are left to a later slice."""
    sources = [target.token_id]
    if vault.policy.mode == MODE_DOMINO and in_range(target, anchor):
        # Collecting the root needs it armed; a disarmed root funds nothing.
        sources += [m.token_id for m in vault.members if m.token_id != target.token_id and not in_range(m, anchor)
                    and (m.token_id != vault.root_token_id or vault.root_armed)]
    return tuple(sorted(sources))


def _ledger(vault, sources, bps):
    """Per source and token, the lots after collect: uncharged + fees owed, charged."""
    ledger = {}
    for token_id in sources:
        member = vault.member(token_id)
        for index in (0, 1):
            uncharged, charged = member.lots[index]
            gross = uncharged + member.fees_owed[index]
            ledger[(token_id, index)] = Budgeted(charged, gross, charged + gross, bps)
    return ledger


def _capacity(ledger, sources, index):
    return sum(ledger[(s, index)].capacity() for s in sources)


def _liquidity_at(sqrt_price, member, amount0, amount1):
    return liquidity_for_amounts(sqrt_price, member.tick_lower, member.tick_upper, amount0, amount1)


def _scarce_output(sqrt_after, member, amount_in_left, amount_out_side, zero_for_one, margin_bps):
    """Whether, adding at sqrt_after, the output token is the scarce side by the margin."""
    lower, upper = sqrt_at_tick(member.tick_lower), sqrt_at_tick(member.tick_upper)
    if zero_for_one:
        # Output is token1: it must bind. Below the range only token0 is used.
        if sqrt_after <= lower:
            return False
        if sqrt_after >= upper:
            return True
        l0 = _liquidity0(sqrt_after, upper, amount_in_left)
        l1 = _liquidity1(lower, sqrt_after, amount_out_side)
    else:
        if sqrt_after >= upper:
            return False
        if sqrt_after <= lower:
            return True
        l0 = _liquidity0(sqrt_after, upper, amount_out_side)
        l1 = _liquidity1(lower, sqrt_after, amount_in_left)
    scarce, other = (l1, l0) if zero_for_one else (l0, l1)
    return scarce * BPS <= other * (BPS - margin_bps)


def _adverse(sqrt_price, zero_for_one, tolerance_bps):
    """The add's price moved against the swap by the tolerance: lower when the
    output is token1 (the position then needs less of it), higher otherwise."""
    if zero_for_one:
        return max(MIN_SQRT, sqrt_price * (BPS - tolerance_bps) // BPS)
    return min(MAX_SQRT - 1, sqrt_price * (BPS + tolerance_bps) // BPS)


def _balancing_swap(vault, member, cap0, cap1, config):
    """The largest exact-input swap after which the output token is still the
    scarce side, by config.swap_margin_bps, even when the price at the add has
    moved against it by config.swap_price_tolerance_bps (on the sqrt price):
    the add then spends all of the output, as A5 requires. None when nothing
    is in excess. The narrower the range, the more a price move changes the
    ratio it takes, and the more input this leaves for a later compound."""
    pool = vault.pool
    price = pool.sqrt_price_x96
    lower, upper = sqrt_at_tick(member.tick_lower), sqrt_at_tick(member.tick_upper)
    if price <= lower:
        zero_for_one = False  # only token0 is added: sell token1
    elif price >= upper:
        zero_for_one = True
    else:
        l0, l1 = _liquidity0(price, upper, cap0), _liquidity1(lower, price, cap1)
        if l0 == l1:
            return None
        zero_for_one = l0 > l1  # token0 in excess
    available = cap0 if zero_for_one else cap1
    if available == 0:
        return None
    fee = pool.fee_pips[0 if zero_for_one else 1]

    def ok(amount):
        after, out = simulate_swap(price, pool.liquidity, fee, zero_for_one, amount)
        left_in = (cap0 if zero_for_one else cap1) - amount
        out_side = (cap1 if zero_for_one else cap0) + out
        moved = _adverse(after, zero_for_one, config.swap_price_tolerance_bps)
        return _scarce_output(moved, member, left_in, out_side, zero_for_one, config.swap_margin_bps)

    low, high = 0, available
    while low < high:  # the greatest amount that keeps the output scarce
        mid = (low + high + 1) // 2
        if ok(mid):
            low = mid
        else:
            high = mid - 1
    if low == 0:
        return None
    after, out = simulate_swap(price, pool.liquidity, fee, zero_for_one, low)
    return (zero_for_one, low, out, after) if out > 0 else None


def _swap_source(ledger, sources, index, amount):
    """The source that pays the swap: the one with the most of the input token."""
    best = max(sources, key=lambda s: (ledger[(s, index)].capacity(), -s))
    return best if ledger[(best, index)].capacity() >= amount else None


def build_candidate(vault, target, anchor, config, *, swap_fraction_bps=0, quoter=None):
    """A COMPOUND of `target` with a balancing swap of swap_fraction_bps of the
    excess (0: direct), simulated with the vault's own spending rules. The
    swap's size comes from the vault pool's own curve (the add's ratio depends
    on that pool's price); its output and leg come from the quoter (the seam)."""
    bps = TARIFF_BPS[vault.policy.mode]
    sources = funding(vault, target, anchor)
    ledger = _ledger(vault, sources, bps)
    caps = {key: entry.cap for key, entry in ledger.items()}
    cap0, cap1 = _capacity(ledger, sources, 0), _capacity(ledger, sources, 1)
    pool = vault.pool
    price, swap, out_expected = pool.sqrt_price_x96, Swap(), 0
    label = 'direct'
    if swap_fraction_bps:
        if not vault.swap_available:
            return None, 'swap_unavailable'
        balancing = _balancing_swap(vault, target, cap0, cap1, config)
        if balancing is None:
            return None, 'nothing_to_balance'
        zero_for_one, amount = balancing[0], balancing[1] * swap_fraction_bps // BPS
        index_in = 0 if zero_for_one else 1
        source = _swap_source(ledger, sources, index_in, amount)
        if amount == 0 or source is None:
            return None, 'nothing_to_balance'
        fee = pool.fee_pips[index_in]
        token_in = pool.pool.currency0 if zero_for_one else pool.pool.currency1
        quoted = (quoter or PoolQuoter(pool)).quote(vault.chain_id, pool.pool, token_in, amount)
        out_expected = quoted.amount_out
        price = pool.sqrt_price_x96 if quoted.sqrt_price_after is None else quoted.sqrt_price_after
        floor_anchor = anchor
        if pool.pool.dex == 3:
            # A v3 TWAP keeps moving until inclusion: take the floor at an anchor that moved against us.
            floor_anchor = (anchor * (BPS + config.twap_drift_bps) // BPS if zero_for_one
                            else anchor * BPS // (BPS + config.twap_drift_bps))
        floor = minimum_output(amount, min(max(floor_anchor, MIN_SQRT), MAX_SQRT), zero_for_one, fee,
                               vault.limits.max_slippage_bps)
        minimum = max(floor, out_expected * (BPS - config.swap_quote_slippage_bps) // BPS, 1)
        if out_expected < minimum:
            return None, 'swap_below_floor'
        if ledger[(source, index_in)].spend(amount) != amount:
            return None, 'swap_unfunded'
        # The swap's output is credited to its source as charged units, which
        # the add spends first. The budget caps what the source may be debited
        # in each token, so it must leave room for more output than simulated:
        # an output the add cannot take would stay and refuse the plan (A5).
        caps[(source, 1 - index_in)] = min(U128, caps[(source, 1 - index_in)] + 2 * out_expected)
        out_entry = ledger[(source, 1 - index_in)]
        out_entry.charged += out_expected
        out_entry.cap = caps[(source, 1 - index_in)]
        leg = replace(quoted.leg, amount_in=amount, min_amount_out=minimum)
        if (leg.token_in, leg.token_out) != ((pool.pool.currency0, pool.pool.currency1) if zero_for_one
                                             else (pool.pool.currency1, pool.pool.currency0)):
            return None, 'quote_leg_mismatch'
        swap = Swap(source, zero_for_one, amount, minimum, (leg,))
        label = f'swap_{swap_fraction_bps}'
    if any(cap > U128 for cap in caps.values()):
        return None, 'budget_overflow'
    budgets = tuple(Budget(s, caps[(s, 0)], caps[(s, 1)]) for s in sources)
    cap0, cap1 = _capacity(ledger, sources, 0), _capacity(ledger, sources, 1)
    liquidity = _liquidity_at(price, target, cap0, cap1)
    if liquidity == 0:
        return None, 'nothing_to_add'
    need0, need1 = amounts_for_liquidity(price, target.tick_lower, target.tick_upper, liquidity, True)
    for index, need in ((0, need0), (1, need1)):
        for s in sources:
            need -= ledger[(s, index)].spend(need)
        if need:
            return None, 'allocation_short'
    if not swap.empty:
        out_index = 1 if swap.zero_for_one else 0
        if ledger[(swap.source, out_index)].charged > out_expected // SWAP_LEFTOVER_DIVISOR:
            return None, 'swap_output_unspent'
    tariff = tuple(sum(ledger[(s, index)].fee for s in sources) for index in (0, 1))
    leftover = (_capacity(ledger, sources, 0), _capacity(ledger, sources, 1))
    min_liquidity = max(1, liquidity * (BPS - config.liquidity_slack_bps) // BPS)
    return Candidate(target.token_id, sources, budgets, swap, out_expected, liquidity, min_liquidity,
                     (need0, need1), tariff, leftover, anchor, label), None


def incremental_earnings(candidate, target, pool_liquidity, growth, horizon_seconds):
    """Fees the added liquidity earns over the horizon, per token, at the
    window's per-unit rate r: r × ΔL × (A − L) / (A + ΔL), where A is the
    pool's active liquidity and L the target's, both at the planning block:
    the same fee flow shared by more liquidity. Out of range: nothing."""
    added = candidate.liquidity
    if not in_range(target, candidate.anchor_sqrt_price):
        return Fraction(0), Fraction(0)
    own = target.liquidity
    active = max(pool_liquidity, own)
    if added == 0 or active == own:
        return Fraction(0), Fraction(0)
    share = Fraction(added * (active - own), active + added)
    rate0, rate1 = growth.rate()
    return (rate0 * share * horizon_seconds / Q128, rate1 * share * horizon_seconds / Q128)


def economics(vault, candidate, prices, gas, config, *, growth=None, gas_units=None):
    """Both gates for one candidate. gas_units: measured by presimulation, else the prior."""
    units = gas_units if gas_units is not None else (
        config.gas_units_compound + (config.gas_units_swap if candidate.has_swap else 0))
    gas_wei = gas.cost(units)
    tariff_wei = prices.value(*candidate.tariff)
    swap_cost = Fraction(0)
    if candidate.has_swap:
        s = candidate.swap
        value_in = prices.value(s.amount_in, 0) if s.zero_for_one else prices.value(0, s.amount_in)
        value_out = (prices.value(0, candidate.swap_out_expected) if s.zero_for_one
                     else prices.value(candidate.swap_out_expected, 0))
        swap_cost = max(Fraction(0), value_in - value_out)
    operator_ok = (tariff_wei * BPS >= gas_wei * (BPS + config.gas_buffer_bps)
                   and tariff_wei - gas_wei >= config.platform_min_profit_wei)
    earnings = None
    owner_ok = False
    if growth is not None:
        target = vault.member(candidate.target)
        e0, e1 = incremental_earnings(candidate, target, vault.pool.liquidity, growth, config.owner_horizon_seconds)
        earnings = prices.wei_per_unit0 * e0 + prices.wei_per_unit1 * e1
        owner_ok = (earnings * (BPS - config.forecast_haircut_bps) * BPS
                    >= (tariff_wei + swap_cost) * BPS * (BPS + config.owner_margin_bps))
    return Economics(candidate.tariff, tariff_wei, units, gas_wei, swap_cost, earnings, operator_ok,
                     owner_ok and candidate.liquidity > 0)


def decide(vault, anchor, prices, gas, config, *, growth_by_target=None, now=None, quoter=None,
           max_gas_cost_wei=None):
    """Whether to compound now, and how. `anchor` is the sqrt price the vault's
    anchor call will return (the signed spot on v4, the TWAP on v3);
    growth_by_target maps a member's token id to its FeeGrowth evidence."""
    now = vault.block_timestamp if now is None else now
    blocked = preconditions(vault, now)
    if blocked is not None:
        return Decision(False, blocked)
    growth_by_target = growth_by_target or {}
    considered, passing = [], []
    for target in sorted(vault.members, key=lambda m: m.token_id):
        if target.token_id == vault.root_token_id and not vault.root_armed:
            considered.append((f'{target.token_id}:all', 'root_disarmed'))
            continue
        direct = None
        for fraction in (0, BPS, BPS // 2):
            candidate, refusal = build_candidate(vault, target, anchor, config, swap_fraction_bps=fraction,
                                                 quoter=quoter)
            label = f'{target.token_id}:{"direct" if fraction == 0 else f"swap_{fraction}"}'
            if candidate is None:
                considered.append((label, refusal))
                continue
            if fraction == 0:
                direct = candidate
            elif direct is not None and not _swap_worth_it(candidate, direct, prices, config):
                considered.append((label, 'swap_too_small'))
                continue
            result = economics(vault, candidate, prices, gas, config, growth=growth_by_target.get(target.token_id))
            if max_gas_cost_wei is not None and result.gas_wei > max_gas_cost_wei:
                considered.append((label, 'vault_gas_ceiling'))
            elif not result.operator_ok:
                considered.append((label, 'gas_not_covered'))
            elif result.earnings_wei is None:
                considered.append((label, 'earnings_evidence_missing'))
            elif not result.owner_ok:
                considered.append((label, 'owner_benefit_insufficient'))
            else:
                considered.append((label, 'eligible'))
                passing.append((candidate, result))
    if not passing:
        reasons = [reason for _, reason in considered]
        order = ('owner_benefit_insufficient', 'gas_not_covered', 'vault_gas_ceiling', 'earnings_evidence_missing',
                 'root_disarmed', 'nothing_to_add')
        reason = next((r for r in order if r in reasons), reasons[0] if reasons else 'no_members')
        return Decision(False, reason, considered=tuple(considered))
    candidate, result = max(passing, key=lambda pair: (pair[1].net_owner_wei, pair[0].liquidity,
                                                       -pair[0].target, pair[0].label == 'direct'))
    return Decision(True, 'eligible', candidate, result, tuple(considered))


def _swap_worth_it(candidate, direct, prices, config):
    """A swap is considered only when what it brings into play is a real share of the fees."""
    s = candidate.swap
    value_in = prices.value(s.amount_in, 0) if s.zero_for_one else prices.value(0, s.amount_in)
    consumed = prices.value(*direct.consumed) + value_in
    return value_in * BPS >= consumed * config.min_swap_share_bps


def remeasured(decision, vault, prices, gas, config, gas_units, *, growth=None, max_gas_cost_wei=None):
    """The same decision with the gas presimulation measured: both gates, and
    the vault's off-chain gas ceiling, again."""
    if not decision.act:
        return decision
    result = economics(vault, decision.candidate, prices, gas, config, growth=growth, gas_units=gas_units)
    if max_gas_cost_wei is not None and result.gas_wei > max_gas_cost_wei:
        return replace(decision, act=False, reason='vault_gas_ceiling', economics=result)
    if not result.operator_ok:
        return replace(decision, act=False, reason='gas_not_covered', economics=result)
    if not result.owner_ok:
        return replace(decision, act=False, reason='owner_benefit_insufficient', economics=result)
    return replace(decision, economics=result)
