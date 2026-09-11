"""Inspect, then discard, one bounded Uniswap existing-pool mint plan.

This module does not calculate LP ratios, prepare transactions, check balances,
sign, or authorize execution. Its result contains only decoded scalar limits.
ABI/action references: Uniswap/sdks revision
1d7d7129e1e005db8fed0c8970301470b46b68a0, v4-sdk/src/utils/v4Planner.ts
and v4-sdk/src/PositionManager.ts. The existing SDK plan is MINT_POSITION,
SETTLE_PAIR, and (only for native currency) SWEEP to the caller.
"""
import re

from eth_abi import decode, encode

from discovery import CHAIN_ID, POSITION_MANAGER, ZERO, DataError, PoolKey, address


MAX_CALLDATA_BYTES = 64 * 1024
MAX_LIQUIDITY = (1 << 127) - 1
MAX_UINT256 = (1 << 256) - 1
MODIFY_LIQUIDITIES_SELECTOR = bytes.fromhex('dd46508f')
MSG_SENDER = '0x' + '00' * 19 + '01'
ADDRESS_THIS = '0x' + '00' * 19 + '02'
POOL_KEY_ABI = '(address,address,uint24,int24,address)'
MINT_ABI = (POOL_KEY_ABI, 'int24', 'int24', 'uint256', 'uint128',
            'uint128', 'address', 'bytes')
_TRANSACTION_REQUIRED = frozenset(('to', 'from', 'data', 'value', 'chainId'))
_TRANSACTION_OPTIONAL = frozenset(('gasLimit', 'maxFeePerGas',
                                  'maxPriorityFeePerGas', 'gasPrice'))


def _canonical_decode(types, data):
    """Reject aliases, trailing bytes, padding, and noncanonical offsets."""
    try:
        result = decode(types, data, strict=True)
        if encode(types, result) != data:
            raise ValueError
        return result
    except Exception:
        raise DataError('invalid_lp_mint_encoding') from None


def _quantity(value):
    # Ethers quantity hex may use an even number of digits (including 0x00).
    if (not isinstance(value, str) or len(value) > 78
            or not re.fullmatch(r'(?:0|[1-9][0-9]*|0x[0-9a-fA-F]{1,64})', value)):
        raise DataError('invalid_lp_mint_transaction')
    result = int(value, 16 if value.startswith('0x') else 10)
    if result > MAX_UINT256:
        raise DataError('invalid_lp_mint_transaction')
    return result


def _context(owner, pool_key, pool_id, tick_lower, tick_upper, deadline):
    try:
        owner = address(owner)
        if owner in (ZERO, MSG_SENDER, ADDRESS_THIS) or not isinstance(pool_key, PoolKey):
            raise ValueError
        key = PoolKey.checked((pool_key.currency0, pool_key.currency1,
                               pool_key.fee_pips, pool_key.tick_spacing,
                               pool_key.hooks), pool_id)
        if (key.hooks != ZERO or key.fee_pips > 1_000_000
                or type(tick_lower) is not int or type(tick_upper) is not int
                or not -887272 <= tick_lower < tick_upper <= 887272
                or tick_lower % key.tick_spacing or tick_upper % key.tick_spacing
                or type(deadline) is not int or not 0 < deadline <= MAX_UINT256):
            raise ValueError
        return owner, key
    except (ValueError, TypeError, AttributeError):
        raise DataError('invalid_lp_mint_context') from None


def inspect_mint(transaction, *, owner, pool_key: PoolKey, pool_id: str,
                 tick_lower: int, tick_upper: int, deadline: int) -> dict:
    """Return exact decimal-string limits for a narrowly admitted mint only.

The caller still checks selected budgets and current gas/balance conditions.
This is static inspection, not simulation, a guarantee of successful execution,
or permission to expose the transaction. Deadlines must match the caller's
review context; freshness is enforced by that caller, not a second clock here.
"""
    owner, key = _context(owner, pool_key, pool_id, tick_lower, tick_upper, deadline)
    if (not isinstance(transaction, dict)
            or not _TRANSACTION_REQUIRED <= transaction.keys()
            or transaction.keys() - _TRANSACTION_REQUIRED - _TRANSACTION_OPTIONAL):
        raise DataError('invalid_lp_mint_transaction')
    try:
        sender, target = address(transaction['from']), address(transaction['to'])
    except ValueError:
        raise DataError('invalid_lp_mint_transaction') from None
    if (sender != owner or target != POSITION_MANAGER
            or type(transaction['chainId']) is not int
            or transaction['chainId'] != CHAIN_ID):
        raise DataError('lp_mint_request_mismatch')
    native_value = _quantity(transaction['value'])
    for name in _TRANSACTION_OPTIONAL & transaction.keys():
        _quantity(transaction[name])
    if ('gasPrice' in transaction
            and ('maxFeePerGas' in transaction or 'maxPriorityFeePerGas' in transaction)):
        raise DataError('invalid_lp_mint_transaction')
    data = transaction['data']
    if (not isinstance(data, str) or len(data) > 2 + MAX_CALLDATA_BYTES * 2
            or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2}){4,}', data)):
        raise DataError('invalid_lp_mint_transaction')
    raw = bytes.fromhex(data[2:])
    if raw[:4] != MODIFY_LIQUIDITIES_SELECTOR:
        # In particular, no multicall, initializePool, permit, or wrapper.
        raise DataError('unsupported_lp_mint_transaction')
    unlock_data, encoded_deadline = _canonical_decode(('bytes', 'uint256'), raw[4:])
    if encoded_deadline != deadline:
        raise DataError('lp_mint_request_mismatch')
    actions, params = _canonical_decode(('bytes', 'bytes[]'), unlock_data)
    native = key.currency0 == ZERO
    expected_actions = b'\x02\x0d\x14' if native else b'\x02\x0d'
    if actions != expected_actions or len(params) != len(expected_actions):
        raise DataError('unsupported_lp_mint_plan')
    mint_key, lower, upper, liquidity, cap0, cap1, recipient, hook_data = _canonical_decode(MINT_ABI, params[0])
    expected_key = (key.currency0, key.currency1, key.fee_pips, key.tick_spacing, key.hooks)
    if (mint_key != expected_key or lower != tick_lower or upper != tick_upper
            or recipient != owner):
        raise DataError('lp_mint_request_mismatch')
    if hook_data:
        raise DataError('unsupported_lp_mint_plan')
    if not 0 < liquidity <= MAX_LIQUIDITY or cap0 == cap1 == 0:
        raise DataError('invalid_lp_mint_amounts')
    settlement = _canonical_decode(('address', 'address'), params[1])
    if settlement != (key.currency0, key.currency1):
        raise DataError('lp_mint_request_mismatch')
    if native:
        currency, refund_recipient = _canonical_decode(('address', 'address'), params[2])
        if currency != ZERO or refund_recipient not in (owner, MSG_SENDER):
            raise DataError('lp_mint_request_mismatch')
    if native_value != (cap0 if native else 0):
        raise DataError('lp_mint_native_value_mismatch')
    return {'mintLiquidityRaw': str(liquidity), 'amount0MaxRaw': str(cap0),
            'amount1MaxRaw': str(cap1), 'nativeValueRaw': str(native_value)}
