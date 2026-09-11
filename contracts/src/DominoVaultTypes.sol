// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";

/// @notice E2 custody-only types. No execution, swapping or financial admission.
library DominoVaultTypes {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExecutionLimits {
        uint64 version;
        uint32 upsideBps;
        uint16 maxSlippageBps;
        uint16 maxPriceImpactBps;
        uint128 maxGasCostWei;
        uint32 maxObservationAgeSeconds;
        uint32 forecastHorizonSeconds;
    }

    struct InitParams {
        uint256 rootTokenId;
        bytes32 expectedPoolId;
        address baseCurrency;
        address quoteCurrency;
        address operator;
        bool consentToUncollectedFees;
        IDominoVaultDraft.Policy policy;
        ExecutionLimits limits;
    }

    struct Position {
        bool known;
        bool active;
        bool isRoot;
        uint256 parentTokenId;
        uint64 generation;
        int24 tickLower;
        int24 tickUpper;
        bytes32 registrationBaselineId;
        bytes32 identity;
        bytes32 source0;
        bytes32 source1;
    }

    struct Checkpoint {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint256 feeGrowthInside0X128;
        uint256 feeGrowthInside1X128;
        uint64 observedAtBlock;
        bytes32 commitment;
    }

    struct Source {
        bool known;
        uint256 tokenId;
        address originalCurrency;
        bytes32 positionIdentity;
    }

    struct FeeBalance {
        uint128 original;
        uint128 charged;
    }
}

/// @dev Minimal locally authored ABI declarations, checked against official
/// v4-periphery. PoolKey, PositionInfo and BalanceDelta keep their ABI widths.
interface IPositionManagerE2 {
    function poolManager() external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (DominoVaultTypes.PoolKey memory, uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function subscriber(uint256 tokenId) external view returns (address);
    function subscribe(uint256 tokenId, address target, bytes calldata data) external;
    function unsubscribe(uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IStateViewE2 {
    function poolManager() external view returns (address);
    function getPositionInfo(bytes32 poolId, address manager, int24 lower, int24 upper, bytes32 salt)
        external
        view
        returns (uint128 liquidity, uint256 last0, uint256 last1);
    function getFeeGrowthInside(bytes32 poolId, int24 lower, int24 upper)
        external
        view
        returns (uint256 inside0, uint256 inside1);
}

interface IERC20E2 {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC721ReceiverE2 {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
