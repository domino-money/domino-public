// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice DRAFT integration boundary. Not an implemented or audited vault.
/// @dev No deployable public vault, swaps, or operator withdrawals are supplied.
/// Every implementation MUST use PolicyValidation at initialization and every
/// policy write, enforce the callers below, and emit events only for completed
/// changes. A test-only policy harness demonstrates these requirements without
/// holding assets. Operator registration/revocation remains a separate design.
interface IDominoVaultDraft {
    struct Policy {
        /// @dev 0..200 bps inclusive; same hard ceiling as FeeAccounting. No default.
        uint16 serviceFeeBps;
        /// @dev 0..2000 bps inclusive; independent of maxOverlapBps. No default.
        uint16 triggerDistanceBps;
        /// @dev 0..2000 bps inclusive; independent of triggerDistanceBps. No default.
        uint16 maxOverlapBps;
        /// @dev 1..type(uint32).max seconds inclusive. Zero is invalid; no default.
        /// The type ceiling is representational, not an approved operational limit.
        uint32 minimumIntervalSeconds;
        /// @dev 1..type(uint8).max inclusive, counting the root and registered children.
        /// Cannot be lowered below current membership. The type ceiling is not a
        /// reviewed deployment/resource cap; deployments may narrow it. No default.
        uint8 maxPositions;
        /// @dev 1..type(uint64).max. Initial version is 1; setPolicy requires current + 1.
        /// Zero, reuse, skipped versions and overflow are invalid.
        uint64 version;
        /// @dev Explicit initial state. setPolicy preserves it; only pause/resume
        /// change it. Both transitions invalidate plans by advancing stateNonce.
        bool paused;
    }

    struct CompoundSelfPlan {
        bytes32 intentId;
        uint256 tokenId;
        uint64 expectedPolicyVersion;
        uint64 expectedStateNonce;
        uint64 deadline;
        uint128 liquidityIncrease;
        // Enforce against proven earned-fee balances, never wallet/principal funds.
        uint128 maxGrossFee0;
        uint128 maxGrossFee1;
        uint128 minNetAdded0;
        uint128 minNetAdded1;
        uint160 minSqrtPriceX96;
        uint160 maxSqrtPriceX96;
    }
    /// @dev A completed owner policy write; stateNonce also advances exactly once.
    event PolicyChanged(uint64 indexed version);
    event AutomationPaused(address indexed caller, uint64 indexed policyVersion, uint64 stateNonce);
    event AutomationResumed(address indexed owner, uint64 indexed policyVersion, uint64 stateNonce);
    /// @dev Actual per-currency amounts delivered to the immutable owner. tokenId
    /// identifies registered pool/currencies; the caller cannot select a recipient.
    event FeeReservesWithdrawn(
        uint256 indexed tokenId, address indexed owner, uint128 amount0, uint128 amount1, uint64 stateNonce
    );
    /// @dev The registered child NFT actually delivered to the immutable owner.
    event ChildPositionWithdrawn(uint256 indexed tokenId, address indexed owner, uint64 stateNonce);

    /// @notice Caller: anyone. Returns the immutable owner of this sequence.
    function owner() external view returns (address);
    /// @notice Caller: anyone. Reports currently registered operator authority only.
    /// @dev Operator authority never includes resume, policy changes or withdrawals.
    function isOperator(address account) external view returns (bool);
    /// @notice Caller: anyone. Returns the stored, validated owner policy.
    function policy() external view returns (Policy memory);
    /// @notice Caller: anyone. Returns the sequence's monotonic action nonce.
    /// @dev Advance on each completed policy write, pause, resume, reserve/child
    /// withdrawal and automation action. Never wrap/reuse it: stale plans must not
    /// revive after pause/resume or any other mutation. Fail closed on exhaustion.
    function stateNonce() external view returns (uint64);
    /// @notice Caller: anyone. Reports completed intent use for replay protection.
    function intentConsumed(bytes32 intentId) external view returns (bool);
    /// @notice Caller: owner or a currently registered operator, while unpaused.
    /// @dev Validate policy version/state nonce, intent replay, expiry, membership,
    /// frequency, all plan bounds and proven fee provenance before any interaction.
    /// The caller must also enforce the reviewed economic consumption minimum or
    /// explicitly bounded subsidy; FeeAccounting intentionally permits a zero cut.
    /// No principal reduction, wallet pull, arbitrary recipient or calldata.
    function compoundSelf(CompoundSelfPlan calldata plan) external;
    /// @notice Caller: owner only. Validate and store a consecutive policy version.
    /// @dev MUST invoke PolicyValidation.validateUpdate before writing; preserve
    /// paused, respect registered membership, advance stateNonce and emit PolicyChanged.
    function setPolicy(Policy calldata next) external;
    /// @notice Caller: owner or a currently registered operator for an emergency stop.
    /// @dev Only stops automation. Reject an already-paused state, advance stateNonce
    /// and emit AutomationPaused. Owner exits remain available while paused.
    function pause() external;
    /// @notice Caller: owner only. Resume automation through an explicit transition.
    /// @dev Reject an already-active state, advance stateNonce and emit AutomationResumed.
    function resume() external;
    /// @notice Caller: owner only, including while paused or the service is offline.
    /// @dev Withdraw only this sequence's tracked reserves to its immutable owner,
    /// without a service fee. Validate membership/balances, advance stateNonce and
    /// emit actual FeeReservesWithdrawn amounts. Operators cannot call this path.
    function withdrawFeeReserves(uint256 tokenId, uint128 amount0, uint128 amount1) external;
    /// @notice Caller: owner only, including while paused or the service is offline.
    /// @dev Transfer a registered child NFT to the immutable owner without an exit
    /// toll; never substitute the root or another sequence's NFT. Update membership,
    /// advance stateNonce and emit ChildPositionWithdrawn after successful transfer.
    function withdrawChildPosition(uint256 tokenId) external;
}
