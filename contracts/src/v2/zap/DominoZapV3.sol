// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PositionManagerMinimal} from "../external/IUniswapV3Minimal.sol";
import {DominoV3Positions} from "../positions/DominoV3Positions.sol";
import {DominoZapBase} from "./DominoZapBase.sol";

/// @notice WETH9's deposit, the only wrapped-native call the v3 zap makes.
interface IWrappedNativeMinimal {
    function deposit() external payable;
}

/// @notice The S1 zap for Uniswap v3 positions (#283), CreateX component
/// `zap.v3`. Positions stay in the owner's wallet. v3 pools hold the wrapped
/// native token: native ETH may come in (msg.value, or a leg's output) and is
/// wrapped before it is added to a WETH pool. docs/v2/F2_ZAP.md is the reference.
/// @dev Position steps are plain NonfungiblePositionManager calls through
/// DominoV3Positions (F1c), with exact allowances reset to zero in the same
/// call. Change range and exit need this contract approved on the NFT;
/// increase is open on v3, but DominoZapBase still requires the owner.
contract DominoZapV3 is DominoZapBase {
    IUniswapV3PositionManagerMinimal private immutable POSITION_MANAGER;
    address private immutable WRAPPED_NATIVE;

    /// @param route The chain profile's registry, Permit2, v3 factory and pool
    /// init code hash (required here) and v4 PoolManager (v4 legs; 0 disables them).
    /// @param positionManager_ The chain profile's NonfungiblePositionManager,
    /// which must belong to route.v3Factory; its WETH9 is the wrapped native.
    constructor(RouteConfig memory route, IUniswapV3PositionManagerMinimal positionManager_) DominoZapBase(route) {
        DominoV3Positions.checkManagers(
            DominoV3Positions.Managers(positionManager_, IUniswapV3FactoryMinimal(route.v3Factory))
        );
        POSITION_MANAGER = positionManager_;
        WRAPPED_NATIVE = positionManager_.WETH9();
    }

    function positionManager() external view returns (address) {
        return address(POSITION_MANAGER);
    }

    function hookedPoolsAllowed() external pure returns (bool) {
        return false;
    }

    // ------------------------------------------------------------- steps

    function _checkPool(DominoV2Types.PoolRef memory pool) internal pure override {
        if (pool.dex != DominoV2Types.DEX_V3 || pool.hooks != address(0)) revert InvalidPlan();
    }

    function _position(uint256 tokenId) internal view override returns (address owner, int24 tickLower, int24 tickUpper) {
        (,,,,, tickLower, tickUpper,,,,,) = POSITION_MANAGER.positions(tokenId);
        owner = POSITION_MANAGER.ownerOf(tokenId);
    }

    function _initialize(DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96) internal override {
        DominoV3Positions.initialize(_managers(), pool, sqrtPriceX96);
    }

    /// Native held for a WETH pool is wrapped, except what is owed as a fee.
    function _prepare(DominoV2Types.PoolRef memory pool) internal override {
        if (pool.currency0 != WRAPPED_NATIVE && pool.currency1 != WRAPPED_NATIVE) return;
        uint256 native = _unowedBalance(address(0));
        if (native != 0) IWrappedNativeMinimal(WRAPPED_NATIVE).deposit{value: native}();
    }

    function _mint(
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity,
        address owner
    ) internal override returns (Step memory) {
        return _step(DominoV3Positions.mint(_managers(), pool, tickLower, tickUpper, amount0, amount1, minLiquidity, owner));
    }

    function _addLiquidity(
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 amount0,
        uint128 amount1,
        uint128 minLiquidity
    ) internal override returns (Step memory) {
        return _step(DominoV3Positions.increase(_managers(), tokenId, pool, amount0, amount1, minLiquidity));
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
        return _step(
            DominoV3Positions.withdraw(_managers(), tokenId, pool, liquidity, amount0Min, amount1Min, recipient, burn)
        );
    }

    function _step(DominoV3Positions.Result memory r) private pure returns (Step memory) {
        return Step(r.tokenId, r.liquidity, r.delta0, r.delta1);
    }

    function _managers() private view returns (DominoV3Positions.Managers memory) {
        return DominoV3Positions.Managers(POSITION_MANAGER, IUniswapV3FactoryMinimal(V3_FACTORY));
    }
}
