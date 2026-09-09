// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice DRAFT integration boundary. Not an implemented or audited vault.
/// @dev No deployable public vault, swaps, or operator withdrawals are supplied.
interface IDominoVaultDraft {
    struct Policy {
        uint16 serviceFeeBps;
        uint16 triggerDistanceBps;
        uint16 maxOverlapBps;
        uint32 minimumIntervalSeconds;
        uint8 maxPositions;
        uint64 version;
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
    event FeesApplied(
        bytes32 indexed intentId, uint256 indexed sourceTokenId, uint256 indexed destinationTokenId,
        uint128 gross0, uint128 gross1, uint128 protocol0, uint128 protocol1,
        uint128 netAdded0, uint128 netAdded1, uint128 remaining0, uint128 remaining1
    );
    event PolicyChanged(uint64 indexed version);
    function owner() external view returns (address);
    function policy() external view returns (Policy memory);
    function stateNonce() external view returns (uint64);
    function intentConsumed(bytes32 intentId) external view returns (bool);
    function compoundSelf(CompoundSelfPlan calldata plan) external;
    function setPolicy(Policy calldata next) external;
    function pause() external;
    function withdrawFeeReserves(uint256 tokenId, uint128 amount0, uint128 amount1) external;
    function withdrawChildPosition(uint256 tokenId) external;
}
