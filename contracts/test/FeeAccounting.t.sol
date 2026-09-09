// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FeeAccounting} from "../src/FeeAccounting.sol";

contract FeeAccountingTest {
    function exposed(uint128 available, uint128 used, uint16 bps) external pure returns(uint128,uint128,uint128) {
        return FeeAccounting.consume(available,used,bps);
    }
    function testOnlyConsumedFeesAreCharged() public pure {
        (uint128 net,uint128 cut,uint128 remaining)=FeeAccounting.consume(200_000_000,100_000_000,200);
        require(net==98_000_000 && cut==2_000_000 && remaining==100_000_000);
        (net,cut,remaining)=FeeAccounting.consume(remaining,100_000_000,200);
        require(net==98_000_000 && cut==2_000_000 && remaining==0);
    }
    function testEmptyConsumptionDoesNotChargeReserve() public pure {
        (uint128 net,uint128 cut,uint128 left)=FeeAccounting.consume(type(uint128).max,0,200);
        require(net==0 && cut==0 && left==type(uint128).max);
    }
    function testRejectExcessiveRateAndOverspending() public {
        (bool ok,)=address(this).call(abi.encodeCall(this.exposed,(100,10,201)));
        require(!ok);
        (ok,)=address(this).call(abi.encodeCall(this.exposed,(100,101,200)));
        require(!ok);
    }
    function testFuzzConservation(uint128 available,uint128 requested,uint16 rate) public pure {
        uint128 used=requested>available?available:requested;
        uint16 bps=rate%201;
        (uint128 net,uint128 cut,uint128 left)=FeeAccounting.consume(available,used,bps);
        require(uint256(net)+cut+left==available);
        require(uint256(net)+cut==used);
        require(cut==uint256(used)*bps/10_000);
    }
}
