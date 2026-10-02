// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../external/IUniswapV4Minimal.sol";
import {DominoV4Positions} from "../positions/DominoV4Positions.sol";
import {DominoZapBase} from "./DominoZapBase.sol";
import {DominoZapV4Steps} from "./DominoZapV4Steps.sol";

/// @notice The S1 zap for Uniswap v4 positions (#283), CreateX component
/// `zap.v4`. Positions stay in the owner's wallet; native ETH is address(0).
/// docs/v2/F2_ZAP.md is the reference.
/// @dev Each position step runs in its own PoolManager unlock, held by this
/// contract; the callback runs the step (DominoV4Positions, F1c) by
/// DELEGATECALL to DominoZapV4Steps, so the PositionManager sees this
/// contract as the locker and payer. Swap legs (F1b) run between the steps
/// with their own unlocks. Increase, change range and exit need this contract
/// approved on the NFT; that approval outlives the action and this contract
/// cannot clear it, which is why DominoZapBase lets only the position's
/// current owner act on it.
contract DominoZapV4 is DominoZapBase {
    error InvalidZapConfig();

    /// Positions in pools with a hooks contract (#283: not decided yet). The
    /// default refuses them; flipping this constant accepts them. Swap legs may
    /// cross hooked pools either way (F1b judges them by what arrives).
    bool internal constant HOOKED_POOLS_ALLOWED = false;

    /// keccak256("domino.v2.zap.v4.unlock") - 1: keccak256 of the pending step's unlock data.
    bytes32 private constant UNLOCK_SLOT = 0xbd47ee87a731f56635c294102807a20486722183802a3132ac47594c200525e7;

    IV4PositionManagerMinimal private immutable POSITION_MANAGER;
    address private immutable STEPS;

    /// @param route The chain profile's registry, Permit2, v3 factory and init
    /// code hash (v3 legs) and v4 PoolManager (required here).
    /// @param positionManager_ The chain profile's v4 PositionManager, which must
    /// settle with route.v4PoolManager.
    /// @param steps The DominoZapV4Steps deployment (the same on every chain).
    constructor(RouteConfig memory route, IV4PositionManagerMinimal positionManager_, address steps)
        DominoZapBase(route)
    {
        DominoV4Positions.checkManagers(
            DominoV4Positions.Managers(IV4PoolManagerMinimal(route.v4PoolManager), positionManager_)
        );
        if (steps.code.length == 0) revert InvalidZapConfig();
        POSITION_MANAGER = positionManager_;
        STEPS = steps;
    }

    function positionManager() external view returns (address) {
        return address(POSITION_MANAGER);
    }

    function hookedPoolsAllowed() external pure returns (bool) {
        return HOOKED_POOLS_ALLOWED;
    }

    /// @notice The PoolManager's callback: a swap leg's (F1b) or one of this
    /// contract's position steps, each only while this contract awaits it.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (_v4LegPending()) return _v4LegCallback(data);
        bytes32 pending;
        assembly ("memory-safe") {
            pending := tload(UNLOCK_SLOT)
        }
        // Every unlock this contract makes sets the pending hash first and only
        // the PoolManager calls back, so a used hash needs no clearing.
        if (msg.sender != V4_POOL_MANAGER || pending != keccak256(data)) revert Unauthorized();
        // run(Managers, Call): both static, so the arguments are the managers
        // followed by the step exactly as it was encoded for the unlock.
        (bool ok, bytes memory result) = STEPS.delegatecall(
            abi.encodePacked(DominoZapV4Steps.run.selector, abi.encode(V4_POOL_MANAGER, POSITION_MANAGER), data)
        );
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        return result;
    }

    // ------------------------------------------------------------- steps

    function _checkPool(DominoV2Types.PoolRef memory pool) internal pure override {
        if (pool.dex != DominoV2Types.DEX_V4 || (pool.hooks != address(0) && !HOOKED_POOLS_ALLOWED)) {
            revert InvalidPlan();
        }
    }

    function _position(uint256 tokenId) internal view override returns (address owner, int24 tickLower, int24 tickUpper) {
        owner = POSITION_MANAGER.ownerOf(tokenId);
        (, uint256 info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        // PositionInfo: 200 bits pool id | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber.
        tickLower = int24(uint24(info >> 8));
        tickUpper = int24(uint24(info >> 32));
    }

    function _initialize(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) internal override {
        DominoV4Positions.initialize(IV4PoolManagerMinimal(V4_POOL_MANAGER), pool, sqrtPriceX96);
    }

    function _prepare(DominoV2Types.PoolRef memory) internal pure override {}

    function _mint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity,
        address owner
    ) internal override returns (Step memory) {
        return _run(
            DominoZapV4Steps.Call(1, pool, 0, tickLower, tickUpper, amount0, amount1, minLiquidity, owner, false)
        );
    }

    function _addLiquidity(
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity
    ) internal override returns (Step memory) {
        return _run(
            DominoZapV4Steps.Call(2, pool, tokenId, 0, 0, amount0, amount1, minLiquidity, address(0), false)
        );
    }

    function _withdraw(
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min,
        address recipient,
        bool burn
    ) internal override returns (Step memory) {
        return _run(
            DominoZapV4Steps.Call(3, pool, tokenId, 0, 0, amount0Min, amount1Min, liquidity, recipient, burn)
        );
    }

    function _run(DominoZapV4Steps.Call memory c) private returns (Step memory) {
        bytes memory data = abi.encode(c);
        bytes32 pending = keccak256(data);
        assembly ("memory-safe") {
            tstore(UNLOCK_SLOT, pending)
        }
        return abi.decode(IV4PoolManagerMinimal(V4_POOL_MANAGER).unlock(data), (Step));
    }
}
