// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultFactory} from "../src/DominoVaultFactory.sol";
import {DominoVault} from "../src/DominoVault.sol";
import {DominoVaultTypes as T} from "../src/DominoVaultTypes.sol";
import {IDominoVaultDraft} from "../src/IDominoVaultDraft.sol";
import {VmE2, MockPoolManager, MockPositionManager, MockStateView, MockERC20} from "./E2Mocks.sol";

interface VmFactoryCode {
    function etch(address account, bytes calldata code) external;
}

contract DominoVaultFactoryTest {
    VmE2 private constant vm = VmE2(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmFactoryCode private constant vmCode = VmFactoryCode(address(vm));
    address private constant OWNER_A = address(0x101);
    address private constant OWNER_B = address(0x102);
    address private constant OPERATOR = address(0x103);
    address private constant FEE_RECIPIENT = address(0x104);

    MockPoolManager private manager;
    MockPositionManager private positions;
    MockStateView private state;
    MockERC20 private token;
    DominoVaultFactory private factory;
    T.PoolKey private key;

    function setUp() public {
        vm.chainId(4663);
        vm.roll(1234);
        vm.warp(1_700_000_000);
        manager = new MockPoolManager();
        positions = new MockPositionManager(address(manager));
        state = new MockStateView(address(manager), positions);
        token = new MockERC20();
        key = T.PoolKey(address(0), address(token), 3000, 60, address(0));
        factory = new DominoVaultFactory(address(manager), address(positions), address(state), FEE_RECIPIENT);
    }

    function params(uint256 root) private view returns (T.InitParams memory value) {
        value.rootTokenId = root;
        value.expectedPoolId = keccak256(abi.encode(key));
        value.baseCurrency = address(0);
        value.quoteCurrency = address(token);
        value.operator = OPERATOR;
        value.consentToUncollectedFees = true;
        value.policy = IDominoVaultDraft.Policy(200, 500, 1000, 600, 4, 1, false);
        value.limits = T.ExecutionLimits(1, 5000, 100, 100, 1_000_000_000_000, 120, 3600);
    }

    function prepare(address owner, uint256 root, uint256 nonce) private returns (address predicted) {
        positions.mint(owner, root, key, -120, 180, 1000);
        predicted = factory.predictVault(owner, nonce);
        vm.prank(owner);
        positions.approve(predicted, root);
    }

    function create(address owner, uint256 root, uint256 nonce) private returns (address vault) {
        T.InitParams memory value = params(root);
        vm.prank(owner);
        vault = factory.createVault(value, nonce);
    }

    function addressGetter(address target, string memory signature) private view returns (address value) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        require(ok && data.length == 32, "missing address getter");
        value = abi.decode(data, (address));
    }

    function assertNotCreated(address owner, uint256 nonce, address predicted) private view {
        require(factory.nextOwnerNonce(owner) == nonce, "failed action consumed nonce");
        require(!factory.isVault(predicted), "failed action registered vault");
        require(factory.vaultForSequence(factory.sequenceIdFor(owner, nonce)) == address(0), "failed sequence registry");
    }

    function testConstructorPinsValidatedManagersAndImplementation() public view {
        require(factory.poolManager() == address(manager), "pool manager pin");
        require(factory.positionManager() == address(positions), "position manager pin");
        require(factory.stateView() == address(state), "state view pin");
        require(factory.serviceFeeRecipient() == FEE_RECIPIENT, "recipient pin");
        address implementation = factory.implementation();
        require(implementation.code.length != 0 && !factory.isVault(implementation), "implementation registry");
        require(addressGetter(implementation, "factory()") == address(factory), "implementation factory");
        require(addressGetter(implementation, "poolManager()") == address(manager), "implementation manager");
    }

    function testConstructorRejectsZeroOrCodeLessPins() public {
        address[4] memory pins = [address(manager), address(positions), address(state), FEE_RECIPIENT];
        for (uint256 i; i < pins.length; ++i) {
            address saved = pins[i];
            pins[i] = address(0);
            vm.expectRevert(DominoVaultFactory.InvalidManagerConfiguration.selector);
            new DominoVaultFactory(pins[0], pins[1], pins[2], pins[3]);
            pins[i] = saved;
        }
        for (uint256 i; i < 3; ++i) {
            address saved = pins[i];
            pins[i] = address(0xdead);
            vm.expectRevert(DominoVaultFactory.InvalidManagerConfiguration.selector);
            new DominoVaultFactory(pins[0], pins[1], pins[2], pins[3]);
            pins[i] = saved;
        }
    }

    function testConstructorRejectsManagerDisagreement() public {
        MockPoolManager other = new MockPoolManager();
        MockPositionManager foreignPositions = new MockPositionManager(address(other));
        MockStateView foreignState = new MockStateView(address(other), positions);
        vm.expectRevert(DominoVaultFactory.ManagerMismatch.selector);
        new DominoVaultFactory(address(manager), address(foreignPositions), address(state), FEE_RECIPIENT);
        vm.expectRevert(DominoVaultFactory.ManagerMismatch.selector);
        new DominoVaultFactory(address(manager), address(positions), address(foreignState), FEE_RECIPIENT);
    }

    function testChainAdmissionAlsoAppliesAfterDeployment() public {
        T.InitParams memory value = params(101);
        vm.chainId(1);
        vm.expectRevert(DominoVaultFactory.UnsupportedChain.selector);
        new DominoVaultFactory(address(manager), address(positions), address(state), FEE_RECIPIENT);
        vm.expectRevert(DominoVaultFactory.UnsupportedChain.selector);
        factory.createVault(value, 0);
    }

    function testPredictionUsesOwnerNonceDomainAndExactCloneCode() public {
        address predicted = prepare(OWNER_A, 101, 0);
        bytes32 sequence = keccak256(
            abi.encode(
                keccak256("DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)"),
                uint256(4663),
                address(factory),
                OWNER_A,
                uint256(0)
            )
        );
        require(factory.sequenceIdFor(OWNER_A, 0) == sequence, "sequence preimage");
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
        );
        address independentPrediction = address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(factory), sequence, keccak256(initCode)))))
        );
        require(predicted == independentPrediction && predicted.code.length == 0, "CREATE2 prediction");
        address vault = create(OWNER_A, 101, 0);
        require(vault == predicted, "deployed address differs");
        require(
            keccak256(vault.code)
                == keccak256(
                    abi.encodePacked(
                        hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3"
                    )
                ),
            "unexpected delegate target/runtime"
        );
        require(factory.isVault(vault) && factory.vaultForSequence(sequence) == vault, "registration");
        require(factory.nextOwnerNonce(OWNER_A) == 1, "owner nonce");
        require(addressGetter(vault, "owner()") == OWNER_A, "immutable caller owner");
        require(addressGetter(vault, "factory()") == address(factory), "factory binding");
        require(addressGetter(vault, "positionManager()") == address(positions), "manager binding");
        require(addressGetter(vault, "stateView()") == address(state), "state binding");
        require(addressGetter(vault, "serviceFeeRecipient()") == FEE_RECIPIENT, "fee recipient binding");
        DominoVault deployed = DominoVault(payable(vault));
        require(
            deployed.implementation() == factory.implementation() && deployed.implementationVersion() == 1,
            "implementation version binding"
        );
        require(deployed.sequenceId() == sequence && deployed.rootTokenId() == 101, "sequence/root binding");
        require(deployed.policy().version == 1 && deployed.executionLimits().version == 1, "initial policy versions");
        require(deployed.stateNonce() == 1 && deployed.authorityGeneration() == 1, "initial authority versions");
        require(positions.ownerOf(101) == OWNER_A && positions.getApproved(101) == vault, "root custody");
        require(positions.subscriber(101) == vault, "root subscription");
        require(!positions.isApprovedForAll(OWNER_A, vault), "unrequested global approval");
    }

    function testAnotherCallerCannotFrontRunAnOwnersPrediction() public {
        address predicted = prepare(OWNER_A, 101, 0);
        require(factory.predictVault(OWNER_B, 0) != predicted, "owners share CREATE2 salt");
        T.InitParams memory value = params(101);
        vm.prank(OWNER_B);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector);
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        assertNotCreated(OWNER_B, 0, factory.predictVault(OWNER_B, 0));
        require(predicted.code.length == 0, "attacker deployed victim vault");
        require(create(OWNER_A, 101, 0) == predicted, "victim cannot initialize after failed front-run");
    }

    function testStaleAndSkippedOwnerNoncesCannotDeploy() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSelector(DominoVaultFactory.UnexpectedOwnerNonce.selector, 0, 1));
        factory.createVault(value, 1);
        assertNotCreated(OWNER_A, 0, predicted);
        create(OWNER_A, 101, 0);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSelector(DominoVaultFactory.UnexpectedOwnerNonce.selector, 1, 0));
        factory.createVault(value, 0);
        require(factory.nextOwnerNonce(OWNER_A) == 1 && factory.isVault(predicted), "replay mutated registry");
    }

    function testTwoOwnersAndTwoSequencesRemainIsolated() public {
        address a0 = prepare(OWNER_A, 101, 0);
        address a1 = prepare(OWNER_A, 102, 1);
        address b0 = prepare(OWNER_B, 201, 0);
        require(a0 != a1 && a0 != b0 && a1 != b0, "prediction collision");
        require(create(OWNER_A, 101, 0) == a0 && create(OWNER_B, 201, 0) == b0, "independent owner nonces");
        require(create(OWNER_A, 102, 1) == a1, "second sequence");
        require(factory.nextOwnerNonce(OWNER_A) == 2 && factory.nextOwnerNonce(OWNER_B) == 1, "shared owner nonce");
        require(addressGetter(a0, "owner()") == OWNER_A && addressGetter(a1, "owner()") == OWNER_A, "owner A");
        require(addressGetter(b0, "owner()") == OWNER_B, "owner B");
        require(
            positions.subscriber(101) == a0 && positions.subscriber(102) == a1 && positions.subscriber(201) == b0,
            "cross-sequence subscription"
        );
    }

    function testGlobalApprovalAloneDoesNotBootstrapRoot() public {
        positions.mint(OWNER_A, 101, key, -120, 180, 1000);
        address predicted = factory.predictVault(OWNER_A, 0);
        vm.prank(OWNER_A);
        positions.setApprovalForAll(predicted, true);
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVault.PermissionUnavailable.selector);
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        vm.prank(OWNER_A);
        positions.approve(predicted, 101);
        require(create(OWNER_A, 101, 0) == predicted, "individual approval did not bootstrap");
    }

    function testImplementationAndCloneCannotBeInitializedAgain() public {
        T.InitParams memory value = params(101);
        address implementation = factory.implementation();
        bytes32 sequence = factory.sequenceIdFor(OWNER_A, 0);
        // Even the designated factory cannot initialize the implementation.
        vm.prank(address(factory));
        vm.expectRevert(DominoVault.AlreadyInitialized.selector);
        DominoVault(payable(implementation)).initialize(OWNER_A, sequence, value);
        require(addressGetter(implementation, "owner()") == address(0), "implementation acquired owner");
        address predicted = prepare(OWNER_A, 101, 0);
        create(OWNER_A, 101, 0);
        vm.prank(OWNER_B);
        vm.expectRevert(DominoVault.Unauthorized.selector);
        DominoVault(payable(predicted)).initialize(OWNER_B, sequence, value);
        vm.prank(address(factory));
        vm.expectRevert(DominoVault.AlreadyInitialized.selector);
        DominoVault(payable(predicted)).initialize(OWNER_B, sequence, value);
        require(addressGetter(predicted, "owner()") == OWNER_A, "reinitialization replaced owner");
    }

    function testCreate2CollisionLeavesNonceAndRegistryUnchanged() public {
        address predicted = prepare(OWNER_A, 101, 0);
        vmCode.etch(predicted, hex"00"); // Fault injection; outsiders cannot deploy from this factory's CREATE2 origin.
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVaultFactory.VaultDeploymentFailed.selector);
        factory.createVault{gas: 500_000}(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
    }

    function testOwnerNonceExhaustionDoesNotWrap() public {
        // Storage fault injection reaches the uint256 boundary without 2**256 calls.
        bytes32 slot = keccak256(abi.encode(OWNER_A, uint256(0)));
        vm.store(address(factory), slot, bytes32(type(uint256).max));
        require(factory.nextOwnerNonce(OWNER_A) == type(uint256).max, "nonce injection layout changed");
        T.InitParams memory value = params(101);
        vm.prank(OWNER_A);
        vm.expectRevert(DominoVaultFactory.OwnerNonceExhausted.selector);
        factory.createVault(value, type(uint256).max);
        require(factory.nextOwnerNonce(OWNER_A) == type(uint256).max, "nonce wrapped");
    }

    function testInitializationCallbackCannotReenterFactory() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        positions.configureSubscribeReentry(address(factory), abi.encodeCall(factory.createVault, (value, 0)), false);
        create(OWNER_A, 101, 0);
        require(positions.subscribeReentryAttempted() && !positions.subscribeReentrySucceeded(), "reentry outcome");
        require(
            keccak256(positions.subscribeReentryResult())
                == keccak256(abi.encodeWithSelector(DominoVaultFactory.ReentrantCreate.selector)),
            "reentry guard error"
        );
        require(factory.isVault(predicted) && factory.nextOwnerNonce(OWNER_A) == 1, "outer create failed");
        require(factory.nextOwnerNonce(address(positions)) == 0, "callback consumed owner nonce");
    }

    function testSubscriptionFailureRollsBackCloneRegistryAndAllowsIdenticalRetry() public {
        address predicted = prepare(OWNER_A, 101, 0);
        T.InitParams memory value = params(101);
        positions.configureSubscribeReentry(address(factory), abi.encodeCall(factory.createVault, (value, 0)), true);
        vm.prank(OWNER_A);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "mock subscribe reentry failed"));
        factory.createVault(value, 0);
        assertNotCreated(OWNER_A, 0, predicted);
        require(predicted.code.length == 0 && positions.subscriber(101) == address(0), "incomplete rollback");
        require(positions.getApproved(101) == predicted, "existing individual approval lost");
        positions.configureSubscribeReentry(address(0), "", false);
        require(create(OWNER_A, 101, 0) == predicted, "same CREATE2 retry failed");
    }

    function testSuccessfulCreationEventMatchesRegistry() public {
        address predicted = prepare(OWNER_A, 101, 0);
        bytes32 sequence = factory.sequenceIdFor(OWNER_A, 0);
        vm.recordLogs();
        create(OWNER_A, 101, 0);
        VmE2.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory)) continue;
            require(logs[i].topics.length == 4, "event topic count");
            require(
                logs[i].topics[0] == keccak256("VaultCreated(address,bytes32,address,uint256,address)"), "event type"
            );
            require(logs[i].topics[1] == bytes32(uint256(uint160(OWNER_A))), "event owner");
            require(
                logs[i].topics[2] == sequence && logs[i].topics[3] == bytes32(uint256(uint160(predicted))),
                "event identity"
            );
            (uint256 nonce, address implementation) = abi.decode(logs[i].data, (uint256, address));
            require(nonce == 0 && implementation == factory.implementation(), "event payload");
            ++found;
        }
        require(found == 1 && factory.vaultForSequence(sequence) == predicted, "missing committed creation event");
    }
}
