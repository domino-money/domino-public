// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DominoVaultTypes as T, IStateViewE2, IERC20E2, IPoolManagerE4} from "./DominoVaultTypes.sol";
import {DominoExecutionTypes as E, IVaultFactoryV4, IPriceGuardV4, IVaultExecutionV4} from "./DominoExecutionTypes.sol";
import {DominoVaultReadHelper} from "./DominoVaultReadHelper.sol";
import {DominoRoutingHelperV4} from "./DominoRoutingHelperV4.sol";

interface IPoolSwapV4 is IPoolManagerE4 {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function swap(T.PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function take(address currency, address recipient, uint256 amount) external;
}

/// @notice Fixed noncustodial execution engine: no delegatecall, router calldata,
/// wallet funding, allowance, native payable entry or configurable recipient.
contract DominoExecutionEngineV4 {
    struct Work { E.Plan plan; uint128[] collectionRemaining; uint128[] originalSpent; }
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
    /// The read helper's own state view, read once at construction. It is
    /// immutable there, so an external call per use bought nothing.
    IStateViewE2 public immutable stateView;
    // Per-execution scratch, transient (EIP-1153) rather than storage: each of
    // these is written and cleared inside one call, and in storage each cost a
    // set and a delete - about fifteen thousand gas apiece after the EIP-3529
    // refund cap - for state no later transaction can read. The same move the
    // vault made for its own scratch.
    uint256 private constant _T_VAULT = 0;
    // The vault's pool manager, read once per execution: _delta asked the
    // clone for it on every one of its dozen calls.
    uint256 private constant _T_MANAGER = 1;
    uint256 private constant _T_UNLOCK = 2;
    uint256 private constant _T_DESTINATION = 3;

    function _tget(uint256 slot) private view returns (uint256 v) {
        assembly ("memory-safe") { v := tload(slot) }
    }

    function _tset(uint256 slot, uint256 v) private {
        assembly ("memory-safe") { tstore(slot, v) }
    }

    function _tgetAddress(uint256 slot) private view returns (address) {
        return address(uint160(_tget(slot)));
    }
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
        stateView = IStateViewE2(DominoVaultReadHelper(readHelper_).stateView());
    }

