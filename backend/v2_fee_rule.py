"""The V2 assisted-swap fee rule, exactly as DominoFeeRules (F1b) applies it on-chain.

The zap refuses a plan whose intent does not carry the terms this module
computes (FeeMismatch), so the planner must reproduce the contract, not a
reading of the documents: contracts/src/v2/fees/DominoFeeRules.sol is the
source, docs/v2/F1_FEES_ROUTE.md and PRICING_POLICY.md (V2) the decisions.

- Which token: every token the legs touch is classified per appearance. A
  leg's tokenIn is a hop when an earlier leg delivered it, else an input; a
  leg's tokenOut is a hop when a later leg spends it, else an output. The best
  ranked charge currency wins (the lowest nonzero rank). Equal ranks go to the
  earlier place (input, then output, then hop), then the earlier leg, then
  tokenIn before tokenOut of the same leg: the contract's scan order. With no
  charge currency in the route, the first leg's input pays (fallback).
- How much: 65 bps (FEE_ASSISTED_SWAP_BPS) of the swapped amount, the larger of
  what the legs spent in the fee token (signed amountIn) and what they
  delivered in it (measured), rounded down.
- No legs, no fee: the intent's terms are (0, address(0)).

`rank` is a callable from a lower-case address to its charge-currency rank (0
when it is not one): the deployed registry's chargeCurrencyRank, or a chain
profile's ranks before a deployment exists. Native ETH is address(0). Hops
inside one Universal Router call or one pool path are invisible here, as they
are to the contract.
"""
from dataclasses import dataclass

ZERO = '0x' + '00' * 20
FEE_ASSISTED_SWAP_BPS = 65
BPS = 10_000

# DominoFeeRules.FROM_*: where the selected fee token appears in the route.
FROM_INPUT, FROM_OUTPUT, FROM_HOP, FROM_FALLBACK = 1, 2, 3, 4
PLACES = {FROM_INPUT: 'input', FROM_OUTPUT: 'output', FROM_HOP: 'hop', FROM_FALLBACK: 'fallback'}


class FeeRuleError(ValueError):
    """The contract would revert InvalidPlan for this input (an empty route, mismatched amounts)."""


@dataclass(frozen=True)
class LegTokens:
    """What the rule reads of a SwapLeg: its tokens and signed input amount."""
    token_in: str
    token_out: str
    amount_in: int = 0


def _tokens(leg):
    if isinstance(leg, LegTokens):
        return leg.token_in.lower(), leg.token_out.lower(), leg.amount_in
    # A SwapLeg-shaped mapping (the plan codec's dicts) or object.
    get = leg.get if isinstance(leg, dict) else lambda name: getattr(leg, name)
    names = ('tokenIn', 'tokenOut', 'amountIn') if isinstance(leg, dict) else ('token_in', 'token_out', 'amount_in')
    return get(names[0]).lower(), get(names[1]).lower(), int(get(names[2]))


def _place(legs, index, token, as_input):
    """DominoFeeRules._place: an input unless an earlier leg delivered it; an
    output unless a later leg spends it; a hop otherwise."""
    if as_input:
        return FROM_HOP if any(legs[j][1] == token for j in range(index)) else FROM_INPUT
    return FROM_HOP if any(legs[j][0] == token for j in range(index + 1, len(legs))) else FROM_OUTPUT


def assisted_swap_fee_token(legs, rank):
    """(token, source) as DominoFeeRules.assistedSwapFeeToken returns them."""
    rows = [_tokens(leg) for leg in legs]
    if not rows:
        raise FeeRuleError('fee_rule_empty_route')
    best_rank, token, source = None, None, 0
    for place in (FROM_INPUT, FROM_OUTPUT, FROM_HOP):
        for index, (spent, delivered, _) in enumerate(rows):
            for candidate, as_input in ((spent, True), (delivered, False)):
                if _place(rows, index, candidate, as_input) != place:
                    continue
                value = rank(candidate)
                if type(value) is not int or not 0 <= value <= 255:
                    raise FeeRuleError('fee_rule_rank_invalid')
                if value != 0 and (best_rank is None or value < best_rank):
                    best_rank, token, source = value, candidate, place
    if source == 0:
        token, source = rows[0][0], FROM_FALLBACK
    return token, source


def swapped_amount(legs, amounts_out, token):
    """DominoFeeRules.swappedAmount: max(spent in token, delivered in token)."""
    rows = [_tokens(leg) for leg in legs]
    if len(amounts_out) != len(rows):
        raise FeeRuleError('fee_rule_amounts_mismatch')
    token = token.lower()
    spent = sum(amount for tin, _, amount in rows if tin == token)
    delivered = sum(int(out) for (_, tout, _), out in zip(rows, amounts_out) if tout == token)
    return max(spent, delivered)


def fee_of(amount, bps):
    """bps of amount, rounded down in the payer's favour."""
    return int(amount) * int(bps) // BPS


def assisted_swap_terms(legs, rank):
    """The intent's (feeBps, feeToken, source): (0, ZERO, None) with no legs."""
    if not legs:
        return 0, ZERO, None
    token, source = assisted_swap_fee_token(legs, rank)
    return FEE_ASSISTED_SWAP_BPS, token, source


def terms_match(legs, rank, fee_bps, fee_token):
    """DominoFeeRules.requireAssistedSwapTerms without the revert."""
    bps, token, _ = assisted_swap_terms(legs, rank)
    return fee_bps == bps and fee_token.lower() == token


def assisted_swap_fee(legs, amounts_out, rank):
    """(token, source, swapped, fee) for legs that ran and delivered amounts_out."""
    token, source = assisted_swap_fee_token(legs, rank)
    swapped = swapped_amount(legs, amounts_out, token)
    return token, source, swapped, fee_of(swapped, FEE_ASSISTED_SWAP_BPS)


def ranks_from_profile(chain):
    """The chain profile's charge-currency ranks (before a registry exists)."""
    def rank(token):
        value = chain.charge_rank(token)
        return 0 if value is None else value
    return rank


def ranks_from_mapping(mapping):
    table = {address.lower(): int(value) for address, value in mapping.items()}
    return lambda token: table.get(token.lower(), 0)
