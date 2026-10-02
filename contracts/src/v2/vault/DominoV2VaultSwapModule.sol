// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {DominoSwapExecutor} from "../route/DominoSwapExecutor.sol";
import {IDominoVaultSwapSteps} from "./IDominoVaultSteps.sol";

/// @notice The vaults' swap port on one chain (component vaultSwap): F1b's
/// swap-leg executor, reached by DELEGATECALL from a vault's locked execution.
/// @dev Automation swaps carry no assisted-swap fee, so this is _executeLegs
/// alone: every leg accepted by its effect on the vault (exactly amountIn of
/// its input out, at least minAmountOut of its output in, no other tracked
/// balance moved, no allowance left), with the pool currencies tracked as
/// well. Its callbacks reach it through the vault and authenticate the v3 pool
/// being swapped on or the PoolManager with the pending leg. Called directly,
/// outside a vault's lock, it refuses to run. Its immutables are the chain's
/// route profile, shared by the v3 and v4 vault implementations.
contract DominoV2VaultSwapModule is DominoSwapExecutor, IDominoVaultSwapSteps {
    constructor(RouteConfig memory config) DominoSwapExecutor(config) {}

    function swap(DominoV2Types.SwapLeg[] calldata legs, address tokenIn, address tokenOut) external {
        address[] memory tracked = new address[](2);
        (tracked[0], tracked[1]) = (tokenIn, tokenOut);
        _executeLegs(legs, tracked);
    }
}
