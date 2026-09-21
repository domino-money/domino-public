// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroTestSetup} from "./shared/NitroTestSetup.sol";

import {DominoVaultV4} from "../src/DominoVaultV4.sol";
import {DominoExecutionTypes as E} from "../src/DominoExecutionTypes.sol";
import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoVaultTypes as T, IERC721ReceiverE2} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";
import {CustodyBehaviour, ICustodyVault} from "./shared/CustodyBehaviour.sol";

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

    uint256 private _parent; int24 private _lo; int24 private _hi; uint128 private _liquidity;
    /// Arm the next execute(): the vault forwards its own calldata to this
    /// engine, and the engine answers by minting one successor of `parent`
    /// through the real executionMint, then returns what execute() decodes.
    function armMint(uint256 parent, int24 lo, int24 hi, uint128 liquidity) external {
        _parent = parent; _lo = lo; _hi = hi; _liquidity = liquidity;
    }
    fallback() external {
        require(_liquidity != 0, "stub engine: nothing armed");
        uint256 id = DominoVaultV4(payable(msg.sender)).executionMint(keccak256(msg.data), _parent, _lo, _hi, _liquidity);
        _liquidity = 0;
        bytes memory out = abi.encode(keccak256(msg.data), id);
        assembly ("memory-safe") { return(add(out, 32), mload(out)) }
    }
}

/// Speaks to the vault with its own address, so a notification can arrive
/// mid-rearm from someone who is not the position manager - the only state in
/// which notifySubscribe's sender clause is the one that decides.
contract SubscribeForwarder {
    function poke(address vault, uint256 tokenId, bytes calldata data) external {
        DominoVaultV4(payable(vault)).notifySubscribe(tokenId, data);
    }
}

