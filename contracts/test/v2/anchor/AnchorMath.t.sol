// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {AnchorMath} from "../../../src/v2/anchor/AnchorMath.sol";
import {RegistryFixtures} from "../registry/RegistryFixtures.sol";

/// @notice External entry points, so reverts can be expected.
contract AnchorMathHarness {
    function sqrtAt(int24 tick) external pure returns (uint160) {
        return AnchorMath.getSqrtPriceAtTick(tick);
    }

    function upstreamSqrtAt(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }
}

/// @notice AnchorMath against independent references: the reference v4-core
/// TickMath and FullMath under contracts/test/reference (the shared copy in
/// src/v2/positions/uniswap must equal them) and exact big-integer vectors
/// computed in Python.
contract AnchorMathTest is RegistryFixtures {
    uint160 internal constant PRICE = 79228162514264337593543950336;
    AnchorMathHarness internal harness;

    function setUp() public {
        harness = new AnchorMathHarness();
    }

    // ------------------------------------------------------------ TickMath
    function testSharedTickMathMatchesUpstreamAtEveryBit() public pure {
        int24[8] memory edges = [int24(0), 1, -1, AnchorMath.MIN_TICK, AnchorMath.MAX_TICK, AnchorMath.MIN_TICK + 1, AnchorMath.MAX_TICK - 1, -201060];
        for (uint256 i; i < edges.length; ++i) {
            _eq(AnchorMath.getSqrtPriceAtTick(edges[i]), TickMath.getSqrtPriceAtTick(edges[i]), "edge tick");
        }
        for (uint256 bit; bit < 20; ++bit) {
            int24 tick = int24(int256(1 << bit));
            _eq(AnchorMath.getSqrtPriceAtTick(tick), TickMath.getSqrtPriceAtTick(tick), "positive bit");
            _eq(AnchorMath.getSqrtPriceAtTick(-tick), TickMath.getSqrtPriceAtTick(-tick), "negative bit");
        }
        _eq(AnchorMath.getSqrtPriceAtTick(AnchorMath.MIN_TICK), AnchorMath.MIN_SQRT_PRICE, "min sqrt price");
        _eq(AnchorMath.getSqrtPriceAtTick(AnchorMath.MAX_TICK), AnchorMath.MAX_SQRT_PRICE, "max sqrt price");
        _eq(AnchorMath.getSqrtPriceAtTick(0), PRICE, "tick 0 is price 1");
    }

    function testFuzzSharedTickMathMatchesUpstream(uint256 seed) public pure {
        int24 tick = int24(int256(seed % 1_774_545) - 887_272);
        _eq(AnchorMath.getSqrtPriceAtTick(tick), TickMath.getSqrtPriceAtTick(tick), "tick");
    }

    function testOutOfRangeTicksRevertLikeUpstream() public {
        int24[4] memory outside =
            [AnchorMath.MAX_TICK + 1, AnchorMath.MIN_TICK - 1, type(int24).max, type(int24).min];
        for (uint256 i; i < outside.length; ++i) {
            bytes memory expected = abi.encodeWithSelector(TickMath.InvalidTick.selector, outside[i]);
            vm.expectRevert(expected);
            harness.sqrtAt(outside[i]);
            vm.expectRevert(expected);
            harness.upstreamSqrtAt(outside[i]);
        }
    }

    // ---------------------------------------------------------------- band
    /// Exact vectors, computed with Python integers from the definition
    /// max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + d): the tick-range
    /// extremes, and the last sqrt price inside a band next to the first one
    /// outside it, at several magnitudes.
    function testBandMatchesExactVectors() public pure {
        uint160 lo = AnchorMath.MIN_SQRT_PRICE;
        uint160 hi = AnchorMath.MAX_SQRT_PRICE;
        _band(hi, lo, 65535, false);
        _band(hi, hi - 1, 0, false);
        _band(hi, hi - 1, 1, true);
        _band(lo + 1, lo, 0, false);
        _band(lo + 1, lo, 1, true);
        _band(lo, lo, 0, true);
        _band(hi, hi, 0, true);
        _band(4295343490, lo, 1, true);
        _band(4295343491, lo, 1, false);
        _band(11804573547, lo, 65535, true);
        _band(11804573548, lo, 65535, false);
        _band(487319373449711800667147189794386754253994416194, 487148901161736701095757684067996274126241323447, 7, true);
        _band(487319373449711800667147189794386754253994416195, 487148901161736701095757684067996274126241323447, 7, false);
        _band(79623317895830914510639640423, PRICE, 100, true);
        _band(79623317895830914510639640424, PRICE, 100, false);
        _band(730787355292991877414854189597985944145257990394, 730750818665451459101842416358141509827966271488, 1, true);
        _band(730787355292991877414854189597985944145257990395, 730750818665451459101842416358141509827966271488, 1, false);
        _band(74984486209148, 53023364282955, 9999, true);
        _band(74984486209149, 53023364282955, 9999, false);
    }

    function _band(uint160 a, uint160 b, uint16 deviation, bool inside) internal pure {
        _check(AnchorMath.withinBand(a, b, deviation) == inside, "vector");
        _check(AnchorMath.withinBand(b, a, deviation) == inside, "vector, reversed");
    }

    /// An independent formulation: ceil(max^2 * 10000 / min^2) <= 10000 + d,
    /// with FullMath's 512-bit division. It needs the quotient to fit in 256
    /// bits, hence min >= 2^80 here; the vectors above cover the rest.
    function testFuzzBandMatchesAnIndependentDefinition(uint160 a, uint160 b, uint16 deviation) public pure {
        uint160 floor = uint160(1) << 80;
        if (a < floor) a = floor + (a % floor);
        if (b < floor) b = floor + (b % floor);
        (uint256 high, uint256 low) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        uint256 once = FullMath.mulDivRoundingUp(high, high * 10_000, low);
        uint256 ratioUp = once / low + (once % low == 0 ? 0 : 1);
        _check(AnchorMath.withinBand(a, b, deviation) == (ratioUp <= 10_000 + uint256(deviation)), "definition");
    }

    function testFuzzBandIsSymmetricAndMonotonic(uint160 a, uint160 b, uint16 deviation) public pure {
        bool inside = AnchorMath.withinBand(a, b, deviation);
        _check(inside == AnchorMath.withinBand(b, a, deviation), "symmetric");
        if (inside && deviation < type(uint16).max) _check(AnchorMath.withinBand(a, b, deviation + 1), "monotonic");
        if (a != 0) _check(AnchorMath.withinBand(a, a, 0), "a price is inside its own zero band");
    }

    function testZeroPriceIsNeverInsideABand() public pure {
        _check(!AnchorMath.withinBand(0, PRICE, type(uint16).max), "zero anchor");
        _check(!AnchorMath.withinBand(PRICE, 0, type(uint16).max), "zero spot");
        _check(!AnchorMath.withinBand(0, 0, type(uint16).max), "both zero");
    }

    // ---------------------------------------------------------- mean tick
    /// OracleLibrary.consult in int256: the int56 difference wraps, then the
    /// quotient rounds toward negative infinity.
    function testFuzzMeanTickMatchesOracleLibrary(int56 start, int56 end, uint32 secondsAgo) public pure {
        if (secondsAgo == 0) secondsAgo = 1;
        int256 delta = int256(end) - int256(start);
        if (delta > type(int56).max) delta -= int256(1) << 56;
        if (delta < type(int56).min) delta += int256(1) << 56;
        int256 period = int256(uint256(secondsAgo));
        int256 mean = delta / period;
        if (delta < 0 && delta % period != 0) mean -= 1;
        _check(int256(AnchorMath.meanTick(start, end, secondsAgo)) == mean, "mean tick");
    }

    function testMeanTickRounding() public pure {
        _check(AnchorMath.meanTick(0, -121, 120) == -2, "down below zero");
        _check(AnchorMath.meanTick(0, -120, 120) == -1, "exact below zero");
        _check(AnchorMath.meanTick(0, 121, 120) == 1, "down above zero");
        _check(AnchorMath.meanTick(type(int56).max - 9, type(int56).min + 110, 120) == 1, "wraps");
    }
}
