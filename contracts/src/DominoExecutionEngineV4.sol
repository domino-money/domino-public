// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IPositionManagerE2, IStateViewE2, IERC20E2, IPoolManagerE4} from "./DominoVaultTypes.sol";
import {DominoExecutionTypes as E, IVaultFactoryV4, IPriceGuardV4} from "./DominoExecutionTypes.sol";
import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";
import {DominoRoutingHelperV4} from "./DominoRoutingHelperV4.sol";
import {IDominoVaultDraft} from "./IDominoVaultDraft.sol";

interface IVaultExecutionV4 {
    function owner() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
    function stateNonce() external view returns (uint64);
    function authorityGeneration() external view returns (uint64);
    function lastExecutionAt() external view returns (uint64);
    function activePositions() external view returns (uint256);
    function consumedIntent(bytes32) external view returns (bool);
    function successorOf(uint256) external view returns (uint256);
    function baseCurrency() external view returns (address);
    function poolId() external view returns (bytes32);
    function poolKey() external view returns (T.PoolKey memory);
    function position(uint256) external view returns (T.Position memory);
    function source(bytes32) external view returns (T.Source memory);
    function checkpoint(uint256) external view returns (T.Checkpoint memory);
    function sequenceIdentityHash() external view returns (bytes32);
    function feeBalance(bytes32, address) external view returns (T.FeeBalance memory);
    function policy() external view returns (IDominoVaultDraft.Policy memory);
    function executionLimits() external view returns (T.ExecutionLimits memory);
    function executionModify(uint256, uint128, uint128, uint128, bool) external;
    function executionCredit(uint256, uint128, uint128) external;
    function executionConvert(bytes32, address, uint128) external;
    function executionCheckpoint(uint256, T.Checkpoint calldata) external;
    function executionApply(bytes32, address, T.CompoundAmounts calldata, address, bool) external;
    function executionMint(bytes32, uint256, int24, int24, uint128) external returns (uint256);
}

