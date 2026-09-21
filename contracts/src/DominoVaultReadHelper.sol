// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeAccounting} from "./FeeAccounting.sol";

import {DominoL2Block} from "./DominoL2Block.sol";

import {DominoVaultTypes as T, IPositionManagerE2, IStateViewE2} from "./DominoVaultTypes.sol";

/// @notice Immutable read, identity, encoding and integer utility for the vault.
/// @dev The vault invokes this contract through typed STATICCALLs after checking
/// its pinned runtime hash. No mutable storage, custody, callback to the vault,
/// approval or execution facility exists here. Public results are observations
/// and commitments, never fee provenance or authority to spend.
contract DominoVaultReadHelper {
    error InvalidIdentity();
    error InvalidPosition();
    error InvalidExecution();
    error InvalidAmount();

    address public immutable positionManager;
    address public immutable stateView;

    /// @dev Created once by the vault implementation constructor, after that
    /// constructor validates the manager addresses. A clone cannot replace it.
    constructor(address positionManager_, address stateView_) {
        positionManager = positionManager_;
        stateView = stateView_;
    }

    /// @dev Supplied directly from the calling vault's local state/immutables.
    /// Keeping the context explicit avoids re-entering its getters during init.
    struct SequenceContext {
        address owner;
        bytes32 sequenceId;
        address factory;
        address implementation;
        uint64 implementationVersion;
        address poolManager;
        bytes32 poolId;
        address baseCurrency;
        address quoteCurrency;
        address serviceFeeRecipient;
        T.PoolKey key;
    }

    struct SequenceWords {
        bytes32 typeHash;
        uint256 chainId;
        address owner_;
        bytes32 sequenceId_;
        address vault;
        address factory_;
        address implementation_;
        uint64 implementationVersion_;
        address poolManager_;
        address positionManager_;
        bytes32 key;
        bytes32 poolId_;
        address base;
        address quote;
        address feeRecipient;
    }

    struct PositionWords {
        bytes32 typeHash;
        bytes32 sequence;
        uint256 tokenId;
        uint64 generation;
        bool isRoot;
        uint256 parentTokenId;
        int24 lower;
        int24 upper;
        bytes32 corePositionId;
        bytes32 baseline;
    }

    error PermissionUnavailable();

    /// @dev No vault backcalls; arguments come from the caller's own state.
    function rootCustody(uint256 tokenId, address owner, address vault) external view returns (address) {
        IPositionManagerE2 manager = IPositionManagerE2(positionManager);
        if (manager.ownerOf(tokenId) != owner || manager.getApproved(tokenId) != vault) revert PermissionUnavailable();
        return manager.subscriber(tokenId);
    }

    function readInitialPosition(bytes32 poolId, uint256 tokenId, address base, address quote)
        external view returns (T.PoolKey memory key, int24 lo, int24 hi)
    {
        (key, lo, hi) = readPosition(poolId, tokenId);
        // readPosition has already refused a non-positive tick spacing.
        if (key.currency0 >= key.currency1 || key.fee > 1_000_000 || key.tickSpacing > 32767
            || key.hooks != address(0) || key.currency1.code.length == 0
            || (key.currency0 != address(0) && key.currency0.code.length == 0)
            || base == quote || !((base == key.currency0 && quote == key.currency1)
                || (base == key.currency1 && quote == key.currency0))) revert InvalidIdentity();
    }

    function readPosition(bytes32 poolId, uint256 tokenId)
        public
        view
        returns (T.PoolKey memory key, int24 lo, int24 hi)
    {
        if (tokenId == 0 || poolId == bytes32(0)) revert InvalidPosition();
        uint256 info;
        (key, info) = IPositionManagerE2(positionManager).getPoolAndPositionInfo(tokenId);
        if (info == 0 || keccak256(abi.encode(key)) != poolId || info >> 56 != uint256(poolId) >> 56) {
            revert InvalidPosition();
        }
        lo = int24(uint24(info >> 8));
        hi = int24(uint24(info >> 32));
        if (
            key.tickSpacing <= 0 || lo < -887272 || hi > 887272 || lo >= hi || lo % key.tickSpacing != 0
                || hi % key.tickSpacing != 0
        ) revert InvalidPosition();
    }

    function readCheckpoint(bytes32 poolId, bytes32 sequence, uint256 tokenId, int24 lo, int24 hi)
        external
        view
        returns (T.Checkpoint memory point)
    {
        uint256 currentBlock = DominoL2Block.number();
        if (currentBlock > type(uint64).max) revert InvalidIdentity();
        (point.liquidity, point.feeGrowthInside0LastX128, point.feeGrowthInside1LastX128) =
            IStateViewE2(stateView).getPositionInfo(poolId, positionManager, lo, hi, bytes32(tokenId));
        if (point.liquidity != IPositionManagerE2(positionManager).getPositionLiquidity(tokenId)) {
            revert InvalidPosition();
        }
        (point.feeGrowthInside0X128, point.feeGrowthInside1X128) =
            IStateViewE2(stateView).getFeeGrowthInside(poolId, lo, hi);
        point.observedAtBlock = uint64(currentBlock);
        point.commitment = keccak256(
            abi.encode(
                keccak256("DominoRegistrationCheckpointV1"),
                sequence,
                tokenId,
                point.liquidity,
                point.feeGrowthInside0LastX128,
                point.feeGrowthInside1LastX128,
                point.feeGrowthInside0X128,
                point.feeGrowthInside1X128,
                point.observedAtBlock
            )
        );
    }

    function validateCompoundPrice(bytes32 poolId, T.CompoundPlan calldata plan, uint32 maxAge)
        external view
    {
        // The timestamp is an operator commitment, independently matched to the
        // canonical L2 header by admission. ArbSys proves the recent L2 hash,
        // but cannot read that historical header's timestamp itself.
        uint256 currentBlock = DominoL2Block.number();
        if (currentBlock > type(uint64).max || plan.observedAtBlock >= currentBlock
            || currentBlock - plan.observedAtBlock >= 256 || plan.observedBlockHash == bytes32(0)
            || DominoL2Block.hash(plan.observedAtBlock) != plan.observedBlockHash
            || plan.observedAtTimestamp > block.timestamp
            || block.timestamp - plan.observedAtTimestamp > maxAge
            // deadline >= observedAtTimestamp follows from the two bounds on
            // block.timestamp above, so the subtraction below cannot underflow.
            || plan.deadline < block.timestamp
            || plan.deadline - plan.observedAtTimestamp > maxAge
            || plan.minSqrtPriceX96 == 0 || plan.minSqrtPriceX96 > plan.maxSqrtPriceX96) {
            revert InvalidExecution();
        }
        (uint160 price,,,) = IStateViewE2(stateView).getSlot0(poolId);
        if (price < plan.minSqrtPriceX96 || price > plan.maxSqrtPriceX96) revert InvalidExecution();
    }

    function accrued(T.Checkpoint calldata point) external pure returns (uint128 amount0, uint128 amount1) {
        uint256 growth0;
        uint256 growth1;
        unchecked {
            growth0 = point.feeGrowthInside0X128 - point.feeGrowthInside0LastX128;
            growth1 = point.feeGrowthInside1X128 - point.feeGrowthInside1LastX128;
        }
        amount0 = _accrued(growth0, point.liquidity);
        amount1 = _accrued(growth1, point.liquidity);
    }

    function _accrued(uint256 growth, uint128 liquidity) private pure returns (uint128) {
        // Exact floor(growth * liquidity / 2^128), without an overflowing
        // intermediate product. The manager's BalanceDelta is signed int128.
        uint256 value = (growth >> 128) * liquidity + ((uint256(uint128(growth)) * liquidity) >> 128);
        if (value > uint128(type(int128).max)) revert InvalidAmount();
        return uint128(value);
    }

    function compoundAmounts(T.CompoundAmounts memory value, uint128 added,
        uint128 maxOriginal, uint128 maxCharged, uint16 feeBps)
        external pure returns (T.CompoundAmounts memory)
    {
        if (feeBps > FeeAccounting.MAX_SERVICE_FEE_BPS) revert InvalidAmount();
        uint256 available = uint256(value.originalBefore) + value.realized;
        if (available + value.chargedBefore > type(uint128).max) revert InvalidAmount();
        value.liquidityAdded = added;
        uint128 charged = added < value.chargedBefore ? added : value.chargedBefore;
        if (charged > maxCharged) charged = maxCharged;
        value.chargedConsumed = charged;
        uint128 net = added - charged;
        // Minimal gross whose owner-favouring floor cut leaves exactly net.
        // ceil(net / (1-fee)) would overcharge at integer boundaries.
        uint256 gross = net == 0 ? 0 : (uint256(net - 1) * 10000) / (10000 - feeBps) + 1;
        if (gross > available || gross > maxOriginal) revert InvalidAmount();
        value.grossOriginalConsumed = uint128(gross);
        value.serviceFee = uint128(gross * feeBps / 10000);
        value.originalAfter = uint128(available - gross);
        value.chargedAfter = value.chargedBefore - charged;
        return value;
    }

    /// @dev E1 word order/type hashes are unchanged. Under the vault's STATICCALL
    /// msg.sender is the clone, not the helper or implementation. This utility
    /// does not authenticate other callers or validate arbitrary supplied state.
    function sequenceIdentity(SequenceContext calldata context) external view returns (bytes32) {
        T.PoolKey calldata key = context.key;
        SequenceWords memory value;
        value.typeHash = keccak256(
            "SequenceIdentity(uint256 chainId,address owner,bytes32 sequenceId,address vault,address factory,address implementation,uint64 implementationVersion,address poolManager,address positionManager,bytes32 poolKey,bytes32 poolId,address baseCurrency,address quoteCurrency,address serviceFeeRecipient)"
        );
        value.chainId = block.chainid;
        value.owner_ = context.owner;
        value.sequenceId_ = context.sequenceId;
        value.vault = msg.sender;
        value.factory_ = context.factory;
        value.implementation_ = context.implementation;
        value.implementationVersion_ = context.implementationVersion;
        value.poolManager_ = context.poolManager;
        value.positionManager_ = positionManager;
        value.key = keccak256(
            abi.encode(
                keccak256(
                    "PoolKey(address currency0,address currency1,uint24 fee_pips,int24 tick_spacing,address hooks)"
                ),
                key.currency0,
                key.currency1,
                key.fee,
                key.tickSpacing,
                key.hooks
            )
        );
        value.poolId_ = context.poolId;
        value.base = context.baseCurrency;
        value.quote = context.quoteCurrency;
        value.feeRecipient = context.serviceFeeRecipient;
        return keccak256(abi.encode(value));
    }

    function positionIdentity(bytes32 sequence, uint256 tokenId, T.Position calldata member)
        external
        view
        returns (bytes32)
    {
        PositionWords memory value;
        value.typeHash = keccak256(
            "PositionIdentity(bytes32 sequence,uint256 tokenId,uint64 generation,bool isRoot,uint256 parentTokenId,int24 tickLower,int24 tickUpper,bytes32 corePositionId,bytes32 registrationBaselineId)"
        );
        value.sequence = sequence;
        value.tokenId = tokenId;
        value.generation = member.generation;
        value.isRoot = member.isRoot;
        value.parentTokenId = member.parentTokenId;
        value.lower = member.tickLower;
        value.upper = member.tickUpper;
        value.corePositionId =
            keccak256(abi.encodePacked(positionManager, member.tickLower, member.tickUpper, bytes32(tokenId)));
        value.baseline = member.registrationBaselineId;
        return keccak256(abi.encode(value));
    }
}
