"""Internal event-time USD valuation from the existing production price registry.

This adapter reads stored observations only. It does not qualify a provider,
authenticate an epoch, classify earnings or establish complete managed capital.
The collector supplies each complete, reconciled component's currency amounts
and splits balance/membership changes. Price changes and stale gaps are handled
here, with exact Fractions and no reference-only or pool-derived fallback.
"""
from bisect import bisect_right
from dataclasses import dataclass
from fractions import Fraction
from types import MappingProxyType
import re

from discovery import CHAIN_ID, DataError, address, bytes32
import price_history as ph
from read_deadline import check_read_deadline

MAX_CURRENCIES = 16
MAX_PIECES = 4096
MAX_DECIMAL_PLACES = 400
MAX_DECIMAL_CHARACTERS = 512
MAX_TIMESTAMP = 2**53-1


def exact_decimal(value):
    """Finite exact decimal for internal calculator inputs, never rounding.

    Token quantities scaled by integer decimals and decimal prices terminate.
    Time averages need not terminate and must remain Fractions until display.
    """
    if type(value) not in (int, Fraction):
        raise DataError('performance_exact_decimal_required')
    value = Fraction(value)
    if max(abs(value.numerator).bit_length(), value.denominator.bit_length()) > 4*(MAX_DECIMAL_CHARACTERS+MAX_DECIMAL_PLACES):
        raise DataError('performance_decimal_capacity_exceeded')
    denominator, twos, fives = value.denominator, 0, 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    if denominator != 1:
        raise DataError('performance_nonterminating_decimal')
    places = max(twos, fives)
    if places > MAX_DECIMAL_PLACES:
        raise DataError('performance_decimal_capacity_exceeded')
    scaled = abs(value.numerator) * 2**(places-twos) * 5**(places-fives)
    whole, fractional = divmod(scaled, 10**places)
    result = str(whole)
    if places:
        result += '.' + str(fractional).zfill(places).rstrip('0')
    if value < 0:
        result = '-' + result
    if len(result) > MAX_DECIMAL_CHARACTERS:
        raise DataError('performance_decimal_capacity_exceeded')
    return result


def _timestamp(value):
    if type(value) is not int or not 0 <= value <= MAX_TIMESTAMP:
        raise DataError('performance_invalid_valuation_time')
    return value


def _currency(value):
    normalized = address(value)
    if type(value) is not str or value != normalized:
        raise DataError('performance_invalid_currency')
    return normalized


def _raw(value):
    if type(value) is not str or not re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value) or int(value) >= 2**256:
        raise DataError('performance_invalid_raw_amount')
    return int(value)


@dataclass(frozen=True)
class Denomination:
    chain_id: int
    currency: str
    decimals: int
    quote: str = 'USD'


@dataclass(frozen=True)
class PricePoint:
    denomination: Denomination
    source: str
    qualification_evidence: str
    observed_at: int
    expires_at: int
    next_observation_at: int | None
    usd_per_token: Fraction


@dataclass(frozen=True)
class AmountValuation:
    currency: str
    raw: str
    timestamp: int
    status: str
    reason: str | None
    price: PricePoint | None
    value_usd: Fraction | None


@dataclass(frozen=True)
class CapitalPiece:
    starts_at: int
    ends_at: int
    value_usd: Fraction
    prices: tuple[PricePoint, ...]


@dataclass(frozen=True)
class CapitalValuation:
    starts_at: int
    ends_at: int
    currencies: tuple[str, ...]
    status: str
    reason: str | None
    pieces: tuple[CapitalPiece, ...]
    integral_usd_seconds: Fraction | None
    end_value_usd: Fraction | None


@dataclass(frozen=True)
class _Asset:
    qualification: ph.PriceQualification | None
    times: tuple[int, ...]
    values: tuple[Fraction, ...]
    unavailable_reason: str | None


