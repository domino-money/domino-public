// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultV4} from "../src/DominoVaultV4.sol";
import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T, IERC721ReceiverE2} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20, E2OwnerReceiver,
    E2ForeignSubscriber, E2OwnerWithoutNFTReceiver} from "./E2Mocks.sol";

interface VmEtch {
    function etch(address target, bytes calldata runtime) external;
}

/// @dev Stands in for the pinned engine. The custody surface never calls it;
/// it only has to have code, because the vault pins its codehash at
/// construction and `_deploymentUnchanged` re-reads it on every owner path.
contract StubEngineV4 {
    address private immutable _factory;
    constructor(address factory_) { _factory = factory_; }
    /// The vault's constructor refuses an engine that does not name the same factory.
    function factory() external view returns (address) { return _factory; }
    /// Lets a test speak with the pinned engine's own address, which is the
    /// only clause of _requireExecution an outsider cannot satisfy by itself.
    function poke(address target, bytes calldata data) external returns (bool ok, bytes memory returned) {
        (ok, returned) = target.call(data);
    }
}

/// @dev Terminal-state injection exists only here, as it does for V3.
contract VaultV4TestHarness is DominoVaultV4 {
    constructor(address factory_, address pool_, address positions_, address state_, address recipient_,
        address readHelper_, address engine_)
        DominoVaultV4(factory_, pool_, positions_, state_, recipient_, readHelper_, engine_) {}
    function forceNonce(uint64 nonce) external { stateNonce = nonce; }
    function forceGeneration(uint64 generation) external { authorityGeneration = generation; }
}

/**
 * The custody surface of the vault the V4 release actually deploys.
 *
 * Until this suite existed, `DominoVaultV4` was imported by exactly one test -
 * reference/OfficialDominoExecutionV4.t.sol - which drives executions and
 * never exercises the owner's own functions or their refusals. Those were
 * covered only through DominoVault.sol, the V3 twin that shares most of this
 * contract's text and has already drifted from it (hygiene H-01, H-02 in
 * reports/CONTRACT_REVIEW_2026-09-19.md). Everything here therefore asserts
 * against V4 directly, never through the twin.
 */
