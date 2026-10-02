// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";

/// @notice The port through which a Domino vault swaps. The chain's
/// DominoV2VaultSwapModule fills it with F1b's swap-leg executor; positions do
/// not go through a port (the vault calls F1c's DominoV3Positions /
/// DominoV4Positions directly).
/// @dev The vault calls `swap` by DELEGATECALL inside its locked execution, so
/// the legs spend and receive the vault's own balance. An implementation:
/// - keeps no storage of its own, and namespaces any transient slot it uses;
/// - may receive the PoolManager's unlockCallback and a v3 pool's
///   uniswapV3SwapCallback through the vault (when the vault itself does not
///   hold the unlock), and authenticates them itself;
/// - moves no balance of tokenIn or tokenOut other than by the legs, and
///   leaves no allowance behind.
/// The vault checks the whole route's effect on return: exactly the plan's
/// amountIn of tokenIn left and at least its minAmountOut of tokenOut arrived.
interface IDominoVaultSwapSteps {
    function swap(DominoV2Types.SwapLeg[] calldata legs, address tokenIn, address tokenOut) external;
}
