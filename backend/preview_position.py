"""Request one non-executable Uniswap v4 position preview with a local API key."""
import argparse
import json
from pathlib import Path
import sys

from discovery import CHAIN_ID, DataError, PoolKey, ZERO
import uniswap_config
from uniswap_position import UniswapPosition


# Never expose provider text, rejected argument values, or configuration paths.
# Only exact, fixed diagnostic codes may leave this command.
SAFE_ERROR_CODES = frozenset({
    'invalid_position_arguments',
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
    'invalid_lp_mint_encoding',
    'invalid_lp_mint_transaction',
    'invalid_lp_mint_context',
    'invalid_lp_mint_amounts',
    'lp_mint_request_mismatch',
    'lp_mint_native_value_mismatch',
    'unsupported_lp_mint_transaction',
    'unsupported_lp_mint_plan',
    'invalid_uniswap_position_number',
    'invalid_uniswap_position_amount',
    'invalid_uniswap_position_price',
    'invalid_uniswap_position_clock',
    'invalid_uniswap_position_identity',
    'invalid_uniswap_position_range',
    'invalid_uniswap_position_gas_reserve',
    'invalid_uniswap_position_response',
    'uniswap_position_chain_mismatch',
    'uniswap_position_pool_unsupported',
    'uniswap_position_currency_mismatch',
    'uniswap_position_input_exceeds_budget',
    'uniswap_position_request_rejected',
    'uniswap_position_credentials_rejected',
    'uniswap_position_access_denied',
    'uniswap_position_pool_unavailable',
    'uniswap_position_rate_limited',
    'uniswap_position_response_too_large',
    'uniswap_position_deadline_exceeded',
    'uniswap_position_unavailable',
    'uniswap_position_expired',
    'uniswap_position_range_mismatch',
    'uniswap_position_input_mismatch',
    'uniswap_position_amount_mismatch',
})


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally repeats rejected values, including accidentally
        # pasted keys or private paths. This command never echoes them.
        raise DataError('invalid_position_arguments')


def _parser():
    parser = _Parser(
        prog='preview_position.py',
        description=__doc__,
        allow_abbrev=False,
        epilog=(
            'Preview only: no executable transaction, approval, signature or broadcast. '
            'Existing hookless fixed-fee v4 pools on Robinhood only. Uniswap calculates '
            'the token composition; this command does not calculate a swap or create '
            'a new pool. Provide aligned ticks from the Uniswap UI/SDK. Returned '
            'adjusted prices use raw token1/token0 units, not human token prices. '
            'Selected token budgets and native gas reserve are optional checks, '
            'not verified wallet balances. The API key is read only from local '
            'configuration, never arguments.'
        ),
    )
    parser.add_argument('--owner', required=True, help='Robinhood NFT recipient address')
    parser.add_argument('--pool-id', required=True, help='Full existing v4 PoolId')
    parser.add_argument('--currency0', required=True, help='Canonical pool currency0 address')
    parser.add_argument('--currency1', required=True, help='Canonical pool currency1 address')
    parser.add_argument('--fee-pips', required=True, type=int, help='Existing fixed pool fee in pips')
    parser.add_argument('--tick-spacing', required=True, type=int, help='Existing pool tick spacing')
    parser.add_argument('--independent-token', required=True,
                        help='Pool token whose requested amount is specified')
    parser.add_argument('--amount-raw', required=True,
                        help='Requested independent-token amount in integer base units')
    parser.add_argument('--tick-lower', required=True, type=int, help='Aligned lower tick')
    parser.add_argument('--tick-upper', required=True, type=int, help='Aligned upper tick')
    parser.add_argument('--slippage-bps', required=True, type=int,
                        help='Explicit maximum slippage in basis points')
    parser.add_argument('--budget0-raw', help='Optional selected currency0 spend cap in base units')
    parser.add_argument('--budget1-raw', help='Optional selected currency1 spend cap in base units')
    parser.add_argument('--native-balance-raw', help='Optional observed native balance in wei')
    parser.add_argument('--native-gas-reserve-raw', help='Optional native gas reserve in wei')
    parser.add_argument('--config-file', type=Path, default=uniswap_config.CONFIG_PATH,
                        help='Private local Uniswap configuration file')
    return parser


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        key = PoolKey.checked((args.currency0, args.currency1, args.fee_pips,
                               args.tick_spacing, ZERO), args.pool_id)
        config = uniswap_config.load_config(args.config_file)
        if not config.get('apiKey'):
            raise DataError('uniswap_config_missing')
        result = UniswapPosition(config['apiKey']).preview(
            owner=args.owner,
            pool_id=args.pool_id,
            pool_key=key,
            independent_token=args.independent_token,
            amount_raw=args.amount_raw,
            tick_lower=args.tick_lower,
            tick_upper=args.tick_upper,
            slippage_bps=args.slippage_bps,
            budget0_raw=args.budget0_raw,
            budget1_raw=args.budget1_raw,
            native_balance_raw=args.native_balance_raw,
            native_gas_reserve_raw=args.native_gas_reserve_raw,
            chain_id=CHAIN_ID,
        )
        output = json.dumps(result, allow_nan=False)
    except DataError as error:
        code = str(error)
        reason = code if code in SAFE_ERROR_CODES else 'position_preview_failed'
        print(json.dumps({'status': 'unavailable', 'reason': reason}), file=sys.stderr)
        return 2
    except Exception:
        print(json.dumps({'status': 'unavailable', 'reason': 'position_preview_failed'}),
              file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
