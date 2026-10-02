// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FixedPoint128} from "./uniswap/FixedPoint128.sol";
import {FullMath} from "./uniswap/FullMath.sol";
import {LiquidityAmounts} from "./uniswap/LiquidityAmounts.sol";
import {SqrtPriceMath} from "./uniswap/SqrtPriceMath.sol";
import {TickMath} from "./uniswap/TickMath.sol";

/// @notice Liquidity arithmetic shared by the v3 and v4 position adapters
/// (domino-money/domino#283, F1c). Every function reproduces what the pools
/// compute, with the rounding direction stated, so a caller can predict an
/// action exactly: Uniswap v3 pools and the v4 PoolManager use the same
/// formulas (SqrtPriceMath, LiquidityAmounts, Position/Tick fee growth).
/// @dev The math under ./uniswap is vendored from Uniswap v4-core and
/// v4-periphery (docs/v2/F1_POSITIONS.md, "Vendored math"); only the pragma
/// and two import paths differ from the reference copies.
library DominoPositionMath {
    error InvalidRange(int24 tickLower, int24 tickUpper, int24 tickSpacing);
    error PoolNotInitialized();

    /// @notice Reverts unless the ticks are ordered, inside the protocol's
    /// bounds and multiples of a positive tick spacing: the checks both pool
    /// versions apply, raised before any token moves.
    function checkRange(int24 tickLower, int24 tickUpper, int24 tickSpacing) internal pure {
        if (
            tickSpacing <= 0 || tickLower >= tickUpper || tickLower < TickMath.MIN_TICK
                || tickUpper > TickMath.MAX_TICK || tickLower % tickSpacing != 0 || tickUpper % tickSpacing != 0
        ) revert InvalidRange(tickLower, tickUpper, tickSpacing);
    }

    /// @notice The most liquidity `amount0` and `amount1` can fund in
    /// [tickLower, tickUpper) at `sqrtPriceX96`. Rounds down (LiquidityAmounts),
    /// exactly as the v3 NonfungiblePositionManager sizes a mint, so the
    /// amounts a pool charges for the result (amountsForLiquidity with
    /// roundUp) never exceed the inputs.
    function liquidityForAmounts(
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );
    }

    /// @notice The token amounts `liquidity` represents in [tickLower,
    /// tickUpper) at `sqrtPriceX96`. With roundUp = true this is what a pool
    /// charges to add the liquidity; with roundUp = false it is the principal a
    /// pool pays out to remove it (fees come on top). The two differ by at most
    /// one unit per token.
    function amountsForLiquidity(
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        bool roundUp
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        uint160 lower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(tickUpper);
        // The pools branch on the stored tick; on a range boundary both readings
        // give the same amounts, so the price comparison below is exact.
        if (sqrtPriceX96 <= lower) {
            amount0 = SqrtPriceMath.getAmount0Delta(lower, upper, liquidity, roundUp);
        } else if (sqrtPriceX96 < upper) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, upper, liquidity, roundUp);
            amount1 = SqrtPriceMath.getAmount1Delta(lower, sqrtPriceX96, liquidity, roundUp);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(lower, upper, liquidity, roundUp);
        }
    }

    /// @notice Fee growth per unit of liquidity inside [tickLower, tickUpper),
    /// in Q128, from the pool's global growth and the two ticks' outside
    /// growth. Wrapping arithmetic, as in v3 Tick.getFeeGrowthInside and v4
    /// Pool.getFeeGrowthInside: only differences of these values are meaningful.
    function feeGrowthInside(
        int24 tickCurrent,
        int24 tickLower,
        int24 tickUpper,
        uint256 feeGrowthGlobalX128,
        uint256 lowerOutsideX128,
        uint256 upperOutsideX128
    ) internal pure returns (uint256 insideX128) {
        unchecked {
            if (tickCurrent < tickLower) insideX128 = lowerOutsideX128 - upperOutsideX128;
            else if (tickCurrent >= tickUpper) insideX128 = upperOutsideX128 - lowerOutsideX128;
            else insideX128 = feeGrowthGlobalX128 - lowerOutsideX128 - upperOutsideX128;
        }
    }

    /// @notice Fees `liquidity` earned between two fee-growth readings, rounded
    /// down as the pools credit them.
    function feesEarned(uint256 insideX128, uint256 insideLastX128, uint128 liquidity)
        internal
        pure
        returns (uint256)
    {
        unchecked {
            return FullMath.mulDiv(insideX128 - insideLastX128, liquidity, FixedPoint128.Q128);
        }
    }
}
