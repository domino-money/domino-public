// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoFeeRules} from "../fees/DominoFeeRules.sol";
import {FullMath} from "../positions/uniswap/FullMath.sol";

/// @notice The arithmetic the vault decides with: the automation tariff's
/// gross/net split and the price ratios of the Domino geometry. Pure
/// functions only.
/// @dev 512-bit products come from the Uniswap math F1c vendors under
/// ../positions/uniswap; the fee rounding is F1b's DominoFeeRules.feeOf; the
/// swap floor is F1b's DominoSwapFloor.
library DominoV2VaultMath {
    uint256 internal constant BPS = 10_000;

    /// Whether the price ratio (a / b)^2 is at least num / 10000, exactly.
    /// Both are nonzero sqrt prices; num is at most 10000 + 1_000_000, so a
    /// sqrt ratio of 2^32 or more always qualifies and bounds the product.
    function ratioAtLeast(uint160 a, uint160 b, uint256 num) internal pure returns (bool) {
        if (a / b >= 1 << 32) return true;
        // floor(a^2 * 1e4 / b) >= b * num  <=>  a^2 * 1e4 >= b^2 * num, as the right side is an integer.
        return FullMath.mulDiv(a, uint256(a) * BPS, b) >= uint256(b) * num;
    }

    /// What `gross` units of uncharged fees leave once the tariff is cut:
    /// gross - floor(gross * bps / 10000). The cut rounds down, for the owner.
    function netOf(uint256 gross, uint16 bps) internal pure returns (uint256) {
        return gross - DominoFeeRules.feeOf(gross, bps);
    }

    /// The least cumulative gross G >= prior whose net is netOf(prior) + net.
    /// netOf grows by zero or one per unit of gross, so every net is reached
    /// and the least G is floor((target - 1) * 10000 / (10000 - bps)) + 1.
    /// Charging against the cumulative gross of one source in one execution
    /// rounds its total cut once, however the consumption is split.
    function grossFor(uint256 prior, uint256 net, uint16 bps) internal pure returns (uint256) {
        if (net == 0) return prior;
        uint256 target = netOf(prior, bps) + net;
        return (target - 1) * BPS / (BPS - bps) + 1;
    }
}
