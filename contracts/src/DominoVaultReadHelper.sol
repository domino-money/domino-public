// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IPositionManagerE2, IStateViewE2} from "./DominoVaultTypes.sol";

/// @notice Immutable read/identity utility for the version-2 custody vault.
/// @dev The vault invokes this contract through typed STATICCALLs after checking
/// its pinned runtime hash. No mutable storage, custody, callback to the vault,
/// approval or execution facility exists here. Public results are observations
/// and commitments, never fee provenance or authority to spend.
contract DominoVaultReadHelper {
    error InvalidIdentity();
    error InvalidPosition();

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

    function readPosition(bytes32 poolId, uint256 tokenId)
        external
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
        if (block.number > type(uint64).max) revert InvalidIdentity();
        (point.liquidity, point.feeGrowthInside0LastX128, point.feeGrowthInside1LastX128) =
            IStateViewE2(stateView).getPositionInfo(poolId, positionManager, lo, hi, bytes32(tokenId));
        if (point.liquidity != IPositionManagerE2(positionManager).getPositionLiquidity(tokenId)) {
            revert InvalidPosition();
        }
        (point.feeGrowthInside0X128, point.feeGrowthInside1X128) =
            IStateViewE2(stateView).getFeeGrowthInside(poolId, lo, hi);
        point.observedAtBlock = uint64(block.number);
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
