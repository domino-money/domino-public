// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T} from "./DominoVaultTypes.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Stateless price-ratio/geometry checks using the pinned official MIT math.
contract DominoRoutingHelperV4 {
    error InvalidGeometry();
    error InvalidPrice();

    function ratioBps(uint160 value, uint160 anchorPrice, bool inverse) public pure returns (uint256) {
        if (value == 0 || anchorPrice == 0) revert InvalidPrice();
        if (inverse) (value, anchorPrice) = (anchorPrice, value);
        // Exact floor(value squared * 10000 / anchorPrice squared).
        uint256 scaled = FullMath.mulDiv(value, uint256(value) * 10000, anchorPrice);
        return scaled / anchorPrice;
    }

    function nearCeiling(T.Position calldata member, uint160 price, bool inverse, uint16 trigger)
        external pure returns (bool) {
        uint160 ceiling = TickMath.getSqrtPriceAtTick(inverse ? member.tickLower : member.tickUpper);
        return ratioBps(price, ceiling, inverse) >= 10000 - trigger;
    }

    function validateSuccessor(T.Position calldata parent, int24 lower, int24 upper, int24 spacing,
        bool inverse, uint16 overlap, uint32 upside) external pure {
        if (spacing <= 0 || lower >= upper || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK
            || lower % spacing != 0 || upper % spacing != 0 || overlap > 2000 || upside == 0)
            revert InvalidGeometry();
        int24 ceilingTick = inverse ? lower : upper;
        int24 floorTick = inverse ? upper : lower;
        int24 priorCeiling = inverse ? parent.tickLower : parent.tickUpper;
        uint160 anchorPrice = TickMath.getSqrtPriceAtTick(priorCeiling);
        uint256 floorRatio = ratioBps(TickMath.getSqrtPriceAtTick(floorTick), anchorPrice, inverse);
        if (floorRatio < 10000 - overlap || floorRatio > 10000
            || ratioBps(TickMath.getSqrtPriceAtTick(ceilingTick), anchorPrice, inverse) < 10000 + upside)
            revert InvalidGeometry();
        int24 previous = inverse ? ceilingTick + spacing : ceilingTick - spacing;
        if (previous >= TickMath.MIN_TICK && previous <= TickMath.MAX_TICK &&
            ratioBps(TickMath.getSqrtPriceAtTick(previous), anchorPrice, inverse) >= 10000 + upside)
            revert InvalidGeometry();
    }

    function checkSwapPrices(uint160 beforePrice, uint160 afterPrice, uint160 anchorPrice,
        uint16 impactBps) external pure {
        if (impactBps >= 10000) revert InvalidPrice();
        uint256 beforeRatio = ratioBps(beforePrice, anchorPrice, false);
        uint256 afterRatio = ratioBps(afterPrice, anchorPrice, false);
        if (beforeRatio < 10000 - impactBps || _ratioCeil(beforePrice, anchorPrice) > 10000 + impactBps
            || afterRatio < 10000 - impactBps || _ratioCeil(afterPrice, anchorPrice) > 10000 + impactBps) revert InvalidPrice();
    }

    function _ratioCeil(uint160 value, uint160 anchorPrice) private pure returns (uint256) {
        uint256 scaled = FullMath.mulDivRoundingUp(value, uint256(value) * 10000, anchorPrice);
        return scaled / anchorPrice + (scaled % anchorPrice == 0 ? 0 : 1);
    }

    function minimumOutput(uint128 amountIn, uint160 price, bool zeroForOne, uint16 slippageBps)
        external pure returns (uint256) {
        if (price == 0 || slippageBps >= 10000) revert InvalidPrice();
        uint256 quote;
        if (price <= type(uint128).max) {
            uint256 ratio = uint256(price) * price;
            quote = zeroForOne ? FullMath.mulDiv(ratio, amountIn, uint256(1) << 192)
                : FullMath.mulDiv(uint256(1) << 192, amountIn, ratio);
        } else {
            uint256 ratio = FullMath.mulDiv(price, price, uint256(1) << 64);
            quote = zeroForOne ? FullMath.mulDiv(ratio, amountIn, uint256(1) << 128)
                : FullMath.mulDiv(uint256(1) << 128, amountIn, ratio);
        }
        return FullMath.mulDiv(quote, 10000 - slippageBps, 10000);
    }
}
