// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "../../reference/official-v4/v4-core/src/PoolManager.sol";
import {PositionManager} from "../../reference/official-v4/v4-periphery/src/PositionManager.sol";
import {ZapV4Behaviour} from "./ZapV4Behaviour.sol";

/// @notice The v4 zap against the vendored PoolManager and PositionManager
/// (contracts/test/reference), deployed from their artifacts so that editing a
/// test does not recompile them.
contract ZapV4VendoredTest is ZapV4Behaviour {
    string private constant POOL_MANAGER = "PoolManager.sol:PoolManager";
    string private constant POSITION_MANAGER = "PositionManager.sol:PositionManager";

    function _deployStack() internal override returns (address manager_, address positions_) {
        manager_ = _deploy(abi.encodePacked(vm.getCode(POOL_MANAGER), abi.encode(address(this))));
        // The descriptor and WETH are never called by the zap.
        positions_ = _deploy(
            abi.encodePacked(
                vm.getCode(POSITION_MANAGER),
                abi.encode(manager_, PERMIT2, uint256(300_000), address(0x2222), address(0x3333))
            )
        );
    }
}
