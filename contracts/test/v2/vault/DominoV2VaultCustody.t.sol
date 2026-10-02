// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultV4, DominoV2VaultV4Hooks} from "../../../src/v2/vault/DominoV2VaultV4.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {MockV3PositionManager} from "./VaultMocks.sol";
import {HarnessV3, VaultVm} from "./VaultHarness.sol";
import {HarnessV4, IV4PositionManagerTest} from "./VaultHarnessV4.sol";

/// A subscriber that accepts any subscription, as another app would.
contract OtherSubscriber {
    function notifySubscribe(uint256, bytes calldata) external {}
    function notifyUnsubscribe(uint256) external {}
    function notifyModifyLiquidity(uint256, int256, int256) external {}
    function notifyBurn(uint256, address, uint256, uint256, int256) external {}
}

/// v4 custody on the PositionManager deployed on Base: the vault is the
/// root's subscriber. Every change the owner makes reaches it at once and
/// disarms the root, and no notification of the owner's own change can ever
/// be blocked by the vault.
contract DominoV2VaultCustodyV4Test is HarnessV4 {
    bytes4 internal constant WRAPPED_ERROR = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));
    bytes4 internal constant SUBSCRIPTION_REVERTED = bytes4(keccak256("SubscriptionReverted(address,bytes)"));

    function _v4() internal view returns (DominoV2VaultV4) {
        return DominoV2VaultV4(payable(address(vault)));
    }

    function _erc721() internal view returns (IV4PositionManagerTest) {
        return IV4PositionManagerTest(address(pm));
    }

    /// The PositionManager wraps the vault's refusal of a subscription.
    function _refusedSubscription() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            WRAPPED_ERROR,
            address(vault),
            DominoV2VaultV4.notifySubscribe.selector,
            abi.encodeWithSelector(DominoV2VaultStorage.UnexpectedCallback.selector),
            abi.encodePacked(SUBSCRIPTION_REVERTED)
        );
    }

    function testCreationSubscribesTheVault() public {
        _simple();
        _true(pm.subscriber(rootId) == address(vault), "subscribed");
        _true(pm.getApproved(rootId) == address(vault), "approved");
        _true(pm.ownerOf(rootId) == OWNER, "root stays in the wallet");
    }

    function testCreationRefusesAForeignSubscriber() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        OtherSubscriber other = new OtherSubscriber();
        vm.prank(OWNER);
        pm.subscribe(rootId, address(other), "");
        _approveNft(OWNER, rootId, factory.predictVault(OWNER, 0));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DominoV2VaultV4Hooks.ForeignSubscriber.selector, address(other)));
        factory.createVault(init, 0);
    }

    function testOwnerDecreaseDisarmsAndIsNeverBlocked() public {
        _simple();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(2, 2);
        _modify(OWNER, rootId, -1);
        _eq(_liquidityOf(rootId), ROOT_LIQUIDITY - 1, "the owner's change went through");
        _true(!vault.rootArmed(), "disarmed");
        _eq(vault.stateNonce(), 2, "nonce");
    }

    function testOwnerIncreaseDisarms() public {
        _simple();
        _modify(OWNER, rootId, 10);
        _eq(_liquidityOf(rootId), ROOT_LIQUIDITY + 10, "the owner's change went through");
        _true(!vault.rootArmed(), "disarmed");
    }

    function testOwnerFeeCollectionDisarms() public {
        _simple();
        _accrue(rootId, 5000, 5000);
        (uint256 fees0,) = _collectable(rootId);
        _true(fees0 > 0, "fees accrued");
        _modify(OWNER, rootId, 0);
        _eq(token0.balanceOf(OWNER), fees0, "the owner took its fees");
        _true(!vault.rootArmed(), "disarmed");
        Plan.PlanV1 memory p = _plan();
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        _execute(p);
    }

    function testApprovedOperatorChangeDisarms() public {
        _simple();
        vm.prank(OWNER);
        _erc721().setApprovalForAll(STRANGER, true);
        _modify(STRANGER, rootId, -1);
        _true(!vault.rootArmed(), "disarmed");
    }

    function testBurnDisarmsAndIsNeverBlocked() public {
        _simple();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(3, 2);
        _burnRoot();
        _true(!vault.rootArmed(), "disarmed, and the view does not revert on a burned root");
        _true(token0.balanceOf(OWNER) > 0 && token1.balanceOf(OWNER) > 0, "the owner got everything");
        (bool exists,) = address(pm).staticcall(abi.encodeCall(pm.ownerOf, (rootId)));
        _true(!exists, "burned");
    }

    function testOwnerUnsubscribeDisarms() public {
        _simple();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(1, 2);
        vm.prank(OWNER);
        pm.unsubscribe(rootId);
        _true(!vault.rootArmed(), "disarmed");
    }

    /// A transfer clears the approval and unsubscribes, best effort, with the
    /// manager's 300,000 gas.
    function testTransferUnsubscribesAndClearsTheApproval() public {
        _simple();
        vm.cool(address(vault));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(1, 2);
        _transferNft(OWNER, STRANGER, rootId);
        _true(pm.subscriber(rootId) == address(0), "unsubscribed");
        _true(pm.getApproved(rootId) == address(0), "approval cleared");
        _true(!vault.rootArmed(), "disarmed");
    }

    /// The manager gives notifyUnsubscribe 300,000 gas; cold, it needs far less.
    function testNotifyUnsubscribeFitsTheGasLimitCold() public {
        _simple();
        _eq(pm.unsubscribeGasLimit(), 300_000, "the deployed limit");
        vm.cool(address(vault));
        vm.prank(address(pm));
        uint256 start = gasleft();
        (bool ok,) = address(vault).call{gas: 300_000}(abi.encodeCall(DominoV2VaultV4.notifyUnsubscribe, (rootId)));
        uint256 used = start - gasleft();
        _true(ok && !vault.rootArmed(), "disarmed within the limit");
        _true(used < 40_000, "cold notifyUnsubscribe under 40k gas");
    }

    function testApprovalToAnotherAppStopsAutomation() public {
        _simple();
        _approveNft(OWNER, rootId, STRANGER);
        _true(pm.subscriber(rootId) == address(vault), "the subscriber slot stays taken");
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
    }

    function testNotificationsFromOthersAreRefused() public {
        _simple();
        vm.startPrank(STRANGER);
        vm.expectRevert(DominoV2VaultStorage.UnexpectedCallback.selector);
        _v4().notifyModifyLiquidity(rootId, -1, 0);
        vm.expectRevert(DominoV2VaultStorage.UnexpectedCallback.selector);
        _v4().notifyBurn(rootId, OWNER, 0, 0, 0);
        vm.expectRevert(DominoV2VaultStorage.UnexpectedCallback.selector);
        _v4().notifyUnsubscribe(rootId);
        vm.expectRevert(DominoV2VaultStorage.UnexpectedCallback.selector);
        _v4().notifySubscribe(rootId, "");
        vm.stopPrank();
        _true(vault.rootArmed(), "still armed");
    }

    function testTheVaultCannotBeSubscribedToAnotherPosition() public {
        _simple();
        uint256 other = _mintPosition(STRANGER, LOWER, UPPER, 1000);
        vm.prank(STRANGER);
        vm.expectRevert(_refusedSubscription());
        pm.subscribe(other, address(vault), "");
    }

    function testNotificationsAboutOtherPositionsAreIgnored() public {
        _simple();
        vm.startPrank(address(pm));
        _v4().notifyModifyLiquidity(rootId + 1, -1, 0);
        _v4().notifyBurn(rootId + 1, OWNER, 0, 0, 0);
        _v4().notifyUnsubscribe(rootId + 1);
        vm.stopPrank();
        _true(vault.rootArmed(), "still armed");
        _eq(vault.stateNonce(), 1, "nothing changed");
    }

    function testNotificationsWhileDisarmedChangeNothing() public {
        _simple();
        _modify(OWNER, rootId, -1);
        vm.recordLogs();
        _modify(OWNER, rootId, -1);
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            _true(logs[i].emitter != address(vault), "no second disarm");
        }
        _eq(vault.stateNonce(), 2, "nonce unchanged");
    }

    function testTheVaultsOwnStepsDoNotDisarm() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        _true(vault.rootArmed(), "armed after collecting and increasing the root");
    }

    function testTheOwnerCannotSubscribeTheVaultByHand() public {
        _simple();
        vm.prank(OWNER);
        pm.unsubscribe(rootId);
        vm.prank(OWNER);
        vm.expectRevert(_refusedSubscription());
        pm.subscribe(rootId, address(vault), "");
    }

    /// An unsubscription whose notification failed (the manager swallows it)
    /// is still seen: the live view and the next execution check the
    /// subscriber itself.
    function testASubscriptionLostSilentlyIsStillSeen() public {
        _simple();
        vm.mockCallRevert(address(vault), abi.encodeCall(DominoV2VaultV4.notifyUnsubscribe, (rootId)), "");
        vm.prank(OWNER);
        pm.unsubscribe(rootId);
        _eq(vault.stateNonce(), 1, "the notification never arrived");
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
    }

    function testANonexistentRootIsRefused() public {
        IDominoVault.Init memory init = _init(999, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(bytes("NOT_MINTED"));
        factory.createVault(init, 0);
    }

    function testRearmKeepsTheSubscription() public {
        _simple();
        _modify(OWNER, rootId, -1);
        vm.prank(OWNER);
        vault.rearm(true);
        _true(vault.rootArmed() && pm.subscriber(rootId) == address(vault), "armed, same subscription");
    }

    /// v4 has no open increase: only the owner ever rearms.
    function testNoOperatorRearmOnV4() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory any;
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.operatorRearm(any);
    }

    function testRearmAfterATransferBackSubscribesAgain() public {
        _simple();
        _transferNft(OWNER, STRANGER, rootId);
        _transferNft(STRANGER, OWNER, rootId);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.rearm(true);
        _approveNft(OWNER, rootId, address(vault));
        vm.prank(OWNER);
        vault.rearm(true);
        _true(vault.rootArmed() && pm.subscriber(rootId) == address(vault), "subscribed again");
    }
}

