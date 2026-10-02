// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault, IDominoVaultExecution} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoFeeEvents} from "../../../src/v2/interfaces/IDominoFees.sol";
import {DominoFeeLedger} from "../../../src/v2/fees/DominoFeeLedger.sol";
import {DominoV3Positions} from "../../../src/v2/positions/DominoV3Positions.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {MockAnchor} from "./VaultMocks.sol";
import {VaultHarness, HarnessV3} from "./VaultHarness.sol";

/// The operator path, IDominoVaultExecution.execute: the plan rules, the fee
/// ledger (tariff once, on consumed earned fees only, charged units never
/// again), the swap floor and its fee-aware fix, the effect checks on every
/// step, and fee settlement with the owed-fee fallback. The executor is the
/// same code on both DEXes; these exact-number cases run on the v3 unit
/// model, and DominoV2VaultV4.t.sol runs the v4 paths on the deployed
/// PoolManager and PositionManager.
abstract contract ExecutionSuite is VaultHarness {
    // ======================================================= fee accounting

    function testCompoundChargesTheTariffOnceAndKeepsTheRemainder() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        uint128 before = _liquidityOf(rootId);
        Plan.PlanV1 memory p = _plan();
        bytes memory raw = Plan.encode(p);
        bytes32 expected = keccak256(abi.encodePacked(block.chainid, address(vault), raw));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoFeeEvents.FeeCharged(DominoV2Types.FEE_KIND_AUTOMATION, address(token0), OWNER, 19, expected);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoFeeEvents.FeeCharged(DominoV2Types.FEE_KIND_AUTOMATION, address(token1), OWNER, 19, expected);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.Compounded(rootId, 980, 980, 980, 19, 19, 2);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVaultExecution.Executed(expected, Plan.ACTION_COMPOUND, 2);
        vm.prank(OPERATOR);
        bytes32 planHash = vault.execute(raw);
        _true(planHash == expected, "plan hash");
        // 1000 of fees: netOf(1000) = 980 is added; the least gross giving 980
        // is 999, so the cut is 19 and one unit stays with the owner.
        _eq(_liquidityOf(rootId) - before, 980, "liquidity added");
        _eq(token0.balanceOf(RECIPIENT), 19, "tariff token0");
        _eq(token1.balanceOf(RECIPIENT), 19, "tariff token1");
        (uint128 uncharged0, uint128 charged0) = _lot(rootId, address(token0));
        (uint128 uncharged1,) = _lot(rootId, address(token1));
        _eq(uncharged0, 1, "remainder token0");
        _eq(charged0, 0, "nothing converted");
        _eq(uncharged1, 1, "remainder token1");
        _eq(vault.reserves(address(token0)), 1, "reserves");
        _eq(vault.stateNonce(), 2, "nonce");
        _eq(vault.lastExecutionAt(), block.timestamp, "last execution");
        _eq(token0.balanceOf(address(vault)), 1, "vault holds only the remainder");
    }

    function testDominoModeChargesFourPercent() public {
        _domino(3);
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        // netOf(1000) at 400 bps = 960; least gross for 960 is 999: cut 39.
        _eq(token0.balanceOf(RECIPIENT), 39, "tariff token0");
        _eq(token1.balanceOf(RECIPIENT), 39, "tariff token1");
        (uint128 uncharged0,) = _lot(rootId, address(token0));
        _eq(uncharged0, 1, "remainder");
    }

    function testOnlyConsumedFeesAreCharged() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        // token1 limits the add to 490 per token; 501 of token0 is never charged.
        _eq(token0.balanceOf(RECIPIENT), 9, "tariff token0");
        _eq(token1.balanceOf(RECIPIENT), 9, "tariff token1");
        (uint128 uncharged0,) = _lot(rootId, address(token0));
        (uint128 uncharged1,) = _lot(rootId, address(token1));
        _eq(uncharged0, 501, "token0 waits uncharged");
        _eq(uncharged1, 1, "token1 remainder");
    }

    function testPlanMaximaBoundTheAdd() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.amount0Max = 500;
        uint128 before = _liquidityOf(rootId);
        _execute(p);
        _eq(_liquidityOf(rootId) - before, 500, "liquidity");
        // least gross for 500 is 510: cut 10, 490 left.
        (uint128 uncharged0,) = _lot(rootId, address(token0));
        _eq(uncharged0, 490, "token0 left");
        _eq(token0.balanceOf(RECIPIENT), 10, "tariff");
    }

    function testPlanMaximaBoundTheAddInToken1() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.amount1Max = 500;
        uint128 before = _liquidityOf(rootId);
        _execute(p);
        _eq(_liquidityOf(rootId) - before, 500, "liquidity");
        (uint128 uncharged1,) = _lot(rootId, address(token1));
        _eq(uncharged1, 490, "token1 left");
    }

    function testBudgetCapsBoundTheDebitTariffIncluded() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.budgets[0].max0 = 300;
        uint128 before = _liquidityOf(rootId);
        _execute(p);
        // a 300 gross cap nets 294; 294 costs a gross of 299 <= 300.
        _eq(_liquidityOf(rootId) - before, 294, "liquidity");
        (uint128 uncharged0,) = _lot(rootId, address(token0));
        _eq(uncharged0, 701, "token0 left");
    }

    // ================================================================= swaps

    function testSwapOutputIsNeverChargedAgain() public {
        _simple();
        _accrue(rootId, 2000, 0);
        uint128 before = _liquidityOf(rootId);
        _execute(_withSwap(_plan(), rootId, true, 970, 960));
        // Swap input: least gross for 970 is 989 (cut 19). The add takes 970 of
        // each token: token0 from the uncharged gross (cumulative 1979, cut 39
        // in all), token1 entirely from the charged swap output (no cut).
        _eq(_liquidityOf(rootId) - before, 970, "liquidity");
        _eq(token0.balanceOf(RECIPIENT), 39, "tariff once on the consumed fees");
        _eq(token1.balanceOf(RECIPIENT), 0, "swap output never charged");
        (uint128 uncharged0,) = _lot(rootId, address(token0));
        (, uint128 charged1) = _lot(rootId, address(token1));
        _eq(uncharged0, 21, "token0 left");
        _eq(charged1, 0, "swap output consumed");
    }

    function testSwapOutputMustFundTheAdd() public {
        _simple();
        _accrue(rootId, 2000, 0);
        // 1500 in leaves token0 limiting: 1040 of the output would sit idle.
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 1500, 1480);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(p);
    }

    /// Swap output is credited to a 128-bit lot; more refuses the execution.
    function testSwapOutputMustFitTheLedger() public {
        _simple();
        _accrue(rootId, 2000, 0);
        token1.mint(address(venue), 1 << 200);
        venue.setRate(1 << 128, 1);
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(p);
    }

    function testSwapFloorIsTheAnchorQuoteLessPoolFeeLessSlippage() public {
        _simple();
        _accrue(rootId, 2000, 0);
        // 970 at price 1, less 0.3% pool fee, less 1% slippage: 957.4 -> 957.
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 970, 956);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(p);
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
    }

    /// V1 position #3409682: the pool's 1% fee plus a 1% owner slippage could
    /// never pass a floor that counted the fee as slippage (99% of quote).
    function testPoolFeeIsNotSlippage() public {
        poolFee = 10000;
        _simple();
        _accrue(rootId, 2000, 0);
        venue.setRate(955, 970);
        // 970 * 0.99 * 0.99 = 950.7 -> 950; the venue pays 955 (98.5%).
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 949);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(planned);
        uint128 before = _liquidityOf(rootId);
        _execute(_withSwap(_plan(), rootId, true, 970, 950));
        _eq(_liquidityOf(rootId) - before, 955, "the bounded swap reinvests");
    }

    function testSwapAnchorsTheQuoteNotTheSpot() public {
        _simple();
        _accrue(rootId, 2000, 0);
        // The anchor says token1 is worth 4x less (sqrt 2): the floor doubles.
        anchor.set(uint160(2 << 96), PRICE_ONE);
        venue.setRate(4 * 970 * 99, 100 * 970);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 3828);
        vm.expectRevert(DominoV2VaultStorage.InvalidRoute.selector);
        _execute(planned);
    }

    function testSwapMustSpendExactlyItsInput() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(4, 0);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(planned);
    }

    function testSwapMustSpendNothingElse() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(1, 3);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(planned);
    }

    function testSwapMustDeliverItsMinimum() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(3, 0);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        _execute(planned);
    }

    function testAddIsBoundedByTheAnchorAgainAfterTheSwap() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(5, 0);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(MockAnchor.SpotOutsideBand.selector);
        _execute(planned);
    }

    function testSwapSourceMustBeBudgeted() public {
        _domino(3);
        _accrue(rootId, 2000, 0);
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId + 1, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testSwapNeedsAnInput() public {
        _simple();
        _accrue(rootId, 2000, 0);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 0, 0);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(planned);
    }

    function testSwapCannotSpendMoreThanTheSourceHolds() public {
        _simple();
        _accrue(rootId, 900, 0);
        Plan.PlanV1 memory planned = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        _execute(planned);
    }

    function testNoSwapIsTheAllZeroValue() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.swap.source = rootId;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.swap.zeroForOne = true;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.swap.amountIn = 1;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.swap.minAmountOut = 1;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    // ============================================================ plan rules

    function testOnlyAdmittedOperatorsExecute() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        bytes memory raw = Plan.encode(_plan());
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.execute(raw);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.execute(raw);
        registry.setOperator(OPERATOR, false);
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.execute(raw);
    }

    function testPauseAndTheGlobalHaltStopExecution() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        vm.prank(OWNER);
        vault.pause();
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(p);
        vm.prank(OWNER);
        vault.resume();
        registry.setHalted(true);
        p = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(p);
        registry.setHalted(false);
        _execute(_plan());
    }

    function testPlanVersionByte() public {
        _simple();
        bytes memory raw = Plan.encode(_plan());
        raw[0] = 0x02;
        vm.prank(OPERATOR);
        vm.expectRevert(Plan.InvalidPlan.selector);
        vault.execute(raw);
        vm.prank(OPERATOR);
        vm.expectRevert(Plan.InvalidPlan.selector);
        vault.execute("");
        vm.prank(OPERATOR);
        vm.expectRevert();
        vault.execute(hex"0100");
    }

    function testPlanBindsTheStateNonce() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        vm.prank(OWNER);
        vault.setLimits(_limits());
        vm.expectRevert(DominoV2VaultStorage.StaleNonce.selector);
        _execute(p);
        p.stateNonce = vault.stateNonce() + 1;
        vm.expectRevert(DominoV2VaultStorage.StaleNonce.selector);
        _execute(p);
    }

    function testPlanDeadline() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        vm.warp(10_000);
        Plan.PlanV1 memory p = _plan();
        p.deadline = 9_999;
        vm.expectRevert(DominoV2VaultStorage.PlanExpired.selector);
        _execute(p);
        p.deadline = 10_000;
        _execute(p);
    }

    function testMinimumIntervalBetweenExecutions() public {
        _simple();
        vm.warp(10_000);
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        _accrue(rootId, 1000, 1000);
        vm.warp(10_059);
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(DominoV2VaultStorage.TooSoon.selector);
        _execute(p);
        vm.warp(10_060);
        _execute(p);
    }

    function testCollectListIsStrictlyAscendingActiveMembers() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.collect = _two(rootId, rootId);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p.collect = _two(rootId, rootId + 50);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testCompoundTargetIsAnActiveCollectedMemberWithoutTicks() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.collect = new uint256[](0);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.target = rootId + 50;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.tickLower = -60;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.tickUpper = 60;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testUnknownActionsAreRefused() public {
        _simple();
        Plan.PlanV1 memory p = _plan();
        p.action = 0;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p.action = 3;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testAnAddNeedsAMinimumAndABudget() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.minLiquidity = 0;
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p = _plan();
        p.budgets = new Plan.Budget[](0);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testBudgetsAreStrictlyAscendingActiveMembers() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.budgets = new Plan.Budget[](2);
        (p.budgets[0], p.budgets[1]) = (_budget(rootId), _budget(rootId));
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
        p.budgets[1] = _budget(rootId + 50);
        vm.expectRevert(DominoV2VaultStorage.InvalidPlan.selector);
        _execute(p);
    }

    function testLiquidityFloor() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        Plan.PlanV1 memory p = _plan();
        p.minLiquidity = 981;
        vm.expectRevert(abi.encodeWithSelector(DominoV3Positions.InsufficientLiquidity.selector, 980, 981));
        _execute(p);
        p.minLiquidity = 980;
        _execute(p);
    }

    function testAnchorEvidenceAndLimitsReachTheAnchor() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        vm.expectCall(
            address(anchor), abi.encodeCall(MockAnchor.anchor, (vault.pool(), bytes(hex"a0"), uint32(300), uint16(200)))
        );
        _execute(_plan());
    }

    function testAnchorOutsideTheBandStopsTheExecution() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        anchor.setOutside(true);
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(MockAnchor.SpotOutsideBand.selector);
        _execute(p);
    }

    /// Until F1b's swap module is wired, a plan with a swap is refused; plans
    /// without one need no module.
    function testAnUnwiredSwapIsUnavailable() public {
        _deployVault(address(0xDEAD));
        _simple();
        _accrue(rootId, 2000, 1000);
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 970, 957);
        vm.expectRevert(DominoV2VaultStorage.StepUnavailable.selector);
        _execute(p);
        _execute(_plan());
    }

    // ======================================================== root custody

    function testRootWhoseApprovalMovedIsDisarmedWithoutSpending() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        _approveNft(OWNER, rootId, STRANGER);
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        bytes32 planHash = _execute(_plan());
        _true(planHash == bytes32(0), "nothing executed");
        _eq(_balance(address(token0), RECIPIENT), 0, "no tariff");
        _eq(vault.stateNonce(), 2, "only the disarm advanced the nonce");
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(p);
    }

    // ===================================================== fee settlement

    function testRecipientThatRejectsLeavesTheFeeOwed() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        token0.setBlocked(RECIPIENT, true);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoFeeEvents.FeeDeferred(address(token0), 19, 19);
        _execute(_plan());
        _eq(vault.owedFees(address(token0)), 19, "owed");
        _eq(token1.balanceOf(RECIPIENT), 19, "the other token paid");
        _eq(vault.reserves(address(token0)), 1, "owed is not the owner's");
        token0.setBlocked(RECIPIENT, false);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoFeeEvents.OwedFeesFlushed(address(token0), RECIPIENT, 19);
        vm.prank(STRANGER);
        _eq(vault.flushOwedFees(address(token0)), 19, "flushed");
        _eq(token0.balanceOf(RECIPIENT), 19, "recipient paid");
        _eq(vault.owedFees(address(token0)), 0, "nothing owed");
        _eq(vault.flushOwedFees(address(token0)), 0, "flush is idempotent");
    }

    function testFalseReturningTransferLeavesTheFeeOwed() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        token1.setFalseTo(RECIPIENT, true);
        _execute(_plan());
        _eq(vault.owedFees(address(token1)), 19, "owed");
        _eq(token0.balanceOf(RECIPIENT), 19, "paid");
    }

    function testSilentTransferCountsAsPaid() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        token0.setSilentTo(RECIPIENT, true);
        _execute(_plan());
        _eq(vault.owedFees(address(token0)), 0, "nothing owed");
        _eq(token0.balanceOf(RECIPIENT), 19, "paid");
    }

    function testMissingRecipientLeavesTheFeeOwedAndFlushWaits() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        registry.setFeeRecipient(address(0));
        _execute(_plan());
        _eq(vault.owedFees(address(token0)), 19, "owed0");
        _eq(vault.owedFees(address(token1)), 19, "owed1");
        vm.expectRevert(DominoFeeLedger.FeeRecipientUnavailable.selector);
        vault.flushOwedFees(address(token0));
        registry.setFeeRecipient(STRANGER);
        vault.flushOwedFees(address(token0));
        _eq(token0.balanceOf(STRANGER), 19, "the recipient in force is paid");
    }

    // ============================================================ callbacks

    /// A swap's callbacks reach the swap module through the vault (the module
    /// authenticates them: DominoV2VaultSwapModule.t.sol); without a module
    /// they are refused.
    function testCallbacksReachTheSwapModule() public {
        _simple();
        _accrue(rootId, 2000, 0);
        config.set(6, 0);
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
        _true(
            keccak256(probe.returned()) == keccak256(abi.encode(keccak256(abi.encode(uint256(970))))),
            "the swap module answered the callback"
        );
        _deployVault(address(0xDEAD));
        _simple();
        vm.expectRevert(DominoV2VaultStorage.StepUnavailable.selector);
        vault.unlockCallback(hex"00");
        vm.expectRevert(DominoV2VaultStorage.StepUnavailable.selector);
        vault.uniswapV3SwapCallback(1, -1, "");
    }
}

contract DominoV2VaultExecutionV3Test is ExecutionSuite, HarnessV3 {
    /// A swap through the pool accrues fees to the destination; v3's increase
    /// pokes them into tokensOwed, where the next collect finds them.
    function testFeesAccruedDuringTheSwapWaitInTokensOwed() public {
        _simple();
        _accrue(rootId, 2000, 0);
        token0.mint(address(npm), 7);
        token1.mint(address(npm), 7);
        config.set(8, 0);
        config.setHook(address(npm), abi.encodeCall(npm.accrue, (rootId, 7, 7)));
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = npm.positions(rootId);
        _eq(owed0, 7, "owed0");
        _eq(owed1, 7, "owed1");
        _true(vault.rootArmed(), "the checkpoint was taken after the step");
    }
}
