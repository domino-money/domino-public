"""Featured pools: the selection rules of featured-policy v1 and v2, with no I/O.

The selector (manage_featured.py) gathers, for each candidate, the provider
observation from the listing, the chain-verified pool, the APR estimate the
site shows (pool_apr.estimate_pool_apr), the reference depth and the token
evidence. This module decides eligibility, diversity, ranking, hysteresis and
slots. The same inputs give the same list, byte for byte.

Safety (S) rules are never relaxed, not for incumbents, pins or a manual
list. Market (M) rules are calibrated in the shadow phase; pins skip them and
incumbents meet the volume, liquidity and depth floors at a discount.

v2 (featured_policy.json `rankBy`, `persistence`, `fill`): a market rule whose
threshold is null is off, today's APR alone may rank, and a short list may be
completed from the embedded list only.

Per chain (launch round P3, 4 Nov 2026): a policy with a `chain` block selects
on that chain (featured_policies/, Base and Arbitrum One), with its own stable,
its provider DEX labels for Uniswap v3 and v4, and ETH priced by the chain
profile's Chainlink feed (or, on a chain Chainlink does not serve, the native
currency by the pool its profile names). Robinhood's policy has no block and keeps its facts:
USDG is its dollar side, `uniswap-v4-robinhood` its only DEX label, and its file,
hence its policy version, does not change.
"""
from decimal import Decimal, InvalidOperation
from fractions import Fraction
import hashlib
import json
from math import isqrt
from pathlib import Path
import re
import unicodedata

from automation_evidence import MAX_TICK, MIN_TICK, _next_initialized
from discovery import DataError, address, bytes32
from v4_math import MAX_SQRT, MIN_SQRT, Q96, amount_delta, sqrt_at_tick

POLICY_PATH = Path(__file__).resolve().parent/'featured_policy.json'
ZERO = '0x' + '0' * 40
DYNAMIC_FEE = 0x800000
HOURS = 3600
# Uniswap versions, as v2_chains.DEX_V3 and DEX_V4 number them. A pool read without one is v4:
# Robinhood's pool_market reads v4 pools only.
DEX_V3, DEX_V4 = 3, 4
# Robinhood's policy names no chain: its one provider DEX label, and its dollar side by symbol.
ROBINHOOD_DEX_LABELS = {'uniswap-v4-robinhood': DEX_V4}
ROBINHOOD_STABLE_SYMBOL = 'USDG'
# A v3 pool's protocol fee is 1/N of its swap fee per input token, N in 4..10 or 0 for none
# (UniswapV3Pool.setFeeProtocol), token0's in the low four bits of slot0.feeProtocol.
V3_PROTOCOL_DENOMINATORS = (0, 4, 5, 6, 7, 8, 9, 10)
GECKO_NETWORK = re.compile(r'[a-z][a-z0-9-]{0,31}')
GECKO_DEX = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')

# Reason codes in rule order. S: safety, never relaxed. M: market, calibrated.
SAFETY = (
    'identity_unresolved', 'provider_currency_or_pool_mismatch', 'provider_dex_unconfirmed',   # E1
    'hooked_pool_unsupported',                                                                 # E2
    'dynamic_fee_unsupported', 'fixed_fee_mismatch', 'fee_out_of_range',                       # E3
    'invalid_protocol_fee', 'protocol_fee_directional_unsupported',                            # E4
    'no_reference_side', 'same_asset_pair',                                                    # E5
    'token_no_code', 'token_metadata_unreadable', 'token_symbol_unsafe', 'token_lookalike',    # E6
    'token_symbol_duplicate', 'token_upgradeable_unreviewed', 'token_code_changed',
    'token_protected_unreviewed', 'token_symbol_forbidden', 'token_unreviewed',
    'excluded_by_owner',                                                                       # E7
    'estimate_not_available',                                                                  # E8
    'no_active_liquidity',                                                                     # E9
)
MARKET = (
    'volume_below_floor', 'tvl_below_floor',                                                   # E10, E11
    'reference_depth_below_floor', 'reference_depth_unmeasurable',                             # E12
    'apr_above_ceiling', 'turnover_above_ceiling',                                             # E13, E14
    'pool_too_young', 'age_unknown', 'activity_below_floor',                                   # E15, E16
    'volume_faded', 'not_persistent',                                                          # E17
    'price_move_outlier', 'provider_price_disagreement',                                       # E18
)
REASONS = SAFETY + MARKET
# featured-policy v2: a market rule whose threshold is null is off. The floors stay.
OPTIONAL_DECIMALS = ('minReferenceDepthUsd', 'maxAprPercent', 'maxTurnover24h', 'minH6ShareOfH24',
                     'maxAbsPriceChange24hPercent', 'maxProviderPriceDeviation')
