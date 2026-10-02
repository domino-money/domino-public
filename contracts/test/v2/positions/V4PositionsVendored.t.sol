// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolManager} from "../../reference/official-v4/v4-core/src/PoolManager.sol";
import {StateView} from "../../reference/official-v4/v4-periphery/src/lens/StateView.sol";
import {PositionManager} from "../../reference/official-v4/v4-periphery/src/PositionManager.sol";
import {V4PositionsBehaviour} from "./V4PositionsBehaviour.sol";

/// @notice The v4 adapter against the vendored PoolManager and PositionManager
/// (contracts/test/reference), a newer build than the deployed one. The import
/// puts them in this suite's compilation; they are deployed from their artifacts
/// so that editing a test does not recompile them.
contract V4PositionsVendoredTest is V4PositionsBehaviour {
    string private constant POOL_MANAGER = "PoolManager.sol:PoolManager";
    string private constant POSITION_MANAGER = "PositionManager.sol:PositionManager";
    string private constant STATE_VIEW = "StateView.sol:StateView";

    function _deployStack() internal override returns (address manager_, address positions_, address stateView_) {
        manager_ = _deploy(abi.encodePacked(vm.getCode(POOL_MANAGER), abi.encode(address(this))));
        // Permit2, the descriptor and WETH are never called by the adapter.
        positions_ = _deploy(
            abi.encodePacked(
                vm.getCode(POSITION_MANAGER),
                abi.encode(manager_, address(0x1111), uint256(300_000), address(0x2222), address(0x3333))
            )
        );
        stateView_ = _deploy(abi.encodePacked(vm.getCode(STATE_VIEW), abi.encode(manager_)));
    }

    function _emitsModifyPosition() internal pure override returns (bool) {
        return true;
    }
}
