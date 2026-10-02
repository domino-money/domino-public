// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UniswapBase8453} from "../positions/fixtures/UniswapBase8453.sol";
import {ZapBaseFixtures} from "./ZapBaseFixtures.sol";
import {ZapV4Behaviour} from "./ZapV4Behaviour.sol";

/// @notice The v4 zap against the PoolManager and PositionManager bytecode
/// deployed on Base (F1c fixtures, fixtures/base-8453.json): the build
/// Robinhood and Arbitrum also run, identical but for immutables.
contract ZapV4DeployedTest is ZapV4Behaviour, ZapBaseFixtures {
    function _deployStack() internal override returns (address, address) {
        _installBaseV4();
        return (UniswapBase8453.V4_POOL_MANAGER, UniswapBase8453.V4_POSITION_MANAGER);
    }

    function testTheStackIsTheProfileBytecode() public view {
        _eq(uint256(manager.codehash), uint256(UniswapBase8453.V4_POOL_MANAGER_CODEHASH), "pool manager");
        _eq(uint256(positions.codehash), uint256(UniswapBase8453.V4_POSITION_MANAGER_CODEHASH), "position manager");
    }
}
