from contextlib import redirect_stdout
from copy import deepcopy
from decimal import Decimal
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coingecko_market_reference import (CoinGeckoMarketReference, DAY_MS, MAX_FETCH_MS,
    MAX_POINTS, ROOT, reference_from_payloads, validate_identity)
from discovery import DataError, ZERO, json_http
from qualify_coingecko_reference import main, write_report


CURRENCY = '0x' + 'ab' * 20
OTHER = '0x' + 'cd' * 20
NOW = 200 * DAY_MS + 123


def metadata():
    return {'id': 'test-asset-42', 'symbol': 'WRONG', 'name': '<untrusted text>',
            'platforms': {'robinhood': CURRENCY, 'ethereum': OTHER},
            'detail_platforms': {'robinhood': {'contract_address': CURRENCY, 'decimal_place': 18}}}


def chart(rows=None):
    return {'prices': rows if rows is not None else [
        [NOW-DAY_MS, Decimal('1.000000000000000001')],
        [NOW-DAY_MS+300_000, Decimal('1.200000000000000001')],
        [NOW, Decimal('1.1')]],
        'market_caps': [['ignored']], 'total_volumes': [['ignored']]}


def parse(response=None, identity=None, **kwargs):
    options = dict(currency=CURRENCY, currency_decimals=18,
                   requested_at_ms=NOW, retrieved_at_ms=NOW+1_000)
    options.update(kwargs)
    return reference_from_payloads(metadata() if identity is None else identity,
        chart() if response is None else response, **options)