contract DominoVaultV4CustodyTest is IERC721ReceiverE2 {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmEtch private constant vmEtch = VmEtch(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0xB0B);
    address private constant STRANGER = address(0xBAD);
    address private constant RECIPIENT = address(0xFEE);
    MockPoolManager private poolManager;
    MockPositionManager private positions;
    MockStateView private stateView;
    DominoVaultReadHelper private readHelper;
    StubEngineV4 private engine;
    MockERC20 private token;
    MockERC20 private secondToken;
    T.PoolKey private key;
    VaultV4TestHarness private vault;
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
        readHelper = new DominoVaultReadHelper(address(positions), address(stateView));
        engine = new StubEngineV4(address(this));
        token = new MockERC20();
        secondToken = new MockERC20();
        address a = nativePair ? address(0) : address(secondToken);
        address b = address(token);
        if (a > b) (a, b) = (b, a);
        key = T.PoolKey(a, b, 3000, 60, address(0));
        positions.mint(owner, 11, key, -600, 600, 1000);
        // This contract is the factory, so it may call initialize directly.
        VaultV4TestHarness implementation_ = new VaultV4TestHarness(address(this), address(poolManager),
            address(positions), address(stateView), RECIPIENT, address(readHelper), address(engine));
        bytes memory creation = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
            address(implementation_), hex"5af43d82803e903d91602b57fd5bf3");
        address clone;
        assembly ("memory-safe") { clone := create(0, add(creation, 32), mload(creation)) }
        require(clone != address(0), "clone deployment failed");
        vault = VaultV4TestHarness(payable(clone));
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

    // ---------------------------------------------------------------
    // The six execution* callbacks: what _requireExecution is worth
    // ---------------------------------------------------------------

    /// Every one of the six entry points the engine drives, as calldata.
    function _executionCalls() private view returns (bytes[] memory calls) {
        T.Checkpoint memory point;
        T.CompoundAmounts memory value;
        calls = new bytes[](6);
        calls[0] = abi.encodeCall(DominoVaultV4.executionModify, (11, 1, 0, 0, false));
        calls[1] = abi.encodeCall(DominoVaultV4.executionCheckpoint, (11, point));
        calls[2] = abi.encodeCall(DominoVaultV4.executionCredit, (11, 1, 1));
        calls[3] = abi.encodeCall(DominoVaultV4.executionConvert,
            (vault.position(11).source0, key.currency0, 1));
        calls[4] = abi.encodeCall(DominoVaultV4.executionApply,
            (vault.position(11).source0, key.currency0, value, address(positions), false));
        calls[5] = abi.encodeCall(DominoVaultV4.executionMint, (bytes32(uint256(1)), 11, -300, 900, 500));
    }

    function _refused(bool ok, bytes memory returned, string memory what) private pure {
        require(!ok, what);
        require(returned.length >= 4 && bytes4(returned) == DominoVaultV4.UnexpectedCallback.selector, what);
    }

    /**
     * No execution is in flight, so all six must refuse every caller - the
     * pinned engine included, because being the engine is only one of the four
     * clauses. Before this test, replacing the whole body of _requireExecution
     * with `{ }` left every V4 suite passing: a forged executionCredit could
     * fabricate fee credit against a live source and nothing would notice.
     */
    function testExecutionCallbacksRefuseEveryCallerOutsideAnExecution() external {
        bytes[] memory calls = _executionCalls();
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory out) = address(vault).call(calls[i]);
            _refused(ok, out, "owner is not the engine");

            vm.prank(STRANGER);
            (ok, out) = address(vault).call(calls[i]);
            _refused(ok, out, "stranger is not the engine");

            vm.prank(OPERATOR);
            (ok, out) = address(vault).call(calls[i]);
            _refused(ok, out, "operator is not the engine");

            // The pinned engine itself, with no execution in flight: the
            // compound flag and the entry depth are unset, so it is refused
            // exactly like an outsider.
            (ok, out) = engine.poke(address(vault), calls[i]);
            _refused(ok, out, "engine outside an execution");
        }
    }

    /// A credit forged against a live source is the concrete harm: it would be
    /// withdrawable. The guard, not the accounting, is what stops it.
    function testForgedCreditCannotFabricateAWithdrawableReserve() external {
        bytes32 source = vault.position(11).source0;
        T.FeeBalance memory before_ = vault.feeBalance(source, key.currency0);
        vm.deal(address(vault), 10 ether);
        (bool ok, bytes memory out) =
            engine.poke(address(vault), abi.encodeCall(DominoVaultV4.executionCredit, (11, 5 ether, 0)));
        _refused(ok, out, "forged credit refused even when the balance would back it");
        T.FeeBalance memory after_ = vault.feeBalance(source, key.currency0);
        require(after_.original == before_.original && after_.charged == before_.charged, "no credit moved");
    }

    // ---------------------------------------------------------------
    // The owner custody surface the release ships
    // ---------------------------------------------------------------

    /// Authorization, one matrix over every owner-only entry point. The
    /// operator is the interesting caller: it is trusted to execute, and must
    /// still be refused here.
    function testOwnerOnlyCustodyRefusesOperatorAndStranger() external {
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeCall(DominoVaultV4.setOperator, (STRANGER));
        calls[1] = abi.encodeCall(DominoVaultV4.revokeOperator, ());
        calls[2] = abi.encodeCall(DominoVaultV4.resume, ());
        calls[3] = abi.encodeCall(DominoVaultV4.rearmRoot, (true));
        calls[4] = abi.encodeCall(DominoVaultV4.withdrawFeeReserves,
            (vault.position(11).source0, key.currency0, 1, 0));
        calls[5] = abi.encodeCall(DominoVaultV4.recoverUntrackedCurrency, (key.currency0, 1));
        uint64 nonce = vault.stateNonce();
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 who; who < 2; ++who) {
                vm.prank(who == 0 ? OPERATOR : STRANGER);
                (bool ok, bytes memory out) = address(vault).call(calls[i]);
                require(!ok && bytes4(out) == DominoVaultV4.Unauthorized.selector, "owner only");
            }
        }
        require(vault.stateNonce() == nonce, "a refused call advances nothing");
    }

    /// The one asymmetry in that matrix: an operator may stop automation and
    /// may not restart it. Nothing pinned this for the shipped vault.
    function testOperatorMayPauseAndMayNotResume() external {
        vm.prank(OPERATOR);
        vault.pause();
        require(vault.policy().paused, "operator paused");
        vm.prank(OPERATOR);
        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(DominoVaultV4.resume, ()));
        require(!ok && bytes4(out) == DominoVaultV4.Unauthorized.selector, "operator may not resume");
        vault.resume();
        require(!vault.policy().paused, "owner resumed");
    }

    /**
     * The split nothing pins: at a saturated counter the ordinary paths refuse
     * and the recovery paths continue. setOperator, resume and rearmRoot call
     * _advance(false) and must revert NonceExhausted; revokeOperator and pause
     * call _advance(true) and must still work, because an owner who cannot
     * revoke an operator at a terminal nonce has lost control of the vault.
     */
    function testTerminalNonceStopsOrdinaryPathsAndNeverStopsRecovery() external {
        vault.forceNonce(type(uint64).max);
        // pause() first, so resume() reaches _advance instead of stopping at
        // its own !paused check - the guards run in a fixed order and this is
        // the only way to observe the terminal branch of resume at all.
        vault.pause();
        require(vault.policy().paused, "pause is recovery and continues at a terminal nonce");

        bytes[] memory refused = new bytes[](3);
        string[] memory names = new string[](3);
        refused[0] = abi.encodeCall(DominoVaultV4.setOperator, (STRANGER)); names[0] = "setOperator";
        refused[1] = abi.encodeCall(DominoVaultV4.resume, ());               names[1] = "resume";
        refused[2] = abi.encodeCall(DominoVaultV4.rearmRoot, (true));        names[2] = "rearmRoot";
        for (uint256 i; i < refused.length; ++i) {
            (bool ok, bytes memory out) = address(vault).call(refused[i]);
            require(!ok && bytes4(out) == DominoVaultV4.NonceExhausted.selector, names[i]);
        }

        vault.revokeOperator();
        require(!vault.isOperator(OPERATOR), "revokeOperator is recovery and continues");
    }

    /// withdrawFeeReserves refuses in a fixed order, and the order matters:
    /// an unknown source is rejected before the currency is even looked at.
    function testWithdrawFeeReservesRefusesInOrderAndNeverPaysAnEmptyReserve() external {
        bytes32 source = vault.position(11).source0;
        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.withdrawFeeReserves, (keccak256("no such source"), address(token), 1, 0)));
        require(!ok && bytes4(out) == DominoVaultV4.UnknownSource.selector, "unknown source first");

        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.withdrawFeeReserves, (source, address(0xDEAD), 1, 0)));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidCurrency.selector, "then the currency");

        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.withdrawFeeReserves, (source, key.currency0, 0, 0)));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidAmount.selector, "then a zero amount");

        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.withdrawFeeReserves, (source, key.currency0, 1, 0)));
        require(!ok && bytes4(out) == DominoVaultV4.InsufficientReserve.selector, "nothing credited yet");
    }

    /// Native is always recoverable, even for an ERC20/ERC20 pair, and nothing
    /// tracked may leave through this door.
    function testRecoverUntrackedCurrencyAdmitsNativeAndRefusesTrackedValue() external {
        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.recoverUntrackedCurrency, (address(0xDEAD), 1)));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidCurrency.selector, "a foreign currency");

        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.recoverUntrackedCurrency, (key.currency0, 0)));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidAmount.selector, "zero");

        vm.deal(address(vault), 3 ether);
        uint256 before_ = address(this).balance;
        vault.recoverUntrackedCurrency(address(0), 3 ether);
        require(address(this).balance == before_ + 3 ether, "untracked native returns to the owner");
    }

    function testSetOperatorRefusesZeroAndANoOpChange() external {
        (bool ok, bytes memory out) =
            address(vault).call(abi.encodeCall(DominoVaultV4.setOperator, (address(0))));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidTransition.selector, "zero is revokeOperator's job");
        (ok, out) = address(vault).call(abi.encodeCall(DominoVaultV4.setOperator, (OPERATOR)));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidTransition.selector, "no-op refused");
        vault.revokeOperator();
        (ok, out) = address(vault).call(abi.encodeCall(DominoVaultV4.revokeOperator, ()));
        require(!ok && bytes4(out) == DominoVaultV4.InvalidTransition.selector, "nothing left to revoke");
    }

    function testRearmRootRequiresExplicitConsent() external {
        (bool ok, bytes memory out) =
            address(vault).call(abi.encodeCall(DominoVaultV4.rearmRoot, (false)));
        require(!ok && bytes4(out) == DominoVaultV4.MissingConsent.selector, "consent is not a default");
        vault.rearmRoot(true);
        require(vault.rootArmed(), "rearmed with consent");
    }

    /// notifyBurn is reached by nothing at all today, and a revert in it
    /// bubbles through the position manager as BurnNotificationReverted - so a
    /// bug here takes away the owner's ability to burn their own root NFT.
    function testNotifyBurnRefusesAForgedCallerAndAForeignToken() external {
        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.notifyBurn, (11, address(this), 0, 0, int256(0))));
        require(!ok && bytes4(out) == DominoVaultV4.UnexpectedCallback.selector, "only the position manager");

        vm.prank(address(positions));
        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.notifyBurn, (12, address(this), 0, 0, int256(0))));
        require(!ok && bytes4(out) == DominoVaultV4.UnexpectedCallback.selector, "only the root token");

        vm.prank(address(positions));
        vault.notifyBurn(11, address(this), 0, 0, 0);
        require(!vault.rootArmed(), "a burnt root disarms the vault");
    }

    /// The fourth clause of _requireExecution, which the other tests cannot
    /// reach: the engine is at the pinned address but no longer the pinned
    /// code. Being the right address is not enough.
    function testExecutionCallbacksRefuseThePinnedAddressAtDifferentCode() external {
        bytes[] memory calls = _executionCalls();
        // Any different runtime at the same address is enough. Speak as the
        // engine with prank rather than through it: the etch replaces the
        // stub's own code, so `poke` would no longer exist to call.
        vmEtch.etch(address(engine), address(readHelper).code);
        require(!vault.rootPermissionValid(), "a re-coded engine invalidates the deployment pin");
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(address(engine));
            (bool ok, bytes memory out) = address(vault).call(calls[i]);
            _refused(ok, out, "pinned address, different code");
        }
    }

    /// The three subscriber callbacks, forged. Each is the position manager's
    /// word about the root, so each must refuse anyone else outright.
    function testSubscriberCallbacksRefuseAnyCallerButThePositionManager() external {
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(DominoVaultV4.notifySubscribe, (11, ""));
        calls[1] = abi.encodeCall(DominoVaultV4.notifyUnsubscribe, (11));
        calls[2] = abi.encodeCall(DominoVaultV4.notifyModifyLiquidity, (11, 1, 0));
        for (uint256 i; i < calls.length; ++i) {
            for (uint256 who; who < 2; ++who) {
                vm.prank(who == 0 ? STRANGER : OPERATOR);
                (bool ok, bytes memory out) = address(vault).call(calls[i]);
                _refused(ok, out, "only the position manager speaks for the root");
            }
        }
    }

    /// notifySubscribe additionally binds the payload: the identity and the
    /// generation the vault expects, and only during its own rearm window.
    function testNotifySubscribeRefusesTheRightCallerWithTheWrongPayload() external {
        vm.prank(address(positions));
        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.notifySubscribe, (11, abi.encode(bytes32(0), uint64(0)))));
        _refused(ok, out, "outside a rearm, and with a foreign payload");

        vm.prank(address(positions));
        (ok, out) = address(vault).call(abi.encodeCall(DominoVaultV4.notifySubscribe,
            (11, abi.encode(vault.sequenceIdentityHash(), vault.authorityGeneration()))));
        _refused(ok, out, "the right payload is still refused outside a rearm");
    }

    /// A liquidity change nobody asked for invalidates the root instead of
    /// being accepted: the vault trusts its own expectation, not the callback.
    function testUnexpectedLiquidityNotificationInvalidatesTheRoot() external {
        require(vault.rootArmed(), "armed to begin with");
        vm.prank(address(positions));
        vault.notifyModifyLiquidity(11, 5, 0);
        require(!vault.rootArmed(), "an unexpected change disarms rather than being believed");
    }

    function testHarnessStandsUpTheShippedVaultNotItsTwin() external view {
        require(vault.owner() == owner, "owner bound");
        require(vault.rootTokenId() == 11 && vault.rootArmed(), "root armed");
        require(vault.isOperator(OPERATOR), "operator set");
        require(vault.rootPermissionValid(), "root permission live");
        require(address(vault.readHelper()) == address(readHelper), "helper pinned");
        require(address(vault.executionEngine()) == address(engine), "engine pinned");
    }
}
