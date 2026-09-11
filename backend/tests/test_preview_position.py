import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError, KEY_TYPES, PoolKey, ZERO
from eth_abi import encode
from eth_hash.auto import keccak
import preview_position


OWNER = '0x1111111111111111111111111111111111111111'
CURRENCY0 = '0x2222222222222222222222222222222222222222'
CURRENCY1 = '0x3333333333333333333333333333333333333333'
POOL_KEY = PoolKey(CURRENCY0, CURRENCY1, 3000, 60, ZERO)
POOL_ID = '0x' + keccak(encode(KEY_TYPES, (CURRENCY0, CURRENCY1, 3000, 60, ZERO))).hex()
SECRET = 'offline-position-test-key'
PRIVATE_PATH = '/private/offline-only/position-key-location.json'
RAW_AMOUNT = '9007199254740993123456789'
ARGS = [
    '--owner', OWNER,
    '--pool-id', POOL_ID,
    '--currency0', CURRENCY0,
    '--currency1', CURRENCY1,
    '--fee-pips', '3000',
    '--tick-spacing', '60',
    '--independent-token', CURRENCY0,
    '--amount-raw', RAW_AMOUNT,
    '--tick-lower', '-120',
    '--tick-upper', '120',
    '--slippage-bps', '50',
]