def _qualification(currency, pool_id):
    value = ph.PRODUCTION_QUALIFICATIONS.get((pool_id, currency))
    if value is None:
        return None, 'price_source_quality_not_qualified'
    if getattr(value, 'reference_only', False):
        return None, 'reference_only_price_not_qualified'
    if type(value) is not ph.PriceQualification:
        return None, 'price_source_quality_not_qualified'
    # Revalidate even a frozen dataclass: object.__setattr__ can bypass its
    # constructor, and registry entries must retain their exact denominations.
    try:
        checked = ph.PriceQualification(value.currency, value.decimals, value.source,
            value.target_pool, value.evidence, value.max_age)
    except (DataError, TypeError, ValueError):
        return None, 'invalid_price_qualification'
    if (checked != value or value.currency != currency or value.target_pool != pool_id
            or type(value.source) is not str or type(value.evidence) is not str):
        return None, 'qualified_price_identity_mismatch'
    return checked, None


class ManagedValuation:
    """Factory-created, bounded snapshot; no supplied price/qualification flags.

    Inputs and results are private collector objects, not an HTTP schema. A
    registry revocation/change invalidates reuse. Epoch membership, raw holdings
    and their canonicality remain the collector's independent responsibility.
    """
    def __init__(self, pool_id, start, end, assets):
        self.pool_id, self.start, self.end = pool_id, start, end
        self.currencies = tuple(assets)
        self._assets = MappingProxyType(dict(assets))

    def _bounds(self, start, end):
        check_read_deadline()
        _timestamp(start); _timestamp(end)
        if not self.start <= start <= end <= self.end:
            raise DataError('performance_valuation_outside_window')

    def _asset(self, currency):
        currency = _currency(currency)
        if currency not in self._assets:
            raise DataError('performance_currency_not_loaded')
        asset = self._assets[currency]
        if asset.unavailable_reason:
            raise DataError(asset.unavailable_reason)
        qualification, reason = _qualification(currency, self.pool_id)
        if reason or qualification != asset.qualification:
            raise DataError('performance_price_qualification_changed')
        return asset

    def _point(self, currency, at):
        asset = self._asset(currency)
        index = bisect_right(asset.times, at)-1
        if index < 0 or at-asset.times[index] > asset.qualification.max_age:
            raise DataError('qualified_price_coverage_gap' if asset.times else 'price_history_missing')
        q = asset.qualification
        return PricePoint(Denomination(CHAIN_ID, currency, q.decimals), q.source, q.evidence,
            asset.times[index], asset.times[index]+q.max_age,
            asset.times[index+1] if index+1 < len(asset.times) else None, asset.values[index])

    def value_amount(self, currency, raw, timestamp):
        """A causal value at this instant; a separate capital gap need not hide it."""
        self._bounds(timestamp, timestamp)
        currency, amount = _currency(currency), _raw(raw)
        if currency not in self._assets:
            raise DataError('performance_currency_not_loaded')
        try:
            point = self._point(currency, timestamp)
        except DataError as error:
            return AmountValuation(currency, raw, timestamp, 'unavailable', str(error), None, None)
        value = Fraction(amount, 10**point.denomination.decimals)*point.usd_per_token
        return AmountValuation(currency, raw, timestamp, 'qualified', None, point, value)

    def boundaries(self, start, end):
        """Internal integer price/expiry boundaries, for union with balance changes.

        Boundaries alone are not coverage evidence; use interval valuation too.
        Unqualified assets contribute no manufactured timestamps.
        """
        self._bounds(start, end)
        bounds = set()
        for asset in self._assets.values():
            if asset.qualification:
                bounds.update(t for at in asset.times for t in (at, at+asset.qualification.max_age) if start < t < end)
        if len(bounds)+1 > MAX_PIECES:
            raise DataError('performance_price_boundary_budget_exhausted')
        return tuple(sorted(bounds))

    def value_capital_interval(self, raw_by_currency, start, end):
        """Value one unchanged complete component on [start,end), plus its endpoint.

        Every declared currency, including zero, needs a qualified feed. Native
        residual can be a third currency for an ERC20 pair. This method cannot
        detect an omitted asset or double counting across caller components.
        Both endpoints and every fractional interval must be covered; failure
        returns no partial integral or pieces. End-only price changes affect the
        endpoint value and contribute zero elapsed time to the integral.
        """
        self._bounds(start, end)
        if start == end:
            raise DataError('performance_zero_capital_duration')
        if type(raw_by_currency) is not dict or not 1 <= len(raw_by_currency) <= MAX_CURRENCIES:
            raise DataError('performance_invalid_capital_amounts')
        raw = {_currency(c): _raw(v) for c, v in raw_by_currency.items()}
        currencies = tuple(sorted(raw))
        if not set(currencies) <= set(self.currencies):
            raise DataError('performance_currency_not_loaded')
        try:
            bounds = {start, end}
            for currency in currencies:
                asset = self._asset(currency)
                self._point(currency, start); self._point(currency, end)
                bounds.update(t for at in asset.times for t in (at, at+asset.qualification.max_age) if start < t < end)
            if len(bounds)-1 > MAX_PIECES:
                raise DataError('performance_price_boundary_budget_exhausted')
            pieces, integral = [], Fraction()
            ordered = sorted(bounds)
            for a, b in zip(ordered, ordered[1:]):
                check_read_deadline()
                for currency in currencies:
                    self._point(currency, Fraction(a+b, 2))
                points = tuple(self._point(c, a) for c in currencies)
                value = sum((Fraction(raw[p.denomination.currency], 10**p.denomination.decimals)*p.usd_per_token
                             for p in points), Fraction())
                pieces.append(CapitalPiece(a, b, value, points))
                integral += value*(b-a)
            end_value = sum((Fraction(raw[c], 10**self._point(c, end).denomination.decimals)*self._point(c, end).usd_per_token
                             for c in currencies), Fraction())
        except DataError as error:
            if str(error) == 'read_deadline_exceeded':
                raise
            return CapitalValuation(start, end, currencies, 'unavailable', str(error), (), None, None)
        return CapitalValuation(start, end, currencies, 'qualified', None, tuple(pieces), integral, end_value)


