// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVault} from "../src/DominoVault.sol";
import {DominoCompoundEngine as Engine} from "../src/DominoCompoundEngine.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VaultE2TestHarness} from "./DominoVaultCustody.t.sol";
import {VmCompoundHeader} from "./DominoCompoundHelper.t.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";

interface VmCompoundCode { function etch(address target, bytes calldata runtime) external; }

/// @dev Callback probes only. This PM intentionally stops after a valid collect
/// callback with a distinct sentinel; it never pretends to settle real fees.
contract CompoundGuardPositions is MockPositionManager {
    error AcceptedExpectedModify();
    uint8 public attack;
    constructor(address manager) MockPositionManager(manager) {}
    function setAttack(uint8 value) external { attack = value; }
    function modifyLiquiditiesWithoutUnlock(bytes calldata actions, bytes[] calldata params) external payable {
        require(keccak256(actions) == keccak256(hex"0111") && params.length == 2, "probe reached wrong phase");
        (uint256 tokenId, uint256 liquidity, uint128 minimum0, uint128 minimum1, bytes memory hookData) =
            abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        require(liquidity == 0 && minimum0 == 0 && minimum1 == 0 && hookData.length == 0,
            "collect probe should never remove principal");
        (address c0, address c1, address recipient) = abi.decode(params[1], (address, address, address));
        (T.PoolKey memory key,) = getPoolAndPositionInfo(tokenId);
        require(c0 == key.currency0 && c1 == key.currency1 && recipient == msg.sender, "collect recipient changed");
        DominoVault vault = DominoVault(payable(msg.sender));
        if (attack == 1) { vault.notifyModifyLiquidity(tokenId, 1, 0); return; }
        if (attack == 2) { vault.notifyModifyLiquidity(tokenId, 0, 1); return; }
        if (attack == 3) return; // Missing callback must fail in the vault.
        if (attack == 4) {
            vault.notifyModifyLiquidity(tokenId, 0, 0);
            vault.notifyModifyLiquidity(tokenId, 0, 0); return;
        }
        if (attack == 5) { vault.notifyModifyLiquidity(tokenId + 1, 0, 0); return; }
        if (attack == 6) { vault.notifyUnsubscribe(tokenId); return; }
        if (attack == 7) {
            T.CompoundPlan memory empty;
            vault.compoundSelf(empty); return;
        }
        vault.notifyModifyLiquidity(tokenId, 0, 0);
        revert AcceptedExpectedModify();
    }
}

contract CompoundGuardPool is MockPoolManager {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint8 public attack;
    DominoVault public vault;
    function configure(uint8 value, DominoVault target) external { attack = value; vault = target; }
    function exttload(bytes32) external pure returns (bytes32) { return bytes32(0); }
    function unlock(bytes calldata data) external returns (bytes memory) {
        Engine engine = Engine(msg.sender);
        if (attack == 1) return engine.unlockCallback(bytes.concat(data, hex"00"));
        if (attack == 2) return bytes("");
        if (attack == 3) { engine.execute(abi.decode(data, (T.CompoundPlan))); return bytes(""); }
        if (attack >= 4) {
            // Trusted-address impersonation isolates stage checks from sender
            // checks. No such privilege exists in the production contracts.
            T.CompoundAmounts[2] memory values;
            T.Checkpoint memory point;
            vm.prank(address(engine));
            if (attack == 4) vault.compoundModify(true, 1, 0);
            if (attack == 5) vault.compoundApply(values);
            if (attack == 6) vault.compoundCheckpoint(point);
            return bytes("");
        }
        return engine.unlockCallback(data);
    }
}

contract CompoundGuardState is MockStateView {
    constructor(address manager, MockPositionManager positions) MockStateView(manager, positions) {}
    function getSlot0(bytes32) external pure returns (uint160, int24, uint24, uint24) {
        return (1 << 96, 0, 0, 3000);
    }
}

