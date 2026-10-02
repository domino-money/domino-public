// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {ZapTestBase} from "./ZapTestKit.sol";

/// @notice The Uniswap bytecode deployed on Base (F1c fixtures,
/// fixtures/base-8453.json), etched at its addresses with the storage its
/// constructors set. Only the suites that run on it import this file, so the
/// others stay small enough for one solc-js job.
abstract contract ZapBaseFixtures is ZapTestBase {
    function _etchFixture(address target, string memory artifact, bytes32 codehash) internal {
        bytes memory runtime = _deploy(vm.getCode(artifact)).code;
        _eq(uint256(keccak256(runtime)), uint256(codehash), "fixture code hash");
        vm.etch(target, runtime);
    }

    /// The Base (8453) v3 factory, NonfungiblePositionManager and WETH9, as deployed.
    function _installBaseV3() internal {
        _etchFixture(UniswapBase8453.V3_FACTORY, UniswapBase8453.V3_FACTORY_ARTIFACT, UniswapBase8453.V3_FACTORY_CODEHASH);
        _etchFixture(
            UniswapBase8453.V3_POSITION_MANAGER,
            UniswapBase8453.V3_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V3_POSITION_MANAGER_CODEHASH
        );
        _etchFixture(UniswapBase8453.WETH9, UniswapBase8453.WETH9_ARTIFACT, UniswapBase8453.WETH9_CODEHASH);
        _constructorStorage();
    }

    /// The Base (8453) v4 PoolManager and PositionManager, as deployed.
    function _installBaseV4() internal {
        _etchFixture(
            UniswapBase8453.V4_POOL_MANAGER,
            UniswapBase8453.V4_POOL_MANAGER_ARTIFACT,
            UniswapBase8453.V4_POOL_MANAGER_CODEHASH
        );
        _etchFixture(
            UniswapBase8453.V4_POSITION_MANAGER,
            UniswapBase8453.V4_POSITION_MANAGER_ARTIFACT,
            UniswapBase8453.V4_POSITION_MANAGER_CODEHASH
        );
        _constructorStorage();
    }

    function _constructorStorage() private {
        (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values) =
            UniswapBase8453.constructorStorage();
        for (uint256 i; i < accounts.length; ++i) {
            vm.store(accounts[i], slots[i], values[i]);
        }
    }

}