/// v3 custody: no subscriber, so the vault compares the root with the
/// checkpoint it recorded after its own last step, on every execution that
/// needs the root, and disarms on any difference without spending anything.
contract DominoV2VaultCustodyV3Test is HarnessV3 {
    // =========================================== the limited operator rearm

    function _checkpointNow() internal view returns (IDominoVaultLedger.RootCheckpoint memory c) {
        (,,,,,,, c.liquidity, c.feeGrowthInside0LastX128, c.feeGrowthInside1LastX128, c.tokensOwed0, c.tokensOwed1) =
            npm.positions(rootId);
    }

    /// A third party adds liquidity to the root, as anyone may on v3.
    function _dustAdd(uint128 amount) internal {
        token0.mint(STRANGER, amount);
        token1.mint(STRANGER, amount);
        vm.startPrank(STRANGER);
        token0.approve(address(npm), amount);
        token1.approve(address(npm), amount);
        npm.increaseLiquidity(
            MockV3PositionManager.IncreaseLiquidityParams(rootId, amount, amount, 0, 0, block.timestamp)
        );
        vm.stopPrank();
    }

    function _operatorRearm(IDominoVaultLedger.RootCheckpoint memory previous) internal {
        vm.prank(OPERATOR);
        vault.operatorRearm(previous);
    }

    function _operatorRearmFails(IDominoVaultLedger.RootCheckpoint memory previous) internal {
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.operatorRearm(previous);
    }

    function testEveryCheckpointIsEmitted() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        IDominoVaultLedger.RootCheckpoint memory created = _checkpointNow();
        address predicted = factory.predictVault(OWNER, 0);
        _approveNft(OWNER, rootId, predicted);
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.expectEmit(true, true, true, true, predicted);
        emit IDominoVaultLedger.RootCheckpointed(created);
        vm.prank(OWNER);
        vault = DominoV2VaultBase(payable(factory.createVault(init, 0)));
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        _eq(uint256(keccak256(abi.encode(_checkpointNow()))), uint256(vm.load(address(vault), bytes32(uint256(6)))), "stored hash");
    }

    /// Fees accrued, then a stranger's dust poked them into tokensOwed: the
    /// execution disarms, an operator rearms, automation goes on.
    function testAnOperatorRearmsARootThatOnlyGainedLiquidity() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        _dustAdd(1);
        _execute(_plan());
        _true(!vault.rootArmed(), "disarmed by the checkpoint");
        IDominoVaultLedger.RootCheckpoint memory current = _checkpointNow();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVaultLedger.RootCheckpointed(current);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootRearmed(3);
        _operatorRearm(previous);
        _true(vault.rootArmed(), "rearmed");
        uint128 before = _liquidityOf(rootId);
        _execute(_plan());
        _eq(_liquidityOf(rootId) - before, 980, "the poked fees compound");
        _true(vault.rootArmed(), "armed");
    }

    /// Before the next execution, an armed root is re-checkpointed and never disarms.
    function testAnOperatorRearmsAnArmedRootBeforeItsNextExecution() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        _dustAdd(3);
        _operatorRearm(previous);
        vm.recordLogs();
        _execute(_plan());
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            _true(
                logs[i].topics.length == 0 || logs[i].topics[0] != IDominoVault.RootDisarmed.selector, "never disarmed"
            );
        }
        _true(vault.rootArmed(), "armed");
    }

    /// A dust add followed by an owner's decrease: the principal in tokensOwed
    /// is more than the fees can explain, so only the owner rearms.
    function testADustAddThenAnOwnerDecreaseWaitsForTheOwner() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        _dustAdd(10);
        vm.prank(OWNER);
        npm.decreaseLiquidity(MockV3PositionManager.DecreaseLiquidityParams(rootId, 5, 0, 0, block.timestamp));
        _true(_checkpointNow().liquidity > previous.liquidity, "liquidity still grew");
        _operatorRearmFails(previous);
        _execute(_plan());
        _operatorRearmFails(previous);
        vm.prank(OWNER);
        vault.rearm(true);
        _true(vault.rootArmed(), "the owner rearms");
    }

    /// A dust add and an owner's collect: tokensOwed grew by less than the fees.
    function testADustAddThenAnOwnerCollectWaitsForTheOwner() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        _dustAdd(1);
        vm.prank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, 10, 0));
        _operatorRearmFails(previous);
    }

    /// A checkpoint can carry tokensOwed (fees the plan's swap accrued, which
    /// the vault's own increase poked); collecting them shrinks what is owed,
    /// which no addition does.
    function testCollectingWhatTheCheckpointOwedWaitsForTheOwner() public {
        _simple();
        _accrue(rootId, 2000, 0);
        token0.mint(address(npm), 7);
        token1.mint(address(npm), 7);
        config.set(8, 0);
        config.setHook(address(npm), abi.encodeCall(npm.accrue, (rootId, 7, 7)));
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
        config.set(0, 0);
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _eq(previous.tokensOwed0, 7, "owed in the checkpoint");
        vm.prank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, 7, 7));
        _dustAdd(1);
        _operatorRearmFails(previous);
    }

    /// Fees poked without any addition (an owner's zero collect) are no addition.
    function testAnOperatorRearmNeedsMoreLiquidity() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        vm.prank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, 0, 0));
        _operatorRearmFails(previous);
    }

    /// The previous checkpoint is the one the vault recorded, not one written
    /// to hide a collect: here, the poked fees disguised as unchanged.
    function testAnOperatorRearmNeedsTheRecordedCheckpoint() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _accrue(rootId, 1000, 1000);
        _dustAdd(1);
        IDominoVaultLedger.RootCheckpoint memory forged = _checkpointNow();
        forged.liquidity = previous.liquidity;
        _operatorRearmFails(forged);
        _operatorRearm(previous);
    }

    function testAnOperatorRearmNeedsCustody() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _dustAdd(1);
        _approveNft(OWNER, rootId, STRANGER);
        _operatorRearmFails(previous);
    }

    function testAnOperatorRearmIsAnOperatorsOutsideTheHalt() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _dustAdd(1);
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.operatorRearm(previous);
        registry.setHalted(true);
        _operatorRearmFails(previous);
        registry.setHalted(false);
        _operatorRearm(previous);
    }

    /// Only a checkpoint mismatch is the operator's to clear: not a custody
    /// loss, and never after the owner ended automation (exitAll).
    function testAnOperatorRearmsOnlyAfterACheckpointMismatch() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _approveNft(OWNER, rootId, STRANGER);
        _execute(_plan());
        _approveNft(OWNER, rootId, address(vault));
        _dustAdd(1);
        _operatorRearmFails(previous);
    }

    function testNoOperatorRearmAfterExitAll() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _dustAdd(1);
        _execute(_plan());
        vm.prank(OWNER);
        vault.exitAll();
        _dustAdd(1);
        _operatorRearmFails(previous);
    }

    function testNoOperatorRearmAfterAnExit() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _dustAdd(1);
        _execute(_plan());
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        vm.prank(EXIT_MODULE);
        vault.executeExit(rootId, _exitInstruction(0, 0));
        _dustAdd(uint128(ROOT_LIQUIDITY) + 10);
        _operatorRearmFails(previous);
    }

    function testNoOperatorRearmAfterTheRootWasRecovered() public {
        _simple();
        IDominoVaultLedger.RootCheckpoint memory previous = _checkpointNow();
        _dustAdd(1);
        _execute(_plan());
        _transferNft(OWNER, address(vault), rootId);
        vm.prank(OWNER);
        vault.recoverPosition(rootId);
        _approveNft(OWNER, rootId, address(vault));
        _operatorRearmFails(previous);
    }

    // ========================================================= re-verification

    function testOwnerDecreaseDisarmsOnTheNextExecution() public {
        _simple();
        _ownerChangesRoot();
        _accrue(rootId, 1000, 1000);
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(5, 2);
        bytes32 planHash = _execute(_plan());
        _true(planHash == bytes32(0), "nothing executed");
        (,,,,,,,,,, uint128 owed0,) = npm.positions(rootId);
        _eq(owed0, 1, "the owner's principal untouched");
        _eq(npm.pending0(rootId), 1000, "fees not collected");
        _eq(token0.balanceOf(RECIPIENT), 0, "no tariff");
    }

    function testOwnerCollectDisarms() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        vm.prank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, 10, 10));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(5, 2);
        _execute(_plan());
    }

    /// Known limit: increaseLiquidity is open on v3, so anyone can add dust
    /// to the root and disarm it; the owner rearms.
    function testThirdPartyIncreaseDisarms() public {
        _simple();
        token0.mint(STRANGER, 1);
        token1.mint(STRANGER, 1);
        vm.startPrank(STRANGER);
        token0.approve(address(npm), 1);
        token1.approve(address(npm), 1);
        npm.increaseLiquidity(MockV3PositionManager.IncreaseLiquidityParams(rootId, 1, 1, 0, 0, block.timestamp));
        vm.stopPrank();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(5, 2);
        _execute(_plan());
        vm.prank(OWNER);
        vault.rearm(true);
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        _true(vault.rootArmed(), "rearmed and running");
    }

    function testApprovalMovedDisarms() public {
        _simple();
        _approveNft(OWNER, rootId, STRANGER);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
    }

    function testTransferDisarms() public {
        _simple();
        _transferNft(OWNER, STRANGER, rootId);
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
    }

    /// Custody is the root's individual approval: an operator approval for
    /// all the owner's tokens does not arm the vault.
    function testArmingNeedsTheIndividualApproval() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(OWNER);
        npm.setApprovalForAll(factory.predictVault(OWNER, 0), true);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        factory.createVault(init, 0);
    }

    /// A root sold to someone who then approves the vault is still not the
    /// owner's: the vault never collects another holder's fees.
    function testARootApprovedAgainByANewHolderIsNotTheVaults() public {
        _simple();
        _transferNft(OWNER, STRANGER, rootId);
        _approveNft(STRANGER, rootId, address(vault));
        _accrue(rootId, 1000, 1000);
        _true(!vault.rootArmed(), "live view");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
        _eq(npm.pending0(rootId), 1000, "the new holder's fees untouched");
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.rearm(true);
    }

    function testBurnedRootDisarmsAndTheViewDoesNotRevert() public {
        _simple();
        vm.startPrank(OWNER);
        npm.decreaseLiquidity(
            MockV3PositionManager.DecreaseLiquidityParams(rootId, ROOT_LIQUIDITY, 0, 0, block.timestamp)
        );
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, type(uint128).max, type(uint128).max));
        npm.burn(rootId);
        vm.stopPrank();
        _true(!vault.rootArmed(), "burned");
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(4, 2);
        _execute(_plan());
    }

    /// The vault's own increase can leave fees in tokensOwed (poked by v3);
    /// the owner collecting just those changes only tokensOwed, and is seen.
    function testOwnerCollectingOnlyWhatIsOwedDisarms() public {
        _simple();
        _accrue(rootId, 2000, 0);
        token0.mint(address(npm), 7);
        token1.mint(address(npm), 7);
        config.set(8, 0);
        config.setHook(address(npm), abi.encodeCall(npm.accrue, (rootId, 7, 7)));
        _execute(_withSwap(_plan(), rootId, true, 970, 957));
        config.set(0, 0);
        vm.prank(OWNER);
        npm.collect(MockV3PositionManager.CollectParams(rootId, OWNER, 7, 7));
        vm.warp(block.timestamp + 60);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(5, 3);
        _execute(_plan());
    }

    function testUntouchedRootStaysArmedAcrossExecutions() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
        _accrue(rootId, 500, 500);
        vm.warp(block.timestamp + 60);
        uint128 before = _liquidityOf(rootId);
        _execute(_plan());
        _true(_liquidityOf(rootId) > before, "second compound");
        _true(vault.rootArmed(), "armed");
    }

    function testRearmTakesANewCheckpoint() public {
        _simple();
        _ownerChangesRoot();
        _execute(_plan());
        vm.prank(OWNER);
        vault.rearm(true);
        _eq(token0.balanceOf(OWNER), 1, "the owner's decreased principal went home at rearm");
        _accrue(rootId, 1000, 1000);
        uint128 before = _liquidityOf(rootId);
        _execute(_plan());
        _eq(_liquidityOf(rootId) - before, 980, "compounds again");
    }

    /// Fees accrued before creation were consented to: they are automation fees.
    function testFeesAccruedBeforeCreationAreAutomationFees() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _accrue(rootId, 1000, 1000);
        vault = _createVaultFor(rootId, 1, 1);
        _execute(_plan());
        _eq(token0.balanceOf(RECIPIENT), 19, "charged once consumed");
    }
}
