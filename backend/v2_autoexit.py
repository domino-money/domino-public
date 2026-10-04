"""Auto-exit for the V2 operator: watch registered mandates, confirm a trigger by the anchor, build the execution.

docs/v2/F4_AUTO_EXIT.md, "For the planner (F6)". The module (DominoAutoExit,
component autoExit) holds owners' signed one-shot ExitMandates. The operator:

1. reads MandateRegistered logs from the module's deployment block on, and
   each mandate's record and status at the head (mandateOf, mandateStatus):
   active, not past validUntil, on a vault whose exit module is this one and
   whose owner is still the mandate's owner;
2. takes the anchor the module will take: on a v4 pool a publisher's signed
   observation of the spot at the head (valid at most the module's
   maxObservationAgeSeconds, 300 s), on a v3 pool the pool's TWAP over a window
   of at least the module's minTwapSeconds (600 s) and at most its
   MAX_TWAP_SECONDS (an hour; the configuration holds the operator's preferred
   window to it), read through the price anchor itself; and fires only when
   that anchor price has crossed a trigger: at or below triggerBelow, or at or
   above a nonzero triggerAbove (the module's own comparison). The spot alone
   never fires an exit;
3. builds IDominoAutoExit.Execution: the evidence; for a conversion one pool
   leg through the vault's own pool selling the other token for convertTo
   with amountIn 0, which the module fills with everything withdrawn, and a
   positive minAmountOut under the module's own fee-aware floor at the
   anchor; and removal minimums the position's principal meets anywhere the
   band lets the spot be (at the band's edges), so the band, not a guess,
   bounds the removal;
4. hands the calldata to the executor, which presimulates it before anything
   is signed. Executing one mandate does not end other mandates on the same
   position (they fail later: the position is gone).
"""
from dataclasses import dataclass
from math import isqrt

from discovery import ZERO, DataError, address
from v2_abi import event, function
from v2_chains import DEX_V4
from v2_plan import LEG_V3_POOL, LEG_V4_POOL, ExitExecution, SwapLeg, exit_calldata, twap_evidence, v3_path, v4_path
from v2_planner import BPS, amounts_for_liquidity
from v2_uniswap import PoolRef, PositionRef
from v2_vaults import calls, pool_ref
from v4_math import MAX_SQRT, MIN_SQRT

AUTO_EXIT = 'IDominoAutoExit'
EXTENSION = 'IDominoAutoExitExtension'
STATUS_ACTIVE = 1
RECEIVE_BOTH, RECEIVE_CONVERTED = 0, 1
Q96 = 1 << 96


@dataclass(frozen=True)
class Mandate:
    """A registered mandate as the module stores it (IDominoAutoExitExtension.MandateRecord)."""
    hash: str
    owner: str
    valid_until: int
    max_slippage_bps: int
    receive_mode: int
    status: int
    vault: str
    convert_to: str
    trigger_below: int
    trigger_above: int
    token_id: int

    def triggered(self, anchor_sqrt_price):
        """DominoAutoExit._authorize: fires at or below `below`, or at or above a nonzero `above`."""
        if anchor_sqrt_price <= 0:
            return False
        return anchor_sqrt_price <= self.trigger_below or (self.trigger_above != 0
                                                            and anchor_sqrt_price >= self.trigger_above)


class MandateWatcher:
    """MandateRegistered logs of the module, from its deployment block on."""

    def __init__(self, deployment, *, max_blocks_per_read=50_000):
        self.deployment, self.max_blocks = deployment, max_blocks_per_read
        self.next_block = deployment.start_block('autoExit')
        self.hashes = {}
        self.final = set()  # revoked, executed or expired: never active again

    def scan(self, rpc, head, *, lag_blocks=0):
        registered = event(AUTO_EXIT, 'MandateRegistered')
        module = self.deployment.auto_exit
        end = head.number - lag_blocks
        start = self.next_block
        while start <= end:
            stop = min(end, start + self.max_blocks - 1)
            for log in rpc.request('eth_getLogs', [{'address': module, 'topics': [registered.topic],
                                                         'fromBlock': hex(start), 'toBlock': hex(stop)}]):
                if address(log['address']) != module:
                    raise DataError('v2_log_address_mismatch')
                values = registered.decode(log)
                self.hashes.setdefault('0x' + values['mandateHash'].hex(), int(log['blockNumber'], 16))
            start = stop + 1
        self.next_block = max(self.next_block, end + 1)
        return sorted((h for h in self.hashes if h not in self.final), key=lambda h: (self.hashes[h], h))

    def forget(self, mandate_hash):
        """A mandate that can never execute again is not read on later passes."""
        self.final.add(mandate_hash)


def read_mandates(rpc, deployment, hashes, block):
    """Each mandate's record at `block`."""
    if not hashes:
        return []
    module = deployment.auto_exit
    records = calls(rpc, block, [(module, function(EXTENSION, 'mandateOf'), (bytes.fromhex(h[2:]),))
                                 for h in hashes])
    mandates = []
    for mandate_hash, (record,) in zip(hashes, records):
        owner, valid_until, slippage, mode, status, vault, convert_to, below, above, token_id = record
        mandates.append(Mandate(mandate_hash, address(owner), valid_until, slippage, mode, status, address(vault),
                                address(convert_to), below, above, token_id))
    return mandates


