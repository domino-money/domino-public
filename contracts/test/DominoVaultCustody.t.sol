// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVault} from "../src/DominoVault.sol";
import {DominoVaultTypes as T, IERC721ReceiverE2} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20, E2OwnerReceiver,
    E2ForeignSubscriber, E2OwnerWithoutNFTReceiver} from "./E2Mocks.sol";
import {CustodyBehaviour, ICustodyVault} from "./shared/CustodyBehaviour.sol";

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

contract DominoVaultCustodyTest is IERC721ReceiverE2, CustodyBehaviour {
    VaultE2TestHarness private harness;
    event CallbackGasBound(uint256 forwardedGas, uint256 coldCallGasUsed);

    receive() external payable {}
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721ReceiverE2.onERC721Received.selector;
    }

    function setUp() public { _setup(address(this), true); }

    function _setup(address owner_, bool nativePair) internal override {
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
        harness = VaultE2TestHarness(payable(clone));
        vault = ICustodyVault(clone);
        vm.prank(owner);
        positions.approve(clone, 11);
        T.InitParams memory params = T.InitParams({
            rootTokenId: 11, expectedPoolId: keccak256(abi.encode(key)), baseCurrency: key.currency0,
            quoteCurrency: key.currency1, operator: OPERATOR, consentToUncollectedFees: true,
            policy: IDominoVaultDraft.Policy(200, 500, 1000, 60, 4, 1, false),
            limits: T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600)
        });
        harness.initialize(owner, keccak256("synthetic sequence"), params);
    }

    function _adopt(uint256 id, uint256 parent) private {
        positions.mint(owner, id, key, -300, 900, 500);
        vm.prank(owner);
        positions.approve(address(vault), id);
        uint64 nonce = vault.stateNonce();
        vm.prank(owner);
        harness.adoptChild(id, parent, true);
        require(vault.stateNonce() == nonce + 1, "adoption nonce not exact");
    }

    function _ownerOnlyWithPositiveControl(bytes memory data) private {
        uint64 nonce = vault.stateNonce();
        address currentOperator = vault.operator();
        address outsider = currentOperator == STRANGER ? OPERATOR : STRANGER;
        require(currentOperator != address(0) && currentOperator != owner && vault.isOperator(currentOperator),
            "owner guard negative requires a current enabled operator");
        require(outsider != currentOperator && outsider != owner && !vault.isOperator(outsider),
            "owner guard outsider must not have operator authority");
        vm.prank(currentOperator); (bool ok, bytes memory result) = address(vault).call(data);
        require(!ok && keccak256(result) == keccak256(abi.encodeWithSelector(DominoVault.Unauthorized.selector)),
            "operator did not fail specifically at owner guard");
        vm.prank(outsider); (ok, result) = address(vault).call(data);
        require(!ok && keccak256(result) == keccak256(abi.encodeWithSelector(DominoVault.Unauthorized.selector)),
            "stranger did not fail specifically at owner guard");
        require(vault.stateNonce() == nonce, "unauthorized call mutated");
        vm.prank(owner); (ok, result) = address(vault).call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        require(vault.stateNonce() == nonce + 1, "owner positive control nonce not exact");
    }

    function testEveryOwnerOnlyGuardHasValidStateAndSuccessfulOwnerControl() public {
        _credit(11, 100, 200);
        IDominoVaultDraft.Policy memory next = vault.policy(); next.version++;
        T.ExecutionLimits memory limits = vault.executionLimits(); limits.version++;
        bytes32 sourceId = vault.position(11).source0;
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.setPolicy, (next)));
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.setExecutionLimits, (limits)));
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.withdrawFeeReserves, (sourceId, key.currency0, 1, 0)));
        _fund(key.currency0, 1);
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.recoverUntrackedCurrency, (key.currency0, 1)));
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.rearmRoot, (true)));
        positions.mint(owner, 99, key, -300, 900, 500); positions.transferFrom(owner, address(vault), 99);
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.recoverUnmanagedPosition, (99)));
        positions.mint(owner, 12, key, -300, 900, 500); positions.approve(address(vault), 12);
        _ownerOnlyWithPositiveControl(abi.encodeCall(harness.adoptChild, (12, 11, true)));
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.withdrawChildPosition, (12)));
        vault.pause();
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.resume, ()));
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.setOperator, (STRANGER)));
        // The helper now exercises STRANGER as the actual current operator and
        // the former OPERATOR as an outsider, before the owner revokes it.
        _ownerOnlyWithPositiveControl(abi.encodeCall(vault.revokeOperator, ()));
    }

    function testOperatorRotationAndAuthorityValidationHaveSuccessfulControls() public {
        uint64 version = vault.policy().version; uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        harness.validateAuthority(version, nonce, generation);
        vm.prank(OPERATOR); harness.validateAuthority(version, nonce, generation);
        vault.setOperator(STRANGER);
        require(vault.operator() == STRANGER && vault.isOperator(STRANGER) && !vault.isOperator(OPERATOR) &&
            vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation + 1, "rotation state wrong");
        vm.prank(OPERATOR); vm.expectRevert(DominoVault.Unauthorized.selector);
        harness.validateAuthority(version, nonce + 1, generation + 1);
        vm.prank(STRANGER); harness.validateAuthority(version, nonce + 1, generation + 1);
        harness.validateAuthority(version, nonce + 1, generation + 1);
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
        vm.expectRevert(DominoVault.InvalidPosition.selector); harness.adoptChild(12, 11, true);
    }

    function testAdoptionRejectsForeignOwnerParentPoolAndUnconsentedOrUnapprovedNFT() public {
        positions.mint(STRANGER, 12, key, -300, 900, 500);
        vm.prank(STRANGER); positions.approve(address(vault), 12);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector); harness.adoptChild(12, 11, true);
        positions.mint(owner, 13, key, -300, 900, 500);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector); harness.adoptChild(13, 11, true);
        positions.approve(address(vault), 13);
        vm.expectRevert(DominoVault.MissingConsent.selector); harness.adoptChild(13, 11, false);
        vm.expectRevert(DominoVault.InvalidPosition.selector); harness.adoptChild(13, 99, true);
        T.PoolKey memory other = key; other.fee = 500;
        positions.mint(owner, 14, other, -300, 900, 500);
        positions.approve(address(vault), 14);
        vm.expectRevert(DominoVault.InvalidPosition.selector); harness.adoptChild(14, 11, true);
        require(positions.ownerOf(13) == owner && !vault.position(13).known, "invalid adoption kept effects");
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

    function testCoreLiquidityMismatchRejectsAdoptionBeforeCustody() public {
        positions.mint(owner, 12, key, -300, 900, 500);
        positions.approve(address(vault), 12);
        stateView.setPositionState(12, 499, 3, 4);
        vm.expectRevert(DominoVault.InvalidPosition.selector); harness.adoptChild(12, 11, true);
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
        vm.prank(STRANGER); vm.expectRevert(DominoVault.Unauthorized.selector); vault.rearmRoot(true);
    }

    function testRejectingNativeReceiverRollsBackButNFTExitDoesNotRequireReceiver() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _adopt(12, 11); _credit(11, 100, 0);
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
        _adopt(12, 11); _adopt(13, 11);
        receiver.configureReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (13)));
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(!receiver.reentryAttempted(), "NFT exit called owner receiver");
        require(positions.ownerOf(12) == owner && positions.ownerOf(13) == address(vault), "second child stolen");
    }

    function testOwnerWithoutNFTReceiverRecoversManagedAndUnmanagedNFTs() public {
        E2OwnerWithoutNFTReceiver receiver = new E2OwnerWithoutNFTReceiver(); _setup(address(receiver), true);
        _adopt(12, 11);
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        require(positions.ownerOf(12) == owner, "owner without receiver cannot exit child");
        positions.mint(owner, 99, key, -300, 900, 500);
        vm.prank(owner); positions.transferFrom(owner, address(vault), 99);
        receiver.invoke(address(vault), abi.encodeCall(vault.recoverUnmanagedPosition, (99)));
        require(positions.ownerOf(99) == owner, "owner without receiver cannot rescue NFT");
    }

    function testPlainNFTManagerFailureRollsBackAndManagerReentryIsUnauthorized() public {
        _adopt(12, 11); _adopt(13, 11);
        positions.setRejectTransfers(true); uint64 nonce = vault.stateNonce();
        vm.expectRevert(MockPositionManager.TransferRejected.selector); vault.withdrawChildPosition(12);
        require(vault.position(12).active && positions.ownerOf(12) == address(vault) && vault.stateNonce() == nonce,
            "failed manager transfer left effects");
        positions.setRejectTransfers(false);
        positions.configureTransferReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (13)));
        vault.withdrawChildPosition(12);
        require(positions.transferReentryAttempted() && !positions.transferReentrySucceeded() &&
            keccak256(positions.transferReentryResult()) == keccak256(abi.encodeWithSelector(DominoVault.Unauthorized.selector)),
            "manager reentry did not fail specifically at owner guard");
        require(positions.ownerOf(12) == owner && positions.ownerOf(13) == address(vault), "manager reentry took second child");
    }

    function testNativeOwnerChildExitReentryFailsAtReentrancyGuard() public {
        E2OwnerReceiver receiver = new E2OwnerReceiver(); _setup(address(receiver), true);
        _adopt(12, 11); _credit(11, 100, 0);
        bytes32 source0 = vault.position(11).source0;
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        receiver.configureReentry(address(vault), abi.encodeCall(vault.withdrawChildPosition, (12)));
        receiver.invoke(address(vault), abi.encodeCall(vault.withdrawFeeReserves, (source0, key.currency0, 50, 0)));
        require(receiver.reentryAttempted() && !receiver.reentrySucceeded() &&
            keccak256(receiver.reentryResult()) == keccak256(abi.encodeWithSelector(DominoVault.ReentrantCall.selector)),
            "owner child exit did not fail specifically at reentrancy guard");
        require(vault.position(12).active && positions.ownerOf(12) == address(vault) && vault.activePositions() == 2 &&
            vault.stateNonce() == nonce + 1 && vault.authorityGeneration() == generation && vault.rootArmed() &&
            address(receiver).balance == 50 && vault.feeBalance(source0, key.currency0).original == 50,
            "nested child exit changed custody or outer payout");
    }

    function testColdCloneUnsubscribeCallbackFitsConservative100kGasBudget() public {
        uint64 nonce = vault.stateNonce(); uint64 generation = vault.authorityGeneration();
        address target = address(vault); address implementation_ = harness.implementation();
        bytes memory data = abi.encodeCall(harness.notifyUnsubscribe, (11));
        // cool marks both account and storage cold; also cool the delegate target.
        vm.cool(target); vm.cool(implementation_);
        vm.prank(address(positions)); uint256 beforeGas = gasleft();
        (bool ok,) = target.call{gas: 100000}(data);
        uint256 used = beforeGas - gasleft();
        require(ok && !vault.rootArmed() && vault.stateNonce() == nonce + 1 &&
            vault.authorityGeneration() == generation + 1, "cold clone callback exceeded budget");
        emit CallbackGasBound(100000, used);
    }

    function testMockManagerEntryGuardsRejectOperationsWhileUnlocked() public {
        _adopt(12, 11);
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
        _adopt(12, 11); _credit(11, 100, 0);
        vault.forceNonce(type(uint64).max);
        uint64 policyVersion = vault.policy().version;
        uint64 generation = vault.authorityGeneration();
        vm.expectRevert(DominoVault.NonceExhausted.selector); harness.validateAuthority(policyVersion, type(uint64).max, generation);
        vm.expectRevert(DominoVault.NonceExhausted.selector); vault.rearmRoot(true);
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
        harness.validateAuthority(policyVersion, nonce, generation);
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
        harness.validateAuthority(version, nonce, type(uint64).max);
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
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "mock safe transfer failed")); harness.adoptChild(12, 11, true);
        require(!vault.position(12).known && positions.ownerOf(12) == owner && vault.stateNonce() == nonce,
            "failed transfer left registration");
    }

    /// V3 only: the typed refusal comes from `onERC721Received`, which exists
    /// because V3 adopts children by safe transfer. V4 declares no receiver
    /// hook at all, so the same push reverts without data - see the V4 suite.
    function testDirectRootOrForeignNFTTransferCannotMasqueradeAsAdoption() public {
        vm.expectRevert(ICustodyVault.UnexpectedCallback.selector); positions.safeTransferFrom(owner, address(vault), 11);
        positions.mint(owner, 12, key, -300, 900, 500);
        vm.expectRevert(ICustodyVault.UnexpectedCallback.selector); positions.safeTransferFrom(owner, address(vault), 12);
        require(positions.ownerOf(11) == owner && positions.subscriber(11) == address(vault), "root rollback failed");
        require(positions.ownerOf(12) == owner && !vault.position(12).known, "unsolicited NFT accepted");
    }

    /// V3 only: V3's ERC20 branch demands the recipient-side receipt on every
    /// payout, so a taxing token strands the surplus. V4 requires it of the
    /// financial path alone (`28eeaa9`) - pinned separately in the V4 suite.
    function testTaxedUntrackedRecoveryStillRejectsExactPayoutMismatchAtBothAmounts() public {
        _fund(key.currency1, 1000);
        MockERC20(key.currency1).configureTransfer(0, 100);
        uint64 nonce = vault.stateNonce();
        vm.expectRevert(ICustodyVault.TransferFailed.selector); vault.recoverUntrackedCurrency(key.currency1, 100);
        vm.expectRevert(ICustodyVault.TransferFailed.selector); vault.recoverUntrackedCurrency(key.currency1, 1000);
        require(vault.stateNonce() == nonce && vault.accountedCurrency(key.currency1) == 0 &&
            _balance(key.currency1, address(vault)) == 1000 && _balance(key.currency1, owner) == 0,
            "taxed surplus recovery mutated state");
        MockERC20(key.currency1).configureTransfer(0, 0);
        vault.recoverUntrackedCurrency(key.currency1, 1000);
        require(_balance(key.currency1, owner) == 1000, "untaxed recovery positive control failed");
    }

    /// V3 only: `_payExact` demands the recipient-side receipt on every ERC20
    /// payout, so a taxing token rolls the whole withdrawal back and the
    /// reserve stays where it is. V4 absorbs the tax instead - see the note on
    /// testTaxedUntrackedRecoveryStillRejectsExactPayoutMismatchAtBothAmounts.
    function testERC20TransferFeeRollsBackTheEntireWithdrawal() public {
        _credit(11, 0, 1000);
        bytes32 source1 = vault.position(11).source1;
        uint64 nonce = vault.stateNonce();
        MockERC20(key.currency1).configureTransfer(0, 100);
        vm.expectRevert(ICustodyVault.TransferFailed.selector);
        vault.withdrawFeeReserves(source1, key.currency1, 100, 0);
        require(vault.feeBalance(source1, key.currency1).original == 1000 && vault.stateNonce() == nonce,
            "taxed payout changed state");
        require(_balance(key.currency1, address(vault)) == 1000 && _balance(key.currency1, owner) == 0,
            "taxed payout moved tokens");
        MockERC20(key.currency1).configureTransfer(0, 0);

        // The two halves of the exactness check are not interchangeable. A
        // token that burns from the sender credits the recipient exactly what
        // it was sent, so only the vault-side clause can refuse it - mutation
        // found that clause deletable with the suite green before this case.
        MockERC20(key.currency1).configureSenderSurcharge(100);
        vm.expectRevert(ICustodyVault.TransferFailed.selector);
        vault.withdrawFeeReserves(source1, key.currency1, 100, 0);
        require(vault.feeBalance(source1, key.currency1).original == 1000 && vault.stateNonce() == nonce &&
            _balance(key.currency1, address(vault)) == 1000, "an over-debiting token moved state");
        MockERC20(key.currency1).configureSenderSurcharge(0);

        _withdraw(11, key.currency1, 1000, 0);
    }

    /// V3 only: it turns on `validateAuthority`, the pre-execution check V3
    /// exposes on the vault. V4 has no such entry point - the engine reaches
    /// the same decision through the routing helper.
    function testPolicyAndLimitsRemainIndependentAndInvalidateOldAuthority() public {
        uint64 oldNonce = vault.stateNonce();
        uint64 generation = vault.authorityGeneration();
        IDominoVaultDraft.Policy memory next = vault.policy();
        next.version++; next.triggerDistanceBps = 100; next.maxOverlapBps = 1700;
        vault.setPolicy(next);
        require(vault.stateNonce() == oldNonce + 1, "policy nonce not exact");
        IDominoVaultDraft.Policy memory stored = vault.policy();
        require(stored.triggerDistanceBps == 100 && stored.maxOverlapBps == 1700, "geometry coupled");
        vm.expectRevert(); harness.validateAuthority(1, oldNonce, generation);
        T.ExecutionLimits memory limits = vault.executionLimits(); limits.version++; limits.upsideBps = 4000;
        vault.setExecutionLimits(limits);
        require(vault.stateNonce() == oldNonce + 2, "limits nonce not exact");
        require(vault.executionLimits().upsideBps == 4000, "limits unchanged");
    }

    /// V3 only: it turns on `validateAuthority`, the pre-execution check V3
    /// exposes on the vault. V4 has no such entry point - the engine reaches
    /// the same decision through the routing helper.
    function testRootTransferAwayAndBackRequiresRearmEvenIfCallbackSuppressed() public {
        positions.setSuppressUnsubscribeCallback(true);
        positions.transferFrom(owner, STRANGER, 11);
        vm.prank(STRANGER); positions.transferFrom(STRANGER, owner, 11);
        positions.approve(address(vault), 11);
        require(!vault.rootPermissionValid(), "cleared subscription ignored");
        uint64 policyVersion = vault.policy().version;
        uint64 nonce = vault.stateNonce();
        uint64 authority = vault.authorityGeneration();
        vm.expectRevert(ICustodyVault.PermissionUnavailable.selector); harness.validateAuthority(policyVersion, nonce, authority);
        bytes32 source0 = vault.position(11).source0;
        uint64 generation = vault.authorityGeneration();
        vault.rearmRoot(true);
        require(vault.rootPermissionValid() && vault.authorityGeneration() > generation, "explicit rearm failed");
        require(vault.position(11).source0 == source0, "rearm reclassified historical fees");
    }
}
