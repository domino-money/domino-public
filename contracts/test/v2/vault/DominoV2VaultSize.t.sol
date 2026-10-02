// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2VaultBase} from "../../../src/v2/vault/DominoV2VaultBase.sol";
import {DominoV2VaultStorage} from "../../../src/v2/vault/DominoV2VaultStorage.sol";

interface SizeVm {
    function deployCode(string calldata artifact, bytes calldata args) external returns (address);
    function getCode(string calldata artifact) external view returns (bytes memory);
}

/// Every V2 vault contract that is ever deployed stays within EIP-170's
/// 24,576-byte runtime and EIP-3860's 49,152-byte initcode, on the build CI
/// uses (solc 0.8.26, via-IR, optimizer 200, Cancun). The executors are
/// deployed by their vault implementation's constructor, so they count inside
/// its initcode as well as on their own.
contract DominoV2VaultSizeTest {
    SizeVm internal constant vm = SizeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant RUNTIME_LIMIT = 24_576;
    uint256 internal constant INITCODE_LIMIT = 49_152;

    event Size(string name, uint256 runtimeBytes, uint256 initcodeBytes);

    error TooLarge(string name, uint256 size, uint256 limit);

    function _check(string memory name, address deployed, uint256 initcode) internal {
        if (deployed.code.length > RUNTIME_LIMIT) revert TooLarge(name, deployed.code.length, RUNTIME_LIMIT);
        if (initcode > INITCODE_LIMIT) revert TooLarge(name, initcode, INITCODE_LIMIT);
        emit Size(name, deployed.code.length, initcode);
    }

    function _wiring() internal view returns (DominoV2VaultStorage.Deployment memory) {
        address stand = address(this);
        return DominoV2VaultStorage.Deployment(stand, stand, stand, stand, stand, stand);
    }

    /// The position manager stand-in's own PoolManager (v4) and factory (v3).
    function poolManager() external view returns (address) {
        return address(this);
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function testEveryDeployableContractFits() public {
        bytes memory v3Args = abi.encode(_wiring());
        bytes memory v4Args = abi.encode(_wiring());
        address v3 = vm.deployCode("DominoV2VaultV3.sol:DominoV2VaultV3", v3Args);
        address v4 = vm.deployCode("DominoV2VaultV4.sol:DominoV2VaultV4", v4Args);
        _check("DominoV2VaultV3", v3, vm.getCode("DominoV2VaultV3.sol:DominoV2VaultV3").length + v3Args.length);
        _check("DominoV2VaultV4", v4, vm.getCode("DominoV2VaultV4.sol:DominoV2VaultV4").length + v4Args.length);
        _check(
            "DominoV2VaultExecutorV3",
            DominoV2VaultBase(payable(v3)).executor(),
            vm.getCode("DominoV2VaultV3.sol:DominoV2VaultExecutorV3").length + v3Args.length
        );
        _check(
            "DominoV2VaultExecutorV4",
            DominoV2VaultBase(payable(v4)).executor(),
            vm.getCode("DominoV2VaultV4.sol:DominoV2VaultExecutorV4").length + v4Args.length
        );
        bytes memory factoryArgs = abi.encode(address(0));
        address deployedFactory =
            vm.deployCode("DominoV2VaultFactory.sol:DominoV2VaultFactory", abi.encode(new BoundStandIn()));
        _check(
            "DominoV2VaultFactory",
            deployedFactory,
            vm.getCode("DominoV2VaultFactory.sol:DominoV2VaultFactory").length + factoryArgs.length
        );
    }
}

/// What a factory under construction needs from its implementation, bound
/// to whichever contract deploys the factory next.
contract BoundStandIn {
    function wiring() external view returns (DominoV2VaultStorage.Deployment memory deployment) {
        deployment.factory = msg.sender;
    }

    function root() external pure returns (uint8 dex, address manager, uint256 tokenId) {
        return (4, address(0), 0);
    }
}
