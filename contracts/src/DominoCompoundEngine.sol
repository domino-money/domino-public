// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IPoolManagerE4, IERC20E2, IPositionManagerE2} from "./DominoVaultTypes.sol";
import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";

interface ICompoundVault {
    function stateNonce() external view returns (uint64);
    function authorityGeneration() external view returns (uint64);
    function lastExecutionAt() external view returns (uint64);
    function consumedIntent(bytes32 intentId) external view returns (bool);
    function poolId() external view returns (bytes32);
    function poolKey() external view returns (T.PoolKey memory);
    function position(uint256 tokenId) external view returns (T.Position memory);
    function checkpoint(uint256 tokenId) external view returns (T.Checkpoint memory);
    function sequenceIdentityHash() external view returns (bytes32);
    function feeBalance(bytes32 source, address currency) external view returns (T.FeeBalance memory);
    function policy() external view returns (IDominoVaultDraft.Policy memory);
    function executionLimits() external view returns (T.ExecutionLimits memory);
    function compoundModify(bool increase, uint128 amount0, uint128 amount1) external;
    function compoundApply(T.CompoundAmounts[2] calldata values) external;
    function compoundCheckpoint(T.Checkpoint calldata point) external;
}

/// @notice Fixed, non-custodial orchestration for one typed same-NFT compound.
/// @dev No delegatecall, upgrades, token approvals, payable entry or arbitrary
/// target/calldata. Only exact clones of the constructing implementation can
/// enter. Vault callbacks separately require an active owner/operator action.
contract DominoCompoundEngine {
    event FeesRealized(address indexed vault, bytes32 indexed intentId, uint256 indexed tokenId,
        bytes32 checkpointBefore, bytes32 checkpointAfter, uint128 amount0, uint128 amount1);
    event SourceFeesApplied(address indexed vault, bytes32 indexed intentId, bytes32 indexed sourceId,
        address currency, T.CompoundAmounts amounts);

    error InvalidExecution();
    error InvalidAmount();
    error UnexpectedCallback();

    address public immutable poolManager;
    address public immutable positionManager;
    DominoVaultReadHelper public immutable readHelper;
    bytes32 public immutable cloneRuntimeHash;
    address private _activeVault;
    bytes32 private _unlockHash;

    constructor(address implementation, address poolManager_, address positionManager_, address readHelper_) {
        poolManager = poolManager_;
        positionManager = positionManager_;
        readHelper = DominoVaultReadHelper(readHelper_);
        cloneRuntimeHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
    }

    function execute(T.CompoundPlan calldata plan) external returns (bytes32 planHash) {
        if (msg.sender.codehash != cloneRuntimeHash || _activeVault != address(0)) revert InvalidExecution();
        _validate(ICompoundVault(msg.sender), plan);
        _activeVault = msg.sender;
        bytes memory encoded = abi.encode(plan);
        _unlockHash = keccak256(encoded);
        IPoolManagerE4(poolManager).unlock(encoded);
        if (_unlockHash != bytes32(0)) revert UnexpectedCallback();
        delete _activeVault;
        return keccak256(abi.encode(keccak256("DominoCompoundSelfV1"), block.chainid, msg.sender, ICompoundVault(msg.sender).sequenceIdentityHash(), plan));
    }

    function _validate(ICompoundVault vault, T.CompoundPlan calldata plan) private view {
        IDominoVaultDraft.Policy memory rules = vault.policy();
        T.ExecutionLimits memory limits = vault.executionLimits();
        if (plan.policyVersion != rules.version || plan.limitsVersion != limits.version
            || plan.stateNonce != vault.stateNonce() || plan.authorityGeneration != vault.authorityGeneration()) {
            revert InvalidExecution();
        }
        T.Position memory member = vault.position(plan.tokenId);
        if (!member.active || member.identity != plan.positionIdentity
            || vault.checkpoint(plan.tokenId).commitment != plan.checkpointId) revert InvalidExecution();
        if (!member.isRoot && IPositionManagerE2(positionManager).ownerOf(plan.tokenId) != address(vault)) {
            revert InvalidExecution();
        }
        uint64 last = vault.lastExecutionAt();
        if (plan.intentId == bytes32(0) || vault.consumedIntent(plan.intentId)
            || plan.liquidityIncrease == 0 || plan.liquidityIncrease > uint128(type(int128).max)
            || block.timestamp > type(uint64).max
            || (last != 0 && block.timestamp - last < rules.minimumIntervalSeconds)) revert InvalidExecution();
        readHelper.validateCompoundPrice(vault.poolId(), plan, limits.maxObservationAgeSeconds);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager || _activeVault == address(0) || _unlockHash == bytes32(0)
            || keccak256(data) != _unlockHash) revert UnexpectedCallback();
        delete _unlockHash;
        T.CompoundPlan memory plan = abi.decode(data, (T.CompoundPlan));
        ICompoundVault vault = ICompoundVault(_activeVault);
        T.PoolKey memory key = vault.poolKey();
        T.Position memory member = vault.position(plan.tokenId);
        bytes32 pool = vault.poolId();
        bytes32 sequence = vault.sequenceIdentityHash();
        T.Checkpoint memory beforePoint = _point(pool, sequence, plan.tokenId, member);
        T.Checkpoint memory stored = vault.checkpoint(plan.tokenId);
        if (beforePoint.liquidity != stored.liquidity
            || beforePoint.feeGrowthInside0LastX128 != stored.feeGrowthInside0LastX128
            || beforePoint.feeGrowthInside1LastX128 != stored.feeGrowthInside1LastX128
            || _managerDelta(key.currency0) != 0 || _managerDelta(key.currency1) != 0) revert InvalidExecution();
        (uint128 realized0, uint128 realized1) = readHelper.accrued(beforePoint);
        uint256 before0 = _balance(key.currency0);
        uint256 before1 = _balance(key.currency1);
        T.CompoundAmounts[2] memory values;
        T.FeeBalance memory balance0 = vault.feeBalance(member.source0, key.currency0);
        T.FeeBalance memory balance1 = vault.feeBalance(member.source1, key.currency1);
        values[0].originalBefore = balance0.original;
        values[0].chargedBefore = balance0.charged;
        values[0].realized = realized0;
        values[1].originalBefore = balance1.original;
        values[1].chargedBefore = balance1.charged;
        values[1].realized = realized1;
        vault.compoundModify(false, realized0, realized1);
        if (_balance(key.currency0) != before0 + realized0 || _balance(key.currency1) != before1 + realized1
            || _managerDelta(key.currency0) != 0 || _managerDelta(key.currency1) != 0) revert InvalidAmount();
        T.Checkpoint memory collected = _point(pool, sequence, plan.tokenId, member);
        _checkPoint(beforePoint, collected, beforePoint.liquidity);
        vault.compoundModify(true, plan.liquidityIncrease, 0);
        uint128 added0 = _managerDebt(key.currency0);
        uint128 added1 = _managerDebt(key.currency1);
        if ((added0 == 0 && added1 == 0) || added0 < plan.minAdded0 || added1 < plan.minAdded1) revert InvalidAmount();
        uint16 bps = vault.policy().serviceFeeBps;
        values[0] = readHelper.compoundAmounts(values[0], added0, plan.maxOriginal0, plan.maxCharged0, bps);
        values[1] = readHelper.compoundAmounts(values[1], added1, plan.maxOriginal1, plan.maxCharged1, bps);
        vault.compoundApply(values);
        emit FeesRealized(_activeVault, plan.intentId, plan.tokenId, beforePoint.commitment, collected.commitment, realized0, realized1);
        for (uint256 i = 0; i < 2; ++i) {
            emit SourceFeesApplied(_activeVault, plan.intentId, i == 0 ? member.source0 : member.source1,
                i == 0 ? key.currency0 : key.currency1, values[i]);
        }
        if (_balance(key.currency0) != before0 + realized0 - values[0].grossOriginalConsumed - values[0].chargedConsumed
            || _balance(key.currency1) != before1 + realized1 - values[1].grossOriginalConsumed - values[1].chargedConsumed
            || _managerDelta(key.currency0) != 0 || _managerDelta(key.currency1) != 0) revert InvalidAmount();
        T.Checkpoint memory afterPoint = _point(pool, sequence, plan.tokenId, member);
        _checkPoint(beforePoint, afterPoint, beforePoint.liquidity + plan.liquidityIncrease);
        readHelper.validateCompoundPrice(pool, plan, vault.executionLimits().maxObservationAgeSeconds);
        vault.compoundCheckpoint(afterPoint);
        return bytes("");
    }

    function _point(bytes32 pool, bytes32 sequence, uint256 tokenId, T.Position memory member)
        private view returns (T.Checkpoint memory)
    {
        return readHelper.readCheckpoint(pool, sequence, tokenId, member.tickLower, member.tickUpper);
    }

    function _checkPoint(T.Checkpoint memory beforePoint, T.Checkpoint memory afterPoint, uint128 liquidity) private pure {
        if (afterPoint.liquidity != liquidity
            || afterPoint.feeGrowthInside0LastX128 != beforePoint.feeGrowthInside0X128
            || afterPoint.feeGrowthInside1LastX128 != beforePoint.feeGrowthInside1X128
            || afterPoint.feeGrowthInside0X128 != beforePoint.feeGrowthInside0X128
            || afterPoint.feeGrowthInside1X128 != beforePoint.feeGrowthInside1X128) revert InvalidExecution();
    }

    function _balance(address currency) private view returns (uint256) {
        return currency == address(0) ? _activeVault.balance : IERC20E2(currency).balanceOf(_activeVault);
    }

    function _managerDelta(address currency) private view returns (int256) {
        return int256(uint256(IPoolManagerE4(poolManager).exttload(keccak256(abi.encode(positionManager, currency)))));
    }

    function _managerDebt(address currency) private view returns (uint128) {
        int256 delta = _managerDelta(currency);
        if (delta > 0 || delta < -int256(uint256(uint128(type(int128).max)))) revert InvalidAmount();
        return uint128(uint256(-delta));
    }
}
