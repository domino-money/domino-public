// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "../../reference/official-v4/v4-core/src/PoolManager.sol";

interface V2FixtureVm {
    function getCode(string calldata artifact) external view returns (bytes memory);
}

/// @notice Deploys the vendored v4-core PoolManager from its compiled
/// artifact. The suites import this file, so the PoolManager is part of their
/// build closure, but never `new` it: a suite that changes is recompiled
/// without the vendored contract being compiled again through IR.
library V2VendoredFixtures {
    V2FixtureVm private constant VM = V2FixtureVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deployPoolManager(address owner) internal returns (PoolManager manager) {
        bytes memory init = abi.encodePacked(VM.getCode("PoolManager.sol:PoolManager"), abi.encode(owner));
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        require(deployed != address(0), "vendored PoolManager deployment");
        manager = PoolManager(deployed);
    }
}