OPTIONAL_INTEGERS = ('minPoolAgeHours', 'minTraders24h', 'minSwaps24h')
# min_fresh_and_previous: the lower of today's and the previous evaluation's APR (v1);
# fresh: today's APR alone.
RANKINGS = ('min_fresh_and_previous', 'fresh')
# What may complete a short list (`fill`, in its order, each at most once):
# yesterday's pools still safe (carried), the embedded list's (fallback).
FILLS = ('carried', 'fallback')
# A threshold as a list states it (read_contract.DecimalString).
DECIMAL_STRING = re.compile(r'[0-9]+(?:\.[0-9]+)?')
SOURCES = ('pinned', 'ranked', 'carried', 'fallback', 'manual')
# The live health check withdraws a served pool whose reported TVL falls under its floor
# divided by 2 (tvl_collapse), or whose 24 h volume falls under its floor divided by 10
# (volume_collapse); the embedded list completes a list only with pools above both.
COLLAPSE = {'tvl_collapse': ('minTvlUsd', 2), 'volume_collapse': ('minVolume24hUsd', 10)}

# Letters that only look Latin, and digits and signs that pass for letters,
# as the Latin letter they imitate: app/src/lib/walletHoldings.ts LOOKS.
LOOKS = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
    'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y',
    'І': 'I', 'Ѕ': 'S',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I',
    'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
    'Υ': 'Y', 'Χ': 'X',
    '0': 'O', '1': 'I', 'L': 'I', '|': 'I', '5': 'S', '$': 'S',
}
UNSAFE_SYMBOL_TEXT = ('.', '/', ':', 'WWW', 'HTTP', 'CLAIM')


def symbol_reading(symbol):
    """A symbol as it reads, exactly as the site's symbolReading reads it.

    NFKD, then invisible, combining and space characters dropped, upper case,
    look-alikes mapped: "P0NS" and "PONS" with a zero-width space both read
    "PONS"; "ÜSDG" and "USDĢ" read "USDG".
    """
    plain = ''.join(ch for ch in unicodedata.normalize('NFKD', symbol)
                    if unicodedata.category(ch) not in ('Cf', 'Mn', 'Me')
                    and not unicodedata.category(ch).startswith('Z') and not ch.isspace()).upper()
    return ''.join(LOOKS.get(ch, ch) for ch in plain)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def load_policy(path=POLICY_PATH):
    policy = json.loads(Path(path).read_text())
    check_policy(policy)
    return policy


def check_policy(policy):
    """Refuse a policy the rules cannot apply; the values themselves are the owner's."""
    try:
        integers = (policy['size'], policy['maxPins'], policy['selectionHourUtc'], policy['selectionLeadMinutes'],
                    policy['selectionRetryUntilMinutes'], policy['maxListingPages'],
                    policy['listingProviderHeadroom'], policy['referenceDepth']['maxSteps'],
                    policy['minPublishable'], policy['validHours'], policy['persistenceLookbackHours'],
                    policy['diversity']['maxMajorPairs'], policy['hysteresis']['maxRankedSwapsPerDay'])
        valid = (policy['schemaVersion'] == 1 and all(type(value) is int for value in integers)
                 and 1 <= policy['size'] <= 12
                 and type(policy['maxPins']) is int and 0 <= policy['maxPins'] <= policy['size']
                 and 0 <= policy['selectionHourUtc'] <= 23
                 and 10 <= policy['selectionLeadMinutes'] <= 180
                 and 0 <= policy['selectionRetryUntilMinutes'] < policy['selectionLeadMinutes']
                 and 1 <= policy['maxListingPages'] <= 10
                 and 0 <= policy['listingProviderHeadroom'] < 25
                 and all(address(token) == token for token in policy['referenceTokens'])
                 and all(type(entry['decimals']) is int and 0 <= entry['decimals'] <= 36
                         for entry in policy['referenceTokens'].values())
                 and _chain_valid(policy)
                 and all(address(token) == token for token in policy['reviewedTokens'])
                 and 0 < Fraction(policy['referenceDepth']['bandPercent']) < 100
                 and 1 <= policy['referenceDepth']['maxSteps'] <= 2048
                 and 1 <= policy['minPublishable'] <= policy['size']
                 and 1 <= policy['validHours'] <= 72
                 and 24 <= policy['persistenceLookbackHours'] <= 72
                 and policy['diversity'] == {'perNonReferenceToken': 1, 'keep': 'deepest',
                                             'maxMajorPairs': policy['diversity']['maxMajorPairs']}
                 and 0 <= policy['diversity']['maxMajorPairs'] <= policy['size']
                 and all(_decimal_string(policy['thresholds'][name]) for name in ('minVolume24hUsd', 'minTvlUsd'))
                 and all(policy['thresholds'][name] is None or _decimal_string(policy['thresholds'][name])
                         for name in OPTIONAL_DECIMALS)
                 and all(policy['thresholds'][name] is None or (type(policy['thresholds'][name]) is int
                                                                 and policy['thresholds'][name] >= 0)
                         for name in OPTIONAL_INTEGERS)
                 and policy['rankBy'] in RANKINGS and type(policy['persistence']) is bool
                 # Ranking by the previous evaluation needs one for every eligible pool.
                 and (policy['persistence'] or policy['rankBy'] == 'fresh')
                 and type(policy['fill']) is list and len(set(policy['fill'])) == len(policy['fill'])
                 and set(policy['fill']) <= set(FILLS)
                 and 0 < Decimal(policy['hysteresis']['incumbentFloorFactor']) <= 1
                 and Decimal(policy['hysteresis']['challengerMargin']) >= 1
                 and type(policy['hysteresis']['maxRankedSwapsPerDay']) is int
                 and 0 <= policy['hysteresis']['maxRankedSwapsPerDay'] <= policy['size'])
    except (KeyError, TypeError, ValueError, InvalidOperation, ZeroDivisionError, AttributeError, DataError):
        valid = False
    if not valid:
        raise DataError('invalid_featured_policy')


