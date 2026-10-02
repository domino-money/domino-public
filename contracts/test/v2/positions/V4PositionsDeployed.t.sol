// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UniswapBase8453} from "./fixtures/UniswapBase8453.sol";
import {V4PositionsBehaviour} from "./V4PositionsBehaviour.sol";

/// @notice The v4 adapter against the PoolManager, PositionManager and
/// StateView bytecode deployed on Base (fixtures/base-8453.json), the build
/// Robinhood and Arbitrum also run (identical but for immutables).
contract V4PositionsDeployedTest is V4PositionsBehaviour {
    function _deployStack() internal override returns (address, address, address) {
        _installBaseV4();
        // The PoolManager's owner (slot 0) sets the protocol fee controller.
        vm.store(UniswapBase8453.V4_POOL_MANAGER, bytes32(0), bytes32(uint256(uint160(address(this)))));
        return (UniswapBase8453.V4_POOL_MANAGER, UniswapBase8453.V4_POSITION_MANAGER, UniswapBase8453.V4_STATE_VIEW);
    }

    function _emitsModifyPosition() internal pure override returns (bool) {
        return false;
    }

    function testFixturesAreTheProfileBytecode() public view {
        _eq(uint256(UniswapBase8453.V4_POOL_MANAGER.codehash), uint256(UniswapBase8453.V4_POOL_MANAGER_CODEHASH), "pool manager");
        _eq(
            uint256(UniswapBase8453.V4_POSITION_MANAGER.codehash),
            uint256(UniswapBase8453.V4_POSITION_MANAGER_CODEHASH),
            "position manager"
        );
        _eq(uint256(UniswapBase8453.V4_STATE_VIEW.codehash), uint256(UniswapBase8453.V4_STATE_VIEW_CODEHASH), "state view");
    }
}
