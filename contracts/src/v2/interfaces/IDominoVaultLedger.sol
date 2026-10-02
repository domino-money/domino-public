// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What a Domino V2 vault keeps per position, for the planner (F6),
/// the app (F7) and indexers. Additive to the F0 freeze (workstream F3,
/// docs/v2/F3_VAULT.md).
/// @dev Each member position has, per pool token, a Lot: `uncharged` earned
/// fees whose automation tariff has not been taken, and `charged` units
/// (swap output) whose tariff was taken on the swap input and is never taken
/// again. Spending takes charged units first, then uncharged gross with the
/// tariff cut once per source and token per execution. `idleReserves` are
/// owner reserves no member owns any more (a withdrawn or exited child's
/// leftovers): withdrawable, never spent by automation. reserves(token) of
/// IDominoVault is idle plus every member's lots.
interface IDominoVaultLedger {
    /// returnReserves: the root still has liquidity.
    error RootOpen();
    /// returnReserves: a successor is still active.
    error SuccessorActive();

    /// One member of the sequence: the root (parent 0) or a successor the
    /// vault holds. successor is the member this one funds near its ceiling.
    struct Member {
        bool active;
        uint96 parent;
        uint96 successor;
        int24 tickLower;
        int24 tickUpper;
    }

    struct Lot {
        uint128 uncharged;
        uint128 charged;
    }

    /// v3 only: the root as the NonfungiblePositionManager held it when the
    /// vault last recorded it (at arming and after each of its own steps).
    struct RootCheckpoint {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// A member's fees moved into its uncharged lots.
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    /// A source's lots swapped in one direction; the output is credited back
    /// to the same source as charged units.
    event Swapped(uint256 indexed source, bool zeroForOne, uint256 amountIn, uint256 amountOut);
    /// A position NFT the vault held without managing it went to the owner.
    event PositionRecovered(uint256 indexed tokenId);
    /// v3 only: the checkpoint the vault now compares the root against.
    event RootCheckpointed(RootCheckpoint checkpoint);

    function member(uint256 tokenId) external view returns (Member memory);
    function lot(uint256 tokenId, address token) external view returns (Lot memory);
    function idleReserves(address token) external view returns (uint256);
    /// The Domino geometry reads prices as this currency per the other one.
    /// The pool's best-ranked charge currency at creation, else currency1.
    function quoteCurrency() external view returns (address);
    function lastExecutionAt() external view returns (uint64);

    /// The owner: a position NFT the vault holds but does not manage (sent
    /// with a plain transferFrom), the root included, goes back to the owner.
    function recoverPosition(uint256 tokenId) external;

    /// v3 only, a registry operator, not under the global halt: rearms a root
    /// that is armed or was disarmed by a checkpoint mismatch (reason 5), when
    /// the only change since `previous` (the last RootCheckpointed) is more
    /// liquidity: the owner still holds it with the vault's approval, its
    /// liquidity grew, and what it is owed grew by exactly the fees the
    /// additions poked, never less (a collect) or more (a decrease). On v3
    /// anyone may add liquidity to a position. Anything else waits for the
    /// owner's rearm.
    function operatorRearm(RootCheckpoint calldata previous) external;

    /// Anyone: once the root is closed and no successor is active, every
    /// reserve of both pool tokens (idle and the root's lots, all of
    /// reserves(token)) goes to the owner and to no one else, without any
    /// charge, as exitAll pays it: a token the owner cannot receive stays
    /// idle (A8). Closed means read live from the position manager: no
    /// liquidity left, or the NFT no longer exists. Only the owner can close
    /// the root: directly, through an operator the owner approved, or through
    /// the exit mandate the owner signed. Emits ReservesWithdrawn per token
    /// paid and returns what was paid; with nothing to pay it changes nothing.
    function returnReserves() external returns (uint256 amount0, uint256 amount1);
}
