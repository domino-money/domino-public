// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice 512-bit multiply-divide, as Uniswap v4-core's FullMath.mulDiv
/// (MIT, credit to Remco Bloemen, https://xn--2-umb.com/21/muldiv). Kept in
/// the V2 source tree so shipped code does not import from the test
/// references (V1 audit D5).
library DominoFullMath {
    /// floor(a * b / denominator) with full precision; reverts when the
    /// result overflows uint256 or the denominator is zero.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0 = a * b;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            require(denominator > prod1);
            if (prod1 == 0) {
                assembly ("memory-safe") {
                    result := div(prod0, denominator)
                }
                return result;
            }
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = (0 - denominator) & denominator;
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }
}
