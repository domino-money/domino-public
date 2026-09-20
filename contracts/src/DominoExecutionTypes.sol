// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";
import {DominoVaultTypes as T} from "./DominoVaultTypes.sol";

/// @notice V4 fee-only execution wire. Existing V3 CompoundPlan is unchanged.
library DominoExecutionTypes {
    // GENERAL and NET increase the authority.tokenId; FUND uses an existing
    // eligible destination; MINT creates exactly one successor of that parent.
    // The routing helper admits the range once and then names GENERAL, NET
    // and MINT; FUND is what remains, and the branches that handle it say so.
    uint8 internal constant GENERAL = 0;
    uint8 internal constant NET = 1;
    uint8 internal constant FUND = 2;
    uint8 internal constant MINT = 3;
    struct PositionRef { uint256 tokenId; bytes32 positionIdentity; bytes32 checkpointId; }
    struct FeeBudget { bytes32 sourceId; address currency; uint128 maxOriginal; uint128 maxCharged; uint128 minOriginal; uint128 minCharged; }
    struct SwapPlan {
        bytes32 sourceId;
        address currencyIn;
        uint128 amountIn;
        uint128 maxOriginal;
        uint128 maxCharged;
        uint128 minAmountOut;
        uint160 sqrtPriceLimitX96;
        bytes32 priceObservationId;
    }
    struct Plan {
        T.CompoundPlan authority;
        uint8 action;
        uint256 destinationTokenId;
        int24 tickLower;
        int24 tickUpper;
        // The ceiling on what this one add may cost, per currency. minAdded0/1
        // on the authority are floors; without these the composition of the
        // add is free anywhere inside maxPriceImpactBps, which is a global
        // liveness knob, not a per-execution commitment.
        uint128 maxAdded0;
        uint128 maxAdded1;
        PositionRef[] collect;
        FeeBudget[] budgets;
        SwapPlan swap;
    }
}

interface IVaultFactoryV4 {
    function implementation() external view returns (address);
    function isVault(address) external view returns (bool);
}

interface IExecutionEngineV4 {
    function factory() external view returns (address);
    function execute(DominoExecutionTypes.Plan calldata plan) external returns (bytes32, uint256);
}

interface IPositionManagerV4 {
    function nextTokenId() external view returns (uint256);
}

interface IPriceGuardV4 {
    function referencePrice(bytes32 observationId, bytes32 poolId, uint64 observedAtBlock,
        bytes32 observedBlockHash, uint32 maxAge) external view returns (uint160);
}

interface IVaultExecutionV4 {
    function owner() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
    function stateNonce() external view returns (uint64);
    function authorityGeneration() external view returns (uint64);
    function lastExecutionAt() external view returns (uint64);
    function activePositions() external view returns (uint256);
    function consumedIntent(bytes32) external view returns (bool);
    function successorOf(uint256) external view returns (uint256);
    function baseCurrency() external view returns (address);
    function poolId() external view returns (bytes32);
    function poolKey() external view returns (T.PoolKey memory);
    function position(uint256) external view returns (T.Position memory);
    function source(bytes32) external view returns (T.Source memory);
    function checkpoint(uint256) external view returns (T.Checkpoint memory);
    function sequenceIdentityHash() external view returns (bytes32);
    function feeBalance(bytes32, address) external view returns (T.FeeBalance memory);
    function policy() external view returns (IDominoVaultDraft.Policy memory);
    function executionLimits() external view returns (T.ExecutionLimits memory);
    function executionModify(uint256, uint128, uint128, uint128, bool) external;
    function executionCredit(uint256, uint128, uint128) external;
    function executionConvert(bytes32, address, uint128) external;
    function executionCheckpoint(uint256, T.Checkpoint calldata) external;
    function executionApply(bytes32, address, T.CompoundAmounts calldata, address, bool) external;
    function executionMint(bytes32, uint256, int24, int24, uint128) external returns (uint256);
}

