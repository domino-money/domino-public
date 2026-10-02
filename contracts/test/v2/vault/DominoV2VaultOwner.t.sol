// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault} from "../../../src/v2/interfaces/IDominoVault.sol";
import {IDominoVaultLedger} from "../../../src/v2/interfaces/IDominoVaultLedger.sol";
import {DominoActionLock} from "../../../src/v2/route/DominoActionLock.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultHarness, VaultVm, HarnessV3} from "./VaultHarness.sol";

/// The owner surface: creation, policy and limits, pause, resume and rearm,
/// withdrawals, recovery, exitAll and the exit-module switch. None of these
/// depends on the operator, the anchor or the executor, and all but arming
/// (DominoV2VaultCustody.t.sol) is the same code on both DEXes: exact amounts
/// on the v3 unit model.
abstract contract OwnerSuite is VaultHarness {
    // ======================================================= initialization

    function testCreationRecordsTheSequence() public {
        registry.setRank(address(token1), 1);
        IDominoVault.Init memory init = _init(_mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY), 1, 1);
        rootId = init.root.tokenId;
        address predicted = factory.predictVault(OWNER, 0);
        _approveNft(OWNER, rootId, predicted);
        vm.expectEmit(true, true, true, true, predicted);
        emit IDominoVault.Initialized(OWNER, _dex(), rootId, DominoV2Types.MODE_SIMPLE);
        vm.expectEmit(true, true, true, true, predicted);
        emit IDominoVault.PolicyChanged(init.policy, 1);
        vm.expectEmit(true, true, true, true, predicted);
        emit IDominoVault.LimitsChanged(init.limits, 1);
        vm.expectEmit(true, true, true, true, predicted);
        emit IDominoVault.RootRearmed(1);
        vm.prank(OWNER);
        vault = DominoV2VaultBase(payable(factory.createVault(init, 0)));
        _true(address(vault) == predicted, "predicted address");
        _true(vault.owner() == OWNER, "owner");
        _true(vault.factory() == address(factory), "factory");
        _true(vault.registry() == address(registry), "registry");
        DominoV2Types.PoolRef memory pool = vault.pool();
        _eq(pool.dex, _dex(), "dex");
        _true(pool.currency1 == address(token1), "currency1");
        _eq(pool.fee, poolFee, "fee");
        _eq(uint256(int256(pool.tickSpacing)), 60, "spacing");
        DominoV2Types.PositionRef memory root = vault.root();
        _true(root.positionManager == manager && root.tokenId == rootId && root.dex == _dex(), "root");
        uint256[] memory members = vault.positions();
        _true(members.length == 1 && members[0] == rootId, "members");
        _true(vault.rootArmed() && !vault.paused(), "armed and running");
        _eq(vault.stateNonce(), 1, "nonce");
        _true(vault.exitModule() == address(0), "no exit module");
        _true(vault.quoteCurrency() == address(token1), "quote");
        IDominoVaultLedger.Member memory root_ = vault.member(rootId);
        _true(root_.active && root_.tickLower == LOWER && root_.tickUpper == UPPER, "root member");
        IDominoVault.Policy memory policy = vault.policy();
        _true(policy.mode == 1 && policy.maxPositions == 1 && policy.minimumIntervalSeconds == 60, "policy");
        IDominoVault.Limits memory limits = vault.limits();
        _true(limits.maxSlippageBps == 100 && limits.upsideBps == 5000, "limits");
        DominoV2VaultStorage.Deployment memory wiring = vault.wiring();
        _true(wiring.swapModule == swapModule && wiring.autoExit == EXIT_MODULE, "wiring");
        _true(vault.executor() != address(0) && vault.executor().code.length != 0, "executor");
    }

    function testQuoteIsTheBestRankedChargeCurrency() public {
        registry.setRank(address(token0), 2);
        _simple();
        _true(vault.quoteCurrency() == address(token0), "only token0 ranked");
        registry.setRank(address(token1), 1);
        _createVaultFor(_mintPosition(OWNER, LOWER, UPPER, 1), 1, 1);
        DominoV2VaultBase second = DominoV2VaultBase(payable(factory.predictVault(OWNER, 1)));
        _true(second.quoteCurrency() == address(token1), "rank 1 beats rank 2");
        registry.setRank(address(token1), 3);
        DominoV2VaultBase third = _createVaultFor(_mintPosition(OWNER, LOWER, UPPER, 1), 1, 1);
        _true(third.quoteCurrency() == address(token0), "rank 2 beats rank 3");
        registry.setRank(address(token0), 0);
        registry.setRank(address(token1), 0);
        DominoV2VaultBase fourth = _createVaultFor(_mintPosition(OWNER, LOWER, UPPER, 1), 1, 1);
        _true(fourth.quoteCurrency() == address(token1), "unranked: currency1");
    }

    function testCreationRequiresConsentAndAMatchingRoot() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(OWNER, rootId, factory.predictVault(OWNER, 0));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        init.consentToUncollectedFees = false;
        _createFails(init, DominoV2VaultStorage.InvalidInit.selector);
        init = _init(rootId, 1, 1);
        init.root.dex = _dex() == 3 ? 4 : 3;
        _createFails(init, DominoV2VaultStorage.InvalidInit.selector);
        init = _init(rootId, 1, 1);
        init.root.positionManager = STRANGER;
        _createFails(init, DominoV2VaultStorage.InvalidInit.selector);
        init = _init(0, 1, 1);
        _createFails(init, DominoV2VaultStorage.InvalidInit.selector);
        init = _init(uint256(type(uint96).max) + 1, 1, 1);
        _createFails(init, DominoV2VaultStorage.InvalidInit.selector);
    }

    function testCreationRequiresTheRootAndItsApproval() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _createFails(_init(rootId, 1, 1), IDominoVault.AutomationUnavailable.selector);
        uint256 foreign = _mintPosition(STRANGER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(STRANGER, foreign, factory.predictVault(OWNER, 0));
        _createFails(_init(foreign, 1, 1), IDominoVault.AutomationUnavailable.selector);
    }

    function testCreationValidatesPolicyAndLimits() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(OWNER, rootId, factory.predictVault(OWNER, 0));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        init.policy.mode = 0;
        _createFails(init, IDominoVault.InvalidPolicy.selector);
        init = _init(rootId, 1, 1);
        init.limits.upsideBps = 0;
        _createFails(init, IDominoVault.InvalidLimits.selector);
        init = _init(rootId, 1, 1);
        init.startPaused = true;
        vm.prank(OWNER);
        vault = DominoV2VaultBase(payable(factory.createVault(init, 0)));
        _true(vault.paused(), "created paused");
    }

    function testOnlyTheFactoryInitializesOnce() public {
        _simple();
        vm.prank(address(factory));
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.initialize(OWNER, _init(rootId, 1, 1));
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        DominoV2VaultBase(payable(implementation)).initialize(OWNER, _init(rootId, 1, 1));
    }

    /// Anyone can put an EIP-1167 clone of the implementation on chain; only
    /// the factory can make one a vault.
    function testOnlyTheFactoryInitializesAClone() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        bytes memory code = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
        address clone;
        assembly {
            clone := create(0, add(code, 32), mload(code))
        }
        _approveNft(OWNER, rootId, clone);
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        DominoV2VaultBase(payable(clone)).initialize(OWNER, init);
    }

    // ===================================================== policy, limits

    function testPolicyRules() public {
        _domino(3);
        IDominoVault.Policy memory next = _policy(DominoV2Types.MODE_DOMINO, 3);
        next.mode = 3;
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_SIMPLE, 2);
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_DOMINO, 3);
        next.triggerDistanceBps = 2001;
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_DOMINO, 3);
        next.maxOverlapBps = 2001;
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_DOMINO, 3);
        next.minimumIntervalSeconds = 0;
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_DOMINO, 0);
        _policyFails(next);
        next = _policy(DominoV2Types.MODE_DOMINO, 3);
        next.triggerDistanceBps = 2000;
        next.maxOverlapBps = 2000;
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.PolicyChanged(next, 2);
        vm.prank(OWNER);
        vault.setPolicy(next);
        _eq(vault.policy().triggerDistanceBps, 2000, "stored");
        // Simple mode is the root alone, at 2%.
        vm.prank(OWNER);
        vault.setPolicy(_policy(DominoV2Types.MODE_SIMPLE, 1));
        _eq(vault.policy().mode, DominoV2Types.MODE_SIMPLE, "downgraded");
    }

    function testOnlyTheOwnerSetsPolicyAndLimits() public {
        _simple();
        IDominoVault.Policy memory policy = _policy(DominoV2Types.MODE_SIMPLE, 1);
        IDominoVault.Limits memory limits = _limits();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.setPolicy(policy);
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.setLimits(limits);
    }

    function testLimitRules() public {
        _simple();
        IDominoVault.Limits memory next = _limits();
        next.maxSlippageBps = 10_000;
        _limitsFail(next);
        next = _limits();
        next.maxPriceImpactBps = 10_000;
        _limitsFail(next);
        next = _limits();
        next.maxObservationAgeSeconds = 0;
        _limitsFail(next);
        next = _limits();
        next.upsideBps = 0;
        _limitsFail(next);
        next = _limits();
        next.upsideBps = 1_000_001;
        _limitsFail(next);
        next = IDominoVault.Limits(9_999, 9_999, 1, 1_000_000);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.LimitsChanged(next, 2);
        vm.prank(OWNER);
        vault.setLimits(next);
        _eq(vault.limits().upsideBps, 1_000_000, "stored");
    }

    // ===================================================== pause and resume

    function testOwnerOrOperatorPausesOnlyTheOwnerResumes() public {
        _simple();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.pause();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.AutomationPaused(OPERATOR, 2);
        vm.prank(OPERATOR);
        vault.pause();
        vm.prank(OWNER);
        vault.pause();
        _eq(vault.stateNonce(), 2, "a second pause changes nothing");
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.resume();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.AutomationResumed(3);
        vm.prank(OWNER);
        vault.resume();
        vm.prank(OWNER);
        vault.resume();
        _eq(vault.stateNonce(), 3, "a second resume changes nothing");
        _true(!vault.paused(), "running");
    }

    /// A pause by the operator never makes the owner's own policy change fail (A9).
    function testPauseDoesNotRaceThePolicy() public {
        _simple();
        vm.prank(OPERATOR);
        vault.pause();
        vm.prank(OWNER);
        vault.setPolicy(_policy(DominoV2Types.MODE_SIMPLE, 1));
        _true(vault.paused(), "still paused");
    }

    // ================================================================ rearm

    function testRearmRequiresConsentAndCustody() public {
        _simple();
        _approveNft(OWNER, rootId, STRANGER);
        _execute(_plan());
        _true(!vault.rootArmed(), "disarmed");
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.rearm(true);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InvalidInit.selector);
        vault.rearm(false);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.AutomationUnavailable.selector);
        vault.rearm(true);
        _approveNft(OWNER, rootId, address(vault));
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootRearmed(3);
        vm.prank(OWNER);
        vault.rearm(true);
        _true(vault.rootArmed(), "armed");
        _accrue(rootId, 1000, 1000);
        _execute(_plan());
    }

    // ========================================================== withdrawals

    function testWithdrawReservesWithoutAnyCharge() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        // token0: 501 uncharged left after the add.
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.withdrawReserves(address(token0), 1);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InvalidAmount.selector);
        vault.withdrawReserves(address(token0), 0);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.withdrawReserves(address(token0), 502);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.withdrawReserves(address(0xDEAD), 1);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(address(token0), 501, 3);
        vm.prank(OWNER);
        vault.withdrawReserves(address(token0), 501);
        _eq(token0.balanceOf(OWNER), 501, "paid to the owner");
        _eq(vault.reserves(address(token0)), 0, "nothing left");
        _eq(token0.balanceOf(RECIPIENT), 9, "no tariff on the withdrawal");
    }

    function testWithdrawalSpendsUnchargedBeforeCharged() public {
        _simple();
        _accrue(rootId, 2000, 5);
        // Swap 970 to token1 and add 961: the add spends charged units first,
        // so 9 charged and the 5 uncharged token1 stay.
        Plan.PlanV1 memory p = _withSwap(_plan(), rootId, true, 970, 957);
        p.amount1Max = 961;
        _execute(p);
        (uint128 uncharged1, uint128 charged1) = _lot(rootId, address(token1));
        _eq(uncharged1, 5, "uncharged token1");
        _eq(charged1, 9, "charged token1");
        vm.prank(OWNER);
        vault.withdrawReserves(address(token1), 7);
        (uncharged1, charged1) = _lot(rootId, address(token1));
        _eq(uncharged1, 0, "uncharged spent first");
        _eq(charged1, 7, "then charged");
    }

    function testRecoverOnlyWhatIsNotAccounted() public {
        _simple();
        _accrue(rootId, 1000, 1000);
        token0.setBlocked(RECIPIENT, true);
        _execute(_plan());
        // Held 1 + 19: 1 is the owner's reserve, 19 is owed to Domino.
        token0.mint(address(vault), 7);
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.recoverToken(address(token0), 7);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.recoverToken(address(token0), 8);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.recoverToken(address(token0), 0);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.TokenRecovered(address(token0), 7);
        vm.prank(OWNER);
        vault.recoverToken(address(token0), 7);
        _eq(token0.balanceOf(OWNER), 7, "surplus recovered");
        _eq(vault.owedFees(address(token0)), 19, "owed untouched");
        // A token outside the pair is wholly unaccounted.
        MockERC20Like other = new MockERC20Like();
        other.mint(address(vault), 3);
        vm.prank(OWNER);
        vault.recoverToken(address(other), 3);
        _eq(other.balanceOf(OWNER), 3, "other token");
        // So is native currency sent to the vault.
        vm.deal(address(vault), 5);
        vm.prank(OWNER);
        vault.recoverToken(address(0), 5);
        _eq(OWNER.balance, 5, "native");
    }

    function testUnbackedLedgerRecoversNothing() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        token0.burn(address(vault), 10);
        vm.prank(OWNER);
        vm.expectRevert(DominoV2VaultStorage.InsufficientReserves.selector);
        vault.recoverToken(address(token0), 1);
    }

    function testRecoverPositionReturnsStrayNftsAndTheRoot() public {
        _simple();
        uint256 stray = _mintPosition(STRANGER, LOWER, UPPER, 1);
        _transferNft(STRANGER, address(vault), stray);
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.recoverPosition(stray);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVaultLedger.PositionRecovered(stray);
        vm.prank(OWNER);
        vault.recoverPosition(stray);
        _true(_ownerOfNft(stray) == OWNER, "stray to the owner");
        // The root sent to the vault by mistake comes back, disarmed exactly
        // once: by the v4 unsubscription on the way in, or by the recovery.
        vm.recordLogs();
        _transferNft(OWNER, address(vault), rootId);
        vm.prank(OWNER);
        vault.recoverPosition(rootId);
        _true(_ownerOfNft(rootId) == OWNER, "root back");
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 disarms;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == IDominoVault.RootDisarmed.selector) ++disarms;
        }
        _eq(disarms, 1, "disarmed once");
    }

    // ============================================================= exitAll

    function testExitAllReturnsEverythingAndStops() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.exitAll();
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ReservesWithdrawn(address(token0), 501, 3);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.RootDisarmed(7, 3);
        vm.prank(OWNER);
        vault.exitAll();
        _eq(token0.balanceOf(OWNER), 501, "reserve0 paid");
        _eq(token1.balanceOf(OWNER), 1, "reserve1 paid");
        _eq(vault.reserves(address(token0)), 0, "empty");
        _true(vault.paused() && !vault.rootArmed(), "stopped");
        _true(_ownerOfNft(rootId) == OWNER, "root untouched in the wallet");
    }

    function testExitAllKeepsAReserveTheOwnerCannotReceive() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        token0.setBlocked(OWNER, true);
        vm.prank(OWNER);
        vault.exitAll();
        _eq(vault.idleReserves(address(token0)), 501, "kept idle");
        _eq(token1.balanceOf(OWNER), 1, "the other paid");
        token0.setBlocked(OWNER, false);
        vm.prank(OWNER);
        vault.withdrawReserves(address(token0), 501);
        _eq(token0.balanceOf(OWNER), 501, "withdrawn later");
    }

    // ========================================================= exit module

    function testOnlyTheDeployedExitModuleCanBeEnabled() public {
        _simple();
        vm.prank(STRANGER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.setExitModule(EXIT_MODULE);
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        vault.setExitModule(STRANGER);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IDominoVault.ExitModuleSet(EXIT_MODULE, 2);
        vm.prank(OWNER);
        vault.setExitModule(EXIT_MODULE);
        _true(vault.exitModule() == EXIT_MODULE, "enabled");
        vm.prank(OWNER);
        vault.setExitModule(address(0));
        _true(vault.exitModule() == address(0), "disabled");
    }

    // ========================================================== reentrancy

    function testOwnerFlowsAreNotReentrant() public {
        _simple();
        _accrue(rootId, 1000, 500);
        _execute(_plan());
        token0.setHook(OWNER, address(vault), abi.encodeCall(vault.flushOwedFees, (address(token0))));
        vm.prank(OWNER);
        vault.withdrawReserves(address(token0), 1);
        _true(
            keccak256(token0.hookResult()) == keccak256(abi.encodeWithSelector(DominoActionLock.ReentrantCall.selector)),
            "the reentrant call was refused"
        );
    }

    function _createFails(IDominoVault.Init memory init, bytes4 selector) internal {
        vm.prank(OWNER);
        vm.expectRevert(selector);
        factory.createVault(init, 0);
    }

    function _policyFails(IDominoVault.Policy memory next) internal {
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.InvalidPolicy.selector);
        vault.setPolicy(next);
    }

    function _limitsFail(IDominoVault.Limits memory next) internal {
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.InvalidLimits.selector);
        vault.setLimits(next);
    }
}

