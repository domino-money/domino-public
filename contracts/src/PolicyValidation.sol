// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeAccounting} from "./FeeAccounting.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";

/// @notice Shared policy validation only. No storage, authority or asset custody.
/// @dev Future vaults MUST call these guards at the actual write boundary, after
/// authorizing the owner. Wider uint types do not widen the approved bps caps.
library PolicyValidation {
    uint16 internal constant MAX_TRIGGER_DISTANCE_BPS = 2000;
    uint16 internal constant MAX_OVERLAP_BPS = 2000;

    error ExcessiveTriggerDistance();
    error ExcessiveOverlap();
    error InvalidMinimumInterval();
    error InvalidMaxPositions();
    error InvalidPolicyVersion();
    error PauseChangeRequiresTransition();
    error PositionLimitBelowMembership();

    /// @dev No policy defaults are selected. The uint32/uint8 upper bounds are
    /// representational; operational/resource ceilings need deployment review.
    function validate(IDominoVaultDraft.Policy memory next) internal pure {
        if (next.serviceFeeBps > FeeAccounting.MAX_SERVICE_FEE_BPS) revert FeeAccounting.ExcessiveFee();
        if (next.triggerDistanceBps > MAX_TRIGGER_DISTANCE_BPS) revert ExcessiveTriggerDistance();
        if (next.maxOverlapBps > MAX_OVERLAP_BPS) revert ExcessiveOverlap();
        if (next.minimumIntervalSeconds == 0) revert InvalidMinimumInterval();
        if (next.maxPositions == 0) revert InvalidMaxPositions();
        if (next.version == 0) revert InvalidPolicyVersion();
    }

    /// @dev A new sequence includes its root and starts at version 1, in an
    /// explicitly supplied paused or active state. registeredPositions is the
    /// membership the vault actually initializes, not a caller-supplied count.
    /// Initialization must be atomic and owner-bound.
    function validateInitial(IDominoVaultDraft.Policy memory initial, uint256 registeredPositions) internal pure {
        validate(initial);
        if (initial.version != 1) revert InvalidPolicyVersion();
        validateMembership(initial.maxPositions, registeredPositions);
    }

    /// @dev Validate before storage mutation. registeredPositions comes from the
    /// vault's own membership state, never from a caller-supplied count. An owner
    /// may change policy while paused, but must use resume() to restart automation.
    function validateUpdate(
        IDominoVaultDraft.Policy memory current,
        IDominoVaultDraft.Policy memory next,
        uint256 registeredPositions
    ) internal pure {
        validate(next);
        if (current.version == 0 || current.version == type(uint64).max || next.version != current.version + 1) {
            revert InvalidPolicyVersion();
        }
        if (next.paused != current.paused) revert PauseChangeRequiresTransition();
        validateMembership(next.maxPositions, registeredPositions);
    }

    function validateMembership(uint8 maxPositions, uint256 registeredPositions) private pure {
        if (registeredPositions == 0 || maxPositions < registeredPositions) {
            revert PositionLimitBelowMembership();
        }
    }
}
