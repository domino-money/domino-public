// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../../../src/v2/DominoV2Types.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../../../src/v2/external/IUniswapV4Minimal.sol";
import {DominoV4Positions} from "../../../src/v2/positions/DominoV4Positions.sol";

/// @notice Step codes of V4PositionsHarness.run.
library V4Steps {
    uint8 internal constant MINT = 1;
    uint8 internal constant MINT_LIQUIDITY = 2;
    uint8 internal constant INCREASE = 3;
    uint8 internal constant INCREASE_LIQUIDITY = 4;
    uint8 internal constant WITHDRAW = 5;
    uint8 internal constant COLLECT = 6;
    uint8 internal constant RAW = 7;
    uint8 internal constant INITIALIZE = 8;
}

/// @notice TEST ONLY. A consumer of DominoV4Positions wired the way the zap and
/// the vault wire it: the contract holds the PoolManager unlock, its
/// unlockCallback accepts only the PoolManager, and every library action runs
/// inside that callback. `run` executes a sequence of steps in one unlock, so a
/// test can compose actions (or leave a raw PositionManager delta open).
contract V4PositionsHarness {
    struct Step {
        uint8 op;
        bytes args;
    }

    IV4PoolManagerMinimal public immutable poolManager;
    IV4PositionManagerMinimal public immutable positionManager;
    address private immutable deployer;

    constructor(IV4PoolManagerMinimal poolManager_, IV4PositionManagerMinimal positionManager_) {
        (poolManager, positionManager, deployer) = (poolManager_, positionManager_, msg.sender);
    }

    receive() external payable {}

    // ------------------------------------------------------------- one unlock

    function run(Step[] memory steps) public returns (bytes[] memory results) {
        return abi.decode(poolManager.unlock(abi.encode(steps)), (bytes[]));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "callback caller");
        Step[] memory steps = abi.decode(data, (Step[]));
        bytes[] memory results = new bytes[](steps.length);
        for (uint256 i; i < steps.length; ++i) {
            results[i] = _step(steps[i]);
        }
        return abi.encode(results);
    }

    function _step(Step memory s) private returns (bytes memory) {
        DominoV4Positions.Managers memory m = _managers();
        if (s.op == V4Steps.MINT) {
            (
                DominoV2Types.PoolRef memory pool,
                int24 lower,
                int24 upper,
                uint128 amount0,
                uint128 amount1,
                uint128 minLiquidity,
                address owner
            ) = abi.decode(s.args, (DominoV2Types.PoolRef, int24, int24, uint128, uint128, uint128, address));
            return abi.encode(DominoV4Positions.mint(m, pool, lower, upper, amount0, amount1, minLiquidity, owner));
        }
        if (s.op == V4Steps.MINT_LIQUIDITY) {
            (
                DominoV2Types.PoolRef memory pool,
                int24 lower,
                int24 upper,
                uint128 liquidity,
                uint128 max0,
                uint128 max1,
                address owner
            ) = abi.decode(s.args, (DominoV2Types.PoolRef, int24, int24, uint128, uint128, uint128, address));
            return abi.encode(DominoV4Positions.mintLiquidity(m, pool, lower, upper, liquidity, max0, max1, owner));
        }
        if (s.op == V4Steps.INCREASE) {
            (uint256 id, DominoV2Types.PoolRef memory pool, uint128 amount0, uint128 amount1, uint128 minLiquidity) =
                abi.decode(s.args, (uint256, DominoV2Types.PoolRef, uint128, uint128, uint128));
            return abi.encode(DominoV4Positions.increase(m, id, pool, amount0, amount1, minLiquidity));
        }
        if (s.op == V4Steps.INCREASE_LIQUIDITY) {
            (uint256 id, DominoV2Types.PoolRef memory pool, uint128 liquidity, uint128 max0, uint128 max1) =
                abi.decode(s.args, (uint256, DominoV2Types.PoolRef, uint128, uint128, uint128));
            return abi.encode(DominoV4Positions.increaseLiquidity(m, id, pool, liquidity, max0, max1));
        }
        if (s.op == V4Steps.WITHDRAW) {
            (
                uint256 id,
                DominoV2Types.PoolRef memory pool,
                uint128 liquidity,
                uint128 min0,
                uint128 min1,
                address recipient,
                bool burn
            ) = abi.decode(s.args, (uint256, DominoV2Types.PoolRef, uint128, uint128, uint128, address, bool));
            return abi.encode(DominoV4Positions.withdraw(m, id, pool, liquidity, min0, min1, recipient, burn));
        }
        if (s.op == V4Steps.COLLECT) {
            (uint256 id, DominoV2Types.PoolRef memory pool, address recipient) =
                abi.decode(s.args, (uint256, DominoV2Types.PoolRef, address));
            return abi.encode(DominoV4Positions.collect(m, id, pool, recipient));
        }
        if (s.op == V4Steps.RAW) {
            (bytes memory actions, bytes[] memory params) = abi.decode(s.args, (bytes, bytes[]));
            positionManager.modifyLiquiditiesWithoutUnlock(actions, params);
            return "";
        }
        if (s.op == V4Steps.INITIALIZE) {
            (DominoV2Types.PoolRef memory pool, uint160 price) = abi.decode(s.args, (DominoV2Types.PoolRef, uint160));
            (uint160 current, bool created) = DominoV4Positions.initialize(poolManager, pool, price);
            return abi.encode(current, created);
        }
        revert("unknown step");
    }

    // -------------------------------------------------------- single actions

    function mint(
        DominoV2Types.PoolRef memory pool,
        int24 lower,
        int24 upper,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity,
        address owner
    ) external returns (DominoV4Positions.Result memory) {
        return _single(V4Steps.MINT, abi.encode(pool, lower, upper, amount0, amount1, minLiquidity, owner));
    }

    function mintLiquidity(
        DominoV2Types.PoolRef memory pool,
        int24 lower,
        int24 upper,
        uint128 liquidity,
        uint128 max0,
        uint128 max1,
        address owner
    ) external returns (DominoV4Positions.Result memory) {
        return _single(V4Steps.MINT_LIQUIDITY, abi.encode(pool, lower, upper, liquidity, max0, max1, owner));
    }

    function increase(uint256 id, DominoV2Types.PoolRef memory pool, uint128 amount0, uint128 amount1, uint128 minLiquidity)
        external
        returns (DominoV4Positions.Result memory)
    {
        return _single(V4Steps.INCREASE, abi.encode(id, pool, amount0, amount1, minLiquidity));
    }

    function increaseLiquidity(uint256 id, DominoV2Types.PoolRef memory pool, uint128 liquidity, uint128 max0, uint128 max1)
        external
        returns (DominoV4Positions.Result memory)
    {
        return _single(V4Steps.INCREASE_LIQUIDITY, abi.encode(id, pool, liquidity, max0, max1));
    }

    function withdraw(
        uint256 id,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 min0,
        uint128 min1,
        address recipient,
        bool burn
    ) external returns (DominoV4Positions.Result memory) {
        return _single(V4Steps.WITHDRAW, abi.encode(id, pool, liquidity, min0, min1, recipient, burn));
    }

    function collect(uint256 id, DominoV2Types.PoolRef memory pool, address recipient)
        external
        returns (DominoV4Positions.Result memory)
    {
        return _single(V4Steps.COLLECT, abi.encode(id, pool, recipient));
    }

    /// Outside any unlock.
    function initialize(DominoV2Types.PoolRef memory pool, uint160 price) external returns (uint160, bool) {
        return DominoV4Positions.initialize(poolManager, pool, price);
    }

    /// The harness acting as an NFT holder (approve, subscribe, transfer).
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

    // ------------------------------------------------------------------ reads

    function position(uint256 id) external view returns (DominoV4Positions.Position memory) {
        return DominoV4Positions.position(_managers(), id);
    }

    function collectable(uint256 id) external view returns (uint256, uint256) {
        return DominoV4Positions.collectable(_managers(), id);
    }

    function slot0(DominoV2Types.PoolRef memory pool) external view returns (uint160, int24, uint24, uint24) {
        return DominoV4Positions.slot0(poolManager, pool);
    }

    function feeGrowthInside(DominoV2Types.PoolRef memory pool, int24 lower, int24 upper)
        external
        view
        returns (uint256, uint256)
    {
        return DominoV4Positions.feeGrowthInside(poolManager, pool, lower, upper);
    }

    function isAuthorized(uint256 id, address account) external view returns (bool) {
        return DominoV4Positions.isAuthorized(_managers(), id, account);
    }

    function checkManagers(IV4PoolManagerMinimal poolManager_, IV4PositionManagerMinimal positionManager_)
        external
        view
    {
        DominoV4Positions.checkManagers(DominoV4Positions.Managers(poolManager_, positionManager_));
    }

    function poolId(DominoV2Types.PoolRef memory pool) external pure returns (bytes32) {
        return DominoV4Positions.poolId(pool);
    }

    function _single(uint8 op, bytes memory args) private returns (DominoV4Positions.Result memory) {
        Step[] memory steps = new Step[](1);
        steps[0] = Step(op, args);
        return abi.decode(run(steps)[0], (DominoV4Positions.Result));
    }

    function _managers() private view returns (DominoV4Positions.Managers memory) {
        return DominoV4Positions.Managers(poolManager, positionManager);
    }
}
