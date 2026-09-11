import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError
import preview_swap


OWNER = '0x1111111111111111111111111111111111111111'
TOKEN_IN = '0x2222222222222222222222222222222222222222'
TOKEN_OUT = '0x3333333333333333333333333333333333333333'
SECRET = 'offline-quote-test-key'
PRIVATE_PATH = '/private/offline-only/key-location.json'
ARGS = [
    '--owner', OWNER,
    '--token-in', TOKEN_IN,
    '--token-out', TOKEN_OUT,
    '--amount-raw', '9007199254740993123456789',
    '--slippage-bps', '50',
    '--max-price-impact-bps', '100',
]


class PreviewSwapTests(unittest.TestCase):
    def run_cli(self, args=None, *, config=None, config_error=None, result=None,
                error=None, constructor_error=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        client = Mock(spec=['preview'])
        client.preview.return_value = result if result is not None else {'status': 'preview'}
        client.preview.side_effect = error
        with patch.object(preview_swap.uniswap_config, 'load_config',
                          return_value=config if config is not None else
                          {'version': 1, 'apiKey': SECRET}, side_effect=config_error) as load, \
                patch.object(preview_swap, 'UniswapQuote', return_value=client,
                             side_effect=constructor_error) as factory, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = preview_swap.main(ARGS if args is None else args)
        self.assertEqual(stderr.getvalue(), '')
        self.assertNotIn(SECRET, stdout.getvalue())
        self.assertNotIn(PRIVATE_PATH, stdout.getvalue())
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        return code, json.loads(stdout.getvalue()), load, factory, client

    def test_exactly_one_quote_with_exact_raw_input_and_explicit_bounds(self):
        result = {'status': 'preview', 'amountInRaw': '9007199254740993123456789',
                  'amountOutRaw': '8181818181818181818181818', 'executable': False}
        code, output, load, factory, client = self.run_cli(result=result)
        self.assertEqual(code, 0)
        self.assertEqual(output, result)
        load.assert_called_once_with(preview_swap.uniswap_config.CONFIG_PATH)
        factory.assert_called_once_with(SECRET)
        client.preview.assert_called_once_with(
            owner=OWNER, token_in=TOKEN_IN, token_out=TOKEN_OUT,
            amount_raw='9007199254740993123456789', slippage_bps=50,
            max_price_impact_bps=100, chain_id=4663)
        self.assertEqual(len(client.mock_calls), 1)

    def test_explicit_config_path_is_loaded_once_without_echo(self):
        code, _, load, _, client = self.run_cli(ARGS + ['--config-file', PRIVATE_PATH])
        self.assertEqual(code, 0)
        load.assert_called_once_with(Path(PRIVATE_PATH))
        client.preview.assert_called_once()

    def test_missing_config_or_key_stops_before_client_creation(self):
        for config in ({}, {'version': 1}, {'version': 1, 'apiKey': ''}):
            with self.subTest(config=config):
                code, output, _, factory, client = self.run_cli(config=config)
                self.assertEqual(code, 1)
                self.assertEqual(output, {'status': 'unavailable', 'reason': 'uniswap_config_missing'})
                factory.assert_not_called()
                client.preview.assert_not_called()

    def test_known_configuration_errors_are_fixed_and_stop_quote(self):
        for reason in ('invalid_uniswap_config', 'invalid_uniswap_key',
                       'uniswap_config_unreadable', 'uniswap_config_permissions'):
            with self.subTest(reason=reason):
                code, output, _, factory, _ = self.run_cli(config_error=DataError(reason))
                self.assertEqual(code, 1)
                self.assertEqual(output['reason'], reason)
                factory.assert_not_called()

    def test_missing_required_arguments_never_read_configuration(self):
        for option in ('--owner', '--token-in', '--token-out', '--amount-raw',
                       '--slippage-bps', '--max-price-impact-bps'):
            with self.subTest(option=option):
                index = ARGS.index(option)
                code, output, load, factory, _ = self.run_cli(ARGS[:index] + ARGS[index + 2:])
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'invalid_quote_arguments')
                load.assert_not_called()
                factory.assert_not_called()

    def test_api_key_and_abbreviated_arguments_are_not_accepted_or_echoed(self):
        for extra in (['--api-key', SECRET], ['--key', SECRET], [SECRET],
                      ['--owner-secret', SECRET], ['--config', PRIVATE_PATH],
                      ['--chain-id', '1']):
            with self.subTest(extra=extra[0]):
                code, output, load, factory, _ = self.run_cli(ARGS + extra)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'invalid_quote_arguments')
                load.assert_not_called()
                factory.assert_not_called()

    def test_invalid_numeric_arguments_are_not_echoed(self):
        for option in ('--slippage-bps', '--max-price-impact-bps'):
            args = ARGS.copy()
            args[args.index(option) + 1] = SECRET
            code, output, load, factory, _ = self.run_cli(args)
            self.assertEqual(code, 2)
            self.assertEqual(output['reason'], 'invalid_quote_arguments')
            load.assert_not_called()
            factory.assert_not_called()

    def test_adapter_error_is_sanitized_without_retry(self):
        for message in (SECRET + PRIVATE_PATH,
                        'uniswap_quote_unavailable ' + SECRET + PRIVATE_PATH,
                        'uniswap_quote_rate_limited\n' + SECRET,
                        'uniswap_quote_rate_limited_' + SECRET):
            with self.subTest(message_prefix=message[:24]):
                code, output, _, factory, client = self.run_cli(error=DataError(message))
                self.assertEqual(code, 1)
                self.assertEqual(output['reason'], 'quote_preview_failed')
                factory.assert_called_once()
                client.preview.assert_called_once()

    def test_documented_adapter_errors_propagate_as_fixed_codes(self):
        for reason in ('invalid_address', 'invalid_bytes32', 'invalid_pool_key',
                       'invalid_tick_spacing', 'invalid_uniswap_api_key',
                       'pool_id_mismatch', 'read_deadline_exceeded',
                       'uniswap_quote_hooks_unsupported', 'uniswap_quote_no_route',
                       'uniswap_quote_credentials_rejected', 'uniswap_quote_rate_limited',
                       'uniswap_quote_request_rejected', 'uniswap_quote_access_denied',
                       'uniswap_quote_response_too_large', 'uniswap_quote_deadline_exceeded'):
            with self.subTest(reason=reason):
                code, output, _, _, client = self.run_cli(error=DataError(reason))
                self.assertEqual(code, 1)
                self.assertEqual(output, {'status': 'unavailable', 'reason': reason})
                client.preview.assert_called_once()

    def test_actual_adapter_rejects_invalid_input_before_transport(self):
        for option, value, reason in (
            ('--owner', SECRET, 'invalid_address'),
            ('--token-out', TOKEN_IN, 'invalid_uniswap_quote_identity'),
            ('--amount-raw', '0', 'invalid_uniswap_quote_number'),
            ('--slippage-bps', '10000', 'invalid_uniswap_quote_number'),
            ('--max-price-impact-bps', '-1', 'invalid_uniswap_quote_number'),
        ):
            with self.subTest(option=option):
                transport = Mock(side_effect=AssertionError('Invalid requests must not reach transport'))
                real_client = preview_swap.UniswapQuote(SECRET, transport=transport)
                args = ARGS.copy()
                args[args.index(option) + 1] = value
                code, output, _, factory, _ = self.run_cli(
                    args, constructor_error=lambda key: real_client)
                self.assertEqual(code, 1)
                self.assertEqual(output, {'status': 'unavailable', 'reason': reason})
                factory.assert_called_once_with(SECRET)
                transport.assert_not_called()

    def test_actual_adapter_maps_transport_error_once_without_provider_echo(self):
        for error, reason in ((DataError('http_429'), 'uniswap_quote_rate_limited'),
                              (RuntimeError(SECRET + PRIVATE_PATH), 'uniswap_quote_unavailable')):
            with self.subTest(reason=reason):
                transport = Mock(side_effect=error)
                real_client = preview_swap.UniswapQuote(SECRET, transport=transport)
                code, output, _, _, _ = self.run_cli(constructor_error=lambda key: real_client)
                self.assertEqual(code, 1)
                self.assertEqual(output, {'status': 'unavailable', 'reason': reason})
                transport.assert_called_once()

    def test_unexpected_exceptions_never_print_tracebacks_or_private_values(self):
        for kwargs in ({'config_error': OSError(SECRET + PRIVATE_PATH)},
                       {'constructor_error': ValueError(SECRET + PRIVATE_PATH)},
                       {'error': RuntimeError(SECRET + PRIVATE_PATH)}):
            with self.subTest(stage=next(iter(kwargs))):
                code, output, _, _, _ = self.run_cli(**kwargs)
                self.assertEqual(code, 1)
                self.assertEqual(output, {'status': 'unavailable', 'reason': 'quote_preview_failed'})

    def test_unserializable_output_fails_without_partial_json(self):
        for result in ({'value': object()}, {'value': float('nan')}):
            with self.subTest(result=type(result['value']).__name__):
                code, output, _, _, client = self.run_cli(result=result)
                self.assertEqual(code, 1)
                self.assertEqual(output['reason'], 'quote_preview_failed')
                client.preview.assert_called_once()

    def test_help_explains_dex_input_fee_boundary_and_non_execution(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(preview_swap.uniswap_config, 'load_config') as load, \
                patch.object(preview_swap, 'UniswapQuote') as factory, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                self.assertRaises(SystemExit) as raised:
            preview_swap.main(['--help'])
        self.assertEqual(raised.exception.code, 0)
        help_text = ' '.join(stdout.getvalue().split())
        self.assertIn('no executable transaction, approval, signature or swap', help_text)
        self.assertIn('DEX input, not the total LP funding budget', help_text)
        self.assertIn('excludes the Domino assisted-swap fee', help_text)
        self.assertNotIn('--api-key', help_text)
        self.assertEqual(stderr.getvalue(), '')
        load.assert_not_called()
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
