"""Offline evidence for canonical mappings, exact history and secret-safe reports."""
from contextlib import redirect_stdout
from copy import deepcopy
from fractions import Fraction
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chainlink_history import USDG, WETH
from discovery import CHAIN_ID, ZERO, DataError
from market_reference_history import CanonicalMarketHistorical, MAX_ROWS, MAX_WINDOW_SECONDS, REFERENCES, SOURCE
from price_history import OBSERVATION_SOURCES, PRODUCTION_QUALIFICATIONS, iso, usd
import qualify_market_reference as cli

SECRET = 'synthetic-provider-secret'
RPC = 'https://robinhood-mainnet.g.alchemy.com/v2/' + SECRET
OTHER = '0x' + 'ab' * 20


def response(currency=ZERO, values=None):
    values = [(300, '1'), (600, '1.1'), (900, '0.99')] if values is None else values
    return {**REFERENCES[currency].identity(), 'currency': 'usd',
            'data': [{'timestamp': iso(at), 'value': value} for at, value in values]}


class CanonicalMarketHistoryTests(unittest.TestCase):
    def provider(self, payload=None, *, clock=lambda: 100000):
        transport = Mock(return_value=response() if payload is None else payload)
        return CanonicalMarketHistorical(RPC, transport=transport, clock=clock), transport

    def test_explicit_canonical_mapping_has_no_admission_or_symbol_input(self):
        expected = {ZERO: {'symbol': 'ETH'},
                    WETH: {'network': 'eth-mainnet', 'address': '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'},
                    USDG: {'network': 'eth-mainnet', 'address': '0xe343167631d89b6ffc58b88d6b7fb0228795491d'}}
        for currency, decimals in ((ZERO, 18), (WETH, 18), (USDG, 6)):
            with self.subTest(currency=currency):
                provider, transport = self.provider(response(currency))
                result = provider.fetch(currency, 300, 900)
                url, body = transport.call_args.args
                self.assertEqual(url, 'https://api.g.alchemy.com/prices/v1/' + SECRET + '/tokens/historical')
                self.assertEqual(body, {**expected[currency], 'startTime': iso(300),
                                       'endTime': iso(900), 'interval': '5m'})
                self.assertEqual((result['chainId'], result['currency']), (CHAIN_ID, currency))
                self.assertEqual(result['reference']['expectedCurrencyDecimals'], decimals)
                self.assertFalse(result['reference']['historicalCurrencyDecimalsVerified'])
                self.assertEqual(result['reference']['providerIdentityEvidence'],
                                 'symbol_echo_only' if currency == ZERO else 'network_address_echo')
                self.assertFalse(result['reference']['robinhoodExecutablePriceQualified'])
                self.assertTrue(all(row['currency'] == currency for row in result['observations']))
                self.assertNotIn(SECRET, json.dumps(result))
        for currency in (OTHER, 'ETH', 'USDG', None, 4663,
                         REFERENCES[WETH].ethereum_address, REFERENCES[USDG].ethereum_address):
            provider, transport = self.provider()
            with self.subTest(currency=currency), self.assertRaises(DataError):
                provider.fetch(currency, 300, 900)
            transport.assert_not_called()

    def test_case_normalizes_address_only_and_never_uses_rpc_as_a_price_source(self):
        provider, transport = self.provider(response(WETH))
        result = provider.fetch('0x' + WETH[2:].upper(), 300, 900)
        self.assertEqual(result['currency'], WETH)
        self.assertEqual(transport.call_count, 1)
        self.assertNotIn(SOURCE, OBSERVATION_SOURCES)
        self.assertEqual(PRODUCTION_QUALIFICATIONS, {})

    def test_complete_grid_does_not_qualify_event_time_composition_or_execution(self):
        provider, _ = self.provider(response(WETH))
        result = provider.fetch(WETH, 300, 900)
        self.assertEqual(result['coverage']['status'], 'observed_grid_complete')
        self.assertEqual(result['coverage']['causalEventTimeCoverage'], 'unqualified')
        self.assertEqual(result['reference']['sourceComposition'], 'unqualified')
        self.assertEqual(result['reference']['bucketTimestampSemantics'], 'unqualified')
        for flag in ('sourceQualified', 'productionQualified', 'executionAvailable',
                     'observationsSaved', 'walletAccessed'):
            self.assertIs(result[flag], False)
        self.assertIsNone(result['tvlUsd'])
        self.assertIsNone(result['feeApr24h'])

    def test_exact_decimal_strings_survive_sorted_numeric_duplicate_deduplication(self):
        exact = '9007199254740993.123456789012345678'
        provider, _ = self.provider(response(values=[(900, '1'), (600, exact),
                                                     (300, '1.000'), (300, '1.0')]))
        result = provider.fetch(ZERO, 300, 900)
        self.assertEqual([row['timestamp'] for row in result['observations']], [300, 600, 900])
        self.assertEqual(result['observations'][1]['priceUsd'], exact)
        self.assertEqual(usd(exact), Fraction('9007199254740993123456789012345678') / 10**18)
        self.assertEqual(result['observations'][0]['priceUsd'], '1.000')
        self.assertEqual(result['duplicateRows'], 1)

    def test_conflicting_numeric_or_null_duplicate_fails_closed(self):
        for first, second in (('1', '2'), (None, '1'), ('1', None)):
            provider, _ = self.provider(response(values=[(600, first), (600, second)]))
            with self.subTest(values=(first, second)), self.assertRaisesRegex(DataError, '^conflicting_price_observation$'):
                provider.fetch(ZERO, 300, 900)

    def test_null_price_stays_missing_and_empty_history_has_no_fake_zero(self):
        provider, _ = self.provider(response(values=[(300, '1'), (600, None), (900, '1')]))
        result = provider.fetch(ZERO, 300, 900)
        self.assertEqual(result['coverage']['status'], 'incomplete')
        self.assertEqual(result['coverage']['nullPriceTimestamps'], [600])
        self.assertEqual(result['coverage']['missingGridTimestamps'], [600])
        self.assertEqual(result['coverage']['largestObservedGapSeconds'], 600)
        self.assertEqual(len(result['observations']), 2)
        provider, _ = self.provider(response(values=[]))
        result = provider.fetch(ZERO, 300, 900)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['coverage']['status'], 'missing')
        for field in ('firstTimestamp', 'lastTimestamp', 'largestObservedGapSeconds'):
            self.assertIsNone(result['coverage'][field])

    def test_internal_and_boundary_gaps_do_not_use_nearby_or_future_samples(self):
        cases = [([(300, '1'), (900, '2')], 300, 900, [600]),
                 ([(600, '1')], 300, 900, [300, 900]),
                 ([(600, '1'), (900, '1')], 301, 901, [301, 901]),
                 ([(301, '1'), (899, '1')], 300, 900, [300, 600, 900])]
        for values, start, end, missing in cases:
            provider, _ = self.provider(response(values=values))
            with self.subTest(values=values):
                result = provider.fetch(ZERO, start, end)
                self.assertEqual(result['coverage']['status'], 'incomplete')
                self.assertEqual(result['coverage']['missingGridTimestamps'], missing)
                self.assertFalse(result['coverage']['interpolationApplied'])

    def test_window_budget_and_future_bounds_prevent_requests(self):
        cases = [(True, 900), (300, True), (-1, 900), (900, 900),
                 (901, 900), (0, MAX_WINDOW_SECONDS+1), (0, 100001)]
        for start, end in cases:
            provider, transport = self.provider()
            with self.subTest(bounds=(start, end)), self.assertRaisesRegex(DataError, '^invalid_price_history_bounds$'):
                provider.fetch(ZERO, start, end)
            transport.assert_not_called()
        for now in (float('nan'), float('inf'), 10**1000, True, '100000'):
            provider, transport = self.provider(clock=lambda: now)
            with self.subTest(clock=now), self.assertRaisesRegex(DataError, '^invalid_price_history_bounds$'):
                provider.fetch(ZERO, 300, 900)
            transport.assert_not_called()

    def test_full_day_plus_boundary_is_bounded_and_overflow_counts_duplicates(self):
        payload = response(values=[(at, '1') for at in range(0, MAX_WINDOW_SECONDS+1, 300)])
        provider, _ = self.provider(payload)
        result = provider.fetch(ZERO, 0, MAX_WINDOW_SECONDS)
        self.assertEqual((MAX_ROWS, len(result['observations'])), (290, 290))
        self.assertEqual(result['coverage']['status'], 'observed_grid_complete')
        payload['data'].append(deepcopy(payload['data'][0]))
        with self.assertRaisesRegex(DataError, '^price_observation_budget_exhausted$'):
            provider.fetch(ZERO, 0, MAX_WINDOW_SECONDS)

    def test_receipt_time_is_recorded_after_transport_without_changing_observation_time(self):
        times = iter((100000, 100007))
        provider, transport = self.provider(clock=lambda: next(times))
        result = provider.fetch(ZERO, 300, 900)
        self.assertEqual(transport.call_count, 1)
        self.assertEqual((result['requestedAt'], result['retrievedAt']), (100000, 100007))
        self.assertEqual([row['timestamp'] for row in result['observations']], [300, 600, 900])
        self.assertTrue(all(row['retrievedAt'] == 100007 for row in result['observations']))

    def test_invalid_receipt_clock_cannot_manufacture_earlier_availability(self):
        for received in (99999, float('nan'), float('inf'), 253402300800, True, '100007'):
            times = iter((100000, received))
            provider, transport = self.provider(clock=lambda: next(times))
            with self.subTest(received=received), self.assertRaisesRegex(DataError, '^invalid_price_history_bounds$'):
                provider.fetch(ZERO, 300, 900)
            self.assertEqual(transport.call_count, 1)

    def test_response_identity_currency_and_provider_errors_are_not_relabelled(self):
        for changes, reason in (({'symbol': 'WETH'}, 'asset_mismatch'),
                                ({'symbol': None}, 'asset_mismatch'),
                                ({'network': 'eth-mainnet'}, 'asset_mismatch'),
                                ({'address': WETH}, 'asset_mismatch'),
                                ({'currency': 'USD'}, 'currency_mismatch'),
                                ({'currency': None}, 'currency_mismatch'),
                                ({'error': {'message': SECRET}}, 'provider_error')):
            provider, _ = self.provider({**response(), **changes})
            with self.subTest(changes=changes), self.assertRaisesRegex(DataError, reason) as caught:
                provider.fetch(ZERO, 300, 900)
            self.assertNotIn(SECRET, str(caught.exception))
        for currency in (WETH, USDG):
            for changes in ({'network': 'robinhood-mainnet'}, {'address': currency},
                            {'symbol': 'ETH'}, {'address': None}, {'network': None}):
                provider, _ = self.provider({**response(currency), **changes})
                with self.subTest(currency=currency, changes=changes), self.assertRaisesRegex(DataError, 'asset_mismatch'):
                    provider.fetch(currency, 300, 900)
            provider, transport = self.provider(response())
            with self.assertRaisesRegex(DataError, 'asset_mismatch'):
                provider.fetch(currency, 300, 900)
            self.assertEqual(transport.call_count, 1)  # No ticker retry.

    def test_invalid_values_timestamps_and_structure_are_rejected(self):
        for value in (0, 1, 1.0, True, '', '0', '-1', 'NaN', 'Infinity', '1e2', '0.1'+'0'*37):
            provider, _ = self.provider(response(values=[(600, value)]))
            with self.subTest(value=value), self.assertRaisesRegex(DataError, '^invalid_usd_price$'):
                provider.fetch(ZERO, 300, 900)
        for at in (299, 901):
            provider, _ = self.provider(response(values=[(at, '1')]))
            with self.assertRaisesRegex(DataError, '^price_outside_requested_window$'):
                provider.fetch(ZERO, 300, 900)
        bads = [[], {'symbol': 'ETH', 'currency': 'usd', 'data': {}},
                {**response(), 'data': [None]}, {**response(), 'data': [{'timestamp': iso(600)}]},
                {**response(), 'data': [{'timestamp': '2026-01-01T00:00:00', 'value': '1'}]},
                {**response(), 'data': [{'timestamp': iso(600), 'value': '1', 'error': SECRET}]}]
        for payload in bads:
            provider, _ = self.provider(payload)
            with self.subTest(payload=payload), self.assertRaises(DataError):
                provider.fetch(ZERO, 300, 900)

    def test_transport_exception_and_unknown_payload_fields_cannot_leak_secrets(self):
        for error in (DataError(RPC), RuntimeError(RPC)):
            provider, transport = self.provider()
            transport.side_effect = error
            with self.assertRaisesRegex(DataError, '^market_reference_provider_unavailable$') as caught:
                provider.fetch(ZERO, 300, 900)
            self.assertNotIn(SECRET, str(caught.exception))
        provider, transport = self.provider()
        transport.side_effect = DataError('http_429')
        with self.assertRaisesRegex(DataError, '^http_429$'):
            provider.fetch(ZERO, 300, 900)
        payload = {**response(), 'untrustedMetadata': {'url': RPC}}
        payload['data'][0]['debug'] = RPC
        provider, _ = self.provider(payload)
        self.assertNotIn(SECRET, json.dumps(provider.fetch(ZERO, 300, 900)))


class CanonicalMarketCliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.config, self.output = root/'providers.json', root/'report.json'
        self.config.write_text(json.dumps({'version': 1, 'rpcUrl': RPC, 'inventoryUrl': RPC}))
        self.config.chmod(0o600)
        self.args = ['--currency', WETH, '--start', '300', '--end', '900',
                     '--provider-config', str(self.config), '--output', str(self.output)]

    def invoke(self, transport):
        output = io.StringIO()
        with patch.object(cli, 'bounded_transport', return_value=transport), redirect_stdout(output):
            code = cli.main(self.args)
        self.assertNotIn(SECRET, output.getvalue())
        return code, json.loads(output.getvalue())

    def test_actual_loader_and_adapter_write_only_sanitized_report(self):
        original = self.config.read_bytes()
        transport = Mock(return_value=response(WETH))
        code, summary = self.invoke(transport)
        self.assertEqual(code, 0)
        self.assertEqual(summary['coverage'], 'observed_grid_complete')
        report = self.output.read_text()
        self.assertNotIn(SECRET, report)
        self.assertNotIn(str(self.config), report)
        self.assertFalse(json.loads(report)['sourceQualified'])
        self.assertEqual(self.config.read_bytes(), original)
        self.assertEqual(transport.call_count, 1)

    def test_partial_history_is_reported_and_existing_output_blocks_network(self):
        code, summary = self.invoke(Mock(return_value=response(WETH, values=[])))
        self.assertEqual((code, summary['coverage']), (1, 'missing'))
        original = self.output.read_bytes()
        transport = Mock(return_value=response())
        code, summary = self.invoke(transport)
        self.assertEqual((code, summary['reason']), (1, 'output_exists'))
        self.assertEqual(self.output.read_bytes(), original)
        transport.assert_not_called()

    def test_dangling_symlink_is_not_overwritten_and_blocks_network(self):
        self.output.symlink_to(self.output.parent/'missing.json')
        transport = Mock(return_value=response())
        code, summary = self.invoke(transport)
        self.assertEqual((code, summary['reason']), (1, 'output_exists'))
        self.assertTrue(self.output.is_symlink())
        transport.assert_not_called()

    def test_exception_output_is_sanitized_and_does_not_create_a_report(self):
        for error in (DataError(RPC), RuntimeError(RPC)):
            code, summary = self.invoke(Mock(side_effect=error))
            self.assertEqual((code, summary['reason']), (1, 'market_reference_provider_unavailable'))
            self.assertFalse(self.output.exists())
        with patch.object(cli, 'qualify', side_effect=DataError(RPC)):
            code, summary = self.invoke(Mock())
        self.assertEqual((code, summary['reason']), (1, 'local_operation_unavailable'))


if __name__ == '__main__':
    unittest.main()
