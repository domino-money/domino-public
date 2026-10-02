// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IUniswapV3PoolMinimal} from "../external/IUniswapV3Minimal.sol";
import {IV4PoolManagerMinimal} from "../external/IUniswapV4Minimal.sol";
import {FullMath} from "../positions/uniswap/FullMath.sol";

/// @notice The fee-aware swap floor (#282, the #3409682 fix).
/// @dev V1 required minAmountOut >= quote × (1 − maxSlippageBps), so the
/// pool's own fee counted as slippage and in a 2% pool no swap could pass a
/// 1% limit (97.8% of spot against a 99% floor). V2's floor excludes the
/// pool's total fee:
///     floor = quote(amountIn at sqrtPriceX96) × (1 − poolFee) × (1 − maxSlippageBps)
/// with poolFee in pips. On v4 the total fee is the protocol fee, taken from
/// the input first, plus the LP fee on the rest (ProtocolFeeLibrary
/// .calculateSwapFee). On v3 the protocol fee is a share of the LP fee
/// (slot0.feeProtocol = 1/N of it), so the swapper pays exactly pool.fee().
/// Pass the anchor price the action is bounded by (IDominoPriceAnchor), not a
/// bare spot that a sandwich can move within the band.
library DominoSwapFloor {
    error InvalidFloor();

    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant BPS = 10_000;
    /// v4-core StateLibrary.POOLS_SLOT: PoolManager's `_pools` mapping.
    bytes32 private constant V4_POOLS_SLOT = bytes32(uint256(6));

    /// @notice amountIn converted at sqrtPriceX96 (token1 per token0, Q64.96), rounded down.
    function quote(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) revert InvalidFloor();
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return zeroForOne
                ? FullMath.mulDiv(ratioX192, amountIn, 1 << 192)
                : FullMath.mulDiv(1 << 192, amountIn, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return zeroForOne
            ? FullMath.mulDiv(ratioX128, amountIn, 1 << 128)
            : FullMath.mulDiv(1 << 128, amountIn, ratioX128);
    }

    /// @notice The least output a swap of amountIn may deliver: the quote
    /// less the pool's own fee (poolFeePips, LP plus protocol), less the
    /// owner's maxSlippageBps. One rounding, down.
    function minimumOutput(
        uint256 amountIn,
        uint160 sqrtPriceX96,
        bool zeroForOne,
        uint24 poolFeePips,
        uint16 maxSlippageBps
    ) internal pure returns (uint256) {
        if (poolFeePips >= PIPS || maxSlippageBps >= BPS) revert InvalidFloor();
        return FullMath.mulDiv(
            quote(amountIn, sqrtPriceX96, zeroForOne), (PIPS - poolFeePips) * (BPS - maxSlippageBps), PIPS * BPS
        );
    }

    /// @notice A v4 swap's total fee in pips for one direction, exactly as
    /// v4-core charges it: protocol + lp − protocol × lp / 1e6.
    /// @param protocolFee getSlot0().protocolFee: zeroForOne in the low 12 bits, oneForZero in the next 12.
    function v4SwapFeePips(uint24 protocolFee, uint24 lpFee, bool zeroForOne) internal pure returns (uint24) {
        uint256 protocol = zeroForOne ? protocolFee & 0xfff : (protocolFee >> 12) & 0xfff;
        return uint24(protocol + lpFee - protocol * lpFee / PIPS);
    }

    /// @notice The v4 PoolId of a PoolRef (keccak256 of the five PoolKey words).
    function v4PoolId(DominoV2Types.PoolRef memory pool) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks));
    }

    /// @notice A v4 pool's slot0 read straight from the PoolManager (as StateLibrary.getSlot0).
    function v4Slot0(address poolManager, bytes32 poolId)
        internal
        view
        returns (uint160 sqrtPriceX96, uint24 protocolFee, uint24 lpFee)
    {
        uint256 word = uint256(
            IV4PoolManagerMinimal(poolManager).extsload(keccak256(abi.encodePacked(poolId, V4_POOLS_SLOT)))
        );
        sqrtPriceX96 = uint160(word);
        protocolFee = uint24(word >> 184);
        lpFee = uint24(word >> 208);
    }

    /// @notice A v4 pool's spot and its total fee for the swap direction.
    function v4SpotAndFee(address poolManager, DominoV2Types.PoolRef memory pool, bool zeroForOne)
        internal
        view
        returns (uint160 sqrtPriceX96, uint24 poolFeePips)
    {
        (uint160 price, uint24 protocolFee, uint24 lpFee) = v4Slot0(poolManager, v4PoolId(pool));
        return (price, v4SwapFeePips(protocolFee, lpFee, zeroForOne));
    }

    /// @notice A v3 pool's spot and its total fee (the protocol share is inside the fee).
    function v3SpotAndFee(address pool) internal view returns (uint160 sqrtPriceX96, uint24 poolFeePips) {
        (sqrtPriceX96,,,,,,) = IUniswapV3PoolMinimal(pool).slot0();
        poolFeePips = IUniswapV3PoolMinimal(pool).fee();
    }
}