def load_managed_valuation(conn, *, pool_id, currencies, start, end):
    """Read existing qualified series without acquiring prices or changing policy.

    The production registry is currently empty. Tests install explicitly
    synthetic registry entries; no observation flag can populate that registry.
    Reference-only qualifications are rejected before any series is constructed.
    """
    if type(pool_id) is not str or bytes32(pool_id) != pool_id:
        raise DataError('performance_invalid_pool_identity')
    _timestamp(start); _timestamp(end)
    if not start <= end or end-start > ph.MAX_PRICE_WINDOW_SECONDS:
        raise DataError('invalid_price_history_bounds')
    if type(currencies) not in (tuple, list) or not 1 <= len(currencies) <= MAX_CURRENCIES:
        raise DataError('performance_invalid_currency_set')
    checked = tuple(_currency(c) for c in currencies)
    if len(set(checked)) != len(checked):
        raise DataError('performance_invalid_currency_set')
    assets = {}
    for currency in sorted(checked):
        check_read_deadline()
        qualification, reason = _qualification(currency, pool_id)
        if reason:
            assets[currency] = _Asset(None, (), (), reason)
            continue
        series, _evidence = ph.load_price_series(conn, pool_id, [currency], start, end)
        check_read_deadline()
        actual = series[0]
        current, changed = _qualification(currency, pool_id)
        if (changed or current != qualification or type(actual) is not ph.PriceSeries
                or actual.qualification != qualification):
            assets[currency] = _Asset(None, (), (), 'performance_price_qualification_changed')
            continue
        # Preserve every causal observation; do not resample a dense series.
        assets[currency] = _Asset(qualification, tuple(actual.times), tuple(actual.values), None)
    return ManagedValuation(pool_id, start, end, assets)
