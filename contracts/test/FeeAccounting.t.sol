// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeAccounting} from "../src/FeeAccounting.sol";

contract FeeAccountingTest {
    function exposed(uint128 available, uint128 used, uint16 bps) external pure returns (uint128, uint128, uint128) {
        return FeeAccounting.consume(available, used, bps);
    }

    function testOnlyConsumedFeesAreCharged() public pure {
        (uint128 net, uint128 cut, uint128 remaining) = FeeAccounting.consume(200_000_000, 100_000_000, 200);
        require(net == 98_000_000 && cut == 2_000_000 && remaining == 100_000_000);
        (net, cut, remaining) = FeeAccounting.consume(remaining, 100_000_000, 200);
        require(net == 98_000_000 && cut == 2_000_000 && remaining == 0);
    }

    function testEmptyConsumptionDoesNotChargeReserve() public pure {
        (uint128 net, uint128 cut, uint128 left) = FeeAccounting.consume(type(uint128).max, 0, 200);
        require(net == 0 && cut == 0 && left == type(uint128).max);
    }

    function testFloorAtFortyNineAndFiftyBaseUnits() public pure {
        (uint128 net, uint128 cut, uint128 left) = FeeAccounting.consume(100, 49, 200);
        require(net == 49 && cut == 0 && left == 51);
        (net, cut, left) = FeeAccounting.consume(100, 50, 200);
        require(net == 49 && cut == 1 && left == 50);
    }

    function testZeroRateAndRepeatedDustRemainValidArithmetic() public pure {
        (uint128 net, uint128 cut, uint128 left) = FeeAccounting.consume(type(uint128).max, type(uint128).max, 0);
        require(net == type(uint128).max && cut == 0 && left == 0);
        (net, cut, left) = FeeAccounting.consume(98, 49, 200);
        require(net == 49 && cut == 0 && left == 49);
        (net, cut, left) = FeeAccounting.consume(left, 49, 200);
        require(net == 49 && cut == 0 && left == 0);
        // The pure library permits both calls. Real callers must enforce economics.
    }

    function testRejectExcessiveRateAndOverspending() public {
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposed, (100, 10, 401)));
        assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
        (ok, data) = address(this).call(abi.encodeCall(this.exposed, (100, 101, 200)));
        assertError(ok, data, FeeAccounting.InsufficientReserve.selector);
        (ok, data) = address(this).call(abi.encodeCall(this.exposed, (0, 1, 401)));
        assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
    }

    function testFuzzConservation(uint128 available, uint128 requested, uint16 rate) public pure {
        uint128 used = requested > available ? available : requested;
        uint16 bps = rate % 401;
        (uint128 net, uint128 cut, uint128 left) = FeeAccounting.consume(available, used, bps);
        require(uint256(net) + cut + left == available);
        require(uint256(net) + cut == used);
        require(cut == uint256(used) * bps / 10_000);
    }

    function testFuzzUnmodifiedInputsMatchExactGuards(uint128 available, uint128 requested, uint16 rate) public {
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposed, (available, requested, rate)));
        if (rate > 400) {
            assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
        } else if (requested > available) {
            assertError(ok, data, FeeAccounting.InsufficientReserve.selector);
        } else {
            require(ok);
            (uint128 net, uint128 cut, uint128 left) = abi.decode(data, (uint128, uint128, uint128));
            require(uint256(net) + cut + left == available && uint256(net) + cut == requested);
        }
    }

    function testFuzzExcessiveRateAlwaysUsesItsSelector(uint128 available, uint128 requested, uint16 seed) public {
        uint16 invalidRate = 401 + seed % 65135;
        (bool ok, bytes memory data) =
            address(this).call(abi.encodeCall(this.exposed, (available, requested, invalidRate)));
        assertError(ok, data, FeeAccounting.ExcessiveFee.selector);
    }

    function testFuzzOverspendingAlwaysUsesItsSelector(uint128 seed, uint128 extra, uint16 rate) public {
        uint128 available = seed % type(uint128).max;
        uint128 used = available + 1 + extra % (type(uint128).max - available);
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.exposed, (available, used, rate % 401)));
        assertError(ok, data, FeeAccounting.InsufficientReserve.selector);
    }

    function assertError(bool ok, bytes memory data, bytes4 selector) internal pure {
        require(!ok && keccak256(data) == keccak256(abi.encodeWithSelector(selector)), "wrong error selector");
    }
    function testDominoFourPercentUsesConsumedGrossAndOwnerFavoringFloor() public pure {
        (uint128 net, uint128 cut, uint128 left) = FeeAccounting.consume(2000, 1000, 400);
        require(net == 960 && cut == 40 && left == 1000);
        (net, cut, left) = FeeAccounting.consume(100, 24, 400);
        require(net == 24 && cut == 0 && left == 76);
        (net, cut, left) = FeeAccounting.consume(100, 25, 400);
        require(net == 24 && cut == 1 && left == 75);
    }

}
