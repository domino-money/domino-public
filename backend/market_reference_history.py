"""Read-only canonical asset reference history; never a qualified price feed.

The address mappings select a provider reference asset. They do not admit tokens,
verify historical wrapper/bridge state, or establish event-time USD valuation.
"""
from dataclasses import dataclass

from chainlink_history import USDG, WETH
from discovery import CHAIN_ID, ZERO, DataError, address
from price_history import AlchemyHistorical, iso, timestamp, usd

SOURCE = 'alchemy_canonical_market_reference_v1'
ADAPTER_VERSION = 1
INTERVAL_SECONDS = 300
MAX_WINDOW_SECONDS = 86400 + INTERVAL_SECONDS
MAX_ROWS = MAX_WINDOW_SECONDS // INTERVAL_SECONDS + 1


@dataclass(frozen=True)
class Reference:
    expected_decimals: int
    mapping: str
    ethereum_address: str | None = None

    def identity(self):
        return ({'network': 'eth-mainnet', 'address': self.ethereum_address}
                if self.ethereum_address else {'symbol': 'ETH'})


# This is a reference adapter's identity map, never an application token list.
# Values are selected by reviewed chain/address, never user/provider token text.
REFERENCES = {
    ZERO: Reference(18, 'native_ethereum_reference'),
    WETH: Reference(18, 'canonical_weth_ethereum_reference',
                    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    USDG: Reference(6, 'canonical_usdg_global_dollar_reference',
                    '0xe343167631d89b6ffc58b88d6b7fb0228795491d'),
}

_SAFE_TRANSPORT_REASONS = frozenset({
    'network_unavailable', 'invalid_json', 'response_too_large',
    'read_deadline_exhausted', 'provider_rate_limited',
    *(f'http_{code}' for code in (400, 401, 403, 404, 408, 429, 500, 502, 503, 504)),
})


def _coverage(rows, start, end, missing_values):
    times = [row['timestamp'] for row in rows]
    expected = set(range(((start + 299) // 300) * 300, end + 1, 300)) | {start, end}
    missing = sorted(expected - set(times))
    return {
        'status': ('missing' if not times else 'incomplete' if missing else 'observed_grid_complete'),
        'diagnosticBasis': 'utc_5m_grid_and_requested_boundaries',
        'startTimestamp': start, 'endTimestamp': end,
        'observationCount': len(times), 'expectedTimestampCount': len(expected),
        'firstTimestamp': times[0] if times else None,
        'lastTimestamp': times[-1] if times else None,
        'largestObservedGapSeconds': max((b-a for a, b in zip(times, times[1:])), default=None),
        'missingGridTimestamps': missing,
        'nullPriceTimestamps': sorted(missing_values),
        'unalignedObservationTimestamps': [at for at in times if at % INTERVAL_SECONDS],
        'causalEventTimeCoverage': 'unqualified',
        'interpolationApplied': False,
    }


class CanonicalMarketHistorical(AlchemyHistorical):
    """Reuse the existing validated private endpoint and bounded HTTP transport.

    A fetch makes exactly one request. No fallback to an arbitrary token symbol,
    pagination, database, source registry, current-price fill, or RPC is used.
    """

    def fetch(self, currency, start, end):
        currency = address(currency)
        if currency not in REFERENCES:
            raise DataError('canonical_market_currency_unsupported')
        now = self.clock()
        if (type(now) not in (int, float) or not 0 <= now < 253402300800 or
                type(start) is not int or type(end) is not int or
                not 0 <= start < end <= now or end-start > MAX_WINDOW_SECONDS):
            raise DataError('invalid_price_history_bounds')
        now, reference = int(now), REFERENCES[currency]
        identity = reference.identity()
        request = {**identity, 'startTime': iso(start), 'endTime': iso(end), 'interval': '5m'}
        try:
            result = self.transport(self.url, request)
        except Exception as error:
            # Injected transports can carry URLs and response bodies in errors.
            reason = str(error) if isinstance(error, DataError) else None
            raise DataError(reason if reason in _SAFE_TRANSPORT_REASONS else
                            'market_reference_provider_unavailable') from None
        if not isinstance(result, dict):
            raise DataError('invalid_price_history_response')
        if result.get('error') is not None:
            raise DataError('market_reference_provider_error')
        if result.get('currency') != 'usd':
            raise DataError('price_response_currency_mismatch')
        if (any(result.get(key) != value for key, value in identity.items()) or
                any(result.get(key) is not None for key in {'symbol', 'network', 'address'} - identity.keys())):
            raise DataError('price_response_asset_mismatch')
        data = result.get('data')
        if not isinstance(data, list):
            raise DataError('invalid_price_history_response')
        if len(data) > MAX_ROWS:
            raise DataError('price_observation_budget_exhausted')
        seen, values = {}, {}
        for entry in data:
            if (not isinstance(entry, dict) or 'value' not in entry or
                    entry.get('error') is not None):
                raise DataError('invalid_price_history_response')
            at = timestamp(entry.get('timestamp'))
            if not start <= at <= end:
                raise DataError('price_outside_requested_window')
            raw = entry['value']
            value = None if raw is None else usd(raw)
            if at in seen and seen[at] != value:
                raise DataError('conflicting_price_observation')
            if at not in seen:
                seen[at], values[at] = value, raw
        provenance = {
            'provider': 'alchemy', 'adapterVersion': ADAPTER_VERSION,
            'requestIdentity': identity, 'currencyMapping': reference.mapping,
            'expectedCurrencyDecimals': reference.expected_decimals,
            'historicalCurrencyDecimalsVerified': False,
            'providerIdentityEvidence': ('network_address_echo' if reference.ethereum_address
                                         else 'symbol_echo_only'),
            'referenceScope': ('crosschain_market_reference' if reference.ethereum_address
                               else 'native_asset_market_reference'),
            'robinhoodExecutablePriceQualified': False,
            'intervalSeconds': INTERVAL_SECONDS,
            'status': 'external_observation_unqualified',
            'targetPoolIndependenceVerified': False,
            'sourceComposition': 'unqualified',
            'bucketTimestampSemantics': 'unqualified',
            'pointTimestampSemanticsQualified': False,
        }
        rows = [{'chainId': CHAIN_ID, 'currency': currency, 'source': SOURCE,
                 'timestamp': at, 'retrievedAt': now, 'priceUsd': values[at],
                 'provenance': dict(provenance)}
                for at in sorted(seen) if seen[at] is not None]
        return {
            'schemaVersion': 1, 'mode': 'bounded_canonical_market_reference_probe',
            'source': SOURCE, 'chainId': CHAIN_ID, 'currency': currency,
            'retrievedAt': now,
            'reference': provenance, 'observations': rows,
            'rowsReceived': len(data), 'duplicateRows': len(data)-len(seen),
            'status': 'observed_unqualified' if rows else 'unavailable',
            'coverage': _coverage(rows, start, end, [at for at in seen if seen[at] is None]),
            'sourceQualified': False, 'productionQualified': False,
            'executionAvailable': False, 'walletAccessed': False,
            'observationsSaved': False, 'tvlUsd': None, 'feeApr24h': None,
        }
