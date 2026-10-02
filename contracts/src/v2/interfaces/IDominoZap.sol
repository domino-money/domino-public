// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IDominoPositionActions} from "./IDominoPositionActions.sol";

/// @notice What the stateless zap adds to IDominoPositionActions (#283 S1,
/// docs/v2/F2_ZAP.md): owner actions that a relayer submits with the owner's
/// signature, the nonces of those signatures, and the receipt events.
/// @dev Additive to the F0 freeze. Who the owner is, per entry point:
/// - create, increase, changeRange, exit: msg.sender;
/// - createWithPermit, increaseWithPermit: intent.recipient, whose Permit2
///   signature carries the PositionIntent as witness (permit.nonce must equal
///   intent.nonce, so Permit2 consumes it);
/// - changeRangeWithSignature, exitWithSignature: the position's current
///   owner, who signs a DominoV2RelayTypes.RelayedPositionAction (domain
///   Domino/2, this zap); intent.nonce is consumed here.
/// Every action on an existing position requires its current owner, so the
/// approval a v4 or v3 position keeps on the zap serves nobody else.
interface IDominoZap {
    error InvalidSignature();
    error NonceUsed(address owner, uint256 nonce);

    /// One per input the owner provided (native currency is address(0)).
    event InputPulled(bytes32 indexed intentHash, address indexed owner, address indexed token, uint256 amount);

    /// One per position step of an action. liquidityDelta > 0 added, < 0
    /// removed (0 only collected fees). amount0/amount1 are the step's net flow
    /// per pool currency: negative was paid into the pool, positive came out of
    /// it (principal and fees; a v4 increase nets the position's accrued fees).
    event PositionLiquidityChanged(
        bytes32 indexed intentHash,
        address indexed owner,
        uint256 indexed tokenId,
        DominoV2Types.PoolRef pool,
        int256 liquidityDelta,
        int256 amount0,
        int256 amount1
    );

    event NoncesInvalidated(address indexed owner, uint256 indexed word, uint256 mask);

    /// The position's owner signs DominoV2RelayTypes.RelayedPositionAction for
    /// this plan; anyone may submit it. The new position goes to intent.recipient.
    function changeRangeWithSignature(IDominoPositionActions.ChangeRangePlan calldata plan, bytes calldata signature)
        external
        returns (IDominoPositionActions.ActionResult memory result);

    /// The position's owner signs DominoV2RelayTypes.RelayedPositionAction for
    /// this plan (amount0Max and amount1Max zero); anyone may submit it.
    function exitWithSignature(IDominoPositionActions.ExitPlan calldata plan, bytes calldata signature)
        external
        returns (IDominoPositionActions.ActionResult memory result);

    /// Unordered nonces of relayed actions, as Permit2: bit (nonce & 255) of
    /// word (nonce >> 8) is set once the nonce is used or invalidated.
    function nonceBitmap(address owner, uint256 word) external view returns (uint256);

    /// Voids the caller's unused relayed-action nonces set in `mask`.
    function invalidateNonces(uint256 word, uint256 mask) external;

    /// The position manager this zap acts on (v3 NonfungiblePositionManager or v4 PositionManager).
    function positionManager() external view returns (address);

    /// Whether positions in v4 pools with a hooks contract are accepted (swap legs always may cross them).
    function hookedPoolsAllowed() external view returns (bool);
}
