// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoRoutingHelperV4} from "../../src/DominoRoutingHelperV4.sol";
import {DominoVaultReadHelper} from "../../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";

/// Independent audit properties. The oracle searches the monotone forward
/// fee function; it does not copy either helper's inverse arithmetic.
contract EngineFeeConservationAuditTest {
    DominoRoutingHelperV4 private routing = new DominoRoutingHelperV4();
    DominoVaultReadHelper private reader = new DominoVaultReadHelper(address(1), address(2));

    function _fee(uint256 gross, uint16 bps) private pure returns (uint256) {
        return gross * bps / 10000;
    }

    function _net(uint256 prior, uint256 gross, uint16 bps) private pure returns (uint256) {
        return gross - (_fee(prior + gross, bps) - _fee(prior, bps));
    }

    function _grossBySearch(uint256 prior, uint128 cap, uint128 target, uint16 bps)
        private pure returns (uint128) {
        uint256 lo;
        uint256 hi = cap;
        while (lo < hi) {
            uint256 middle = (lo + hi) / 2;
            if (_net(prior, middle, bps) < target) lo = middle + 1;
            else hi = middle;
        }
        require(_net(prior, lo, bps) == target, "oracle reachable target");
        return uint128(lo);
    }

    function testFuzzCumulativeInverseMatchesForwardSearch(
        uint128 originalSeed, uint128 chargedSeed, uint128 capSeed,
        uint128 wantedSeed, uint128 priorSeed, uint16 feeSeed
    ) external view {
        uint16 bps = feeSeed % 201;
        uint128 original = originalSeed % 1e30;
        uint128 charged = chargedSeed % 1e30;
        uint128 cap = uint128(uint256(capSeed) % (uint256(original) + 1));
        uint128 chargedCap = charged / 2;
        uint128 prior = priorSeed % 1e30;
        uint256 maxNet = _net(prior, cap, bps) + chargedCap;
        uint128 wanted = uint128(uint256(wantedSeed) % (maxNet + 1));
        uint128 usedCharged = wanted < chargedCap ? wanted : chargedCap;
        uint128 gross = _grossBySearch(prior, cap, wanted - usedCharged, bps);
        T.CompoundAmounts memory value;
        value.originalBefore = original;
        value.chargedBefore = charged;
        T.CompoundAmounts memory out = routing.compoundAmounts(value, wanted, cap, chargedCap, bps, prior, 0);
        require(out.grossOriginalConsumed == gross, "inverse agrees with independent search");
        require(out.chargedConsumed == usedCharged, "charged output consumed without a second charge");
        require(out.serviceFee == _fee(uint256(prior) + gross, bps) - _fee(prior, bps), "cumulative fee only");
        require(uint256(out.originalAfter) + gross == original, "original conserved");
        require(uint256(out.chargedAfter) + usedCharged == charged, "charged conserved");
        require(uint256(out.liquidityAdded) + out.serviceFee == uint256(gross) + usedCharged, "spent value conserved");
    }

    function testFuzzNetAndGeneralAgreeWithoutPriorSpend(
        uint128 originalSeed, uint128 realizedSeed, uint128 chargedSeed,
        uint128 wantedSeed, uint16 feeSeed
    ) external view {
        uint16 bps = feeSeed % 201;
        T.CompoundAmounts memory value;
        value.originalBefore = originalSeed % 1e30;
        value.realized = realizedSeed % 1e30;
        value.chargedBefore = chargedSeed % 1e30;
        uint128 cap = value.originalBefore + value.realized;
        uint128 wanted = uint128(uint256(wantedSeed) % (_net(0, cap, bps) + value.chargedBefore + 1));
        T.CompoundAmounts memory netted = reader.compoundAmounts(value, wanted, cap, value.chargedBefore, bps);
        T.CompoundAmounts memory general = routing.compoundAmounts(value, wanted, cap, value.chargedBefore, bps, 0, 0);
        require(keccak256(abi.encode(netted)) == keccak256(abi.encode(general)), "NET and GENERAL use the same economic split");
    }

    function testSplitAtFeeBoundaryChargesOnce() external view {
        T.CompoundAmounts memory value;
        value.originalBefore = 100;
        T.CompoundAmounts memory first = routing.compoundAmounts(value, 49, 100, 0, 200, 0, 0);
        value.originalBefore = first.originalAfter;
        T.CompoundAmounts memory second = routing.compoundAmounts(value, 1, value.originalBefore, 0, 200, first.grossOriginalConsumed, 0);
        require(first.grossOriginalConsumed == 49 && first.serviceFee == 0, "first spend below threshold");
        require(second.grossOriginalConsumed == 2 && second.serviceFee == 1, "second spend crosses cumulative threshold");
        require(first.serviceFee + second.serviceFee == (uint256(first.grossOriginalConsumed) + second.grossOriginalConsumed) * 200 / 10000,
            "one floor over combined spend");
    }

    function testFuzzExactOriginalFloorSurvivesRoundingPlateaus(
        uint128 originalSeed, uint128 chargedSeed, uint128 priorSeed, uint16 feeSeed
    ) external view {
        uint16 bps = feeSeed % 201;
        uint128 original = originalSeed % 1e30;
        uint128 charged = chargedSeed % 1e30;
        uint128 prior = priorSeed % 1e30;
        T.CompoundAmounts memory value;
        value.originalBefore = original;
        value.chargedBefore = charged;
        uint128 wanted = uint128(_net(prior, original, bps) + charged);
        T.CompoundAmounts memory out = routing.compoundAmounts(value, wanted, original, charged, bps, prior, original);
        require(out.grossOriginalConsumed == original && out.chargedConsumed == charged, "exact authorized floors consumed");
        require(out.originalAfter == 0 && out.chargedAfter == 0, "full exact allocation leaves no stranded floor");
        require(uint256(out.liquidityAdded) + out.serviceFee == uint256(original) + charged, "exact-floor conservation");
    }
}
