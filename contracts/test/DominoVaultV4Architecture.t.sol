// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultV4} from "../src/DominoVaultV4.sol";
import {DominoVaultFactoryV4} from "../src/DominoVaultFactoryV4.sol";
import {DominoVaultReadHelper} from "../src/DominoVaultReadHelper.sol";
import {DominoExecutionTypes as E} from "../src/DominoExecutionTypes.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VaultV4TestHarness, StubEngineV4} from "./DominoVaultV4Custody.t.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";

interface VmArchitectureCode {
    function etch(address target, bytes calldata runtime) external;
}

/// @dev Architecture/availability evidence only. Artificial credits below use
/// the existing test harness; they are never claimed as collected trading fees.
/// Ported from the V3 architecture suite when V3 was retired: the helper pin,
/// its failure modes and what stays reachable without it are V4 properties
/// too. V4 differs in two places, both marked below: the helper is a
/// constructor argument rather than something a factory builds, and a child
/// arrives by execution mint rather than adoption.
contract DominoVaultV4ArchitectureTest {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmArchitectureCode private constant codeVm = VmArchitectureCode(address(vm));
    address private constant OTHER_OWNER = address(0x2202);
    address private constant OPERATOR = address(0x2203);
    address private constant RECIPIENT = address(0x2204);

    MockPoolManager private manager;
    MockPositionManager private positions;
    MockStateView private state;
    MockERC20 private token;
    DominoVaultFactoryV4 private factory;
    DominoVaultReadHelper private readHelper;
    StubEngineV4 private engine;
    DominoVaultV4 private vault;
    T.PoolKey private key;

    receive() external payable {}

    function setUp() public {
        vm.chainId(4663);
        vm.roll(400);
        vm.warp(1_700_000_000);
        manager = new MockPoolManager();
        positions = new MockPositionManager(address(manager));
        state = new MockStateView(address(manager), positions);
        token = new MockERC20();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        readHelper = new DominoVaultReadHelper(address(positions), address(state));
        factory = new DominoVaultFactoryV4(address(manager), address(positions), address(state), RECIPIENT);
        engine = new StubEngineV4(address(factory));
        factory.finalizeImplementation(address(new DominoVaultV4(address(factory), address(manager),
            address(positions), address(state), RECIPIENT, address(readHelper), address(engine))));
        vault = _create(address(this), 11);
    }

    function _params(uint256 root) private view returns (T.InitParams memory value) {
        value.rootTokenId = root;
        value.expectedPoolId = keccak256(abi.encode(key));
        value.baseCurrency = address(0);
        value.quoteCurrency = address(token);
        value.operator = OPERATOR;
        value.consentToUncollectedFees = true;
        value.policy = IDominoVaultDraft.Policy(200, 500, 1000, 60, 4, 1, false);
        value.limits = T.ExecutionLimits(1, 5000, 100, 100, 1 ether, 60, 3600);
    }

    function _prepare(address owner, uint256 root) private returns (address predicted, uint256 nonce) {
        nonce = factory.nextOwnerNonce(owner);
        predicted = factory.predictVault(owner, nonce);
        positions.mint(owner, root, key, -600, 600, 1000);
        vm.prank(owner);
        positions.approve(predicted, root);
    }

    function _create(address owner, uint256 root) private returns (DominoVaultV4 result) {
        (, uint256 nonce) = _prepare(owner, root);
        T.InitParams memory value = _params(root);
        vm.prank(owner);
        result = DominoVaultV4(payable(factory.createVault(value, nonce)));
    }

    function _assertMetadata(DominoVaultV4 target, address helper, bytes32 helperHash) private view {
        require(target.implementationVersion() == 4, "wrong immutable vault version");
        require(address(target.readHelper()) == helper && target.readHelperCodeHash() == helperHash,
            "helper metadata changed");
        require(helper != address(0) && helper.code.length != 0 && helper.codehash == helperHash,
            "helper metadata is not deployed runtime");
    }

    function testFactoryClonesShareFixedHelperWithoutSharingOwnerState() public {
        DominoVaultV4 peer = _create(OTHER_OWNER, 21);
        DominoVaultV4 implementation = DominoVaultV4(payable(factory.implementation()));
        address helper = address(vault.readHelper());
        bytes32 helperHash = vault.readHelperCodeHash();
        _assertMetadata(vault, helper, helperHash);
        _assertMetadata(peer, helper, helperHash);
        _assertMetadata(implementation, helper, helperHash);
        require(vault.owner() == address(this) && peer.owner() == OTHER_OWNER, "owner domain mixed");
        require(vault.sequenceIdentityHash() != peer.sequenceIdentityHash() &&
            vault.position(11).identity != peer.position(21).identity &&
            vault.position(11).source0 != peer.position(21).source0, "shared helper merged identities");
        bytes32 peerIdentity = peer.sequenceIdentityHash();
        bytes32 peerCheckpoint = peer.checkpoint(21).commitment;
        uint64 peerNonce = peer.stateNonce();
        vault.rearmRoot(true);
        vault.pause();
        require(peer.sequenceIdentityHash() == peerIdentity && peer.checkpoint(21).commitment == peerCheckpoint &&
            peer.stateNonce() == peerNonce && peer.rootPermissionValid() && !peer.policy().paused,
            "one clone changed another clone");
        _assertMetadata(vault, helper, helperHash);

        // V4 difference: the helper is a constructor argument the implementation
        // pins by address and codehash, not something the factory builds. A
        // second factory finalised over a fresh helper pins that one.
        DominoVaultReadHelper otherHelper = new DominoVaultReadHelper(address(positions), address(state));
        DominoVaultFactoryV4 otherFactory = new DominoVaultFactoryV4(
            address(manager), address(positions), address(state), RECIPIENT);
        StubEngineV4 otherEngine = new StubEngineV4(address(otherFactory));
        otherFactory.finalizeImplementation(address(new DominoVaultV4(address(otherFactory), address(manager),
            address(positions), address(state), RECIPIENT, address(otherHelper), address(otherEngine))));
        DominoVaultV4 otherImplementation = DominoVaultV4(payable(otherFactory.implementation()));
        require(address(otherImplementation.readHelper()) == address(otherHelper) && address(otherHelper) != helper,
            "helper pin is not the constructor argument");
        _assertMetadata(otherImplementation, address(otherHelper), address(otherHelper).codehash);
    }

    function _sequenceDigest(uint64 version) private view returns (bytes32) {
        bytes32 keyDigest = keccak256(abi.encode(
            keccak256("PoolKey(address currency0,address currency1,uint24 fee_pips,int24 tick_spacing,address hooks)"),
            key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks));
        return keccak256(abi.encode(
            keccak256("SequenceIdentity(uint256 chainId,address owner,bytes32 sequenceId,address vault,address factory,address implementation,uint64 implementationVersion,address poolManager,address positionManager,bytes32 poolKey,bytes32 poolId,address baseCurrency,address quoteCurrency,address serviceFeeRecipient)"),
            uint256(4663), address(this), vault.sequenceId(), address(vault), address(factory), factory.implementation(),
            version, address(manager), address(positions), keyDigest, keccak256(abi.encode(key)),
            key.currency0, key.currency1, RECIPIENT));
    }

    function testVersionFourUsesExistingIdentityDomainWithNewVersionValue() public view {
        require(vault.sequenceIdentityHash() == _sequenceDigest(4), "version 4 E1 identity mismatch");
        require(vault.sequenceIdentityHash() != _sequenceDigest(3), "version 3 identity replayed");
    }

    function testHelperRejectsMutationAndCustodySelectorsWithoutChangingVault() public {
        address helper = address(vault.readHelper());
        bytes32 helperHash = helper.codehash;
        bytes32 identity = vault.sequenceIdentityHash();
        uint64 nonce = vault.stateNonce();
        bytes[] memory forbidden = new bytes[](6);
        forbidden[0] = abi.encodeWithSignature("upgradeTo(address)", OTHER_OWNER);
        forbidden[1] = abi.encodeWithSignature("setReadHelper(address)", OTHER_OWNER);
        forbidden[2] = abi.encodeWithSignature("initialize(address)", OTHER_OWNER);
        forbidden[3] = abi.encodeWithSignature("execute(address,bytes)", address(vault), abi.encodeCall(vault.pause, ()));
        forbidden[4] = abi.encodeCall(vault.withdrawChildPosition, (11));
        forbidden[5] = abi.encodeCall(vault.notifyUnsubscribe, (11));
        for (uint256 i; i < forbidden.length; ++i) {
            (bool accepted,) = helper.call(forbidden[i]);
            require(!accepted, "helper accepted state/custody selector");
        }
        vm.deal(address(this), 1 ether);
        (bool received,) = helper.call{value: 1}("");
        require(!received && helper.balance == 0, "helper accepted asset custody");
        require(vault.sequenceIdentityHash() == identity && vault.stateNonce() == nonce && vault.rootPermissionValid(),
            "direct helper calls changed vault authority");
        _assertMetadata(vault, helper, helperHash);
    }

    function _assertUnavailableWithoutMutation() private {
        uint64 nonce = vault.stateNonce();
        uint64 generation = vault.authorityGeneration();
        bytes32 checkpoint = vault.checkpoint(11).commitment;
        bytes32 original = vault.registrationCheckpoint(11).commitment;
        uint64 version = vault.policy().version;
        require(vault.rootArmed() && !vault.rootPermissionValid(), "helper outage did not fail closed");
        // execute() is where V4 asks what V3's pre-flight check asked; with
        // the helper gone it is refused before any engine call.
        E.Plan memory plan;
        vm.expectRevert(DominoVaultV4.PermissionUnavailable.selector);
        vault.execute(plan);
        vm.expectRevert(DominoVaultV4.PermissionUnavailable.selector);
        vault.rearmRoot(true);
        require(vault.stateNonce() == nonce && vault.authorityGeneration() == generation && vault.rootArmed() &&
            vault.checkpoint(11).commitment == checkpoint && vault.registrationCheckpoint(11).commitment == original &&
            vault.policy().version == version, "unavailable helper mutated state");
    }

    function testMissingHelperFailsClosedAndRestorationAllowsExplicitRearm() public {
        address helper = address(vault.readHelper());
        bytes memory runtime = helper.code;
        bytes32 identity = vault.position(11).identity;
        bytes32 source0 = vault.position(11).source0;
        bytes32 initial = vault.registrationCheckpoint(11).commitment;
        codeVm.etch(helper, hex"");
        _assertUnavailableWithoutMutation();
        // External unsubscribe remains authority-reducing and independent of the helper.
        positions.unsubscribe(11);
        require(!vault.rootArmed(), "helper outage blocked invalidation");
        codeVm.etch(helper, runtime);
        require(!vault.rootPermissionValid(), "restored helper silently rearmed root");
        state.setPositionState(11, 1000, 17, 23);
        state.setFeeGrowthInside(keccak256(abi.encode(key)), -600, 600, 29, 31);
        vm.roll(401);
        vault.rearmRoot(true);
        require(vault.rootPermissionValid() && vault.checkpoint(11).feeGrowthInside0LastX128 == 17 &&
            vault.checkpoint(11).feeGrowthInside1X128 == 31 && vault.checkpoint(11).observedAtBlock == 401,
            "restored helper cannot open fresh checkpoint");
        require(vault.position(11).identity == identity && vault.position(11).source0 == source0 &&
            vault.registrationCheckpoint(11).commitment == initial, "restoration replaced initial provenance");
        require(vault.accountedCurrency(address(0)) == 0 && vault.accountedCurrency(address(token)) == 0,
            "rearm created fee credits");
    }

    function testChangedButFunctionalHelperRuntimeIsRejectedByHash() public {
        address helper = address(vault.readHelper());
        bytes memory runtime = helper.code;
        // An unreachable trailing STOP preserves callable code but changes identity.
        codeVm.etch(helper, abi.encodePacked(runtime, hex"00"));
        require(helper.code.length == runtime.length + 1 && helper.codehash != vault.readHelperCodeHash(),
            "changed-runtime control invalid");
        (T.PoolKey memory returned, int24 lower, int24 upper) =
            vault.readHelper().readPosition(keccak256(abi.encode(key)), 11);
        require(keccak256(abi.encode(returned)) == keccak256(abi.encode(key)) && lower == -600 && upper == 600,
            "changed helper did not retain functional positive control");
        _assertUnavailableWithoutMutation();
    }

    function testUnavailableHelperRollsBackFactoryCreationAndSamePredictionRetries() public {
        (address predicted, uint256 nonce) = _prepare(OTHER_OWNER, 21);
        address helper = address(vault.readHelper());
        bytes memory runtime = helper.code;
        T.InitParams memory value = _params(21);
        codeVm.etch(helper, hex"");
        vm.prank(OTHER_OWNER);
        vm.expectRevert(DominoVaultV4.ReadHelperUnavailable.selector);
        factory.createVault(value, nonce);
        require(predicted.code.length == 0 && !factory.isVault(predicted) &&
            factory.nextOwnerNonce(OTHER_OWNER) == nonce &&
            factory.vaultForSequence(factory.sequenceIdFor(OTHER_OWNER, nonce)) == address(0) &&
            positions.ownerOf(21) == OTHER_OWNER && positions.getApproved(21) == predicted &&
            positions.subscriber(21) == address(0), "failed helper initialization was not atomic");
        codeVm.etch(helper, runtime);
        vm.prank(OTHER_OWNER);
        address created = factory.createVault(value, nonce);
        require(created == predicted && DominoVaultV4(payable(created)).rootPermissionValid(),
            "same prediction could not retry after restoration");
    }

    function _fundedHarness() private returns (VaultV4TestHarness result) {
        StubEngineV4 harnessEngine = new StubEngineV4(address(this));
        VaultV4TestHarness implementation = new VaultV4TestHarness(address(this), address(manager),
            address(positions), address(state), RECIPIENT, address(readHelper), address(harnessEngine));
        bytes memory creation = abi.encodePacked(hex"3d602d80600a3d3981f3", hex"363d3d373d3d3d363d73",
            address(implementation), hex"5af43d82803e903d91602b57fd5bf3");
        address clone;
        assembly ("memory-safe") { clone := create(0, add(creation, 32), mload(creation)) }
        require(clone != address(0), "harness clone failed");
        result = VaultV4TestHarness(payable(clone));
        positions.mint(address(this), 31, key, -600, 600, 1000);
        positions.approve(clone, 31);
        result.initialize(address(this), keccak256("architecture artificial credit fixture"), _params(31));
        // V4 difference: the child arrives by execution mint, as successor 32.
        E.Plan memory plan;
        plan.action = E.MINT;
        plan.authority.tokenId = 31;
        plan.authority.intentId = keccak256("architecture fixture child");
        harnessEngine.armMint(31, -300, 900, 500);
        manager.setUnlocked(true);
        result.execute(plan);
        manager.setUnlocked(false);
        require(result.position(32).active && positions.ownerOf(32) == clone, "fixture child not minted as 32");
        vm.deal(clone, 112);
        token.mint(clone, 218);
        result.creditOriginal(31, 100, 200);
        result.creditConverted(result.position(31).source0, address(0), 5);
        result.creditConverted(result.position(31).source1, address(token), 7);
    }

    function testMissingHelperCannotBlockTrackedUntrackedOrNFTRecovery() public {
        VaultV4TestHarness funded = _fundedHarness();
        T.Position memory root = funded.position(31);
        positions.mint(address(this), 99, key, -300, 900, 500);
        positions.transferFrom(address(this), address(funded), 99);
        codeVm.etch(address(funded.readHelper()), hex"");
        require(!funded.rootPermissionValid(), "recovery fixture helper still available");
        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = token.balanceOf(address(this));
        funded.pause();
        funded.withdrawFeeReserves(root.source0, address(0), 100, 5);
        funded.withdrawFeeReserves(root.source1, address(token), 200, 7);
        funded.recoverUntrackedCurrency(address(0), 7);
        funded.recoverUntrackedCurrency(address(token), 11);
        funded.withdrawChildPosition(32);
        funded.recoverUnmanagedPosition(99);
        // Root transfer notification and its subsequent rescue also stay local.
        positions.transferFrom(address(this), address(funded), 31);
        funded.recoverUnmanagedPosition(31);
        require(address(this).balance == nativeBefore + 112 && token.balanceOf(address(this)) == tokenBefore + 218 &&
            address(funded).balance == 0 && token.balanceOf(address(funded)) == 0, "helper outage trapped currency");
        require(funded.accountedCurrency(address(0)) == 0 && funded.accountedCurrency(address(token)) == 0 &&
            funded.feeBalance(root.source0, address(0)).original == 0 &&
            funded.feeBalance(root.source0, address(0)).charged == 0 &&
            funded.feeBalance(root.source1, address(token)).original == 0 &&
            funded.feeBalance(root.source1, address(token)).charged == 0, "recovery missed accounting class");
        require(positions.ownerOf(31) == address(this) && positions.ownerOf(32) == address(this) &&
            positions.ownerOf(99) == address(this) && !funded.position(32).active && funded.activePositions() == 1 &&
            !funded.rootArmed() && funded.source(root.source0).known && funded.position(31).identity == root.identity,
            "helper outage trapped NFT or erased source history");
    }
}
