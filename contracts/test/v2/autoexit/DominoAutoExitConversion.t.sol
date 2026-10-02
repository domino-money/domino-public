// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IV4PoolManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {IDominoAutoExit} from "../../../src/v2/interfaces/IDominoAutoExit.sol";
import {IDominoAutoExitExtension} from "../../../src/v2/interfaces/IDominoAutoExitExtension.sol";
import {IDominoFeeEvents} from "../../../src/v2/interfaces/IDominoFees.sol";
import {IDominoPositionActions} from "../../../src/v2/interfaces/IDominoPositionActions.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoSwapFloor} from "../../../src/v2/route/DominoSwapFloor.sol";
import {ScriptedRouter} from "../route/RouteAdversaries.sol";
import {AutoExitFixture, VmAutoExit} from "./AutoExitFixture.sol";
import {MockVault} from "./AutoExitMocks.sol";

/// Conversion through F1b's executor, the fee-aware floor against the anchor
/// (DominoSwapFloor: quote × (1 − pool fee) × (1 − slippage), the #3409682
/// fix) and where the 20 bps fee is taken (#283 S3; F0's fee rule). The pool
/// trades one token0 for four token1 at the anchor; its fee is 0.3%; token1
/// is the first charge currency.
contract DominoAutoExitConversionTest is AutoExitFixture {
    uint256 private constant FEE_BPS = 20;
    bytes32 private constant LEG_EXECUTED = keccak256("SwapLegExecuted(uint8,address,address,address,uint256,uint256)");
    /// The floor for HELD0 of token0 on the 0.3% pool with a 1% mandate:
    /// 4e18 × 0.997 × 0.99.
    uint256 private constant FLOOR_HELD0 = 3.94812e18;

    function _fee(uint256 amount) private pure returns (uint256) {
        return amount * FEE_BPS / 10_000;
    }

    function _refused(bytes32 mandateHash, IDominoAutoExit.Execution memory execution, bytes4 reason) private {
        vm.prank(OPERATOR);
        vm.expectRevert(reason);
        autoExit.execute(mandateHash, execution);
    }

    function _with(DominoV2Types.SwapLeg memory leg) private returns (IDominoAutoExit.Execution memory) {
        return _plan(_observation(pool, STOP), _legs(leg));
    }

    function _feesCharged(VmAutoExit.Log[] memory logs) private view returns (uint256) {
        return _count(logs, address(autoExit), IDominoFeeEvents.FeeCharged.selector);
    }

    /// (amountIn, amountOut) of the module's only SwapLegExecuted.
    function _legEffect(VmAutoExit.Log[] memory logs) private view returns (uint256 amountIn, uint256 amountOut) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(autoExit) && logs[i].topics[0] == LEG_EXECUTED) {
                (, amountIn, amountOut) = abi.decode(logs[i].data, (address, uint256, uint256));
            }
        }
    }

    function _bound(uint256 value, uint256 low, uint256 high) private pure returns (uint256) {
        return low + value % (high - low + 1);
    }

    // ------------------------------------------------- converted delivery
    /// Into the first charge currency: the fee is 20 bps of the converted
    /// output, in that currency, and the only charge.
    function testConvertsIntoTheListedTokenAndChargesTheOutput() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        IDominoAutoExit.Execution memory execution = _with(_routerLeg(address(token0), address(token1), HELD0, 3.98e18));
        vm.recordLogs();
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, execution);
        uint256 gross = HELD1 + 3.98e18;
        uint256 net = gross - _fee(gross);
        _eq(amount0, 0, "no token0");
        _eq(amount1, net, "net output");
        _eq(token1.balanceOf(owner), net, "owner paid in token1");
        _eq(token0.balanceOf(owner), 0, "owner has no token0");
        _eq(token1.balanceOf(FEE_RECIPIENT), _fee(gross), "fee on the output");
        _eq(token0.balanceOf(address(autoExit)) + token1.balanceOf(address(autoExit)), 0, "nothing stays");
        _eq(_feesCharged(vm.getRecordedLogs()), 1, "one charge");
    }

    /// Through the vault's own v4 pool, the leg taking whatever the removal
    /// delivered (amountIn zero): every token0 is sold, at least the floor arrives.
    function testConvertsThroughAV4PoolWithTheRemainder() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        IDominoAutoExit.Execution memory execution = _with(_poolLeg(address(token0), address(token1), 0, pool));
        vm.recordLogs();
        (, uint256 amount1) = _execute(mandateHash, execution);
        (uint256 sold, uint256 bought) = _legEffect(vm.getRecordedLogs());
        _eq(sold, HELD0, "the whole withdrawal sold");
        _true(bought >= FLOOR_HELD0, "at least the floor");
        uint256 gross = HELD1 + bought;
        _eq(amount1, gross - _fee(gross), "net output");
        _eq(token1.balanceOf(owner), amount1, "owner paid");
        _eq(token0.balanceOf(address(autoExit)), 0, "no token0 stays");
    }

    function testConvertsIntoAListedToken0() public {
        registry.setChargeCurrency(address(token0), 1);
        bytes32 mandateHash = _register(_converted(address(token0)));
        (uint256 amount0, uint256 amount1) = _execute(
            mandateHash, _plan(_observation(pool, STOP), _legs(_routerLeg(address(token1), address(token0), HELD1, 0.995e18)))
        );
        uint256 gross = HELD0 + 0.995e18;
        _eq(amount0, gross - _fee(gross), "net token0");
        _eq(amount1, 0, "no token1");
        _eq(token0.balanceOf(FEE_RECIPIENT), _fee(gross), "fee on the output");
        _eq(token1.balanceOf(FEE_RECIPIENT), 0, "no fee in token1");
    }

    /// Into a token that is no charge currency: 20 bps of each token
    /// withdrawn, before the conversion, in that token; nothing on the output.
    function testConvertsIntoAnUnlistedTokenChargingEachTokenWithdrawn() public {
        bytes32 mandateHash = _register(_converted(address(token0)));
        uint256 sold = HELD1 - _fee(HELD1);
        IDominoAutoExit.Execution memory execution =
            _plan(_observation(pool, STOP), _legs(_routerLeg(address(token1), address(token0), sold, sold / 4)));
        vm.recordLogs();
        (uint256 amount0,) = _execute(mandateHash, execution);
        uint256 gross = HELD0 - _fee(HELD0) + sold / 4;
        _eq(amount0, gross, "the output is not charged");
        _eq(token0.balanceOf(owner), gross, "owner paid in token0");
        _eq(token1.balanceOf(owner), 0, "owner has no token1");
        _eq(token0.balanceOf(FEE_RECIPIENT), _fee(HELD0), "fee in token0");
        _eq(token1.balanceOf(FEE_RECIPIENT), _fee(HELD1), "fee in token1");
        _eq(_feesCharged(vm.getRecordedLogs()), 2, "two charges");
    }

    function testConvertsNativeIntoTheTokenThroughAV4Pool() public {
        DominoV2Types.PoolRef memory ref = _poolOf(DominoV2Types.DEX_V4, address(0), address(token1));
        MockVault nativeVault = _newVault(ref, HELD0, HELD1);
        anchor.setSpot(ref, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.vault = address(nativeVault);
        bytes32 mandateHash = _register(mandate);
        (, uint256 amount1) =
            _execute(mandateHash, _plan(_observation(ref, STOP), _legs(_poolLeg(address(0), address(token1), 0, ref))));
        _true(amount1 >= HELD1 + FLOOR_HELD0 - _fee(HELD1 + 4e18), "native sold at the floor or better");
        _eq(token1.balanceOf(owner), amount1, "owner paid");
        _eq(address(autoExit).balance, 0, "no native stays");
    }

    function testConvertsIntoNativeThroughAV4Pool() public {
        registry.setChargeCurrency(address(0), 2);
        DominoV2Types.PoolRef memory ref = _poolOf(DominoV2Types.DEX_V4, address(0), address(token1));
        MockVault nativeVault = _newVault(ref, HELD0, HELD1);
        anchor.setSpot(ref, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(0));
        mandate.vault = address(nativeVault);
        bytes32 mandateHash = _register(mandate);
        (uint256 amount0,) =
            _execute(mandateHash, _plan(_observation(ref, STOP), _legs(_poolLeg(address(token1), address(0), 0, ref))));
        _eq(owner.balance, amount0, "owner paid in native");
        _true(FEE_RECIPIENT.balance > 0 && FEE_RECIPIENT.balance == (amount0 + FEE_RECIPIENT.balance) * FEE_BPS / 10_000, "native fee on the output");
        _eq(token1.balanceOf(address(autoExit)), 0, "every token1 sold");
    }

    // ------------------------------------------------------------- floor
    /// The floor is quote × (1 − pool fee) × (1 − slippage) at the anchor:
    /// 4e18 × 0.997 × 0.99 for the withdrawn token0, to the unit.
    function testTheFloorExcludesThePoolFeeToTheUnit() public {
        _eq(DominoSwapFloor.minimumOutput(HELD0, STOP, true, 3000, 100), FLOOR_HELD0, "the floor");
        bytes32 atFloor = _register(_converted(address(token1)));
        _execute(atFloor, _with(_routerLeg(address(token0), address(token1), HELD0, FLOOR_HELD0)));

        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.nonce = 2;
        bytes32 below = _register(mandate);
        vault.setPosition(TOKEN_ID, HELD0, HELD1);
        _fund(address(token0), address(vault), HELD0);
        _fund(address(token1), address(vault), HELD1);
        _refused(
            below,
            _with(_routerLeg(address(token0), address(token1), HELD0, FLOOR_HELD0 - 1)),
            IDominoAutoExitExtension.BelowMinimum.selector
        );
    }

    /// #3409682: on a 2% pool a 1% mandate still converts at 97.8% of the
    /// anchor, because the pool's own fee is not slippage.
    function testA2PercentPoolConvertsUnderA1PercentMandate() public {
        DominoV2Types.PoolRef memory steep = _v4Pool(address(token0), address(token1), 20_000, 60);
        MockVault steepVault = _newVault(steep, HELD0, HELD1);
        anchor.setSpot(steep, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.vault = address(steepVault);
        bytes32 mandateHash = _register(mandate);
        (, uint256 amount1) = _execute(
            mandateHash, _plan(_observation(steep, STOP), _legs(_routerLeg(address(token0), address(token1), HELD0, 3.912e18)))
        );
        _eq(amount1, HELD1 + 3.912e18 - _fee(HELD1 + 3.912e18), "converted");
    }

    /// A pool fee above MAX_POOL_FEE_PIPS (10%) counts as 10%: a 20% fee
    /// (a hook's dynamic fee, say) cannot lower the floor below 0.9 × 0.99.
    function testThePoolFeeCountsAtMostTenPercent() public {
        DominoV2Types.PoolRef memory extreme = _v4Pool(address(token0), address(token1), 200_000, 60);
        MockVault extremeVault = _newVault(extreme, HELD0, HELD1);
        anchor.setSpot(extreme, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.vault = address(extremeVault);
        bytes32 mandateHash = _register(mandate);
        _refused(
            mandateHash,
            _plan(_observation(extreme, STOP), _legs(_routerLeg(address(token0), address(token1), HELD0, 3.4e18))),
            IDominoAutoExitExtension.BelowMinimum.selector
        );
        _execute(
            mandateHash, _plan(_observation(extreme, STOP), _legs(_routerLeg(address(token0), address(token1), HELD0, 3.564e18)))
        );
    }

    /// On v4 the fee is read from the PoolManager, protocol fee included:
    /// 1% LP plus 0.1% protocol is 10,990 pips, a floor of 3.9164796e18. A
    /// router paying 3.918e18 passes only because the protocol fee counts.
    function testAV4PoolsProtocolFeeCountsInTheFloor() public {
        DominoV2Types.PoolRef memory taxed = _v4Pool(address(token0), address(token1), 10_000, 60);
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(
            IV4PoolManagerMinimal.PoolKey(address(token0), address(token1), 10_000, 60, address(0)), 1000 | (1000 << 12)
        );
        MockVault taxedVault = _newVault(taxed, HELD0, HELD1);
        anchor.setSpot(taxed, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.vault = address(taxedVault);
        bytes32 mandateHash = _register(mandate);
        _eq(DominoSwapFloor.minimumOutput(HELD0, STOP, true, 10_990, 100), 3.9164796e18, "the floor");
        _execute(
            mandateHash, _plan(_observation(taxed, STOP), _legs(_routerLeg(address(token0), address(token1), HELD0, 3.918e18)))
        );
    }

    /// A v3 pool's fee is its tier (PoolRef.fee): 1% here, so the floor is
    /// 4e18 × 0.99 × 0.99 to the unit.
    function testAV3PoolsFeeIsItsTier() public {
        DominoV2Types.PoolRef memory v3 = _poolOf(DominoV2Types.DEX_V3, address(token0), address(token1));
        v3.fee = 10_000;
        v3.tickSpacing = 200;
        MockVault v3Vault = _newVault(v3, 2 * HELD0, 2 * HELD1);
        anchor.setTwap(v3, STOP);
        anchor.setSpot(v3, STOP);
        DominoV2Types.ExitMandate memory mandate = _converted(address(token1));
        mandate.vault = address(v3Vault);
        bytes32 first = _register(mandate);
        mandate.nonce = 2;
        bytes32 second = _register(mandate);
        v3Vault.setPosition(TOKEN_ID, HELD0, HELD1);
        bytes memory twap = abi.encode(uint32(MIN_TWAP));
        _refused(
            first,
            _plan(twap, _legs(_routerLeg(address(token0), address(token1), HELD0, 3.9204e18 - 1))),
            IDominoAutoExitExtension.BelowMinimum.selector
        );
        _execute(first, _plan(twap, _legs(_routerLeg(address(token0), address(token1), HELD0, 3.9204e18))));
        _eq(autoExit.mandateStatus(second), 1, "the other mandate is untouched");
    }

    // -------------------------------------------------------------- legs
    /// Each clause alone: a leg that sells the wrong token (into the right
    /// one), and a leg that buys the wrong token (from the right one).
    function testLegsConvertTheSourceIntoTheTarget() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        _refused(
            mandateHash,
            _with(_routerLeg(address(token1), address(token1), HELD0, 1)),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
        _refused(
            mandateHash,
            _with(_routerLeg(address(token0), address(token0), HELD0, 1)),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
    }

    function testLegsConvertEverythingWithdrawn() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        _refused(
            mandateHash,
            _with(_routerLeg(address(token0), address(token1), HELD0 - 1, 4e18)),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
        _refused(
            mandateHash,
            _with(_routerLeg(address(token0), address(token1), HELD0 + 1, 4e18)),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
        _refused(mandateHash, _plan(_observation(pool, STOP)), IDominoAutoExitExtension.InvalidExecution.selector);
    }

    /// A router's calldata fixes the amount it pulls, so only a pool leg may
    /// take the remainder.
    function testOnlyAPoolLegTakesTheRemainder() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        _refused(
            mandateHash,
            _with(_routerLeg(address(token0), address(token1), 0, 4e18)),
            IDominoAutoExitExtension.InvalidExecution.selector
        );
    }

    function testASplitRouteWithAPoolRemainder() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        DominoV2Types.SwapLeg[] memory split = new DominoV2Types.SwapLeg[](2);
        split[0] = _routerLeg(address(token0), address(token1), 4e17, 1.6e18);
        split[1] = _poolLeg(address(token0), address(token1), 0, pool);
        (, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP), split));
        _true(amount1 > HELD1 + 1.6e18, "both legs counted");
        _eq(token0.balanceOf(address(autoExit)), 0, "every token0 sold");
    }

    /// Already all in the target: no leg is needed, and a leg given is never called.
    function testNothingToConvertCallsNoRouter() public {
        vault.setPosition(TOKEN_ID, 0, HELD1);
        bytes32 mandateHash = _register(_converted(address(token1)));
        DominoV2Types.SwapLeg memory failing = _routerLeg(address(token0), address(token1), HELD0, 1);
        failing.data = abi.encodeCall(ScriptedRouter.fail, ());
        (, uint256 amount1) = _execute(mandateHash, _with(failing));
        _eq(amount1, HELD1 - _fee(HELD1), "delivered without a swap");
    }

    // ------------------------------------- F1b's executor, wired in place
    function testTheExecutorRefusesAnUnadmittedRouter() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        DominoV2Types.SwapLeg memory leg = _routerLeg(address(token0), address(token1), HELD0, 4e18);
        leg.router = address(new ScriptedRouter(PERMIT2));
        _refused(mandateHash, _with(leg), IDominoPositionActions.InvalidPlan.selector);
    }

    function testTheExecutorRefusesARouterReturningInput() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        ScriptedRouter.Script memory script;
        script.tokenIn = address(token0);
        script.pull = HELD0;
        script.refundIn = 1;
        script.tokenOut = address(token1);
        script.pay = 4e18;
        _fund(address(token1), address(router), 4e18);
        _refused(
            mandateHash,
            _with(_routerLegWith(address(token0), address(token1), HELD0, script)),
            IDominoPositionActions.SwapEffectMismatch.selector
        );
    }

    /// The module tracks native currency on every leg: a router that slips
    /// ETH in while swapping two tokens is refused, not left with ETH stranded.
    function testALegThatMovesNativeCurrencyIsRefused() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        ScriptedRouter.Script memory script;
        script.tokenIn = address(token0);
        script.pull = HELD0;
        script.tokenOut = address(token1);
        script.pay = 4e18;
        script.extraToken = address(0);
        script.extraAmount = 1;
        _fund(address(token1), address(router), 4e18);
        vm.deal(address(router), 1);
        _refused(
            mandateHash,
            _with(_routerLegWith(address(token0), address(token1), HELD0, script)),
            IDominoPositionActions.SwapEffectMismatch.selector
        );
    }

    function testTheExecutorEnforcesALegsMinimum() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        DominoV2Types.SwapLeg memory leg = _routerLeg(address(token0), address(token1), HELD0, 4e18);
        leg.minAmountOut = 4e18 + 1;
        _refused(mandateHash, _with(leg), IDominoPositionActions.SwapEffectMismatch.selector);
    }

    function testARouterFailureRevertsWithItsReason() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        DominoV2Types.SwapLeg memory leg = _routerLeg(address(token0), address(token1), HELD0, 4e18);
        leg.data = abi.encodeCall(ScriptedRouter.fail, ());
        IDominoAutoExit.Execution memory execution = _with(leg);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "router says no"));
        autoExit.execute(mandateHash, execution);
    }

    function testARouterCannotReenter() public {
        bytes32 mandateHash = _register(_converted(address(token1)));
        ScriptedRouter.Script memory script;
        script.tokenIn = address(token0);
        script.pull = HELD0;
        script.tokenOut = address(token1);
        script.pay = 4e18;
        script.callTarget = address(autoExit);
        script.callData = abi.encodeCall(IDominoAutoExitExtension.cancelNonce, (5));
        _fund(address(token1), address(router), 4e18);
        _refused(
            mandateHash,
            _with(_routerLegWith(address(token0), address(token1), HELD0, script)),
            DominoActionLock.ReentrantCall.selector
        );
    }

    // ------------------------------------------- receiving both: the fee
    /// The first charge currency covers the fee: 20 bps of the position at
    /// the anchor, all of it in that currency.
    function testBothPaysTheFeeInTheListedToken() public {
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, HELD0, "token0 untouched");
        _eq(amount1, HELD1 - _fee(8e18), "token1 pays it all");
    }

    /// The listed token received covers part of the fee; the rest is taken in
    /// the other token at the anchor price.
    function testBothTakesTheRemainderInTheOtherToken() public {
        vault.setPosition(TOKEN_ID, HELD0, 1e15);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        uint256 due = _fee(1e15 + HELD0 * 4);
        _eq(amount1, 0, "all token1 to the fee");
        _eq(amount0, HELD0 - (due - 1e15) / 4, "the rest in token0");
        _eq(token1.balanceOf(FEE_RECIPIENT), 1e15, "fee in token1");
        _eq(token0.balanceOf(FEE_RECIPIENT), (due - 1e15) / 4, "fee in token0");
    }

    function testBothPrefersTheBetterRankedCurrency() public {
        registry.setChargeCurrency(address(token0), 1);
        registry.setChargeCurrency(address(token1), 2);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, HELD0 - _fee(2e18), "token0 pays it all");
        _eq(amount1, HELD1, "token1 untouched");
    }

    function testBothChargesTheOnlyListedToken0() public {
        registry.setChargeCurrency(address(token0), 1);
        registry.setChargeCurrency(address(token1), 0);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, HELD0 - _fee(2e18), "token0 pays it all");
        _eq(amount1, HELD1, "token1 untouched");
    }

    /// token0 leads and covers only part of the fee: the rest in token1.
    function testBothTakesTheRemainderInToken1WhenToken0Leads() public {
        registry.setChargeCurrency(address(token0), 1);
        registry.setChargeCurrency(address(token1), 0);
        vault.setPosition(TOKEN_ID, 1e15, HELD1);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        uint256 due = _fee(1e15 + HELD1 / 4);
        _eq(amount0, 0, "all token0 to the fee");
        _eq(amount1, HELD1 - (due - 1e15) * 4, "the rest in token1");
        _eq(token0.balanceOf(FEE_RECIPIENT), 1e15, "fee in token0");
        _eq(token1.balanceOf(FEE_RECIPIENT), (due - 1e15) * 4, "fee in token1");
    }

    function testBothOnEqualRanksChargesToken0() public {
        registry.setChargeCurrency(address(token0), 2);
        registry.setChargeCurrency(address(token1), 2);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, HELD0 - _fee(2e18), "token0 pays it all");
        _eq(amount1, HELD1, "token1 untouched");
    }

    function testBothWithoutAChargeCurrencyChargesEachToken() public {
        registry.setChargeCurrency(address(token1), 0);
        bytes32 mandateHash = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, HELD0 - _fee(HELD0), "20 bps of token0");
        _eq(amount1, HELD1 - _fee(HELD1), "20 bps of token1");
    }

    /// A position wholly in the unlisted token pays in that token, not in a
    /// listed token it did not deliver (exact 20 bps, no round trip through
    /// the anchor price, which would round to a different fee here).
    function testBothIgnoresAListedTokenNotReceived() public {
        uint160 price = 3 * Q96 / 2;
        anchor.setSpot(pool, price);
        vault.setPosition(TOKEN_ID, 1000, 0);
        bytes32 first = _register(_mandate());
        (uint256 amount0, uint256 amount1) = _execute(first, _plan(_observation(pool, price)));
        _eq(amount0, 998, "token0: 20 bps of 1000, rounded down");
        _eq(amount1, 0, "no token1");

        registry.setChargeCurrency(address(token0), 1);
        registry.setChargeCurrency(address(token1), 0);
        vault.setPosition(TOKEN_ID, 0, 1000);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.nonce = 2;
        bytes32 second = _register(mandate);
        (amount0, amount1) = _execute(second, _plan(_observation(pool, price)));
        _eq(amount0, 0, "no token0");
        _eq(amount1, 998, "token1: 20 bps of 1000, rounded down");
    }

    function testTheFeeRoundsDownForTheOwner() public {
        vault.setPosition(TOKEN_ID, 499, 0);
        bytes32 mandateHash = _register(_mandate());
        vm.recordLogs();
        (uint256 amount0,) = _execute(mandateHash, _plan(_observation(pool, STOP)));
        _eq(amount0, 499, "no fee below one unit");
        _eq(_feesCharged(vm.getRecordedLogs()), 0, "no charge");
    }

    /// Every unit withdrawn ends with the owner or the fee recipient, and the
    /// fee never exceeds 20 bps of the position at the anchor.
    function testFuzzBothSettlementConservesEveryToken(
        uint96 held0,
        uint96 held1,
        uint8 rank0,
        uint8 rank1,
        uint64 priceSeed
    ) public {
        registry.setChargeCurrency(address(token0), uint8(_bound(rank0, 0, 2)));
        registry.setChargeCurrency(address(token1), uint8(_bound(rank1, 0, 2)));
        uint160 price = uint160(_bound(priceSeed, 1 << 80, 1 << 112));
        anchor.setSpot(pool, price);
        vault.setPosition(TOKEN_ID, held0, held1);
        _fund(address(token0), address(vault), held0);
        _fund(address(token1), address(vault), held1);
        DominoV2Types.ExitMandate memory mandate = _mandate();
        mandate.triggerBelowSqrtPriceX96 = price;
        bytes32 mandateHash = _register(mandate);
        (uint256 amount0, uint256 amount1) = _execute(mandateHash, _plan(_observation(pool, price)));
        uint256 fee0 = token0.balanceOf(FEE_RECIPIENT);
        uint256 fee1 = token1.balanceOf(FEE_RECIPIENT);
        _eq(amount0 + fee0, held0, "token0 conserved");
        _eq(amount1 + fee1, held1, "token1 conserved");
        _eq(token0.balanceOf(owner), amount0, "owner token0");
        _eq(token1.balanceOf(owner), amount1, "owner token1");
        _eq(token0.balanceOf(address(autoExit)) + token1.balanceOf(address(autoExit)), 0, "nothing stays");
        uint256 value = uint256(held1) + DominoSwapFloor.quote(held0, price, true);
        _true(fee1 + DominoSwapFloor.quote(fee0, price, true) <= _fee(value) + 1, "at most 20 bps of the position");
    }
}
