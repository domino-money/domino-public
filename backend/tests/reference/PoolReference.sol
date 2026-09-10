// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
// Non-production test harness only. No token settlement, approvals or signing.
import {Pool} from "./v4/src/libraries/Pool.sol";
import {SwapMath} from "./v4/src/libraries/SwapMath.sol";
import {TickMath} from "./v4/src/libraries/TickMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "./v4/src/types/BalanceDelta.sol";
import {Slot0, Slot0Library} from "./v4/src/types/Slot0.sol";
import {Position} from "./v4/src/libraries/Position.sol";

contract PoolReference {
    using Pool for Pool.State;
    using BalanceDeltaLibrary for BalanceDelta;
    using Slot0Library for Slot0;
    Pool.State private state;
    int24 private spacing;
    function initialize(uint160 price,uint24 fee,int24 s) external {
        state.initialize(price,fee); spacing=s;
    }
    function modify(int24 lo,int24 hi,int128 delta) external {
        state.modifyLiquidity(Pool.ModifyLiquidityParams(address(this),lo,hi,delta,spacing,bytes32(0)));
    }
    function modifyOwned(address owner,int24 lo,int24 hi,int128 delta,bytes32 salt) external
        returns(int128,int128,int128,int128) {
        (BalanceDelta d,BalanceDelta f)=state.modifyLiquidity(Pool.ModifyLiquidityParams(owner,lo,hi,delta,spacing,salt));
        return(d.amount0(),d.amount1(),f.amount0(),f.amount1());
    }
    function positionInfo(address owner,int24 lo,int24 hi,bytes32 salt) external view returns(uint128,uint256,uint256) {
        Position.State storage p=state.positions[Position.calculatePositionKey(owner,lo,hi,salt)];
        return(p.liquidity,p.feeGrowthInside0LastX128,p.feeGrowthInside1LastX128);
    }
    function positionId(address owner,int24 lo,int24 hi,bytes32 salt) external pure returns(bytes32) {
        return Position.calculatePositionKey(owner,lo,hi,salt);
    }
    function inside(int24 lo,int24 hi) external view returns(uint256,uint256) {return state.getFeeGrowthInside(lo,hi);}
    function tickInfo(int24 tick) external view returns(uint128,int128,uint256,uint256) {
        Pool.TickInfo storage t=state.ticks[tick];
        return(t.liquidityGross,t.liquidityNet,t.feeGrowthOutside0X128,t.feeGrowthOutside1X128);
    }
    function protocol(uint24 fee) external {state.setProtocolFee(fee);}
    function donate(uint256 a,uint256 b) external {state.donate(a,b);}
    function runSwap(bool zero,int256 amount,uint160 limit) external returns
        (int128,int128,uint160,uint128,int24,uint24,uint256,uint256,uint256) {
        (BalanceDelta d,uint256 p,uint24 fee,Pool.SwapResult memory s)=
            state.swap(Pool.SwapParams(amount,spacing,zero,limit,0));
        return (d.amount0(),d.amount1(),s.sqrtPriceX96,s.liquidity,s.tick,fee,p,
                state.feeGrowthGlobal0X128,state.feeGrowthGlobal1X128);
    }
    function growth() external view returns(uint256,uint256) {
        return (state.feeGrowthGlobal0X128,state.feeGrowthGlobal1X128);
    }
    function step(uint160 p,uint160 t,uint128 l,int256 a,uint24 f) external pure
        returns(uint160,uint256,uint256,uint256) {return SwapMath.computeSwapStep(p,t,l,a,f);}
    function sqrtAt(int24 tick) external pure returns(uint160) {return TickMath.getSqrtPriceAtTick(tick);}
    function tickAt(uint160 p) external pure returns(int24) {return TickMath.getTickAtSqrtPrice(p);}
    function tickCap(int24 s) external pure returns(uint128) {return Pool.tickSpacingToMaxLiquidityPerTick(s);}
}
