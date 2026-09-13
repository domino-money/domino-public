// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";
import {DominoExecutionTypes as E, IVaultExecutionV4} from "./DominoExecutionTypes.sol";
import {DominoVaultTypes as T, IStateViewE2, IPositionManagerE2} from "./DominoVaultTypes.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Stateless price-ratio/geometry checks using the pinned official MIT math.
contract DominoRoutingHelperV4 {
    error InvalidGeometry();
    error InvalidPrice();
    error InvalidExecution();
    error InvalidRoute();
    error InvalidAmount();

    function ratioBps(uint160 value, uint160 anchorPrice, bool inverse) public pure returns (uint256) {
        if (value == 0 || anchorPrice == 0) revert InvalidPrice();
        if (inverse) (value, anchorPrice) = (anchorPrice, value);
        // Exact floor(value squared * 10000 / anchorPrice squared).
        uint256 scaled = FullMath.mulDiv(value, uint256(value) * 10000, anchorPrice);
        return scaled / anchorPrice;
    }

    function nearCeiling(T.Position calldata member, uint160 price, bool inverse, uint16 trigger)
        external pure returns (bool) {
        uint160 ceiling = TickMath.getSqrtPriceAtTick(inverse ? member.tickLower : member.tickUpper);
        return ratioBps(price, ceiling, inverse) >= 10000 - trigger;
    }

    function validateSuccessor(T.Position calldata parent, int24 lower, int24 upper, int24 spacing,
        bool inverse, uint16 overlap, uint32 upside) external pure {
        if (spacing <= 0 || lower >= upper || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK
            || lower % spacing != 0 || upper % spacing != 0 || overlap > 2000 || upside == 0)
            revert InvalidGeometry();
        int24 ceilingTick = inverse ? lower : upper;
        int24 floorTick = inverse ? upper : lower;
        int24 priorCeiling = inverse ? parent.tickLower : parent.tickUpper;
        uint160 anchorPrice = TickMath.getSqrtPriceAtTick(priorCeiling);
        uint256 floorRatio = ratioBps(TickMath.getSqrtPriceAtTick(floorTick), anchorPrice, inverse);
        if (floorRatio < 10000 - overlap || floorRatio > 10000
            || ratioBps(TickMath.getSqrtPriceAtTick(ceilingTick), anchorPrice, inverse) < 10000 + upside)
            revert InvalidGeometry();
        int24 previous = inverse ? ceilingTick + spacing : ceilingTick - spacing;
        if (previous >= TickMath.MIN_TICK && previous <= TickMath.MAX_TICK &&
            ratioBps(TickMath.getSqrtPriceAtTick(previous), anchorPrice, inverse) >= 10000 + upside)
            revert InvalidGeometry();
    }

    function checkSwapPrices(uint160 beforePrice, uint160 afterPrice, uint160 anchorPrice,
        uint16 impactBps) external pure {
        if (impactBps >= 10000) revert InvalidPrice();
        uint256 beforeRatio = ratioBps(beforePrice, anchorPrice, false);
        uint256 afterRatio = ratioBps(afterPrice, anchorPrice, false);
        if (beforeRatio < 10000 - impactBps || _ratioCeil(beforePrice, anchorPrice) > 10000 + impactBps
            || afterRatio < 10000 - impactBps || _ratioCeil(afterPrice, anchorPrice) > 10000 + impactBps) revert InvalidPrice();
    }

    function compoundAmounts(T.CompoundAmounts memory value, uint128 added,
        uint128 maxOriginal, uint128 maxCharged, uint16 feeBps, uint128 grossBefore)
        external pure returns (T.CompoundAmounts memory) {
        if (feeBps > 200) revert InvalidAmount();
        uint256 available = uint256(value.originalBefore) + value.realized;
        if (available + value.chargedBefore > type(uint128).max) revert InvalidAmount();
        value.liquidityAdded = added;
        uint128 charged = added < value.chargedBefore ? added : value.chargedBefore;
        if (charged > maxCharged) charged = maxCharged;
        value.chargedConsumed = charged;
        uint256 net = added - charged;
        uint256 priorFee = uint256(grossBefore) * feeBps / 10000;
        uint256 totalNet = uint256(grossBefore) - priorFee + net;
        uint256 gross = net == 0 ? 0 : (totalNet - 1) * 10000 / (10000 - feeBps) + 1 - grossBefore;
        if (gross > available || gross > maxOriginal) revert InvalidAmount();
        value.grossOriginalConsumed = uint128(gross);
        value.serviceFee = uint128((uint256(grossBefore) + gross) * feeBps / 10000 - priorFee);
        value.originalAfter = uint128(available - gross);
        value.chargedAfter = value.chargedBefore - charged;
        return value;
    }

    function _ratioCeil(uint160 value, uint160 anchorPrice) private pure returns (uint256) {
        uint256 scaled = FullMath.mulDivRoundingUp(value, uint256(value) * 10000, anchorPrice);
        return scaled / anchorPrice + (scaled % anchorPrice == 0 ? 0 : 1);
    }

    function minimumOutput(uint128 amountIn, uint160 price, bool zeroForOne, uint16 slippageBps)
        external pure returns (uint256) {
        if (price == 0 || slippageBps >= 10000) revert InvalidPrice();
        uint256 quote;
        if (price <= type(uint128).max) {
            uint256 ratio = uint256(price) * price;
            quote = zeroForOne ? FullMath.mulDiv(ratio, amountIn, uint256(1) << 192)
                : FullMath.mulDiv(uint256(1) << 192, amountIn, ratio);
        } else {
            uint256 ratio = FullMath.mulDiv(price, price, uint256(1) << 64);
            quote = zeroForOne ? FullMath.mulDiv(ratio, amountIn, uint256(1) << 128)
                : FullMath.mulDiv(uint256(1) << 128, amountIn, ratio);
        }
        return FullMath.mulDiv(quote, 10000 - slippageBps, 10000);
    }
    function validate(address vaultAddress, E.Plan calldata plan, DominoVaultReadHelper readHelper) external view {
        IVaultExecutionV4 vault = IVaultExecutionV4(vaultAddress);
        T.CompoundPlan calldata a = plan.authority;
        IDominoVaultDraft.Policy memory rules = vault.policy();
        T.ExecutionLimits memory limits = vault.executionLimits();
        T.Position memory parent = vault.position(a.tokenId);
        uint64 last = vault.lastExecutionAt();
        if (plan.action > E.MINT || a.intentId == bytes32(0) || vault.consumedIntent(a.intentId)
            || !parent.active || a.positionIdentity != parent.identity || a.checkpointId != vault.checkpoint(a.tokenId).commitment
            || a.policyVersion != rules.version || a.limitsVersion != limits.version || a.stateNonce != vault.stateNonce()
            || a.authorityGeneration != vault.authorityGeneration() || a.liquidityIncrease == 0
            || a.liquidityIncrease > uint128(type(int128).max) || block.timestamp > type(uint64).max
            || (last != 0 && block.timestamp - last < rules.minimumIntervalSeconds)
            || a.maxOriginal0 != 0 || a.maxOriginal1 != 0 || a.maxCharged0 != 0 || a.maxCharged1 != 0
            || plan.collect.length > 16 || plan.budgets.length == 0 || plan.budgets.length > 32)
            revert InvalidExecution();
        if (vault.positionManager() != readHelper.positionManager()) revert InvalidExecution();
        readHelper.validateCompoundPrice(vault.poolId(), a, limits.maxObservationAgeSeconds);
        T.PoolKey memory key = vault.poolKey();
        if (key.hooks != address(0) || key.fee > 1_000_000) revert InvalidRoute();
        (uint160 price,int24 tick,,) = IStateViewE2(readHelper.stateView()).getSlot0(vault.poolId());
        bool inverse = vault.baseCurrency() == key.currency1;
        if (plan.action <= E.NET) {
            if (plan.destinationTokenId != a.tokenId || plan.tickLower != 0 || plan.tickUpper != 0) revert InvalidRoute();
        } else if (plan.action == E.MINT) {
            if (plan.destinationTokenId != 0 || vault.successorOf(a.tokenId) != 0 || vault.activePositions() >= rules.maxPositions
                || !this.nearCeiling(parent,price,inverse,rules.triggerDistanceBps)) revert InvalidRoute();
            this.validateSuccessor(parent,plan.tickLower,plan.tickUpper,key.tickSpacing,inverse,rules.maxOverlapBps,limits.upsideBps);
        } else if (plan.tickLower != 0 || plan.tickUpper != 0 || !vault.position(plan.destinationTokenId).active) revert InvalidRoute();
        for (uint256 i; i < plan.collect.length; ++i) {
            E.PositionRef calldata ref = plan.collect[i]; T.Position memory member = vault.position(ref.tokenId);
            if (!member.active || (i != 0 && plan.collect[i-1].tokenId >= ref.tokenId)
                || member.identity != ref.positionIdentity || vault.checkpoint(ref.tokenId).commitment != ref.checkpointId)
                revert InvalidExecution();
            _custody(vault,ref.tokenId,member);
        }
        for (uint256 i; i < plan.budgets.length; ++i) {
            E.FeeBudget calldata b = plan.budgets[i]; T.Source memory source = vault.source(b.sourceId);
            if (!source.known || !vault.position(source.tokenId).active || (b.maxOriginal == 0 && b.maxCharged == 0)
                || (b.currency != key.currency0 && b.currency != key.currency1)
                || (b.maxOriginal != 0 && source.originalCurrency != b.currency)) revert InvalidAmount();
            if (i != 0) {
                E.FeeBudget calldata previous = plan.budgets[i-1];
                if (previous.sourceId > b.sourceId || (previous.sourceId == b.sourceId && previous.currency >= b.currency))
                    revert InvalidAmount();
            }
            _sourceRoute(vault,plan,source.tokenId,price,tick,inverse,rules);
        }
        if (plan.swap.amountIn == 0) {
            E.SwapPlan memory empty;
            if (keccak256(abi.encode(plan.swap)) != keccak256(abi.encode(empty))) revert InvalidRoute();
        } else if (plan.action == E.NET || plan.swap.sourceId == bytes32(0) || plan.swap.minAmountOut == 0
            || plan.swap.sqrtPriceLimitX96 == 0 || plan.swap.priceObservationId == bytes32(0)) revert InvalidRoute();
    }

    function _sourceRoute(IVaultExecutionV4 vault, E.Plan calldata p, uint256 tokenId, uint160 price,
        int24 tick, bool inverse, IDominoVaultDraft.Policy memory rules) private view {
        T.Position memory member = vault.position(tokenId); _custody(vault,tokenId,member);
        if (p.action <= E.NET) { if (tokenId != p.destinationTokenId) revert InvalidRoute(); return; }
        if (p.action == E.MINT) { if (tokenId != p.authority.tokenId) revert InvalidRoute(); return; }
        if (tokenId == p.destinationTokenId) return;
        T.Position memory target = vault.position(p.destinationTokenId);
        bool sourceInside = tick >= member.tickLower && tick < member.tickUpper;
        if (sourceInside) {
            if (!this.nearCeiling(member,price,inverse,rules.triggerDistanceBps)
                || vault.successorOf(tokenId) != p.destinationTokenId) revert InvalidRoute();
        } else if (!(tick >= target.tickLower && tick < target.tickUpper)) revert InvalidRoute();
    }

    function _custody(IVaultExecutionV4 vault, uint256 id, T.Position memory member) private view {
        if (IPositionManagerE2(vault.positionManager()).ownerOf(id) != (member.isRoot ? vault.owner() : address(vault)))
            revert InvalidExecution();
    }

}
