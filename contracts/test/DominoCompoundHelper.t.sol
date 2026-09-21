// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "./shared/NitroTestSetup.sol";

import {DominoVaultReadHelper as Helper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {VmE2} from "./E2Mocks.sol";

interface VmCompoundHeader {
    function setBlockhash(uint256 blockNumber, bytes32 blockHash) external;
}

contract CompoundPriceState {
    uint160 public price = 1 << 96;
    function setPrice(uint160 next) external { price = next; }
    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        return (price, 0, 0, 3000);
    }
}

/// @dev Arithmetic/header guard evidence only, not fee-origin or economic qualification.
contract DominoCompoundHelperTest {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    Helper private helper;
    CompoundPriceState private state;
    uint256 private constant Q128 = 1 << 128;
    bytes32 private constant HEADER = keccak256("synthetic previous canonical header");

    function setUp() public {
        NitroTestSetup.install();
        state = new CompoundPriceState();
        helper = new Helper(address(1), address(state));
        vm.roll(400); vm.warp(1000);
        VmCompoundHeader(address(vm)).setBlockhash(399, HEADER);
    }

    function _amounts(uint128 original, uint128 charged, uint128 realized)
        private pure returns (T.CompoundAmounts memory value)
    { value.originalBefore = original; value.chargedBefore = charged; value.realized = realized; }

    function testAccruedWrapAndIndependentCurrencyFloors() public view {
        T.Checkpoint memory p;
        p.liquidity = 3;
        p.feeGrowthInside0LastX128 = type(uint256).max - Q128 + 1;
        p.feeGrowthInside0X128 = Q128 / 2;
        p.feeGrowthInside1LastX128 = 100;
        p.feeGrowthInside1X128 = 100 + Q128 / 3;
        (uint128 a, uint128 b) = helper.accrued(p);
        require(a == 4 && b == 0, "wrapped growth or independent flooring changed");
    }

    function testAccruedFullWidthIntermediateAndSignedBoundary() public {
        T.Checkpoint memory p;
        p.liquidity = uint128(type(int128).max);
        p.feeGrowthInside0X128 = Q128;
        p.feeGrowthInside1X128 = Q128 - 1;
        (uint128 a, uint128 b) = helper.accrued(p);
        require(a == uint128(type(int128).max) && b == a - 1, "signed maximum incorrect");
        p.feeGrowthInside0X128 = Q128 + 3;
        vm.expectRevert(Helper.InvalidAmount.selector); helper.accrued(p);
        // Naive growth*liquidity overflows uint256. The result is oversized,
        // so reject with the domain error, not an intermediate arithmetic panic.
        p.liquidity = type(uint128).max;
        p.feeGrowthInside0X128 = type(uint256).max;
        vm.expectRevert(Helper.InvalidAmount.selector); helper.accrued(p);
        p.liquidity = 0;
        (a, b) = helper.accrued(p);
        require(a == 0 && b == 0, "zero liquidity manufactured accrual");
    }

    function testFuzzAccruedMatchesBoundedIndependentProduct(uint128 growth, uint128 liquidity) public {
        T.Checkpoint memory p;
        p.liquidity = liquidity; p.feeGrowthInside0X128 = growth;
        uint256 expected = uint256(growth) * liquidity / Q128;
        if (expected > uint128(type(int128).max)) {
            vm.expectRevert(Helper.InvalidAmount.selector); helper.accrued(p);
        } else {
            (uint128 actual,) = helper.accrued(p);
            require(actual == expected, "Q128 floor mismatch");
        }
    }

    function testAccruedUsesAllHighGrowthBitsBeforeSignedRejection() public {
        T.Checkpoint memory p;
        p.liquidity = 1;
        p.feeGrowthInside0X128 = (uint256(uint128(type(int128).max)) << 128) | type(uint128).max;
        p.feeGrowthInside1X128 = p.feeGrowthInside0X128;
        (uint128 a, uint128 b) = helper.accrued(p);
        require(a == uint128(type(int128).max) && b == a, "high growth bits lost");
        // A single growth unit crosses the signed result boundary here.
        p.feeGrowthInside1X128++;
        vm.expectRevert(Helper.InvalidAmount.selector); helper.accrued(p);
    }

    function testEveryLowerRateUsesMinimalGrossForExactNet() public view {
        _checkRates(0, 200);
    }

    function testEveryUpperRateUsesMinimalGrossForExactNet() public view {
        _checkRates(201, 400);
    }

    function _checkRates(uint16 first, uint16 last) private view {
        // Independent small-domain search catches both floor plateaus and an
        // incorrect ceil(net/(1-fee)) inverse without repeating the helper formula.
        for (uint16 rate = first; rate <= last; ++rate) {
            for (uint128 net; net <= 101; ++net) {
                uint128 expected;
                while (uint256(expected) - uint256(expected) * rate / 10000 < net) ++expected;
                T.CompoundAmounts memory v = helper.compoundAmounts(_amounts(1000, 0, 0), net, 1000, 0, rate);
                require(v.grossOriginalConsumed == expected && v.liquidityAdded == net &&
                    v.serviceFee == uint256(expected) * rate / 10000 &&
                    uint256(v.grossOriginalConsumed) == uint256(v.serviceFee) + net,
                    "minimal floor inverse or conservation mismatch");
            }
        }
    }

    function testFortyNineFiftyDoNotOverconsumeTheFloorPlateau() public view {
        T.CompoundAmounts memory a = helper.compoundAmounts(_amounts(50, 0, 0), 49, 50, 0, 200);
        require(a.grossOriginalConsumed == 49 && a.serviceFee == 0 && a.originalAfter == 1,
            "net49 must not consume gross50 just to collect one unit");
        T.CompoundAmounts memory b = helper.compoundAmounts(_amounts(51, 0, 0), 50, 51, 0, 200);
        require(b.grossOriginalConsumed == 51 && b.serviceFee == 1 && b.originalAfter == 0,
            "net50 should consume51 and charge1");
    }

    function testChargedBalancesAreConsumedOnceAndWaitingOriginalRemainsUncharged() public view {
        T.CompoundAmounts memory v = helper.compoundAmounts(_amounts(400, 30, 100), 79, 100, 30, 200);
        require(v.chargedConsumed == 30 && v.grossOriginalConsumed == 49 && v.serviceFee == 0 &&
            v.originalAfter == 451 && v.chargedAfter == 0, "wrong class or charged waiting funds");
        // A later collected/converted charged lot stays exempt even at a new rate.
        v = helper.compoundAmounts(_amounts(v.originalAfter, 50, 0), 50, 0, 50, 400);
        require(v.grossOriginalConsumed == 0 && v.serviceFee == 0 && v.originalAfter == 451 &&
            v.chargedConsumed == 50 && v.chargedAfter == 0, "charged lot paid twice");
    }

    function testBudgetsApplyIndependentlyAndNeverRequireAllAvailableFunds() public {
        T.CompoundAmounts memory v = helper.compoundAmounts(_amounts(50, 100, 50), 59, 50, 10, 200);
        require(v.chargedConsumed == 10 && v.grossOriginalConsumed == 49 && v.originalAfter == 51 &&
            v.chargedAfter == 90, "charged cap was ignored");
        vm.expectRevert(Helper.InvalidAmount.selector);
        helper.compoundAmounts(_amounts(50, 100, 50), 60, 50, 10, 200);
        vm.expectRevert(Helper.InvalidAmount.selector);
        helper.compoundAmounts(_amounts(10, 0, 0), 11, type(uint128).max, 0, 0);
        vm.expectRevert(Helper.InvalidAmount.selector);
        helper.compoundAmounts(_amounts(type(uint128).max, 1, 0), 1, 1, 1, 0);
        vm.expectRevert(Helper.InvalidAmount.selector);
        helper.compoundAmounts(_amounts(type(uint128).max, 0, 1), 1, 1, 0, 0);
        vm.expectRevert(Helper.InvalidAmount.selector);
        helper.compoundAmounts(_amounts(100, 0, 0), 1, 100, 0, 401);
    }

    function testFuzzMaximumAmountsConserveAndChooseMinimalGross(uint128 net, uint16 rawRate) public {
        uint16 rate = rawRate % 401;
        uint256 maximumNet = uint256(type(uint128).max) - uint256(type(uint128).max) * rate / 10000;
        if (net > maximumNet) {
            vm.expectRevert(Helper.InvalidAmount.selector);
            helper.compoundAmounts(_amounts(type(uint128).max, 0, 0), net, type(uint128).max, 0, rate);
        } else {
            T.CompoundAmounts memory v = helper.compoundAmounts(
                _amounts(type(uint128).max, 0, 0), net, type(uint128).max, 0, rate);
            uint256 gross = v.grossOriginalConsumed;
            require(gross - gross * rate / 10000 == net && gross + v.originalAfter == type(uint128).max,
                "full-width gross or reserve conservation");
            require(gross == 0 || gross - 1 - (gross - 1) * rate / 10000 < net, "gross not minimal");
        }
    }

    function _pricePlan() private view returns (T.CompoundPlan memory p) {
        p.observedAtBlock = 399; p.observedBlockHash = HEADER;
        p.observedAtTimestamp = 940; p.deadline = 1000;
        p.minSqrtPriceX96 = state.price(); p.maxSqrtPriceX96 = state.price();
    }

    function testPriceAgeDeadlineAndBoundsAcceptInclusiveEdges() public {
        T.CompoundPlan memory p = _pricePlan();
        helper.validateCompoundPrice(bytes32(0), p, 60);
        p.observedAtTimestamp = 1000; p.deadline = 1060;
        p.minSqrtPriceX96--; p.maxSqrtPriceX96++;
        state.setPrice(p.minSqrtPriceX96); helper.validateCompoundPrice(bytes32(0), p, 60);
        state.setPrice(p.maxSqrtPriceX96); helper.validateCompoundPrice(bytes32(0), p, 60);
        // Match the price guard's common 255-L2-block observation window.
        p.observedAtBlock = 145;
        VmCompoundHeader(address(vm)).setBlockhash(145, HEADER);
        helper.validateCompoundPrice(bytes32(0), p, 60);
    }

    function testPriceRejectsChangedHashCurrentFutureOrExpiredObservation() public {
        for (uint256 variant; variant < 13; ++variant) {
            T.CompoundPlan memory p = _pricePlan();
            if (variant == 0) p.observedBlockHash = bytes32(0);
            if (variant == 1) p.observedBlockHash = keccak256("different header");
            if (variant == 2) p.observedAtBlock = 400;
            if (variant == 3) p.observedAtBlock = 401;
            if (variant == 4) {
                p.observedAtBlock = 144;
                VmCompoundHeader(address(vm)).setBlockhash(144, HEADER);
            }
            if (variant == 5) p.observedAtTimestamp = 1001;
            if (variant == 6) p.observedAtTimestamp = 939;
            if (variant == 7) p.deadline = 999;
            if (variant == 8) p.deadline = 1001;
            if (variant == 9) p.minSqrtPriceX96 = 0;
            if (variant == 10) p.minSqrtPriceX96 = p.maxSqrtPriceX96 + 1;
            if (variant == 11) { p.minSqrtPriceX96++; p.maxSqrtPriceX96++; }
            if (variant == 12) { p.minSqrtPriceX96--; p.maxSqrtPriceX96--; }
            vm.expectRevert(Helper.InvalidExecution.selector);
            helper.validateCompoundPrice(bytes32(0), p, 60);
        }
        T.CompoundPlan memory changed = _pricePlan();
        VmCompoundHeader(address(vm)).setBlockhash(399, keccak256("replacement"));
        vm.expectRevert(Helper.InvalidExecution.selector);
        helper.validateCompoundPrice(bytes32(0), changed, 60);
    }
}