def _decimal_string(value):
    return type(value) is str and len(value) <= 224 and DECIMAL_STRING.fullmatch(value) is not None


def _chain_valid(policy):
    """Robinhood's policy prices ETH from its ETH/USDG pool and names no chain. A chain's names its id, its profile,
    its stable among the reference tokens and its GeckoTerminal network with one label per Uniswap version, and
    prices its native currency as its profile says (the Chainlink feed, or the pool it names), so it names no pool.
    featured_chains checks it against the profile."""
    chain = policy.get('chain')
    if chain is None:
        return bytes32(policy['ethUsdPricePool']) == policy['ethUsdPricePool']
    gecko = chain['geckoTerminal']
    versions = list(gecko['dexes'].values())
    return (set(chain) == {'chainId', 'profile', 'stable', 'geckoTerminal'} and policy['ethUsdPricePool'] is None
            and type(chain['chainId']) is int and 0 < chain['chainId'] < 2**63
            and re.fullmatch(r'[a-z][a-z0-9]{0,31}-' + str(chain['chainId']), chain['profile']) is not None
            and address(chain['stable']) == chain['stable'] and chain['stable'] in policy['referenceTokens']
            and set(gecko) == {'network', 'dexes'} and GECKO_NETWORK.fullmatch(gecko['network']) is not None
            and type(gecko['dexes']) is dict and 1 <= len(versions) <= 2 and len(set(versions)) == len(versions)
            and all(type(version) is int and version in (DEX_V3, DEX_V4) for version in versions)
            and all(GECKO_DEX.fullmatch(label) is not None for label in gecko['dexes']))


def stable_of(policy):
    """The reference token a depth or a major pair counts in dollars: the chain's stable, or Robinhood's USDG."""
    chain = policy.get('chain')
    if chain is not None:
        return chain['stable']
    return next((token for token, entry in policy['referenceTokens'].items()
                 if entry['symbol'] == ROBINHOOD_STABLE_SYMBOL), None)


def dex_labels(policy):
    """{the provider's DEX label: the Uniswap version it lists} for the policy's chain."""
    chain = policy.get('chain')
    return dict(chain['geckoTerminal']['dexes']) if chain is not None else dict(ROBINHOOD_DEX_LABELS)


def protocol_fee_reason(pool):
    """Why a pool's protocol fee keeps it out, or None. v4 takes up to 1000 pips per direction before the LP fee;
    v3 takes 1/N of the swap fee per input token. A fee that differs by direction has no well-defined share of a
    volume reported for both directions (pool_apr)."""
    protocol = pool['protocolFeeRaw']
    if pool.get('dex', DEX_V4) == DEX_V3:
        sides = (protocol & 0xf, protocol >> 4)
        # The high side keeps every bit above the low four: a value past a byte is no denominator.
        if any(side not in V3_PROTOCOL_DENOMINATORS for side in sides):
            return 'invalid_protocol_fee'
        return 'protocol_fee_directional_unsupported' if sides[0] != sides[1] else None
    if (protocol & 0xfff) > 1000 or (protocol >> 12) > 1000:
        return 'invalid_protocol_fee'
    return 'protocol_fee_directional_unsupported' if (protocol & 0xfff) != (protocol >> 12) else None


def policy_version(policy, overrides):
    """featured-v1: plus 12 hex of the defaults and the overrides in force."""
    return 'featured-v1:' + digest({'policy': policy, 'overrides': overrides})[:12]


