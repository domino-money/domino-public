"""Domino-compound's geometry and routing, mirrored from the vault (DominoV2VaultExecutor.sol), line for line.

A Domino vault holds a sequence: the root and the successors it mints as the price climbs. The vault decides, against
its anchor price, which member may fund which, and accepts a successor only within its owner's policy. The planner
asks these functions before it builds a plan, so a plan the vault would refuse is never signed.

Prices are quote per base. `inverse` is true when the quote currency is the pool's currency0
(IDominoVaultLedger.quoteCurrency): prices are then read upside down, the ceiling is a member's lower tick and the
sequence grows toward lower ticks. Every comparison is exact, on sqrt prices (Q64.96) squared.

The successor's range is the owner's choice of 5 Oct 2026: its floor is the edge of the aligned tick cell the anchor
is in, so the successor holds the price when it is minted (it takes both tokens, and members the price has left may
fund it); its top is the first aligned tick at least upsideBps above the basis, as the vault requires. When the
overlap the policy allows does not reach down to that cell, there is no successor.
"""
from v4_math import sqrt_at_tick, tick_at_sqrt

BPS = 10_000
MIN_TICK, MAX_TICK = -887272, 887272


def ratio_at_least(a, b, num):
    """DominoV2VaultMath.ratioAtLeast: (a / b)^2 >= num / 10000, exactly (the 2^32 shortcut decides the same)."""
    return a * a * BPS >= b * b * num


def oriented_at_least(x, y, num, inverse):
    """DominoV2VaultExecutor._orientedAtLeast: (x / y)^2 >= num / 10000 in the quote-per-base orientation."""
    return ratio_at_least(y, x, num) if inverse else ratio_at_least(x, y, num)


def ceiling_tick(member, inverse):
    return member.tick_lower if inverse else member.tick_upper


def in_range(member, anchor):
    """DominoV2VaultExecutor._inRange: on raw ticks, whatever the orientation."""
    return sqrt_at_tick(member.tick_lower) <= anchor < sqrt_at_tick(member.tick_upper)


def near_ceiling(member, anchor, trigger_bps, inverse):
    """DominoV2VaultExecutor._nearCeiling: the anchor within the trigger distance below the ceiling, or past it."""
    return oriented_at_least(anchor, sqrt_at_tick(ceiling_tick(member, inverse)), BPS - trigger_bps, inverse)


def past_ceiling(member, anchor, inverse):
    return oriented_at_least(anchor, sqrt_at_tick(ceiling_tick(member, inverse)), BPS, inverse)


def check_successor(parent, tick_lower, tick_upper, anchor, *, trigger_bps, overlap_bps, upside_bps, spacing,
                    inverse):
    """DominoV2VaultExecutor._checkSuccessor: whether the vault accepts this successor range now (False: it reverts
    InvalidRoute). The range's own validity (order, alignment, bounds) is the position adapter's, checked apart."""
    if not near_ceiling(parent, anchor, trigger_bps, inverse):
        return False
    ceiling = sqrt_at_tick(ceiling_tick(parent, inverse))
    basis = anchor if past_ceiling(parent, anchor, inverse) else ceiling
    floor = sqrt_at_tick(tick_upper if inverse else tick_lower)
    top = tick_lower if inverse else tick_upper
    inward = tick_lower + spacing if inverse else tick_upper - spacing
    upside = BPS + upside_bps
    return (oriented_at_least(basis, floor, BPS, inverse)
            and oriented_at_least(floor, basis, BPS - overlap_bps, inverse)
            and oriented_at_least(sqrt_at_tick(top), basis, upside, inverse)
            and not oriented_at_least(sqrt_at_tick(inward), basis, upside, inverse))


def successor_range(parent, anchor, *, trigger_bps, overlap_bps, upside_bps, spacing, inverse):
    """The successor of `parent` at `anchor` (see the module), as (tick_lower, tick_upper), with the reason when
    there is none: successor_not_due (not near the ceiling) or successor_range_unavailable."""
    if not near_ceiling(parent, anchor, trigger_bps, inverse):
        return None, 'successor_not_due'
    cell = (tick_at_sqrt(anchor) // spacing) * spacing  # the aligned tick at or below the anchor
    ceiling = sqrt_at_tick(ceiling_tick(parent, inverse))
    basis = anchor if past_ceiling(parent, anchor, inverse) else ceiling
    upside = BPS + upside_bps
    low_k, high_k = -(MAX_TICK // spacing), MAX_TICK // spacing  # the aligned ticks within the range
    if not inverse:
        lower = cell
        # The first aligned tick above the floor whose price reaches the basis by upsideBps.
        k = _first(lambda k: ratio_at_least(sqrt_at_tick(k * spacing), basis, upside), lower // spacing + 1, high_k)
        upper = None if k is None else k * spacing
    else:
        upper = cell + spacing
        # Upside down: the first aligned tick below the floor whose price is the basis's by upsideBps, downward.
        k = _last(lambda k: ratio_at_least(basis, sqrt_at_tick(k * spacing), upside), low_k, upper // spacing - 1)
        lower = None if k is None else k * spacing
    # Aligned, ordered and within the tick range by construction (DominoPositionMath.checkRange's own rules).
    if lower is None or upper is None:
        return None, 'successor_range_unavailable'
    if not check_successor(parent, lower, upper, anchor, trigger_bps=trigger_bps, overlap_bps=overlap_bps,
                           upside_bps=upside_bps, spacing=spacing, inverse=inverse):
        return None, 'successor_range_unavailable'
    return (lower, upper), None


def full_range(spacing):
    """The widest aligned range: fee growth inside it is the pool's global growth, whatever the ticks' state."""
    edge = (MAX_TICK // spacing) * spacing
    return -edge, edge


def _first(holds, low, high):
    """The least k in [low, high] for which `holds` (monotone: False then True), or None."""
    if low > high or not holds(high):
        return None
    while low < high:
        mid = (low + high) // 2
        if holds(mid):
            high = mid
        else:
            low = mid + 1
    return low


def _last(holds, low, high):
    """The greatest k in [low, high] for which `holds` (monotone: True then False), or None."""
    if low > high or not holds(low):
        return None
    while low < high:
        mid = (low + high + 1) // 2
        if holds(mid):
            low = mid
        else:
            high = mid - 1
    return low


def routable(source, destination, *, mint, target, anchor, trigger_bps, inverse):
    """DominoV2VaultExecutor._routable: whether `source` may fund the plan's destination (a COMPOUND of member
    `target`, or a MINT whose parent is `target` and whose new member is `destination`). Fees return to their own
    position; a member the price is in funds nothing else, except its successor (or, for a MINT, the successor it
    is minting) once the price is within the trigger distance of its ceiling; a member the price has left funds
    any position the price is in."""
    if not mint and source.token_id == target:
        return True
    if in_range(source, anchor):
        own = source.token_id == target if mint else source.successor == target
        return own and near_ceiling(source, anchor, trigger_bps, inverse)
    return in_range(destination, anchor)