contract MockERC20Like {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract DominoV2VaultOwnerV3Test is OwnerSuite, HarnessV3 {
    /// What the v3 manager already owes the root at arming may be principal
    /// from an owner's decrease: it goes to the owner, never into automation,
    /// and the collect (F1c's, which takes everything) brings the fees
    /// accrued so far with it.
    function testArmingPaysWhatWasAlreadyOwedToTheOwner() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        token0.mint(address(npm), 40);
        token1.mint(address(npm), 30);
        npm.setOwed(rootId, 40, 30);
        _accrue(rootId, 5, 6);
        vault = _createVaultFor(rootId, 1, 1);
        _eq(token0.balanceOf(OWNER), 45, "owed0 and the fees to the owner");
        _eq(token1.balanceOf(OWNER), 36, "owed1 and the fees to the owner");
        (,,,,,,,,,, uint128 owed0, uint128 owed1) = npm.positions(rootId);
        _eq(owed0 + owed1 + npm.pending0(rootId) + npm.pending1(rootId), 0, "nothing left behind");
        _true(vault.rootArmed(), "armed on the new checkpoint");
    }

    /// Without anything owed, the fees accrued before arming were consented
    /// to: they stay with the root and become automation fees.
    function testArmingLeavesAccruedFeesWhenNothingIsOwed() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _accrue(rootId, 5, 6);
        vault = _createVaultFor(rootId, 1, 1);
        _eq(token0.balanceOf(OWNER) + token1.balanceOf(OWNER), 0, "nothing paid out");
        _eq(npm.pending0(rootId) + npm.pending1(rootId), 11, "the fees stay with the root");
    }
}
