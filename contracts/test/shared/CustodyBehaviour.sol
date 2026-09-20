// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T} from "../../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../../src/IDominoVaultDraft.sol";
import {VmE2, MockERC20, MockPoolManager, MockPositionManager, MockStateView, E2OwnerReceiver,
    E2ForeignSubscriber, E2OwnerWithoutNFTReceiver} from "../E2Mocks.sol";

/**
 * The custody surface DominoVault and DominoVaultV4 share, as one interface.
 *
 * scripts/check-vault-abi-drift.mjs records that the two vaults have 96 ABI
 * members in common; this is the part of that surface the shared tests use,
 * plus the four harness-only entry points each suite's subclass adds. The
 * errors are declared here rather than imported from either vault so a shared
 * test can name one without choosing a lineage - the selector depends on the
 * signature alone, so it is the same error in both.
 */
/// Test-only runtime replacement, used to take an oracle offline.
interface VmE2CodeEtch {
    function etch(address target, bytes calldata runtime) external;
}

interface ICustodyVault {
    error Unauthorized();
    error InvalidPosition();
    error MissingConsent();
    error PermissionUnavailable();
    error ForeignSubscription();
    error UnexpectedCallback();
    error ReentrantCall();
    error NonceExhausted();
    error InvalidTransition();
    error UnknownSource();
    error InvalidCurrency();
    error InvalidAmount();
    error InsufficientReserve();
    error TransferFailed();
    error UnbackedReserve();
    error ReadHelperUnavailable();

    function owner() external view returns (address);
    function factory() external view returns (address);
    // Declared identically by both lineages, so the shared tests reach it
    // through the vault rather than through a leaf's concrete harness.
    function initialize(address owner_, bytes32 sequenceId_, T.InitParams calldata params) external;
    function operator() external view returns (address);
    function isOperator(address account) external view returns (bool);
    function stateNonce() external view returns (uint64);
    function authorityGeneration() external view returns (uint64);
    function rootTokenId() external view returns (uint256);
    function rootArmed() external view returns (bool);
    function rootPermissionValid() external view returns (bool);
    function activePositions() external view returns (uint256);
    function accountedCurrency(address currency) external view returns (uint256);
    function position(uint256 tokenId) external view returns (T.Position memory);
    function checkpoint(uint256 tokenId) external view returns (T.Checkpoint memory);
    function registrationCheckpoint(uint256 tokenId) external view returns (T.Checkpoint memory);
    function feeBalance(bytes32 sourceId, address currency) external view returns (T.FeeBalance memory);
    function source(bytes32 sourceId) external view returns (T.Source memory);
    function policy() external view returns (IDominoVaultDraft.Policy memory);
    function executionLimits() external view returns (T.ExecutionLimits memory);
    function sequenceIdentityHash() external view returns (bytes32);

    function setOperator(address next) external;
    function revokeOperator() external;
    function pause() external;
    function resume() external;
    function rearmRoot(bool consentToUncollectedFees) external;
    function withdrawFeeReserves(bytes32 sourceId, address currency, uint128 original, uint128 charged) external;
    function withdrawChildPosition(uint256 tokenId) external;
    function recoverUnmanagedPosition(uint256 tokenId) external;
    function recoverUntrackedCurrency(address currency, uint256 amount) external;
    function setPolicy(IDominoVaultDraft.Policy calldata next) external;
    function setExecutionLimits(T.ExecutionLimits calldata next) external;
    function notifySubscribe(uint256 tokenId, bytes calldata data) external view;
    function notifyUnsubscribe(uint256 tokenId) external;
    function notifyModifyLiquidity(uint256 tokenId, int256 liquidityChange, int256 feesAccrued) external;
    function notifyBurn(uint256 tokenId, address owner_, uint256 liquidity, uint256 fees, int256 delta) external;

    /// Harness-only, on both subclasses. The fee sinks are internal in both
    /// vaults; V4 also exposes them to its pinned engine, which is a
    /// production path and not this one.
    function creditOriginal(uint256 tokenId, uint128 amount0, uint128 amount1) external;
    function creditConverted(bytes32 sourceId, address currency, uint128 amount) external;
    function forceNonce(uint64 nonce) external;
    function forceGeneration(uint64 generation) external;
}

/**
 * Custody behaviour both vault lineages must have, written once.
 *
 * Hygiene H-02 found that the release's own vault was covered only through its
 * V3 twin, and that the twin had drifted. Copying the V3 suite would have left
 * two copies free to drift again; inheriting one body means a divergence on
 * the shared surface stops being a silent difference and becomes a build
 * failure in whichever suite no longer fits.
 *
 * A subclass supplies `_setup`, which must leave `vault`, `key`, `owner` and
 * the mocks pointing at a live, armed vault of its own lineage.
 */
