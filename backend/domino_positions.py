"""Pools that hold a Domino position: every NFT the Setup contract minted.

Read-only. The Setup contract's own SetupMinted events since its deployment name
the positions; the PositionManager names each position's pool at one block. The
activity follower keeps those pools' activity current
(`manage_activity.py --follow --domino-positions`), so a new Domino pool joins
without anyone listing it.

The scan starts at the deployment block on every call: on our node the log index
answers it in milliseconds today, and its cost grows with the range (about 11 us
of node CPU per thousand blocks, docs/LOCAL_RPC_SOURCE.md).
"""
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import KEY_TYPES, POSITION_MANAGER, DataError, PoolKey, address, bytes32

# DominoSetupV1 on Robinhood (docs/deployments/v1-robinhood-mainnet-2026-09-21).
SETUP_CONTRACT = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'
SETUP_DEPLOY_BLOCK = 69_249_061
SETUP_MINTED_TOPIC = '0x' + keccak(b'SetupMinted(bytes32,address,uint256,uint128,uint128,uint128)').hex()
# One scan reads every position's key in turn, inside the follower's minute:
# 14 positions on 2 Oct 2026. Past the bound the scan refuses, and the bound
# (with manage_activity's request budget, derived from it) is raised then.
MAX_POSITIONS = 1_000
POOL_KEY = '(address,address,uint24,int24,address)'


def position_pools(rpc, head):
    """{poolId: [tokenIds]} for every position the Setup contract minted up to `head`.

    A burned position has no pool any more and is left out: Uniswap clears its
    positionInfo, as nft_ownership.read_identity reads it.
    """
    logs = rpc.request('eth_getLogs', [{'address': SETUP_CONTRACT, 'topics': [SETUP_MINTED_TOPIC],
                                        'fromBlock': hex(SETUP_DEPLOY_BLOCK), 'toBlock': hex(head.number)}])
    if not isinstance(logs, list):
        raise DataError('invalid_logs_response')
    if len(logs) > MAX_POSITIONS:
        raise DataError('domino_positions_over_bound')
    token_ids = set()
    for log in logs:
        topics = log.get('topics') if isinstance(log, dict) else None
        if (not isinstance(topics, list) or len(topics) != 4 or address(log.get('address')) != SETUP_CONTRACT
                or topics[0] != SETUP_MINTED_TOPIC):
            raise DataError('invalid_setup_log')
        token_ids.add(int(bytes32(topics[3]), 16))
    pools = {}
    for token_id in sorted(token_ids):
        raw_key, info = rpc.call(POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], [token_id],
                                 [POOL_KEY, 'uint256'], block=head.tag)
        if type(info) is not int or not 0 <= info < 2 ** 256:
            raise DataError('invalid_nft_position_info')
        if info == 0:
            continue
        pool_id = '0x' + keccak(encode(KEY_TYPES, raw_key)).hex()
        PoolKey.checked(raw_key, pool_id)
        # positionInfo carries the first 25 bytes of its pool's id.
        if info >> 56 != int(pool_id, 16) >> 56:
            raise DataError('nft_pool_mismatch')
        pools.setdefault(pool_id, []).append(token_id)
    return pools
