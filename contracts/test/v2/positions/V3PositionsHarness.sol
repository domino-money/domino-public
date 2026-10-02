// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal,
    IUniswapV3PositionManagerMinimal
} from "../../../src/v2/external/IUniswapV3Minimal.sol";
import {DominoV3Positions} from "../../../src/v2/positions/DominoV3Positions.sol";

/// @notice TEST ONLY. A consumer of DominoV3Positions: it holds the tokens it
/// pays with, as the zap and the vault do, and calls the library directly (v3
/// needs no unlock).
contract V3PositionsHarness {
    IUniswapV3PositionManagerMinimal public immutable positionManager;
    IUniswapV3FactoryMinimal public immutable factory;
    address private immutable deployer;

    constructor(IUniswapV3PositionManagerMinimal positionManager_, IUniswapV3FactoryMinimal factory_) {
        (positionManager, factory, deployer) = (positionManager_, factory_, msg.sender);
    }

    function mint(
        DominoV2Types.PoolRef memory pool,
        int24 lower,
        int24 upper,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity,
        address owner
    ) external returns (DominoV3Positions.Result memory) {
        return DominoV3Positions.mint(_managers(), pool, lower, upper, amount0, amount1, minLiquidity, owner);
    }

    function increase(uint256 id, DominoV2Types.PoolRef memory pool, uint128 amount0, uint128 amount1, uint128 minLiquidity)
        external
        returns (DominoV3Positions.Result memory)
    {
        return DominoV3Positions.increase(_managers(), id, pool, amount0, amount1, minLiquidity);
    }

    function withdraw(
        uint256 id,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 min0,
        uint128 min1,
        address recipient,
        bool burn
    ) external returns (DominoV3Positions.Result memory) {
        return DominoV3Positions.withdraw(_managers(), id, pool, liquidity, min0, min1, recipient, burn);
    }

    function collect(uint256 id, DominoV2Types.PoolRef memory pool, address recipient)
        external
        returns (DominoV3Positions.Result memory)
    {
        return DominoV3Positions.collect(_managers(), id, pool, recipient);
    }

    function initialize(DominoV2Types.PoolRef memory pool, uint160 price) external returns (address, uint160) {
        return DominoV3Positions.initialize(_managers(), pool, price);
    }

    /// The harness acting as an NFT holder (approve, transfer).
    function call(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == deployer, "deployer only");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    function checkManagers(IUniswapV3PositionManagerMinimal positionManager_, IUniswapV3FactoryMinimal factory_)
        external
        view
    {
        DominoV3Positions.checkManagers(DominoV3Positions.Managers(positionManager_, factory_));
    }

    function poolAddress(DominoV2Types.PoolRef memory pool) external view returns (address) {
        return DominoV3Positions.poolAddress(_managers(), pool);
    }

    function position(uint256 id) external view returns (DominoV3Positions.Position memory) {
        return DominoV3Positions.position(_managers(), id);
    }

    function collectable(uint256 id) external view returns (uint256, uint256) {
        return DominoV3Positions.collectable(_managers(), id);
    }

    function feeGrowthInside(address pool, int24 lower, int24 upper) external view returns (uint256, uint256) {
        return DominoV3Positions.feeGrowthInside(IUniswapV3PoolMinimal(pool), lower, upper);
    }

    function isAuthorized(uint256 id, address account) external view returns (bool) {
        return DominoV3Positions.isAuthorized(_managers(), id, account);
    }

    function _managers() private view returns (DominoV3Positions.Managers memory) {
        return DominoV3Positions.Managers(positionManager, factory);
    }
}
