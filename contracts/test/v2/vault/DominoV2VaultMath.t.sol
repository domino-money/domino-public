// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "../../../src/v2/positions/uniswap/TickMath.sol";
import {DominoV2VaultMath as M} from "../../../src/v2/vault/DominoV2VaultMath.sol";

interface MathVm {
    function assume(bool condition) external pure;
}

/// The vault's arithmetic: the tariff's least-gross rule and its rounding
/// once per source, and the exact price ratios. The Uniswap math underneath
/// is F1c's vendored copy and the swap floor is F1b's DominoSwapFloor, each
/// tested in its own front; the vault's use of the floor is in
/// DominoV2VaultExecution.t.sol and DominoV2VaultUniswapV4.t.sol.
contract DominoV2VaultMathTest {
    MathVm internal constant vm = MathVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error Mismatch(string what, uint256 actual, uint256 expected);

    function _eq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert Mismatch(what, actual, expected);
    }

    function _bps(bool domino) internal pure returns (uint16) {
        return domino ? 400 : 200;
    }

    function testNetOfRoundsTheCutDown() public pure {
        _eq(M.netOf(1000, 200), 980, "2% of 1000");
        _eq(M.netOf(49, 200), 49, "under one unit of cut");
        _eq(M.netOf(50, 200), 49, "one unit of cut");
        _eq(M.netOf(1000, 400), 960, "4% of 1000");
    }

    /// The gross is the least whose net is exact: never a unit of tariff more.
    function testFuzz_grossForIsTheLeastExactGross(uint128 prior, uint128 net, bool domino) public pure {
        uint16 bps = _bps(domino);
        uint256 gross = M.grossFor(prior, net, bps);
        _eq(M.netOf(gross, bps), M.netOf(prior, bps) + net, "exact net");
        if (gross > prior) {
            if (M.netOf(gross - 1, bps) >= M.netOf(prior, bps) + net) revert Mismatch("not least", gross, prior);
        } else {
            _eq(net, 0, "no gross for nothing");
        }
    }

    /// Consumption split in two within one execution pays the same tariff as
    /// in one piece: the cut rounds once per source and token.
    function testFuzz_splitConsumptionPaysTheSameTariff(uint128 first, uint128 second, bool domino) public pure {
        uint16 bps = _bps(domino);
        uint256 afterFirst = M.grossFor(0, first, bps);
        uint256 split = M.grossFor(afterFirst, second, bps);
        uint256 whole = M.grossFor(0, uint256(first) + second, bps);
        _eq(split, whole, "same gross");
    }

    function testFuzz_ratioAtLeastIsExact(uint112 a, uint112 b, uint32 num) public pure {
        vm.assume(a != 0 && b != 0 && num <= 1_010_000);
        bool expected = uint256(a) * a * 10_000 >= uint256(b) * b * num;
        if (M.ratioAtLeast(a, b, num) != expected) revert Mismatch("ratio", a, b);
    }

    function testRatioAtLeastForFarApartPrices() public pure {
        if (!M.ratioAtLeast(TickMath.MAX_SQRT_PRICE, TickMath.MIN_SQRT_PRICE, 1_010_000)) {
            revert Mismatch("far above", 0, 1);
        }
        if (M.ratioAtLeast(TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE, 1)) revert Mismatch("far below", 1, 0);
    }
}
