"""Request one non-executable Uniswap swap preview using a private local API key."""
import argparse
import json
from pathlib import Path

from discovery import DataError
import uniswap_config
from uniswap_quote import UniswapQuote


# Only documented fixed codes may leave this CLI. Provider errors, file paths,
# argument contents and unexpected exception messages are never diagnostics.
SAFE_ERROR_CODES = frozenset({
    'uniswap_quote_native_route_unsupported',
    'invalid_quote_arguments',
    'uniswap_config_missing',
    'invalid_uniswap_config',
    'invalid_uniswap_key',
    'uniswap_config_unreadable',
    'uniswap_config_permissions',
    'invalid_address',
    'invalid_bytes32',
    'invalid_pool_key',
    'invalid_tick_spacing',
    'invalid_uniswap_api_key',
    'pool_id_mismatch',
    'read_deadline_exceeded',
    'invalid_uniswap_quote_amount',
    'invalid_uniswap_quote_approval_flag',
    'invalid_uniswap_quote_clock',
    'invalid_uniswap_quote_decimal',
    'invalid_uniswap_quote_fee',
    'invalid_uniswap_quote_identity',
    'invalid_uniswap_quote_number',
    'invalid_uniswap_quote_outputs',
    'invalid_uniswap_quote_response',
    'invalid_uniswap_quote_routes',
    'invalid_uniswap_quote_simulation',
    'uniswap_quote_access_denied',
    'uniswap_quote_chain_mismatch',
    'uniswap_quote_credentials_rejected',
    'uniswap_quote_currency_mismatch',
    'uniswap_quote_deadline_exceeded',
    'uniswap_quote_decimals_mismatch',
    'uniswap_quote_expired',
    'uniswap_quote_hooks_unsupported',
    'uniswap_quote_input_mismatch',
    'uniswap_quote_minimum_output_mismatch',
    'uniswap_quote_no_route',
    'uniswap_quote_output_amount_mismatch',
    'uniswap_quote_pool_reused',
    'uniswap_quote_rate_limited',
    'uniswap_quote_recipient_mismatch',
    'uniswap_quote_request_mismatch',
    'uniswap_quote_request_rejected',
    'uniswap_quote_response_too_large',
    'uniswap_quote_route_amount_mismatch',
    'uniswap_quote_route_disconnected',
    'uniswap_quote_route_unsupported',
    'uniswap_quote_slippage_mismatch',
    'uniswap_quote_transfer_tax_unsupported',
    'uniswap_quote_unavailable',
})


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally repeats rejected values, including an accidentally
        # pasted key or a private configuration path.
        raise DataError('invalid_quote_arguments')


def _parser():
    parser = _Parser(
        prog='preview_swap.py',
        description=__doc__,
        allow_abbrev=False,
        epilog=(
            'Preview only: no executable transaction, approval, signature or swap. '
            'The amount is DEX input, not the total LP funding budget; it excludes '
            'the Domino assisted-swap fee whose tariff is not yet calibrated. '
            'The API key is read only from local configuration, never arguments.'
        ),
    )
    parser.add_argument('--owner', required=True, help='Robinhood owner address for the quote')
    parser.add_argument('--token-in', required=True, help='Input token address, or native zero address')
    parser.add_argument('--token-out', required=True, help='Output token address, or native zero address')
    parser.add_argument('--amount-raw', required=True,
                        help='Exact DEX input in integer token base units; excludes the Domino fee')
    parser.add_argument('--slippage-bps', required=True, type=int,
                        help='Explicit maximum slippage in basis points')
    parser.add_argument('--max-price-impact-bps', required=True, type=int,
                        help='Explicit maximum price impact in basis points')
    parser.add_argument('--config-file', type=Path, default=uniswap_config.CONFIG_PATH,
                        help='Private local Uniswap configuration file')
    return parser


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        config = uniswap_config.load_config(args.config_file)
        if not config.get('apiKey'):
            raise DataError('uniswap_config_missing')
        result = UniswapQuote(config['apiKey']).preview(
            owner=args.owner,
            token_in=args.token_in,
            token_out=args.token_out,
            amount_raw=args.amount_raw,
            slippage_bps=args.slippage_bps,
            max_price_impact_bps=args.max_price_impact_bps,
            chain_id=4663,
        )
        output = json.dumps(result, allow_nan=False)
    except DataError as error:
        code = str(error)
        reason = code if code in SAFE_ERROR_CODES else 'quote_preview_failed'
        print(json.dumps({'status': 'unavailable', 'reason': reason}))
        return 2 if reason == 'invalid_quote_arguments' else 1
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason': 'quote_preview_failed'}))
        return 1
    print(output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
