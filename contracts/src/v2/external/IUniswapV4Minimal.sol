// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal local declarations of Uniswap v4 as deployed on Robinhood,
/// Base and Arbitrum (byte-identical builds; selectors pinned in
/// contracts/test/v2/DominoV2External.t.sol, checked 1 Oct 2026).
/// @dev Facts the implementations rely on (deployed build, not the newer
/// vendored copy under contracts/test/reference, which also emits a
/// ModifyPosition event mainnet never emits):
/// - INCREASE, DECREASE and BURN need the owner or an approval of msgSender();
///   unlike v3, increasing liquidity is not open. MINT is open.
/// - Every modifyLiquidity credits accrued fees to the caller's delta, so an
///   increase settles the position's uncollected fees.
/// - A transfer reverts while the PoolManager is unlocked, unsubscribes the
///   position (best-effort notifyUnsubscribe, 300000 gas) and clears the
///   approval: after any transfer the vault has neither.
/// - notifyModifyLiquidity and notifyBurn are blocking: a subscriber that
///   reverts blocks the owner's own change. Domino subscribers never revert on
///   a change the owner started; they disarm instead.
interface IV4PositionManagerMinimal {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function modifyLiquiditiesWithoutUnlock(bytes calldata actions, bytes[] calldata params) external payable;
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, uint256 info);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
    function nextTokenId() external view returns (uint256);
    function subscribe(uint256 tokenId, address newSubscriber, bytes calldata data) external payable;
    function unsubscribe(uint256 tokenId) external payable;
    function subscriber(uint256 tokenId) external view returns (address);
    function unsubscribeGasLimit() external view returns (uint256);
    function permit(address spender, uint256 tokenId, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function poolManager() external view returns (address);
}

/// @dev swap: amountSpecified < 0 is exact input. BalanceDelta packs amount0
/// in the high 128 bits and amount1 in the low 128 bits. Currency deltas live
/// in transient slot keccak256(abi.encode(target, currency)), read with exttload.
interface IV4PoolManagerMinimal {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function settleFor(address recipient) external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function exttload(bytes32 slot) external view returns (bytes32 value);
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

/// @dev getSlot0.protocolFee packs the zeroForOne fee in the low 12 bits and
/// the oneForZero fee in the high 12 bits, in pips (max 1000), taken from the
/// input before the LP fee.
interface IV4StateViewMinimal {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt)
        external
        view
        returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128);
    function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// @dev What a v4 subscriber implements. No transfer notification exists in
/// the deployed build.
interface IV4SubscriberMinimal {
    function notifySubscribe(uint256 tokenId, bytes memory data) external;
    function notifyUnsubscribe(uint256 tokenId) external;
    function notifyModifyLiquidity(uint256 tokenId, int256 liquidityChange, int256 feesAccrued) external;
    function notifyBurn(uint256 tokenId, address owner, uint256 info, uint256 liquidity, int256 feesAccrued) external;
}

interface IV4UnlockCallbackMinimal {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
