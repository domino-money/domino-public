// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoV2Types} from "../DominoV2Types.sol";
import {IV4PoolManagerMinimal, IV4PositionManagerMinimal} from "../external/IUniswapV4Minimal.sol";
import {DominoPositionMath} from "./DominoPositionMath.sol";

/// @notice PoolManager.initialize, which F0's minimal PoolManager omits. The
/// selector is exercised against the deployed bytecode in the F1c tests.
interface IV4PoolInitializerMinimal {
    function initialize(IV4PositionManagerMinimal.PoolKey memory key, uint160 sqrtPriceX96)
        external
        returns (int24 tick);
}

/// @notice Uniswap v4 position adapter for the V2 zap (F2) and vault (F3),
/// domino-money/domino#283 F1c. docs/v2/F1_POSITIONS.md is the reference.
/// @dev Every action runs inside a PoolManager unlock the calling contract
/// holds (its own unlockCallback), through
/// PositionManager.modifyLiquiditiesWithoutUnlock. The PositionManager's
/// resulting deltas are closed by the same call: its credits are taken to the
/// named recipient through the PositionManager's TAKE action (while the
/// PositionManager is locked, so no third party can claim them), then its debts
/// are paid from this contract's balance with sync, transfer and settleFor. No
/// Permit2 or token allowance is involved, and no delta stays open.
/// Facts of the deployed PositionManager this relies on (F0 constraints):
/// - INCREASE, DECREASE and BURN need the caller (this contract) to be the
///   owner or approved; MINT is open.
/// - Every liquidity change credits the position's accrued fees to the caller:
///   an increase delivers the owner's uncollected fees to this contract.
/// - A subscriber's notifyModifyLiquidity and notifyBurn are blocking.
/// - Only the INCREASE_LIQUIDITY, DECREASE_LIQUIDITY, MINT_POSITION,
///   BURN_POSITION and TAKE actions are used; all exist in the deployed build.
library DominoV4Positions {
    error InvalidPool();
    error InvalidRecipient(address recipient);
    error PositionPoolMismatch(uint256 tokenId);
    error InsufficientLiquidity(uint128 liquidity, uint128 minimum);
    error PartialBurn(uint256 tokenId, uint128 liquidity, uint128 positionLiquidity);
    error OpenDelta(int256 delta0, int256 delta1);
    error TransferFailed(address token);
    error SettlementMismatch(address currency, uint256 expected, uint256 paid);
    error ManagerMismatch();

    /// Action bytes of the PositionManager (v4-periphery Actions.sol).
    uint8 internal constant ACTION_INCREASE_LIQUIDITY = 0x00;
    uint8 internal constant ACTION_DECREASE_LIQUIDITY = 0x01;
    uint8 internal constant ACTION_MINT_POSITION = 0x02;
    uint8 internal constant ACTION_BURN_POSITION = 0x03;
    uint8 internal constant ACTION_TAKE = 0x0e;

    /// PoolManager storage (v4-core StateLibrary): pools mapping slot and the
    /// offsets inside Pool.State.
    uint256 private constant POOLS_SLOT = 6;
    uint256 private constant FEE_GROWTH_GLOBAL0_OFFSET = 1;
    uint256 private constant TICKS_OFFSET = 4;
    uint256 private constant POSITIONS_OFFSET = 6;

    /// The chain's PoolManager and PositionManager (api-contracts/v2/chains).
    struct Managers {
        IV4PoolManagerMinimal poolManager;
        IV4PositionManagerMinimal positionManager;
    }

    /// What one action did. delta0/delta1 are this action's net flow per pool
    /// currency: negative was paid from this contract's balance, positive was
    /// delivered to the recipient. On an increase the position's accrued fees
    /// are netted in, so a delta can be positive.
    struct Result {
        uint256 tokenId;
        uint128 liquidity;
        int256 delta0;
        int256 delta1;
    }

    /// A position as the PositionManager and PoolManager hold it.
    struct Position {
        address owner;
        DominoV2Types.PoolRef pool;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        /// Zero when the position has no subscriber.
        address subscriber;
    }

    // ------------------------------------------------------- actions (unlocked)

    /// @notice Mints a position to `owner` with the most liquidity
    /// `amount0Desired` and `amount1Desired` fund at the current price
    /// (DominoPositionMath.liquidityForAmounts, rounded down), paid from this
    /// contract's balance. The unused part of the amounts stays here.
    /// Reverts with InsufficientLiquidity below `minLiquidity` (or at zero).
    function mint(
        Managers memory m,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Desired,
        uint128 amount1Desired,
        uint128 minLiquidity,
        address owner
    ) internal returns (Result memory) {
        DominoPositionMath.checkRange(tickLower, tickUpper, pool.tickSpacing);
        (uint160 sqrtPriceX96,,,) = slot0(m.poolManager, pool);
        uint128 liquidity =
            DominoPositionMath.liquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired);
        _minimum(liquidity, minLiquidity);
        return _mint(m, pool, tickLower, tickUpper, liquidity, amount0Desired, amount1Desired, owner);
    }

    /// @notice Mints exactly `liquidity`, paying at most amount0Max and
    /// amount1Max (the PositionManager's MaximumAmountExceeded otherwise).
    function mintLiquidity(
        Managers memory m,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        address owner
    ) internal returns (Result memory) {
        DominoPositionMath.checkRange(tickLower, tickUpper, pool.tickSpacing);
        return _mint(m, pool, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner);
    }

    /// @notice Adds the most liquidity the desired amounts fund at the current
    /// price to `tokenId`, which must belong to `pool`. This contract must own
    /// the NFT or be approved for it. The position's accrued fees are credited
    /// in the same step and delivered here, netted against the payment.
    function increase(
        Managers memory m,
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 amount0Desired,
        uint128 amount1Desired,
        uint128 minLiquidity
    ) internal returns (Result memory) {
        (int24 tickLower, int24 tickUpper) = _position(m, tokenId, pool);
        (uint160 sqrtPriceX96,,,) = slot0(m.poolManager, pool);
        uint128 liquidity =
            DominoPositionMath.liquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired);
        _minimum(liquidity, minLiquidity);
        return _increase(m, tokenId, pool, liquidity, amount0Desired, amount1Desired);
    }

    /// @notice Adds exactly `liquidity` to `tokenId`; the principal is bounded by
    /// amount0Max and amount1Max (fees are credited on top).
    function increaseLiquidity(
        Managers memory m,
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 amount0Max,
        uint128 amount1Max
    ) internal returns (Result memory) {
        _position(m, tokenId, pool);
        return _increase(m, tokenId, pool, liquidity, amount0Max, amount1Max);
    }

    /// @notice Removes `liquidity` from `tokenId` and delivers it, with every fee
    /// the position accrued, to `recipient`. amount0Min and amount1Min bound the
    /// principal, as in the PositionManager. With `burnPosition` the NFT is
    /// burned too and `liquidity` must be the position's whole liquidity.
    /// `liquidity` 0 without a burn only collects fees (see collect).
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
        _position(m, tokenId, pool);
        _closed(m, pool);
        r.tokenId = tokenId;
        r.liquidity = liquidity;
        bytes[] memory params = new bytes[](1);
        if (burnPosition) {
            uint128 current = m.positionManager.getPositionLiquidity(tokenId);
            if (liquidity != current) revert PartialBurn(tokenId, liquidity, current);
            params[0] = abi.encode(tokenId, amount0Min, amount1Min, bytes(""));
            m.positionManager.modifyLiquiditiesWithoutUnlock(abi.encodePacked(ACTION_BURN_POSITION), params);
        } else {
            // An empty v4 position holds no fees (every change credited them),
            // and the PoolManager rejects modifying it.
            if (liquidity == 0) {
                if (m.positionManager.getPositionLiquidity(tokenId) == 0) return r;
                (amount0Min, amount1Min) = (0, 0);
            }
            params[0] = abi.encode(tokenId, uint256(liquidity), amount0Min, amount1Min, bytes(""));
            m.positionManager.modifyLiquiditiesWithoutUnlock(abi.encodePacked(ACTION_DECREASE_LIQUIDITY), params);
        }
        (r.delta0, r.delta1) = _resolve(m, pool, recipient);
    }

    /// @notice Delivers the fees `tokenId` accrued to `recipient`, without
    /// changing its liquidity.
    function collect(Managers memory m, uint256 tokenId, DominoV2Types.PoolRef memory pool, address recipient)
        internal
        returns (Result memory)
    {
        return withdraw(m, tokenId, pool, 0, 0, 0, recipient, false);
    }

    // ----------------------------------------------------------- pool set-up

    /// @notice Reverts unless the PositionManager settles with this PoolManager.
    /// A consumer calls it once, in its constructor, with the chain profile's
    /// addresses.
    function checkManagers(Managers memory m) internal view {
        if (m.positionManager.poolManager() != address(m.poolManager)) revert ManagerMismatch();
    }

    /// @notice Initializes the pool at `sqrtPriceX96` unless it already has a
    /// price, and returns the price in force. A pool someone else initialized
    /// first is not an error: the caller bounds the returned price (#282 A11).
    /// Works with or without an unlock.
    function initialize(IV4PoolManagerMinimal manager, DominoV2Types.PoolRef memory pool, uint160 sqrtPriceX96)
        internal
        returns (uint160 currentSqrtPriceX96, bool initialized)
    {
        (currentSqrtPriceX96,,,) = slot0(manager, pool);
        if (currentSqrtPriceX96 != 0) return (currentSqrtPriceX96, false);
        IV4PoolInitializerMinimal(address(manager)).initialize(_key(pool), sqrtPriceX96);
        return (sqrtPriceX96, true);
    }

    // ------------------------------------------------------------------ reads

    /// @notice The v4 pool id: keccak256 of the five PoolKey fields.
    function poolId(DominoV2Types.PoolRef memory pool) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks));
    }

    /// @notice The pool's slot0. protocolFee packs the zeroForOne fee in its low
    /// 12 bits and the oneForZero fee in the high 12 bits, in pips. A zero
    /// price means the pool is not initialized.
    function slot0(IV4PoolManagerMinimal manager, DominoV2Types.PoolRef memory pool)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        _key(pool);
        uint256 word = uint256(manager.extsload(_stateSlot(pool)));
        sqrtPriceX96 = uint160(word);
        tick = int24(uint24(word >> 160));
        protocolFee = uint24(word >> 184);
        lpFee = uint24(word >> 208);
    }

    /// @notice The position's owner, pool, range, liquidity, fee checkpoints and
    /// subscriber. Reverts for a token that was never minted or was burned.
    function position(Managers memory m, uint256 tokenId) internal view returns (Position memory p) {
        (IV4PositionManagerMinimal.PoolKey memory key, uint256 info) = m.positionManager.getPoolAndPositionInfo(tokenId);
        p.owner = m.positionManager.ownerOf(tokenId);
        p.pool = DominoV2Types.PoolRef(
            DominoV2Types.DEX_V4, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
        );
        (p.tickLower, p.tickUpper) = _ticks(info);
        if (info & 0xFF != 0) p.subscriber = m.positionManager.subscriber(tokenId);
        (p.liquidity, p.feeGrowthInside0LastX128, p.feeGrowthInside1LastX128) =
            _positionState(m, p.pool, p.tickLower, p.tickUpper, tokenId);
    }

    /// @notice What collect would deliver now: the fees accrued since the
    /// position's last change, computed as the PoolManager credits them.
    function collectable(Managers memory m, uint256 tokenId) internal view returns (uint256 fees0, uint256 fees1) {
        Position memory p = position(m, tokenId);
        (uint256 inside0, uint256 inside1) = feeGrowthInside(m.poolManager, p.pool, p.tickLower, p.tickUpper);
        fees0 = DominoPositionMath.feesEarned(inside0, p.feeGrowthInside0LastX128, p.liquidity);
        fees1 = DominoPositionMath.feesEarned(inside1, p.feeGrowthInside1LastX128, p.liquidity);
    }

    /// @notice Fee growth inside a range now (Q128), as the PoolManager computes it.
    function feeGrowthInside(
        IV4PoolManagerMinimal manager,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (uint256 inside0X128, uint256 inside1X128) {
        bytes32 state = _stateSlot(pool);
        int24 tick = int24(uint24(uint256(manager.extsload(state)) >> 160));
        uint256 lower = uint256(_tickSlot(state, tickLower));
        uint256 upper = uint256(_tickSlot(state, tickUpper));
        uint256 global = uint256(state) + FEE_GROWTH_GLOBAL0_OFFSET;
        inside0X128 = DominoPositionMath.feeGrowthInside(
            tick, tickLower, tickUpper, _load(manager, global), _load(manager, lower + 1), _load(manager, upper + 1)
        );
        inside1X128 = DominoPositionMath.feeGrowthInside(
            tick, tickLower, tickUpper, _load(manager, global + 1), _load(manager, lower + 2), _load(manager, upper + 2)
        );
    }

    /// @notice Whether `account` may increase, decrease or burn `tokenId`: the
    /// owner, the token's approved address or an operator for all the owner's
    /// tokens.
    function isAuthorized(Managers memory m, uint256 tokenId, address account) internal view returns (bool) {
        address owner = m.positionManager.ownerOf(tokenId);
        return owner == account || m.positionManager.getApproved(tokenId) == account
            || m.positionManager.isApprovedForAll(owner, account);
    }

    // ---------------------------------------------------------------- private

    function _mint(
        Managers memory m,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        address owner
    ) private returns (Result memory r) {
        _recipient(owner);
        IV4PositionManagerMinimal.PoolKey memory key = _key(pool);
        _closed(m, pool);
        r.tokenId = m.positionManager.nextTokenId();
        r.liquidity = liquidity;
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(key, tickLower, tickUpper, uint256(liquidity), amount0Max, amount1Max, owner, bytes(""));
        m.positionManager.modifyLiquiditiesWithoutUnlock(abi.encodePacked(ACTION_MINT_POSITION), params);
        (r.delta0, r.delta1) = _resolve(m, pool, address(this));
    }

    function _increase(
        Managers memory m,
        uint256 tokenId,
        DominoV2Types.PoolRef memory pool,
        uint128 liquidity,
        uint128 amount0Max,
        uint128 amount1Max
    ) private returns (Result memory r) {
        _closed(m, pool);
        r.tokenId = tokenId;
        r.liquidity = liquidity;
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(tokenId, uint256(liquidity), amount0Max, amount1Max, bytes(""));
        m.positionManager.modifyLiquiditiesWithoutUnlock(abi.encodePacked(ACTION_INCREASE_LIQUIDITY), params);
        (r.delta0, r.delta1) = _resolve(m, pool, address(this));
    }

    /// Closes the PositionManager's deltas in the pool's currencies: credits
    /// first, taken inside its lock, then debts paid from this contract.
    function _resolve(Managers memory m, DominoV2Types.PoolRef memory pool, address recipient)
        private
        returns (int256 delta0, int256 delta1)
    {
        delta0 = _delta(m, pool.currency0);
        delta1 = _delta(m, pool.currency1);
        uint256 credits = (delta0 > 0 ? 1 : 0) + (delta1 > 0 ? 1 : 0);
        if (credits != 0) {
            bytes memory actions = new bytes(credits);
            bytes[] memory params = new bytes[](credits);
            uint256 i;
            if (delta0 > 0) {
                actions[i] = bytes1(ACTION_TAKE);
                params[i++] = abi.encode(pool.currency0, recipient, uint256(delta0));
            }
            if (delta1 > 0) {
                actions[i] = bytes1(ACTION_TAKE);
                params[i] = abi.encode(pool.currency1, recipient, uint256(delta1));
            }
            m.positionManager.modifyLiquiditiesWithoutUnlock(actions, params);
        }
        if (delta0 < 0) _pay(m, pool.currency0, uint256(-delta0));
        if (delta1 < 0) _pay(m, pool.currency1, uint256(-delta1));
    }

    function _pay(Managers memory m, address currency, uint256 amount) private {
        m.poolManager.sync(currency);
        uint256 paid;
        if (currency == address(0)) {
            paid = m.poolManager.settleFor{value: amount}(address(m.positionManager));
        } else {
            (bool ok, bytes memory data) =
                currency.call(abi.encodeWithSelector(0xa9059cbb, address(m.poolManager), amount));
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed(currency);
            paid = m.poolManager.settleFor(address(m.positionManager));
        }
        if (paid != amount) revert SettlementMismatch(currency, amount, paid);
    }

    /// The PositionManager's open delta in `currency` (TransientStateLibrary).
    function _delta(Managers memory m, address currency) private view returns (int256) {
        return int256(uint256(m.poolManager.exttload(keccak256(abi.encode(address(m.positionManager), currency)))));
    }

    /// Each action starts from a closed PositionManager account, so its deltas
    /// are its own.
    function _closed(Managers memory m, DominoV2Types.PoolRef memory pool) private view {
        int256 delta0 = _delta(m, pool.currency0);
        int256 delta1 = _delta(m, pool.currency1);
        if (delta0 != 0 || delta1 != 0) revert OpenDelta(delta0, delta1);
    }

    /// The PositionManager maps address(1) to the locker and address(2) to
    /// itself; neither, nor the zero address, may receive a position or tokens.
    function _recipient(address recipient) private pure {
        if (uint160(recipient) <= 2) revert InvalidRecipient(recipient);
    }

    function _minimum(uint128 liquidity, uint128 minLiquidity) private pure {
        if (liquidity == 0 || liquidity < minLiquidity) revert InsufficientLiquidity(liquidity, minLiquidity);
    }

    /// Ticks of a position that must belong to `pool`.
    function _position(Managers memory m, uint256 tokenId, DominoV2Types.PoolRef memory pool)
        private
        view
        returns (int24 tickLower, int24 tickUpper)
    {
        IV4PositionManagerMinimal.PoolKey memory expected = _key(pool);
        (IV4PositionManagerMinimal.PoolKey memory key, uint256 info) = m.positionManager.getPoolAndPositionInfo(tokenId);
        if (
            key.currency0 != expected.currency0 || key.currency1 != expected.currency1 || key.fee != expected.fee
                || key.tickSpacing != expected.tickSpacing || key.hooks != expected.hooks
        ) revert PositionPoolMismatch(tokenId);
        return _ticks(info);
    }

    function _key(DominoV2Types.PoolRef memory pool) private pure returns (IV4PositionManagerMinimal.PoolKey memory) {
        if (pool.dex != DominoV2Types.DEX_V4) revert InvalidPool();
        return IV4PositionManagerMinimal.PoolKey(pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks);
    }

    /// PositionInfo: 200 bits pool id | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber.
    function _ticks(uint256 info) private pure returns (int24 tickLower, int24 tickUpper) {
        tickLower = int24(uint24(info >> 8));
        tickUpper = int24(uint24(info >> 32));
    }

    function _stateSlot(DominoV2Types.PoolRef memory pool) private pure returns (bytes32) {
        return keccak256(abi.encode(poolId(pool), POOLS_SLOT));
    }

    function _tickSlot(bytes32 state, int24 tick) private pure returns (bytes32) {
        return keccak256(abi.encode(int256(tick), uint256(state) + TICKS_OFFSET));
    }

    function _load(IV4PoolManagerMinimal manager, uint256 slot) private view returns (uint256) {
        return uint256(manager.extsload(bytes32(slot)));
    }

    /// Liquidity and fee checkpoints of the PoolManager position the
    /// PositionManager holds for tokenId (owner PositionManager, salt tokenId).
    function _positionState(
        Managers memory m,
        DominoV2Types.PoolRef memory pool,
        int24 tickLower,
        int24 tickUpper,
        uint256 tokenId
    ) private view returns (uint128 liquidity, uint256 inside0LastX128, uint256 inside1LastX128) {
        bytes32 key = keccak256(abi.encodePacked(address(m.positionManager), tickLower, tickUpper, bytes32(tokenId)));
        uint256 slot = uint256(keccak256(abi.encode(key, uint256(_stateSlot(pool)) + POSITIONS_OFFSET)));
        liquidity = uint128(_load(m.poolManager, slot));
        inside0LastX128 = _load(m.poolManager, slot + 1);
        inside1LastX128 = _load(m.poolManager, slot + 2);
    }
}
