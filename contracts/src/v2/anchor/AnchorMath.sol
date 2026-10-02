// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "../positions/uniswap/TickMath.sol";

/// @title Price arithmetic of the Domino V2 price anchor
/// @notice The band check every anchored action relies on, the v3 TWAP mean
/// tick, and the tick-to-sqrt-price conversion they need.
/// @dev The conversion and the tick range are Uniswap v4-core's TickMath, as
/// vendored byte for byte in src/v2/positions/uniswap (v4-core 59d3ecf, MIT),
/// so shipped V2 code shares one copy and never imports the test tree (V1
/// audit item D5). AnchorMath.t.sol checks it against the reference copy
/// under contracts/test/reference/official-v4 for every tick.
library AnchorMath {
    int24 internal constant MIN_TICK = TickMath.MIN_TICK;
    int24 internal constant MAX_TICK = TickMath.MAX_TICK;
    /// getSqrtPriceAtTick(MIN_TICK) and getSqrtPriceAtTick(MAX_TICK).
    uint160 internal constant MIN_SQRT_PRICE = TickMath.MIN_SQRT_PRICE;
    uint160 internal constant MAX_SQRT_PRICE = TickMath.MAX_SQRT_PRICE;
    uint256 internal constant BPS = 10_000;

    /// @notice Whether two sqrt prices are within `maxDeviationBps` of each
    /// other on the price (the square of the sqrt price), in both directions:
    /// max(a, b)^2 * 10000 <= min(a, b)^2 * (10000 + maxDeviationBps).
    /// @dev Symmetric, so the band is the same whichever token is the base:
    /// the price may sit at most a factor (1 + d) above or below the other.
    /// Evaluated exactly on 512-bit products: no rounding, and no input in the
    /// uint160 range can overflow or revert. False when either price is zero.
    function withinBand(uint160 a, uint160 b, uint16 maxDeviationBps) internal pure returns (bool) {
        if (a == 0 || b == 0) return false;
        (uint256 high, uint256 low) = a > b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        // high * BPS < 2**174 and low * (BPS + 65535) < 2**177: both products
        // fit in 512 bits with room to spare.
        (uint256 highHi, uint256 highLo) = _mul512(high, high * BPS);
        (uint256 lowHi, uint256 lowLo) = _mul512(low, low * (BPS + maxDeviationBps));
        return highHi < lowHi || (highHi == lowHi && highLo <= lowLo);
    }

    /// @notice The arithmetic mean tick between two v3 tick cumulatives taken
    /// `secondsAgo` (nonzero) apart, rounded toward negative infinity, exactly
    /// as Uniswap's OracleLibrary.consult computes it; the subtraction wraps in
    /// int56, as the pool's own accumulator does. The result is not narrowed:
    /// the caller checks it against MIN_TICK and MAX_TICK first.
    function meanTick(int56 startCumulative, int56 endCumulative, uint32 secondsAgo)
        internal
        pure
        returns (int56 mean)
    {
        int56 delta;
        unchecked {
            delta = endCumulative - startCumulative;
        }
        int56 period = int56(uint56(secondsAgo));
        mean = delta / period;
        if (delta < 0 && delta % period != 0) mean--;
    }

    /// @notice sqrt(1.0001^tick) * 2^96, rounded up; reverts
    /// TickMath.InvalidTick outside [MIN_TICK, MAX_TICK].
    function getSqrtPriceAtTick(int24 tick) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }

    /// @dev The full 512-bit product (FullMath's mul512, Remco Bloemen).
    function _mul512(uint256 x, uint256 y) private pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }
}
