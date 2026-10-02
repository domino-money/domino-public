// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {DominoV4Positions} from "../positions/DominoV4Positions.sol";

/// @notice The v4 position steps of DominoZapV4, kept in their own code so the
/// zap fits the 24,576-byte limit. CreateX component `zap.v4.steps`.
/// @dev Stateless and configuration-free: it has no storage, no constructor
/// arguments and no funds, and runs only by DELEGATECALL from DominoZapV4's
/// unlock callback, so every PositionManager and PoolManager call it makes,
/// every payment and every approval it relies on are the zap's own. A direct
/// call is refused. The steps are DominoV4Positions (F1c), unchanged.
contract DominoZapV4Steps {
    error DirectCall();

    uint8 internal constant OP_MINT = 1;
    uint8 internal constant OP_INCREASE = 2;
    uint8 internal constant OP_WITHDRAW = 3;

    /// One position step. MINT: amount0/amount1 are the desired amounts and
    /// liquidity the minimum; INCREASE: the same on tokenId; WITHDRAW: liquidity
    /// to remove, amount0/amount1 the minima, recipient and burn as given.
    struct Call {
        uint8 op;
        DominoV2Types.PoolRef pool;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 amount0;
        uint128 amount1;
        uint128 liquidity;
        address recipient;
        bool burn;
    }

    address private immutable SELF = address(this);

    /// @notice Runs one step inside the caller's PoolManager unlock.
    /// @param m The caller's PoolManager and PositionManager.
    /// @param c The step.
    function run(DominoV4Positions.Managers memory m, Call memory c)
        external
        returns (DominoV4Positions.Result memory)
    {
        if (address(this) == SELF) revert DirectCall();
        if (c.op == OP_MINT) {
            return DominoV4Positions.mint(m, c.pool, c.tickLower, c.tickUpper, c.amount0, c.amount1, c.liquidity, c.recipient);
        }
        if (c.op == OP_INCREASE) return DominoV4Positions.increase(m, c.tokenId, c.pool, c.amount0, c.amount1, c.liquidity);
        return DominoV4Positions.withdraw(m, c.tokenId, c.pool, c.liquidity, c.amount0, c.amount1, c.recipient, c.burn);
    }
}