interface IPoolSwapV4 is IPoolManagerE4 {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function swap(T.PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function take(address currency, address recipient, uint256 amount) external;
}

/// @notice Fixed noncustodial execution engine: no delegatecall, router calldata,
/// wallet funding, allowance, native payable entry or configurable recipient.
contract DominoExecutionEngineV4 {
    error InvalidExecution();
    error InvalidAmount();
    error InvalidRoute();
    error UnexpectedCallback();
    address public immutable factory;
    DominoVaultReadHelper public immutable readHelper;
    DominoRoutingHelperV4 public immutable routingHelper;
    IPriceGuardV4 public immutable priceGuard;
    bytes32 public immutable readHelperHash;
    bytes32 public immutable routingHelperHash;
    bytes32 public immutable priceGuardHash;
    address private _activeVault;
    bytes32 private _unlockHash;
    uint256 private _destination;
    uint256 public constant MAX_COLLECTIONS = 16;
    uint256 public constant MAX_BUDGETS = 32;

    event FeesRealized(address indexed vault, bytes32 indexed intentId, uint256 indexed tokenId,
        bytes32 checkpointBefore, bytes32 checkpointAfter, uint128 amount0, uint128 amount1);
    event BudgetApplied(address indexed vault, bytes32 indexed intentId, bytes32 indexed sourceId,
        address currency, uint256 destinationTokenId, T.CompoundAmounts amounts);
    event FeesConverted(address indexed vault, bytes32 indexed intentId, bytes32 indexed sourceId,
        address currencyIn, address currencyOut, uint128 amountIn, uint128 amountOut,
        T.CompoundAmounts inputAmounts, uint128 chargedOutputBefore, uint128 chargedOutputAfter);

    constructor(address factory_, address readHelper_, address routingHelper_, address priceGuard_) {
        if (factory_.code.length == 0 || readHelper_.code.length == 0
            || routingHelper_.code.length == 0 || priceGuard_.code.length == 0) revert InvalidExecution();
        factory = factory_; readHelper = DominoVaultReadHelper(readHelper_);
        routingHelper = DominoRoutingHelperV4(routingHelper_); priceGuard = IPriceGuardV4(priceGuard_);
        readHelperHash = readHelper_.codehash; routingHelperHash = routingHelper_.codehash;
        priceGuardHash = priceGuard_.codehash;
    }

    function execute(E.Plan calldata plan) external returns (bytes32 planHash, uint256 destination) {
        address implementation = IVaultFactoryV4(factory).implementation();
        bytes32 cloneHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73",implementation,hex"5af43d82803e903d91602b57fd5bf3"));
        if (!IVaultFactoryV4(factory).isVault(msg.sender) || msg.sender.codehash != cloneHash || _activeVault != address(0)
            || address(readHelper).codehash != readHelperHash || address(routingHelper).codehash != routingHelperHash
            || address(priceGuard).codehash != priceGuardHash) revert InvalidExecution();
        IVaultExecutionV4 vault = IVaultExecutionV4(msg.sender);
        _validate(vault, plan);
        _activeVault = msg.sender;
        bytes memory data = abi.encode(plan); _unlockHash = keccak256(data);
        IPoolManagerE4(vault.poolManager()).unlock(data);
        if (_unlockHash != bytes32(0)) revert UnexpectedCallback();
        destination = _destination;
        planHash = keccak256(abi.encode(keccak256("DominoExecutionV4"),block.chainid,msg.sender,vault.sequenceIdentityHash(),plan));
        delete _activeVault; delete _destination;
    }

    function _validate(IVaultExecutionV4 vault, E.Plan calldata plan) private view {
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
            || plan.collect.length > MAX_COLLECTIONS || plan.budgets.length == 0 || plan.budgets.length > MAX_BUDGETS)
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
                || !routingHelper.nearCeiling(parent,price,inverse,rules.triggerDistanceBps)) revert InvalidRoute();
            routingHelper.validateSuccessor(parent,plan.tickLower,plan.tickUpper,key.tickSpacing,inverse,rules.maxOverlapBps,limits.upsideBps);
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
            if (!routingHelper.nearCeiling(member,price,inverse,rules.triggerDistanceBps)
                || vault.successorOf(tokenId) != p.destinationTokenId) revert InvalidRoute();
        } else if (!(tick >= target.tickLower && tick < target.tickUpper)) revert InvalidRoute();
    }

    function _custody(IVaultExecutionV4 vault, uint256 id, T.Position memory member) private view {
        if (IPositionManagerE2(readHelper.positionManager()).ownerOf(id) != (member.isRoot ? vault.owner() : address(vault)))
            revert InvalidExecution();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        IVaultExecutionV4 vault = IVaultExecutionV4(_activeVault);
        if (_activeVault == address(0) || msg.sender != vault.poolManager() || _unlockHash == bytes32(0)
            || keccak256(data) != _unlockHash) revert UnexpectedCallback();
        delete _unlockHash;
        E.Plan memory plan = abi.decode(data,(E.Plan));
        T.PoolKey memory key = vault.poolKey();
        if (_delta(vault.positionManager(),key.currency0) != 0 || _delta(vault.positionManager(),key.currency1) != 0
            || _delta(address(this),key.currency0) != 0 || _delta(address(this),key.currency1) != 0) revert InvalidExecution();
        if (plan.action == E.NET) _net(vault,plan,key);
        else {
            for (uint256 i; i < plan.collect.length; ++i) _collect(vault,plan.authority.intentId,plan.collect[i].tokenId,key);
            if (plan.swap.amountIn != 0) _swap(vault,plan,key);
            _fund(vault,plan,key);
        }
        readHelper.validateCompoundPrice(vault.poolId(),plan.authority,vault.executionLimits().maxObservationAgeSeconds);
        if (_delta(vault.positionManager(),key.currency0) != 0 || _delta(vault.positionManager(),key.currency1) != 0
            || _delta(address(this),key.currency0) != 0 || _delta(address(this),key.currency1) != 0) revert InvalidAmount();
        return bytes("");
    }

    function _point(IVaultExecutionV4 vault, uint256 id) private view returns (T.Checkpoint memory) {
        T.Position memory member = vault.position(id);
        return readHelper.readCheckpoint(vault.poolId(),vault.sequenceIdentityHash(),id,member.tickLower,member.tickUpper);
    }

    function _before(IVaultExecutionV4 vault, uint256 id) private view returns (T.Checkpoint memory point) {
        point = _point(vault,id); T.Checkpoint memory stored = vault.checkpoint(id);
        if (point.liquidity != stored.liquidity || point.feeGrowthInside0LastX128 != stored.feeGrowthInside0LastX128
            || point.feeGrowthInside1LastX128 != stored.feeGrowthInside1LastX128) revert InvalidExecution();
    }

    function _after(T.Checkpoint memory beforePoint, T.Checkpoint memory afterPoint, uint128 increase) private pure {
        if (afterPoint.liquidity != beforePoint.liquidity + increase
            || afterPoint.feeGrowthInside0LastX128 != beforePoint.feeGrowthInside0X128
            || afterPoint.feeGrowthInside1LastX128 != beforePoint.feeGrowthInside1X128
            || afterPoint.feeGrowthInside0X128 != beforePoint.feeGrowthInside0X128
            || afterPoint.feeGrowthInside1X128 != beforePoint.feeGrowthInside1X128) revert InvalidExecution();
    }

    function _collect(IVaultExecutionV4 vault, bytes32 intentId, uint256 id, T.PoolKey memory key) private {
        T.Checkpoint memory beforePoint = _before(vault,id);
        (uint128 a,uint128 b) = readHelper.accrued(beforePoint);
        uint256 old0 = _balance(key.currency0); uint256 old1 = _balance(key.currency1);
        vault.executionModify(id,0,a,b,true);
        if (_balance(key.currency0) != old0+a || _balance(key.currency1) != old1+b
            || _delta(vault.positionManager(),key.currency0) != 0 || _delta(vault.positionManager(),key.currency1) != 0) revert InvalidAmount();
        T.Checkpoint memory point = _point(vault,id); _after(beforePoint,point,0);
        vault.executionCredit(id,a,b); vault.executionCheckpoint(id,point);
        emit FeesRealized(address(vault),intentId,id,beforePoint.commitment,point.commitment,a,b);
    }

    function _fund(IVaultExecutionV4 vault, E.Plan memory plan, T.PoolKey memory key) private {
        uint256 id = plan.destinationTokenId;
        T.Checkpoint memory beforePoint;
        if (plan.action == E.MINT) id = vault.executionMint(plan.authority.intentId,plan.authority.tokenId,
            plan.tickLower,plan.tickUpper,plan.authority.liquidityIncrease);
        else {
            // A destination not among the sources may have its own uncollected
            // fees. Realize them into their own sources before increasing it.
            bool alreadyCollected;
            for (uint256 i; i < plan.collect.length; ++i) if (plan.collect[i].tokenId == id) alreadyCollected = true;
            if (!alreadyCollected || plan.swap.amountIn != 0) _collect(vault,plan.authority.intentId,id,key);
            beforePoint = _before(vault,id);
            vault.executionModify(id,plan.authority.liquidityIncrease,0,0,false);
        }
        _destination = id;
        uint128 added0 = _debt(vault.positionManager(),key.currency0);
        uint128 added1 = _debt(vault.positionManager(),key.currency1);
        if ((added0 == 0 && added1 == 0) || added0 < plan.authority.minAdded0 || added1 < plan.authority.minAdded1) revert InvalidAmount();
        _allocate(vault,plan,key.currency0,added0); _allocate(vault,plan,key.currency1,added1);
        if (plan.action != E.MINT) {
            T.Checkpoint memory afterPoint = _point(vault,id); _after(beforePoint,afterPoint,plan.authority.liquidityIncrease);
            vault.executionCheckpoint(id,afterPoint);
        } else if (_point(vault,id).liquidity != plan.authority.liquidityIncrease) revert InvalidExecution();
    }

    function _amounts(IVaultExecutionV4 vault, E.FeeBudget memory budget, uint128 wanted)
        private view returns (T.CompoundAmounts memory value) {
        T.FeeBalance memory balance = vault.feeBalance(budget.sourceId,budget.currency);
        value.originalBefore = balance.original; value.chargedBefore = balance.charged;
        return readHelper.compoundAmounts(value,wanted,budget.maxOriginal,budget.maxCharged,vault.policy().serviceFeeBps);
    }

    function _allocate(IVaultExecutionV4 vault, E.Plan memory plan, address currency, uint128 remaining) private {
        for (uint256 i; i < plan.budgets.length && remaining != 0; ++i) {
            E.FeeBudget memory b = plan.budgets[i]; if (b.currency != currency) continue;
            T.FeeBalance memory available = vault.feeBalance(b.sourceId,currency);
            uint128 gross = available.original < b.maxOriginal ? available.original : b.maxOriginal;
            uint128 charged = available.charged < b.maxCharged ? available.charged : b.maxCharged;
            uint256 net = uint256(gross) - uint256(gross)*vault.policy().serviceFeeBps/10000 + charged;
            uint128 wanted = net < remaining ? uint128(net) : remaining;
            if (wanted == 0) continue;
            T.CompoundAmounts memory value = _amounts(vault,b,wanted);
            vault.executionApply(b.sourceId,currency,value,vault.positionManager(),false);
            emit BudgetApplied(address(vault),plan.authority.intentId,b.sourceId,currency,_destination,value);
            remaining -= wanted;
        }
        if (remaining != 0) revert InvalidAmount();
    }

    function _net(IVaultExecutionV4 vault, E.Plan memory plan, T.PoolKey memory key) private {
        uint256 id = plan.authority.tokenId; T.Position memory member = vault.position(id);
        if (plan.collect.length != 1 || plan.collect[0].tokenId != id || plan.budgets.length != 2) revert InvalidRoute();
        T.Checkpoint memory beforePoint = _before(vault,id);
        (uint128 realized0,uint128 realized1) = readHelper.accrued(beforePoint);
        uint256 old0 = _balance(key.currency0); uint256 old1 = _balance(key.currency1);
        // TAKE_PAIR rejects a negative side; this deliberately narrow optimized
        // path never falls back to the general implementation.
        vault.executionModify(id,plan.authority.liquidityIncrease,realized0,realized1,true);
        uint256 received0 = _balance(key.currency0)-old0;
        uint256 received1 = _balance(key.currency1)-old1;
        if (received0 > realized0 || received1 > realized1) revert InvalidAmount();
        uint128 added0 = realized0-uint128(received0); uint128 added1 = realized1-uint128(received1);
        if ((added0 == 0 && added1 == 0) || added0 < plan.authority.minAdded0 || added1 < plan.authority.minAdded1) revert InvalidAmount();
        for (uint256 i; i < 2; ++i) {
            E.FeeBudget memory budget = plan.budgets[i];
            bool zero = budget.currency == key.currency0;
            if (budget.sourceId != (zero ? member.source0 : member.source1) || budget.maxCharged != 0) revert InvalidRoute();
            T.FeeBalance memory balance = vault.feeBalance(budget.sourceId,budget.currency);
            T.CompoundAmounts memory value; value.originalBefore = balance.original; value.chargedBefore = balance.charged;
            value.realized = zero ? realized0 : realized1;
            value = readHelper.compoundAmounts(value,zero ? added0 : added1,budget.maxOriginal,0,vault.policy().serviceFeeBps);
            if (value.grossOriginalConsumed > value.realized) revert InvalidAmount();
            vault.executionApply(budget.sourceId,budget.currency,value,vault.positionManager(),true);
            emit BudgetApplied(address(vault),plan.authority.intentId,budget.sourceId,budget.currency,id,value);
        }
        T.Checkpoint memory afterPoint = _point(vault,id); _after(beforePoint,afterPoint,plan.authority.liquidityIncrease);
        vault.executionCheckpoint(id,afterPoint); _destination = id;
        emit FeesRealized(address(vault),plan.authority.intentId,id,beforePoint.commitment,afterPoint.commitment,realized0,realized1);
    }

    function _swap(IVaultExecutionV4 vault, E.Plan memory plan, T.PoolKey memory key) private {
        E.SwapPlan memory route = plan.swap;
        bool zeroForOne = route.currencyIn == key.currency0;
        if (!zeroForOne && route.currencyIn != key.currency1) revert InvalidRoute();
        address outputCurrency = zeroForOne ? key.currency1 : key.currency0;
        uint256 budgetIndex = type(uint256).max;
        for (uint256 i; i < plan.budgets.length; ++i) {
            if (plan.budgets[i].sourceId == route.sourceId && plan.budgets[i].currency == route.currencyIn) budgetIndex = i;
        }
        if (budgetIndex == type(uint256).max || route.maxOriginal > plan.budgets[budgetIndex].maxOriginal
            || route.maxCharged > plan.budgets[budgetIndex].maxCharged) revert InvalidAmount();
        E.FeeBudget memory budget = E.FeeBudget(route.sourceId,route.currencyIn,route.maxOriginal,route.maxCharged);
        T.CompoundAmounts memory value = _amounts(vault,budget,route.amountIn);
        T.ExecutionLimits memory limits = vault.executionLimits();
        uint160 anchorPrice = priceGuard.referencePrice(route.priceObservationId,vault.poolId(),plan.authority.observedAtBlock,
            plan.authority.observedBlockHash,limits.maxObservationAgeSeconds);
        (uint160 beforePrice,,,) = IStateViewE2(readHelper.stateView()).getSlot0(vault.poolId());
        routingHelper.checkSwapPrices(beforePrice,beforePrice,anchorPrice,limits.maxPriceImpactBps);
        if (route.minAmountOut < routingHelper.minimumOutput(route.amountIn,anchorPrice,zeroForOne,limits.maxSlippageBps)) revert InvalidRoute();
        uint256 beforeInput = _balance(route.currencyIn); uint256 beforeOutput = _balance(outputCurrency);
        IPoolSwapV4 manager = IPoolSwapV4(vault.poolManager());
        int256 delta = manager.swap(key,IPoolSwapV4.SwapParams(zeroForOne,-int256(uint256(route.amountIn)),route.sqrtPriceLimitX96),bytes(""));
        int128 delta0 = int128(delta >> 128); int128 delta1 = int128(uint128(uint256(delta)));
        int128 input = zeroForOne ? delta0 : delta1; int128 output = zeroForOne ? delta1 : delta0;
        if (input != -int256(uint256(route.amountIn)) || output <= 0 || uint128(output) < route.minAmountOut) revert InvalidAmount();
        uint128 amountOut = uint128(output);
        (uint160 afterPrice,,,) = IStateViewE2(readHelper.stateView()).getSlot0(vault.poolId());
        routingHelper.checkSwapPrices(beforePrice,afterPrice,anchorPrice,limits.maxPriceImpactBps);
        vault.executionApply(route.sourceId,route.currencyIn,value,address(this),false);
        manager.take(outputCurrency,address(vault),amountOut);
        if (_balance(route.currencyIn) != beforeInput-value.grossOriginalConsumed-value.chargedConsumed
            || _balance(outputCurrency) != beforeOutput+amountOut) revert InvalidAmount();
        uint128 outputBefore = vault.feeBalance(route.sourceId,outputCurrency).charged;
        vault.executionConvert(route.sourceId,outputCurrency,amountOut);
        plan.budgets[budgetIndex].maxOriginal -= value.grossOriginalConsumed;
        plan.budgets[budgetIndex].maxCharged -= value.chargedConsumed;
        emit FeesConverted(address(vault),plan.authority.intentId,route.sourceId,route.currencyIn,outputCurrency,
            route.amountIn,amountOut,value,outputBefore,vault.feeBalance(route.sourceId,outputCurrency).charged);
    }

    function _balance(address currency) private view returns (uint256) {
        return currency == address(0) ? _activeVault.balance : IERC20E2(currency).balanceOf(_activeVault);
    }
    function _delta(address account, address currency) private view returns (int256) {
        return int256(uint256(IPoolManagerE4(IVaultExecutionV4(_activeVault).poolManager()).exttload(keccak256(abi.encode(account,currency)))));
    }
    function _debt(address account, address currency) private view returns (uint128) {
        int256 delta = _delta(account,currency);
        if (delta > 0 || delta < -int256(uint256(uint128(type(int128).max)))) revert InvalidAmount();
        return uint128(uint256(-delta));
    }
}
