// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IDominoVault, IDominoVaultFactory} from "../../../src/v2/interfaces/IDominoVault.sol";
import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";
import {DominoV2VaultExecutor} from "../../../src/v2/vault/DominoV2VaultExecutor.sol";
import {DominoV2VaultPlan as Plan} from "../../../src/v2/vault/DominoV2VaultPlan.sol";
import {VaultHarness, HarnessV3} from "./VaultHarness.sol";
import {HarnessV4} from "./VaultHarnessV4.sol";

/// An implementation stand-in that reports any wiring and DEX.
contract FakeImplementation {
    DominoV2VaultStorage.Deployment internal _wiring;
    uint8 internal _dex;

    constructor(address factory_, uint8 dex_) {
        _wiring.factory = factory_;
        _dex = dex_;
    }

    function wiring() external view returns (DominoV2VaultStorage.Deployment memory) {
        return _wiring;
    }

    function root() external view returns (DominoV2Types.PositionRef memory) {
        return DominoV2Types.PositionRef(_dex, address(0), 0);
    }
}

/// The factory and the implementation on either DEX: one-time binding,
/// owner-only creation at a predictable address, EIP-1167 clones, and an
/// implementation and executor that are never themselves a vault.
abstract contract FactorySuite is VaultHarness {
    function deployArtifact(string memory artifact, bytes memory args) external returns (address) {
        return vm.deployCode(artifact, args);
    }

    function testGettersAndPrediction() public {
        _true(factory.dex() == _dex(), "dex");
        _true(factory.implementation() == implementation, "implementation");
        _true(factory.registry() == address(registry), "registry");
        address predicted = factory.predictVault(OWNER, 0);
        _eq(factory.nextNonce(OWNER), 0, "nonce");
        _true(!factory.isVault(predicted), "not yet");
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(OWNER, rootId, predicted);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IDominoVaultFactory.VaultCreated(OWNER, predicted, rootId, _dex(), 0);
        vm.prank(OWNER);
        address created = factory.createVault(_init(rootId, 1, 1), 0);
        _true(created == predicted, "created where predicted");
        _true(factory.isVault(created), "registered");
        _eq(factory.nextNonce(OWNER), 1, "nonce advanced");
        _true(DominoV2VaultBase(payable(created)).owner() == OWNER, "owned by its creator");
        _true(!factory.isVault(implementation), "the implementation is not a vault");
    }

    function testCloneIsEip1167() public {
        _simple();
        bytes memory expected = abi.encodePacked(
            hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
        _true(keccak256(address(vault).code) == keccak256(expected), "minimal proxy");
    }

    function testCreationNeedsTheExpectedNonce() public {
        rootId = _mintPosition(OWNER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(OWNER, rootId, factory.predictVault(OWNER, 0));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(IDominoVaultFactory.UnexpectedNonce.selector, 0, 1));
        factory.createVault(init, 1);
    }

    function testEachOwnerHasItsOwnSequence() public {
        _simple();
        address second = factory.predictVault(STRANGER, 0);
        _true(second != address(vault), "another owner, another address");
        uint256 strangerRoot = _mintPosition(STRANGER, LOWER, UPPER, ROOT_LIQUIDITY);
        _approveNft(STRANGER, strangerRoot, second);
        IDominoVault.Init memory init = _init(strangerRoot, 1, 1);
        vm.prank(STRANGER);
        _true(factory.createVault(init, 0) == second, "the stranger's own vault");
        DominoV2VaultBase third = _createVaultFor(_mintPosition(OWNER, LOWER, UPPER, 1), 1, 1);
        _true(address(third) == factory.predictVault(OWNER, 1), "the owner's second vault");
    }

    function testFactoryBindsOnlyAnImplementationBuiltForIt() public {
        FakeImplementation wrongFactory = new FakeImplementation(address(0xF00), _dex());
        try this.deployArtifact("DominoV2VaultFactory.sol:DominoV2VaultFactory", abi.encode(wrongFactory)) {
            revert Expected("an implementation built for another factory");
        } catch (bytes memory reason) {
            _true(bytes4(reason) == DominoV2VaultStorage.InvalidInit.selector, "InvalidInit");
        }
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FakeImplementation wrongDex = new FakeImplementation(predicted, 5);
        try this.deployArtifact("DominoV2VaultFactory.sol:DominoV2VaultFactory", abi.encode(wrongDex)) {
            revert Expected("an unknown DEX");
        } catch (bytes memory reason) {
            _true(bytes4(reason) == DominoV2VaultStorage.InvalidInit.selector, "InvalidInit");
        }
    }

    function testImplementationNeedsItsCoreWiring() public {
        for (uint256 i; i < 4; ++i) {
            DominoV2VaultStorage.Deployment memory bad = _wiring(address(factory), swapModule);
            if (i == 0) bad.factory = address(0);
            if (i == 1) bad.registry = address(0);
            if (i == 2) bad.priceAnchor = address(0);
            if (i == 3) bad.positionManager = address(0);
            try this.deployArtifact(_artifact(), abi.encode(bad)) {
                revert Expected("missing core wiring");
            } catch (bytes memory reason) {
                _true(bytes4(reason) == DominoV2VaultStorage.InvalidInit.selector, "InvalidInit");
            }
        }
    }

    function testTheExecutorRefusesDirectCalls() public {
        _simple();
        DominoV2VaultExecutor executor = DominoV2VaultExecutor(vault.executor());
        bytes memory raw = Plan.encode(_plan());
        vm.prank(OPERATOR);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        executor.execute(raw);
        vm.prank(EXIT_MODULE);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        executor.executeExit(rootId, _exitInstruction(0, 0));
    }

    function testTheImplementationIsNeverAVault() public {
        _simple();
        DominoV2VaultBase impl = DominoV2VaultBase(payable(implementation));
        IDominoVault.Init memory init = _init(rootId, 1, 1);
        vm.prank(address(factory));
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        impl.initialize(OWNER, init);
        _true(impl.owner() == address(0), "no owner");
        vm.prank(OWNER);
        vm.expectRevert(IDominoVault.Unauthorized.selector);
        impl.exitAll();
    }
}

contract DominoV2VaultFactoryV3Test is FactorySuite, HarnessV3 {}

contract DominoV2VaultFactoryV4Test is FactorySuite, HarnessV4 {}
