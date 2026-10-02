// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {
    IUniswapV3FactoryMinimal,
    IUniswapV3PoolMinimal,
    IUniswapV3PositionManagerMinimal
} from "../external/IUniswapV3Minimal.sol";
import {DominoPositionMath} from "./DominoPositionMath.sol";

/// @notice The NonfungiblePositionManager's pool initializer (v3-periphery
/// PoolInitializer), which F0's minimal declaration omits. The selector is
/// exercised against the deployed bytecode in the F1c tests.
interface IV3PoolInitializerMinimal {
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
}

/// @notice Uniswap v3 position adapter for the V2 zap (F2) and vault (F3),
/// domino-money/domino#283 F1c, with the same shape as DominoV4Positions.
/// docs/v2/F1_POSITIONS.md is the reference.
/// @dev Plain calls to the NonfungiblePositionManager; no unlock. Facts of the
/// deployed v3-periphery 1.0.0 build this relies on (F0 constraints):
/// - mint and increaseLiquidity are open to anyone and pull from the caller
///   through an ERC20 allowance; this library approves exactly the desired
///   amounts and resets both allowances to zero in the same call.
/// - decreaseLiquidity, collect and burn need the owner, the token's approved
///   address or an operator.
/// - Fees and removed principal accrue in tokensOwed until collect; withdraw
///   always collects in the same call, so nothing it removes stays owed.
/// - Native currency is never used: v3 pools hold the wrapped token.
library DominoV3Positions {
    error InvalidPool();
    error InvalidRecipient(address recipient);
    error PositionPoolMismatch(uint256 tokenId);
    error InsufficientLiquidity(uint128 liquidity, uint128 minimum);
    error PartialBurn(uint256 tokenId, uint128 liquidity, uint128 positionLiquidity);
    error ApprovalFailed(address token);
    error ManagerMismatch();

    /// The chain's NonfungiblePositionManager and factory (api-contracts/v2/chains).
    struct Managers {
        IUniswapV3PositionManagerMinimal positionManager;
        IUniswapV3FactoryMinimal factory;
    }

    /// What one action did; the same shape as DominoV4Positions.Result.
    /// delta0/delta1: negative was paid from this contract's balance, positive
    /// was delivered to the recipient.
    struct Result {
        uint256 tokenId;
        uint128 liquidity;
        int256 delta0;
        int256 delta1;
    }

    /// A position as the NonfungiblePositionManager holds it. The fee
    /// checkpoints and tokensOwed are what F3 re-verifies before each execution.
    struct Position {
        address owner;
        /// The token's individual approval (the manager's `operator` field).
        address approved;
        DominoV2Types.PoolRef pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    // ---------------------------------------------------------------- actions

    /// @notice Mints a position to `owner` from at most amount0Desired and
    /// amount1Desired of this contract's balance; the manager sizes the
    /// liquidity at the current price (rounded down) and charges what it needs.
    /// The unused part stays here. Reverts with InsufficientLiquidity below
    /// `minLiquidity`.
    function mint(
        Managers memory m,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Desired,
        uint128 amount1Desired,
        uint128 minLiquidity,
        address owner
    ) internal returns (Result memory r) {
        _recipient(owner);
        poolAddress(m, pool);
        DominoPositionMath.checkRange(tickLower, tickUpper, pool.tickSpacing);
        _approvePair(m, pool, amount0Desired, amount1Desired);
        uint256 amount0;
        uint256 amount1;
        (r.tokenId, r.liquidity, amount0, amount1) = m.positionManager.mint(
            IUniswapV3PositionManagerMinimal.MintParams(
                pool.currency0,
                pool.currency1,
                pool.fee,
                tickLower,
                tickUpper,
                amount0Desired,
                amount1Desired,
                0,
                0,
                owner,
                block.timestamp
            )
        );
        _approvePair(m, pool, 0, 0);
        _minimum(r.liquidity, minLiquidity);
        (r.delta0, r.delta1) = (-int256(amount0), -int256(amount1));
    }

    /// @notice Adds liquidity to `tokenId`, which must belong to `pool`, from at
    /// most the desired amounts. Open to anyone on v3: no approval is needed,
    /// and the position's accrued fees stay owed to it (unlike v4).
    function increase(
        Managers memory m,
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 amount0Desired,
        uint128 amount1Desired,
        uint128 minLiquidity
    ) internal returns (Result memory r) {
        _position(m, tokenId, pool);
        _approvePair(m, pool, amount0Desired, amount1Desired);
        uint256 amount0;
        uint256 amount1;
        (r.liquidity, amount0, amount1) = m.positionManager.increaseLiquidity(
            IUniswapV3PositionManagerMinimal.IncreaseLiquidityParams(
                tokenId, amount0Desired, amount1Desired, 0, 0, block.timestamp
            )
        );
        _approvePair(m, pool, 0, 0);
        _minimum(r.liquidity, minLiquidity);
        r.tokenId = tokenId;
        (r.delta0, r.delta1) = (-int256(amount0), -int256(amount1));
    }

    /// @notice Removes `liquidity` from `tokenId` and delivers it, with
    /// everything the position had owed (fees and any principal removed
    /// earlier), to `recipient`. amount0Min and amount1Min bound the principal;
    /// with `liquidity` 0 nothing is removed and they are ignored. With
    /// `burnPosition` the NFT is burned too and `liquidity` must be the
    /// position's whole liquidity.
    function withdraw(
        Managers memory m,
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 amount0Min,
        uint128 amount1Min,
        address recipient,
        bool burnPosition
    ) internal returns (Result memory r) {
        _recipient(recipient);
        uint128 current = _position(m, tokenId, pool);
        if (burnPosition && liquidity != current) revert PartialBurn(tokenId, liquidity, current);
        r.tokenId = tokenId;
        r.liquidity = liquidity;
        if (liquidity != 0) {
            m.positionManager.decreaseLiquidity(
                IUniswapV3PositionManagerMinimal.DecreaseLiquidityParams(
                    tokenId, liquidity, amount0Min, amount1Min, block.timestamp
                )
            );
        }
        (uint256 amount0, uint256 amount1) = m.positionManager.collect(
            IUniswapV3PositionManagerMinimal.CollectParams(tokenId, recipient, type(uint128).max, type(uint128).max)
        );
        if (burnPosition) m.positionManager.burn(tokenId);
        (r.delta0, r.delta1) = (int256(amount0), int256(amount1));
    }

    /// @notice Delivers everything `tokenId` owes (accrued fees, and principal
    /// removed earlier and not yet collected) to `recipient`.
    function collect(Managers memory m, uint256 tokenId, DominoV2Types.PoolRef memory pool, address recipient)
        internal
        returns (Result memory)
    {
        return withdraw(m, tokenId, pool, 0, 0, 0, recipient, false);
    }

    // ----------------------------------------------------------- pool set-up

    /// @notice Reverts unless the position manager works with this factory. A
    /// consumer calls it once, in its constructor, with the chain profile's
    /// addresses.
    function checkManagers(Managers memory m) internal view {
        if (m.positionManager.factory() != address(m.factory)) revert ManagerMismatch();
    }

    /// @notice Validates `pool` against the factory and returns its address
    /// (zero when not created yet): dex 3, no hooks, sorted non-native tokens,
    /// and the tick spacing the factory assigns to the fee.
    function poolAddress(Managers memory m, DominoV2Types.PoolRef memory pool) internal view returns (address) {
        if (
            pool.dex != DominoV2Types.DEX_V3 || pool.hooks != address(0) || pool.currency0 == address(0)
                || pool.currency0 >= pool.currency1 || pool.tickSpacing == 0
                || m.factory.feeAmountTickSpacing(pool.fee) != pool.tickSpacing
        ) revert InvalidPool();
        return m.factory.getPool(pool.currency0, pool.currency1, pool.fee);
    }

    /// @notice Creates and initializes the pool at `sqrtPriceX96` unless it
    /// already has a price, and returns its address and the price in force. A
    /// pool someone else initialized first is not an error: the caller bounds
    /// the returned price (#282 A11).
    function initialize(Managers memory m, DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96)
        internal
        returns (address pool_, uint160 currentSqrtPriceX96)
    {
        poolAddress(m, pool);
        pool_ = IV3PoolInitializerMinimal(address(m.positionManager)).createAndInitializePoolIfNecessary(
            pool.currency0, pool.currency1, pool.fee, sqrtPriceX96
        );
        (currentSqrtPriceX96,,,,,,) = IUniswapV3PoolMinimal(pool_).slot0();
    }

    // ------------------------------------------------------------------ reads

    /// @notice The position's owner, approval, pool, range, liquidity, fee
    /// checkpoints and tokensOwed. Reverts for a token that does not exist.
    function position(Managers memory m, uint256 tokenId) internal view returns (Position memory p) {
        (
            ,
            p.approved,
            p.pool.currency0,
            p.pool.currency1,
            p.pool.fee,
            p.tickLower,
            p.tickUpper,
            p.liquidity,
            p.feeGrowthInside0LastX128,
            p.feeGrowthInside1LastX128,
            p.tokensOwed0,
            p.tokensOwed1
        ) = m.positionManager.positions(tokenId);
        p.pool.dex = DominoV2Types.DEX_V3;
        p.pool.tickSpacing = m.factory.feeAmountTickSpacing(p.pool.fee);
        p.owner = m.positionManager.ownerOf(tokenId);
    }

    /// @notice What collect would deliver now: tokensOwed plus the fees accrued
    /// since the manager's last checkpoint of the position, as the manager
    /// would credit them.
    function collectable(Managers memory m, uint256 tokenId) internal view returns (uint256 amount0, uint256 amount1) {
        Position memory p = position(m, tokenId);
        (amount0, amount1) = (p.tokensOwed0, p.tokensOwed1);
        if (p.liquidity != 0) {
            IUniswapV3PoolMinimal pool =
                IUniswapV3PoolMinimal(m.factory.getPool(p.pool.currency0, p.pool.currency1, p.pool.fee));
            (uint256 inside0, uint256 inside1) = feeGrowthInside(pool, p.tickLower, p.tickUpper);
            amount0 += DominoPositionMath.feesEarned(inside0, p.feeGrowthInside0LastX128, p.liquidity);
            amount1 += DominoPositionMath.feesEarned(inside1, p.feeGrowthInside1LastX128, p.liquidity);
        }
    }

    /// @notice Fee growth inside a range now (Q128), as the pool computes it.
    function feeGrowthInside(IUniswapV3PoolMinimal pool, int24 tickLower, int24 tickUpper)
        internal
        view
        returns (uint256 inside0X128, uint256 inside1X128)
    {
        (, int24 tick,,,,,) = pool.slot0();
        (,, uint256 lower0, uint256 lower1,,,,) = pool.ticks(tickLower);
        (,, uint256 upper0, uint256 upper1,,,,) = pool.ticks(tickUpper);
        inside0X128 =
            DominoPositionMath.feeGrowthInside(tick, tickLower, tickUpper, pool.feeGrowthGlobal0X128(), lower0, upper0);
        inside1X128 =
            DominoPositionMath.feeGrowthInside(tick, tickLower, tickUpper, pool.feeGrowthGlobal1X128(), lower1, upper1);
    }

    /// @notice Whether `account` may decrease, collect or burn `tokenId`: the
    /// owner, the token's approved address or an operator for all the owner's
    /// tokens. Increasing needs none of these on v3.
    function isAuthorized(Managers memory m, uint256 tokenId, address account) internal view returns (bool) {
        address owner = m.positionManager.ownerOf(tokenId);
        return owner == account || m.positionManager.getApproved(tokenId) == account
            || m.positionManager.isApprovedForAll(owner, account);
    }

    // ---------------------------------------------------------------- private

    /// Liquidity of a position that must belong to `pool`.
    function _position(Managers memory m, uint256 tokenId, DominoV2Types.PoolRef memory pool)
        private
        view
        returns (uint128 liquidity)
    {
        if (pool.dex != DominoV2Types.DEX_V3) revert InvalidPool();
        address token0;
        address token1;
        uint24 fee;
        (,, token0, token1, fee,,, liquidity,,,,) = m.positionManager.positions(tokenId);
        if (token0 != pool.currency0 || token1 != pool.currency1 || fee != pool.fee) {
            revert PositionPoolMismatch(tokenId);
        }
    }

    /// Exact allowances to the manager before it pulls, zero after.
    function _approvePair(Managers memory m, DominoV2Types.PoolRef memory pool, uint256 amount0, uint256 amount1)
        private
    {
        _approve(pool.currency0, address(m.positionManager), amount0);
        _approve(pool.currency1, address(m.positionManager), amount1);
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApprovalFailed(token);
    }

    /// The zero address cannot own a position, and collect to it would leave
    /// the tokens in the manager for anyone to sweep.
    function _recipient(address recipient) private pure {
        if (recipient == address(0)) revert InvalidRecipient(recipient);
    }

    function _minimum(uint128 liquidity, uint128 minLiquidity) private pure {
        if (liquidity < minLiquidity) revert InsufficientLiquidity(liquidity, minLiquidity);
    }
}
