// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVault} from "../src/DominoVault.sol";
import {DominoVaultTypes as T, IERC721ReceiverE2} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20, E2OwnerReceiver,
    E2ForeignSubscriber} from "./E2Mocks.sol";

interface VmE2CodeEtch {
    function etch(address target, bytes calldata runtime) external;
}

/// @dev Artificial credit sinks and terminal-state injection exist ONLY here.
contract VaultE2TestHarness is DominoVault {
    constructor(address factory_, address pool_, address positions_, address state_, address recipient_)
        DominoVault(factory_, pool_, positions_, state_, recipient_) {}
    function creditOriginal(uint256 id, uint128 amount0, uint128 amount1) external {
        _creditOriginalFees(id, amount0, amount1);
    }
    function creditConverted(bytes32 sourceId, address currency, uint128 amount) external {
        _creditConvertedFees(sourceId, currency, amount);
    }
    function forceNonce(uint64 nonce) external { stateNonce = nonce; }
    function forceGeneration(uint64 generation) external { authorityGeneration = generation; }
}

contract DominoVaultCustodyTest is IERC721ReceiverE2 {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0xB0B);
    address private constant STRANGER = address(0xBAD);
    address private constant RECIPIENT = address(0xFEE);
    MockPoolManager private poolManager;
    MockPositionManager private positions;
    MockStateView private stateView;
    MockERC20 private token;
    MockERC20 private secondToken;
    T.PoolKey private key;
    VaultE2TestHarness private vault;
    address private owner;

    receive() external payable {}
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721ReceiverE2.onERC721Received.selector;
    }

    function setUp() public { _setup(address(this), true); }

    function _setup(address owner_, bool nativePair) private {
        vm.chainId(4663);
        owner = owner_;
        poolManager = new MockPoolManager();
        positions = new MockPositionManager(address(poolManager));
        stateView = new MockStateView(address(poolManager), positions);
        token = new MockERC20();
        secondToken = new MockERC20();
        address a = nativePair ? address(0) : address(secondToken);
        address b = address(token);
        if (a > b) (a, b) = (b, a);
        key = T.PoolKey(a, b, 3000, 60, address(0));
        positions.mint(owner, 11, key, -600, 600, 1000);
        VaultE2TestHarness implementation_ = new VaultE2TestHarness(address(this), address(poolManager),
            address(positions), address(stateView), RECIPIENT);
        bytes memory creation = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
            address(implementation_), hex"5af43d82803e903d91602b57fd5bf3");
        address clone;
        assembly ("memory-safe") { clone := create(0, add(creation, 32), mload(creation)) }
        require(clone != address(0), "clone deployment failed");
        vault = VaultE2TestHarness(payable(clone));
        vm.prank(owner);
        positions.approve(clone, 11);
        T.InitParams memory params = T.InitParams({
            rootTokenId: 11, expectedPoolId: keccak256(abi.encode(key)), baseCurrency: key.currency0,
            quoteCurrency: key.currency1, operator: OPERATOR, consentToUncollectedFees: true,
            policy: IDominoVaultDraft.Policy(200, 500, 1000, 60, 4, 1, false),
            limits: T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600)
        });
        vault.initialize(owner, keccak256("synthetic sequence"), params);
    }

    function _fund(address currency, uint256 amount) private {
        if (currency == address(0)) vm.deal(address(vault), address(vault).balance + amount);
        else MockERC20(currency).mint(address(vault), amount);
    }

    function _credit(uint256 id, uint128 amount0, uint128 amount1) private {
        _fund(key.currency0, amount0);
        _fund(key.currency1, amount1);
        vault.creditOriginal(id, amount0, amount1);
    }

    function _adopt(uint256 id, uint256 parent) private {
        positions.mint(owner, id, key, -300, 900, 500);
        vm.prank(owner);
        positions.approve(address(vault), id);
        vm.prank(owner);
        vault.adoptChild(id, parent, true);
    }

    function _balance(address currency, address account) private view returns (uint256) {
        return currency == address(0) ? account.balance : MockERC20(currency).balanceOf(account);
    }

    function _withdraw(uint256 id, address currency, uint128 original, uint128 charged) private {
        T.Position memory p = vault.position(id);
        bytes32 sourceId = currency == key.currency0 ? p.source0 : p.source1;
        vm.prank(owner);
        vault.withdrawFeeReserves(sourceId, currency, original, charged);
    }

    function testInitializedRootStaysWithOwnerAndCheckpointDoesNotCreditFees() public view {
        require(vault.owner() == owner && vault.factory() == address(this), "wrong fixed identity");
        require(positions.ownerOf(11) == owner, "root custody moved");
        require(vault.rootArmed() && vault.rootPermissionValid(), "root not armed");
        require(positions.subscriber(11) == address(vault), "root not subscribed");
        T.Position memory p = vault.position(11);
        require(p.known && p.active && p.isRoot && p.parentTokenId == 0, "root membership");
        require(p.source0 != bytes32(0) && p.source1 != bytes32(0) && p.source0 != p.source1, "source identity");
        T.Checkpoint memory cp = vault.checkpoint(11);
        require(cp.liquidity == 1000 && cp.commitment != bytes32(0), "checkpoint missing");
        require(vault.accountedCurrency(key.currency0) == 0 && vault.accountedCurrency(key.currency1) == 0,
            "registration fabricated reserves");
    }

    function testOnlyOwnerCanChangePolicyLimitsOperatorAndWithdraw() public {
        _credit(11, 100, 200);
        IDominoVaultDraft.Policy memory next = vault.policy(); next.version++;
        T.ExecutionLimits memory limits = vault.executionLimits(); limits.version++;
        bytes32 sourceId = vault.position(11).source0;
        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeCall(vault.setPolicy, (next));
        calls[1] = abi.encodeCall(vault.setExecutionLimits, (limits));
        calls[2] = abi.encodeCall(vault.setOperator, (STRANGER));
        calls[3] = abi.encodeCall(vault.revokeOperator, ());
        calls[4] = abi.encodeCall(vault.withdrawFeeReserves, (sourceId, key.currency0, 1, 0));
        calls[5] = abi.encodeCall(vault.recoverUntrackedCurrency, (key.currency0, 1));
        calls[6] = abi.encodeCall(vault.rearmRoot, (true));
        calls[7] = abi.encodeCall(vault.recoverUnmanagedPosition, (11));
        uint64 nonce = vault.stateNonce();
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(OPERATOR); (bool ok,) = address(vault).call(calls[i]); require(!ok, "operator gained owner power");
            vm.prank(STRANGER); (ok,) = address(vault).call(calls[i]); require(!ok, "stranger gained owner power");
        }
        require(vault.stateNonce() == nonce && vault.accountedCurrency(key.currency0) == 100, "failed calls mutated");
    }

    function testPolicyAndLimitsRemainIndependentAndInvalidateOldAuthority() public {
        uint64 oldNonce = vault.stateNonce();
        uint64 generation = vault.authorityGeneration();
        IDominoVaultDraft.Policy memory next = vault.policy();
        next.version++; next.triggerDistanceBps = 100; next.maxOverlapBps = 1700;
        vault.setPolicy(next);
        IDominoVaultDraft.Policy memory stored = vault.policy();
        require(stored.triggerDistanceBps == 100 && stored.maxOverlapBps == 1700, "geometry coupled");
        vm.expectRevert(); vault.validateAuthority(1, oldNonce, generation);
        T.ExecutionLimits memory limits = vault.executionLimits(); limits.version++; limits.upsideBps = 4000;
        vault.setExecutionLimits(limits);
        require(vault.executionLimits().upsideBps == 4000, "limits unchanged");
    }

    function testOperatorMayPauseButOnlyOwnerMayResumeAndRevocationStopsOperator() public {
        vm.prank(OPERATOR); vault.pause();
        require(vault.policy().paused, "operator pause failed");
        vm.prank(OPERATOR); vm.expectRevert(); vault.resume();
        vault.resume();
        require(!vault.policy().paused, "owner resume failed");
        vault.revokeOperator();
        require(!vault.isOperator(OPERATOR), "operator still authorized");
        vm.prank(OPERATOR); vm.expectRevert(); vault.pause();
    }

    function testWithdrawNativeAndERC20ReservesPaysOnlyOwnerWithNoFee() public {
        _credit(11, 100, 200);
        uint256 nativeBefore = owner.balance;
        uint256 tokenBefore = _balance(key.currency1, owner);
        uint256 serviceBefore = RECIPIENT.balance;
        _withdraw(11, key.currency0, 70, 0);
        _withdraw(11, key.currency1, 90, 0);
        require(owner.balance == nativeBefore + 70 && _balance(key.currency1, owner) == tokenBefore + 90, "owner payout");
        require(RECIPIENT.balance == serviceBefore && _balance(key.currency1, RECIPIENT) == 0, "exit toll");
        require(vault.accountedCurrency(key.currency0) == 30 && vault.accountedCurrency(key.currency1) == 110, "reserve debit");
    }

    function testBothERC20CurrenciesWithdrawUsingCanonicalOrder() public {
        _setup(address(this), false);
        _credit(11, 21, 34);
        _withdraw(11, key.currency0, 21, 0);
        _withdraw(11, key.currency1, 34, 0);
        require(_balance(key.currency0, owner) == 21 && _balance(key.currency1, owner) == 34, "ERC20 pair payout");
    }

    function testDonationsAreUntrackedAndRecoveryCannotTouchReservedFees() public {
        _credit(11, 100, 200);
        _fund(key.currency0, 17); _fund(key.currency1, 29);
        require(vault.accountedCurrency(key.currency0) == 100 && vault.accountedCurrency(key.currency1) == 200,
            "donation became earned fee");
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(); vault.recoverUntrackedCurrency(key.currency0, 18);
        require(vault.stateNonce() == nonce, "failed recovery changed nonce");
        vault.recoverUntrackedCurrency(key.currency0, 17);
        vault.recoverUntrackedCurrency(key.currency1, 29);
        require(_balance(key.currency0, address(vault)) == 100 && _balance(key.currency1, address(vault)) == 200,
            "recovery spent accounted fees");
        _withdraw(11, key.currency0, 100, 0); _withdraw(11, key.currency1, 200, 0);
    }

    function testERC20PairCanRecoverNativeDonationWithoutTouchingTrackedTokens() public {
        _setup(address(this), false); _credit(11, 21, 34);
        vm.deal(address(vault), 17);
        uint256 ownerBefore = owner.balance;
        vm.prank(STRANGER); vm.expectRevert(); vault.recoverUntrackedCurrency(address(0), 17);
        vault.recoverUntrackedCurrency(address(0), 17);
        require(owner.balance == ownerBefore + 17 && address(vault).balance == 0, "native surplus stranded");
        require(vault.accountedCurrency(key.currency0) == 21 && vault.accountedCurrency(key.currency1) == 34,
            "native rescue altered token fee accounting");
        MockERC20 unrelated = new MockERC20(); unrelated.mint(address(vault), 5);
        vm.expectRevert(); vault.recoverUntrackedCurrency(address(unrelated), 5);
    }

    function testArtificialCreditSinksRequireRealBalanceBackingAndPreserveChargeClass() public {
        bytes32 sourceId = vault.position(11).source0;
        vm.expectRevert(); vault.creditOriginal(11, 1, 0);
        vm.expectRevert(); vault.creditConverted(sourceId, key.currency1, 1);
        require(vault.accountedCurrency(key.currency0) == 0, "unbacked credit retained");
        _credit(11, 50, 0);
        _fund(key.currency1, 80); vault.creditConverted(sourceId, key.currency1, 80);
        T.FeeBalance memory converted = vault.feeBalance(sourceId, key.currency1);
        require(converted.original == 0 && converted.charged == 80, "converted fee reclassified");
        vm.expectRevert(); vault.withdrawFeeReserves(sourceId, key.currency1, 1, 0);
        vault.withdrawFeeReserves(sourceId, key.currency1, 0, 80);
        require(_balance(key.currency1, owner) == 80, "charged output taxed again");
    }

    function testWrongCurrencyAndUnknownSourceCannotWithdrawAnotherBalance() public {
        _credit(11, 100, 200);
        bytes32 source0 = vault.position(11).source0;
        bytes32 source1 = vault.position(11).source1;
        vm.expectRevert(); vault.withdrawFeeReserves(keccak256("unknown source"), key.currency0, 1, 0);
        vm.expectRevert(); vault.withdrawFeeReserves(source0, key.currency1, 1, 0);
        vm.expectRevert(); vault.withdrawFeeReserves(source1, key.currency0, 1, 0);
        require(vault.accountedCurrency(key.currency0) == 100 && vault.accountedCurrency(key.currency1) == 200,
            "cross-currency withdrawal mutated");
    }

    function testChildAdoptionUsesActualCustodyAndWithdrawalRetainsSourceReserves() public {
        _adopt(12, 11);
        require(positions.ownerOf(12) == address(vault), "child not custodied");
        T.Position memory child = vault.position(12);
        require(child.known && child.active && !child.isRoot && child.parentTokenId == 11, "child membership");
        _credit(12, 50, 80);
        vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner && !vault.position(12).active, "child exit failed");
        T.Source memory source_ = vault.source(child.source0);
        require(source_.known && source_.tokenId == 12, "historical source deleted");
        vault.withdrawFeeReserves(child.source0, key.currency0, 50, 0);
        vault.withdrawFeeReserves(child.source1, key.currency1, 80, 0);
        require(vault.accountedCurrency(key.currency0) == 0 && vault.accountedCurrency(key.currency1) == 0, "stranded reserve");
        positions.approve(address(vault), 12);
        vm.expectRevert(); vault.adoptChild(12, 11, true);
    }

    function testAdoptionRejectsForeignOwnerParentPoolAndUnconsentedOrUnapprovedNFT() public {
        positions.mint(STRANGER, 12, key, -300, 900, 500);
        vm.prank(STRANGER); positions.approve(address(vault), 12);
        vm.expectRevert(); vault.adoptChild(12, 11, true);
        positions.mint(owner, 13, key, -300, 900, 500);
        vm.expectRevert(); vault.adoptChild(13, 11, true);
        positions.approve(address(vault), 13);
        vm.expectRevert(); vault.adoptChild(13, 11, false);
        vm.expectRevert(); vault.adoptChild(13, 99, true);
        T.PoolKey memory other = key; other.fee = 500;
        positions.mint(owner, 14, other, -300, 900, 500);
        positions.approve(address(vault), 14);
        vm.expectRevert(); vault.adoptChild(14, 11, true);
        require(positions.ownerOf(13) == owner && !vault.position(13).known, "invalid adoption kept effects");
    }

    function testDirectRootOrForeignNFTTransferCannotMasqueradeAsAdoption() public {
        vm.expectRevert(); positions.safeTransferFrom(owner, address(vault), 11);
        positions.mint(owner, 12, key, -300, 900, 500);
        vm.expectRevert(); positions.safeTransferFrom(owner, address(vault), 12);
        require(positions.ownerOf(11) == owner && positions.subscriber(11) == address(vault), "root rollback failed");
        require(positions.ownerOf(12) == owner && !vault.position(12).known, "unsolicited NFT accepted");
    }

    function testUnsafeUnknownNFTCanOnlyBeRecoveredToImmutableOwner() public {
        T.PoolKey memory other = key; other.fee = 500;
        positions.mint(owner, 99, other, -300, 900, 500);
        positions.transferFrom(owner, address(vault), 99);
        uint64 nonce = vault.stateNonce();
        vm.prank(OPERATOR); vm.expectRevert(); vault.recoverUnmanagedPosition(99);
        vm.prank(STRANGER); vm.expectRevert(); vault.recoverUnmanagedPosition(99);
        require(positions.ownerOf(99) == address(vault) && vault.stateNonce() == nonce, "outsider recovered NFT");
        vault.recoverUnmanagedPosition(99);
        require(positions.ownerOf(99) == owner && !vault.position(99).known, "unknown NFT not rescued");
        require(vault.stateNonce() == nonce + 1, "rescue nonce not exact");
    }

    function testUnsafePreviouslyWithdrawnChildRecoveryPreservesHistoricalSources() public {
        _adopt(12, 11); _credit(12, 50, 0);
        bytes32 source0 = vault.position(12).source0;
        vault.withdrawChildPosition(12);
        positions.transferFrom(owner, address(vault), 12);
        vault.recoverUnmanagedPosition(12);
        require(positions.ownerOf(12) == owner && !vault.position(12).active, "withdrawn child rescue changed membership");
        require(vault.position(12).source0 == source0 && vault.feeBalance(source0, key.currency0).original == 50,
            "withdrawn child reserve lost");
        vault.withdrawFeeReserves(source0, key.currency0, 50, 0);
    }

    function testActiveChildCannotBypassManagedExitViaRecovery() public {
        _adopt(12, 11);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(); vault.recoverUnmanagedPosition(12);
        require(positions.ownerOf(12) == address(vault) && vault.position(12).active && vault.stateNonce() == nonce,
            "active child recovery changed state");
        vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner && !vault.position(12).active, "normal child exit blocked");
    }

    function testUnsafeRootRecoveryInvalidatesOnceAndRequiresExplicitRearm() public {
        positions.setSuppressUnsubscribeCallback(true);
        positions.transferFrom(owner, address(vault), 11);
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        T.Position memory old = vault.position(11);
        vault.recoverUnmanagedPosition(11);
        require(positions.ownerOf(11) == owner && !vault.rootArmed() && !vault.rootPermissionValid(), "root rescue kept authority");
        require(vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation + 1, "root rescue nonce doubled");
        T.Position memory current = vault.position(11);
        require(current.identity == old.identity && current.source0 == old.source0 && current.source1 == old.source1,
            "root rescue changed fee provenance");
        vm.expectRevert(); vault.rearmRoot(true);
        positions.approve(address(vault), 11); vault.rearmRoot(true);
        require(vault.rootPermissionValid(), "root cannot be rearmed after rescue");
    }

    function testUnmanagedRescueReceiverRejectionRollsBackAndReentryCannotRescueAnotherNFT() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        positions.mint(owner, 90, key, -300, 900, 500); positions.mint(owner, 91, key, -300, 900, 500);
        vm.startPrank(owner);
        positions.transferFrom(owner, address(vault), 90); positions.transferFrom(owner, address(vault), 91);
        vm.stopPrank();
        uint64 nonce = vault.stateNonce(); receiver.setReject(false, true);
        bytes memory rescue = abi.encodeCall(vault.recoverUnmanagedPosition, (90));
        vm.expectRevert(); receiver.invoke(address(vault), rescue);
        require(positions.ownerOf(90) == address(vault) && vault.stateNonce() == nonce, "rescue callback rollback");
        receiver.setReject(false, false);
        receiver.configureReentry(address(vault), abi.encodeCall(vault.recoverUnmanagedPosition, (91)));
        receiver.invoke(address(vault), rescue);
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded(), "unmanaged rescue reentered");
        require(positions.ownerOf(90) == owner && positions.ownerOf(91) == address(vault), "rescued both NFTs");
    }

    function testCoreLiquidityMismatchRejectsAdoptionBeforeCustody() public {
        positions.mint(owner, 12, key, -300, 900, 500);
        positions.approve(address(vault), 12);
        stateView.setPositionState(12, 499, 3, 4);
        vm.expectRevert(); vault.adoptChild(12, 11, true);
        require(positions.ownerOf(12) == owner && !vault.position(12).known, "bad checkpoint adopted");
    }

    function testPauseAndRootTransferLeaveOwnerExitsAvailable() public {
        _adopt(12, 11); _credit(11, 100, 0); _credit(12, 0, 80);
        vault.pause();
        positions.transferFrom(owner, STRANGER, 11);
        require(!vault.rootPermissionValid(), "old owner still armed");
        _withdraw(11, key.currency0, 100, 0);
        _withdraw(12, key.currency1, 80, 0);
        vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner, "root transfer reassigned child");
        vm.prank(STRANGER); vm.expectRevert(); vault.rearmRoot(true);
    }

    function testRootTransferAwayAndBackRequiresRearmEvenIfCallbackSuppressed() public {
        positions.setSuppressUnsubscribeCallback(true);
        positions.transferFrom(owner, STRANGER, 11);
        vm.prank(STRANGER); positions.transferFrom(STRANGER, owner, 11);
        positions.approve(address(vault), 11);
        require(!vault.rootPermissionValid(), "cleared subscription ignored");
        uint64 policyVersion = vault.policy().version;
        uint64 nonce = vault.stateNonce();
        uint64 authority = vault.authorityGeneration();
        vm.expectRevert(); vault.validateAuthority(policyVersion, nonce, authority);
        bytes32 source0 = vault.position(11).source0;
        uint64 generation = vault.authorityGeneration();
        vault.rearmRoot(true);
        require(vault.rootPermissionValid() && vault.authorityGeneration() > generation, "explicit rearm failed");
        require(vault.position(11).source0 == source0, "rearm reclassified historical fees");
    }

    function testIndividualApprovalIsRequiredEvenWithGlobalApproval() public {
        positions.approve(address(0), 11);
        positions.setApprovalForAll(address(vault), true);
        require(!vault.rootPermissionValid(), "global approval bypass");
        vm.expectRevert(); vault.rearmRoot(true);
        positions.approve(address(vault), 11);
        vault.rearmRoot(true);
        require(vault.rootPermissionValid(), "individual approval not restored");
    }

    function testForeignSubscriberRequiresExplicitUnsubscribeBeforeRearm() public {
        positions.unsubscribe(11);
        E2ForeignSubscriber foreign = new E2ForeignSubscriber();
        positions.subscribe(11, address(foreign), "");
        vm.expectRevert(); vault.rearmRoot(true);
        positions.unsubscribe(11);
        vault.rearmRoot(true);
        require(positions.subscriber(11) == address(vault), "rearm subscribe missing");
    }

    function testOnlyManagerCanNotifyAndUnexpectedSubscriptionCannotArmVault() public {
        vm.expectRevert(); vault.notifyUnsubscribe(11);
        vm.expectRevert(); vault.notifyModifyLiquidity(11, 1, 0);
        vm.expectRevert(); vault.notifyBurn(11, owner, 0, 1000, 0);
        vm.prank(address(positions)); vm.expectRevert(); vault.notifySubscribe(11, "");
        require(vault.rootPermissionValid(), "forged callback affected authority");
    }

    function testExternalModifyCallbackInvalidatesWithoutCreditingReportedFees() public {
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        positions.notifyModify(11, 0, type(int256).max);
        require(!vault.rootArmed() && vault.stateNonce() > nonce && vault.authorityGeneration() > generation,
            "modify failed to invalidate");
        require(vault.accountedCurrency(key.currency0) == 0 && vault.accountedCurrency(key.currency1) == 0,
            "subscriber delta became spendable fees");
    }

    function testRepeatedInvalidationCallbacksDoNotCreateNewAuthorityTransitions() public {
        positions.notifyModify(11, 0, 1);
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        positions.notifyModify(11, 0, type(int256).max);
        positions.unsubscribe(11);
        require(vault.stateNonce() == nonce && vault.authorityGeneration() == generation && !vault.rootArmed(),
            "repeated invalidation advanced authority");
    }

    function testRearmSnapshotsExactCoreStateWithoutReplacingOriginalSourceIdentity() public {
        T.Position memory before_ = vault.position(11);
        T.Checkpoint memory initial = vault.checkpoint(11);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(); vault.rearmRoot(false);
        require(vault.stateNonce() == nonce, "unconsented rearm mutated");
        stateView.setPositionState(11, 1000, 11, 22);
        stateView.setFeeGrowthInside(keccak256(abi.encode(key)), -600, 600, 33, 44);
        vm.roll(block.number + 1);
        vault.rearmRoot(true);
        T.Checkpoint memory current = vault.checkpoint(11);
        require(current.feeGrowthInside0LastX128 == 11 && current.feeGrowthInside1LastX128 == 22 &&
            current.feeGrowthInside0X128 == 33 && current.feeGrowthInside1X128 == 44 &&
            current.observedAtBlock == block.number && current.commitment != initial.commitment,
            "checkpoint mixed or not refreshed");
        T.Position memory after_ = vault.position(11);
        require(after_.identity == before_.identity && after_.registrationBaselineId == before_.registrationBaselineId &&
            after_.source0 == before_.source0 && after_.source1 == before_.source1, "historical source replaced");
        require(vault.accountedCurrency(key.currency0) == 0 && vault.accountedCurrency(key.currency1) == 0,
            "checkpoint difference fabricated fee reserve");
    }

    function testBurnCallbackInvalidatesRootWithoutStrandingAlreadyTrackedReserves() public {
        _credit(11, 100, 0);
        positions.burn(11, type(int256).max);
        require(!vault.rootArmed() && !vault.rootPermissionValid(), "burn retained authority");
        _withdraw(11, key.currency0, 100, 0);
        require(vault.accountedCurrency(key.currency0) == 0, "burn stranded earned fees");
    }

    function testERC20FalseRevertAndTransferFeeRollbackLedgerAndBalances() public {
        _credit(11, 0, 1000);
        bytes32 source1 = vault.position(11).source1;
        uint64 nonce = vault.stateNonce();
        for (uint8 failure; failure < 3; ++failure) {
            MockERC20(key.currency1).configureTransfer(failure == 0 ? 0 : failure, failure == 0 ? 100 : 0);
            vm.expectRevert(); vault.withdrawFeeReserves(source1, key.currency1, 100, 0);
            require(vault.feeBalance(source1, key.currency1).original == 1000 && vault.stateNonce() == nonce,
                "failed token payout changed state");
            require(_balance(key.currency1, address(vault)) == 1000 && _balance(key.currency1, owner) == 0,
                "failed token payout changed token balances");
        }
        MockERC20(key.currency1).configureTransfer(0, 0);
        _withdraw(11, key.currency1, 1000, 0);
    }

    function testERC20ReentryCannotWithdrawSecondSource() public {
        _credit(11, 100, 200);
        bytes32 source0 = vault.position(11).source0;
        MockERC20(key.currency1).configureReentry(address(vault),
            abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 100, 0)), false);
        _withdraw(11, key.currency1, 200, 0);
        require(MockERC20(key.currency1).reentryAttempted() && !MockERC20(key.currency1).reentrySucceeded(), "token reentry");
        require(vault.feeBalance(source0, key.currency0).original == 100, "token stole second source");
    }

    function testOwnerNativeReceiverReentryFailsWhileOuterExitSucceeds() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        bytes memory exit = abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 50, 0));
        receiver.configureReentry(address(vault), exit);
        receiver.invoke(address(vault), exit);
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded(), "owner receiver reentered");
        require(address(receiver).balance == 50 && vault.feeBalance(source0, key.currency0).original == 50, "double native exit");
    }

    function testRejectingNativeAndNFTReceiverRollsBackActualExits() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _adopt(12, 11); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); receiver.setReject(true, true);
        vm.expectRevert(); receiver.invoke(address(vault),
            abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 100, 0)));
        vm.expectRevert(); receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(vault.stateNonce() == nonce && vault.feeBalance(source0, key.currency0).original == 100, "receiver rollback");
        require(positions.ownerOf(12) == address(vault) && vault.position(12).active, "NFT receiver rollback");
        receiver.setReject(false, false);
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
    }

    function testOwnerNFTReceiverCannotReenterAnotherChildExit() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _adopt(12, 11); _adopt(13, 11);
        receiver.configureReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (13)));
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded(), "NFT receiver reentered");
        require(positions.ownerOf(12) == owner && positions.ownerOf(13) == address(vault), "second child stolen");
    }

    function testTerminalNonceRejectsNewAuthorityButOwnerRecoveryRemainsAvailable() public {
        _adopt(12, 11); _credit(11, 100, 0);
        vault.forceNonce(type(uint64).max);
        uint64 policyVersion = vault.policy().version;
        uint64 generation = vault.authorityGeneration();
        vm.expectRevert(); vault.validateAuthority(policyVersion, type(uint64).max, generation);
        vm.expectRevert(); vault.rearmRoot(true);
        _withdraw(11, key.currency0, 100, 0);
        vault.withdrawChildPosition(12);
        require(vault.stateNonce() == type(uint64).max && positions.ownerOf(12) == owner, "terminal recovery wrapped/failed");
    }

    function testUnavailableStateViewBlocksAuthorityButNotNativeERC20AndChildRecovery() public {
        _adopt(12, 11); _credit(11, 100, 200);
        uint64 policyVersion = vault.policy().version;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        uint256 nativeBefore = owner.balance; uint256 tokenBefore = _balance(key.currency1, owner);
        // Test-only runtime replacement: every oracle call now reverts, while
        // the PositionManager and PoolManager continue serving actual custody.
        VmE2CodeEtch(address(vm)).etch(address(stateView), hex"60006000fd");
        (bool oracleAvailable,) = address(stateView).staticcall(abi.encodeWithSignature("poolManager()"));
        require(!oracleAvailable && !vault.rootPermissionValid(), "disabled oracle did not block authority");
        vm.expectRevert(DominoVault.PermissionUnavailable.selector);
        vault.validateAuthority(policyVersion, nonce, generation);
        _withdraw(11, key.currency0, 100, 0);
        _withdraw(11, key.currency1, 200, 0);
        vault.withdrawChildPosition(12);
        require(owner.balance == nativeBefore + 100 && _balance(key.currency1, owner) == tokenBefore + 200,
            "oracle outage blocked fee payout");
        require(positions.ownerOf(12) == owner && !vault.position(12).active, "oracle outage blocked NFT recovery");
        require(vault.stateNonce() == nonce + 3 && vault.accountedCurrency(key.currency0) == 0 &&
            vault.accountedCurrency(key.currency1) == 0, "recovery transition count or reserves wrong");
    }

    function testTerminalAuthorityGenerationBlocksNewAuthorityButPermitsRevocationAndOwnerExits() public {
        _adopt(12, 11); _credit(11, 100, 0); vault.pause();
        vault.forceGeneration(type(uint64).max);
        uint64 nonce = vault.stateNonce(); uint64 version = vault.policy().version;
        vm.expectRevert(DominoVault.NonceExhausted.selector);
        vault.validateAuthority(version, nonce, type(uint64).max);
        vm.expectRevert(DominoVault.NonceExhausted.selector); vault.setOperator(STRANGER);
        vm.expectRevert(DominoVault.NonceExhausted.selector); vault.rearmRoot(true);
        vm.expectRevert(DominoVault.NonceExhausted.selector); vault.resume();
        require(vault.stateNonce() == nonce && vault.operator() == OPERATOR && vault.policy().paused,
            "rejected terminal action mutated authority");
        vault.revokeOperator();
        require(vault.stateNonce() == nonce + 1 && !vault.isOperator(OPERATOR) &&
            vault.authorityGeneration() == type(uint64).max, "terminal revocation wrapped or counted twice");
        _withdraw(11, key.currency0, 100, 0);
        require(vault.stateNonce() == nonce + 2 && vault.authorityGeneration() == type(uint64).max,
            "terminal fee recovery wrapped or counted twice");
        vault.withdrawChildPosition(12);
        require(vault.stateNonce() == nonce + 3 && vault.authorityGeneration() == type(uint64).max &&
            positions.ownerOf(12) == owner, "terminal NFT recovery wrapped or failed");
    }

    function testAdoptionTransferFailureRollsBackMembershipAndCheckpoint() public {
        positions.mint(owner, 12, key, -300, 900, 500); positions.approve(address(vault), 12);
        positions.setRejectSafeTransfers(true);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(); vault.adoptChild(12, 11, true);
        require(!vault.position(12).known && positions.ownerOf(12) == owner && vault.stateNonce() == nonce,
            "failed transfer left registration");
    }

    function testFuzzExactOriginalAndChargedWithdrawalConservation(uint64 original, uint64 charged) public {
        if (original == 0 && charged == 0) return;
        bytes32 source0 = vault.position(11).source0;
        _credit(11, original, 0);
        _fund(key.currency0, charged);
        vault.creditConverted(source0, key.currency0, charged);
        uint256 ownerBefore = owner.balance;
        uint256 amount = uint256(original) + charged;
        vault.withdrawFeeReserves(source0, key.currency0, original, charged);
        T.FeeBalance memory remaining = vault.feeBalance(source0, key.currency0);
        require(owner.balance == ownerBefore + amount && address(vault).balance == 0, "raw payout mismatch");
        require(remaining.original == 0 && remaining.charged == 0 && vault.accountedCurrency(key.currency0) == 0,
            "fee class not fully debited");
        vm.expectRevert(); vault.withdrawFeeReserves(source0, key.currency0, original, charged);
    }
}
