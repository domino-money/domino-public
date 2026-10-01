// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPermit2Signature} from "../../src/v2/external/IPermit2Signature.sol";
import {
    IUniswapV3CallbacksMinimal,
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal,
    IUniswapV3PositionManagerMinimal
} from "../../src/v2/external/IUniswapV3Minimal.sol";
import {
    IV4PoolManagerMinimal,
    IV4PositionManagerMinimal,
    IV4StateViewMinimal,
    IV4SubscriberMinimal,
    IV4UnlockCallbackMinimal
} from "../../src/v2/external/IUniswapV4Minimal.sol";

/// @notice The local third-party declarations must hit the deployed contracts.
/// Every expected selector below was computed from the pinned upstream source
/// and found in the deployed bytecode on Robinhood (4663), Base (8453) and
/// Arbitrum (42161) on 1 Oct 2026 (survey for docs/v2/F0_INTERFACES.md).
contract DominoV2ExternalTest {
    error WrongSelector(string what, bytes4 actual, bytes4 expected);

    function _is(bytes4 actual, bytes4 expected, string memory what) private pure {
        if (actual != expected) revert WrongSelector(what, actual, expected);
    }

    function testPermit2SignatureTransfer() public pure {
        _is(IPermit2Signature.permitWitnessTransferFrom.selector, 0xfe8ec1a7, "permitWitnessTransferFrom batch");
        _is(IPermit2Signature.nonceBitmap.selector, 0x4fe02b44, "nonceBitmap");
    }

    function testUniswapV3PositionManager() public pure {
        _is(IUniswapV3PositionManagerMinimal.positions.selector, 0x99fbab88, "positions");
        _is(IUniswapV3PositionManagerMinimal.mint.selector, 0x88316456, "mint");
        _is(IUniswapV3PositionManagerMinimal.increaseLiquidity.selector, 0x219f5d17, "increaseLiquidity");
        _is(IUniswapV3PositionManagerMinimal.decreaseLiquidity.selector, 0x0c49ccbe, "decreaseLiquidity");
        _is(IUniswapV3PositionManagerMinimal.collect.selector, 0xfc6f7865, "collect");
        _is(IUniswapV3PositionManagerMinimal.burn.selector, 0x42966c68, "burn");
        _is(IUniswapV3PositionManagerMinimal.ownerOf.selector, 0x6352211e, "ownerOf");
        _is(IUniswapV3PositionManagerMinimal.getApproved.selector, 0x081812fc, "getApproved");
        _is(IUniswapV3PositionManagerMinimal.isApprovedForAll.selector, 0xe985e9c5, "isApprovedForAll");
        _is(IUniswapV3PositionManagerMinimal.permit.selector, 0x7ac2ff7b, "permit");
        _is(IUniswapV3PositionManagerMinimal.factory.selector, 0xc45a0155, "factory");
        _is(IUniswapV3PositionManagerMinimal.WETH9.selector, 0x4aa4a4fc, "WETH9");
    }

    function testUniswapV3PoolAndFactory() public pure {
        _is(IUniswapV3PoolMinimal.slot0.selector, 0x3850c7bd, "slot0");
        _is(IUniswapV3PoolMinimal.liquidity.selector, 0x1a686502, "liquidity");
        _is(IUniswapV3PoolMinimal.feeGrowthGlobal0X128.selector, 0xf3058399, "feeGrowthGlobal0X128");
        _is(IUniswapV3PoolMinimal.feeGrowthGlobal1X128.selector, 0x46141319, "feeGrowthGlobal1X128");
        _is(IUniswapV3PoolMinimal.ticks.selector, 0xf30dba93, "ticks");
        _is(IUniswapV3PoolMinimal.positions.selector, 0x514ea4bf, "pool positions");
        _is(IUniswapV3PoolMinimal.observe.selector, 0x883bdbfd, "observe");
        _is(IUniswapV3PoolMinimal.increaseObservationCardinalityNext.selector, 0x32148f67, "cardinality");
        _is(IUniswapV3PoolMinimal.swap.selector, 0x128acb08, "swap");
        _is(IUniswapV3PoolMinimal.token0.selector, 0x0dfe1681, "token0");
        _is(IUniswapV3PoolMinimal.token1.selector, 0xd21220a7, "token1");
        _is(IUniswapV3PoolMinimal.fee.selector, 0xddca3f43, "fee");
        _is(IUniswapV3PoolMinimal.tickSpacing.selector, 0xd0c93a7c, "tickSpacing");
        _is(IUniswapV3FactoryMinimal.getPool.selector, 0x1698ee82, "getPool");
        _is(IUniswapV3FactoryMinimal.feeAmountTickSpacing.selector, 0x22afcccb, "feeAmountTickSpacing");
        _is(IUniswapV3CallbacksMinimal.uniswapV3SwapCallback.selector, 0xfa461e33, "swap callback");
        _is(IUniswapV3CallbacksMinimal.uniswapV3MintCallback.selector, 0xd3487997, "mint callback");
    }

    function testUniswapV4PositionManager() public pure {
        _is(IV4PositionManagerMinimal.modifyLiquidities.selector, 0xdd46508f, "modifyLiquidities");
        _is(IV4PositionManagerMinimal.modifyLiquiditiesWithoutUnlock.selector, 0x4afe393c, "withoutUnlock");
        _is(IV4PositionManagerMinimal.getPoolAndPositionInfo.selector, 0x7ba03aad, "getPoolAndPositionInfo");
        _is(IV4PositionManagerMinimal.getPositionLiquidity.selector, 0x1efeed33, "getPositionLiquidity");
        _is(IV4PositionManagerMinimal.nextTokenId.selector, 0x75794a3c, "nextTokenId");
        _is(IV4PositionManagerMinimal.subscribe.selector, 0x2b9261de, "subscribe");
        _is(IV4PositionManagerMinimal.unsubscribe.selector, 0xad0b27fb, "unsubscribe");
        _is(IV4PositionManagerMinimal.subscriber.selector, 0x16a24131, "subscriber");
        _is(IV4PositionManagerMinimal.unsubscribeGasLimit.selector, 0x4767565f, "unsubscribeGasLimit");
        _is(IV4PositionManagerMinimal.permit.selector, 0x0f5730f1, "erc721 permit");
        _is(IV4PositionManagerMinimal.ownerOf.selector, 0x6352211e, "ownerOf");
        _is(IV4PositionManagerMinimal.getApproved.selector, 0x081812fc, "getApproved");
        _is(IV4PositionManagerMinimal.poolManager.selector, 0xdc4c90d3, "poolManager");
    }

    function testUniswapV4PoolManagerStateViewAndCallbacks() public pure {
        _is(IV4PoolManagerMinimal.unlock.selector, 0x48c89491, "unlock");
        _is(IV4PoolManagerMinimal.sync.selector, 0xa5841194, "sync");
        _is(IV4PoolManagerMinimal.settle.selector, 0x11da60b4, "settle");
        _is(IV4PoolManagerMinimal.settleFor.selector, 0x3dd45adb, "settleFor");
        _is(IV4PoolManagerMinimal.take.selector, 0x0b0d9c09, "take");
        _is(IV4PoolManagerMinimal.swap.selector, 0xf3cd914c, "swap");
        _is(IV4PoolManagerMinimal.exttload.selector, 0xf135baaa, "exttload");
        _is(IV4PoolManagerMinimal.extsload.selector, 0x1e2eaeaf, "extsload");
        _is(IV4StateViewMinimal.getSlot0.selector, 0xc815641c, "getSlot0");
        _is(IV4StateViewMinimal.getPositionInfo.selector, 0xdacf1d2f, "getPositionInfo");
        _is(IV4StateViewMinimal.getFeeGrowthInside.selector, 0x53e9c1fb, "getFeeGrowthInside");
        _is(IV4StateViewMinimal.getLiquidity.selector, 0xfa6793d5, "getLiquidity");
        _is(IV4SubscriberMinimal.notifySubscribe.selector, 0x8d57f6b2, "notifySubscribe");
        _is(IV4SubscriberMinimal.notifyUnsubscribe.selector, 0xaf45dd14, "notifyUnsubscribe");
        _is(IV4SubscriberMinimal.notifyModifyLiquidity.selector, 0xd8865c27, "notifyModifyLiquidity");
        _is(IV4SubscriberMinimal.notifyBurn.selector, 0xb1a9116f, "notifyBurn");
        _is(IV4UnlockCallbackMinimal.unlockCallback.selector, 0x91dd7346, "unlockCallback");
    }
}