@dataclass(frozen=True)
class ModuleParameters:
    max_observation_age_seconds: int
    min_twap_seconds: int


def module_parameters(rpc, deployment, block):
    (age,), (twap,) = calls(rpc, block, [(deployment.auto_exit, function(EXTENSION, 'maxObservationAgeSeconds'), ()),
                                         (deployment.auto_exit, function(EXTENSION, 'minTwapSeconds'), ())])
    return ModuleParameters(age, twap)


def eligible(mandate, vault_owner, exit_module, deployment, now):
    """Why the module would refuse this mandate before the anchor, or None."""
    if mandate.status != STATUS_ACTIVE:
        return 'mandate_not_active'
    if now > mandate.valid_until:
        return 'mandate_expired'
    if exit_module != deployment.auto_exit:
        return 'exit_module_not_enabled'
    if vault_owner != mandate.owner:
        return 'vault_owner_changed'
    return None


def band_edges(anchor_sqrt_price, band_bps):
    """The lowest and highest spot sqrt price AnchorMath.withinBand admits around
    the anchor: the price may differ by a factor of at most 1 + band/10000."""
    factor = isqrt((BPS + band_bps) * (1 << 192) // BPS) + 1  # sqrt(1 + band) in Q96, rounded up
    high = min(MAX_SQRT - 1, -(-anchor_sqrt_price * factor // Q96))
    low = max(MIN_SQRT, anchor_sqrt_price * Q96 // factor)
    return low, high


def removal_minimums(liquidity, tick_lower, tick_upper, anchor_sqrt_price, band_bps):
    """Principal minimums the withdrawal meets wherever the band lets the spot be:
    amount0 is least at the highest admitted price, amount1 at the lowest."""
    if liquidity == 0:
        return 0, 0
    low, high = band_edges(anchor_sqrt_price, band_bps)
    amount0, _ = amounts_for_liquidity(high, tick_lower, tick_upper, liquidity, False)
    _, amount1 = amounts_for_liquidity(low, tick_lower, tick_upper, liquidity, False)
    return amount0, amount1


def conversion_legs(mandate, pool):
    """One pool leg through the vault's own pool, filled with everything withdrawn."""
    if mandate.receive_mode == RECEIVE_BOTH:
        return ()
    if mandate.convert_to not in (pool.currency0, pool.currency1):
        raise DataError('v2_mandate_invalid')
    source = pool.currency1 if mandate.convert_to == pool.currency0 else pool.currency0
    if pool.dex == DEX_V4:
        return (SwapLeg(LEG_V4_POOL, ZERO, source, mandate.convert_to, 0, 1, v4_path([pool])),)
    return (SwapLeg(LEG_V3_POOL, ZERO, source, mandate.convert_to, 0, 1, v3_path(source, pool.fee, mandate.convert_to)),)


@dataclass(frozen=True)
class ExitPlan:
    mandate: Mandate
    anchor_sqrt_price: int
    execution: ExitExecution
    calldata: str
    deadline: int


def plan_exit(mandate, pool, position, anchor_sqrt_price, evidence, deadline):
    """The Execution for a triggered mandate, or None when the anchor has not crossed."""
    if not mandate.triggered(anchor_sqrt_price):
        return None
    min0, min1 = removal_minimums(position.liquidity, position.tick_lower, position.tick_upper, anchor_sqrt_price,
                                  mandate.max_slippage_bps)
    execution = ExitExecution(evidence, conversion_legs(mandate, pool), min0, min1)
    return ExitPlan(mandate, anchor_sqrt_price, execution, exit_calldata(mandate.hash, execution), deadline)


def vault_facts(rpc, mandate, block):
    """The vault's exit module, owner and pool at `block`."""
    (module,), (owner,), (pool,) = calls(rpc, block, [(mandate.vault, function('IDominoVault', 'exitModule'), ()),
                                                     (mandate.vault, function('IDominoVault', 'owner'), ()),
                                                     (mandate.vault, function('IDominoVault', 'pool'), ())])
    return address(module), address(owner), pool_ref(pool)


def twap_exit_evidence(parameters, preferred_window):
    """The v3 window an exit may use: at least the module's minimum. The
    preferred window is at most the module's hour (checked_config), which the
    module's minimum never exceeds (its constructor), so neither does this."""
    window = max(parameters.min_twap_seconds, preferred_window)
    return window, twap_evidence(window)


def position_ref(chain, pool, token_id):
    manager = chain.uniswap.v4.positionManager if pool.dex == DEX_V4 else chain.uniswap.v3.positionManager
    return PositionRef(pool.dex, manager, token_id)


__all__ = ['Mandate', 'MandateWatcher', 'ModuleParameters', 'PoolRef', 'band_edges', 'conversion_legs', 'eligible',
           'module_parameters', 'plan_exit', 'position_ref', 'read_mandates', 'removal_minimums',
           'twap_exit_evidence', 'vault_facts']