contract DominoCompoundGuardsTest {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OPERATOR = address(0x88B0B);
    address private constant STRANGER = address(0x88BAD);
    address private constant RECIPIENT = address(0x88FEE);
    bytes32 private constant HEADER = keccak256("synthetic guard header");
    CompoundGuardPool private manager;
    CompoundGuardPositions private positions;
    CompoundGuardState private state;
    MockERC20 private token;
    VaultE2TestHarness private vault;
    T.PoolKey private key;

    receive() external payable {}

    function setUp() public {
        vm.chainId(4663); vm.roll(400); vm.warp(1000);
        VmCompoundHeader(address(vm)).setBlockhash(399, HEADER);
        manager = new CompoundGuardPool();
        positions = new CompoundGuardPositions(address(manager));
        state = new CompoundGuardState(address(manager), positions);
        token = new MockERC20();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        VaultE2TestHarness implementation = new VaultE2TestHarness(
            address(this), address(manager), address(positions), address(state), RECIPIENT);
        bytes memory creation = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
            address(implementation), hex"5af43d82803e903d91602b57fd5bf3");
        address clone;
        assembly ("memory-safe") { clone := create(0, add(creation, 32), mload(creation)) }
        require(clone != address(0), "guard clone not created");
        vault = VaultE2TestHarness(payable(clone));
        positions.mint(address(this), 11, key, -600, 600, 1000);
        positions.approve(clone, 11);
        T.InitParams memory params = T.InitParams({
            rootTokenId: 11, expectedPoolId: keccak256(abi.encode(key)), baseCurrency: key.currency0,
            quoteCurrency: key.currency1, operator: OPERATOR, consentToUncollectedFees: true,
            policy: IDominoVaultDraft.Policy(200, 500, 1000, 60, 4, 1, false),
            limits: T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600)
        });
        vault.initialize(address(this), keccak256("compound callback-only fixture"), params);
        manager.configure(0, vault);
    }

    function _plan() private view returns (T.CompoundPlan memory p) {
        p.intentId = keccak256("guard intent"); p.tokenId = 11;
        p.positionIdentity = vault.position(11).identity; p.checkpointId = vault.checkpoint(11).commitment;
        p.policyVersion = vault.policy().version; p.limitsVersion = vault.executionLimits().version;
        p.stateNonce = vault.stateNonce(); p.authorityGeneration = vault.authorityGeneration();
        p.observedAtBlock = 399; p.observedBlockHash = HEADER;
        p.observedAtTimestamp = 1000; p.deadline = 1060; p.liquidityIncrease = 1;
        p.minSqrtPriceX96 = 1 << 96; p.maxSqrtPriceX96 = 1 << 96;
    }

    function _fail(T.CompoundPlan memory p, bytes4 selector) private {
        uint64 nonce = vault.stateNonce();
        bytes32 checkpoint = vault.checkpoint(11).commitment;
        vm.expectRevert(selector); vault.compoundSelf(p);
        require(vault.stateNonce() == nonce && vault.checkpoint(11).commitment == checkpoint &&
            !vault.consumedIntent(p.intentId) && vault.lastExecutionAt() == 0 && vault.rootArmed(),
            "failed attempt changed history, intent, authority or checkpoint");
    }

    function testOwnerAndOperatorReachCorrectCallbackAndFailureCanRetry() public {
        T.CompoundPlan memory p = _plan();
        _fail(p, CompoundGuardPositions.AcceptedExpectedModify.selector);
        vm.prank(OPERATOR); vm.expectRevert(CompoundGuardPositions.AcceptedExpectedModify.selector);
        vault.compoundSelf(p);
        _fail(p, CompoundGuardPositions.AcceptedExpectedModify.selector);
    }

    function testUnauthorizedPausedRevokedAndTerminalExecutionFailWithoutUnlock() public {
        T.CompoundPlan memory p = _plan();
        vm.prank(STRANGER); vm.expectRevert(DominoVault.Unauthorized.selector); vault.compoundSelf(p);
        vault.pause(); _fail(_plan(), DominoVault.PermissionUnavailable.selector);
        vault.resume(); vault.revokeOperator(); p = _plan();
        vm.prank(OPERATOR); vm.expectRevert(DominoVault.Unauthorized.selector); vault.compoundSelf(p);
        vault.forceNonce(type(uint64).max); _fail(_plan(), DominoVault.NonceExhausted.selector);
    }

    function testExactAuthorityIdentityAndAmountGuardsHavePassingPositiveControl() public {
        for (uint256 variant; variant < 10; ++variant) {
            T.CompoundPlan memory p = _plan();
            if (variant == 0) p.policyVersion++;
            if (variant == 1) p.limitsVersion++;
            if (variant == 2) p.stateNonce++;
            if (variant == 3) p.authorityGeneration++;
            if (variant == 4) p.positionIdentity = bytes32(0);
            if (variant == 5) p.checkpointId = bytes32(0);
            if (variant == 6) p.tokenId = 12;
            if (variant == 7) p.intentId = bytes32(0);
            if (variant == 8) p.liquidityIncrease = 0;
            if (variant == 9) p.liquidityIncrease = uint128(type(int128).max) + 1;
            _fail(p, Engine.InvalidExecution.selector);
        }
        _fail(_plan(), CompoundGuardPositions.AcceptedExpectedModify.selector);
    }

    function testModifyCallbackRejectsWrongValuesOmissionDuplicateAndUnsubscribe() public {
        for (uint8 attack = 1; attack <= 6; ++attack) {
            positions.setAttack(attack); _fail(_plan(), DominoVault.UnexpectedCallback.selector);
        }
        positions.setAttack(7); _fail(_plan(), DominoVault.ReentrantCall.selector);
        positions.setAttack(0); _fail(_plan(), CompoundGuardPositions.AcceptedExpectedModify.selector);
    }

    function testUnlockDataAndCallbackLifecycleAreBoundToAnOutstandingIntent() public {
        manager.configure(1, vault); _fail(_plan(), Engine.UnexpectedCallback.selector);
        manager.configure(2, vault); _fail(_plan(), Engine.UnexpectedCallback.selector);
        manager.configure(3, vault); _fail(_plan(), Engine.InvalidExecution.selector);
        manager.configure(0, vault); _fail(_plan(), CompoundGuardPositions.AcceptedExpectedModify.selector);
        Engine engine = vault.compoundEngine();
        T.CompoundPlan memory p = _plan();
        bytes memory encoded = abi.encode(p);
        vm.expectRevert(Engine.UnexpectedCallback.selector); engine.unlockCallback(encoded);
        vm.prank(address(manager)); vm.expectRevert(Engine.UnexpectedCallback.selector);
        engine.unlockCallback(encoded);
        vm.expectRevert(Engine.InvalidExecution.selector); engine.execute(p);
        // Even an exact clone caller cannot start the typed vault callbacks
        // outside compoundSelf's active, non-reentrant state machine.
        vm.prank(address(vault)); vm.expectRevert(DominoVault.UnexpectedCallback.selector); engine.execute(p);
    }

    function testPinnedEngineCannotSkipCollectOrJumpToApplyAndCheckpoint() public {
        for (uint8 attack = 4; attack <= 6; ++attack) {
            manager.configure(attack, vault); _fail(_plan(), DominoVault.UnexpectedCallback.selector);
        }
        manager.configure(0, vault); _fail(_plan(), CompoundGuardPositions.AcceptedExpectedModify.selector);
    }

    function testIdleEngineCallbacksCannotMutateEvenFromThePinnedAddress() public {
        T.CompoundAmounts[2] memory values;
        T.Checkpoint memory point;
        address[2] memory callers = [address(this), address(vault.compoundEngine())];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]); vm.expectRevert(DominoVault.UnexpectedCallback.selector);
            vault.compoundModify(false, 0, 0);
            vm.prank(callers[i]); vm.expectRevert(DominoVault.UnexpectedCallback.selector);
            vault.compoundApply(values);
            vm.prank(callers[i]); vm.expectRevert(DominoVault.UnexpectedCallback.selector);
            vault.compoundCheckpoint(point);
        }
        require(vault.stateNonce() == 1 && vault.checkpoint(11).liquidity == 1000, "idle callback changed state");
    }

    function testEngineCodeLossBlocksAuthorityButPreservesOwnerAssetRecovery() public {
        T.Position memory root = vault.position(11);
        vm.deal(address(vault), 112); token.mint(address(vault), 218);
        vault.creditOriginal(11, 100, 200);
        vault.creditConverted(root.source0, address(0), 5);
        vault.creditConverted(root.source1, address(token), 7);
        positions.mint(address(this), 12, key, -300, 900, 500);
        positions.approve(address(vault), 12); vault.adoptChild(12, 11, true);
        T.CompoundPlan memory p = _plan();
        address engine = address(vault.compoundEngine());
        bytes memory runtime = engine.code;
        VmCompoundCode(address(vm)).etch(engine, hex"");
        require(!vault.rootPermissionValid(), "missing engine left authority active");
        _fail(p, DominoVault.PermissionUnavailable.selector);
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = token.balanceOf(address(this));
        vault.pause();
        vault.withdrawFeeReserves(root.source0, address(0), 100, 5);
        vault.withdrawFeeReserves(root.source1, address(token), 200, 7);
        vault.recoverUntrackedCurrency(address(0), 7);
        vault.recoverUntrackedCurrency(address(token), 11);
        vault.withdrawChildPosition(12);
        require(address(this).balance == nativeBefore + 112 && token.balanceOf(address(this)) == tokenBefore + 218 &&
            vault.accountedCurrency(address(0)) == 0 && vault.accountedCurrency(address(token)) == 0 &&
            positions.ownerOf(12) == address(this), "engine outage trapped funds or NFT");
        VmCompoundCode(address(vm)).etch(engine, bytes.concat(runtime, hex"00"));
        require(!vault.rootPermissionValid(), "changed engine hash left authority active");
        VmCompoundCode(address(vm)).etch(engine, runtime);
        require(vault.rootPermissionValid(), "exact engine restoration did not restore code qualification");
    }
}