/// @dev Terminal-state injection exists only here, as it does for V3.
contract VaultV4TestHarness is DominoVaultV4 {
    constructor(address factory_, address pool_, address positions_, address state_, address recipient_,
        address readHelper_, address engine_)
        DominoVaultV4(factory_, pool_, positions_, state_, recipient_, readHelper_, engine_) {}
    /// The same artificial sinks the V3 harness exposes, so the shared
    /// custody behaviour can credit a reserve without an execution. In
    /// production these are reachable only through the pinned engine.
    function creditOriginal(uint256 id, uint128 amount0, uint128 amount1) external {
        _creditOriginalFees(id, amount0, amount1);
    }
    function creditConverted(bytes32 sourceId, address currency, uint128 amount) external {
        _creditConvertedFees(sourceId, currency, amount);
    }
    function forceNonce(uint64 nonce) external { stateNonce = nonce; }
    /// The V4 fee-credit sinks are reachable only through the pinned engine,
    /// so a custody test cannot credit the ledger the way the V3 harness does.
    function forceAccounted(address currency, uint256 amount) external { accountedCurrency[currency] = amount; }
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
contract DominoVaultV4CustodyTest is IERC721ReceiverE2, CustodyBehaviour {
    VmEtch private constant vmEtch = VmEtch(address(uint160(uint256(keccak256("hevm cheat code")))));
    DominoVaultReadHelper private readHelper;
    StubEngineV4 private engine;
    VaultV4TestHarness private harness;

    receive() external payable {}
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721ReceiverE2.onERC721Received.selector;
    }

    function setUp() public { _setup(address(this), true); }

    function _setup(address owner_, bool nativePair) internal override {
        NitroTestSetup.install();
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
        harness = VaultV4TestHarness(payable(clone));
        implementation = address(implementation_);
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

    // ---------------------------------------------------------------
    // The six execution* callbacks: what _requireExecution is worth
    // ---------------------------------------------------------------

    /// Every one of the six entry points the engine drives, as calldata.
    /// V4 acquires a child only by minting a successor inside an execution, so
    /// this drives the real path: execute() -> engine -> executionMint -> the
    /// position manager's MINT_POSITION, with the pool manager unlocked as it
    /// would be inside the engine's own unlock. The id is whatever the manager
    /// mints next; the shared tests count from 12, so the mock counts too.
    function _child(uint256 id, uint256 parent) internal override {
        require(positions.nextTokenId() == id, "the manager would not mint this id next");
        E.Plan memory plan;
        plan.action = E.MINT;
        plan.authority.tokenId = parent;
        plan.authority.intentId = keccak256(abi.encode("child", id, parent));
        engine.armMint(parent, -300, 900, 500);
        uint64 nonce = vault.stateNonce();
        poolManager.setUnlocked(true);
        vm.prank(owner);
        harness.execute(plan);
        poolManager.setUnlocked(false);
        require(vault.position(id).active && positions.ownerOf(id) == address(vault) &&
            vault.stateNonce() == nonce + 1, "successor mint not exact");
    }

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

    /**
     * Only the surplus above the ledger may leave by this door.
     *
     * Nothing tested this: deleting the insolvency arm of the guard entirely -
     * leaving `amount > held` - left all 213 contract tests green, which is how
     * the gap was found. The name of the test above promised this and did not
     * deliver it, because the V4 fee sinks are unreachable from a custody test.
     */
    function testRecoverUntrackedCurrencyNeverReachesTheLedgerItTracks() external {
        vm.deal(address(vault), 10 ether);
        harness.forceAccounted(address(0), 7 ether);

        (bool ok, bytes memory out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.recoverUntrackedCurrency, (address(0), 3 ether + 1)));
        require(!ok && bytes4(out) == DominoVaultV4.InsufficientReserve.selector, "one wei past the surplus");

        uint256 before_ = address(this).balance;
        vault.recoverUntrackedCurrency(address(0), 3 ether);
        require(address(this).balance == before_ + 3 ether, "exactly the surplus leaves");
        require(address(vault).balance == 7 ether, "the tracked ledger is untouched");

        // And an insolvent vault - held below what it tracks - lets nothing out
        // at all, rather than underflowing into a large allowance.
        harness.forceAccounted(address(0), 9 ether);
        (ok, out) = address(vault).call(abi.encodeCall(
            DominoVaultV4.recoverUntrackedCurrency, (address(0), 1)));
        require(!ok && bytes4(out) == DominoVaultV4.InsufficientReserve.selector, "insolvent: nothing leaves");
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
        harness.notifyBurn(11, address(this), 0, 0, 0);
        require(!vault.rootArmed(), "a burnt root disarms the vault");
    }

    /**
     * What a re-coded engine actually costs, stated as what this test shows.
     *
     * An earlier comment here claimed this reached _requireExecution's
     * codehash clause. It does not and cannot: all six callbacks are decided
     * by `_T_COMPOUND == 0` first, and that flag is transient, so no test can
     * put the vault in the state where the codehash clause would be the one
     * to fire. The pin is enforced on the path that matters instead -
     * rootPermissionValid, which execute() checks at entry - and that is what
     * is asserted below.
     */
    function testARecodedEngineBreaksTheDeploymentPinAndKeepsCallbacksRefused() external {
        bytes[] memory calls = _executionCalls();
        require(vault.rootPermissionValid(), "the pin holds before the engine is re-coded");

        // Any different runtime at the same address is enough. Speak as the
        // engine with prank rather than through it: the etch replaces the
        // stub's own code, so `poke` would no longer exist to call.
        vmEtch.etch(address(engine), address(readHelper).code);
        require(!vault.rootPermissionValid(), "and breaks once it is");
        // Every owner path that re-checks the deployment now refuses.
        (bool armed, bytes memory why) = address(vault).call(abi.encodeCall(DominoVaultV4.rearmRoot, (true)));
        require(!armed && bytes4(why) == DominoVaultV4.PermissionUnavailable.selector, "rearm refuses a re-coded engine");
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

    /**
     * notifySubscribe's last two clauses - the token it reports and the
     * identity payload it carries - are live only inside a rearm, behind two
     * transient flags a test cannot write. An earlier version of this test
     * called the function directly and was decided by the transition flag two
     * clauses earlier, so it pinned neither. Driving a rearm through a mock
     * that forwards a different token or a different payload reaches both.
     *
     * Measured with mutation: the sender, token and payload clauses each fail
     * this test when deleted. The other two do not, and the reason is the
     * guard's own shape rather than a gap here. Outside a rearm
     * `_T_TRANSITION == 0` and `_T_ENTERED != 1` are true together and mask
     * each other; inside one they are false together. `_T_ENTERED != 1` can
     * therefore never be the clause that decides - _T_TRANSITION is set only
     * inside _armRoot, reached only from two nonReentrant functions - so it is
     * redundant, not untested. `_T_TRANSITION == 0` could decide alone, but
     * only for a notification arriving during some other guarded call, which
     * no mock here can produce.
     */
    function testNotifySubscribeBindsTheTokenAndTheIdentityPayload() external {
        // Clause 1 alone is unreachable the same way: outside a rearm the
        // transition flag decides first. These two cases pin that pair.
        for (uint256 who; who < 2; ++who) {
            vm.prank(who == 0 ? STRANGER : address(positions));
            (bool ok, bytes memory out) = address(vault).call(
                abi.encodeCall(DominoVaultV4.notifySubscribe, (11, "")));
            _refused(ok, out, "refused outside a rearm");
        }

        // Mid-rearm, from a caller that is not the position manager: here the
        // sender clause is the only one that is true, so this is what pins it.
        SubscribeForwarder forwarder = new SubscribeForwarder();
        positions.configureSubscribeReentry(address(forwarder),
            abi.encodeCall(SubscribeForwarder.poke,
                (address(vault), 11, abi.encode(vault.sequenceIdentityHash(), vault.authorityGeneration() + 1))),
            false);
        vault.rearmRoot(true);
        require(!positions.subscribeReentrySucceeded(), "a stranger's notification is refused mid-rearm");
        require(bytes4(positions.subscribeReentryResult()) == DominoVaultV4.UnexpectedCallback.selector,
            "and refused as an unexpected callback");
        positions.configureSubscribeReentry(address(0), "", false);

        // A rearm that reports a different token.
        positions.setSubscribeOverride("", 12);
        (bool ok2, bytes memory out2) = address(vault).call(
            abi.encodeCall(DominoVaultV4.rearmRoot, (true)));
        _refused(ok2, out2, "the notification must name the root token");

        // A rearm whose payload is not the identity the vault armed with.
        positions.setSubscribeOverride(abi.encode(bytes32(0), uint64(0)), 0);
        (ok2, out2) = address(vault).call(abi.encodeCall(DominoVaultV4.rearmRoot, (true)));
        _refused(ok2, out2, "the payload must be this vault's identity and generation");

        // And the honest rearm still passes, so the cases above failed on the
        // clause named and not on the rearm itself.
        positions.setSubscribeOverride("", 0);
        vault.rearmRoot(true);
        require(vault.rootArmed(), "an unaltered rearm is admitted");
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
        require(address(harness.readHelper()) == address(readHelper), "helper pinned");
        require(address(harness.executionEngine()) == address(engine), "engine pinned");
    }

    /**
     * V4 declares no `onERC721Received`, so an unsolicited push cannot enter
     * the vault at all - the transfer reverts on the unrecognised selector
     * rather than on a typed guard. V3 needs the hook because `adoptChild`
     * takes a child by safe transfer; V4 has no adoption, and the only NFT it
     * ever acquires is one `executionMint` creates.
     *
     * That mint is safe without a hook, verified against the vendored official
     * source rather than assumed: `PositionManager._mint`
     * (test/reference/official-v4/v4-periphery/src/PositionManager.sol:369)
     * calls solmate's `_mint` (solmate/src/tokens/ERC721.sol:157), which does
     * not call the receiver. `_safeMint` exists beside it and is not used.
     */
    function testNoNFTCanBePushedIntoTheVaultBecauseItDeclaresNoReceiverHook() public {
        _setup(address(this), true);
        (bool ok,) = address(vault).call(abi.encodeWithSignature(
            "onERC721Received(address,address,uint256,bytes)", address(this), address(this), uint256(11), ""));
        require(!ok, "the vault answers a receiver hook it does not declare");

        vm.expectRevert();
        positions.safeTransferFrom(owner, address(vault), 11);
        positions.mint(owner, 12, key, -300, 900, 500);
        vm.expectRevert();
        positions.safeTransferFrom(owner, address(vault), 12);
        require(positions.ownerOf(11) == owner && positions.subscriber(11) == address(vault), "root rollback failed");
        require(positions.ownerOf(12) == owner && !vault.position(12).known, "unsolicited NFT accepted");
    }

    /**
     * The other half of `28eeaa9`: V4 requires the recipient-side receipt of
     * the financial path only, while the vault-side debit stays exact on every
     * payout. V3 demands both on its ERC20 branch, which strands an untracked
     * surplus for good behind a fee-on-transfer token - there is no partial
     * exit to fall back on. V3's own native branch already tolerated this, so
     * V4 made the two currencies agree.
     *
     * What must not weaken is the vault side: whatever the token does to the
     * recipient, nothing beyond `amount` may leave, because that is what keeps
     * `accountedCurrency` honest for the reserves that are tracked.
     */
    function testTaxedUntrackedRecoveryPaysOutWhileTheVaultSideDebitStaysExact() public {
        _setup(address(this), false);
        _fund(key.currency1, 1000);
        MockERC20(key.currency1).configureTransfer(0, 100);

        uint64 nonce = vault.stateNonce();
        vault.recoverUntrackedCurrency(key.currency1, 100);
        require(_balance(key.currency1, address(vault)) == 900, "the vault was debited by more than it sent");
        require(_balance(key.currency1, owner) == 99, "the tax reached the owner as a shortfall, not a revert");
        require(vault.stateNonce() > nonce, "recovery did not advance state");

        // The reserved side is untouchable either way: a tracked balance still
        // cannot be recovered as if it were surplus.
        _credit(11, 0, 400);
        vm.expectRevert(ICustodyVault.InsufficientReserve.selector);
        vault.recoverUntrackedCurrency(key.currency1, 901);
    }

    /**
     * The tracked half of the `28eeaa9` trade, and the one that has to be
     * tight. A taxing token no longer strands a fee reserve: the withdrawal
     * goes through and the owner absorbs the tax. What may not move is the
     * ledger's relationship to the vault's own balance - the reserve is
     * debited by exactly what left the vault, so the remainder is still fully
     * backed and still withdrawable once the tax is off.
     */
    function testERC20TransferFeeIsAbsorbedByTheOwnerWhileTheLedgerStaysBacked() public {
        _setup(address(this), false);
        _credit(11, 0, 1000);
        bytes32 source1 = vault.position(11).source1;
        MockERC20(key.currency1).configureTransfer(0, 100);

        _withdraw(11, key.currency1, 100, 0);
        require(_balance(key.currency1, owner) == 99, "the owner was not paid the taxed remainder");
        require(_balance(key.currency1, address(vault)) == 900, "the vault lost more than the reserve released");
        require(vault.feeBalance(source1, key.currency1).original == 900, "the ledger and the vault disagree");

        // And the vault-side debit is the half that may not weaken. A token
        // that burns from the sender takes more out of the vault than the
        // reserve released, which would leave the ledger claiming backing that
        // is no longer there - so the whole withdrawal reverts instead.
        MockERC20(key.currency1).configureSenderSurcharge(100);
        vm.expectRevert(ICustodyVault.TransferFailed.selector);
        vault.withdrawFeeReserves(source1, key.currency1, 100, 0);
        require(vault.feeBalance(source1, key.currency1).original == 900 &&
            _balance(key.currency1, address(vault)) == 900, "an over-debiting token moved state");
        MockERC20(key.currency1).configureSenderSurcharge(0);

        // Backed means withdrawable: the untaxed remainder still comes out whole.
        MockERC20(key.currency1).configureTransfer(0, 0);
        _withdraw(11, key.currency1, 900, 0);
        require(vault.feeBalance(source1, key.currency1).original == 0 &&
            _balance(key.currency1, address(vault)) == 0 && _balance(key.currency1, owner) == 999,
            "the remainder was not fully backed");
    }

    /**
     * executionMint believes the manager only when the manager did what it was
     * asked - minted the next id, and minted it to the vault - and gives a
     * parent one successor at most. The routing helper repeats the successor
     * rule before the engine is ever called; the vault is the last line and is
     * pinned on its own. All three clauses were deletable with the suite green
     * before this test.
     */
    function testExecutionMintRefusesASecondSuccessorAndAManagerThatDidSomethingElse() public {
        _child(12, 11);
        E.Plan memory plan;
        plan.action = E.MINT;
        plan.authority.tokenId = 11;
        plan.authority.intentId = keccak256("a second successor of the root");
        engine.armMint(11, -300, 900, 500);
        poolManager.setUnlocked(true);
        vm.expectRevert(DominoVaultV4.InvalidPosition.selector);
        harness.execute(plan);

        // The manager mints the id it said it would, to someone else.
        plan.authority.tokenId = 12;
        plan.authority.intentId = keccak256("a successor minted to a stranger");
        positions.setMintRecipientOverride(STRANGER);
        engine.armMint(12, -300, 900, 500);
        vm.expectRevert(DominoVaultV4.InvalidPosition.selector);
        harness.execute(plan);
        positions.setMintRecipientOverride(address(0));

        // The manager mints nothing and reports so through nextTokenId.
        plan.authority.intentId = keccak256("a successor that was never minted");
        positions.setMintNothing(true);
        engine.armMint(12, -300, 900, 500);
        vm.expectRevert(DominoVaultV4.InvalidPosition.selector);
        harness.execute(plan);
        positions.setMintNothing(false);
        poolManager.setUnlocked(false);

        require(vault.activePositions() == 2 && harness.successorOf(12) == 0 && !vault.position(13).known,
            "a refused mint registered a child");
    }
}