class CoinGeckoMarketReferenceTests(unittest.TestCase):
    def test_discovery_binds_generic_address_and_fixed_chart_id(self):
        transport = Mock(side_effect=[metadata(), chart()])
        adapter = CoinGeckoMarketReference(transport=transport, clock_ms=iter([NOW, NOW+1_000]).__next__)
        result = adapter.history(CURRENCY.upper().replace('0X', '0x'), currency_decimals=18)
        self.assertEqual(transport.call_count, 2)
        self.assertEqual(transport.call_args_list[0].args,
            (ROOT+'/coins/robinhood/contract/'+CURRENCY,))
        self.assertEqual(transport.call_args_list[1].args,
            (ROOT+'/coins/test-asset-42/market_chart?vs_currency=usd&days=1',))
        self.assertTrue(all(call.kwargs == {'timeout': 5} for call in transport.call_args_list))
        self.assertEqual(result['identity']['currency'], CURRENCY)
        self.assertEqual(result['identity']['currencyDecimals'], 18)
        self.assertEqual(result['identity']['chainId'], 4663)
        self.assertNotIn('WRONG', json.dumps(result))
        self.assertNotIn('untrusted', json.dumps(result))

    def test_wrong_platform_and_each_conflicting_address_are_rejected(self):
        mutations = [lambda m: m['platforms'].pop('robinhood'),
                     lambda m: m['detail_platforms'].pop('robinhood'),
                     lambda m: m['platforms'].update(robinhood=OTHER),
                     lambda m: m['detail_platforms']['robinhood'].update(contract_address=OTHER),
                     lambda m: m.update(platforms=None),
                     lambda m: m.update(detail_platforms={'robinhood': []})]
        for mutate in mutations:
            raw = metadata(); mutate(raw)
            transport = Mock(return_value=raw)
            adapter = CoinGeckoMarketReference(transport=transport)
            with self.subTest(metadata=raw), self.assertRaisesRegex(DataError, 'coingecko_currency_identity_mismatch'):
                adapter.history(CURRENCY, currency_decimals=18)
            self.assertEqual(transport.call_count, 1)

    def test_decimals_missing_wrong_or_coercible_are_rejected(self):
        for value in (None, 6, '18', 18.0, Decimal('18'), True):
            raw = metadata(); raw['detail_platforms']['robinhood']['decimal_place'] = value
            with self.subTest(value=value), self.assertRaisesRegex(DataError, 'coingecko_currency_identity_mismatch'):
                parse(identity=raw)

    def test_caller_currency_and_decimals_are_checked_before_transport(self):
        for currency, decimals in ((ZERO, 18), ('MARLIN', 18), (CURRENCY, '18'),
                                   (CURRENCY, True), (CURRENCY, -1), (CURRENCY, 256)):
            transport = Mock()
            with self.subTest(currency=currency, decimals=decimals), self.assertRaises(DataError):
                CoinGeckoMarketReference(transport=transport).history(currency, currency_decimals=decimals)
            transport.assert_not_called()

    def test_identity_canonicalizes_provider_address_case(self):
        raw = metadata()
        raw['platforms']['robinhood'] = CURRENCY.upper().replace('0X', '0x')
        raw['detail_platforms']['robinhood']['contract_address'] = raw['platforms']['robinhood']
        self.assertEqual(validate_identity(raw, currency=CURRENCY, currency_decimals=18)['currency'], CURRENCY)

    def test_unsafe_coin_ids_never_select_an_endpoint(self):
        for value in ('../ethereum', 'test?key=private', 'coin#fragment', 'https://other.test',
                      'Test', '-test', 'test-', 'test--asset', 'tést', '', 'a'*129, None):
            raw = metadata(); raw['id'] = value
            transport = Mock(return_value=raw)
            with self.subTest(value=value), self.assertRaisesRegex(DataError, 'invalid_coingecko_coin_id'):
                CoinGeckoMarketReference(transport=transport).history(CURRENCY, currency_decimals=18)
            self.assertEqual(transport.call_count, 1)

    def test_exact_decimals_and_millisecond_labels_are_preserved(self):
        result = parse(chart([[NOW-1, '1.2345678901234567890123456789'],
                              [NOW-300_001, Decimal('1E-8')], [NOW, 100]]))
        self.assertEqual(result['points'], [
            {'timestampMs': NOW-300_001, 'priceUsd': '0.00000001'},
            {'timestampMs': NOW-1, 'priceUsd': '1.2345678901234567890123456789'},
            {'timestampMs': NOW, 'priceUsd': '100'}])
        self.assertEqual(result['diagnostics']['maxGapMs'], 300_000)

    def test_float_nonpositive_nonfinite_and_unbounded_prices_rejected(self):
        for value in (1.2, True, None, 0, '-1', 'NaN', 'Infinity', Decimal('NaN'),
                      Decimal('sNaN'), Decimal('Infinity'), Decimal('-Infinity'),
                      '1e999999', '1e-999999', '1e79', '1e-79', '9'*79,
                      '1.'+'0'*79, ' 1', '+1', '01', '１', []):
            with self.subTest(value=value), self.assertRaisesRegex(DataError, '^invalid_coingecko_price$'):
                parse(chart([[NOW, value]]))

    def test_identical_duplicates_deduplicate_but_revisions_fail_closed(self):
        result = parse(chart([[NOW, '1.20'], [NOW, Decimal('1.2')], [NOW-1, 2]]))
        self.assertEqual(result['diagnostics']['inputPointCount'], 3)
        self.assertEqual(result['diagnostics']['pointCount'], 2)
        self.assertEqual(result['diagnostics']['duplicatePointCount'], 1)
        with self.assertRaisesRegex(DataError, '^coingecko_price_revision_conflict$'):
            parse(chart([[NOW, '1.2'], [NOW, '1.200000000000000001']]))

    def test_empty_malformed_and_oversized_charts_fail(self):
        for raw in ({}, {'prices': None}, chart([]), chart([[NOW]]), chart([[NOW, 1, 2]]),
                    chart([(NOW, 1)]), chart([[NOW, 1]]*(MAX_POINTS+1))):
            with self.subTest(chart=type(raw)), self.assertRaisesRegex(DataError, '^invalid_coingecko_chart$'):
                parse(raw)

    def test_timestamp_requires_integer_milliseconds_within_request_and_retrieval(self):
        for timestamp in (float(NOW), Decimal(NOW), str(NOW), True, -1, 2**63):
            with self.subTest(timestamp=timestamp), self.assertRaisesRegex(DataError, '^invalid_coingecko_timestamp$'):
                parse(chart([[timestamp, 1]]))
        for timestamp in (NOW-DAY_MS-1, NOW+1_001):
            with self.subTest(timestamp=timestamp), self.assertRaisesRegex(DataError, '^coingecko_point_outside_request_window$'):
                parse(chart([[timestamp, 1]]))
        self.assertEqual(parse(chart([[NOW+1_000, 1]]))['points'][0]['timestampMs'], NOW+1_000)

    def test_invalid_clock_windows_fail(self):
        for kwargs in ({'requested_at_ms': True}, {'retrieved_at_ms': 1.0},
                       {'retrieved_at_ms': NOW-1}, {'retrieved_at_ms': NOW+MAX_FETCH_MS+1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(DataError):
                parse(**kwargs)

    def test_continuous_sample_labels_never_qualify_event_coverage(self):
        rows = [[NOW-DAY_MS+i*300_000, 1] for i in range(289)]
        result = parse(chart(rows))
        self.assertEqual(result['diagnostics']['maxGapMs'], 300_000)
        self.assertEqual(result['diagnostics']['gapsAboveCadenceThreshold'], 0)
        self.assertEqual(result['diagnostics']['firstPointOffsetFromRequestedStartMs'], 0)
        self.assertEqual(result['diagnostics']['lastPointOffsetFromRequestedEndMs'], 0)
        self.assertEqual(result['diagnostics']['canonicalEventTimeCoverage'], 'unqualified')
        self.assertEqual(result['status'], 'unqualified')
        self.assertEqual(result['mode'], 'provider_reference_only')
        self.assertEqual(result['provenance']['targetPoolIndependence'], 'unqualified')
        self.assertEqual(result['provenance']['timestampSemantics'], 'provider_chart_timestamp_unqualified')
        self.assertFalse(result['provenance']['providerPublicationTimeVerified'])
        self.assertFalse(result['provenance']['onchainCurrencyIdentityVerified'])
        self.assertFalse(result['executionAvailable'])
        self.assertNotIn('feeAprPercent', result)

    def test_sparse_or_single_point_data_retains_missing_cadence_evidence(self):
        one = parse(chart([[NOW-1_000, 1]]))
        self.assertIsNone(one['diagnostics']['maxGapMs'])
        self.assertEqual(one['diagnostics']['sampleSpanMs'], 0)
        self.assertEqual(one['diagnostics']['lastPointOffsetFromRequestedEndMs'], -1_000)
        result = parse()
        self.assertEqual(result['diagnostics']['gapsAboveCadenceThreshold'], 1)
        self.assertEqual(result['diagnostics']['maxGapMs'], DAY_MS-300_000)

    def test_provider_errors_are_sanitized_without_retry(self):
        for error in (DataError('http_401 private payload'), RuntimeError('https://secret.test/key')):
            transport = Mock(side_effect=error)
            with self.subTest(error=type(error)), self.assertRaisesRegex(DataError, '^coingecko_provider_unavailable$'):
                CoinGeckoMarketReference(transport=transport).history(CURRENCY, currency_decimals=18)
            self.assertEqual(transport.call_count, 1)
        transport = Mock(side_effect=[metadata(), {'error': 'private provider details'}])
        with self.assertRaisesRegex(DataError, '^invalid_coingecko_chart$'):
            CoinGeckoMarketReference(transport=transport, clock_ms=lambda: NOW).history(CURRENCY, currency_decimals=18)
        self.assertEqual(transport.call_count, 2)

    def test_default_json_transport_keeps_decimal_lexemes(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read1 = Mock(side_effect=[b'{"prices":[[17280000123,1.234567890123456789]]}', b''])
        opener = Mock(return_value=response)
        loaded = json_http(ROOT+'/coins/test/market_chart?vs_currency=usd&days=1', opener=opener)
        self.assertIsInstance(loaded['prices'][0][1], Decimal)
        self.assertEqual(parse(loaded)['points'][0]['priceUsd'], '1.234567890123456789')

    def test_parser_does_not_mutate_captured_payloads(self):
        raw_metadata, raw_chart = metadata(), chart()
        previous = deepcopy((raw_metadata, raw_chart))
        parse(raw_chart, raw_metadata)
        self.assertEqual((raw_metadata, raw_chart), previous)

    def test_report_exclusive_creation_rejects_existing_file_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'report.json'
            report = parse()
            write_report(path, report)
            saved = path.read_bytes()
            self.assertEqual(json.loads(saved), report)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): write_report(path, {'overwritten': True})
            self.assertEqual(path.read_bytes(), saved)
            link = Path(directory)/'link.json'; link.symlink_to(path)
            with self.assertRaises(FileExistsError): write_report(link, {'overwritten': True})
            self.assertEqual(path.read_bytes(), saved)

    def test_cli_skips_provider_for_existing_output_and_sanitizes_io_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'exists.json'; path.write_text('untouched')
            arguments = ['--currency', CURRENCY, '--decimals', '18', '--output', str(path)]
            with patch('qualify_coingecko_reference.CoinGeckoMarketReference') as adapter, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(arguments), 1)
                adapter.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())['reason'], 'coingecko_output_exists')
            self.assertEqual(path.read_text(), 'untouched')
            arguments[-1] = str(Path(directory)/'missing'/'report.json')
            with patch('qualify_coingecko_reference.CoinGeckoMarketReference') as adapter, redirect_stdout(io.StringIO()) as output:
                adapter.return_value.history.return_value = parse()
                self.assertEqual(main(arguments), 1)
            self.assertEqual(json.loads(output.getvalue())['reason'], 'coingecko_report_unavailable')
            self.assertNotIn(directory, output.getvalue())

    def test_cli_success_does_not_claim_source_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'report.json'
            with patch('qualify_coingecko_reference.CoinGeckoMarketReference') as adapter, redirect_stdout(io.StringIO()) as output:
                adapter.return_value.history.return_value = parse()
                self.assertEqual(main(['--currency', CURRENCY, '--decimals', '18', '--output', str(path)]), 0)
            self.assertEqual(json.loads(output.getvalue())['sourceQualification'], 'unqualified')
            self.assertFalse(json.loads(path.read_text())['executionAvailable'])


if __name__ == '__main__':
    unittest.main()
