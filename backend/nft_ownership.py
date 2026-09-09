"""Official PositionManager NFT identity and owner at one pinned block.

No symbol matching, transaction-sender inference, owner cache, wallet authentication
or entitlement to fees previously settled to an earlier holder.
"""
from dataclasses import asdict
import re

from eth_abi import encode
from eth_hash.auto import keccak

from discovery import (CHAIN_ID, KEY_TYPES, POSITION_MANAGER, STATE_VIEW, ZERO,
                       DataError, PoolKey, address, bytes32)
from position_accounting import core_position_id, principal_amounts
from pool_activity import valid_price
from v4_math import Q128, U256

VERSION = 1


def token_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,77})', value):
        raise DataError('invalid_nft_token_id')
    result = int(value)
    if result >= 2**256:
        raise DataError('invalid_nft_token_id')
    return result


def signed_tick(word):
    word &= 0xffffff
    return word-(1 << 24) if word & (1 << 23) else word


def read_identity(rpc, value, block):
    number = token_id(value)
    raw_key, info = rpc.call(POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], [number],
                            ['(address,address,uint24,int24,address)', 'uint256'], block=block.tag)
    if type(info) is not int or not 0 <= info <= U256:
        raise DataError('invalid_nft_position_info')
    # Uniswap clears positionInfo on burn. A transport/revert error is NEVER a burn.
    if info == 0:
        return {'tokenId': value, 'status': 'position_info_empty_at_snapshot', 'owner': None,
                'corePositionId': None, 'nftOwnershipResolved': False}
    pool_id = '0x'+keccak(encode(KEY_TYPES, raw_key)).hex()
    key = PoolKey.checked(raw_key, pool_id)
    lower, upper = signed_tick(info >> 8), signed_tick(info >> 32)
    if (not -887272 <= lower < upper <= 887272 or lower % key.tick_spacing or upper % key.tick_spacing or
            info >> 56 != int(pool_id, 16) >> 56):
        raise DataError('nft_pool_or_range_mismatch')
    owner, = rpc.call(POSITION_MANAGER, 'ownerOf(uint256)', ['uint256'], [number], ['address'], block=block.tag)
    owner = address(owner)
    if owner == ZERO:
        raise DataError('nft_live_position_has_no_owner')
    liquidity, = rpc.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint256'], [number],
                          ['uint128'], block=block.tag)
    salt = '0x'+number.to_bytes(32, 'big').hex()
    return {'tokenId': value, 'status': 'owner_verified_at_snapshot', 'owner': owner,
            'positionManager': POSITION_MANAGER, 'poolId': pool_id, 'poolKey': asdict(key),
            'tickLower': lower, 'tickUpper': upper, 'salt': salt, 'liquidityRaw': str(liquidity),
            'coreOwner': POSITION_MANAGER, 'corePositionId': core_position_id(POSITION_MANAGER, lower, upper, salt),
            'nftOwnershipResolved': True, 'ownershipBasis': 'ownerOf_at_pinned_block',
            'walletControlVerified': False, 'isWithdrawalQuote': False, 'executionAvailable': False}


def read_nft_position(rpc, value, block):
    result = read_identity(rpc, value, block)
    if not result['nftOwnershipResolved']:
        return result
    pool = bytes.fromhex(result['poolId'][2:])
    lo, hi, number = result['tickLower'], result['tickUpper'], token_id(value)
    liquidity, last0, last1 = rpc.call(STATE_VIEW, 'getPositionInfo(bytes32,address,int24,int24,bytes32)',
        ['bytes32', 'address', 'int24', 'int24', 'bytes32'],
        [pool, POSITION_MANAGER, lo, hi, number.to_bytes(32, 'big')], ['uint128', 'uint256', 'uint256'], block=block.tag)
    if str(liquidity) != result['liquidityRaw']:
        raise DataError('nft_core_liquidity_mismatch')
    sqrt_price, tick, _, _ = rpc.call(STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'], [pool],
                                    ['uint160', 'int24', 'uint24', 'uint24'], block=block.tag)
    valid_price(sqrt_price, tick)
    growth = rpc.call(STATE_VIEW, 'getFeeGrowthInside(bytes32,int24,int24)', ['bytes32', 'int24', 'int24'],
                      [pool, lo, hi], ['uint256', 'uint256'], block=block.tag)
    principal = principal_amounts({'sqrtPriceX96': str(sqrt_price)}, lo, hi, liquidity)
    fees = [((growth[i]-last) & U256)*liquidity//Q128 for i, last in enumerate((last0, last1))]
    return {**result, 'principalRaw': list(map(str, principal)), 'unsettledFeesRaw': list(map(str, fees)),
            'inRange': lo <= tick < hi, 'hasLiquidity': liquidity > 0,
            'amountScope': 'current_core_principal_and_unsettled_fees_only',
            'pastSettledFeesAttributedToCurrentOwner': False, 'tokenCompatibilityQualified': False}


def resolve_core_owners(rpc, pool_id, positions, block):
    items = []
    for position in positions:
        item = dict(position)
        if address(position['coreOwner']) != POSITION_MANAGER:
            item['nft'] = {'status': 'core_owner_adapter_required', 'owner': None, 'nftOwnershipResolved': False}
        else:
            value = str(int(bytes32(position['salt']), 16))
            nft = read_identity(rpc, value, block)
            if nft['nftOwnershipResolved']:
                if (nft['poolId'] != pool_id or nft['corePositionId'] != position['corePositionId'] or
                        nft['liquidityRaw'] != position['liquidityRaw']):
                    raise DataError('nft_core_identity_mismatch')
            elif position['liquidityRaw'] != '0':
                raise DataError('nft_active_core_has_empty_position_info')
            item['nft'] = nft
        items.append(item)
    return items