abstract contract CustodyBehaviour {
    VmE2 internal constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OPERATOR = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);
    address internal constant RECIPIENT = address(0xFEE);

    ICustodyVault internal vault;
    T.PoolKey internal key;
    address internal owner;
    // Both lineages stand on the same mocks; the shared tests read them.
    MockPoolManager internal poolManager;
    MockPositionManager internal positions;
    MockStateView internal stateView;
    MockERC20 internal token;
    MockERC20 internal secondToken;
    /// The implementation behind the clone under test, for cold-gas measurement.
    address internal implementation;

    event CallbackGasBound(uint256 forwardedGas, uint256 coldCallGasUsed);

    /// Build a vault of this lineage, owned by `owner_`, over a native or an
    /// ERC20/ERC20 pair, armed and ready.
    function _setup(address owner_, bool nativePair) internal virtual;

    /// Give the vault an active child of `parent`, numbered `id`, the way this
    /// lineage acquires one: V3 adopts an owner's NFT, V4 mints a successor
    /// through an execution. Either way the child ends in the vault's custody
    /// and the state nonce advances exactly once.
    function _child(uint256 id, uint256 parent) internal virtual;

    function _assertRootInvalidated(VmE2.Log[] memory logs, uint8 reason, uint64 generation, uint64 nonce) internal view {
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == keccak256("RootInvalidated(uint8,uint64,uint64)")) {
                _assertRootInvalidatedEvent(logs[i], reason, generation, nonce);
                ++count;
            }
        }
        require(count == 1, "root invalidation event missing or duplicated");
    }

    function _assertRootInvalidatedEvent(VmE2.Log memory entry, uint8 reason, uint64 generation, uint64 nonce)
        internal view
    {
        require(entry.emitter == address(vault) && entry.topics.length == 1 &&
            entry.topics[0] == keccak256("RootInvalidated(uint8,uint64,uint64)") &&
            keccak256(entry.data) == keccak256(abi.encode(reason, generation, nonce)), "wrong root invalidation event");
    }

    function _assertRootRecoveryEvent(VmE2.Log memory entry, uint64 nonce) internal view {
        require(entry.emitter == address(vault) && entry.topics.length == 3 &&
            entry.topics[0] == keccak256("UnmanagedPositionRecovered(uint256,address,bool,uint64)") &&
            entry.topics[1] == bytes32(uint256(11)) && entry.topics[2] == bytes32(uint256(uint160(owner))) &&
            keccak256(entry.data) == keccak256(abi.encode(true, nonce)), "root recovery event wrong");
    }

    function _checkpointCommitment(uint256 id, T.Checkpoint memory cp) internal view returns (bytes32) {
        return keccak256(abi.encode(keccak256("DominoRegistrationCheckpointV1"), vault.sequenceIdentityHash(), id,
            cp.liquidity, cp.feeGrowthInside0LastX128, cp.feeGrowthInside1LastX128,
            cp.feeGrowthInside0X128, cp.feeGrowthInside1X128, cp.observedAtBlock));
    }
    function _assertEnteredRootCallbackRejected(bool burn_) internal {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        bytes memory nested = burn_ ? abi.encodeCall(positions.burn, (11, 123)) :
            abi.encodeCall(positions.notifyModify, (11, 1, 123));
        receiver.configureReentry(address(positions), nested);
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 50, 0)));
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded() &&
            keccak256(receiver.reentryResult()) == keccak256(abi.encodeWithSelector(ICustodyVault.UnexpectedCallback.selector)),
            "entered root callback did not fail specifically at callback guard");
        require(vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation && vault.rootArmed() &&
            vault.rootPermissionValid() && positions.subscriber(11) == address(vault) && positions.ownerOf(11) == owner &&
            positions.getApproved(11) == address(vault) && positions.getPositionLiquidity(11) == 1000 && !poolManager.isUnlocked(),
            "rejected callback changed root or core lock state");
        require(address(receiver).balance == 50 && address(vault).balance == 50 &&
            vault.feeBalance(source0, key.currency0).original == 50, "callback rejection disrupted exact owner payout");
    }

    function _fund(address currency, uint256 amount) internal {
        if (currency == address(0)) vm.deal(address(vault), address(vault).balance + amount);
        else MockERC20(currency).mint(address(vault), amount);
    }

    function _credit(uint256 id, uint128 amount0, uint128 amount1) internal {
        _fund(key.currency0, amount0);
        _fund(key.currency1, amount1);
        vault.creditOriginal(id, amount0, amount1);
    }

    function _balance(address currency, address account) internal view returns (uint256) {
        return currency == address(0) ? account.balance : MockERC20(currency).balanceOf(account);
    }

    function _withdraw(uint256 id, address currency, uint128 original, uint128 charged) internal {
        T.Position memory p = vault.position(id);
        bytes32 sourceId = currency == key.currency0 ? p.source0 : p.source1;
        vm.prank(owner);
        vault.withdrawFeeReserves(sourceId, currency, original, charged);
    }

    // ---------------------------------------------------------------
    // Fee reserves
    // ---------------------------------------------------------------

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

    function testZeroWithdrawalFailsForKnownBackedSource() public {
        _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.InvalidAmount.selector);
        vault.withdrawFeeReserves(source0, key.currency0, 0, 0);
        require(vault.stateNonce() == nonce && vault.feeBalance(source0, key.currency0).original == 100,
            "zero withdrawal mutated state");
    }

    // ---------------------------------------------------------------
    // Untracked value
    // ---------------------------------------------------------------

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

    function testIndividualApprovalIsRequiredEvenWithGlobalApproval() public {
        positions.approve(address(0), 11);
        positions.setApprovalForAll(address(vault), true);
        require(!vault.rootPermissionValid(), "global approval bypass");
        vm.expectRevert(ICustodyVault.PermissionUnavailable.selector); vault.rearmRoot(true);
        positions.approve(address(vault), 11);
        vault.rearmRoot(true);
        require(vault.rootPermissionValid(), "individual approval not restored");
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

    function testUnsafeRootRecoveryInvalidatesOnceAndRequiresExplicitRearm() public {
        positions.setSuppressUnsubscribeCallback(true);
        positions.transferFrom(owner, address(vault), 11);
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        T.Position memory old = vault.position(11);
        positions.setRejectTransfers(true);
        vm.expectRevert(MockPositionManager.TransferRejected.selector); vault.recoverUnmanagedPosition(11);
        require(positions.ownerOf(11) == address(vault) && vault.rootArmed() &&
            vault.stateNonce() == nonce && vault.authorityGeneration() == generation &&
            keccak256(abi.encode(vault.position(11))) == keccak256(abi.encode(old)),
            "failed root rescue retained invalidation or changed custody");
        positions.setRejectTransfers(false);
        vm.recordLogs();
        vault.recoverUnmanagedPosition(11);
        _assertRootInvalidated(vm.getRecordedLogs(), 4, generation + 1, nonce + 1);
        require(positions.ownerOf(11) == owner && !vault.rootArmed() && !vault.rootPermissionValid(), "root rescue kept authority");
        require(vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation + 1, "root rescue nonce doubled");
        T.Position memory current = vault.position(11);
        require(current.identity == old.identity && current.source0 == old.source0 && current.source1 == old.source1,
            "root rescue changed fee provenance");
        vm.expectRevert(ICustodyVault.PermissionUnavailable.selector); vault.rearmRoot(true);
        positions.approve(address(vault), 11); vault.rearmRoot(true);
        require(vault.rootPermissionValid(), "root cannot be rearmed after rescue");
    }

    function testDeliveredRootTransferAndRescueEmitTwoOrderedInvalidations() public {
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        bytes32 identity = vault.position(11).identity;
        vm.recordLogs();
        positions.transferFrom(owner, address(vault), 11);
        vault.recoverUnmanagedPosition(11);
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 3, "root transfer and rescue log count");
        _assertRootInvalidatedEvent(logs[0], 1, generation + 1, nonce + 1);
        _assertRootInvalidatedEvent(logs[1], 4, generation + 2, nonce + 2);
        _assertRootRecoveryEvent(logs[2], nonce + 2);
        require(positions.ownerOf(11) == owner && positions.subscriber(11) == address(0) &&
            !vault.rootArmed() && !vault.rootPermissionValid() && vault.stateNonce() == nonce + 2 &&
            vault.authorityGeneration() == generation + 2 && vault.position(11).identity == identity,
            "delivered callback rescue changed custody or counter semantics");
    }

    function testTerminalGenerationRootRecoverySaturatesAndEmitsReasonFour() public {
        positions.setSuppressUnsubscribeCallback(true);
        positions.transferFrom(owner, address(vault), 11);
        vault.forceGeneration(type(uint64).max);
        uint64 nonce = vault.stateNonce();
        vm.recordLogs();
        vault.recoverUnmanagedPosition(11);
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 3 && logs[0].emitter == address(vault) && logs[0].topics.length == 2 &&
            logs[0].topics[0] == keccak256("TerminalRecovery(bytes4,uint64,uint64)") &&
            logs[0].topics[1] == bytes32(vault.recoverUnmanagedPosition.selector) &&
            keccak256(logs[0].data) == keccak256(abi.encode(nonce, type(uint64).max)),
            "terminal root recovery marker wrong");
        _assertRootInvalidatedEvent(logs[1], 4, type(uint64).max, nonce + 1);
        _assertRootRecoveryEvent(logs[2], nonce + 1);
        require(positions.ownerOf(11) == owner && !vault.rootArmed() && !vault.rootPermissionValid() &&
            vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == type(uint64).max,
            "terminal root rescue failed or wrapped");
    }

    function testUnmanagedRescueIgnoresRejectingReceiverAndCannotInvokeOwnerReentry() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        positions.mint(owner, 90, key, -300, 900, 500); positions.mint(owner, 91, key, -300, 900, 500);
        vm.startPrank(owner);
        positions.transferFrom(owner, address(vault), 90); positions.transferFrom(owner, address(vault), 91);
        vm.stopPrank();
        uint64 nonce = vault.stateNonce(); receiver.setReject(false, true);
        bytes memory rescue = abi.encodeCall(vault.recoverUnmanagedPosition, (90));
        receiver.configureReentry(address(vault), abi.encodeCall(vault.recoverUnmanagedPosition, (91)));
        receiver.invoke(address(vault), rescue);
        require(!receiver.reentryAttempted(), "unmanaged rescue called owner receiver");
        require(vault.stateNonce() == nonce + 1, "plain transfer rescue nonce");
        require(positions.ownerOf(90) == owner && positions.ownerOf(91) == address(vault), "rescued both NFTs");
    }

    function testForeignSubscriberRequiresExplicitUnsubscribeBeforeRearm() public {
        positions.unsubscribe(11);
        E2ForeignSubscriber foreign = new E2ForeignSubscriber();
        positions.subscribe(11, address(foreign), "");
        vm.expectRevert(ICustodyVault.ForeignSubscription.selector); vault.rearmRoot(true);
        positions.unsubscribe(11);
        vault.rearmRoot(true);
        require(positions.subscriber(11) == address(vault), "rearm subscribe missing");
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

    function testBurnCallbackInvalidatesRootWithoutStrandingAlreadyTrackedReserves() public {
        _credit(11, 100, 0);
        positions.burn(11, type(int256).max);
        require(!vault.rootArmed() && !vault.rootPermissionValid(), "burn retained authority");
        _withdraw(11, key.currency0, 100, 0);
        require(vault.accountedCurrency(key.currency0) == 0, "burn stranded earned fees");
    }

    /// A token that fails outright - by reverting, or by returning false while
    /// reverting nothing - must leave the ledger and both balances untouched.
    /// The third case this test used to carry, a token that succeeds but
    /// credits less than it was sent, is where the two lineages part company
    /// and lives in each leaf suite.
    function testERC20FalseReturnAndRevertRollBackLedgerAndBalances() public {
        _credit(11, 0, 1000);
        bytes32 source1 = vault.position(11).source1;
        uint64 nonce = vault.stateNonce();
        for (uint8 failure = 1; failure < 3; ++failure) {
            MockERC20(key.currency1).configureTransfer(failure, 0);
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
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded() &&
            keccak256(receiver.reentryResult()) == keccak256(abi.encodeWithSelector(ICustodyVault.ReentrantCall.selector)),
            "owner receiver did not fail specifically at reentrancy guard");
        require(address(receiver).balance == 50 && vault.feeBalance(source0, key.currency0).original == 50, "double native exit");
    }

    function testNativeOwnerCallbackCanUnsubscribeRootDuringSuccessfulExit() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        receiver.configureReentry(address(positions), abi.encodeCall(positions.unsubscribe, (11)));
        vm.recordLogs();
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 50, 0)));
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2, "nested unsubscribe exit log count");
        _assertRootInvalidatedEvent(logs[0], 1, generation + 1, nonce + 2);
        require(logs[1].emitter == address(vault) && logs[1].topics.length == 4 &&
            logs[1].topics[0] == keccak256("FeeReservesWithdrawn(bytes32,address,address,uint128,uint128,uint64)") &&
            logs[1].topics[1] == source0 && logs[1].topics[2] == bytes32(uint256(uint160(key.currency0))) &&
            logs[1].topics[3] == bytes32(uint256(uint160(owner))) &&
            keccak256(logs[1].data) == keccak256(abi.encode(uint128(50), uint128(0), nonce + 2)),
            "fee exit event must follow invalidation and share its final nonce");
        require(receiver.reentryAttempted() && receiver.reentrySucceeded() && positions.subscriber(11) == address(0) && !vault.rootArmed() &&
            !vault.rootPermissionValid() && vault.stateNonce() == nonce + 2 && vault.authorityGeneration() == generation + 1,
            "callback during exit left root authority stale");
        require(address(receiver).balance == 50 && vault.feeBalance(source0, key.currency0).original == 50,
            "invalidation disrupted exact owner payout");
    }

    function testNativeOwnerCallbackCanUnsubscribeDuringUntrackedRecovery() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _credit(11, 100, 0); _fund(key.currency0, 17);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        receiver.configureReentry(address(positions), abi.encodeCall(positions.unsubscribe, (11)));
        vm.recordLogs();
        receiver.invoke(address(vault), abi.encodeCall(vault.recoverUntrackedCurrency, (key.currency0, 17)));
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2, "nested unsubscribe surplus log count");
        _assertRootInvalidatedEvent(logs[0], 1, generation + 1, nonce + 2);
        require(logs[1].emitter == address(vault) && logs[1].topics.length == 3 &&
            logs[1].topics[0] == keccak256("UntrackedCurrencyRecovered(address,address,uint256,uint64)") &&
            logs[1].topics[1] == bytes32(uint256(uint160(key.currency0))) &&
            logs[1].topics[2] == bytes32(uint256(uint160(owner))) &&
            keccak256(logs[1].data) == keccak256(abi.encode(uint256(17), nonce + 2)),
            "surplus event must follow invalidation and share its final nonce");
        require(receiver.reentryAttempted() && receiver.reentrySucceeded() && !vault.rootArmed() &&
            positions.subscriber(11) == address(0) && vault.stateNonce() == nonce + 2 &&
            vault.authorityGeneration() == generation + 1 && address(receiver).balance == 17 &&
            vault.feeBalance(source0, key.currency0).original == 100 && vault.accountedCurrency(key.currency0) == 100,
            "surplus invalidation altered tracked reserve or authority");
    }

    function testUnsubscribeGasGuardRevertsBeforeLosingSubscription() public {
        positions.setUnsubscribeGasLimit(100000);
        uint64 nonce = vault.stateNonce();
        (bool ok, bytes memory result) = address(positions).call{gas: 50000}(abi.encodeCall(positions.unsubscribe, (11)));
        require(!ok && keccak256(result) == keccak256(abi.encodeWithSelector(MockPositionManager.UnsubscribeGasTooLow.selector)),
            "mock did not enforce upstream pre-call gas guard");
        require(positions.subscriber(11) == address(vault) && vault.rootArmed() && vault.stateNonce() == nonce,
            "failed cap guard lost subscription");
    }

    function testInsufficientCallbackBudgetLeavesAdvisoryFlagButAuthorityFailsClosed() public {
        positions.setUnsubscribeGasLimit(1000);
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        positions.unsubscribe(11);
        require(positions.subscriber(11) == address(0) && vault.rootArmed() && !vault.rootPermissionValid() &&
            vault.stateNonce() == nonce && vault.authorityGeneration() == generation,
            "lost callback must remain explicit and fail closed");
    }

    function testTerminalSurplusNFTRecoveryAndPauseEmitExactRecoveryEvents() public {
        _fund(key.currency0, 7);
        positions.mint(owner, 99, key, -300, 900, 500); positions.transferFrom(owner, address(vault), 99);
        vault.forceNonce(type(uint64).max);
        uint64 generation = vault.authorityGeneration();
        vm.recordLogs();
        vault.pause(); vault.recoverUntrackedCurrency(key.currency0, 7); vault.recoverUnmanagedPosition(99);
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        bytes4[3] memory selectors = [vault.pause.selector, vault.recoverUntrackedCurrency.selector,
            vault.recoverUnmanagedPosition.selector];
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == keccak256("TerminalRecovery(bytes4,uint64,uint64)")) {
                require(found < 3 && logs[i].topics.length == 2 && logs[i].topics[1] == bytes32(selectors[found]) &&
                    keccak256(logs[i].data) == keccak256(abi.encode(type(uint64).max, generation)),
                    "wrong terminal recovery event");
                ++found;
            }
        }
        require(found == 3 && vault.stateNonce() == type(uint64).max && vault.authorityGeneration() == generation &&
            vault.policy().paused && address(vault).balance == 0 && positions.ownerOf(99) == owner,
            "terminal recovery missed event, wrapped or failed");
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

    function testRearmSnapshotsExactCoreStateWithoutReplacingOriginalSourceIdentity() public {
        T.Position memory before_ = vault.position(11);
        T.Checkpoint memory initial = vault.checkpoint(11);
        T.Checkpoint memory registered = vault.registrationCheckpoint(11);
        bytes32 baseline = _checkpointCommitment(11, registered);
        require(baseline == before_.registrationBaselineId && baseline == registered.commitment,
            "registration checkpoint does not reconstruct baseline");
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.MissingConsent.selector); vault.rearmRoot(false);
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
        bytes32 firstRearmCommitment = current.commitment;
        stateView.setPositionState(11, 1000, 55, 66);
        stateView.setFeeGrowthInside(keccak256(abi.encode(key)), -600, 600, 77, 88);
        vm.roll(block.number + 1);
        vault.rearmRoot(true);
        current = vault.checkpoint(11);
        require(current.feeGrowthInside0LastX128 == 55 && current.feeGrowthInside1LastX128 == 66 &&
            current.feeGrowthInside0X128 == 77 && current.feeGrowthInside1X128 == 88 &&
            current.observedAtBlock == block.number && current.commitment != firstRearmCommitment &&
            current.commitment != initial.commitment && _checkpointCommitment(11, current) == current.commitment &&
            vault.stateNonce() == nonce + 2, "second rearm did not retain a distinct coherent observation");
        T.Position memory after_ = vault.position(11);
        T.Checkpoint memory preserved = vault.registrationCheckpoint(11);
        require(keccak256(abi.encode(preserved)) == keccak256(abi.encode(registered)) &&
            _checkpointCommitment(11, preserved) == baseline, "registration checkpoint overwritten by rearm");
        require(after_.identity == before_.identity && after_.registrationBaselineId == before_.registrationBaselineId &&
            after_.source0 == before_.source0 && after_.source1 == before_.source1, "historical source replaced");
        require(vault.accountedCurrency(key.currency0) == 0 && vault.accountedCurrency(key.currency1) == 0,
            "checkpoint difference fabricated fee reserve");
    }

    function testNativeOwnerModifyCallbackRejectedWhileWithdrawalCompletes() public {
        _assertEnteredRootCallbackRejected(false);
    }

    function testNativeOwnerBurnCallbackRejectedWhileWithdrawalCompletes() public {
        _assertEnteredRootCallbackRejected(true);
    }

    function testOnlyManagerCanNotifyAndUnexpectedSubscriptionCannotArmVault() public {
        vm.expectRevert(); vault.notifyUnsubscribe(11);
        vm.expectRevert(); vault.notifyModifyLiquidity(11, 1, 0);
        vm.expectRevert(); vault.notifyBurn(11, owner, 0, 1000, 0);
        vm.prank(address(positions)); vm.expectRevert(); vault.notifySubscribe(11, "");
        require(vault.rootPermissionValid(), "forged callback affected authority");
    }

    /**
     * Resuming is the one owner action that re-arms automation, so it refuses
     * to run while the root permission is gone - otherwise the vault would
     * come back unpaused over a position it can no longer act on, and the
     * operator would be turned loose against a stale authority.
     *
     * Found by mutation: deleting `if (!rootPermissionValid()) revert
     * PermissionUnavailable()` from V4's `resume` left every suite in the tree
     * green. Pausing is deliberately not symmetric - a vault that has lost its
     * permission must still be pausable.
     */
    function testResumeRefusesWhileTheRootPermissionIsGoneButPauseDoesNot() public {
        _setup(address(this), true);
        vault.pause();
        require(vault.policy().paused, "pause did not take");

        vm.prank(owner);
        positions.approve(address(0), 11);
        require(!vault.rootPermissionValid() && vault.rootArmed(),
            "the root must be armed but unusable for this to mean anything");

        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.PermissionUnavailable.selector);
        vault.resume();
        require(vault.policy().paused && vault.stateNonce() == nonce, "a refused resume changed state");

        // Restoring the permission is enough; nothing else has to be re-armed.
        vm.prank(owner);
        positions.approve(address(vault), 11);
        vault.resume();
        require(!vault.policy().paused, "resume did not recover");
    }

    function testUnsafePreviouslyWithdrawnChildRecoveryPreservesHistoricalSources() public {
        _child(12, 11); _credit(12, 50, 0);
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
        _child(12, 11);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(); vault.recoverUnmanagedPosition(12);
        require(positions.ownerOf(12) == address(vault) && vault.position(12).active && vault.stateNonce() == nonce,
            "active child recovery changed state");
        vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner && !vault.position(12).active, "normal child exit blocked");
    }

    function testPauseAndRootTransferLeaveOwnerExitsAvailable() public {
        _child(12, 11); _credit(11, 100, 0); _credit(12, 0, 80);
        vault.pause();
        positions.transferFrom(owner, STRANGER, 11);
        require(!vault.rootPermissionValid(), "old owner still armed");
        _withdraw(11, key.currency0, 100, 0);
        _withdraw(12, key.currency1, 80, 0);
        vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner, "root transfer reassigned child");
        vm.prank(STRANGER); vm.expectRevert(ICustodyVault.Unauthorized.selector); vault.rearmRoot(true);
    }

    function testRejectingNativeReceiverRollsBackButNFTExitDoesNotRequireReceiver() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _child(12, 11); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); receiver.setReject(true, true);
        vm.expectRevert(); receiver.invoke(address(vault),
            abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 100, 0)));
        require(vault.stateNonce() == nonce && vault.feeBalance(source0, key.currency0).original == 100, "receiver rollback");
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(positions.ownerOf(12) == owner && !vault.position(12).active && vault.stateNonce() == nonce + 1,
            "rejecting NFT receiver stranded child");
    }

    function testPlainNFTExitNeverCallsOwnerReceiverOrReentryHook() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _child(12, 11); _child(13, 12);
        receiver.configureReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (13)));
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(!receiver.reentryAttempted(), "NFT exit called owner receiver");
        require(positions.ownerOf(12) == owner && positions.ownerOf(13) == address(vault), "second child stolen");
    }

    function testOwnerWithoutNFTReceiverRecoversManagedAndUnmanagedNFTs() public {
        E2OwnerWithoutNFTReceiver receiver = new E2OwnerWithoutNFTReceiver(); _setup(address(receiver), true);
        _child(12, 11);
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(positions.ownerOf(12) == owner, "owner without receiver cannot exit child");
        positions.mint(owner, 99, key, -300, 900, 500);
        vm.prank(owner); positions.transferFrom(owner, address(vault), 99);
        receiver.invoke(address(vault), abi.encodeCall(vault.recoverUnmanagedPosition, (99)));
        require(positions.ownerOf(99) == owner, "owner without receiver cannot rescue NFT");
    }

    function testPlainNFTManagerFailureRollsBackAndManagerReentryIsUnauthorized() public {
        _child(12, 11); _child(13, 12);
        positions.setRejectTransfers(true); uint64 nonce = vault.stateNonce();
        vm.expectRevert(MockPositionManager.TransferRejected.selector); vault.withdrawChildPosition(12);
        require(vault.position(12).active && positions.ownerOf(12) == address(vault) && vault.stateNonce() == nonce,
            "failed manager transfer left effects");
        positions.setRejectTransfers(false);
        positions.configureTransferReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (13)));
        vault.withdrawChildPosition(12);
        require(positions.transferReentryAttempted() && !positions.transferReentrySucceeded() &&
            keccak256(positions.transferReentryResult()) == keccak256(abi.encodeWithSelector(ICustodyVault.Unauthorized.selector)),
            "manager reentry did not fail specifically at owner guard");
        require(positions.ownerOf(12) == owner && positions.ownerOf(13) == address(vault), "manager reentry took second child");
    }

    function testNativeOwnerChildExitReentryFailsAtReentrancyGuard() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _child(12, 11); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        receiver.configureReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 50, 0)));
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded() &&
            keccak256(receiver.reentryResult()) == keccak256(abi.encodeWithSelector(ICustodyVault.ReentrantCall.selector)),
            "owner child exit did not fail specifically at reentrancy guard");
        require(vault.position(12).active && positions.ownerOf(12) == address(vault) && vault.activePositions() == 2 &&
            vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation && vault.rootArmed() &&
            address(receiver).balance == 50 && vault.feeBalance(source0, key.currency0).original == 50,
            "nested child exit changed custody or outer payout");
    }

    function testMockManagerEntryGuardsRejectOperationsWhileUnlocked() public {
        _child(12, 11);
        poolManager.setUnlocked(true);
        vm.expectRevert(MockPositionManager.ManagerUnlocked.selector); positions.unsubscribe(11);
        vm.expectRevert(MockPositionManager.ManagerUnlocked.selector); positions.transferFrom(owner, STRANGER, 11);
        vm.expectRevert(MockPositionManager.ManagerUnlocked.selector); positions.notifyModify(11, 0, 0);
        vm.expectRevert(MockPositionManager.ManagerUnlocked.selector); positions.burn(11, 0);
        vm.expectRevert(MockPositionManager.ManagerUnlocked.selector); vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == address(vault) && vault.position(12).active, "locked-model rejection mutated custody");
        poolManager.setUnlocked(false); vault.withdrawChildPosition(12);
        require(positions.ownerOf(12) == owner, "locked manager positive control failed");
    }

    function testTerminalNonceRejectsNewAuthorityButOwnerRecoveryRemainsAvailable() public {
        _child(12, 11); _credit(11, 100, 0);
        vault.forceNonce(type(uint64).max);
        vm.expectRevert(ICustodyVault.NonceExhausted.selector); vault.rearmRoot(true);
        _withdraw(11, key.currency0, 100, 0);
        vault.withdrawChildPosition(12);
        require(vault.stateNonce() == type(uint64).max && positions.ownerOf(12) == owner, "terminal recovery wrapped/failed");
    }

    function testUnavailableStateViewBlocksAuthorityButNotNativeERC20AndChildRecovery() public {
        _child(12, 11); _credit(11, 100, 200);
        uint64 nonce = vault.stateNonce();
        uint256 nativeBefore = owner.balance; uint256 tokenBefore = _balance(key.currency1, owner);
        // Test-only runtime replacement: every oracle call now reverts, while
        // the PositionManager and PoolManager continue serving actual custody.
        VmE2CodeEtch(address(vm)).etch(address(stateView), hex"60006000fd");
        (bool oracleAvailable,) = address(stateView).staticcall(abi.encodeWithSignature("poolManager()"));
        require(!oracleAvailable && !vault.rootPermissionValid(), "disabled oracle did not block authority");
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
        _child(12, 11); _credit(11, 100, 0); vault.pause();
        vault.forceGeneration(type(uint64).max);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.NonceExhausted.selector); vault.setOperator(STRANGER);
        vm.expectRevert(ICustodyVault.NonceExhausted.selector); vault.rearmRoot(true);
        vm.expectRevert(ICustodyVault.NonceExhausted.selector); vault.resume();
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

    function testColdCloneUnsubscribeCallbackFitsConservative100kGasBudget() public {
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        address target = address(vault);
        bytes memory data = abi.encodeCall(vault.notifyUnsubscribe, (11));
        // cool marks both account and storage cold; also cool the delegate target.
        vm.cool(target); vm.cool(implementation);
        vm.prank(address(positions)); uint256 beforeGas = gasleft();
        (bool ok,) = target.call{gas: 100000}(data);
        uint256 used = beforeGas - gasleft();
        require(ok && !vault.rootArmed() && vault.stateNonce() == nonce + 1 &&
            vault.authorityGeneration() == generation + 1, "cold clone callback exceeded budget");
        emit CallbackGasBound(100000, used);
    }

    /// withdrawChildPosition is the owner's managed exit for a child and only
    /// that: the root leaves by recovery, a withdrawn child has already left,
    /// and a token the vault never registered is not a child. Found by
    /// mutation - the ported suite reached the happy path only, so the guard
    /// could be deleted with both lineages green.
    function testWithdrawChildPositionRefusesTheRootAWithdrawnChildAndAnUnknownToken() public {
        _child(12, 11);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.InvalidPosition.selector); vault.withdrawChildPosition(11);
        vm.expectRevert(ICustodyVault.InvalidPosition.selector); vault.withdrawChildPosition(99);
        vault.withdrawChildPosition(12);
        vm.expectRevert(ICustodyVault.InvalidPosition.selector); vault.withdrawChildPosition(12);
        require(vault.stateNonce() == nonce + 1 && vault.activePositions() == 1 && positions.ownerOf(11) == owner
            && vault.rootArmed(), "a refused exit moved state");

        // Recovery is for what the vault holds. A token it does not hold is
        // refused as a position, before any transfer is attempted.
        positions.mint(owner, 99, key, -300, 900, 500);
        vm.expectRevert(ICustodyVault.InvalidPosition.selector); vault.recoverUnmanagedPosition(99);
        require(positions.ownerOf(99) == owner && vault.stateNonce() == nonce + 1, "a refused recovery moved state");
    }
}
