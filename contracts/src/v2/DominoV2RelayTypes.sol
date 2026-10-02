// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "./DominoV2Types.sol";

/// @notice What the owner signs when a relayer submits a change of range or
/// an exit for them (F2, docs/v2/F2_ZAP.md). Additive to the F0 freeze, and
/// kept beside DominoV2Types rather than in it so that no F0 source changes.
/// @dev The PositionIntent alone does not bind the amounts a change of range
/// or an exit removes, so a relayed action signed over it could be submitted
/// with zero minima and sandwiched. RelayedPositionAction nests the intent
/// with the plan's removal bounds, caps and burn flag, and the wallet shows
/// all of them. An exit signs its caps as zero. Exported with the F0 types by
/// scripts/v2/eip712_exports.py (api-contracts/v2/eip712.json).
library DominoV2RelayTypes {
    struct RelayedPositionAction {
        DominoV2Types.PositionIntent intent;
        uint128 liquidityToRemove;
        uint128 amount0MinRemoved;
        uint128 amount1MinRemoved;
        uint128 amount0Max;
        uint128 amount1Max;
        bool burn;
    }

    string internal constant RELAYED_POSITION_ACTION_TYPE =
        "RelayedPositionAction(PositionIntent intent,uint128 liquidityToRemove,uint128 amount0MinRemoved,uint128 amount1MinRemoved,uint128 amount0Max,uint128 amount1Max,bool burn)";

    /// keccak256(RELAYED_POSITION_ACTION_TYPE ‖ POOL_REF_TYPE ‖ POSITION_INTENT_TYPE),
    /// referenced types in alphabetical order. A literal, because the optimizer
    /// does not fold the concatenation and the zap has no bytes to spare;
    /// DominoV2Types.t.sol pins it to the strings and to eth_account's value.
    bytes32 internal constant RELAYED_POSITION_ACTION_TYPEHASH =
        0x6e8b248d462b87dd2bd6c5013dca851bce24d5cab8794bf2842ffe0fa7f33bde;

    function hashRelayedPositionAction(RelayedPositionAction memory action) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RELAYED_POSITION_ACTION_TYPEHASH,
                DominoV2Types.hashPositionIntent(action.intent),
                action.liquidityToRemove,
                action.amount0MinRemoved,
                action.amount1MinRemoved,
                action.amount0Max,
                action.amount1Max,
                action.burn
            )
        );
    }
}
