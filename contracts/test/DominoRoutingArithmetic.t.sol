// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoRoutingHelperV4} from "../src/DominoRoutingHelperV4.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// The vendored FullMath's mulDiv is internal; this exposes it so a test can
/// find the exact line where it overflows, independently of the guard.
contract FullMathProbe {
    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return FullMath.mulDiv(a, b, d); }
}

/**
 * The routing helper's arithmetic, pinned at its edges (review D-09).
 *
 * The review put the overflow threshold of ratioBps down as an arithmetic
 * estimate. These constants were computed outside Solidity, with unbounded
 * integers, and the tests make the contract agree with them to the unit -
 * where the guard sits, where the multiplication would really overflow, where
 * minimumOutput's two branches meet, and the one price region where it can
 * overflow at all.
 */
contract DominoRoutingArithmeticTest {
    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 private constant SPREAD = 1 << 54;
    uint160 private constant ANCHOR = uint160(1) << 96;

    // ratioBps(type(uint160).max, type(uint160).max >> 54): the largest spread the guard admits.
    uint256 private constant RATIO_AT_LARGEST_SPREAD = 3245185536584267267831560205762639999;
    // With value at uint160 max, value * value * 10000 / anchor first fits in 256 bits at this anchor;
    // one below, FullMath overflows. That is 2^77.29, against the guard's 2^105.97 (max >> 54).
    uint256 private constant OVERFLOW_ANCHOR = 184467440737095516160000;
    // minimumOutput at the branch boundary, amountIn = uint128 max, no slippage.
    uint256 private constant Z_BELOW = 6277101735386680763835789423207666416047015212242905858048;
    uint256 private constant Z_ABOVE = 6277101735386680763835789423207666416083908700390324961280;
    uint256 private constant NZ_BELOW = 18446744073709551616;
    uint256 private constant NZ_ABOVE = 18446744073709551615;
    uint256 private constant NZ_AT_MIN_SQRT = 115783384738768196242144082653949453838306988932806144552194799290216044976282;
    uint256 private constant Z_AT_MAX_SQRT = 115783384785599357996676985412062652720342362943929506828539444553934033845703;
    // checkSwapPrices at 100 bps around ANCHOR: the exact first admitted price below and last above.
    uint160 private constant LOWEST_ADMITTED = 78831026366734652303669917532;
    uint160 private constant HIGHEST_ADMITTED = 79623317895830914510639640423;

    DominoRoutingHelperV4 private routing;
    FullMathProbe private probe;

    function setUp() public {
        routing = new DominoRoutingHelperV4();
        probe = new FullMathProbe();
    }

    function _refused(bytes memory data, bytes4 expected, string memory what) private view {
        (bool ok, bytes memory out) = address(routing).staticcall(data);
        require(!ok && out.length >= 4 && bytes4(out) == expected, what);
    }

    // ------------------------------------------------------------ ratioBps

    function testRatioBpsIsExactOnPowersOfTwo() external view {
        require(routing.ratioBps(uint160(1) << 100, uint160(1) << 100, false) == 10000, "equal prices");
        require(routing.ratioBps(uint160(1) << 100, uint160(1) << 99, false) == 40000, "twice the anchor is four times the price");
        require(routing.ratioBps(uint160(1) << 99, uint160(1) << 100, false) == 2500, "half the anchor is a quarter of the price");
        require(routing.ratioBps(uint160(1) << 99, uint160(1) << 100, true) == 40000, "inverse swaps the operands");
    }

    /// The guard admits value / anchor == 2^54 and refuses 2^54 + 1, at the
    /// top of uint160 where the multiplication is largest.
    function testTheSpreadGuardSitsExactlyAtTwoToTheFiftyFour() external view {
        uint160 value = type(uint160).max;
        uint160 admitted = value >> 54;
        require(value / admitted == SPREAD, "the boundary anchor gives the boundary spread");
        require(routing.ratioBps(value, admitted, false) == RATIO_AT_LARGEST_SPREAD, "largest admitted ratio");
        _refused(abi.encodeCall(DominoRoutingHelperV4.ratioBps, (value, value >> 55, false)),
            DominoRoutingHelperV4.InvalidPrice.selector, "one more bit of spread");
        _refused(abi.encodeCall(DominoRoutingHelperV4.ratioBps, (value, 0, false)),
            DominoRoutingHelperV4.InvalidPrice.selector, "a zero anchor");
        _refused(abi.encodeCall(DominoRoutingHelperV4.ratioBps, (0, admitted, false)),
            DominoRoutingHelperV4.InvalidPrice.selector, "a zero value");
    }

    /// Where the multiplication would really overflow, measured against
    /// FullMath itself: the guard is what keeps ratioBps 2^28 short of it.
    function testTheGuardIsTwentyEightBitsInsideTheRealOverflowLine() external view {
        uint256 value = type(uint160).max;
        uint256 product = value * 10000;
        require(probe.mulDiv(value, product, OVERFLOW_ANCHOR) <= type(uint256).max, "fits at the line");
        (bool ok,) = address(probe).staticcall(abi.encodeCall(FullMathProbe.mulDiv, (value, product, OVERFLOW_ANCHOR - 1)));
        require(!ok, "one below the line overflows");
        require((type(uint160).max >> 54) / OVERFLOW_ANCHOR >= 1 << 28, "the guard's anchor is at least 2^28 times the line");
    }

    // ------------------------------------------------------ minimumOutput

    /// The two branches - direct square below uint128, square over 2^64 above -
    /// agree to within rounding where they meet.
    function testMinimumOutputBranchesMeetAtTheUint128Boundary() external view {
        uint128 amount = type(uint128).max;
        require(routing.minimumOutput(amount, type(uint128).max, true, 0) == Z_BELOW, "zeroForOne below");
        require(routing.minimumOutput(amount, uint160(type(uint128).max) + 1, true, 0) == Z_ABOVE, "zeroForOne above");
        require(routing.minimumOutput(amount, type(uint128).max, false, 0) == NZ_BELOW, "oneForZero below");
        require(routing.minimumOutput(amount, uint160(type(uint128).max) + 1, false, 0) == NZ_ABOVE, "oneForZero above");
        require(NZ_BELOW - NZ_ABOVE == 1, "the branches differ by one unit of rounding, no more");
        // The boundary is not a convention: at 2^128 - 1 the two formulas really
        // differ for some amounts, so the price must take the direct branch.
        // Found by mutation - moving the boundary down by one survived the
        // maximum-amount vectors above, because there the two agree.
        require(routing.minimumOutput(type(uint128).max - 1, type(uint128).max, false, 0) == (uint256(1) << 64) - 1,
            "the direct branch floors to 2^64 - 1 where the shifted one would give 2^64");
        require(routing.minimumOutput((uint128(1) << 127) - 1, type(uint128).max, false, 0) == (uint256(1) << 63) - 1,
            "and to 2^63 - 1 where the shifted one would give 2^63");
    }

    /// The one region where the quote can overflow: a sqrt price below 2^32,
    /// selling currency1 for the maximum amount. The smallest price Uniswap v4
    /// admits is 161,443 above 2^32, so no pool reading reaches it; the guard's
    /// band could publish such a price only against a pool sitting at the very
    /// bottom tick, and the outcome is a refused swap, not a wrong quote.
    function testMinimumOutputOverflowsOnlyBelowTheSmallestValidPrice() external view {
        uint128 amount = type(uint128).max;
        require(routing.minimumOutput(amount, uint160(1) << 32, false, 0) == (uint256(1) << 256 - 128) * ((uint256(1) << 128) - 1),
            "at 2^32 the quote is 2^256 - 2^128 and fits");
        (bool ok,) = address(routing).staticcall(abi.encodeCall(DominoRoutingHelperV4.minimumOutput,
            (amount, (uint160(1) << 32) - 1, false, 0)));
        require(!ok, "one below 2^32 overflows");
        require(routing.minimumOutput(amount, MIN_SQRT_PRICE, false, 0) == NZ_AT_MIN_SQRT, "the smallest valid price fits");
        require(routing.minimumOutput(amount, MAX_SQRT_PRICE, true, 0) == Z_AT_MAX_SQRT, "the largest valid price fits");
        require(MIN_SQRT_PRICE - (uint160(1) << 32) == 161443, "the margin below the smallest valid price");
    }

    /// For every valid price, amount and slippage, in both directions: no
    /// revert, and the floor never exceeds the unslipped quote.
    function testFuzzMinimumOutputNeverRevertsInsideTheValidPriceRange(uint160 price, uint128 amount, uint16 slippage, bool zeroForOne)
        external view
    {
        price = uint160(MIN_SQRT_PRICE + uint256(price) % (uint256(MAX_SQRT_PRICE) - MIN_SQRT_PRICE + 1));
        slippage = uint16(slippage % 10000);
        uint256 unslipped = routing.minimumOutput(amount, price, zeroForOne, 0);
        uint256 floor = routing.minimumOutput(amount, price, zeroForOne, slippage);
        require(floor <= unslipped, "a floor above the quote");
        // The same 512-bit product the contract takes, so the quote near 2^256 does not overflow here.
        require(floor == probe.mulDiv(unslipped, 10000 - slippage, 10000), "a floor that is not the slippage it was asked for");
    }

    function testMinimumOutputRefusesAZeroPriceAndTotalSlippage() external view {
        _refused(abi.encodeCall(DominoRoutingHelperV4.minimumOutput, (1, 0, true, 0)),
            DominoRoutingHelperV4.InvalidPrice.selector, "zero price");
        _refused(abi.encodeCall(DominoRoutingHelperV4.minimumOutput, (1, ANCHOR, true, 10000)),
            DominoRoutingHelperV4.InvalidPrice.selector, "100% slippage");
    }

    // ---------------------------------------------------- checkSwapPrices

    /**
     * _ratioCeil repeats ratioBps's two guards - a zero anchor and the spread
     * limit - and neither can be the one that decides: checkSwapPrices calls
     * ratioBps with the same operands first, so a zero anchor or an excessive
     * spread is refused before _ratioCeil runs. Both were deletable with this
     * suite green; they stay as the private function's own statement of its
     * domain, and this test pins the refusals that reach the caller.
     */
    function testTheCeilingGuardsAreRefusedByTheFloorFirst() external view {
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (ANCHOR, ANCHOR, 0, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "a zero anchor");
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (type(uint160).max, ANCHOR, type(uint160).max >> 55, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "a spread beyond 2^54");
    }

    /// The impact limit is exact to the wei on both sides: the floor ratio
    /// decides below the anchor, the ceiling ratio above.
    function testCheckSwapPricesIsExactToTheWeiOnBothSides() external view {
        routing.checkSwapPrices(LOWEST_ADMITTED, LOWEST_ADMITTED, ANCHOR, 100);
        routing.checkSwapPrices(HIGHEST_ADMITTED, HIGHEST_ADMITTED, ANCHOR, 100);
        routing.checkSwapPrices(LOWEST_ADMITTED, HIGHEST_ADMITTED, ANCHOR, 100);
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (LOWEST_ADMITTED - 1, ANCHOR, ANCHOR, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "one wei below the floor, before");
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (ANCHOR, LOWEST_ADMITTED - 1, ANCHOR, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "one wei below the floor, after");
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (HIGHEST_ADMITTED + 1, ANCHOR, ANCHOR, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "one wei above the ceiling, before");
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (ANCHOR, HIGHEST_ADMITTED + 1, ANCHOR, 100)),
            DominoRoutingHelperV4.InvalidPrice.selector, "one wei above the ceiling, after");
        _refused(abi.encodeCall(DominoRoutingHelperV4.checkSwapPrices, (ANCHOR, ANCHOR, ANCHOR, 10000)),
            DominoRoutingHelperV4.InvalidPrice.selector, "an impact limit of everything");
        require(routing.ratioBps(LOWEST_ADMITTED, ANCHOR, false) == 9900 && routing.ratioBps(LOWEST_ADMITTED - 1, ANCHOR, false) == 9899,
            "the floor boundary is where ratioBps crosses 9900");
    }
}
