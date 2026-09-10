// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoVaultDraft} from "../../src/IDominoVaultDraft.sol";
import {PolicyValidation} from "../../src/PolicyValidation.sol";

/// @notice TEST ONLY: synthetic policy, membership and reserve records, with no
/// tokens, NFT custody, transfers, callbacks or compound implementation. Events
/// demonstrate the intended boundary; production receipt truth remains untested.
contract PolicyWriteHarness {
    error OwnerOnly();
    error OwnerOrOperatorOnly();
    error AlreadyPaused();
    error AlreadyActive();
    error AutomationIsPaused();
    error StalePolicy();
    error StaleState();
    error UnknownPosition();
    error UnknownChild();
    error InsufficientTrackedReserve();
    error StateNonceExhausted();
    error InvalidFixture();

    address public immutable owner;
    address private immutable operator;
    IDominoVaultDraft.Policy private stored;
    uint64 public stateNonce;
    uint256 public registeredPositions;
    mapping(uint256 => bool) private knownPosition;
    mapping(uint256 => bool) private childHeld;
    mapping(uint256 => uint128[2]) private reserves;

    constructor(
        address owner_,
        address operator_,
        IDominoVaultDraft.Policy memory initial,
        uint256 root,
        uint256[] memory children
    ) {
        PolicyValidation.validateInitial(initial);
        if (owner_ == address(0)) revert InvalidFixture();
        owner = owner_;
        operator = operator_;
        knownPosition[root] = true;
        registeredPositions = children.length + 1;
        if (registeredPositions > initial.maxPositions) revert PolicyValidation.PositionLimitBelowMembership();
        for (uint256 i; i < children.length; i++) {
            if (knownPosition[children[i]]) revert InvalidFixture();
            knownPosition[children[i]] = true;
            childHeld[children[i]] = true;
        }
        stored = initial;
    }

    function policy() external view returns (IDominoVaultDraft.Policy memory) {
        return stored;
    }

    function isOperator(address account) public view returns (bool) {
        return account != address(0) && account == operator;
    }

    function setPolicy(IDominoVaultDraft.Policy calldata next) external {
        requireOwner();
        PolicyValidation.validateUpdate(stored, next, registeredPositions);
        advanceNonce();
        stored = next;
        emit IDominoVaultDraft.PolicyChanged(next.version);
    }

    function pause() external {
        requireOwnerOrOperator();
        if (stored.paused) revert AlreadyPaused();
        advanceNonce();
        stored.paused = true;
        emit IDominoVaultDraft.AutomationPaused(msg.sender, stored.version, stateNonce);
    }

    function resume() external {
        requireOwner();
        if (!stored.paused) revert AlreadyActive();
        advanceNonce();
        stored.paused = false;
        emit IDominoVaultDraft.AutomationResumed(owner, stored.version, stateNonce);
    }

    function withdrawFeeReserves(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        requireOwner();
        if (!knownPosition[tokenId]) revert UnknownPosition();
        uint128[2] storage balance = reserves[tokenId];
        if (amount0 > balance[0] || amount1 > balance[1]) revert InsufficientTrackedReserve();
        advanceNonce();
        balance[0] -= amount0;
        balance[1] -= amount1;
        emit IDominoVaultDraft.FeeReservesWithdrawn(tokenId, owner, amount0, amount1, stateNonce);
    }

    function withdrawChildPosition(uint256 tokenId) external {
        requireOwner();
        if (!childHeld[tokenId]) revert UnknownChild();
        advanceNonce();
        childHeld[tokenId] = false;
        registeredPositions--;
        // Keep the synthetic source record: leftover tracked reserves remain
        // owner-withdrawable after the child leaves the active membership.
        emit IDominoVaultDraft.ChildPositionWithdrawn(tokenId, owner, stateNonce);
    }

    function assertPlanFresh(uint64 expectedPolicyVersion, uint64 expectedStateNonce) external view {
        requireOwnerOrOperator();
        if (stored.paused) revert AutomationIsPaused();
        if (expectedPolicyVersion != stored.version) revert StalePolicy();
        if (expectedStateNonce != stateNonce) revert StaleState();
    }

    function seedReservesForTest(uint256 tokenId, uint128 amount0, uint128 amount1) external {
        requireOwner();
        if (!knownPosition[tokenId]) revert UnknownPosition();
        reserves[tokenId] = [amount0, amount1];
    }

    function reservesForTest(uint256 tokenId) external view returns (uint128[2] memory) {
        return reserves[tokenId];
    }

    function seedNonceForTest(uint64 nonce) external {
        requireOwner();
        stateNonce = nonce;
    }

    function requireOwner() private view {
        if (msg.sender != owner) revert OwnerOnly();
    }

    function requireOwnerOrOperator() private view {
        if (msg.sender != owner && !isOperator(msg.sender)) revert OwnerOrOperatorOnly();
    }

    function advanceNonce() private {
        if (stateNonce == type(uint64).max) revert StateNonceExhausted();
        stateNonce++;
    }
}