    function execute(E.Plan calldata plan) external returns (bytes32 planHash, uint256 destination) {
        address implementation = IVaultFactoryV4(factory).implementation();
        bytes32 cloneHash = keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73",implementation,hex"5af43d82803e903d91602b57fd5bf3"));
        if (!IVaultFactoryV4(factory).isVault(msg.sender) || msg.sender.codehash != cloneHash || _tget(_T_VAULT) != 0
            || address(readHelper).codehash != readHelperHash || address(routingHelper).codehash != routingHelperHash
            || address(priceGuard).codehash != priceGuardHash) revert InvalidExecution();
        IVaultExecutionV4 vault = IVaultExecutionV4(msg.sender);
        routingHelper.validate(address(vault), plan, readHelper);
        _tset(_T_VAULT, uint256(uint160(msg.sender)));
        _tset(_T_MANAGER, uint256(uint160(vault.poolManager())));
        bytes memory data = abi.encode(plan);
        if (keccak256(msg.data) != keccak256(bytes.concat(this.execute.selector,data))) revert InvalidExecution();
        _tset(_T_UNLOCK, uint256(keccak256(data)));
        IPoolManagerE4(_tgetAddress(_T_MANAGER)).unlock(data);
        if (_tget(_T_UNLOCK) != 0) revert UnexpectedCallback();
        destination = _tget(_T_DESTINATION);
        planHash = keccak256(abi.encode(keccak256("DominoExecutionV4"),block.chainid,msg.sender,vault.sequenceIdentityHash(),plan));
        // All three cleared on the success path: transient state lives to the
        // end of the transaction, not the end of the call.
        _tset(_T_VAULT, 0); _tset(_T_MANAGER, 0); _tset(_T_DESTINATION, 0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        IVaultExecutionV4 vault = IVaultExecutionV4(_tgetAddress(_T_VAULT));
        if (_tget(_T_VAULT) == 0 || msg.sender != _tgetAddress(_T_MANAGER) || _tget(_T_UNLOCK) == 0
            || uint256(keccak256(data)) != _tget(_T_UNLOCK)) revert UnexpectedCallback();
        _tset(_T_UNLOCK, 0);
        E.Plan memory plan = abi.decode(data,(E.Plan));
        T.PoolKey memory key = vault.poolKey();
        if (_delta(vault.positionManager(),key.currency0) != 0 || _delta(vault.positionManager(),key.currency1) != 0
            || _delta(address(this),key.currency0) != 0 || _delta(address(this),key.currency1) != 0) revert InvalidExecution();
        // The anchor binds every action, not only a swap. A GENERAL, NET, FUND
        // or MINT whose only price check is the plan's own band would let the
        // caller contribute the reserve at a price it moved itself.
        T.ExecutionLimits memory limits = vault.executionLimits();
        uint160 anchorPrice = priceGuard.referencePrice(plan.swap.priceObservationId,vault.poolId(),
            plan.authority.observedAtBlock,plan.authority.observedBlockHash,limits.maxObservationAgeSeconds);
        {
            (uint160 spot,,,) = stateView.getSlot0(vault.poolId());
            routingHelper.checkSwapPrices(spot,spot,anchorPrice,limits.maxPriceImpactBps);
        }
        if (plan.action == E.NET) _net(vault,plan,key);
        else {
            Work memory work = Work(plan,new uint128[](plan.budgets.length),new uint128[](plan.budgets.length));
            for (uint256 i; i < plan.budgets.length; ++i) {
                E.FeeBudget memory b = plan.budgets[i];
                T.FeeBalance memory old = vault.feeBalance(b.sourceId,b.currency);
                if (old.original < b.minOriginal || old.charged < b.minCharged) revert InvalidAmount();
                work.collectionRemaining[i] = b.maxOriginal - b.minOriginal;
                b.maxOriginal = b.minOriginal;
                if (b.maxCharged > old.charged) b.maxCharged = old.charged;
            }
            for (uint256 i; i < plan.collect.length; ++i) _collect(vault,work,plan.collect[i].tokenId,key);
            if (plan.swap.amountIn != 0) _swap(vault,work,key,anchorPrice,limits);
            _fund(vault,work,key);
        }
        for (uint256 i; i < plan.budgets.length; ++i)
            if (plan.budgets[i].minOriginal != 0 || plan.budgets[i].minCharged != 0) revert InvalidAmount();
        readHelper.validateCompoundPrice(vault.poolId(),plan.authority,limits.maxObservationAgeSeconds);
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

    function _collect(IVaultExecutionV4 vault, Work memory work, uint256 id, T.PoolKey memory key) private {
        T.Checkpoint memory beforePoint = _before(vault,id);
        (uint128 a,uint128 b) = readHelper.accrued(beforePoint);
        uint256 old0 = _balance(key.currency0); uint256 old1 = _balance(key.currency1);
        vault.executionModify(id,0,a,b,true);
        if (_balance(key.currency0) != old0+a || _balance(key.currency1) != old1+b
            || _delta(vault.positionManager(),key.currency0) != 0 || _delta(vault.positionManager(),key.currency1) != 0) revert InvalidAmount();
        T.Checkpoint memory point = _point(vault,id); _after(beforePoint,point,0);
        vault.executionCredit(id,a,b); vault.executionCheckpoint(id,point);
        T.Position memory member = vault.position(id);
        for (uint256 i; i < work.plan.budgets.length; ++i) {
            E.FeeBudget memory budget = work.plan.budgets[i];
            uint128 amount;
            if (budget.sourceId == member.source0 && budget.currency == key.currency0) amount = a;
            else if (budget.sourceId == member.source1 && budget.currency == key.currency1) amount = b;
            uint128 admitted = amount < work.collectionRemaining[i] ? amount : work.collectionRemaining[i];
            work.collectionRemaining[i] -= admitted; budget.maxOriginal += admitted;
        }
        emit FeesRealized(address(vault),work.plan.authority.intentId,id,beforePoint.commitment,point.commitment,a,b);
    }

    function _fund(IVaultExecutionV4 vault, Work memory work, T.PoolKey memory key) private {
        E.Plan memory plan = work.plan;
        uint256 id = plan.destinationTokenId;
        T.Checkpoint memory beforePoint;
        if (plan.action == E.MINT) id = vault.executionMint(plan.authority.intentId,plan.authority.tokenId,
            plan.tickLower,plan.tickUpper,plan.authority.liquidityIncrease);
        else {
            // A destination not among the sources may have its own uncollected
            // fees. Realize them into their own sources before increasing it.
            bool alreadyCollected;
            for (uint256 i; i < plan.collect.length; ++i) if (plan.collect[i].tokenId == id) alreadyCollected = true;
            if (!alreadyCollected || plan.swap.amountIn != 0) _collect(vault,work,id,key);
            beforePoint = _before(vault,id);
            vault.executionModify(id,plan.authority.liquidityIncrease,0,0,false);
        }
        _tset(_T_DESTINATION, id);
        uint128 added0 = _debt(vault.positionManager(),key.currency0);
        uint128 added1 = _debt(vault.positionManager(),key.currency1);
        _bound(added0,added1,plan);
        _allocate(vault,work,key.currency0,added0); _allocate(vault,work,key.currency1,added1);
        if (plan.action != E.MINT) {
            T.Checkpoint memory afterPoint = _point(vault,id); _after(beforePoint,afterPoint,plan.authority.liquidityIncrease);
            vault.executionCheckpoint(id,afterPoint);
        } else if (_point(vault,id).liquidity != plan.authority.liquidityIncrease) revert InvalidExecution();
    }

    function _amounts(IVaultExecutionV4 vault, E.FeeBudget memory budget, uint128 wanted, uint128 priorGross)
        private view returns (T.CompoundAmounts memory value) {
        T.FeeBalance memory balance = vault.feeBalance(budget.sourceId,budget.currency);
        value.originalBefore = balance.original; value.chargedBefore = balance.charged;
        return routingHelper.compoundAmounts(value,wanted,budget.maxOriginal,budget.maxCharged,vault.policy().serviceFeeBps,priorGross,budget.minOriginal);
    }

    function _allocate(IVaultExecutionV4 vault, Work memory work, address currency, uint128 remaining) private {
        E.Plan memory plan = work.plan;
        uint16 feeBps = vault.policy().serviceFeeBps;
        // Exact pre-existing allocations precede every optional collection cap.
        // Otherwise an early cap could starve a later source's required debit.
        for (uint256 pass; pass < 2; ++pass) {
            for (uint256 i; i < plan.budgets.length; ++i) {
                E.FeeBudget memory actualBudget = plan.budgets[i];
                if (actualBudget.currency != currency) continue;
                E.FeeBudget memory b = E.FeeBudget(actualBudget.sourceId,currency,actualBudget.maxOriginal,
                    actualBudget.maxCharged,0,0);
                if (pass == 0) {
                    b.maxOriginal = actualBudget.minOriginal; b.minOriginal = actualBudget.minOriginal;
                    b.maxCharged = actualBudget.minCharged;
                    if (b.maxOriginal == 0 && b.maxCharged == 0) continue;
                } else if (remaining == 0) continue;
                T.FeeBalance memory available = vault.feeBalance(b.sourceId,currency);
                uint128 gross = available.original < b.maxOriginal ? available.original : b.maxOriginal;
                uint128 charged = available.charged < b.maxCharged ? available.charged : b.maxCharged;
                uint128 priorGross = work.originalSpent[i];
                uint256 fee = (uint256(priorGross)+gross)*feeBps/10000 - uint256(priorGross)*feeBps/10000;
                uint256 net = uint256(gross) - fee + charged;
                if (pass == 0 && net > remaining) revert InvalidAmount();
                uint128 wanted = net < remaining ? uint128(net) : remaining;
                if (pass != 0 && wanted == 0) continue;
                T.CompoundAmounts memory value = _amounts(vault,b,wanted,priorGross);
                vault.executionApply(b.sourceId,currency,value,vault.positionManager(),false);
                emit BudgetApplied(address(vault),plan.authority.intentId,b.sourceId,currency,_tget(_T_DESTINATION),value);
                _debit(actualBudget,value.grossOriginalConsumed,value.chargedConsumed);
                work.originalSpent[i] += value.grossOriginalConsumed;
                remaining -= wanted;
            }
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
        _bound(added0,added1,plan);
        for (uint256 i; i < 2; ++i) {
            E.FeeBudget memory budget = plan.budgets[i];
            bool zero = budget.currency == key.currency0;
            if (budget.sourceId != (zero ? member.source0 : member.source1) || budget.maxCharged != 0 || budget.minOriginal != 0) revert InvalidRoute();
            T.FeeBalance memory balance = vault.feeBalance(budget.sourceId,budget.currency);
            T.CompoundAmounts memory value; value.originalBefore = balance.original; value.chargedBefore = balance.charged;
            value.realized = zero ? realized0 : realized1;
            value = readHelper.compoundAmounts(value,zero ? added0 : added1,budget.maxOriginal,0,vault.policy().serviceFeeBps);
            if (value.grossOriginalConsumed > value.realized) revert InvalidAmount();
            vault.executionApply(budget.sourceId,budget.currency,value,vault.positionManager(),true);
            _debit(plan.budgets[i],value.grossOriginalConsumed,value.chargedConsumed);
            emit BudgetApplied(address(vault),plan.authority.intentId,budget.sourceId,budget.currency,id,value);
        }
        T.Checkpoint memory afterPoint = _point(vault,id); _after(beforePoint,afterPoint,plan.authority.liquidityIncrease);
        vault.executionCheckpoint(id,afterPoint); _tset(_T_DESTINATION, id);
        emit FeesRealized(address(vault),plan.authority.intentId,id,beforePoint.commitment,afterPoint.commitment,realized0,realized1);
    }

    function _swap(IVaultExecutionV4 vault, Work memory work, T.PoolKey memory key,
        uint160 anchorPrice, T.ExecutionLimits memory limits) private {
        E.Plan memory plan = work.plan;
        E.SwapPlan memory route = plan.swap;
        bool zeroForOne = route.currencyIn == key.currency0;
        if (!zeroForOne && route.currencyIn != key.currency1) revert InvalidRoute();
        address outputCurrency = zeroForOne ? key.currency1 : key.currency0;
        uint256 budgetIndex = type(uint256).max;
        for (uint256 i; i < plan.budgets.length; ++i) {
            if (plan.budgets[i].sourceId == route.sourceId && plan.budgets[i].currency == route.currencyIn) budgetIndex = i;
        }
        if (budgetIndex == type(uint256).max) revert InvalidAmount();
        uint128 originalCap = route.maxOriginal < plan.budgets[budgetIndex].maxOriginal ? route.maxOriginal : plan.budgets[budgetIndex].maxOriginal;
        uint128 chargedCap = route.maxCharged < plan.budgets[budgetIndex].maxCharged ? route.maxCharged : plan.budgets[budgetIndex].maxCharged;
        E.FeeBudget memory budget = E.FeeBudget(route.sourceId,route.currencyIn,originalCap,chargedCap,0,0);
        T.CompoundAmounts memory value = _amounts(vault,budget,route.amountIn,0);
        // The anchor and the limits are the ones unlockCallback already bound.
        (uint160 beforePrice,,,) = stateView.getSlot0(vault.poolId());
        routingHelper.checkSwapPrices(beforePrice,beforePrice,anchorPrice,limits.maxPriceImpactBps);
        if (route.minAmountOut < routingHelper.minimumOutput(route.amountIn,anchorPrice,zeroForOne,limits.maxSlippageBps)) revert InvalidRoute();
        uint256 beforeInput = _balance(route.currencyIn); uint256 beforeOutput = _balance(outputCurrency);
        IPoolSwapV4 manager = IPoolSwapV4(vault.poolManager());
        int256 delta = manager.swap(key,IPoolSwapV4.SwapParams(zeroForOne,-int256(uint256(route.amountIn)),route.sqrtPriceLimitX96),bytes(""));
        int128 delta0 = int128(delta >> 128); int128 delta1 = int128(uint128(uint256(delta)));
        int128 input = zeroForOne ? delta0 : delta1; int128 output = zeroForOne ? delta1 : delta0;
        if (input != -int256(uint256(route.amountIn)) || output <= 0 || uint128(output) < route.minAmountOut) revert InvalidAmount();
        uint128 amountOut = uint128(output);
        (uint160 afterPrice,,,) = stateView.getSlot0(vault.poolId());
        routingHelper.checkSwapPrices(beforePrice,afterPrice,anchorPrice,limits.maxPriceImpactBps);
        vault.executionApply(route.sourceId,route.currencyIn,value,address(this),false);
        manager.take(outputCurrency,address(vault),amountOut);
        if (_balance(route.currencyIn) != beforeInput-value.grossOriginalConsumed-value.chargedConsumed
            || _balance(outputCurrency) != beforeOutput+amountOut) revert InvalidAmount();
        uint128 outputBefore = vault.feeBalance(route.sourceId,outputCurrency).charged;
        vault.executionConvert(route.sourceId,outputCurrency,amountOut);
        _debit(plan.budgets[budgetIndex],value.grossOriginalConsumed,value.chargedConsumed);
        bool outputBudget;
        for (uint256 i; i < plan.budgets.length; ++i) {
            if (plan.budgets[i].sourceId == route.sourceId && plan.budgets[i].currency == outputCurrency) {
                plan.budgets[i].maxCharged += amountOut; outputBudget = true;
            }
        }
        if (!outputBudget) revert InvalidAmount();
        emit FeesConverted(address(vault),plan.authority.intentId,route.sourceId,route.currencyIn,outputCurrency,
            route.amountIn,amountOut,value,outputBefore,vault.feeBalance(route.sourceId,outputCurrency).charged);
        work.originalSpent[budgetIndex] += value.grossOriginalConsumed;
    }

    /// What the add actually cost, against the plan's own floor and ceiling.
    /// Both sites share this deliberately: kept inline, the IR pipeline emits
    /// the condition twice and the ceiling no longer fits the engine's reserve.
    function _bound(uint128 added0, uint128 added1, E.Plan memory plan) private pure {
        if ((added0 == 0 && added1 == 0) || added0 < plan.authority.minAdded0 || added1 < plan.authority.minAdded1
            || added0 > plan.maxAdded0 || added1 > plan.maxAdded1) revert InvalidAmount();
    }

    function _debit(E.FeeBudget memory budget, uint128 original, uint128 charged) private pure {
        budget.maxOriginal -= original; budget.maxCharged -= charged;
        budget.minOriginal = original >= budget.minOriginal ? 0 : budget.minOriginal - original;
        budget.minCharged = charged >= budget.minCharged ? 0 : budget.minCharged - charged;
    }

    function _balance(address currency) private view returns (uint256) {
        address self = _tgetAddress(_T_VAULT);
        return currency == address(0) ? self.balance : IERC20E2(currency).balanceOf(self);
    }
    function _delta(address account, address currency) private view returns (int256) {
        return int256(uint256(IPoolManagerE4(_tgetAddress(_T_MANAGER)).exttload(keccak256(abi.encode(account,currency)))));
    }
    function _debt(address account, address currency) private view returns (uint128) {
        int256 delta = _delta(account,currency);
        if (delta > 0 || delta < -int256(uint256(uint128(type(int128).max)))) revert InvalidAmount();
        return uint128(uint256(-delta));
    }
}
