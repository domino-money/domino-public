// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One transient lock shared by every entry point of a Domino V2
/// contract: its actions, flushOwedFees, and the swap-leg executor, which only
/// runs inside a locked action. A contract that inherits the fee ledger and the
/// executor gets one lock, so nothing a swap leg calls can flush fees or start
/// another action in the middle of one.
abstract contract DominoActionLock {
    error ReentrantCall();

    /// keccak256("domino.v2.lock") - 1
    bytes32 private constant LOCK_SLOT = 0x0c429f717eb5c55ba5abe953f78a2d066a7285a4e1b710b6979458ffe81eb0af;

    modifier nonReentrant() {
        if (_actionLocked()) revert ReentrantCall();
        assembly ("memory-safe") {
            tstore(LOCK_SLOT, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(LOCK_SLOT, 0)
        }
    }

    function _actionLocked() internal view returns (bool locked) {
        assembly ("memory-safe") {
            locked := tload(LOCK_SLOT)
        }
    }
}