class PreviewPositionTests(unittest.TestCase):
    def run_cli(self, args=None, *, config=None, config_error=None, result=None,
                error=None, constructor_error=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        client = Mock(spec=['preview'])
        client.preview.return_value = result if result is not None else {
            'status': 'preview', 'executionAvailable': False}
        client.preview.side_effect = error
        with patch.object(preview_position.uniswap_config, 'load_config',
                          return_value=config if config is not None else
                          {'version': 1, 'apiKey': SECRET}, side_effect=config_error) as load, \
                patch.object(preview_position, 'UniswapPosition', return_value=client,
                             side_effect=constructor_error) as factory, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = preview_position.main(ARGS if args is None else args)
        output = stdout.getvalue() if code == 0 else stderr.getvalue()
        self.assertEqual(stderr.getvalue() if code == 0 else stdout.getvalue(), '')
        self.assertNotIn(SECRET, output)
        self.assertNotIn(PRIVATE_PATH, output)
        self.assertEqual(len(output.splitlines()), 1)
        return code, json.loads(output), load, factory, client

    def test_one_preview_preserves_raw_units_and_explicit_selection(self):
        result = {'status': 'preview', 'amount0Raw': RAW_AMOUNT, 'executionAvailable': False}
        code, output, load, factory, client = self.run_cli(result=result)
        self.assertEqual(code, 0)
        self.assertEqual(output, result)
        load.assert_called_once_with(preview_position.uniswap_config.CONFIG_PATH)
        factory.assert_called_once_with(SECRET)
        client.preview.assert_called_once_with(
            owner=OWNER, pool_id=POOL_ID, pool_key=POOL_KEY,
            independent_token=CURRENCY0, amount_raw=RAW_AMOUNT,
            tick_lower=-120, tick_upper=120, slippage_bps=50,
            budget0_raw=None, budget1_raw=None, native_balance_raw=None,
            native_gas_reserve_raw=None, chain_id=4663)
        self.assertEqual(len(client.mock_calls), 1)

    def test_explicit_budgets_native_reserve_and_other_independent_side(self):
        args = ARGS.copy()
        args[args.index('--independent-token') + 1] = CURRENCY1
        args += ['--budget0-raw', '10000000000000000000000000',
                 '--budget1-raw', '10000000000000000000000001',
                 '--native-balance-raw', '30000000000000000',
                 '--native-gas-reserve-raw', '1000000000000000']
        code, _, _, _, client = self.run_cli(args)
        self.assertEqual(code, 0)
        kwargs = client.preview.call_args.kwargs
        self.assertEqual(kwargs['independent_token'], CURRENCY1)
        self.assertEqual(kwargs['budget0_raw'], '10000000000000000000000000')
        self.assertEqual(kwargs['budget1_raw'], '10000000000000000000000001')
        self.assertEqual(kwargs['native_balance_raw'], '30000000000000000')
        self.assertEqual(kwargs['native_gas_reserve_raw'], '1000000000000000')

    def test_explicit_config_path_loaded_without_echo(self):
        code, _, load, _, client = self.run_cli(ARGS + ['--config-file', PRIVATE_PATH])
        self.assertEqual(code, 0)
        load.assert_called_once_with(Path(PRIVATE_PATH))
        client.preview.assert_called_once()

    def test_missing_configuration_stops_before_client_creation(self):
        for config in ({}, {'version': 1}, {'version': 1, 'apiKey': ''}):
            with self.subTest(config=config):
                code, output, _, factory, client = self.run_cli(config=config)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'uniswap_config_missing')
                factory.assert_not_called()
                client.preview.assert_not_called()

    def test_known_configuration_errors_are_fixed(self):
        for reason in ('invalid_uniswap_config', 'invalid_uniswap_key',
                       'uniswap_config_unreadable', 'uniswap_config_permissions'):
            with self.subTest(reason=reason):
                code, output, _, factory, _ = self.run_cli(config_error=DataError(reason))
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], reason)
                factory.assert_not_called()

    def test_required_arguments_do_not_default_or_read_configuration(self):
        for option in ARGS[::2]:
            with self.subTest(option=option):
                index = ARGS.index(option)
                code, output, load, factory, _ = self.run_cli(ARGS[:index] + ARGS[index + 2:])
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'invalid_position_arguments')
                load.assert_not_called()
                factory.assert_not_called()

    def test_forbidden_modes_credentials_urls_and_abbreviations_are_rejected(self):
        for extra in (['--api-key', SECRET], ['--key', SECRET], [SECRET],
                      ['--config', PRIVATE_PATH], ['--chain-id', '1'],
                      ['--endpoint', 'https://provider.invalid'], ['--hooks', OWNER],
                      ['--new-pool'], ['--initial-price', '1'], ['--sign'],
                      ['--broadcast'], ['--calldata'], ['--price-min', '1']):
            with self.subTest(option=extra[0]):
                code, output, load, factory, _ = self.run_cli(ARGS + extra)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'invalid_position_arguments')
                load.assert_not_called()
                factory.assert_not_called()

    def test_malformed_numeric_arguments_never_echo_value(self):
        for option in ('--fee-pips', '--tick-spacing', '--tick-lower',
                       '--tick-upper', '--slippage-bps'):
            args = ARGS.copy()
            args[args.index(option) + 1] = SECRET
            code, output, load, factory, _ = self.run_cli(args)
            self.assertEqual(code, 2)
            self.assertEqual(output['reason'], 'invalid_position_arguments')
            load.assert_not_called()
            factory.assert_not_called()

    def test_pool_identity_is_checked_before_loading_key(self):
        for option, value, reason in (
            ('--pool-id', SECRET, 'invalid_bytes32'),
            ('--currency0', SECRET, 'invalid_address'),
            ('--currency1', CURRENCY0, 'invalid_pool_key'),
            ('--fee-pips', '500', 'pool_id_mismatch'),
            ('--tick-spacing', '0', 'invalid_tick_spacing'),
        ):
            with self.subTest(option=option):
                args = ARGS.copy()
                args[args.index(option) + 1] = value
                code, output, load, factory, _ = self.run_cli(args)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], reason)
                load.assert_not_called()
                factory.assert_not_called()

    def test_unknown_and_decorated_adapter_errors_are_redacted_without_retry(self):
        for reason in (SECRET + PRIVATE_PATH, 'invalid_lp_mint_context ' + SECRET,
                       'invalid_lp_mint_context\n' + SECRET,
                       'invalid_lp_mint_context_' + SECRET):
            code, output, _, _, client = self.run_cli(error=DataError(reason))
            self.assertEqual(code, 2)
            self.assertEqual(output['reason'], 'position_preview_failed')
            client.preview.assert_called_once()

    def test_documented_fixed_errors_pass_through(self):
        for reason in preview_position.SAFE_ERROR_CODES:
            with self.subTest(reason=reason):
                code, output, _, _, client = self.run_cli(error=DataError(reason))
                self.assertEqual(code, 2)
                self.assertEqual(output, {'status': 'unavailable', 'reason': reason})
                client.preview.assert_called_once()

    def test_actual_adapter_rejects_invalid_selection_before_transport(self):
        for option, value, reason in (
            ('--owner', SECRET, 'invalid_address'),
            ('--owner', ZERO, 'invalid_uniswap_position_identity'),
            ('--independent-token', OWNER, 'uniswap_position_currency_mismatch'),
            ('--amount-raw', '0', 'invalid_uniswap_position_amount'),
            ('--tick-lower', '-119', 'invalid_uniswap_position_range'),
            ('--tick-upper', '-120', 'invalid_uniswap_position_range'),
            ('--slippage-bps', '10000', 'invalid_uniswap_position_number'),
            ('--budget0-raw', '1', 'uniswap_position_input_exceeds_budget'),
            ('--budget1-raw', SECRET, 'invalid_uniswap_position_amount'),
            ('--native-gas-reserve-raw', '1', 'invalid_uniswap_position_gas_reserve'),
        ):
            with self.subTest(option=option):
                transport = Mock(side_effect=AssertionError('Invalid input must not reach transport'))
                real_client = preview_position.UniswapPosition(SECRET, transport=transport)
                args = ARGS.copy()
                if option in args:
                    args[args.index(option) + 1] = value
                else:
                    args += [option, value]
                code, output, _, factory, _ = self.run_cli(
                    args, constructor_error=lambda key: real_client)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], reason)
                factory.assert_called_once_with(SECRET)
                transport.assert_not_called()

    def test_actual_adapter_maps_transport_error_once_without_provider_echo(self):
        for error, reason in (
            (DataError('http_429'), 'uniswap_position_rate_limited'),
            (DataError('http_401'), 'uniswap_position_credentials_rejected'),
            (RuntimeError(SECRET + PRIVATE_PATH), 'uniswap_position_unavailable'),
        ):
            with self.subTest(reason=reason):
                transport = Mock(side_effect=error)
                real_client = preview_position.UniswapPosition(SECRET, transport=transport)
                code, output, _, factory, _ = self.run_cli(constructor_error=lambda key: real_client)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], reason)
                factory.assert_called_once_with(SECRET)
                transport.assert_called_once()

    def test_unexpected_exceptions_never_print_traceback_or_private_values(self):
        for kwargs in ({'config_error': OSError(SECRET + PRIVATE_PATH)},
                       {'constructor_error': ValueError(SECRET + PRIVATE_PATH)},
                       {'error': RuntimeError(SECRET + PRIVATE_PATH)}):
            with self.subTest(stage=next(iter(kwargs))):
                code, output, _, _, _ = self.run_cli(**kwargs)
                self.assertEqual(code, 2)
                self.assertEqual(output['reason'], 'position_preview_failed')

    def test_unserializable_output_has_no_partial_stdout(self):
        for result in ({'value': object()}, {'value': float('nan')}):
            code, output, _, _, client = self.run_cli(result=result)
            self.assertEqual(code, 2)
            self.assertEqual(output['reason'], 'position_preview_failed')
            client.preview.assert_called_once()

    def test_help_explains_units_limits_and_non_execution_without_loading_key(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(preview_position.uniswap_config, 'load_config') as load, \
                patch.object(preview_position, 'UniswapPosition') as factory, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                self.assertRaises(SystemExit) as raised:
            preview_position.main(['--help'])
        self.assertEqual(raised.exception.code, 0)
        text = ' '.join(stdout.getvalue().split())
        self.assertIn('no executable transaction, approval, signature or broadcast', text)
        self.assertIn('Existing hookless fixed-fee v4 pools on Robinhood only', text)
        self.assertIn('raw token1/token0 units, not human token prices', text)
        self.assertIn('not verified wallet balances', text)
        self.assertNotIn('--api-key', text)
        self.assertEqual(stderr.getvalue(), '')
        load.assert_not_called()
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