# ------------------------------------------------------------------ depth
def band_bound(sqrt_price, band, *, zero_for_one):
    """The square-root price at which the non-reference side is `band` cheaper.

    Selling the non-reference currency moves the price toward it: down when
    it is currency0 (the reference is currency1), up otherwise. The bound is
    the same fraction of the price either way, so neither side's depth
    depends on which address sorts first.
    """
    keep = 1 - band
    square = sqrt_price * sqrt_price
    bound = (isqrt(square * keep.numerator // keep.denominator) if zero_for_one
             else isqrt(square * keep.denominator // keep.numerator))
    return min(max(bound, MIN_SQRT), MAX_SQRT - 1)


def reference_depth(bitmap, tick_net, *, sqrt_price, tick, liquidity, tick_spacing,
                    reference_is_currency1, band, max_steps):
    """Raw reference currency the pool releases before the band is crossed.

    The pool's own liquidity is walked tick by tick, as the core would when
    someone sells the other currency into it: a narrow position at the price
    counts only for its width, not for the whole band. `bitmap(word)` and
    `tick_net(tick)` read the pool at one block. None when the walk needs more
    steps than `max_steps`: the depth is then unmeasured, not assumed.
    """
    zero_for_one = reference_is_currency1
    bound = band_bound(sqrt_price, band, zero_for_one=zero_for_one)
    currency = 1 if zero_for_one else 0
    price, amount, steps = sqrt_price, 0, 0
    while price != bound:
        steps += 1
        if steps > max_steps:
            return None
        next_tick, initialized = _next_initialized(bitmap, tick, tick_spacing, zero_for_one)
        next_tick = max(MIN_TICK, min(MAX_TICK, next_tick))
        next_price = sqrt_at_tick(next_tick)
        target = max(next_price, bound) if zero_for_one else min(next_price, bound)
        if target != price:
            amount += amount_delta(price, target, max(0, liquidity), currency, False)
            price = target
        if price == bound:
            break
        if initialized:
            net = tick_net(next_tick)
            liquidity += -net if zero_for_one else net
        tick = next_tick - 1 if zero_for_one else next_tick
    return amount


def eth_usd(sqrt_price, eth_decimals=18, usdg_decimals=6):
    """USDG per ETH from the ETH/USDG pool's spot (ETH is currency0)."""
    return Fraction(sqrt_price * sqrt_price, Q96 * Q96) * Fraction(10 ** eth_decimals, 10 ** usdg_decimals)


def depth_usd(raw_amount, reference, policy, eth_price):
    decimals = policy['referenceTokens'][reference]['decimals']
    price = Fraction(1) if reference == stable_of(policy) else eth_price
    if price is None:
        return None
    return Fraction(raw_amount, 10 ** decimals) * price


def provider_price_deviation(listing, market, pool, decimals):
    """|provider price - pool spot| / pool spot, in the provider's base/quote; None if unknown.

    For a new token the provider prices it from this same pool, so this only
    checks coherence: a wrong pool, a stale page or a unit error.
    """
    provider = _decimal((listing or {}).get('baseTokenPriceQuoteToken'))
    if provider is None or market is None:
        return None
    currency0, currency1 = pool['currencies']
    if decimals.get(currency0) is None or decimals.get(currency1) is None:
        return None
    sqrt = int(pool['sqrtPriceX96'])
    spot = Fraction(sqrt * sqrt, Q96 * Q96) * Fraction(10 ** decimals[currency0], 10 ** decimals[currency1])
    if market['baseToken'] == currency1:
        spot = 1 / spot
    gap = abs(Fraction(provider) - spot) / spot
    return str(Decimal(gap.numerator) / Decimal(gap.denominator))


# ------------------------------------------------------------------ tokens
def token_reasons(evidence, policy, *, published_readings, excluded_tokens=()):
    """TA-1 to TA-6 for the non-reference token; reasons in rule order.

    `published_readings` maps each symbol reading already shown (by a pin, a
    reference token or an earlier list) to the one address allowed to read so.
    """
    token = evidence['address']
    reviewed = token in policy['reviewedTokens']
    if not evidence.get('code'):
        return ['token_no_code']
    reasons = []
    symbol, decimals = evidence.get('symbol'), evidence.get('decimals')
    if type(decimals) is not int or not 0 <= decimals <= 36 or not isinstance(symbol, str) or not symbol:
        reasons.append('token_metadata_unreadable')
    elif (not 1 <= len(symbol) <= 32
          or any(ch.isspace() or unicodedata.category(ch) in ('Cc', 'Cf') for ch in symbol)
          or any(text in symbol.upper() for text in UNSAFE_SYMBOL_TEXT)):
        reasons.append('token_symbol_unsafe')
    if isinstance(symbol, str) and symbol:
        reading = symbol_reading(symbol)
        references = {symbol_reading(entry['symbol']) for entry in policy['referenceTokens'].values()}
        owner = published_readings.get(reading)
        if reading in references or (owner is not None and owner != token):
            reasons.append('token_lookalike')
        if reading in {symbol_reading(value) for value in policy['forbiddenSymbols']}:
            reasons.append('token_symbol_forbidden')
        elif reading in {symbol_reading(value) for value in policy['protectedSymbols']} and not reviewed:
            reasons.append('token_protected_unreviewed')
    if evidence.get('proxy') and policy['rejectUpgradeableTokens'] and not reviewed:
        reasons.append('token_upgradeable_unreviewed')
    baseline = evidence.get('baselineCodeHash')
    if baseline is not None and baseline != evidence.get('codeHash'):
        reasons.append('token_code_changed')
    if policy['requireReviewedTokens'] and not reviewed:
        reasons.append('token_unreviewed')
    if token in excluded_tokens:
        reasons.append('excluded_by_owner')
    return reasons


# ------------------------------------------------------------------ pools
def _decimal(value):
    if value is None:
        return None
    try:
        return Decimal(value)
    except (InvalidOperation, TypeError, ValueError):
        return None


def reference_side(currencies, policy):
    """(reference currency, other currency, major pair?) or a reason."""
    references = policy['referenceTokens']
    c0, c1 = currencies
    if [c0, c1] in [sorted(pair) for pair in policy['sameAssetPairs']]:
        return None, 'same_asset_pair'
    if c0 in references and c1 in references:
        # Both sides are reference assets: the depth that matters is the dollar side.
        dollar = [token for token in (c0, c1) if token == stable_of(policy)]
        reference = dollar[0] if dollar else c1
        return (reference, c0 if reference == c1 else c1, True), None
    if c1 in references:
        return (c1, c0, False), None
    if c0 in references:
        return (c0, c1, False), None
    return None, 'no_reference_side'


def screen(market, listing, created_at, policy, *, now, relaxed=False):
    """The market rules a provider observation fails on its own, before any chain read.

    E10, E11, E14, E15, E16, E17a and E18a read only provider fields; the
    selector uses this to skip the chain work for pools that cannot pass, and
    `evaluate` applies the very same function to every candidate it reads.
    """
    thresholds, reasons, listing = policy['thresholds'], [], listing or {}
    factor = Decimal(policy['hysteresis']['incumbentFloorFactor']) if relaxed else Decimal(1)
    volume = _decimal(market.get('volume24hUsd')) if market else None
    tvl = _decimal(market.get('reportedLiquidityUsd')) if market else None
    if volume is None or volume < Decimal(thresholds['minVolume24hUsd']) * factor:
        reasons.append('volume_below_floor')
    if tvl is None or tvl < Decimal(thresholds['minTvlUsd']) * factor:
        reasons.append('tvl_below_floor')
    turnover = thresholds['maxTurnover24h']
    if turnover is not None and volume is not None and tvl is not None and tvl > 0 and volume / tvl > Decimal(turnover):
        reasons.append('turnover_above_ceiling')
    if thresholds['minPoolAgeHours'] is not None:
        if created_at is None:
            reasons.append('age_unknown')
        elif now - created_at < thresholds['minPoolAgeHours'] * HOURS:
            reasons.append('pool_too_young')
    traders, swaps = thresholds['minTraders24h'], thresholds['minSwaps24h']
    if traders is not None or swaps is not None:
        trades = listing.get('transactions24h')
        if (trades is None or (traders is not None and trades['buyers'] + trades['sellers'] < traders)
                or (swaps is not None and trades['buys'] + trades['sells'] < swaps)):
            reasons.append('activity_below_floor')
    share, recent = thresholds['minH6ShareOfH24'], _decimal(listing.get('volume6hUsd'))
    # Without a 24 h volume E10 already fails; the share is then undefined.
    if share is not None and volume is not None and (recent is None or recent < volume * Decimal(share)):
        reasons.append('volume_faded')
    move, change = thresholds['maxAbsPriceChange24hPercent'], _decimal(listing.get('priceChange24hPercent'))
    if move is not None and change is not None and abs(change) > Decimal(move):
        reasons.append('price_move_outlier')
    return reasons, volume, tvl


def collapses(volume, tvl, policy):
    """The COLLAPSE conditions a 24 h volume and a reported TVL show; a figure that is unknown shows none."""
    figures = {'tvl_collapse': tvl, 'volume_collapse': volume}
    return {condition for condition, (floor, divisor) in COLLAPSE.items()
            if figures[condition] is not None and figures[condition] < Decimal(policy['thresholds'][floor]) / divisor}


def evaluate(candidate, policy, *, now, previous, relaxed=False, excluded_pools=(), excluded_tokens=(),
             published_readings=None):
    """Every rule a candidate fails, in rule order, plus the figures that rank it.

    `candidate` is what the selector gathered: `market` and `listing` from the
    provider, `chain` (the verified pool, its active liquidity, or an identity
    error), `estimate`, `depth` and `token`. `previous` maps pool ids to the
    most recent successful evaluation within the persistence lookback.
    `relaxed` applies the incumbent discount to the E10-E12 floors.
    """
    pool_id = candidate['poolId']
    thresholds, reasons = policy['thresholds'], []
    chain, market, listing = candidate.get('chain') or {}, candidate.get('market'), candidate.get('listing') or {}
    pool = chain.get('pool')
    reference = other = None
    major = False
    if pool is None:
        reasons.append(chain.get('error') if chain.get('error') in SAFETY else 'identity_unresolved')
    else:
        key = pool['poolKey']
        if market is not None and (market['currencies'] != pool['currencies'] or
                                   sorted((market['baseToken'], market['quoteToken'])) != pool['currencies']):
            reasons.append('provider_currency_or_pool_mismatch')
        # The provider's label must list the pool's own Uniswap version on this chain.
        if market is not None and dex_labels(policy).get(market.get('dexLabel')) != pool.get('dex', DEX_V4):
            reasons.append('provider_dex_unconfirmed')
        if key['hooks'] != ZERO:
            reasons.append('hooked_pool_unsupported')
        if key['fee_pips'] == DYNAMIC_FEE or key.get('feeMode') == 'dynamic':
            reasons.append('dynamic_fee_unsupported')
        elif key['fee_pips'] != pool['currentLpFeePips']:
            reasons.append('fixed_fee_mismatch')
        # A pool with no fee earns its LPs nothing, and its volume costs nothing to make:
        # zero-fee pools ranked on wash volume from 16 to 25 Oct 2026.
        elif not 0 < key['fee_pips'] < 1_000_000:
            reasons.append('fee_out_of_range')
        protocol = protocol_fee_reason(pool)
        if protocol:
            reasons.append(protocol)
        side, problem = reference_side(pool['currencies'], policy)
        if problem:
            reasons.append(problem)
        else:
            reference, other, major = side
    token = candidate.get('token')
    if other is not None and not major:
        if token is None or token.get('address') != other:
            reasons.append('token_metadata_unreadable')
        else:
            reasons.extend(token_reasons(token, policy, published_readings=published_readings or {},
                                         excluded_tokens=excluded_tokens))
    if pool_id in excluded_pools and 'excluded_by_owner' not in reasons:
        reasons.append('excluded_by_owner')
    estimate = candidate.get('estimate')
    fresh = _decimal(estimate.get('feeAprEstimate24hPercent')) if estimate else None
    if estimate is None or estimate.get('status') != 'available' or fresh is None:
        reasons.append('estimate_not_available')
    if pool is not None and not chain.get('liquidity', 0) > 0:
        reasons.append('no_active_liquidity')

    factor = Decimal(policy['hysteresis']['incumbentFloorFactor']) if relaxed else Decimal(1)
    screened, volume, tvl = screen(market, listing, (candidate.get('age') or {}).get('createdAt'), policy,
                                   now=now, relaxed=relaxed)
    reasons.extend(screened)
    depth = candidate.get('depth') or {}
    depth_value, depth_floor = _decimal(depth.get('usd')), thresholds['minReferenceDepthUsd']
    if depth_floor is not None:
        if depth.get('status') != 'measured' or depth_value is None:
            reasons.append('reference_depth_unmeasurable')
        elif depth_value < Decimal(depth_floor) * factor:
            reasons.append('reference_depth_below_floor')
    before = previous.get(pool_id) if previous else None
    prior = _decimal(before.get('freshApr')) if before else None
    ceiling = thresholds['maxAprPercent']
    if (ceiling is not None and fresh is not None
            and max(fresh, prior if prior is not None else fresh) > Decimal(ceiling)):
        reasons.append('apr_above_ceiling')
    if policy['persistence'] and not (before and before.get('eligibleExceptPersistence')):
        reasons.append('not_persistent')
    deviation, limit = candidate.get('providerPriceDeviation'), thresholds['maxProviderPriceDeviation']
    if limit is not None and deviation is not None and _decimal(deviation) > Decimal(limit):
        reasons.append('provider_price_disagreement')
    reasons.sort(key=REASONS.index)

    safe = not any(reason in SAFETY for reason in reasons)
    market_reasons = [reason for reason in reasons if reason in MARKET]
    if policy['rankBy'] == 'fresh':
        rank = fresh
    else:
        rank = min(fresh, prior) if fresh is not None and prior is not None else None
    return {
        'poolId': pool_id, 'reasons': reasons, 'safe': safe,
        'eligible': safe and not market_reasons,
        'eligibleExceptPersistence': safe and all(reason == 'not_persistent' for reason in market_reasons),
        'relaxed': relaxed, 'freshApr': str(fresh) if fresh is not None else None,
        'prevApr': str(prior) if prior is not None else None,
        'rankApr': str(rank) if rank is not None else None,
        'volume24hUsd': str(volume) if volume is not None else None,
        'reportedLiquidityUsd': str(tvl) if tvl is not None else None,
        'referenceDepthUsd': depth.get('usd'),
        'reference': reference, 'token': other, 'major': major,
        'symbolReading': symbol_reading(token['symbol']) if token and isinstance(token.get('symbol'), str)
                         and token.get('address') == other and not major else None,
    }


# ------------------------------------------------------------------ compose
def rank_key(evaluation):
    """rankApr, then 24 h volume, then liquidity, all descending; then pool id."""
    return (-Decimal(evaluation['rankApr']), -Decimal(evaluation['volume24hUsd']),
            -Decimal(evaluation['reportedLiquidityUsd']), evaluation['poolId'])


def _depth_key(evaluation):
    return (-Decimal(evaluation['reportedLiquidityUsd'] or 0),) + rank_key(evaluation)[1:]


class Diversity:
    """One pool per non-reference token, at most `maxMajorPairs` pools with two
    reference sides, and no two tokens whose symbols read alike."""
    def __init__(self, policy, taken=()):
        self.max_major = policy['diversity']['maxMajorPairs']
        self.tokens, self.readings, self.majors = {}, {}, 0
        for item in taken:
            self.take(item)

    def reason(self, item):
        if item['major']:
            return 'diversity_major_pair' if self.majors >= self.max_major else None
        if item['token'] in self.tokens:
            return 'diversity_same_token'
        owner = self.readings.get(item['symbolReading'])
        if item['symbolReading'] and owner is not None and owner != item['token']:
            return 'token_symbol_duplicate'
        return None

    def take(self, item):
        if item['major']:
            self.majors += 1
        else:
            self.tokens[item['token']] = item['poolId']
            if item['symbolReading']:
                self.readings[item['symbolReading']] = item['token']


def _holds(item, policy):
    """A fallback the health check would keep: its 24 h volume and TVL known, and neither collapsed."""
    volume, tvl = _decimal(item.get('volume24hUsd')), _decimal(item.get('reportedLiquidityUsd'))
    return volume is not None and tvl is not None and not collapses(volume, tvl, policy)


def refill(kept, evaluations, policy, *, embedded=(), ready=lambda pool_id: True):
    """Pools that complete a repaired list, each ready and admissible beside those kept.

    The day's eligible pools come in the order `compose` chooses them: the
    deepest pool per token and per major pair, then by rankApr. On 30 Oct 2026
    a walk by rankApr put the 0.01% ETH/USDG pool (US$ 250k) where the
    selection keeps the deepest. A pool chosen so that is not ready yet keeps
    its token's or major pair's place: the list stays short until it is ready
    (it is kept warm as a candidate) rather than take a shallower pool. Then
    the embedded list's safe pools whose figures the health check would keep.
    """
    slots = policy['size'] - len(kept)
    if slots <= 0:
        return []
    by_id = {item['poolId']: item for item in evaluations}
    diversity, listed = Diversity(policy, [by_id[pool_id] for pool_id in kept if pool_id in by_id]), set(kept)
    # Diversity picks the deepest pool per token before any ranking, as in compose.
    chosen = []
    for item in sorted((item for item in evaluations if item['eligible']), key=_depth_key):
        if item['poolId'] not in listed and not diversity.reason(item):
            diversity.take(item)
            chosen.append(item)
    added = []
    for item in sorted(chosen, key=rank_key):
        if len(added) >= slots:
            break
        if ready(item['poolId']):
            listed.add(item['poolId'])
            added.append({'poolId': item['poolId'], 'source': 'ranked'})
    for pool_id in embedded:
        if len(added) >= slots:
            break
        item = by_id.get(pool_id)
        if (pool_id in listed or item is None or not item['safe'] or not _holds(item, policy)
                or diversity.reason(item) or not ready(pool_id)):
            continue
        diversity.take(item)
        listed.add(pool_id)
        added.append({'poolId': pool_id, 'source': 'fallback'})
    return added


def compose(evaluations, policy, *, previous_list, pins=(), embedded=()):
    """The day's list from eligible pools, the previous list and the owner's pins.

    Order of operations (featured-pools v1 §6.3):
    1. pins in their declared slots, if they pass every safety rule;
    2. diversity: one pool per non-reference token (the deepest), a pinned
       token keeps its place, at most `maxMajorPairs` pools with two reference
       sides, and no two tokens that read alike;
    3. hysteresis: incumbents that stay eligible keep their place; free slots
       go to the best newcomers without counting as swaps; then a newcomer
       replaces the weakest incumbent only above `challengerMargin` times its
       rankApr, at most `maxRankedSwapsPerDay` times;
    4. ranked pools fill the other slots by rankApr;
    5. short lists are completed, in the order `fill` names, with incumbents
       that are still safe (carried) and the embedded list's safe pools whose
       figures the health check would keep (fallback).
    Fewer than `minPublishable` pinned or ranked pools keeps the previous list.
    """
    size, hysteresis = policy['size'], policy['hysteresis']
    if (len(pins) > policy['maxPins'] or len({pin['slot'] for pin in pins}) != len(pins)
            or len({pin['poolId'] for pin in pins}) != len(pins)
            or any(type(pin['slot']) is not int or not 1 <= pin['slot'] <= size for pin in pins)):
        raise DataError('invalid_featured_pins')
    by_id = {item['poolId']: item for item in evaluations}
    dropped = []
    pinned = {}
    for pin in pins:
        item = by_id.get(pin['poolId'])
        if item is None or not item['safe']:
            dropped.append({'poolId': pin['poolId'], 'reason': 'pin_failed_safety'})
        else:
            pinned[pin['slot']] = item
    diversity = Diversity(policy, pinned.values())
    admissible, take = diversity.reason, diversity.take

    pinned_ids = {item['poolId'] for item in pinned.values()}
    eligible = [item for item in evaluations if item['eligible'] and item['poolId'] not in pinned_ids]
    # Diversity picks the deepest pool per token before any ranking.
    ranked = []
    for item in sorted(eligible, key=_depth_key):
        reason = admissible(item)
        if reason:
            dropped.append({'poolId': item['poolId'], 'reason': reason})
            continue
        take(item)
        ranked.append(item)
    ranked.sort(key=rank_key)
    incumbent_ids = [entry['poolId'] for entry in previous_list]
    slots = size - len(pinned)
    kept = [item for item in ranked if item['poolId'] in incumbent_ids][:slots]
    newcomers = [item for item in ranked if item['poolId'] not in incumbent_ids]
    chosen = list(kept)
    fill = newcomers[:max(0, slots - len(chosen))]
    chosen += fill
    waiting = newcomers[len(fill):]
    swaps = 0
    margin = Decimal(hysteresis['challengerMargin'])
    while waiting and swaps < hysteresis['maxRankedSwapsPerDay']:
        incumbents = [item for item in chosen if item['poolId'] in incumbent_ids]
        if not incumbents:
            break
        weakest = max(incumbents, key=rank_key)
        challenger = waiting[0]
        if not Decimal(challenger['rankApr']) > margin * Decimal(weakest['rankApr']):
            break
        chosen[chosen.index(weakest)] = challenger
        waiting.pop(0)
        dropped.append({'poolId': weakest['poolId'], 'reason': 'replaced_by_challenger'})
        swaps += 1
    chosen.sort(key=rank_key)
    for item in waiting:
        dropped.append({'poolId': item['poolId'], 'reason': 'below_hysteresis'})
    entries = [{'poolId': item['poolId'], 'source': 'ranked'} for item in chosen]
    listed = pinned_ids | {item['poolId'] for item in chosen}
    sources = {'carried': incumbent_ids, 'fallback': embedded}
    for source in policy['fill']:
        for pool_id in sources[source]:
            if len(entries) + len(pinned) >= size:
                break
            item = by_id.get(pool_id)
            if pool_id in listed or item is None or not item['safe'] or admissible(item):
                continue
            # A fallback the health check would withdraw within hours does not complete the list.
            if source == 'fallback' and not _holds(item, policy):
                continue
            take(item)
            listed.add(pool_id)
            entries.append({'poolId': pool_id, 'source': source})
    pools, rest = [], iter(entries)
    for slot in range(1, size + 1):
        if slot in pinned:
            pools.append({'slot': slot, 'poolId': pinned[slot]['poolId'], 'source': 'pinned'})
        else:
            entry = next(rest, None)
            if entry is not None:
                pools.append({'slot': slot, **entry})
    pools = [{**entry, 'slot': index} for index, entry in enumerate(pools, start=1)]
    publishable = sum(1 for entry in pools if entry['source'] in ('pinned', 'ranked'))
    return {'status': 'current' if publishable >= policy['minPublishable'] else 'carried_over',
            'pools': pools, 'rankedSwaps': swaps, 'dropped': dropped}


def list_id(pools):
    """sha256 of what identifies a list: its pools in order, never its times or figures."""
    fields = ('slot', 'source', 'poolId', 'poolKey', 'tokens', 'integrationClass')
    return '0x' + digest([{name: entry.get(name) for name in fields} for entry in pools])
