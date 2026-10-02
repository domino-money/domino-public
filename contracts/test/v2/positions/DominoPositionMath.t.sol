// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoPositionMath} from "../../../src/v2/positions/DominoPositionMath.sol";
import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {PositionTestKit} from "./PositionTestKit.sol";

/// @notice DominoPositionMath on its own: range checks, rounding directions and
/// fee growth. Its agreement with the real pools is proven in the v3 and v4
/// suites, which compare every predicted amount with what the pools charge.
contract DominoPositionMathTest is PositionTestKit {
    uint160 internal constant PRICE_ONE = 79228162514264337593543950336;

    // External entry points, so a revert happens one call deep.
    function checkRange(int24 lower, int24 upper, int24 spacing) external pure {
        DominoPositionMath.checkRange(lower, upper, spacing);
    }

    function liquidityForAmounts(uint160 price, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        external
        pure
        returns (uint128)
    {
        return DominoPositionMath.liquidityForAmounts(price, lower, upper, amount0, amount1);
    }

    function amountsForLiquidity(uint160 price, int24 lower, int24 upper, uint128 liquidity, bool roundUp)
        external
        pure
        returns (uint256, uint256)
    {
        return DominoPositionMath.amountsForLiquidity(price, lower, upper, liquidity, roundUp);
    }

    function _refused(int24 lower, int24 upper, int24 spacing) private {
        vm.expectRevert(abi.encodeWithSelector(DominoPositionMath.InvalidRange.selector, lower, upper, spacing));
        this.checkRange(lower, upper, spacing);
    }

    function testCheckRangeAcceptsOrderedAlignedRanges() public view {
        this.checkRange(-600, 600, 60);
        this.checkRange(-887272, 887272, 1);
        this.checkRange(-887200, 887200, 200);
        this.checkRange(0, 10, 10);
    }

    function testCheckRangeRefusesEachViolation() public {
        _refused(-600, 600, 0);
        _refused(-600, 600, -60);
        _refused(600, 600, 60);
        _refused(660, 600, 60);
        _refused(-887273, 0, 1);
        _refused(0, 887273, 1);
        _refused(-610, 600, 60);
        _refused(-600, 610, 60);
    }

    function testAnUninitializedPriceIsRefused() public {
        vm.expectRevert(DominoPositionMath.PoolNotInitialized.selector);
        this.liquidityForAmounts(0, -600, 600, 1e18, 1e18);
        vm.expectRevert(DominoPositionMath.PoolNotInitialized.selector);
        this.amountsForLiquidity(0, -600, 600, 1e18, true);
    }

    /// The core sizing property: what the pool charges for the liquidity the
    /// inputs fund never exceeds the inputs.
    function testFuzzLiquidityNeverOverchargesTheInputs(
        uint256 priceSeed,
        int24 lowerSeed,
        uint24 width,
        uint128 amount0,
        uint128 amount1
    ) public view {
        int24 lower = int24(int256(_bound(uint256(int256(lowerSeed) + 887272), 0, 2 * 887272 - 1)) - 887272);
        int24 upper = int24(int256(_bound(width, 1, uint256(int256(887272 - lower)))) + lower);
        uint160 price = uint160(_bound(priceSeed, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        try this.liquidityForAmounts(price, lower, upper, amount0, amount1) returns (uint128 liquidity) {
            (uint256 owed0, uint256 owed1) = this.amountsForLiquidity(price, lower, upper, liquidity, true);
            _true(owed0 <= amount0, "amount0 within the input");
            _true(owed1 <= amount1, "amount1 within the input");
        } catch {
            // More than 2^128 liquidity: nothing to check.
        }
    }

    function testFuzzRoundingUpAddsAtMostOneUnit(uint256 priceSeed, int24 lowerSeed, uint24 width, uint128 liquidity)
        public
        view
    {
        int24 lower = int24(int256(_bound(uint256(int256(lowerSeed) + 887272), 0, 2 * 887272 - 1)) - 887272);
        int24 upper = int24(int256(_bound(width, 1, uint256(int256(887272 - lower)))) + lower);
        uint160 price = uint160(_bound(priceSeed, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        (uint256 up0, uint256 up1) = this.amountsForLiquidity(price, lower, upper, liquidity, true);
        (uint256 down0, uint256 down1) = this.amountsForLiquidity(price, lower, upper, liquidity, false);
        _true(up0 >= down0 && up0 - down0 <= 1, "amount0 rounding");
        _true(up1 >= down1 && up1 - down1 <= 1, "amount1 rounding");
    }

    function testRangeEdgesUseOneToken() public view {
        uint160 lower = TickMath.getSqrtPriceAtTick(-600);
        uint160 upper = TickMath.getSqrtPriceAtTick(600);
        (uint256 full0,) = this.amountsForLiquidity(lower - 1, -600, 600, 1e18, true);
        (uint256 at0, uint256 at1) = this.amountsForLiquidity(lower, -600, 600, 1e18, true);
        _eq(at0, full0, "at the lower edge the position is all currency0");
        _eq(at1, 0, "and no currency1");
        (, uint256 full1) = this.amountsForLiquidity(upper, -600, 600, 1e18, true);
        (uint256 in0, uint256 in1) = this.amountsForLiquidity(upper - 1, -600, 600, 1e18, true);
        _true(in0 > 0 && in1 <= full1, "just below the upper edge both tokens");
        (at0, at1) = this.amountsForLiquidity(upper, -600, 600, 1e18, true);
        _eq(at0, 0, "at the upper edge no currency0");
        _eq(at1, full1, "and all currency1");
        // At the lower edge the position is sized on currency0 alone; the unit
        // full0 was rounded up by is worth a few units of liquidity here.
        uint128 sized = this.liquidityForAmounts(lower, -600, 600, full0, 0);
        _true(sized >= 1e18 - 1 && sized <= 1e18 + 64, "lower edge sizes on currency0");
        (uint256 again0, uint256 again1) = this.amountsForLiquidity(lower, -600, 600, sized, true);
        _true(again0 <= full0 && again1 == 0, "and never charges more than full0");
    }

    function testFeeGrowthInsideFollowsThePools() public pure {
        // Below the range: lower outside minus upper outside.
        _eq(DominoPositionMath.feeGrowthInside(-601, -600, 600, 1000, 300, 100), 200, "below");
        // At the lower tick the range is active.
        _eq(DominoPositionMath.feeGrowthInside(-600, -600, 600, 1000, 300, 100), 600, "at lower");
        _eq(DominoPositionMath.feeGrowthInside(599, -600, 600, 1000, 300, 100), 600, "inside");
        // At the upper tick the range is not active: upper outside minus lower outside.
        _eq(DominoPositionMath.feeGrowthInside(600, -600, 600, 1000, 100, 300), 200, "at upper");
        // Wrapping arithmetic, as the pools use.
        _eq(
            DominoPositionMath.feeGrowthInside(0, -600, 600, 5, 10, 0),
            type(uint256).max - 4,
            "inside wraps below zero"
        );
        _eq(DominoPositionMath.feeGrowthInside(-601, -600, 600, 0, 1, 2), type(uint256).max, "below wraps");
        _eq(DominoPositionMath.feeGrowthInside(600, -600, 600, 0, 2, 1), type(uint256).max, "above wraps");
    }

    function testFeesEarnedRoundDownAndWrap() public pure {
        uint256 q128 = 1 << 128;
        _eq(DominoPositionMath.feesEarned(3 * q128, q128, 5), 10, "growth times liquidity");
        _eq(DominoPositionMath.feesEarned(q128 + q128 / 2, q128, 3), 1, "rounded down");
        _eq(DominoPositionMath.feesEarned(q128 - 1, type(uint256).max, 2), 2, "wrapped growth");
    }
}
