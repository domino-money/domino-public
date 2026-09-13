// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T} from "./DominoVaultTypes.sol";

/// @notice V4 fee-only execution wire. Existing V3 CompoundPlan is unchanged.
library DominoExecutionTypes {
    // GENERAL and NET increase the authority.tokenId; FUND uses an existing
    // eligible destination; MINT creates exactly one successor of that parent.
    uint8 internal constant GENERAL = 0;
    uint8 internal constant NET = 1;
    uint8 internal constant FUND = 2;
    uint8 internal constant MINT = 3;
    struct PositionRef { uint256 tokenId; bytes32 positionIdentity; bytes32 checkpointId; }
    struct FeeBudget { bytes32 sourceId; address currency; uint128 maxOriginal; uint128 maxCharged; }
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
